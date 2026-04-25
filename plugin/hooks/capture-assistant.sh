#!/bin/bash
# Stop hook — echoes the assistant's last turn text to the dialogue UI.
# Reads the JSONL transcript and accumulates all assistant text blocks since
# the last user message. Each transcript entry is a single content block,
# so a turn with text + tool calls produces multiple "type":"assistant"
# entries; we need to concatenate the text ones.
set -e

LOG=/tmp/sprite-dialogue.log

URL=$(cat /tmp/sprite-dialogue-url 2>/dev/null) || exit 0
[ -z "$URL" ] && exit 0

input=$(cat)
transcript=$(echo "$input" | jq -r '.transcript_path // empty')
if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then
  echo "$(date -u +%FT%T.%3NZ) [stop-hook] no transcript path" >> "$LOG"
  exit 0
fi

# Walk the transcript, resetting accumulator on each user entry, appending
# each assistant text block. Final value = all assistant text since the
# last user message.
text=$(jq -rs '
  # A user entry is a turn boundary only if it carries real user input.
  # Tool results also appear as type:"user" but should NOT reset the
  # accumulator since they are part of the assistant turn.
  def isRealUserInput($e):
    ($e.message // {}).content as $c |
    ($c | type) == "string"
    or (($c | type) == "array" and ($c | any(.type == "text")));
  reduce .[] as $e ("";
    ($e.type // "") as $t |
    if $t == "user" and isRealUserInput($e) then ""
    elif $t == "assistant" then
      ((($e.message // {}).content) // []) as $c |
      if ($c | type) == "array" then
        . + ($c | map(select(.type == "text") | .text) | join(""))
      else . end
    else . end
  )
' "$transcript")

if [ -z "$text" ]; then
  echo "$(date -u +%FT%T.%3NZ) [stop-hook] no text in last turn (tool-only)" >> "$LOG"
  exit 0
fi

echo "$(date -u +%FT%T.%3NZ) [stop-hook] echoing ${#text} chars" >> "$LOG"

curl -s --max-time 2 -X POST "$URL/echo" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg t "$text" '{type:"assistant", text:$t}')" >/dev/null || true
