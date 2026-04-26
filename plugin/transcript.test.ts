import { test, expect, describe } from 'bun:test'
import {
  isChannelText,
  isLocalCommandArtifact,
  extractText,
  entryToMessage,
  parseEntries,
  nextActivity,
  IDLE_ACTIVITY,
  type Activity,
} from './transcript'

describe('isChannelText', () => {
  test('matches the channel source wrapper', () => {
    expect(isChannelText('<channel source="sprite-dialogue" chat_id="web">hi</channel>')).toBe(true)
  })
  test('tolerates leading whitespace', () => {
    expect(isChannelText('  \n<channel source="x">')).toBe(true)
  })
  test('rejects channel-source mid-text', () => {
    expect(isChannelText('hello <channel source="x">')).toBe(false)
  })
  test('rejects channel tag without source attr', () => {
    expect(isChannelText('<channel >')).toBe(false)
  })
  test('rejects empty string', () => {
    expect(isChannelText('')).toBe(false)
  })
})

describe('isLocalCommandArtifact', () => {
  test('matches local-command-stdout', () => {
    expect(isLocalCommandArtifact('<local-command-stdout>done</local-command-stdout>')).toBe(true)
  })
  test('matches local-command-caveat', () => {
    expect(isLocalCommandArtifact('<local-command-caveat>warn</local-command-caveat>')).toBe(true)
  })
  test('matches command-name', () => {
    expect(isLocalCommandArtifact('<command-name>/exit</command-name>')).toBe(true)
  })
  test('matches command-message and command-args', () => {
    expect(isLocalCommandArtifact('<command-message>x</command-message>')).toBe(true)
    expect(isLocalCommandArtifact('<command-args></command-args>')).toBe(true)
  })
  test('rejects unrelated tags', () => {
    expect(isLocalCommandArtifact('<channel source="x">')).toBe(false)
    expect(isLocalCommandArtifact('hello world')).toBe(false)
    expect(isLocalCommandArtifact('')).toBe(false)
  })
})

describe('extractText', () => {
  test('returns string content as-is', () => {
    expect(extractText('hello')).toBe('hello')
  })
  test('joins text blocks from an array', () => {
    expect(extractText([
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
    ])).toBe('one two')
  })
  test('skips non-text blocks (e.g. thinking)', () => {
    expect(extractText([
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text: 'visible' },
    ])).toBe('visible')
  })
  test('returns empty when any tool_result block is present', () => {
    expect(extractText([
      { type: 'text', text: 'x' },
      { type: 'tool_result', content: 'y' },
    ])).toBe('')
  })
  test('returns empty for non-array, non-string input', () => {
    expect(extractText(null)).toBe('')
    expect(extractText(42)).toBe('')
    expect(extractText({ type: 'text', text: 'x' })).toBe('')
  })
})

describe('entryToMessage', () => {
  const baseAssistant = (overrides: any = {}) => ({
    type: 'assistant',
    uuid: 'a-uuid',
    timestamp: '2026-04-25T12:00:00.000Z',
    message: { content: [{ type: 'text', text: 'hello' }] },
    ...overrides,
  })
  const baseUser = (overrides: any = {}) => ({
    type: 'user',
    uuid: 'u-uuid',
    timestamp: '2026-04-25T12:00:00.000Z',
    message: { content: 'hi there' },
    ...overrides,
  })

  test('converts a valid assistant entry', () => {
    expect(entryToMessage(baseAssistant())).toEqual({
      id: 'a-uuid',
      from: 'assistant',
      text: 'hello',
      ts: Date.parse('2026-04-25T12:00:00.000Z'),
    })
  })
  test('converts a valid user entry (string content)', () => {
    expect(entryToMessage(baseUser())).toEqual({
      id: 'u-uuid',
      from: 'user',
      text: 'hi there',
      ts: Date.parse('2026-04-25T12:00:00.000Z'),
    })
  })
  test('returns null when uuid is missing', () => {
    expect(entryToMessage(baseAssistant({ uuid: undefined }))).toBeNull()
  })
  test('returns null when timestamp is missing', () => {
    expect(entryToMessage(baseAssistant({ timestamp: undefined }))).toBeNull()
  })
  test('returns null when timestamp is unparseable', () => {
    expect(entryToMessage(baseAssistant({ timestamp: 'not-a-date' }))).toBeNull()
  })
  test('returns null for assistant tool turns (tool_result present)', () => {
    expect(entryToMessage(baseAssistant({
      message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_result', content: 'y' }] },
    }))).toBeNull()
  })
  test('returns null for assistant entries with empty text', () => {
    expect(entryToMessage(baseAssistant({
      message: { content: [{ type: 'text', text: '   ' }] },
    }))).toBeNull()
  })
  test('returns null for user channel echoes', () => {
    expect(entryToMessage(baseUser({
      message: { content: '<channel source="sprite-dialogue">hi</channel>' },
    }))).toBeNull()
  })
  test('returns null for user local-command artifacts', () => {
    expect(entryToMessage(baseUser({
      message: { content: '<command-name>/exit</command-name>' },
    }))).toBeNull()
    expect(entryToMessage(baseUser({
      message: { content: '<local-command-stdout>bye</local-command-stdout>' },
    }))).toBeNull()
  })
  test('returns null for unknown entry types', () => {
    expect(entryToMessage(baseAssistant({ type: 'permission-mode' }))).toBeNull()
    expect(entryToMessage(baseAssistant({ type: 'system' }))).toBeNull()
  })
  test('returns null for user entries with array content (meta injections like /sprite skill loading)', () => {
    expect(entryToMessage(baseUser({
      message: { content: [{ type: 'text', text: 'Base directory for this skill: /home/sprite/.claude/skills/sprite\n\nIMPORTANT...' }] },
    }))).toBeNull()
  })
  test('returns null for non-object input', () => {
    expect(entryToMessage(null)).toBeNull()
    expect(entryToMessage(undefined)).toBeNull()
    expect(entryToMessage('string')).toBeNull()
    expect(entryToMessage(42)).toBeNull()
  })
})

