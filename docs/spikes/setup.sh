#!/usr/bin/env bash
# Build a throwaway scratch repository for spikes R1–R6 (docs/plan.md §10).
#
# The repo's default branch is `develop`, not `main`, so R6 is tested too.
# It has a local bare "origin" and a stub project skill. Nothing here
# touches the network or any real project.
#
# Usage: bash docs/spikes/setup.sh [dir]   (default: /tmp/bb-spike)
set -euo pipefail

ROOT="${1:-/tmp/bb-spike}"
if [ -e "$ROOT" ]; then
  echo "refusing: $ROOT already exists (remove it or pass another dir)" >&2
  exit 1
fi

mkdir -p "$ROOT"
git init -q --bare -b develop "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/work" 2>/dev/null
cd "$ROOT/work"
git checkout -q -B develop

cat > README.md <<'EOF'
# bb-spike
Throwaway scratch repo for speckit-bug-batch spikes. Safe to delete.
EOF
printf '.claude/worktrees/\n.claude/settings.local.json\n' > .gitignore

mkdir -p .claude/skills/stub-assess
cat > .claude/skills/stub-assess/SKILL.md <<'EOF'
---
name: stub-assess
description: Spike stub standing in for /speckit-bug-assess. Writes a fixed assessment file in the current working tree.
---

Write the file `.specify/bugs/stub/assessment.md` in the current working
directory, creating folders as needed, with exactly this content:

    # Stub assessment
    verdict: valid

Then reply with the absolute path of the file you wrote and the output of
`git rev-parse --show-toplevel`. Do nothing else.
EOF

git add -A
git -c user.name=spike -c user.email=spike@example.invalid commit -q -m "spike: initial"
git -c push.negotiate=false push -q -u origin develop
git remote set-head origin develop >/dev/null

echo "scratch repo ready: $ROOT/work (default branch: develop)"
echo "next: cd $ROOT/work && claude    # accept the trust prompt"
echo "then paste docs/spikes/spike-prompt.md into that session"
