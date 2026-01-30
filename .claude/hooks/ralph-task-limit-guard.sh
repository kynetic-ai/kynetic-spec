#!/bin/bash
# Ralph task limit guard - blocks task start when limit reached
#
# AC: @ralph-task-limit ac-hook-block
#
# This hook provides hard enforcement of the --max-tasks limit.
# Ralph writes a marker file when the limit is reached; this hook
# blocks 'kspec task start' commands when that marker exists.

# Marker file location (relative to project root)
MARKER_FILE=".claude/ralph-task-limit.json"

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command from the JSON input
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# If no command, allow (not a Bash tool call)
if [ -z "$COMMAND" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Only check commands that match "kspec task start"
if [[ ! "$COMMAND" =~ kspec[[:space:]]+task[[:space:]]+start ]]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Get cwd from hook input to find marker file
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
if [ -z "$CWD" ]; then
  CWD="$PWD"
fi

# Find project root by walking up looking for .claude directory
PROJECT_ROOT="$CWD"
while [ "$PROJECT_ROOT" != "/" ]; do
  if [ -d "$PROJECT_ROOT/.claude" ]; then
    break
  fi
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done

if [ "$PROJECT_ROOT" = "/" ]; then
  # No .claude directory found, allow
  echo '{"decision": "allow"}'
  exit 0
fi

MARKER_PATH="$PROJECT_ROOT/$MARKER_FILE"

# Check if marker file exists
if [ ! -f "$MARKER_PATH" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Read marker file and check if active
ACTIVE=$(jq -r '.active // false' "$MARKER_PATH" 2>/dev/null)
if [ "$ACTIVE" != "true" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Extract limit info for error message
MAX=$(jq -r '.max // "?"' "$MARKER_PATH" 2>/dev/null)
COMPLETED=$(jq -r '.completed // "?"' "$MARKER_PATH" 2>/dev/null)

# Block the command
cat <<EOF
{
  "decision": "block",
  "reason": "[ralph-task-limit-guard] BLOCKED: Task limit reached (${COMPLETED}/${MAX} tasks completed this iteration). This limit was set by --max-tasks. Please wrap up current work and let the iteration end naturally. Do not attempt to start new tasks."
}
EOF
exit 0
