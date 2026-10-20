#!/usr/bin/env bash
# create-iam-users.sh — Create the two IAM principals needed to deploy a LOB workload.
#
# Creates:
#   1. agenticai-lob-deployer   — local CLI user (bootstrap + ECR push + optional role creation)
#   2. agenticai-ci-runner      — GitLab CI user (s3:PutObject to pipeline source bucket only)
#
# Usage:
#   ./scripts/create-iam-users.sh --tenant payors --workload-account 172873868821
#
# Optional flags:
#   --region        us-east-1   (default: us-east-1)
#   --dry-run                   (print what would be created, no AWS calls)
#
# Prerequisites:
#   - AWS CLI configured with credentials that have IAM admin access in the workload account
#   - Run from any directory (script is self-contained)
#
set -euo pipefail

# ── Arg parse ─────────────────────────────────────────────────────────────────
TENANT=""
WORKLOAD_ACCOUNT=""
REGION="us-east-1"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant)           TENANT="$2";           shift 2 ;;
    --workload-account) WORKLOAD_ACCOUNT="$2"; shift 2 ;;
    --region)           REGION="$2";           shift 2 ;;
    --dry-run)          DRY_RUN=true;          shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── Validate ──────────────────────────────────────────────────────────────────
errors=()
[[ -z "$TENANT"           ]] && errors+=("--tenant is required")
[[ -z "$WORKLOAD_ACCOUNT" ]] && errors+=("--workload-account is required")

if [[ -n "$WORKLOAD_ACCOUNT" ]] && ! [[ "$WORKLOAD_ACCOUNT" =~ ^[0-9]{12}$ ]]; then
  errors+=("--workload-account must be a 12-digit AWS account ID")
fi

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "Errors:" >&2
  for e in "${errors[@]}"; do echo "  • $e" >&2; done
  exit 1
fi

# ── Derived values ─────────────────────────────────────────────────────────────
# IAM principals are tenant-scoped so multiple LOBs can share ONE workload account
# without colliding (or silently sharing/rotating each other's credentials).
DEPLOYER_USER="agenticai-lob-deployer-${TENANT}"
CI_USER="agenticai-ci-runner-${TENANT}"
DEPLOYER_POLICY="agenticai-lob-deployer-policy-${TENANT}"
CI_POLICY="agenticai-ci-runner-policy-${TENANT}"
SOURCE_BUCKET_ARN="arn:aws:s3:::agenticai-pipeline-source-${TENANT}"
ECR_REPO_ARN="arn:aws:ecr:${REGION}:${WORKLOAD_ACCOUNT}:repository/agenticai-nonprod-${TENANT}-*"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Create IAM users: ${TENANT} / ${WORKLOAD_ACCOUNT}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deployer user : ${DEPLOYER_USER}"
echo "  CI runner user: ${CI_USER}"
echo "  Source bucket : ${SOURCE_BUCKET_ARN}"
echo "  ECR repo      : ${ECR_REPO_ARN}"
[[ "$DRY_RUN" == true ]] && echo "  Mode          : DRY RUN - no AWS calls"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "Would create:"
  echo "  IAM user: ${DEPLOYER_USER} with policy ${DEPLOYER_POLICY}"
  echo "  IAM user: ${CI_USER} with policy ${CI_POLICY}"
  echo "  Access keys for both users (printed to stdout)"
  exit 0
fi

# ── Helper ────────────────────────────────────────────────────────────────────
create_user_if_missing() {
  local user="$1"
  if aws iam get-user --user-name "$user" &>/dev/null; then
    echo "  User '${user}' already exists — skipping creation."
  else
    aws iam create-user --user-name "$user" > /dev/null
    echo "  Created user: ${user}"
  fi
}

put_inline_policy() {
  local user="$1" policy_name="$2" policy_doc="$3"
  aws iam put-user-policy \
    --user-name "$user" \
    --policy-name "$policy_name" \
    --policy-document "$policy_doc"
  echo "  Attached policy '${policy_name}' to '${user}'"
}

create_access_key() {
  local user="$1"
  local result
  result=$(aws iam create-access-key --user-name "$user")
  local key_id secret
  key_id=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin)['AccessKey']; print(d['AccessKeyId'])")
  secret=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin)['AccessKey']; print(d['SecretAccessKey'])")
  echo "$key_id $secret"
}

