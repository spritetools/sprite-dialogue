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
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, appendFileSync } from 'fs'
import { homedir, hostname } from 'os'
import { join, extname, basename } from 'path'
import type { ServerWebSocket } from 'bun'

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
      'Plugin hooks automatically mirror your conversational text to the UI — you do not need to call any tool to send text. Just respond normally.',
      '',
      'Messages from the web UI arrive as <channel source="sprite-dialogue" chat_id="web" message_id="..." [file_name="..." file_path="..."]>. If the tag has a file_path attribute, Read that file — it is a screenshot or image upload from the user.',
      '',
      'To send an IMAGE to the user, use the send_image tool with the absolute file path. Use this only for images; text is mirrored automatically.',
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
        'text is mirrored to the UI automatically by the plugin hook.',
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

    // Hook-driven echo endpoint: terminal -> UI mirroring
    if (url.pathname === '/echo' && req.method === 'POST') {
      return (async () => {
        try {
          const body = await req.json() as { type: 'user' | 'assistant'; text: string }
          const text = (body.text ?? '').toString()
          if (!text.trim()) return new Response(null, { status: 204 })
          const from: 'user' | 'assistant' = body.type === 'assistant' ? 'assistant' : 'user'
          const id = nextId()
          broadcast({ type: 'msg', id, from, text, ts: Date.now() })
          log(`[echo] ${from}: ${text.slice(0, 80)}`)
          return new Response(null, { status: 204 })
        } catch (err) {
          log(`[echo] error: ${err}`)
          return new Response('bad request', { status: 400 })
        }
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
    },
    close: (ws) => {
      clients.delete(ws)
      log(`[ws] close (clients=${clients.size})`)
    },
    message: (_, raw) => {
      const rawStr = String(raw)
      log(`[ws] message received: ${rawStr.slice(0, 120)}`)
      try {
        const { id, text } = JSON.parse(rawStr) as { id: string; text: string }
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
// Embedded HTML
// ---------------------------------------------------------------------------

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sprite-dialogue</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #111827;
    color: #e5e7eb;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* -- Header -- */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 1rem;
    background: #1f2937;
    border-bottom: 1px solid #374151;
    flex-shrink: 0;
  }
  header h1 { font-size: 0.875rem; font-weight: 600; }
  #status {
    width: 8px; height: 8px; border-radius: 50%;
    background: #ef4444;
    transition: background 0.3s;
  }
  #status.connected { background: #22c55e; }

  /* -- Messages -- */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .msg {
    max-width: 80%;
    padding: 0.625rem 0.875rem;
    border-radius: 12px;
    line-height: 1.5;
    word-break: break-word;
    position: relative;
  }
  .msg-assistant {
    align-self: flex-start;
    background: #1f2937;
    border: 1px solid #374151;
  }
  .msg-user {
    align-self: flex-end;
    background: #1d4ed8;
  }

  .msg-meta {
    font-size: 0.6875rem;
    opacity: 0.5;
    margin-top: 0.25rem;
  }

  .msg-text { white-space: pre-wrap; }

  .msg-reply-quote {
    font-size: 0.75rem;
    opacity: 0.6;
    border-left: 2px solid #6b7280;
    padding-left: 0.5rem;
    margin-bottom: 0.375rem;
    max-height: 2.5em;
    overflow: hidden;
  }

  .msg-image {
    max-width: 100%;
    max-height: 400px;
    border-radius: 8px;
    margin-top: 0.375rem;
    cursor: pointer;
    display: block;
  }

  .msg-file-link {
    display: inline-block;
    margin-top: 0.375rem;
    color: #93c5fd;
    text-decoration: underline;
  }

  /* -- Drop overlay -- */
  #drop-overlay {
    position: fixed;
    inset: 0;
    background: rgba(29, 78, 216, 0.25);
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    font-weight: 600;
    color: #93c5fd;
    border: 3px dashed #3b82f6;
    z-index: 100;
    pointer-events: none;
  }
  #drop-overlay.active { display: flex; }

  /* -- Compose -- */
  #compose {
    flex-shrink: 0;
    background: #1f2937;
    border-top: 1px solid #374151;
    padding: 0.75rem 1rem;
  }

  #preview-bar {
    display: none;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    padding: 0.375rem;
    background: #374151;
    border-radius: 8px;
  }
  #preview-bar.active { display: flex; }
  #preview-thumb {
    height: 48px;
    max-width: 120px;
    border-radius: 4px;
    object-fit: cover;
  }
  #preview-name { font-size: 0.75rem; opacity: 0.7; flex: 1; }
  #preview-remove {
    background: none; border: none; color: #ef4444;
    font-size: 1rem; cursor: pointer; padding: 0.25rem;
  }

  #compose-row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }

  #text {
    flex: 1;
    resize: none;
    border: 1px solid #374151;
    border-radius: 8px;
    background: #111827;
    color: #e5e7eb;
    font: inherit;
    font-size: 0.875rem;
    padding: 0.5rem 0.75rem;
    min-height: 2.5rem;
    max-height: 8rem;
    outline: none;
  }
  #text:focus { border-color: #3b82f6; }

  #compose-actions {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }

  .btn {
    background: none;
    border: 1px solid #4b5563;
    color: #d1d5db;
    border-radius: 6px;
    padding: 0.375rem 0.625rem;
    font-size: 0.8125rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:hover { background: #374151; }
  .btn-primary {
    background: #2563eb;
    border-color: #2563eb;
    color: #fff;
  }
  .btn-primary:hover { background: #1d4ed8; }

  #file-input { display: none; }

  /* -- Lightbox -- */
  #lightbox {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.92);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 200;
    cursor: zoom-out;
  }
  #lightbox img {
    max-width: 92vw;
    max-height: 92vh;
    border-radius: 4px;
  }
</style>
</head>
<body>

<header>
  <h1>sprite-dialogue</h1>
  <div id="status"></div>
</header>

<div id="messages"></div>

<div id="drop-overlay">Drop image here</div>

<div id="lightbox" onclick="this.style.display='none'">
  <img src="" alt="preview">
</div>

<form id="compose" onsubmit="return handleSubmit(event)">
  <div id="preview-bar">
    <img id="preview-thumb" src="" alt="preview">
    <span id="preview-name"></span>
    <button type="button" id="preview-remove" onclick="clearPending()">&times;</button>
  </div>
  <div id="compose-row">
    <textarea id="text" rows="1" placeholder="Message or paste a screenshot..." autocomplete="off"></textarea>
    <div id="compose-actions">
      <button type="button" class="btn" onclick="document.getElementById('file-input').click()">Attach</button>
      <input type="file" id="file-input" accept="image/*" onchange="handleFileSelect(this)">
      <button type="submit" class="btn btn-primary">Send</button>
    </div>
  </div>
</form>

<script>
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const messagesEl = document.getElementById('messages')
const textEl = document.getElementById('text')
const statusEl = document.getElementById('status')
const previewBar = document.getElementById('preview-bar')
const previewThumb = document.getElementById('preview-thumb')
const previewName = document.getElementById('preview-name')
const dropOverlay = document.getElementById('drop-overlay')
const lightbox = document.getElementById('lightbox')
const lightboxImg = lightbox.querySelector('img')

const msgMap = {}   // id -> { el, bodyEl, text }
let pendingFile = null  // File or Blob
let pendingObjectUrl = null
let uid = 0

// ---------------------------------------------------------------------------
// WebSocket with auto-reconnect and outbound queue
// ---------------------------------------------------------------------------
let ws = null
let reconnectDelay = 500
const outboundQueue = []  // messages to send once WS is open

function wsSend(payload) {
  const data = JSON.stringify(payload)
  if (ws && ws.readyState === 1) {
    try { ws.send(data); return true }
    catch (err) { console.warn('ws.send failed, queuing:', err) }
  }
  outboundQueue.push(data)
  return false
}

function flushQueue() {
  while (outboundQueue.length && ws && ws.readyState === 1) {
    try { ws.send(outboundQueue.shift()) }
    catch (err) { console.warn('flush failed:', err); break }
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(proto + '//' + location.host + '/ws')

  ws.onopen = () => {
    statusEl.classList.add('connected')
    reconnectDelay = 500
    flushQueue()
  }

  ws.onclose = () => {
    statusEl.classList.remove('connected')
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 8000)
  }

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.type === 'msg') addMessage(m)
    if (m.type === 'edit') editMessage(m.id, m.text)
  }
}
connect()

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
function addMessage(m) {
  const div = document.createElement('div')
  div.className = 'msg msg-' + m.from

  // Quote reply
  if (m.replyTo && msgMap[m.replyTo]) {
    const quote = document.createElement('div')
    quote.className = 'msg-reply-quote'
    quote.textContent = msgMap[m.replyTo].text.slice(0, 120)
    div.appendChild(quote)
  }

  // Text body
  const body = document.createElement('div')
  body.className = 'msg-text'
  body.textContent = m.text || ''
  div.appendChild(body)

  // File / image
  if (m.file) {
    if (m.file.isImage) {
      const img = document.createElement('img')
      img.className = 'msg-image'
      img.src = m.file.url
      img.alt = m.file.name
      img.loading = 'lazy'
      img.onclick = () => openLightbox(img.src)
      img.onload = () => { if (wasNearBottom) scrollToBottom() }
      div.appendChild(img)
    } else {
      const a = document.createElement('a')
      a.className = 'msg-file-link'
      a.href = m.file.url
      a.download = m.file.name
      a.textContent = m.file.name
      div.appendChild(a)
    }
  }

  // Timestamp
  const meta = document.createElement('div')
  meta.className = 'msg-meta'
  meta.textContent = new Date(m.ts).toLocaleTimeString()
  div.appendChild(meta)

  // Capture scroll position BEFORE appending so we can detect "was at bottom"
  const wasNearBottom = isNearBottom() || m.from === 'user'

  messagesEl.appendChild(div)
  msgMap[m.id] = { el: div, bodyEl: body, text: m.text || '' }

  if (wasNearBottom) scrollToBottom()
}

