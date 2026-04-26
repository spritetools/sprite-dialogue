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
    const text = extractText(entry.message.content).trim()
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
