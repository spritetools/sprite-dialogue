/**
 * Pure JSONL transcript parsing. Used by both the live watcher and the
 * on-connect backfill in server.ts so the two paths can't disagree about
 * which entries become visible chat messages.
 *
 * Kept side-effect-free so it can be unit-tested without spinning up
 * server.ts's MCP / HTTP / WebSocket plumbing.
 */

export type ChatMsg = {
  id: string
  from: 'user' | 'assistant'
  text: string
  ts: number
}

export function isChannelText(s: string): boolean {
  return s.trimStart().startsWith('<channel source=')
}

// Slash-command artifacts that claude writes into the transcript as user
// entries — meta for claude's own consumption, not chat content. Examples:
// <command-name>/exit</command-name>, <local-command-stdout>...</...>,
// <local-command-caveat>...</...>. Filter so they don't pollute the UI.
export function isLocalCommandArtifact(s: string): boolean {
  const t = s.trimStart()
  return t.startsWith('<local-command-') ||
         t.startsWith('<command-name>') ||
         t.startsWith('<command-message>') ||
         t.startsWith('<command-args>')
}

export function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // tool_result blocks mean this is a tool turn, not real user/assistant text.
  if (content.some((b: any) => b?.type === 'tool_result')) return ''
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('')
}

// Convert a JSONL entry into a chat message. Returns null if the entry
// should not appear in the UI (tool turns, channel echoes, local-command
// meta, malformed entries, missing uuid/timestamp).
export function entryToMessage(entry: any): ChatMsg | null {
  if (!entry || typeof entry !== 'object' || !entry.uuid || !entry.timestamp) return null
  const ts = Date.parse(entry.timestamp)
  if (!Number.isFinite(ts)) return null
  if (entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)) {
    const text = extractText(entry.message.content)
    if (!text.trim()) return null
    return { id: entry.uuid, from: 'assistant', text, ts }
  }
  if (entry.type === 'user' && entry.message) {
    // Real user input (terminal, web UI, slash-command artifacts) always has
    // STRING content. Array content with text blocks indicates a meta injection
    // — slash-command-invoked skills (e.g. /sprite), system reminders, etc. —
    // which claude code synthesizes for its own consumption, not chat content.
    // Tool-result arrays were already dropped by extractText returning ''.
    if (typeof entry.message.content !== 'string') return null
    const text = entry.message.content.trim()
    if (!text) return null
    if (isChannelText(text)) return null
    if (isLocalCommandArtifact(text)) return null
    return { id: entry.uuid, from: 'user', text, ts }
  }
  return null
}

// Parse the contents of a JSONL transcript into chat messages. Skips blank
// lines and malformed JSON silently — partial / mid-flush lines are common
// in the live tail path and shouldn't crash the watcher.
export function parseEntries(content: string): ChatMsg[] {
  const out: ChatMsg[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const msg = entryToMessage(JSON.parse(line))
      if (msg) out.push(msg)
    } catch { /* skip malformed */ }
  }
  return out
}

// ---------------------------------------------------------------------------
// Activity tracking — drives the "claude is working" indicator in the UI.
//
// BUSY rules (match the design discussion):
//   1. Most recent assistant entry's stop_reason ≠ "end_turn" → busy
//   2. A non-tool-result user entry newer than the most recent end_turn → busy
//      (covers the window where the user has spoken but claude hasn't yet
//      flushed its response to the JSONL — claude only writes at turn end).
//
// IDLE means: most recent assistant entry has stop_reason = "end_turn" AND
// no newer non-tool-result user entries.
// ---------------------------------------------------------------------------

export type Activity = {
  state: 'busy' | 'idle'
  toolCallCount: number  // count of tool_use blocks since the last end_turn
  latestTool: { name: string; summary: string } | null
  startedAt: number | null  // ms since epoch when the burst began; null when idle
}

export const IDLE_ACTIVITY: Activity = { state: 'idle', toolCallCount: 0, latestTool: null, startedAt: null }

function timestampMs(entry: any): number {
  const ts = entry?.timestamp ? Date.parse(entry.timestamp) : NaN
  return Number.isFinite(ts) ? ts : Date.now()
}

// Per-tool: which input field is the most useful to show as a one-line summary.
// Anything not listed here falls through to JSON.stringify(input).
const TOOL_KEY_FIELDS: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
}

function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  const key = TOOL_KEY_FIELDS[name]
  if (key) {
    const v = input[key]
    if (typeof v === 'string') return v
  }
  try { return JSON.stringify(input) } catch { return '' }
}

// Pure transition: given current activity state and the next JSONL entry,
// return the next activity. Returns the SAME object reference when nothing
// visible changed, so callers can cheaply dedupe broadcasts via `next !== prev`.
export function nextActivity(current: Activity, entry: any): Activity {
  if (!entry || typeof entry !== 'object' || !entry.type) return current

  if (entry.type === 'user' && entry.message) {
    // Only STRING content is a real new-turn trigger. Array content is either
    // a tool_result (continuation of an in-progress burst, not a fresh prompt)
    // or a meta injection (claude code writes these for system reminders,
    // skill loadings, session init, etc — they'd otherwise spuriously light
    // up "thinking…" on startup and keep counting until an end_turn that
    // never comes). Mirrors the same filter in entryToMessage.
    if (typeof entry.message.content !== 'string') return current
    if (current.state === 'busy') return current
    return { state: 'busy', toolCallCount: 0, latestTool: null, startedAt: timestampMs(entry) }
  }

  if (entry.type === 'assistant' && entry.message) {
    let next = current

    if (Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block?.type === 'tool_use') {
          if (next === current) next = { ...current }
          next.toolCallCount = next.toolCallCount + 1
          next.latestTool = {
            name: String(block.name ?? '?'),
            summary: summarizeToolInput(block.name, block.input),
          }
          if (next.state !== 'busy') {
            next.state = 'busy'
            // First sign of busy with no preceding user-trigger (e.g. bun
            // started mid-burst) — fall back to this entry's timestamp.
            next.startedAt = timestampMs(entry)
          }
        }
      }
    }

    if (entry.message.stop_reason === 'end_turn') {
      if (next.state !== 'idle' || next.toolCallCount !== 0 || next.latestTool !== null || next.startedAt !== null) {
        return { state: 'idle', toolCallCount: 0, latestTool: null, startedAt: null }
      }
      return current
    }

    // Other stop_reasons (tool_use, max_tokens, stop_sequence, ...) don't
    // override state on their own. tool_use is already handled by the loop
    // above; the rest can fire on synthetic / placeholder entries that don't
    // represent real claude work (e.g. claude code's "No response requested."
    // for /exit) and would spuriously light up the activity bubble.
    return next
  }

  return current
}
