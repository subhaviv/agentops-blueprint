---
name: lob-deploy-agent
description: LOB-team runbook to deploy an agent onto the Enterprise Agentic AI Platform via the governed CICD pipeline — containerize the agent to the AgentCore HTTP contract, scaffold the workload CDK, create the tenant CI role + ECR repo, push the image, and merge to trigger the pipeline. Use when deploying a new or existing agent (e.g. a Strands agent) for a LOB tenant, or when asked "how does the consumer/LOB team deploy an agent". This is the PRODUCT-team half; the platform side is platform-onboard-lob.
---

# lob-deploy-agent — deploy an agent via the governed pipeline (LOB team)

> ## 🟩 RUN THIS **ONCE PER AGENT** — ships ONE agent
> Containerize → push image → platform stands up the agent's pipeline → merge → deploy.
> **Repeat this whole doc for every agent** the LOB ships (patient-journey, then the
> next, then the next). Each agent gets its OWN pipeline + eval gate.
> **Prerequisite: the LOB is already onboarded → `lob-onboard.md` (once per LOB).**

The **LOB/product team's** side of shipping an agent on the shared platform. You own
the agent, its container image, the tenant CI role, and merging to `main`; the platform
team owns the bucket, pipeline, and registry record (see platform-onboard-lob).

Two deploy paths exist — this skill is the **governed CICD path** (the operating model's
recommended route). An imperative CodeZip path exists for quick demos but bypasses the
governance gates; prefer CICD for anything beyond a one-off.

Reference repos: `payor-agents` (reference LOB), the blueprint
(`agentops-blueprint`). IAM setup for the access-key model: `scripts/create-iam-users.sh`.
**Canonical, full walkthrough:** `docs/WORKLOAD_SETUP.md` (this repo) — Part 1 Steps 3–9
are the complete version of sections 1–5 below. This skill is the quick reference.

## 1. Containerize the agent (to the AgentCore HTTP contract)
The platform pipeline provisions runtimes from a **container image**, not a CodeZip.
Create `blueprints/<agent>/` with `agent.py` (or `main.py`), `Dockerfile`, `requirements.txt`:
- The image must serve **`/ping` → `{"status":"Healthy"}` within 120 s** and
  **`/invocations`** (streaming). `BedrockAgentCoreApp()` + `app.run(host="0.0.0.0", port=8080)`
  gives this for free — a Strands agent that already calls `app.run(...)` needs NO code
  change, only packaging.
- **Read all env + do all I/O inside the app factory**, never at module import — a
  module-level read crashes `/ping` and the runtime never reaches READY.
- **Never call Bedrock directly** — inference goes through the platform inference gateway
  via M2M OAuth (resolve `INFERENCE_M2M_SECRET_ARN` from Secrets Manager inside the factory;
  Claude uses `/inference/v1/messages` + header `anthropic-version: 2023-06-01`).
- **Stamp `baggage: session.id=<sid>`** on every gateway request for correlation.
- `Dockerfile`: `FROM python:3.13-slim`, `USER 10001`, `EXPOSE 8080`, ARM64.
- **Verify locally before pushing:** `docker build --platform linux/arm64`, run it, curl
  `/ping` — ECR tags are immutable, so a broken image burns a tag.

## 2. Scaffold the workload CDK (copy, don't reinvent)
Bring these into the repo (from the blueprint / a reference LOB):
`.gitlab-ci.yml`, `cdk.json`, `package.json`, `tsconfig.json`, `bin/workload-app.ts`,
`apps/workload-account/lib/{workload-app-stack,workload-network-stack}.ts`,
`scripts/create-iam-users.sh`.
The stack is **fully context-driven** — you usually do NOT edit it. Set `cdk.context.json`:
- `agenticai/tenantId`, `agenticai/agentId`, `agenticai/costCentre`, `agenticai/vpcCidr`
  (give each LOB a DISTINCT CIDR if they share an account), AZs, account id,
