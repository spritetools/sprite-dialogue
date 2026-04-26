# sprite-dialogue TODO

Small enhancements and known issues to address.

## Enhancements

- [x] Pass original filename through channel meta as `file_name`
- [ ] Auto-restart the bun server on file changes during development (consider `bun --hot server.ts` or watch flag)
- [ ] Add a connection status indicator that's more visible (the 8px dot is subtle)
- [x] Plugin path (`--plugin-dir`) confirmed working for channels — the fix was using the right dev-flag tag: `plugin:sprite-dialogue@inline` (not `server:sprite-dialogue`). The "inline" marketplace name is what `--plugin-dir` synthesizes.
- [ ] Clear the input box: Escape key when focused, plus a clear button next to/inside the textarea
- [x] Activity indicator on the chat UI — implemented as a singleton "pseudo-message" bubble in the message stream (rather than the originally-imagined small header indicator). Bubble appears on busy, updates in place with tool-call count + name/arg snippet of the latest tool call, vanishes on idle. Detection uses stop_reason on the most recent assistant entry plus "newer non-tool-result user entry than last end_turn" (covers the window where claude is generating but hasn't flushed the JSONL yet). Pure transition logic in transcript.ts (nextActivity); 12 unit tests.
- [x] Opt-in completion chime — bell icon embedded in the activity bubble; click to arm. On the busy → idle transition, plays a synthesized 880Hz chirp via Web Audio (no asset shipping) and auto-disarms. Activation gesture (click) satisfies browser autoplay policy.
- [ ] Header in upper-left showing `<sprite-name>:<claude-session-name>`, mirrored into the page `<title>` so it's visible in the browser tab too
- [ ] Copy button on rendered code blocks — small icon in the corner of each `<pre>`/`<code>` block in markdown-rendered messages, clicks to copy the block contents to the clipboard
- [ ] Self-documenting UI — `?`/Help button that surfaces keyboard shortcuts, paste/drop behavior, and available channel features
- [x] README quick-start — Quickstart section now lives directly under the tagline with install + relaunch + URL discovery in three short blocks; longer architecture/layout detail pushed below.
- [ ] Review shipped docs — audit what's in the repo (README + any plugin-bundled markdown) for accuracy, currency, and end-user-vs-developer-internal fitness
- [ ] LLM-served file links — new MCP tool that emits a clickable link in the chat (e.g. `<a target="_blank">…</a>`); a server endpoint streams the local file (with a path-safety allowlist) so the user can click to open it in a new tab. Useful for things like "let me show you the CLAUDE.md" or surfacing logs/screenshots that aren't images.
- [ ] Syntax highlighting for source files served at `/project/root/*` — e.g. `.ts`, `.js`, `.json`, `.html`, `.css`. Same pipeline shape as the markdown renderer (detect extension, transform server-side, serve `text/html` with a `?raw=1` escape hatch). Pick highlight.js or shiki; settle on a light theme to match the markdown renderer's CSS.
- [x] Make WebSocket connection more robust against half-open / silently-dead sockets — today the client has auto-reconnect with exponential backoff (500ms → 8s) and an outbound queue, but no liveness probing. Symptom: status indicator stays green and messages stop flowing until the user refreshes the tab. Fix needs three pieces: (1) **server-side pings** every ~25s via Bun's `sendPing()` so dead clients are detected and dropped; (2) **client-side liveness detector** — send an app-layer `{type:'ping'}` every ~25s, expect a `{type:'pong'}` reply within ~5s, force-close + reconnect if missed; (3) **visibility-change handler** — on `document.visibilitychange` becoming 'visible', if `ws.readyState !== OPEN`, schedule an immediate reconnect (skip the backoff).
- [ ] Restyle the chat UI for brand identity — today the palette is stock Tailwind dark (`#111827` bg, `#1f2937` cards, `#1d4ed8` user bubble, blue-300 links) with no connection to the spritetools.github.io landing page. Pull in the brand orange (`#e2733e`) as the accent (header strip, focus ring, link color, status indicator), tone down the user bubble (saturated blue-700 on gray-900 is loud — try a muted/warm variant), and consider asymmetric bubble corners (user squares bottom-right, assistant squares bottom-left) for sender differentiation. Pair with the `<sprite>:<session>` header item so the chrome is reworked once. Smaller follow-ons: empty-state placeholder with paste/drop hints, and slightly more breathing room in the compose/header chrome.
- [x] Backfill chat history on WebSocket reconnect — today the UI loses everything on page refresh / `/mcp` reconnect / new tab. On every `ws.open`, before subscribing the client to live broadcasts, replay the last ~50 messages from the most recently modified `~/.claude/projects/*/*.jsonl` through the existing `processEntry` filter and send them to *that client only* (not broadcast — others already have them). Design choices captured: source = JSONL (survives both browser and bun restarts and is already the live path's source of truth); window = last 50 messages; multi-session = most-recently-modified file only (don't merge); images = text-only replay with a small `[image]` placeholder for v1; race handling = snapshot-then-live with no buffering (rely on the existing client-side `msgMap` id-based dedupe). Optional `snapshot-start`/`snapshot-end` markers so the UI can render the batch without auto-scroll thrashing.

## Known Issues

- [ ] Localhost port forwarding can go stale — `http://localhost:<port>/` from the laptop returns connection-refused even though the bun server inside the sprite is healthy and listening on `0.0.0.0:<port>`. Reproduced 2026-04-25 on sprite `copy-paste` after a long active session: the WebSocket log shows the laptop client connecting and disconnecting cleanly throughout the day (multiple `[ws] open` / `[ws] close` cycles), then silently stopping. The fix that worked was closing `sprite console`, waiting for the sprite to transition `running → warm`, then reconnecting. Unclear whether this is `sprite proxy`-side, `sprite console`-side, or laptop network state (NAT/socket cache). Worth investigating before announcement so we can either fix it or document a workaround in the README — first-time users will hit this and conclude the plugin is broken.
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
