#!/usr/bin/env bash
# setup-lob.sh — Set up this LOB workload repo for a new tenant.
#
# What this does:
#   1. Validates inputs
#   2. Writes cdk.context.json with your tenant values + platform inference values
#   3. Sets GitLab CI/CD variables (PIPELINE_SOURCE_BUCKET, PIPELINE_SOURCE_KEY)
#      if --gitlab-project-id is supplied; otherwise prints them for manual entry
#   4. Commits the context file change
#
# Usage:
#   ./scripts/setup-lob.sh \
#     --tenant           member-services           \
#     --workload-account 172873868821              \
#     --cost-centre      member-services           \
#     --m2m-secret-arn   arn:aws:secretsmanager:... \
#     --inference-url    https://...               \
#     --inference-model  anthropic.claude-sonnet-5
#
# Optional flags:
#   --agent-id           primary            (default: primary)
#   --region             us-east-1          (default: us-east-1)
#   --azs                us-east-1a,us-east-1b
#   --vpc-cidr           10.0.0.0/16        (default: 10.0.0.0/16)
#   --user-pool-id       us-east-1_XXXX     (Cognito pool from platform team)
#   --user-pool-client   CLIENT_ID
#   --notification-email ops@example.com
#   --gitlab-project-id  12345              (if set, writes CI variables via glab CLI)
#   --ci-runner-user-arn arn:aws:iam::172873868821:user/gitlab-ci
#                                          (IAM user the CI runner uses to assume the role)
#   --dry-run                               (print what would change, no file writes)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTEXT_FILE="$REPO_ROOT/cdk.context.json"

# ── Defaults ──────────────────────────────────────────────────────────────────
TENANT=""
WORKLOAD_ACCOUNT=""
COST_CENTRE=""
M2M_SECRET_ARN=""
INFERENCE_URL=""
INFERENCE_MODEL=""
AGENT_ID="primary"
REGION="us-east-1"
AZS="us-east-1a,us-east-1b"
VPC_CIDR="10.0.0.0/16"
USER_POOL_ID=""
USER_POOL_CLIENT=""
NOTIFICATION_EMAIL=""
GITLAB_PROJECT_ID=""
CI_RUNNER_USER_ARN=""
DRY_RUN=false

# ── Arg parse ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant)            TENANT="$2";            shift 2 ;;
    --workload-account)  WORKLOAD_ACCOUNT="$2";  shift 2 ;;
    --cost-centre)       COST_CENTRE="$2";       shift 2 ;;
    --m2m-secret-arn)    M2M_SECRET_ARN="$2";    shift 2 ;;
    --inference-url)     INFERENCE_URL="$2";     shift 2 ;;
    --inference-model)   INFERENCE_MODEL="$2";   shift 2 ;;
    --agent-id)          AGENT_ID="$2";          shift 2 ;;
    --region)            REGION="$2";            shift 2 ;;
    --azs)               AZS="$2";               shift 2 ;;
    --vpc-cidr)          VPC_CIDR="$2";          shift 2 ;;
    --user-pool-id)      USER_POOL_ID="$2";      shift 2 ;;
    --user-pool-client)  USER_POOL_CLIENT="$2";  shift 2 ;;
    --notification-email) NOTIFICATION_EMAIL="$2"; shift 2 ;;
    --gitlab-project-id)   GITLAB_PROJECT_ID="$2";   shift 2 ;;
    --ci-runner-user-arn)  CI_RUNNER_USER_ARN="$2";  shift 2 ;;
    --dry-run)             DRY_RUN=true;              shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────────
errors=()
[[ -z "$TENANT"           ]] && errors+=("--tenant is required")
[[ -z "$WORKLOAD_ACCOUNT" ]] && errors+=("--workload-account is required")
[[ -z "$COST_CENTRE"      ]] && errors+=("--cost-centre is required")
[[ -z "$M2M_SECRET_ARN"   ]] && errors+=("--m2m-secret-arn is required (from platform team)")
[[ -z "$INFERENCE_URL"    ]] && errors+=("--inference-url is required (from platform team)")
[[ -z "$INFERENCE_MODEL"  ]] && errors+=("--inference-model is required (from platform team)")

if [[ -n "$TENANT" ]] && ! [[ "$TENANT" =~ ^[a-z][a-z0-9-]{1,38}[a-z0-9]$ ]]; then
  errors+=("--tenant must be lowercase alphanumeric+hyphens, 3-40 chars (e.g. member-services)")
fi

if [[ -n "$WORKLOAD_ACCOUNT" ]] && ! [[ "$WORKLOAD_ACCOUNT" =~ ^[0-9]{12}$ ]]; then
  errors+=("--workload-account must be a 12-digit AWS account ID")
