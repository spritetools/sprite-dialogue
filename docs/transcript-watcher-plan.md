# Plan: replace hooks with a transcript watcher in the bun server

## Why

The current hook-based mirroring is racy. The `Stop` hook fires *before* Claude Code finishes flushing the assistant's final text block to the JSONL transcript, so the hook's jq runs on a partial file and finds no text. We've confirmed this by overlaying log timestamps:

```
06:24:56.299Z  transcript idx 93 written  ("## Findings...")
06:24:56.484Z  stop-hook fires             → echoes 110 chars (= idx 73 only)
```

Between idx 73 and idx 93 there are no user-reset entries — only `tool_use`/`tool_result`/`thinking`. If both lines had been on disk the hook would have concatenated them. They weren't. The entry's internal timestamp is a *composition* timestamp, not a flush time.

We could band-aid with `sleep`, mtime polling, or a retry loop in the hook, but the cleaner fix is to remove the hook from the data path entirely. Have the bun MCP server (which is already running and has filesystem access) tail the JSONL itself. Race-free by construction: we don't read until Claude has flushed.

A bonus: this lets us delete both hooks (`Stop` and `UserPromptSubmit`) and simplify install. The plugin becomes a single MCP server with no auxiliary hook scripts.

## What we keep, what we drop

Keep:
- `server.ts` MCP channel (inbound UI→Claude flow is unchanged — WebSocket → `deliver()` → channel notification).
- `send_image` MCP tool (the tool is the only Claude-initiated sending mechanism we need).
- `/echo` HTTP endpoint? **Drop it.** No external producer remains; the server now generates echo events internally.
- The web UI as-is (it's a passive consumer).

Drop:
- `plugin/hooks/` directory (entire — both scripts and `hooks.json`).
- `/echo` endpoint in `server.ts` (was POSTed to by the hooks).
- The `[stop-hook]` and `[ws] message dropped` log lines that referenced the hook flow (replace with `[transcript]` lines).

## Architecture

The bun server gains a `watchTranscripts()` loop that:

1. **Discovers transcript files.** Scans `~/.claude/projects/*/` for `*.jsonl`. We don't need to identify *the* active session — multiple sessions in the same project would all reflect in the UI, which is acceptable for this tool.
2. **Snapshots existing files at startup** with offset = current size. We do *not* replay history when the server starts; we only forward new content from now on.
3. **Discovers new files** that appear after startup (= a new Claude session). For these, we DO process from offset 0, since the whole file is new content.
4. **Polls every 250–500ms.** For each known file, `statSync` to check size. If it grew, read the new bytes, split on `\n`, parse each line as JSON, run it through `processEntry()`.
5. **`processEntry(entry)` rules:**
   - `entry.type === "assistant"` and `entry.message.content` is an array → join all `{type:"text"}` block texts. If non-empty after trimming, broadcast as assistant message.
   - `entry.type === "user"`:
     - If content is a string → that's the user text.
     - If content is an array containing a `tool_result` block → skip (it's a tool result, not user input).
     - If content is an array → join all `{type:"text"}` block texts.
     - Skip if text starts with `<channel source=` (it's a channel notification we already showed in the UI).
     - Otherwise broadcast as user message.
   - All other entry types (`thinking`, system metadata like `custom-title`, `agent-name`, etc.) → ignore.

Use `appendFileSync` log lines `[transcript] new file: ...`, `[transcript] processed N lines from ...`, `[transcript] echoed assistant: ...` so we can debug.

`fs.watch` is an option for change notifications but Bun's implementation has cross-platform inconsistencies; **start with simple `setInterval` polling at 300ms.** It's plenty fast and avoids edge cases.

## Concrete implementation

### Files to change

1. `plugin/server.ts` — add the watcher; drop the `/echo` route.
2. `plugin/hooks/` — delete the directory entirely (`git rm -r plugin/hooks`).
3. `plugin/.claude-plugin/plugin.json` — no change needed (it doesn't reference hooks; Claude Code auto-discovers via the dir).
4. `README.md` — remove any mention of hooks. Update the "Architecture" section.
5. `TODO.md` — close out the relevant items, add any new follow-ups.
6. `CLAUDE.md` — update the "Architecture (current)" section to describe the watcher; remove "Known broken / about to fix" since this fixes it.

### `server.ts` insertion

Add this block AFTER `Bun.serve({...})` and BEFORE the `HTML` constant declaration. It uses already-imported `readdirSync`, `statSync`, `readFileSync`, `existsSync`. Add `existsSync` and `openSync`/`readSync`/`closeSync` to the import line if not present (Bun supports them in `fs`).

```ts
// ---------------------------------------------------------------------------
// Transcript watcher — mirrors assistant text and terminal user prompts to
// the UI. Replaces the previous Stop / UserPromptSubmit hook scripts.
// ---------------------------------------------------------------------------

const TRANSCRIPTS_ROOT = join(homedir(), '.claude', 'projects')
const transcriptOffsets = new Map<string, number>()
const seenTranscripts = new Set<string>()

function listTranscripts(): string[] {
  if (!existsSync(TRANSCRIPTS_ROOT)) return []
  const out: string[] = []
  try {
    for (const proj of readdirSync(TRANSCRIPTS_ROOT)) {
      const dir = join(TRANSCRIPTS_ROOT, proj)
      try {
        if (!statSync(dir).isDirectory()) continue
        for (const f of readdirSync(dir)) {
          if (f.endsWith('.jsonl')) out.push(join(dir, f))
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return out
}

function readNewBytes(path: string): string | null {
  try {
    const size = statSync(path).size
    const start = transcriptOffsets.get(path) ?? 0
    if (start >= size) return null
    const len = size - start
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, start)
      transcriptOffsets.set(path, size)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch { return null }
}

function isChannelText(s: string): boolean {
  return s.trimStart().startsWith('<channel source=')
}

function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // If there's any tool_result block, this is a tool turn, not real user text.
  if (content.some((b: any) => b?.type === 'tool_result')) return ''
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('')
}

function processEntry(entry: any): void {
  if (!entry || typeof entry !== 'object') return
  if (entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)) {
    const text = extractText(entry.message.content)
    if (!text.trim()) return
    broadcast({ type: 'msg', id: nextId(), from: 'assistant', text, ts: Date.now() })
    log(`[transcript] echoed assistant: ${text.slice(0, 80).replace(/\n/g, ' ')}`)
  } else if (entry.type === 'user' && entry.message) {
    const text = extractText(entry.message.content).trim()
    if (!text) return
    if (isChannelText(text)) return  // already in UI
    broadcast({ type: 'msg', id: nextId(), from: 'user', text, ts: Date.now() })
    log(`[transcript] echoed user: ${text.slice(0, 80).replace(/\n/g, ' ')}`)
  }
}

function pollTranscripts(): void {
  for (const path of listTranscripts()) {
    if (!seenTranscripts.has(path)) {
      // First time we see this file. If we're at startup, snapshot size to
      // skip history. If we're observing it appear later, it's a new session
      // — read from start.
      seenTranscripts.add(path)
      if (transcriptsInitialized) {
        transcriptOffsets.set(path, 0)
        log(`[transcript] new file: ${path}`)
      } else {
        try { transcriptOffsets.set(path, statSync(path).size) } catch {}
      }
    }
    const chunk = readNewBytes(path)
    if (!chunk) continue
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      try { processEntry(JSON.parse(line)) } catch { /* skip malformed lines */ }
    }
  }
}

let transcriptsInitialized = false

function startTranscriptWatcher(): void {
  // Initial snapshot: mark all currently existing transcripts as seen at
  // their current sizes so we don't replay history.
  for (const path of listTranscripts()) {
    seenTranscripts.add(path)
    try { transcriptOffsets.set(path, statSync(path).size) } catch {}
  }
  transcriptsInitialized = true
  setInterval(pollTranscripts, 300)
  log(`[transcript] watcher started (root=${TRANSCRIPTS_ROOT}, snapshot=${seenTranscripts.size} files)`)
}

startTranscriptWatcher()
```

### `/echo` route removal

In the `Bun.serve({ fetch: ... })` handler, find the block that handles `url.pathname === '/echo' && req.method === 'POST'` and delete it. Verify nothing else references `/echo`.

### Hook directory removal

```
git rm -r plugin/hooks
```

That removes `plugin/hooks/hooks.json`, `plugin/hooks/capture-assistant.sh`, `plugin/hooks/capture-user-prompt.sh`. With Claude Code auto-discovering hooks from a plugin's `hooks/` directory, deleting it disables all hooks for the plugin without further config changes.

### MCP server `instructions` update

In `server.ts`, update the channel `instructions` string. The current one tells Claude that hooks mirror text automatically. That's still true — the *mechanism* changed, not the contract. But we should remove anything that explicitly references hooks (it'll be misleading). Keep the gist: "respond normally, your text appears in the UI; use `send_image` for images."

A cleaner phrasing:

```
The user may be viewing this conversation in two places at once: the
terminal where Claude Code is running, and the sprite-dialogue web UI in
their browser. They might be looking at either one at any moment.

The plugin automatically mirrors your conversational text to the UI as
you produce it — you don't need to call any tool to send text. Just
respond normally.

Messages from the web UI arrive as <channel source="sprite-dialogue"
chat_id="web" message_id="..." [file_name="..." file_path="..."]>. If
the tag has a file_path attribute, Read that file — it is a screenshot
or image upload from the user.

To send an IMAGE to the user, use the send_image tool with an absolute
file path. Use this only for images; text is mirrored automatically.

The UI is at the URL written to /tmp/sprite-dialogue-url (port derived
from this Sprite's hostname).
```

## Verification

1. **Local dev test on this Sprite (the one named `copy-paste`):**
   - From `/home/sprite/sprite-dialogue/plugin/` run `bun install` (no-op if up to date).
   - Launch Claude with `claude --dangerously-load-development-channels plugin:sprite-dialogue@inline --plugin-dir /home/sprite/sprite-dialogue/plugin --resume`.
   - Open `http://localhost:38858` in your laptop browser.
   - Send a UI message: it should arrive in Claude. Claude's reply should appear in the UI within ~300ms after the JSONL flushes.
   - Type a message in the terminal: it should appear in the UI as a user message (without the `<channel source=...>` wrapper).
   - Have Claude do a multi-block turn (text + tool + text). Both text segments should appear in the UI.
   - Confirm `/tmp/sprite-dialogue.log` shows `[transcript]` lines, no `[stop-hook]` lines.

2. **Fresh-Sprite install test:**
   - On the MacBook: `sprite create dialogue-test2 && sprite use dialogue-test2 && sprite console`.
   - In Claude on the new Sprite:
     ```
     /plugin marketplace add rphilander/sprite-dialogue
     /plugin install sprite-dialogue@sprite-dialogue
     /reload-plugins
     ```
   - Exit and relaunch with `claude --dangerously-load-development-channels plugin:sprite-dialogue@sprite-dialogue`.
   - `! cat /tmp/sprite-dialogue-url`, open in browser, exchange messages both ways.
   - Cleanup: `sprite destroy dialogue-test2`.

## Commit & push

When everything works, commit with the standard trailer:

```
git add -A
git -c user.name="Rodrigo Philander" -c user.email="rodrigo.philander@gmail.com" commit -m "$(cat <<'EOF'
Replace hooks with transcript watcher in the bun server

The Stop hook was racing the JSONL flush, so Claude's final assistant
text often arrived after the hook's jq had already given up. Move the
mirroring into the bun MCP server itself: poll ~/.claude/projects/*/*.jsonl
every 300ms, track byte offsets, and broadcast new assistant/user text
entries (skipping channel-sourced inputs and tool results). Drop the
hook scripts and the /echo HTTP endpoint they posted to.

Race-free by construction; install is also simpler now (no hook scripts
to copy).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push "https://x-access-token:$(cat .gh-token)@github.com/rphilander/sprite-dialogue.git" main:main
sprite-env checkpoints create --comment "sprite-dialogue: transcript watcher replaces hooks; race fix shipped"
```

Then update `TODO.md` to close out the resolved items and add any new ones.

## Edge cases worth keeping in mind

- **Two Claude sessions on the same project.** Both append to their own `.jsonl` files in the same project dir. Our watcher will pick up both. The UI will show interleaved messages. Acceptable; document if anyone hits it.
- **Server restart mid-conversation.** On restart, we snapshot all existing transcripts at their current sizes — meaning we skip the in-progress turn's content if the user already typed something but Claude hadn't replied yet. The next user message and reply will flow normally. Acceptable.
- **JSONL line wraps mid-write.** Possible if Claude writes a partial line, we read it, then it finishes. Our `JSON.parse` will throw; we silently skip. The next poll picks up the now-complete line because the offset advanced. Wait — that's actually a bug: if we advance offset past a partial line, we lose it. **Fix:** when splitting on `\n`, only consume *complete* lines (i.e., bytes ending in `\n`). Buffer the partial trailing fragment until the next read. Implementation: track `transcriptBuffers` Map<path, string> alongside offsets; concat new bytes onto the buffer, split on `\n`, process all but the last fragment, save last fragment back. Add this to the implementation.
