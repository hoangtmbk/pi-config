#!/bin/bash
ev="$1"; payload=$(cat)
log=/private/tmp/claude-501/-Users-hoangta-workspace-pi-config/457109b8-ad0e-41c3-9ed6-0bb71b7f38db/scratchpad/exp/logs/hooks.log
printf '%s %s sock=%s tok=%s %s\n' "$(date +%T)" "$ev" "${CLAUDE_CODE_MESSAGING_SOCKET:-}" "${CLAUDE_CODE_MESSAGING_TOKEN:+set}" "$payload" >> "$log"
if [ "$ev" = SessionStart ]; then env | grep -E '^CLAUDE_CODE_(MESSAGING|SESSION)' > /private/tmp/claude-501/-Users-hoangta-workspace-pi-config/457109b8-ad0e-41c3-9ed6-0bb71b7f38db/scratchpad/exp/logs/env-$(date +%s).txt; fi
exit 0
