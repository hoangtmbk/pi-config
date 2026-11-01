#!/bin/bash
payload=$(cat)
cmd=$(printf '%s' "$payload" | /usr/bin/python3 -I -c 'import json,sys; d=json.load(sys.stdin); print((d.get("tool_input") or {}).get("command",""))')
case "$cmd" in
  *"git push"*)
    echo "$(date +%T) floor ask: $cmd" >> /private/tmp/claude-501/-Users-hoangta-workspace-pi-config/457109b8-ad0e-41c3-9ed6-0bb71b7f38db/scratchpad/exp/logs/floor.log
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Floor action: git push needs the Lead or the human"}}' ;;
esac
exit 0
