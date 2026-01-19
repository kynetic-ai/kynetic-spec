#!/bin/bash
# Guard against dangerous git operations in .kspec worktree
#
# This hook prevents accidentally creating branches or switching
# branches in the .kspec worktree, which should always stay on kspec-meta.

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command from the JSON input
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# If no command, allow (not a Bash tool call)
if [ -z "$COMMAND" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Block deleting kspec-meta from anywhere
if [[ "$COMMAND" == *"git branch -d kspec-meta"* || "$COMMAND" == *"git branch -D kspec-meta"* ]]; then
  cat <<EOF
{
  "decision": "block",
  "reason": "[kspec-worktree-guard] BLOCKED: Cannot delete kspec-meta branch. This is the main branch for the .kspec worktree."
}
EOF
  exit 0
fi

# Get cwd from hook input (not pwd - hook runs in different context)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
IN_KSPEC=false

if [[ "$CWD" == *"/.kspec"* || "$CWD" == *"/.kspec" ]]; then
  IN_KSPEC=true
fi

# Also check if command contains cd to .kspec
if [[ "$COMMAND" == *"cd "*".kspec"* || "$COMMAND" == *"cd .kspec"* ]]; then
  IN_KSPEC=true
fi

if [ "$IN_KSPEC" = false ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Dangerous patterns in .kspec (branch creation/modification/history rewriting)
# Note: "git checkout kspec-meta" is safe and allowed
DANGEROUS_PATTERNS=(
  # Branch creation
  "git checkout -b"
  "git checkout -B"
  "git branch -c"
  "git branch -C"
  "git branch -m"
  "git branch -M"
  "git switch -c"
  "git switch -C"
  "git switch --create"
  # History rewriting - these can cause conflicts with active sessions
  "git reset"
  "git rebase"
  "git cherry-pick"
  "git commit --amend"
  # Force push
  "git push --force"
  "git push -f"
  # Discarding changes
  "git stash"
  "git clean"
  "git checkout -- "
  "git restore"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if [[ "$COMMAND" == *"$pattern"* ]]; then
    cat <<EOF
{
  "decision": "block",
  "reason": "[kspec-worktree-guard] BLOCKED: Dangerous git operation in .kspec worktree. This worktree contains active session data and must stay on kspec-meta. Operations like reset, rebase, stash, and clean can corrupt session files. Change to main repo first: cd /home/chapel/Projects/kynetic-spec"
}
EOF
    exit 0
  fi
done

# Allow all other commands
echo '{"decision": "allow"}'
