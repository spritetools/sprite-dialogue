import { test, expect, describe } from 'bun:test'
import {
  isChannelText,
  isLocalCommandArtifact,
  extractText,
  entryToMessage,
  parseEntries,
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
