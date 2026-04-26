#!/usr/bin/env bun
/**
 * sprite-dialogue — Visual dev iteration channel for Claude Code on Sprites.
 *
 * A two-way chat UI with inline screenshot support. Paste or drag-drop images
 * from your browser, and Claude can reply with annotated screenshots.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, appendFileSync, readdirSync, readlinkSync, existsSync, openSync, readSync, closeSync } from 'fs'
import { homedir, hostname } from 'os'
import { join, extname, basename, resolve } from 'path'
import { execSync } from 'child_process'
import type { ServerWebSocket } from 'bun'
import { marked } from 'marked'
import { type ChatMsg, entryToMessage, parseEntries, type Activity, IDLE_ACTIVITY, nextActivity } from './transcript'

// ---------------------------------------------------------------------------
// Logging — append to a file so we can debug message drops
// ---------------------------------------------------------------------------

const LOG_FILE = '/tmp/sprite-dialogue.log'
function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
  try { process.stderr.write(line) } catch {}
}

// ---------------------------------------------------------------------------
// Orphan cleanup, parent-death detection, and shutdown
// ---------------------------------------------------------------------------

// Find the PID listening on `port` by parsing /proc/net/tcp{,6} for the
// socket inode, then matching it against /proc/*/fd/*.
function findPortHolderPid(port: number): number | null {
  const inodes = new Set<string>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let content: string
    try { content = readFileSync(file, 'utf-8') } catch { continue }
    for (const line of content.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 10) continue
      if (parts[3] !== '0A') continue  // 0A = LISTEN
      const portHex = parts[1].split(':')[1]
      if (parseInt(portHex, 16) === port) inodes.add(parts[9])
    }
  }
  if (inodes.size === 0) return null
  for (const entry of readdirSync('/proc')) {
    const pid = parseInt(entry, 10)
    if (!pid) continue
    let fds: string[]
    try { fds = readdirSync(`/proc/${pid}/fd`) } catch { continue }
    for (const fd of fds) {
      try {
        const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)
        if (m && inodes.has(m[1])) return pid
      } catch { /* ignore */ }
    }
  }
  return null
}