fi

if [[ -n "$M2M_SECRET_ARN" ]] && ! [[ "$M2M_SECRET_ARN" =~ ^arn:aws:secretsmanager: ]]; then
  errors+=("--m2m-secret-arn must be a Secrets Manager ARN (arn:aws:secretsmanager:...)")
fi

if [[ -n "$INFERENCE_URL" ]] && ! [[ "$INFERENCE_URL" =~ ^https:// ]]; then
  errors+=("--inference-url must start with https://")
fi

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "Errors:" >&2
  for e in "${errors[@]}"; do echo "  • $e" >&2; done
  exit 1
fi

# ── Derived values ─────────────────────────────────────────────────────────────
BUCKET_NAME="agenticai-pipeline-source-${TENANT}"
ECR_REPO="${WORKLOAD_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/agenticai-nonprod-${TENANT}-${AGENT_ID}"

# AZs as JSON array
IFS=',' read -ra AZ_ARRAY <<< "$AZS"
AZ_JSON="[$(printf '"%s",' "${AZ_ARRAY[@]}" | sed 's/,$//')]"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  LOB Setup: ${TENANT}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Tenant ID         : $TENANT"
echo "  Agent ID          : $AGENT_ID"
echo "  Cost centre       : $COST_CENTRE"
echo "  Workload account  : $WORKLOAD_ACCOUNT"
echo "  Region            : $REGION"
echo "  Availability zones: $AZS"
echo "  VPC CIDR          : $VPC_CIDR"
echo "  S3 source bucket  : $BUCKET_NAME"
echo "  ECR repo          : $ECR_REPO"
echo "  M2M secret ARN    : $M2M_SECRET_ARN"
echo "  Inference URL     : $INFERENCE_URL"
echo "  Inference model   : $INFERENCE_MODEL"
[[ -n "$USER_POOL_ID"    ]] && echo "  User pool ID      : $USER_POOL_ID"
[[ -n "$USER_POOL_CLIENT" ]] && echo "  User pool client  : $USER_POOL_CLIENT"
[[ -n "$NOTIFICATION_EMAIL" ]] && echo "  Notification email: $NOTIFICATION_EMAIL"
[[ -n "$GITLAB_PROJECT_ID"  ]] && echo "  GitLab project ID : $GITLAB_PROJECT_ID"
[[ "$DRY_RUN" == true ]] && echo "  Mode              : DRY RUN - no changes"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run - would write cdk.context.json and commit."
  echo ""
  echo "GitLab CI variables to set (Settings → CI/CD → Variables):"
  echo "  PIPELINE_SOURCE_BUCKET = ${BUCKET_NAME}"
  echo "  PIPELINE_SOURCE_KEY    = workload-source.zip"
  echo "  AWS_ROLE_ARN           = <IAM role ARN from platform team>"
  exit 0
fi

# ── Working-tree clean check ───────────────────────────────────────────────────
if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

# ── Write cdk.context.json ────────────────────────────────────────────────────
echo "Writing cdk.context.json..."

# Build optional fields
OPTIONAL_FIELDS=""
if [[ -n "$USER_POOL_ID" ]]; then
  OPTIONAL_FIELDS+="
  \"agenticai/externalUserPoolId\":       \"${USER_POOL_ID}\","
fi
if [[ -n "$USER_POOL_CLIENT" ]]; then
  OPTIONAL_FIELDS+="
  \"agenticai/externalUserPoolClientId\": \"${USER_POOL_CLIENT}\","
fi
if [[ -n "$NOTIFICATION_EMAIL" ]]; then
  OPTIONAL_FIELDS+="
  \"agenticai/notificationEmail\":        \"${NOTIFICATION_EMAIL}\","
fi

cat > "$CONTEXT_FILE" <<JSON
{
  "agenticai/defaultRegion":        "${REGION}",
  "agenticai/workloadAccountId":    "${WORKLOAD_ACCOUNT}",
  "agenticai/vpcCidr":              "${VPC_CIDR}",
  "agenticai/availabilityZones":    ${AZ_JSON},
  "agenticai/tenantId":             "${TENANT}",
  "agenticai/agentId":              "${AGENT_ID}",
  "agenticai/costCentre":           "${COST_CENTRE}",
  "agenticai/envName":              "nonprod",
  "agenticai/deployWorkloadApp":    true,

  "agenticai/inferenceM2mSecretArn": "${M2M_SECRET_ARN}",
  "agenticai/inferenceGatewayUrl":   "${INFERENCE_URL}",
  "agenticai/inferenceModelId":      "${INFERENCE_MODEL}"${OPTIONAL_FIELDS:+,${OPTIONAL_FIELDS}}
}
JSON

echo "cdk.context.json written."

# ── Create CI runner IAM role ─────────────────────────────────────────────────
CI_RUNNER_ROLE_ARN=""
CI_RUNNER_USER_ARN="${CI_RUNNER_USER_ARN:-arn:aws:iam::REPLACE_ME:user/REPLACE_ME}"

ROLE_NAME="agenticai-ci-runner-${TENANT}"
PLATFORM_SOURCE_BUCKET_ARN="arn:aws:s3:::agenticai-pipeline-source-${TENANT}"

echo "Creating CI runner IAM role '${ROLE_NAME}' in workload account..."
CI_RUNNER_ROLE_ARN=$(aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Principal\": { \"AWS\": \"${CI_RUNNER_USER_ARN}\" },
      \"Action\": \"sts:AssumeRole\"
    }]
  }" \
  --description "CI runner role for ${TENANT} LOB — allows S3 upload to platform pipeline source bucket" \
  --query 'Role.Arn' --output text 2>&1) || {
    echo "Warning: could not create IAM role (may already exist). Fetching existing ARN..." >&2
    CI_RUNNER_ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || echo "")
  }

