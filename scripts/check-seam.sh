#!/usr/bin/env bash
# Enforce the provider seam (acceptance #12): no provider SDK may be imported
# outside server/providers/. Keep this green.
set -euo pipefail

leak=$(grep -rEn "from ['\"]@octokit|from ['\"]@gitbeaker|require\(['\"]@octokit|require\(['\"]@gitbeaker" \
  server web --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v 'server/providers/' || true)

if [ -n "$leak" ]; then
  echo "✗ Provider SDK import leaked outside server/providers/:"
  echo "$leak"
  exit 1
fi

echo "✓ seam clean: no @octokit/@gitbeaker imports outside server/providers/"