// If our port is held by a stale bun server.ts (from a prior session, possibly
// in a different cwd after a layout change), SIGTERM it so we can bind. Holders
// that aren't bun server.ts are left alone — we'll surface EADDRINUSE instead.
function killOrphans(): void {
  const holder = findPortHolderPid(PORT)
  if (!holder || holder === process.pid) return
  let cmdline: string
  try {
    cmdline = readFileSync(`/proc/${holder}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim()
  } catch {
    log(`port ${PORT} held by pid=${holder}, cmdline unreadable; not killing`)
    return
  }
  if (!/(^|\/)bun\b.*\bserver\.ts\b/.test(cmdline)) {
    log(`port ${PORT} held by pid=${holder} (${cmdline}); not a bun server.ts, not killing`)
    return
  }
  try {
    process.kill(holder, 'SIGTERM')
    log(`killed orphan bun server.ts pid=${holder} holding port ${PORT}`)
    Bun.sleepSync(500)
  } catch (err) {
    log(`failed to SIGTERM pid=${holder}: ${err}`)
  }
}

// Watch the parent (Claude Code). If it dies, we exit so we don't become an
// orphan ourselves.
function watchParent(): void {
  const ppid = process.ppid
  if (!ppid || ppid === 1) return
  setInterval(() => {
    try {
      process.kill(ppid, 0)  // signal 0 = existence check
    } catch {
      log(`parent process ${ppid} gone, exiting`)
      process.exit(0)
    }
  }, 5000)
}

process.on('SIGTERM', () => { log('SIGTERM received, exiting'); process.exit(0) })
process.on('SIGINT', () => { log('SIGINT received, exiting'); process.exit(0) })

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Port is derived from hostname (the sprite name) so each sprite gets a
// distinct port, avoiding collisions on the user's laptop where multiple
// sprites' ports are forwarded simultaneously. Range 30000-39999 sits
// outside common dev port ranges.
function hashHostnameToPort(host: string, min = 30000, max = 39999): number {
  let h = 5381  // djb2
  for (let i = 0; i < host.length; i++) {
    h = ((h << 5) + h + host.charCodeAt(i)) | 0
  }
  return min + (Math.abs(h) % (max - min + 1))
}

const PORT = Number(process.env.SPRITE_DIALOGUE_PORT ?? hashHostnameToPort(hostname()))
const STATE_DIR = join(homedir(), '.claude', 'channels', 'sprite-dialogue')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const OUTBOX_DIR = join(STATE_DIR, 'outbox')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase())
}

// ---------------------------------------------------------------------------
// Wire protocol (server <-> browser via WebSocket)
// ---------------------------------------------------------------------------

type Msg = {
  id: string
  from: 'user' | 'assistant'
  text: string
  ts: number
  replyTo?: string
  file?: { url: string; name: string; isImage: boolean }
}

type Wire =
  | ({ type: 'msg' } & Msg)
  | { type: 'edit'; id: string; text: string }

const clients = new Set<ServerWebSocket<unknown>>()
let seq = 0

function nextId() {
  return `m${Date.now()}-${++seq}`
}

function broadcast(m: Wire) {
  const data = JSON.stringify(m)
  for (const ws of clients) if (ws.readyState === 1) ws.send(data)
}

function mime(ext: string) {
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  }
  return m[ext] ?? 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// MCP channel server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'sprite-dialogue', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'The user may be viewing this conversation in two places at once: the terminal where Claude Code is running, and the sprite-dialogue web UI in their browser. They might be looking at either one at any moment.',
      '',
      'The plugin automatically mirrors your conversational text to the UI as you produce it — you do not need to call any tool to send text. Just respond normally.',
      '',
      'Messages from the web UI arrive as <channel source="sprite-dialogue" chat_id="web" message_id="..." [file_name="..." file_path="..."]>. If the tag has a file_path attribute, Read that file — it is a screenshot or image upload from the user.',
      '',
      'To send an IMAGE to the user, use the send_image tool with an absolute file path. Use this only for images; text is mirrored automatically.',
      '',
      `The UI is at the URL written to /tmp/sprite-dialogue-url (port derived from this Sprite's hostname).`,
    ].join('\n'),
  },
)

// -- Tools ------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_image',
      description:
        'Send an image to the sprite-dialogue UI. Pass the absolute path of an image file ' +
        '(png/jpg/gif/webp/svg, 50 MB max). Optional caption text. Use this ONLY for images; ' +
        'text is mirrored to the UI automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the image file' },
          caption: { type: 'string', description: 'Optional caption text shown with the image' },
        },
        required: ['path'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'send_image': {
        const path = args.path as string
        const caption = (args.caption as string | undefined) ?? ''

        const st = statSync(path)
        if (st.size > 50 * 1024 * 1024) throw new Error(`file too large: ${path}`)

        mkdirSync(OUTBOX_DIR, { recursive: true })
        const ext = extname(path).toLowerCase()
        const out = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
        copyFileSync(path, join(OUTBOX_DIR, out))
        const file = { url: `/files/${out}`, name: basename(path), isImage: isImageExt(ext) }

        const id = nextId()
        broadcast({ type: 'msg', id, from: 'assistant', text: caption, ts: Date.now(), file })
        return { content: [{ type: 'text', text: `sent image (${id})` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// Deliver user message to Claude via channel notification
// ---------------------------------------------------------------------------

function deliver(id: string, text: string, file?: { path: string; name: string }): void {
  log(`[deliver] id=${id} text=${JSON.stringify(text).slice(0, 80)} file=${file?.path ?? 'none'}`)
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text || `(${file?.name ?? 'attachment'})`,
      meta: {
        chat_id: 'web',
        message_id: id,
        user: 'web',
        ts: new Date().toISOString(),
        ...(file ? { file_path: file.path, file_name: file.name } : {}),
      },
    },
  }).then(() => {
    log(`[deliver] notification sent for ${id}`)
  }).catch((err) => {
    log(`[deliver] FAILED for ${id}: ${err}`)
  })
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

// Self-heal: kill any prior server.ts holding our port, then watch our parent.
killOrphans()
watchParent()

// Project-root preview: serve files under the user's home directory by default.
// A Sprite is itself the sandbox — anything sensitive belongs in a different
// Sprite — so $HOME is the natural scope. Override with SPRITE_DIALOGUE_PROJECT_ROOT
// if you want a tighter root. Hidden files and path traversal blocked either way.
// Markdown links like `[label](/project/root/some-repo/docs/index.html)` resolve here.
const PROJECT_ROOT = resolve(process.env.SPRITE_DIALOGUE_PROJECT_ROOT ?? homedir())

function hasHiddenSegment(rel: string): boolean {
  return rel.split('/').some(seg => seg.startsWith('.'))
}

function renderMarkdown(absPath: string, urlPath: string): string {
  const md = readFileSync(absPath, 'utf-8')
  const html = marked.parse(md, { breaks: true, gfm: true, async: false }) as string
  return `<!doctype html><meta charset="utf-8"><title>${urlPath}</title>
<style>
  body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#222;max-width:760px;margin:2em auto;padding:0 1.5em}
  h1,h2,h3,h4{line-height:1.25;margin-top:1.5em}
  h1{font-size:2em;border-bottom:1px solid #eee;padding-bottom:.3em}
  h2{font-size:1.5em;border-bottom:1px solid #eee;padding-bottom:.3em}
  a{color:#06c} a:hover{text-decoration:underline}
  code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f5f5;padding:.1em .3em;border-radius:3px}
  pre{background:#f5f5f5;padding:1em;border-radius:6px;overflow-x:auto}
  pre code{background:none;padding:0}
  blockquote{border-left:4px solid #ddd;padding:0 1em;color:#555;margin:1em 0}
  table{border-collapse:collapse;margin:1em 0}
  th,td{border:1px solid #ddd;padding:.4em .8em} th{background:#f5f5f5}
  img{max-width:100%}
  hr{border:0;border-top:1px solid #eee;margin:2em 0}
  .raw-link{position:fixed;top:.5em;right:.8em;font-size:.8em;color:#888;text-decoration:none}
</style>
<a class="raw-link" href="?raw=1">view raw</a>
<article>${html}</article>`
}

function renderListing(absDir: string, urlPath: string): string {
  const at = urlPath.endsWith('/') ? urlPath : urlPath + '/'
  const entries = readdirSync(absDir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1, bd = b.isDirectory() ? 0 : 1
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name)
    })
  const isRoot = at === '/project/root/'
  const upRow = isRoot ? '' : `<li><a href="${at.replace(/[^/]+\/$/, '')}">../</a></li>`
  const rows = entries.map(e => {
    const slash = e.isDirectory() ? '/' : ''
    return `<li><a href="${at}${encodeURIComponent(e.name)}${slash}">${e.name}${slash}</a></li>`
  }).join('')
  return `<!doctype html><meta charset="utf-8"><title>${urlPath}</title>
<style>body{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:1.5em;max-width:780px;margin:auto;color:#222}h1{font-size:1em;font-weight:600;color:#666;margin:0 0 1em}ul{list-style:none;padding:0;margin:0}li{padding:1px 0}a{text-decoration:none;color:#06c}a:hover{text-decoration:underline}</style>
<h1>${urlPath}</h1><ul>${upRow}${rows}</ul>`
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  idleTimeout: 0,
  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (server.upgrade(req)) return
      return new Response('upgrade failed', { status: 400 })
    }

    // Project root preview — serve repo files for in-browser inspection
    if (url.pathname === '/project/root' || url.pathname.startsWith('/project/root/')) {
      const rel = decodeURIComponent(url.pathname.slice('/project/root'.length).replace(/^\//, ''))
      if (hasHiddenSegment(rel)) return new Response('forbidden', { status: 403 })
      const abs = resolve(PROJECT_ROOT, rel)
      if (abs !== PROJECT_ROOT && !abs.startsWith(PROJECT_ROOT + '/')) {
        return new Response('forbidden', { status: 403 })
      }
      let st
      try { st = statSync(abs) } catch { return new Response('404', { status: 404 }) }
      if (st.isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          return new Response(null, { status: 301, headers: { location: url.pathname + '/' } })
        }
        const indexPath = join(abs, 'index.html')
        if (existsSync(indexPath)) {
          return new Response(Bun.file(indexPath))
        }
        return new Response(renderListing(abs, url.pathname), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (st.isFile()) {
        if (extname(abs).toLowerCase() === '.md' && url.searchParams.get('raw') !== '1') {
          return new Response(renderMarkdown(abs, url.pathname), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }
        return new Response(Bun.file(abs))
      }
      return new Response('404', { status: 404 })
    }

    // Serve outbox files (Claude -> user images)
    if (url.pathname.startsWith('/files/')) {
      const f = url.pathname.slice(7)
      if (f.includes('..') || f.includes('/')) return new Response('bad', { status: 400 })
      try {
        return new Response(readFileSync(join(OUTBOX_DIR, f)), {
          headers: { 'content-type': mime(extname(f).toLowerCase()) },
        })
      } catch {
        return new Response('404', { status: 404 })
      }
    }

    // Serve inbox files (user -> user, for inline display of own uploads)
    if (url.pathname.startsWith('/inbox-files/')) {
      const f = url.pathname.slice(13)
      if (f.includes('..') || f.includes('/')) return new Response('bad', { status: 400 })
      try {
        return new Response(readFileSync(join(INBOX_DIR, f)), {
          headers: { 'content-type': mime(extname(f).toLowerCase()) },
        })
      } catch {
        return new Response('404', { status: 404 })
      }
    }

    // File upload from browser (paste / drag-drop / attach)
    if (url.pathname === '/upload' && req.method === 'POST') {
      return (async () => {
        const form = await req.formData()
        const id = String(form.get('id') ?? '')
        const text = String(form.get('text') ?? '')
        const f = form.get('file')
        if (!id) return new Response('missing id', { status: 400 })

        let file: { path: string; name: string } | undefined
        let inboxUrl: string | undefined

        if (f instanceof File && f.size > 0) {
          mkdirSync(INBOX_DIR, { recursive: true })
          const ext = extname(f.name).toLowerCase() || '.png'
          const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          const path = join(INBOX_DIR, filename)
          writeFileSync(path, Buffer.from(await f.arrayBuffer()))
          file = { path, name: f.name }
          inboxUrl = `/inbox-files/${filename}`
        }

        deliver(id, text, file)

        if (inboxUrl) {
          return new Response(JSON.stringify({ url: inboxUrl }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(null, { status: 204 })
      })()
    }

    // Main page
    if (url.pathname === '/') {
      return new Response(HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('404', { status: 404 })
  },
  websocket: {
    open: (ws) => {
      clients.add(ws)
      log(`[ws] open (clients=${clients.size})`)
      // Replay recent transcript history to this client only. Bracket with
      // snapshot markers so the UI can suppress per-message auto-scroll
      // during the bulk-append, and rely on client-side msgMap dedupe (keyed
      // by uuid) to collapse any overlap with a live broadcast that might
      // fire mid-replay.
      try {
        const snap = buildBackfill()
        ws.send(JSON.stringify({ type: 'snapshot-start', count: snap.length }))
        for (const m of snap) ws.send(JSON.stringify({ type: 'msg', ...m }))
        ws.send(JSON.stringify({ type: 'snapshot-end' }))
        // Tell the new client about any in-progress burst so the activity
        // indicator can render immediately rather than waiting for the next
        // JSONL event to come through.
        ws.send(JSON.stringify(activityMessage()))
        log(`[ws] backfilled ${snap.length} messages, activity=${activity.state}`)
      } catch (err) {
        log(`[ws] backfill error: ${err}`)
      }
    },
    close: (ws) => {
      clients.delete(ws)
      log(`[ws] close (clients=${clients.size})`)
    },
    message: (ws, raw) => {
      const rawStr = String(raw)
      try {
        const parsed = JSON.parse(rawStr)
        // App-layer heartbeat: client probes liveness by sending {type:'ping'},
        // expects {type:'pong'} back within a short window.
        if (parsed?.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong' })) } catch {}
          return
        }
        log(`[ws] message received: ${rawStr.slice(0, 120)}`)
        const { id, text } = parsed as { id: string; text: string }
        if (id && text?.trim()) {
          deliver(id, text.trim())
        } else {
          log(`[ws] message dropped: id=${id} text=${JSON.stringify(text)}`)
        }
      } catch (err) {
        log(`[ws] JSON parse error: ${err}`)
      }
    },
  },
})

const URL_FILE = '/tmp/sprite-dialogue-url'
const url = `http://localhost:${PORT}`
try { writeFileSync(URL_FILE, url + '\n') } catch {}
log(`sprite-dialogue: ${url} (logs at ${LOG_FILE}, url at ${URL_FILE})`)

// ---------------------------------------------------------------------------
// Transcript watcher — mirrors assistant text and terminal user prompts to
// the UI by tailing ~/.claude/projects/*/*.jsonl. Replaces the previous
// Stop / UserPromptSubmit hook scripts (which raced the JSONL flush).
// ---------------------------------------------------------------------------

// Resolve our project's transcripts dir from claude's cwd. claude indexes
// ~/.claude/projects/<encoded-cwd>/, where encoded = cwd with '/' → '-'.
//
// Walking process.ppid alone is wrong: the npm-script start chain inserts a
// `bun run start` parent between bun and claude, and that intermediate's cwd
// is the plugin dir (CLAUDE_PLUGIN_ROOT), not claude's cwd. So we walk the
// process tree up to ~8 levels looking for the first ancestor whose argv[0]
// basename is `claude`, then read /proc/<that-pid>/cwd.
function resolveClaudeCwd(): string {
  let pid = process.ppid
  for (let i = 0; i < 8 && pid > 1; i++) {
    try {
      const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? ''
      if ((argv0.split('/').pop() ?? '') === 'claude') {
        return readlinkSync(`/proc/${pid}/cwd`)
      }
      const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)/m)
      pid = m ? parseInt(m[1], 10) : 0
    } catch { break }
  }
  return process.cwd()
}

function resolveProjectDir(): string {
  return join(homedir(), '.claude', 'projects', resolveClaudeCwd().replace(/\//g, '-'))
}

const PROJECT_DIR = resolveProjectDir()
const transcriptOffsets = new Map<string, number>()
const transcriptBuffers = new Map<string, string>()
const seenTranscripts = new Set<string>()
let transcriptsInitialized = false

function listTranscripts(): string[] {
  if (!existsSync(PROJECT_DIR)) return []
  try {
    return readdirSync(PROJECT_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(PROJECT_DIR, f))
  } catch { return [] }
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

// Activity state for the busy/idle indicator. Reassigned through nextActivity()
// — referential identity is the change signal, so equality checks dedupe trivially.
let activity: Activity = IDLE_ACTIVITY

function activityMessage(): Record<string, unknown> {
  return activity.state === 'idle'
    ? { type: 'activity', state: 'idle' }
    : {
        type: 'activity',
        state: 'busy',
        toolCallCount: activity.toolCallCount,
        latestTool: activity.latestTool,
      }
}

function processEntry(entry: any): void {
  // Activity must be updated for *every* entry (including tool turns and user
  // text), even when the entry doesn't produce a visible chat message.
  const next = nextActivity(activity, entry)
  if (next !== activity) {
    activity = next
    broadcast(activityMessage())
  }
  const msg = entryToMessage(entry)
  if (!msg) return
  broadcast({ type: 'msg', ...msg })
  log(`[transcript] echoed ${msg.from}: ${msg.text.slice(0, 80).replace(/\n/g, ' ')}`)
}

// Read all project JSONLs (union across sessions), sort by entry timestamp,
// return the most recent `limit` messages. Sent to a newly-connected client
// so a refresh / reconnect doesn't lose history. Cross-session is intentional:
// shows continuous project activity rather than a single session's view.
function buildBackfill(limit = 50): ChatMsg[] {
  const messages: ChatMsg[] = []
  for (const path of listTranscripts()) {
    try { messages.push(...parseEntries(readFileSync(path, 'utf8'))) }
    catch { /* skip unreadable */ }
  }
  messages.sort((a, b) => a.ts - b.ts)
  return messages.slice(-limit)
}

function pollTranscripts(): void {
  for (const path of listTranscripts()) {
    if (!seenTranscripts.has(path)) {
      seenTranscripts.add(path)
      if (transcriptsInitialized) {
        // New session appearing while we're running — read from start.
        transcriptOffsets.set(path, 0)
        log(`[transcript] new file: ${path}`)
      } else {
        // Initial snapshot path: skip pre-existing history.
        try { transcriptOffsets.set(path, statSync(path).size) } catch {}
      }
    }
    const chunk = readNewBytes(path)
    if (chunk == null) continue
    // Buffer the trailing partial line (no \n yet) so we don't try to parse
    // a half-flushed JSON record. The offset already advanced, so the next
    // poll's chunk picks up where this one stopped — concat with the buffer.
    const buffered = (transcriptBuffers.get(path) ?? '') + chunk
    const parts = buffered.split('\n')
    const trailing = parts.pop() ?? ''
    transcriptBuffers.set(path, trailing)
    for (const line of parts) {
      if (!line.trim()) continue
      try { processEntry(JSON.parse(line)) } catch { /* skip malformed */ }
    }
  }
}

function startTranscriptWatcher(): void {
  for (const path of listTranscripts()) {
    seenTranscripts.add(path)
    try { transcriptOffsets.set(path, statSync(path).size) } catch {}
  }
  transcriptsInitialized = true
  setInterval(pollTranscripts, 300)
  log(`[transcript] watcher started (project=${PROJECT_DIR}, snapshot=${seenTranscripts.size} files)`)
}

startTranscriptWatcher()

// ---------------------------------------------------------------------------
// Embedded HTML — kept in ui.html for editor highlighting and easier diffing.
// Loaded once at startup with template substitution; not hot-reloaded.
// ---------------------------------------------------------------------------

// Look up the sprite name via `sprite-env info`; fall back to hostname() if
// the CLI is missing or fails. Used for the header title so the user can
// tell tabs apart when running multiple Sprites at once.
function getSpriteName(): string {
  try {
    const out = execSync('sprite-env info', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    const info = JSON.parse(out)
    if (typeof info.sprite_name === 'string' && info.sprite_name) return info.sprite_name
  } catch { /* fall through */ }
  return hostname()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

const SPRITE_NAME = getSpriteName()
const HTML = readFileSync(join(import.meta.dir, 'ui.html'), 'utf8')
  .replaceAll('{{SPRITE_NAME}}', escapeHtml(SPRITE_NAME))