describe('parseEntries', () => {
  const valid = JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-04-25T12:00:00.000Z',
    message: { content: [{ type: 'text', text: 'one' }] },
  })
  const valid2 = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-04-25T12:00:01.000Z',
    message: { content: 'two' },
  })
  const channelEcho = JSON.stringify({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-04-25T12:00:02.000Z',
    message: { content: '<channel source="x">x</channel>' },
  })

  test('returns [] for empty input', () => {
    expect(parseEntries('')).toEqual([])
  })
  test('parses a single entry', () => {
    expect(parseEntries(valid)).toHaveLength(1)
  })
  test('parses multiple entries separated by newlines', () => {
    const out = parseEntries([valid, valid2].join('\n'))
    expect(out).toHaveLength(2)
    expect(out[0].id).toBe('a1')
    expect(out[1].id).toBe('u1')
  })
  test('skips blank lines', () => {
    const out = parseEntries(['', valid, '', '', valid2, ''].join('\n'))
    expect(out).toHaveLength(2)
  })
  test('skips malformed JSON without throwing', () => {
    const out = parseEntries([valid, '{not json', valid2].join('\n'))
    expect(out).toHaveLength(2)
  })
  test('drops filtered entries (channel echoes) silently', () => {
    const out = parseEntries([valid, channelEcho, valid2].join('\n'))
    expect(out).toHaveLength(2)
    expect(out.map(m => m.id)).toEqual(['a1', 'u1'])
  })
})