if [[ -n "$CI_RUNNER_ROLE_ARN" && "$CI_RUNNER_ROLE_ARN" != *"REPLACE_ME"* ]]; then
  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "PipelineSourceUpload" \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:PutObject\", \"s3:GetBucketVersioning\"],
        \"Resource\": [\"${PLATFORM_SOURCE_BUCKET_ARN}\", \"${PLATFORM_SOURCE_BUCKET_ARN}/*\"]
      }]
    }"
  echo "  CI runner role ready: ${CI_RUNNER_ROLE_ARN}"
else
  echo "  Skipped — replace CI_RUNNER_USER_ARN placeholder and re-run, or create the role manually."
  CI_RUNNER_ROLE_ARN="<create role manually — trust your CI IAM user, allow s3:PutObject on ${PLATFORM_SOURCE_BUCKET_ARN}>"
fi

# ── GitLab CI variables ───────────────────────────────────────────────────────
if [[ -n "$GITLAB_PROJECT_ID" ]]; then
  if command -v glab &>/dev/null; then
    echo "Setting GitLab CI variables via glab..."
    glab variable set PIPELINE_SOURCE_BUCKET --value "$BUCKET_NAME"    --project "$GITLAB_PROJECT_ID" --masked=false
    glab variable set PIPELINE_SOURCE_KEY    --value "workload-source.zip" --project "$GITLAB_PROJECT_ID" --masked=false
    echo "GitLab CI variables set."
  else
    echo "Warning: glab CLI not found - set these CI variables manually:" >&2
    echo "  PIPELINE_SOURCE_BUCKET = ${BUCKET_NAME}" >&2
    echo "  PIPELINE_SOURCE_KEY    = workload-source.zip" >&2
  fi
else
  echo ""
  echo "Set these CI/CD variables:"
  echo "  PIPELINE_SOURCE_BUCKET = ${BUCKET_NAME}"
  echo "  PIPELINE_SOURCE_KEY    = workload-source.zip"
  echo "  AWS_ROLE_ARN           = ${CI_RUNNER_ROLE_ARN}"
fi

# ── Commit ────────────────────────────────────────────────────────────────────
git -C "$REPO_ROOT" add "$CONTEXT_FILE"
git -C "$REPO_ROOT" commit -m "$(cat <<EOF
chore(setup): configure tenant ${TENANT}

Workload account: ${WORKLOAD_ACCOUNT}
Region: ${REGION} / AZs: ${AZS}
Inference model: ${INFERENCE_MODEL}

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"

echo ""
echo "✓ Done. Next steps:"
echo ""
echo "  1. Push and open an MR:"
echo "       git push origin main"
echo ""
echo "  2. On merge to main, GitLab CI uploads to S3 and the platform pipeline fires."
echo "     Watch it at: AWS Console → CodePipeline → agenticai-workload-s3-${TENANT}-${AGENT_ID}"
echo "     (platform account - ask the platform team for console access if needed)"
echo ""
echo "  3. Push your first agent image to ECR before the pipeline reaches the Nonprod stage:"
echo "       aws ecr get-login-password --region ${REGION} | \\"
echo "         docker login --username AWS --password-stdin ${WORKLOAD_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
echo "       docker tag your-agent:latest ${ECR_REPO}:v1"
echo "       docker push ${ECR_REPO}:v1"
echo ""
echo "  4. Wire the image URI in workload-app-stack.ts and add it to cdk.context.json:"
echo "       \"agenticai/yourAgentImageUri\": \"${ECR_REPO}:v1\""
echo ""
echo "  See docs/WORKLOAD_SETUP.md for the full walkthrough."
