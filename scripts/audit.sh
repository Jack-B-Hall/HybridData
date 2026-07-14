#!/usr/bin/env bash
# Prove the repository is free of the banned upstream project names.
#
# The forbidden patterns are assembled from fragments so this audit script does
# not itself contain the literal strings it searches for (otherwise the audit
# would flag its own source).
set -euo pipefail

cd "$(dirname "$0")/.."

A="nul""ka"
B="nai""poc"
PATTERN="${A}|${B}"

matches=$(grep -rilE "$PATTERN" \
    --exclude-dir=.git --exclude-dir=.venv \
    --exclude-dir=node_modules --exclude-dir=dist \
    --exclude="audit.sh" . || true)

if [ -n "$matches" ]; then
    echo "AUDIT FAILED — banned strings found in:"
    echo "$matches"
    exit 1
fi
echo "AUDIT CLEAN — no banned strings in the repository."