function editMessage(id, text) {
  const entry = msgMap[id]
  if (!entry) return
  entry.bodyEl.textContent = text + ' (edited)'
  entry.text = text
}

function isNearBottom() {
  const el = messagesEl
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

function scrollToBottom() {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' })
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
function openLightbox(src) {
  lightboxImg.src = src
  lightbox.style.display = 'flex'
}

// ---------------------------------------------------------------------------
// Pending image (paste / drop / file picker)
// ---------------------------------------------------------------------------
function setPending(file) {
  pendingFile = file
  if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl)
  pendingObjectUrl = URL.createObjectURL(file)
  previewThumb.src = pendingObjectUrl
  previewName.textContent = file.name || 'clipboard.png'
  previewBar.classList.add('active')
}

function clearPending() {
  pendingFile = null
  if (pendingObjectUrl) { URL.revokeObjectURL(pendingObjectUrl); pendingObjectUrl = null }
  previewBar.classList.remove('active')
  document.getElementById('file-input').value = ''
}

// ---------------------------------------------------------------------------
// Clipboard paste
// ---------------------------------------------------------------------------
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const blob = item.getAsFile()
      if (blob) setPending(blob)
      return
    }
  }
})

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------
let dragCounter = 0

document.addEventListener('dragenter', (e) => {
  e.preventDefault()
  dragCounter++
  dropOverlay.classList.add('active')
})

