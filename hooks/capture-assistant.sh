#!/bin/bash
# Stop hook — echoes the assistant's last turn text to the dialogue UI.
# Reads the JSONL transcript, finds the last assistant entry, extracts text blocks.
set -e

URL=$(cat /tmp/sprite-dialogue-url 2>/dev/null) || exit 0
[ -z "$URL" ] && exit 0

input=$(cat)
transcript=$(echo "$input" | jq -r '.transcript_path // empty')
[ -z "$transcript" ] || [ ! -f "$transcript" ] && exit 0

# Extract the last assistant entry's text blocks, joined.
text=$(jq -s '
  map(select(.type == "assistant" and (.message.content | type == "array")))
  | last
  | (.message.content // [])
  | map(select(.type == "text") | .text)
  | join("")
' "$transcript")

# jq -s on JSONL fails on some edge cases; if empty/null, bail
[ -z "$text" ] || [ "$text" = "null" ] || [ "$text" = '""' ] && exit 0

# jq returns a JSON-quoted string; pass through to a payload
curl -s --max-time 2 -X POST "$URL/echo" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --argjson t "$text" '{type:"assistant", text:$t}')" >/dev/null || true
