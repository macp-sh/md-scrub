import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  withTopicSetting, topicSetting, cycle, effective, patterns, withPattern, logActions, isPaused, header, isExcluded,
} from '../hooks/panel'

const HOME = '/home/test'
const ROOT = '/p/acme-app'
const USER = `${HOME}/.claude/md-scrub`
const PROJECT = `${ROOT}/.claude/md-scrub`
const STATE = `${USER}/state`

// ---------- pure helpers ----------

test('topic settings are written, cycled and removed cleanly', () => {
  const on = withTopicSetting({ thresholds: { flag: 0.4 } }, 'credentials', true)
  expect(JSON.parse(on)).toEqual({ thresholds: { flag: 0.4 }, topics: { credentials: { enabled: true } } })
  expect(JSON.parse(withTopicSetting(JSON.parse(on), 'credentials', undefined))).toEqual({ thresholds: { flag: 0.4 } })
  expect([cycle(undefined), cycle(true), cycle(false)]).toEqual([true, false, undefined])
  expect(topicSetting({ topics: { a: { enabled: false } } }, 'a')).toBe(false)
  expect(topicSetting({}, 'a')).toBeUndefined()
})

test('the project beats the user, which beats the default', () => {
  const t = { id: 'a', name: 'A', description: '', builtIn: true, def: true }
  expect(effective(t, { user: {}, project: {} })).toBe(true)
  expect(effective(t, { user: { topics: { a: { enabled: false } } }, project: {} })).toBe(false)
  expect(effective(t, { user: { topics: { a: { enabled: false } } }, project: { topics: { a: { enabled: true } } } })).toBe(true)
})

test('exclusion files keep comments and order', () => {
  const text = '# saved docs\nlegal/\n'
  expect(patterns(text)).toEqual(['legal/'])
  expect(withPattern(text, 'notes/', true)).toBe('# saved docs\nlegal/\nnotes/\n')
  expect(withPattern(text, 'legal/', true)).toBe(text)
  expect(withPattern(text, 'legal/', false)).toBe('# saved docs\n')
  expect(withPattern('', 'a.md', true)).toBe('a.md\n')
  expect(isExcluded('docs/legal/terms.md', ['legal/'])).toBe(true)
  expect(isExcluded('notes/a.draft.md', ['*.draft.md'])).toBe(true)
  expect(isExcluded('docs/maps.md', ['docs/'])).toBe(true)
  expect(isExcluded('docs/maps.md', ['maps.md'])).toBe(true)
  expect(isExcluded('docs/maps.md', ['notes/'])).toBe(false)
})

test('the log shows actions newest first, without clean ones or other events', () => {
  const text = [
    { t: '2026-10-11T03:00:00Z', event: 'action', action: 'scrubbed', file: `${ROOT}/a.md` },
    { t: '2026-10-11T03:01:00Z', event: 'jev', p: 0.1 },
    { t: '2026-10-11T03:02:00Z', event: 'action', action: 'clean', file: `${ROOT}/b.md` },
    { t: '2026-10-11T03:03:00Z', event: 'action', action: 'flagged', file: `${ROOT}/c.md` },
  ].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n'
  expect(logActions(text).map(e => e.action)).toEqual(['flagged', 'scrubbed'])
})

test('paused only while the latest Jev or action entry is a recent unchecked write', () => {
  const now = Date.parse('2026-10-11T03:10:00Z')
  const unchecked = JSON.stringify({ t: '2026-10-11T03:05:00Z', event: 'action', action: 'unchecked', file: 'x.md' })
  const jev = JSON.stringify({ t: '2026-10-11T03:06:00Z', event: 'jev', p: 0.1 })
  expect(isPaused(unchecked, now)).toBe(true)
  expect(isPaused(`${unchecked}\n${jev}`, now)).toBe(false)
  expect(isPaused(unchecked, now + 20 * 60 * 1000)).toBe(false)
})

test('the header comes from the start-up check, for this project only', () => {
  expect(header(undefined, ROOT, false)).toEqual({ state: 'on' })
  expect(header({ cwd: ROOT, line: 'off: add your OpenRouter key in /plugin > Installed > md-scrub > Configure' }, ROOT, false))
    .toEqual({ state: 'off', reason: 'add your OpenRouter key in /plugin > Installed > md-scrub > Configure' })
  expect(header({ cwd: '/elsewhere', line: 'off: a settings or topic file has an error' }, ROOT, false)).toEqual({ state: 'on' })
  expect(header({ cwd: ROOT, line: '1 topic has an error' }, ROOT, false)).toEqual({ state: 'on', warning: '1 topic has an error' })
  expect(header(undefined, ROOT, true).state).toBe('paused')
})

// ---------- the pane, against a small in-memory file system ----------

