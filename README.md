# sprite-dialogue

A two-way visual chat channel for Claude Code, built for iterating on web UIs from a [Sprite](https://sprites.dev) (or any remote Linux dev environment).

You sit in your laptop browser. Claude Code runs in the Sprite terminal. The dialogue server bridges them: you paste screenshots in, Claude annotates and replies with screenshots out. No clipboard hacks, no SSH tunnels — just an HTTP/WebSocket page accessible at the Sprite's auto-forwarded port.

## What it does

- **From you** → screenshots and text into Claude's session via clipboard paste, drag-and-drop, or file picker
- **From Claude** → conversational text is automatically mirrored to the UI by plugin hooks (no tool calls needed); images go via a `send_image` tool
- **Image lightbox** for full-size viewing
- **Auto-scroll** that respects manual scroll-back
- **Outbound queue** so messages don't drop during WebSocket reconnects

Built on top of [Claude Code's channels API](https://code.claude.com/docs/en/channels-reference) and [hooks](https://code.claude.com/docs/en/hooks).

## Architecture

- **Inbound (you → Claude)**: UI WebSocket → channel notification → Claude session
- **Outbound text (Claude → you)**: `Stop` hook reads the JSONL transcript, POSTs the last assistant turn to the server's `/echo` endpoint, broadcast to UI WebSocket
- **Outbound images (Claude → you)**: `send_image` tool with absolute file path
- **Terminal user input**: `UserPromptSubmit` hook captures the prompt, POSTs to `/echo` so the UI shows what was typed in the terminal too

## Quickstart on a Sprite

Inside Claude Code on the Sprite:

```
/plugin marketplace add rphilander/sprite-dialogue
/plugin install sprite-dialogue@sprite-dialogue
```

Then exit and relaunch Claude with the channel flag:

```
claude --dangerously-load-development-channels plugin:sprite-dialogue@sprite-dialogue
```

## Repository layout

This repo is both the marketplace and the plugin. The plugin lives in the
[`plugin/`](./plugin) subdirectory; `.claude-plugin/marketplace.json` at the
root declares it. To run from a local clone (e.g. for development), point
`--plugin-dir` at the `plugin/` subdirectory, not the repo root.

The server picks a port deterministically from the Sprite's hostname (range 30000–39999), so multiple Sprites running sprite-dialogue won't collide on `localhost` when forwarded to your laptop. After Claude Code starts, find the URL:

```bash
cat /tmp/sprite-dialogue-url
```

Open that URL in your laptop browser. (Sprites auto-forward bound ports; no `sprite proxy` needed when running `sprite console`.)

To override the port explicitly, set `SPRITE_DIALOGUE_PORT` before launching Claude.

Runtime state lives at `~/.claude/channels/sprite-dialogue/{inbox,outbox}/`. The bun server is a single `server.ts` file with embedded HTML; it has self-heal logic that kills any stale predecessor and exits when its parent (Claude Code) goes away.

## Status

Working but rough around the edges — see [TODO.md](./TODO.md) for known issues and planned enhancements.

## License

MIT