# ── 1. LOB deployer user ──────────────────────────────────────────────────────
echo "Creating LOB deployer user (${DEPLOYER_USER})..."
create_user_if_missing "$DEPLOYER_USER"

put_inline_policy "$DEPLOYER_USER" "$DEPLOYER_POLICY" '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CdkBootstrap",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:GetTemplate",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet"
      ],
      "Resource": "arn:aws:cloudformation:'"${REGION}"':'"${WORKLOAD_ACCOUNT}"':stack/CDKToolkit/*"
    },
    {
      "Sid": "CdkBootstrapIam",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:DeleteRole",
        "iam:TagRole",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::'"${WORKLOAD_ACCOUNT}"':role/cdk-*"
    },
    {
      "Sid": "CdkBootstrapS3",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketPolicy",
        "s3:PutBucketVersioning",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutEncryptionConfiguration",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:DeleteBucket"
      ],
      "Resource": "arn:aws:s3:::cdk-*"
    },
    {
      "Sid": "CdkBootstrapEcr",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:SetRepositoryPolicy",
        "ecr:PutLifecyclePolicy",
        "ecr:DeleteRepository",
        "ecr:TagResource"
      ],
      "Resource": "arn:aws:ecr:'"${REGION}"':'"${WORKLOAD_ACCOUNT}"':repository/cdk-*"
    },
    {
      "Sid": "CdkBootstrapSsm",
      "Effect": "Allow",
      "Action": [
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:DeleteParameter"
      ],
      "Resource": "arn:aws:ssm:'"${REGION}"':'"${WORKLOAD_ACCOUNT}"':parameter/cdk-bootstrap/*"
    },
    {
      "Sid": "EcrPush",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EcrPushRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:DescribeImages"
      ],
      "Resource": "'"${ECR_REPO_ARN}"'"
    },
    {
      "Sid": "CiRoleCreation",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:TagRole"
      ],
      "Resource": "arn:aws:iam::'"${WORKLOAD_ACCOUNT}"':role/agenticai-ci-runner-*"
    }
  ]
}'

echo ""
echo "Creating access key for ${DEPLOYER_USER}..."
read -r DEPLOYER_KEY_ID DEPLOYER_SECRET <<< "$(create_access_key "$DEPLOYER_USER")"

# ── 2. CI runner user ─────────────────────────────────────────────────────────
echo ""
echo "Creating CI runner user (${CI_USER})..."
create_user_if_missing "$CI_USER"

put_inline_policy "$CI_USER" "$CI_POLICY" '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PipelineSourceUpload",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetBucketVersioning"
      ],
      "Resource": [
        "'"${SOURCE_BUCKET_ARN}"'",
        "'"${SOURCE_BUCKET_ARN}"'/*"
      ]
    }
  ]
}'

echo ""
echo "Creating access key for ${CI_USER}..."
read -r CI_KEY_ID CI_SECRET <<< "$(create_access_key "$CI_USER")"

# ── Output ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Done — save these credentials now, they won't be shown again"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "── LOB Deployer (agentops-consumer AWS CLI profile) ──"
echo "  aws configure --profile agentops-consumer"
echo "    AWS Access Key ID     : ${DEPLOYER_KEY_ID}"
echo "    AWS Secret Access Key : ${DEPLOYER_SECRET}"
echo "    Default region        : ${REGION}"
echo ""
echo "── GitLab CI Runner ──"
echo "  GitLab CI/CD variable  AWS_ACCESS_KEY_ID     = ${CI_KEY_ID}"
echo "  GitLab CI/CD variable  AWS_SECRET_ACCESS_KEY = ${CI_SECRET}"
echo "  GitLab CI/CD variable  PIPELINE_SOURCE_BUCKET = agenticai-pipeline-source-${TENANT}"
echo "  GitLab CI/CD variable  PIPELINE_SOURCE_KEY    = workload-source.zip"
echo ""
echo "  (AWS_ROLE_ARN is not needed — the CI user has direct s3:PutObject access)"
echo ""
echo "  Mark AWS_SECRET_ACCESS_KEY as 'Masked' in GitLab CI/CD settings."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