function fakeFiles(on: On, files: Map<string, string>, writes: Map<string, string>) {
  mock.clock(on)
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.root', () => ({ value: ROOT }))
  // The plugin's own defaults are found by their tail, wherever the test loads the plugin from.
  const find = (path: string) => files.get(path) ?? [...files].find(([k]) => k.startsWith('*') && path.endsWith(k.slice(1)))?.[1]
  on('fs.read', (_$, e) => {
    const text = find(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_$, e) => ({ value: find(e.path) !== undefined }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const dir = e.path.replace(/\/$/, '')
    const names = new Map<string, 'file' | 'dir'>()
    for (const [k] of files) {
      const key = k.startsWith('*') ? null : k
      if (!key || !key.startsWith(dir + '/')) continue
      const rest = key.slice(dir.length + 1)
      names.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
    }
    for (const [k] of files) {
      if (k.startsWith('*') && k.slice(1).startsWith('/defaults/topics/') && dir.endsWith('/defaults/topics')) names.set(k.split('/').pop()!, 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
}

const PANE_PROPS = {
  title: 'md-scrub', isFocused: true, bodyColumns: 100, placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

function project(extra: Record<string, string> = {}) {
  return new Map<string, string>([
    ['*/defaults/config.json', JSON.stringify({ enabled: true, topics: { 'third-party-terms': { enabled: true } } })],
    ['*/defaults/topics/third-party-terms.json', JSON.stringify({ name: 'third-party legal terms', description: 'What other companies say you can or cannot do.' })],
    [`${PROJECT}/config.json`, JSON.stringify({ topics: { 'third-party-terms': { enabled: false } } })],
    [`${USER}/topics/advice.json`, JSON.stringify({ name: 'medical or financial advice', description: 'Recommendations about health or money.' })],
    [`${ROOT}/docs/maps.md`, '# Maps'],
    [`${ROOT}/legal/terms.md`, '# Terms'],
    ...Object.entries(extra),
  ])
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: topics show the result here, and a cell cycles that scope's config.json`, async ($, on) => {
    const files = project()
    const writes = new Map<string, string>()
    fakeFiles(on, files, writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })

    expect((await ui.find({ text: /^md-scrub$/ })) ?? (await ui.find({ text: 'md-scrub' }))).toBeDefined()
    expect(await ui.find({ text: 'Third-party legal terms' })).toBeDefined()
    expect(await ui.find({ text: 'acme-app' })).toBeDefined()

    // Not set for the user: pressing sets it on.
    await ui.press({ key: 't:third-party-terms:user' })
    expect(JSON.parse(writes.get(`${USER}/config.json`)!)).toEqual({ topics: { 'third-party-terms': { enabled: true } } })
    // Off for the project: pressing clears it, removing the key.
    await ui.press({ key: 't:third-party-terms:project' })
    expect(JSON.parse(writes.get(`${PROJECT}/config.json`)!)).toEqual({})
  })

  test(`${surface}: the header says why md-scrub is off`, async ($, on) => {
    const files = project({ [`${STATE}/setup.json`]: JSON.stringify({ cwd: ROOT, line: 'off: add your OpenRouter key in /plugin > Installed > md-scrub > Configure' }) })
    fakeFiles(on, files, new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    expect(await ui.find({ text: 'off' })).toBeDefined()
    expect(await ui.find({ text: /add your OpenRouter key/ })).toBeDefined()
  })

  test(`${surface}: an exclusion is added to the project by default`, async ($, on) => {
    const files = project({ [`${PROJECT}/exclusions`]: '# ours\nlegal/\n' })
    const writes = new Map<string, string>()
    fakeFiles(on, files, writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'tab:exclusions' })
    expect(await ui.find({ text: 'legal/' })).toBeDefined()
    await ui.press({ key: 'addx' })
    await ui.input({ key: 'add', text: 'do', kind: 'change' })
    expect(await ui.find({ key: 's:docs/' })).toBeDefined()
    await ui.input({ key: 'add', text: 'docs/' })
    expect(writes.get(`${PROJECT}/exclusions`)).toBe('# ours\nlegal/\ndocs/\n')
  })

  test(`${surface}: the log lists scrubbed and flagged files, and e excludes one`, async ($, on) => {
    const log = [
      { t: '2026-10-11T03:00:00Z', event: 'action', action: 'scrubbed', file: `${ROOT}/docs/maps.md`, topics: ['third-party-terms'], edits: 1 },
      { t: '2026-10-11T03:01:00Z', event: 'action', action: 'clean', file: `${ROOT}/README.md` },
      { t: '2026-10-11T03:02:00Z', event: 'action', action: 'flagged', file: `${ROOT}/vendor-terms.md` },
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    const files = project({ [`${STATE}/log.jsonl`]: log })
    const writes = new Map<string, string>()
    fakeFiles(on, files, writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'tab:log' })
    expect(await ui.find({ text: /vendor-terms\.md/ })).toBeDefined()
    expect(await ui.find({ text: /README\.md/ })).toBeUndefined()
    await ui.press({ key: 'l:1' })
    await ui.press({ key: 'e:1' })
    expect(writes.get(`${PROJECT}/exclusions`)).toBe('docs/\n')
    expect(await ui.find({ text: /excluded/ })).toBeDefined()
  })
}
