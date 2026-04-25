# sprite-dialogue TODO

Small enhancements and known issues to address.

## Enhancements

- [x] Pass original filename through channel meta as `file_name`
- [ ] Auto-restart the bun server on file changes during development (consider `bun --hot server.ts` or watch flag)
- [ ] Add a connection status indicator that's more visible (the 8px dot is subtle)
- [x] Plugin path (`--plugin-dir`) confirmed working for channels — the fix was using the right dev-flag tag: `plugin:sprite-dialogue@inline` (not `server:sprite-dialogue`). The "inline" marketplace name is what `--plugin-dir` synthesizes.
- [ ] Clear the input box: Escape key when focused, plus a clear button next to/inside the textarea
- [ ] Chime on turn completion — when an assistant turn ends (no further tool calls pending), play a short sound in the UI so the user is notified that a long-running turn is done. Should be muteable.
- [ ] Header in upper-left showing `<sprite-name>:<claude-session-name>`, mirrored into the page `<title>` so it's visible in the browser tab too
- [ ] Copy button on rendered code blocks — small icon in the corner of each `<pre>`/`<code>` block in markdown-rendered messages, clicks to copy the block contents to the clipboard
- [ ] Self-documenting UI — `?`/Help button that surfaces keyboard shortcuts, paste/drop behavior, and available channel features
- [ ] README quick-start — short top-of-README path from zero to "I see the UI in my browser" (install plugin → relaunch claude with flag → open `/tmp/sprite-dialogue-url`); push longer detail down
- [ ] Review shipped docs — audit what's in the repo (README + any plugin-bundled markdown) for accuracy, currency, and end-user-vs-developer-internal fitness
- [ ] LLM-served file links — new MCP tool that emits a clickable link in the chat (e.g. `<a target="_blank">…</a>`); a server endpoint streams the local file (with a path-safety allowlist) so the user can click to open it in a new tab. Useful for things like "let me show you the CLAUDE.md" or surfacing logs/screenshots that aren't images.
- [ ] Backfill chat history on WebSocket reconnect — today the UI loses everything on page refresh / `/mcp` reconnect / new tab. On every `ws.open`, before subscribing the client to live broadcasts, replay the last ~50 messages from the most recently modified `~/.claude/projects/*/*.jsonl` through the existing `processEntry` filter and send them to *that client only* (not broadcast — others already have them). Design choices captured: source = JSONL (survives both browser and bun restarts and is already the live path's source of truth); window = last 50 messages; multi-session = most-recently-modified file only (don't merge); images = text-only replay with a small `[image]` placeholder for v1; race handling = snapshot-then-live with no buffering (rely on the existing client-side `msgMap` id-based dedupe). Optional `snapshot-start`/`snapshot-end` markers so the UI can render the batch without auto-scroll thrashing.

## Known Issues

- [x] Occasional message drops: fixed by adding a client-side outbound queue that buffers messages when the WebSocket is reconnecting. Server-side logging at `/tmp/sprite-dialogue.log` left in place to catch any recurrence.

## Resolved

- [x] Stop-hook race: assistant text often missing from UI echoes because the hook fired before Claude flushed the final text block to the JSONL. Replaced both Stop and UserPromptSubmit hooks with a polling transcript watcher inside the bun MCP server (`~/.claude/projects/*/*.jsonl`, 300ms tick, per-file byte offsets, partial-line buffering). Race-free by construction.
- [x] Orphan bun processes blocking port reuse: `killOrphans()` originally filtered candidates by cwd-equality, which stranded servers from prior sessions whose cwd no longer matched (e.g. after the marketplace/plugin layout reorg). Replaced with a port-holder lookup: parse `/proc/net/tcp{,6}` for the listening socket inode, walk `/proc/*/fd/*` to find the owning PID, SIGTERM only if cmdline matches `bun server.ts`. Resilient to layout changes.
- [x] `bun install` hang on fresh Sprites: cross-mount-point rename (overlay target ↔ /tmp on /dev/vdb) triggered bun 1.3.11's fallback path, which deadlocked silently — Claude's MCP handshake timed out at ~30s with no log output. Pinned `BUN_TMPDIR` to `$PWD/.bun-tmp` in the start script so install stays on a single mount.

## Testing checklist

- [x] Text message: user → Claude
- [x] Text message: Claude → user (via transcript watcher)
- [x] Image: clipboard paste (Cmd+V)
- [x] Image: drag-and-drop
- [x] Image: Attach button (file picker)
- [x] Auto-scroll on new message (fixed)
- [ ] Lightbox zoom on click
- [ ] Image: Claude → user (via `send_image` tool)
- [ ] Multi-image upload
- [ ] Multi-tab synchronization (open dialogue in two tabs, verify both update)
- [ ] Multi-block turns (text + tool + text): both text segments mirror to UI
