# sprite-dialogue TODO

Small enhancements and known issues to address.

## Enhancements

- [x] Pass original filename through channel meta as `file_name`
- [ ] Auto-restart the bun server on file changes during development (consider `bun --hot server.ts` or watch flag)
- [ ] Add a connection status indicator that's more visible (the 8px dot is subtle)
- [x] Plugin path (`--plugin-dir`) confirmed working for channels — the fix was using the right dev-flag tag: `plugin:sprite-dialogue@inline` (not `server:sprite-dialogue`). The "inline" marketplace name is what `--plugin-dir` synthesizes.

## Known Issues

- [ ] Orphan bun processes survive when claude exits abruptly, blocking port reuse on restart (need a cleanup hook or a way for claude to kill its MCP children on exit)
- [x] Occasional message drops: fixed by adding a client-side outbound queue that buffers messages when the WebSocket is reconnecting. Server-side logging at `/tmp/sprite-dialogue.log` left in place to catch any recurrence.

## Testing checklist

- [x] Text message: user → Claude
- [x] Text message: Claude → user (via reply tool)
- [x] Image: clipboard paste (Cmd+V)
- [x] Image: drag-and-drop
- [x] Image: Attach button (file picker)
- [x] Auto-scroll on new message (fixed)
- [ ] Lightbox zoom on click
- [ ] Image: Claude → user (via reply tool with files arg)
- [ ] Multi-image upload
- [ ] Multi-tab synchronization (open dialogue in two tabs, verify both update)