describe('nextActivity', () => {
  const TS = '2026-04-26T12:00:00.000Z'
  const TS_MS = Date.parse(TS)

  const userEntry = (overrides: any = {}) => ({
    type: 'user',
    timestamp: TS,
    message: { content: 'hello' },
    ...overrides,
  })
  const assistantEntry = (content: any[], stop: string | null = 'end_turn', timestamp = TS) => ({
    type: 'assistant',
    timestamp,
    message: { content, stop_reason: stop },
  })
  const toolUse = (name: string, input: any) => ({ type: 'tool_use', name, input })
  const text = (s: string) => ({ type: 'text', text: s })
  const toolResult = (s: string) => ({ type: 'tool_result', content: s })

  // Helper to construct a busy state for tests that don't care about startedAt.
  const busyAt = (overrides: Partial<Activity> = {}): Activity => ({
    state: 'busy',
    toolCallCount: 0,
    latestTool: null,
    startedAt: TS_MS,
    ...overrides,
  })

  test('plain user entry transitions idle → busy', () => {
    const next = nextActivity(IDLE_ACTIVITY, userEntry())
    expect(next.state).toBe('busy')
    expect(next.toolCallCount).toBe(0)
    expect(next.latestTool).toBeNull()
  })

  test('records startedAt from entry timestamp on transition to busy', () => {
    const ts = '2026-04-26T13:30:00.000Z'
    const next = nextActivity(IDLE_ACTIVITY, userEntry({ timestamp: ts }))
    expect(next.startedAt).toBe(Date.parse(ts))
  })

  test('tool_result user entry leaves state unchanged', () => {
    const busy = busyAt({ toolCallCount: 2, latestTool: { name: 'Bash', summary: 'ls' } })
    const next = nextActivity(busy, userEntry({ message: { content: [toolResult('ok')] } }))
    expect(next).toBe(busy)  // same reference — no change
  })

  test('meta-injection user entry (array of text blocks) does not flip idle → busy', () => {
    // System reminders, skill loadings, etc. that claude code writes as user
    // entries with array content. Should be ignored — same filter as in
    // entryToMessage.
    const next = nextActivity(IDLE_ACTIVITY, userEntry({
      message: { content: [{ type: 'text', text: '<system-reminder>...</system-reminder>' }] },
    }))
    expect(next).toBe(IDLE_ACTIVITY)
  })

  test('assistant tool_use blocks increment count and update latestTool', () => {
    const a = nextActivity(IDLE_ACTIVITY, assistantEntry([toolUse('Bash', { command: 'ls -la' })], 'tool_use'))
    expect(a.state).toBe('busy')
    expect(a.toolCallCount).toBe(1)
    expect(a.latestTool).toEqual({ name: 'Bash', summary: 'ls -la' })

    const b = nextActivity(a, assistantEntry([toolUse('Read', { file_path: '/tmp/x.txt' })], 'tool_use'))
    expect(b.toolCallCount).toBe(2)
    expect(b.latestTool).toEqual({ name: 'Read', summary: '/tmp/x.txt' })
  })

  test('startedAt is preserved across subsequent assistant tool_use entries', () => {
    const start = busyAt({ toolCallCount: 1 })
    const next = nextActivity(start, assistantEntry(
      [toolUse('Read', { file_path: '/x' })],
      'tool_use',
      '2026-04-26T13:30:00.000Z',  // later timestamp
    ))
    expect(next.startedAt).toBe(TS_MS)  // unchanged from original busy
  })

  test('multiple tool_use blocks in one entry are all counted', () => {
    const next = nextActivity(IDLE_ACTIVITY, assistantEntry([
      toolUse('Bash', { command: 'ls' }),
      toolUse('Read', { file_path: '/x' }),
      toolUse('Grep', { pattern: 'foo' }),
    ], 'tool_use'))
    expect(next.toolCallCount).toBe(3)
    expect(next.latestTool).toEqual({ name: 'Grep', summary: 'foo' })
  })

  test('end_turn assistant entry resets to idle including startedAt', () => {
    const busy = busyAt({ toolCallCount: 5, latestTool: { name: 'Bash', summary: 'x' } })
    const next = nextActivity(busy, assistantEntry([text('done')], 'end_turn'))
    expect(next).toEqual({ state: 'idle', toolCallCount: 0, latestTool: null, startedAt: null })
  })

  test('end_turn from already-idle returns same reference', () => {
    const next = nextActivity(IDLE_ACTIVITY, assistantEntry([text('hi')], 'end_turn'))
    expect(next).toBe(IDLE_ACTIVITY)
  })

  test('plain user entry while already busy returns same reference', () => {
    const busy = busyAt({ toolCallCount: 3 })
    const next = nextActivity(busy, userEntry())
    expect(next).toBe(busy)
  })

  test('falls back to JSON.stringify for unknown tool inputs', () => {
    const next = nextActivity(IDLE_ACTIVITY, assistantEntry([
      toolUse('UnknownTool', { foo: 'bar', n: 42 }),
    ], 'tool_use'))
    expect(next.latestTool?.summary).toBe('{"foo":"bar","n":42}')
  })

  test('tool_use with no key field uses JSON.stringify', () => {
    const next = nextActivity(IDLE_ACTIVITY, assistantEntry([
      toolUse('Bash', { /* no command */ unexpected: 'x' }),
    ], 'tool_use'))
    expect(next.latestTool?.summary).toBe('{"unexpected":"x"}')
  })

  test('non-object input yields empty summary', () => {
    const next = nextActivity(IDLE_ACTIVITY, assistantEntry([
      toolUse('Bash', null),
    ], 'tool_use'))
    expect(next.latestTool?.summary).toBe('')
  })

  test('non-end_turn non-tool_use stop does NOT flip idle → busy', () => {
    // Removing the previous fallback that auto-triggered busy on any
    // non-end_turn stop_reason. That was over-aggressive — it fired on
    // synthetic entries (e.g. claude code's "No response requested." for
    // /exit, with model: "<synthetic>" and stop_reason: "stop_sequence")
    // and spuriously lit up the activity bubble.
    expect(nextActivity(IDLE_ACTIVITY, assistantEntry([text('x')], 'max_tokens'))).toBe(IDLE_ACTIVITY)
    expect(nextActivity(IDLE_ACTIVITY, assistantEntry([text('No response requested.')], 'stop_sequence'))).toBe(IDLE_ACTIVITY)
  })

  test('malformed entry returns same reference', () => {
    expect(nextActivity(IDLE_ACTIVITY, null)).toBe(IDLE_ACTIVITY)
    expect(nextActivity(IDLE_ACTIVITY, undefined)).toBe(IDLE_ACTIVITY)
    expect(nextActivity(IDLE_ACTIVITY, 'string')).toBe(IDLE_ACTIVITY)
    expect(nextActivity(IDLE_ACTIVITY, {})).toBe(IDLE_ACTIVITY)
  })
})