document.addEventListener('dragleave', (e) => {
  e.preventDefault()
  dragCounter--
  if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('active') }
})

document.addEventListener('dragover', (e) => e.preventDefault())

document.addEventListener('drop', (e) => {
  e.preventDefault()
  dragCounter = 0
  dropOverlay.classList.remove('active')
  const file = e.dataTransfer?.files[0]
  if (file && file.type.startsWith('image/')) setPending(file)
})

// ---------------------------------------------------------------------------
// File picker
// ---------------------------------------------------------------------------
function handleFileSelect(input) {
  const file = input.files[0]
  if (file) setPending(file)
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------
function handleSubmit(e) {
  e.preventDefault()
  const text = textEl.value.trim()
  const file = pendingFile

  if (!text && !file) return

  const id = 'u' + Date.now() + '-' + (++uid)

  if (file) {
    // Optimistic render with object URL
    const localUrl = pendingObjectUrl
    const name = file.name || 'clipboard.png'
    const isImage = file.type.startsWith('image/')
    addMessage({ id, from: 'user', text, ts: Date.now(), file: { url: localUrl, name, isImage } })

    // Upload
    const fd = new FormData()
    fd.set('id', id)
    fd.set('text', text)
    fd.set('file', file, name)
    fetch('/upload', { method: 'POST', body: fd })
      .then(r => {
        if (r.ok && r.status !== 204) {
          return r.json().then(data => {
            // Update image src to server URL
            const img = msgMap[id]?.el.querySelector('.msg-image')
            if (img && data.url) img.src = data.url
          })
        }
      })
      .catch(() => {})

    // Clear pending but don't revoke the object URL yet (it's displayed)
    pendingFile = null
    pendingObjectUrl = null
    previewBar.classList.remove('active')
    document.getElementById('file-input').value = ''
  } else {
    // Text-only
    addMessage({ id, from: 'user', text, ts: Date.now() })
    wsSend({ id, text })
  }

  textEl.value = ''
  textEl.style.height = ''
}

// ---------------------------------------------------------------------------
// Auto-resize textarea
// ---------------------------------------------------------------------------
textEl.addEventListener('input', () => {
  textEl.style.height = ''
  textEl.style.height = Math.min(textEl.scrollHeight, 128) + 'px'
})

// Enter to send, Shift+Enter for newline
textEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    document.getElementById('compose').requestSubmit()
  }
})
</script>
</body>
</html>`
