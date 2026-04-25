#!/bin/bash
# UserPromptSubmit hook — echoes terminal-typed user prompts to the dialogue UI.
# Skips channel-sourced messages (those start with "<channel source=") since
# the user already sees them in the UI.
set -e

URL=$(cat /tmp/sprite-dialogue-url 2>/dev/null) || exit 0
[ -z "$URL" ] && exit 0

input=$(cat)
prompt=$(echo "$input" | jq -r '.prompt // empty')
[ -z "$prompt" ] && exit 0

# Skip channel-sourced inputs to avoid duplicates
case "$prompt" in
  '<channel source='*) exit 0 ;;
esac

curl -s --max-time 2 -X POST "$URL/echo" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$prompt" '{type:"user", text:$t}')" >/dev/null || true
