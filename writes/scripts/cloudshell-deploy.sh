#!/usr/bin/env bash
# CloudShell / authorized admin helper for Approval A only.
# Do NOT run until the user approves isolated Writes deployment.
# Never paste long-lived keys into chat.
set -euo pipefail
REGION="${AWS_REGION:-us-west-2}"
STACK="${STACK_NAME:-socialdeskclub-writes}"
BUCKET="${SITE_BUCKET:-socialdeskclub.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Identity =="
aws sts get-caller-identity
aws configure get region || true

echo "== Preflight (read-only) =="
aws s3api get-bucket-location --bucket "$BUCKET"
aws dynamodb describe-table --region "$REGION" --table-name reads-users --query 'Table.TableName'
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" 2>/dev/null \
  || echo "Stack $STACK not found (expected on first deploy)."

if [[ "${EXECUTE:-}" != "1" ]]; then
  echo
  echo "Read-only preflight complete. Re-run with EXECUTE=1 only after Approval A."
  echo "Example:"
  echo "  EXECUTE=1 $0"
  exit 0
fi

echo "== Creating change set (no execute yet via --no-execute-changeset) =="
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$ROOT/writes-stack.yaml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ExistingUsersTable=reads-users \
  --no-execute-changeset

echo "Inspect the change set in the console or CLI, then execute THAT change set only."
echo "After the stack is CREATE/UPDATE_COMPLETE:"
echo "  aws lambda update-function-code --region $REGION --function-name ${STACK}-api --zip-file fileb://$ROOT/writes-api.zip"
echo "  aws lambda wait function-updated --region $REGION --function-name ${STACK}-api"
echo "  aws cloudformation describe-stacks --region $REGION --stack-name $STACK --query 'Stacks[0].Outputs' --output table"
echo "Substitute WritesApiEndpoint into $ROOT/frontend/config.js, then upload the four frontend files only."
