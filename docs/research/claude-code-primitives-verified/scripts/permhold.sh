#!/bin/bash
hold="$1"; payload=$(cat)
log=/private/tmp/claude-501/-Users-hoangta-workspace-pi-config/457109b8-ad0e-41c3-9ed6-0bb71b7f38db/scratchpad/exp/logs/permhold.log
sid=$(printf '%s' "$payload" | /usr/bin/python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d.get("session_id","")[:8], d.get("tool_name"), d.get("permission_mode"))')
echo "$(date +%T) start hold=$hold $sid" >> "$log"
sleep "$hold"
echo "$(date +%T) end hold=$hold $sid -> allow" >> "$log"
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
