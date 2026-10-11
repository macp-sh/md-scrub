import { test, expect, mock } from 'claude-code/testing'
import { outcomeLine, progressLine } from '../hooks/status'

const STATE = '/home/test/.claude/md-scrub/state'

test('lines appear only when md-scrub acted', () => {
  const base = { id: 'x', file: '/p/DEPS.md', phase: 'done', startedAt: 0 }
  expect(outcomeLine({ ...base, outcome: 'scrubbed', edits: 2 })).toBe('scrubbed DEPS.md (2 edits)')
  expect(outcomeLine({ ...base, file: '/p/terms.md', outcome: 'flagged', reason: 'mostly third-party legal terms' })).toBe('flagged terms.md (mostly third-party legal terms)')
  expect(outcomeLine({ ...base, outcome: 'unchecked' })).toBe("not checked DEPS.md (OpenRouter isn't responding)")
  expect(outcomeLine({ ...base, outcome: 'clean' })).toBeUndefined()
  expect(outcomeLine({ ...base, outcome: 'clean' })).toBeUndefined()
  expect(progressLine({ ...base, phase: 'Jev 1/2' })).toBeUndefined()
  expect(progressLine({ ...base, phase: 'sweeping 1/3: a.md' })).toBeUndefined()
  expect(progressLine({ ...base, phase: 'scrubbing 1 section' })).toBe('scrubbing DEPS.md…')
})

test('stays hidden while checking, shows the clean-up and outcome, then clears', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: STATE, stderr: '', isStdoutTruncated: false } }))
  const files = new Map<string, string>()
  const statuses: (string | undefined)[] = []
  let release = () => {}

  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  // Stands in for md-scrub's settings hook: writes progress, waits, then records the outcome.
  on('classic.PreToolUse', async (_$, e) => {
    const call = `${STATE}/calls/${e.tool_use_id.replace(/[^\w-]/g, '')}.json`
    const record = { id: e.tool_use_id, file: '/p/DEPS.md', phase: 'Jev 1/2', startedAt: clock.now() }
    files.set(call, JSON.stringify(record))
    await new Promise<void>(resolve => (release = resolve))
    files.set(call, JSON.stringify({ ...record, phase: 'scrubbing 1 section' }))
    await new Promise<void>(resolve => (release = resolve))
    const done = { ...record, phase: 'done', outcome: 'scrubbed', edits: 2 }
    files.set(call, JSON.stringify(done))
    return {}
  })
  on('tool.call', () => ({ result: 'wrote DEPS.md' }))

  const call = $.tool.call({ tool: 'Write', file_path: '/p/DEPS.md', content: 'x' })
  await clock.advance(100)
  expect(statuses).toEqual([]) // nothing before 300 ms

  await clock.advance(600)
  expect(statuses).toEqual([]) // Jev checking: nothing found yet

  release()
  await clock.advance(500)
  expect(statuses.at(-1)).toBe('scrubbing DEPS.md…')

  release()
  await call
  await clock.advance(0)
  expect(statuses.at(-1)).toBe('scrubbed DEPS.md (2 edits)')

  await clock.advance(6000)
  expect(statuses.at(-1)).toBeUndefined()
})

test('stays quiet for calls md-scrub ignores', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: STATE, stderr: '', isStdoutTruncated: false } }))
  const statuses: (string | undefined)[] = []
  on('fs.read', () => {
    throw new Error('missing')
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: 'ok' }))

  await $.tool.call({ tool: 'Read', file_path: '/p/app.ts' })
  await clock.advance(1000)
  expect(statuses).toEqual([])
})

test('passes a block from beneath through unchanged', async ($, on) => {
  mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: STATE, stderr: '', isStdoutTruncated: false } }))
  on('fs.read', () => {
    throw new Error('missing')
  })
  on('classic.PreToolUse', () => ({ deny: 'md-scrub blocked this write' }))
  const result = await $.tool.call({ tool: 'Write', file_path: '/p/LICENSE', content: 'x' })
  expect(result.isError).toBe(true)
})

test('keeps a setup problem on the line, under any outcome, until a later check clears it', async ($, on) => {
  const clock = mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: STATE, stderr: '', isStdoutTruncated: false } }))
  const files = new Map<string, string>()
  const statuses: (string | undefined)[] = []
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  // Stands in for md-scrub's session-start check, which writes setup.json.
  let line: string | null = 'off: add your OpenRouter key in /plugin > Installed > md-scrub > Configure'
  on('classic.SessionStart', () => {
    files.set(`${STATE}/setup.json`, JSON.stringify({ cwd: '/p', line }))
    return {}
  })
  on('classic.PreToolUse', (_$, e) => {
    files.set(`${STATE}/calls/${e.tool_use_id.replace(/[^\w-]/g, '')}.json`,
      JSON.stringify({ id: e.tool_use_id, file: '/p/DEPS.md', phase: 'done', startedAt: clock.now(), outcome: 'scrubbed', edits: 1 }))
    return {}
  })
  on('tool.call', () => ({ result: 'wrote DEPS.md' }))

  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  expect(statuses.at(-1)).toBe(line)

  await $.tool.call({ tool: 'Write', file_path: '/p/DEPS.md', content: 'x' })
  await clock.advance(0)
  expect(statuses.at(-1)).toBe('scrubbed DEPS.md (1 edit)')
  await clock.advance(6000)
  expect(statuses.at(-1)).toBe(line)

  line = null
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  expect(statuses.at(-1)).toBeUndefined()
})

test('ignores a setup problem recorded for another folder', async ($, on) => {
  mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: STATE, stderr: '', isStdoutTruncated: false } }))
  const statuses: (string | undefined)[] = []
  on('fs.read', () => ({ value: JSON.stringify({ cwd: '/other', line: 'off: a settings or topic file has an error' }) }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'startup', cwd: '/p' })
  expect(statuses.at(-1)).toBeUndefined()
})
