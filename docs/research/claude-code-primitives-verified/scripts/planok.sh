#!/bin/bash
payload=$(cat)
echo "$(date +%T) planok $1 $(printf '%s' "$payload" | /usr/bin/python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d.get("session_id","")[:8], d.get("tool_name"), d.get("permission_mode"), json.dumps(d.get("permission_suggestions"))[:300])')" >> /private/tmp/claude-501/-Users-hoangta-workspace-pi-config/457109b8-ad0e-41c3-9ed6-0bb71b7f38db/scratchpad/exp/logs/planok.log
if [ "$1" = setauto ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}}}'
else
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
fi
