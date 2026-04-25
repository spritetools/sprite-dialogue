# sprite-dialogue — project context

A two-way visual chat channel for Claude Code, designed for iterating on web UIs from a [Sprite](https://sprites.dev). The user runs Claude Code in a Sprite terminal and views/uses a parallel web UI in their laptop browser. Screenshots and text flow both directions; Claude's text responses are mirrored to the UI; the user can paste/drop screenshots into the UI and Claude reads them as channel notifications.

GitHub: <https://github.com/rphilander/sprite-dialogue>

## Repo layout

```
sprite-dialogue/                   # marketplace + plugin co-located
  .claude-plugin/marketplace.json  # marketplace definition (this repo, source: ./plugin)
  .gh-token                        # fine-grained GitHub PAT (gitignored)
  .gitignore
  LICENSE / README.md / TODO.md
  CLAUDE.md                        # this file
  plugin/                          # the actual plugin
    .claude-plugin/plugin.json
    .mcp.json                      # spawns "bun run start" via ${CLAUDE_PLUGIN_ROOT}
    .npmrc / bun.lock / package.json
    server.ts                      # MCP channel + Bun HTTP + WebSocket + embedded UI
    hooks/                         # WILL BE REMOVED in the upcoming refactor
      hooks.json
      capture-assistant.sh
      capture-user-prompt.sh
```

The repo serves two roles: a single-plugin marketplace (root) and the plugin itself (subdirectory). Earlier we tried co-locating them at the root with a self-referential URL source, which produced a recursive nested install. The current layout matches the official `claude-plugins-official` pattern (`marketplace.json` source = relative path to subdirectory).

## How it runs

- Installed plugin (the "real" path):
  ```
  /plugin marketplace add rphilander/sprite-dialogue
  /plugin install sprite-dialogue@sprite-dialogue
  /reload-plugins
  ```
  Then relaunch with `claude --dangerously-load-development-channels plugin:sprite-dialogue@sprite-dialogue`.

- Local dev (dev-loaded from the source tree):
  `claude --dangerously-load-development-channels plugin:sprite-dialogue@inline --plugin-dir /home/sprite/sprite-dialogue/plugin`

- The bun server picks a port deterministically from `hostname()` (range 30000–39999) so multiple Sprites' ports don't collide on `localhost` when forwarded by `sprite console`. The URL is written to `/tmp/sprite-dialogue-url`.

- Runtime state: `~/.claude/channels/sprite-dialogue/{inbox,outbox}/`.
- Runtime log: `/tmp/sprite-dialogue.log`.

## Architecture (current)

- **Inbound** (UI → Claude): browser WebSocket → `deliver()` → `mcp.notification('notifications/claude/channel')` → arrives in Claude as `<channel source="sprite-dialogue" ...>`.
- **Outbound text** (Claude → UI): `Stop` hook reads the JSONL transcript with jq, posts the last assistant turn's text to `/echo`, broadcast to UI WebSocket.
- **Outbound images** (Claude → UI): `send_image` MCP tool with absolute file path.
- **Terminal user input** (terminal → UI): `UserPromptSubmit` hook posts the prompt to `/echo`.

The Stop hook is racy — it fires before Claude Code flushes the final assistant text block to disk, so jq finds nothing. The fix is the upcoming refactor (see `docs/transcript-watcher-plan.md`).

## Notable behaviors and quirks in `server.ts`

- `killOrphans()` at startup: scans `/proc` for stale `bun server.ts` processes with the same cwd and SIGTERMs them. Self-heals when a previous Claude session left a child running.
- `watchParent()`: polls `process.kill(ppid, 0)` every 5s; exits cleanly when the Claude parent is gone. Bounds the orphan window after a non-graceful exit.
- `SIGTERM`/`SIGINT` handlers exit cleanly so the killed orphan releases its port promptly.
- `start` script in `package.json` is `bun install --no-summary && bun server.ts` — runs install on first launch, then starts the server. (Don't add `exec` — bun's built-in shell doesn't support it.)
- WebSocket client has an outbound queue so messages aren't dropped during reconnect.
- `marketplace.json` source uses a relative-path string (`./plugin`), NOT `{source:"github"|"url", ...}`. The github form clones via SSH and fails on Sprites without keys; the URL form pointing at this repo's own .git triggered a recursive nested install.

## Conventions

- Commits use this trailer (per CLI claude defaults):
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Author identity: `Rodrigo Philander <rodrigo.philander@gmail.com>`.
- Push pattern (token from gitignored `.gh-token`):
  ```
  git push "https://x-access-token:$(cat .gh-token)@github.com/rphilander/sprite-dialogue.git" main:main
  ```
- Sprite checkpoints via `sprite-env checkpoints create --comment "..."` after milestones.
- README tells users to install via the plugin commands; only mention `--plugin-dir` for local dev.
- Don't commit `node_modules`, `*.log`, `.DS_Store`, `.gh-token` (already in .gitignore).

## Tested and working today

- Plugin installs cleanly via `/plugin marketplace add` + `/plugin install` + `/reload-plugins`.
- Channel inbound (UI → Claude) works.
- Image attachments via `send_image` tool render inline.
- Markdown rendering for assistant messages (marked + DOMPurify).
- Auto-scroll, clipboard paste, drag-drop, file picker, lightbox.
- Hostname-hashed port selection.
- Outbound WebSocket queue.
- Self-heal: orphan kill, parent watch, signal handling.

## Known broken / about to fix

- Stop hook fires before Claude's final assistant text is flushed to the JSONL → text often missing from UI echoes (the "Paris." case, "no text in last turn (tool-only)" log lines).
- The fix is in `docs/transcript-watcher-plan.md`.