- `agenticai/agentImageUri` = the ECR URI (see naming below),
- the three inference values (M2M secret ARN, gateway URL, model id), `guardrailId`.
Validate: `npm ci && npx tsc --noEmit && npx cdk synth -c stage=workload` — check the
synthesized `runtimeName` + `imageUri`.

## 3. Create the tenant CI user + access keys  (access-key model)
```
./scripts/create-iam-users.sh --tenant <tenant> --workload-account <acct>
```
Creates two tenant-scoped IAM **users** — `agenticai-ci-runner-<tenant>` (CI: direct
`s3:PutObject` on the pipeline source bucket) and `agenticai-lob-deployer-<tenant>`
(bootstrap + `ecr:PutImage`) — each with a **static access key**, and prints the keys.
Set the CI user's key as GitLab CI vars `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
(secret **Masked**). Hand the CI **user ARN**
(`arn:aws:iam::<acct>:user/agenticai-ci-runner-<tenant>`) to the platform team — it is
the **bucket-policy principal**.

- **Why users + keys, not a role:** GitLab CI here authenticates with static access
  keys (OIDC / assume-role is not available), so the direct-user model is correct. The
  role-based `setup-lob.sh` needs OIDC and does NOT apply.
- **This script does NOT:** create the ECR repo, write `cdk.context.json`, or touch git.
  It only creates the IAM users + keys + their inline policies.

## 3b. Create the ECR repo (separate — the IAM script does not)
```
aws ecr create-repository --repository-name agenticai-nonprod-<tenant>-<agentId> \
  --region us-east-1 --profile <workload-profile>
```
The deployer user's policy already allows `ecr:PutImage` on
`agenticai-nonprod-<tenant>-*`, but the repo itself must exist before the push.

## 4. Push the image
```
ECR=<acct>.dkr.ecr.us-east-1.amazonaws.com
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $ECR
docker tag <agent>:latest $ECR/agenticai-nonprod-<tenant>-<agent>:<agent>-v1
docker push $ECR/agenticai-nonprod-<tenant>-<agent>:<agent>-v1
```

## 5. Merge to deploy
Set GitLab CI vars (`PIPELINE_SOURCE_BUCKET` = the tenant bucket from the platform team, `PIPELINE_SOURCE_KEY=<agentId>/workload-source.zip` — this agent's OWN folder in the shared tenant bucket, must match the pipeline's `sourceObjectKey`; plus CI creds). Commit + merge to `main` → CI zips + `s3 cp` →
pipeline runs Synth → Nonprod → EvaluationGate → ProdApproval → Prod. Then give the
platform team the runtime ID for the registry record.

## Naming convention (critical — gets mismatched)
Everything is `agenticai-nonprod-<tenant>-<agentId>` (NOT `-primary` unless agentId IS
`primary`). ECR repo, runtime name prefix, pipeline — all derive from
`<tenant>-<agentId>`. A `cdk.context.json` image URI that says `-primary` while
`agentId` is something else will point at a repo that doesn't exist.

## Traps
- **Multiple LOBs in one account:** names are tenant-scoped so they coexist, BUT give
  each a distinct `vpcCidr`, and run `create-iam-users.sh --tenant <tenant>` so the IAM
  users are suffixed per tenant. An un-suffixed flat `agenticai-ci-runner` (the old
  pre-fix script) would collide with / rotate another LOB's credentials in a shared
  account — the current script scopes them per tenant.
- **`/ping` is the readiness gate** — if the runtime never reaches READY, it's almost
  always a module-level env read or heavy import before the factory. Defer everything.
- **EHR/tool calls go through the governance gateway** (the clinician's user token,
  Cedar on `cognito:groups`), not an in-process scope check — the in-process check is a
  demo stand-in; the real governance is the gateway.
- **Account bootstrap trusting platform is one-time per account**, not per agent/LOB.
