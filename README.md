# sprite-dialogue

A two-way visual chat channel for Claude Code, built for iterating on web UIs from a [Sprite](https://sprites.dev) (or any remote Linux dev environment).

You sit in your laptop browser. Claude Code runs in the Sprite terminal. The dialogue server bridges them: you paste screenshots in, Claude annotates and replies with screenshots out. No clipboard hacks, no SSH tunnels — just an HTTP/WebSocket page accessible at the Sprite's auto-forwarded port.

## What it does

- **From you** → screenshots and text into Claude's session via clipboard paste, drag-and-drop, or file picker
- **From Claude** → text replies and image attachments rendered inline in the chat UI
- **Image lightbox** for full-size viewing
- **Auto-scroll** that respects manual scroll-back
- **Outbound queue** so messages don't drop during WebSocket reconnects

Built on top of [Claude Code's channels API](https://code.claude.com/docs/en/channels-reference).

## Quickstart on a Sprite

```bash
git clone https://github.com/<owner>/sprite-dialogue.git /home/sprite/sprite-dialogue
cd /home/sprite/sprite-dialogue && bun install
```

Then restart Claude Code with channel flags:

```
claude --dangerously-load-development-channels server:sprite-dialogue \
       --mcp-config /home/sprite/sprite-dialogue/mcp-direct.json
```

The server picks a port deterministically from the Sprite's hostname (range 30000–39999), so multiple Sprites running sprite-dialogue won't collide on `localhost` when forwarded to your laptop. After Claude Code starts, find the URL:

```bash
cat /tmp/sprite-dialogue-url
```

Open that URL in your laptop browser. (Sprites auto-forward bound ports; no `sprite proxy` needed when running `sprite console`.)

To override the port explicitly, set `SPRITE_DIALOGUE_PORT` before launching Claude.

## Architecture

Single `server.ts` containing:
- An MCP channel server (stdio transport, `claude/channel` capability)
- A Bun HTTP server (port 4242 by default, `SPRITE_DIALOGUE_PORT` to override)
- A WebSocket endpoint for live UI updates
- Embedded HTML/CSS/JS for the chat UI

Runtime state at `~/.claude/channels/sprite-dialogue/{inbox,outbox}/`.

## Status

Working but rough around the edges — see [TODO.md](./TODO.md) for known issues and planned enhancements. Channel notifications currently require loading via `--mcp-config` rather than `--plugin-dir`; the proper plugin-install path needs more investigation.

## License

MIT
