# LOB Onboarding — start a new tenant (LOB side)

> ## 🟦 RUN THIS **ONCE PER LOB** — stands the TENANT up
> Trust the account, create the CI user, get the tenant bucket. After this, the LOB
> *exists* on the platform. You do this **one time**, ever, for the whole LOB.
> **Deploying agents is a different doc → `lob-deploy-agent.md` (once per AGENT).**

> Run this **once per LOB**, right after cloning this blueprint. It is the LOB's
> half of the level-2 handshake with the platform team. Adding each agent afterwards
> is a separate, repeatable flow — see `lob-deploy-agent.md`.
>
> **Canonical, full walkthrough:** `docs/WORKLOAD_SETUP.md` (this repo) — the complete
> step-by-step LOB guide. This file is the quick-reference skill for the *onboarding
> handshake* only; `WORKLOAD_SETUP.md` Part 1 Step 0–2 is the same ground in full.

This is deliberately short: the LOB does NOT create the pipeline, the source bucket,
or the registry — those are platform-owned. The LOB's job here is **(a) create the CI
credential and (b) complete the handshake** so the platform team can stand up the
tenant's pipeline.

## Accounts
- Your **workload account** (consumer), e.g. `172873868821`. May be SHARED with other
  LOBs — tenant-scoped names keep you from colliding.
- The **platform account** is `195698601974` (you don't deploy there; platform does).

## Step 1 — Bootstrap your workload account to trust platform (one-time per ACCOUNT)
Only if your account is not already bootstrapped (a shared account another LOB already
onboarded is already done — check `CDKToolkit` first, don't re-run):
```
npx cdk bootstrap aws://<your-workload-account>/us-east-1 \
  --trust 195698601974 \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

## Step 2 — Create your CI credential (access-key model)
```
./scripts/create-iam-users.sh --tenant <your-tenant> --workload-account <your-account>
```
This creates two tenant-scoped IAM **users** with static access keys and prints them:
- `agenticai-ci-runner-<tenant>` — the GitLab CI user (direct `s3:PutObject` to the
  pipeline source bucket). Put its key into GitLab CI vars `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` (secret **Masked**).
- `agenticai-lob-deployer-<tenant>` — local bootstrap + `ecr:PutImage`.

> Access keys, not a role: GitLab CI here has no OIDC, so the principal is an IAM
> **user**. Capture the printed keys now — they are shown once.

## Step 3 — The handshake with the platform team
Give the platform team:
- your **CI runner USER ARN**: `arn:aws:iam::<your-account>:user/agenticai-ci-runner-<tenant>`
- your tenant id, workload account id, region/AZs, cost centre.

They (per `platform-onboard-lob`):
- create the per-tenant source bucket `agenticai-pipeline-source-<tenant>` (via the
  `LobSourceBucket` stack) with a policy granting your CI user `s3:PutObject` on `/*`;
- hand back the **bucket name** and the three inference values (M2M secret ARN,
  gateway URL, model id).

## Step 4 — You are onboarded. Now add agents.
With the CI credential created and the handshake done, onboard each agent with
`lob-deploy-agent.md` (containerize → own AppStack → push image → merge). Each agent
gets its OWN AppStack + its OWN pipeline (platform stands up the pipeline per agent),
sharing this tenant's VPC, CI user and source bucket — so each agent is eval-gated
independently.

## What you do NOT do (platform owns these)
- ❌ Create the pipeline (`S3WorkloadPipelineStack`) — platform, per agent.
- ❌ Create the source bucket directly — platform creates it once at LOB-onboard
  (`LobSourceBucket`). Each agent just uploads to its OWN folder in it
  (`PIPELINE_SOURCE_KEY=<agentId>/workload-source.zip`).
- ❌ Add the GA Registry record — platform, after each agent's first deploy.
