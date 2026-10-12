import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  withTopicSetting, topicSetting, effective, patterns, withPattern, logActions, isPaused, header, isExcluded,
  projectLog, logDetail, inherited, shown, flipped, providerName, ownSettings, parseExclude, excludeRows,
} from '../hooks/panel'

const HOME = '/home/test'
const ROOT = '/p/acme-app'
const USER = `${HOME}/.claude/md-scrub`
const PROJECT = `${ROOT}/.claude/md-scrub`
const STATE = `${USER}/state`

// ---------- pure helpers ----------

test('topic settings are written and removed cleanly', () => {
  const on = withTopicSetting({ thresholds: { flag: 0.4 } }, 'credentials', true)
  expect(JSON.parse(on)).toEqual({ thresholds: { flag: 0.4 }, topics: { credentials: { enabled: true } } })
  expect(JSON.parse(withTopicSetting(JSON.parse(on), 'credentials', undefined))).toEqual({ thresholds: { flag: 0.4 } })
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
  expect(withPattern('legal/\n', 'legal/', false)).toBe('')
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

test('the log keeps this project\'s rows, under either spelling of its root, and counts the rest', () => {
  const rows = [
    { t: '', event: 'action', action: 'scrubbed', file: '/private/tmp/acme/docs/a.md' },
    { t: '', event: 'action', action: 'flagged', file: '/tmp/acme/b.md' },
    { t: '', event: 'action', action: 'flagged', file: '/tmp/acme-other/c.md' },
    { t: '', event: 'action', action: 'flagged', file: '/elsewhere/d.md' },
  ]
  const { rows: here, others } = projectLog(rows, ['/tmp/acme', '/private/tmp/acme'])
  expect(here.map(r => r.file)).toEqual(['docs/a.md', 'b.md'])
  expect(others).toBe(2)
  expect(projectLog(rows, ['/tmp/acme'], 1).rows.length).toBe(1)
})

test('a log row says what happened in one line', () => {
  const name = (id: string) => ({ terms: 'Third-party legal terms' } as Record<string, string>)[id] ?? id
  expect(logDetail({ t: '', event: 'action', action: 'scrubbed', topics: ['terms'], edits: 2 }, name)).toBe('Third-party legal terms · 2 edits')
  expect(logDetail({ t: '', event: 'action', action: 'flagged', topics: ['terms'], reason: 'mostly', share: 96 }, name))
    .toBe('Mostly Third-party legal terms (96%); saved as written for you to review')
  expect(logDetail({ t: '', event: 'action', action: 'flagged', topics: ['terms'], reason: 'clean-up failed' }, name))
    .toBe('Third-party legal terms; the clean-up failed, so it was saved as written')
  expect(logDetail({ t: '', event: 'action', action: 'unchecked', reason: 'timeout' }, name)).toBe('Not checked: timeout')
})

test('a scope that does not set a topic follows the next one down', () => {
  const t = { id: 'x', name: 'x', description: '', builtIn: true, def: true }
  expect(inherited(t, { user: {}, project: {} }, 'user')).toBe(true)
  expect(inherited(t, { user: {}, project: {} }, 'project')).toBe(true)
  expect(inherited(t, { user: { topics: { x: { enabled: false } } }, project: {} }, 'project')).toBe(false)
  // The user follows only the default, whatever the project says.
  expect(inherited(t, { user: {}, project: { topics: { x: { enabled: false } } } }, 'user')).toBe(true)
})

test('a cell shows its setting or what it inherits, and a press saves only a difference', () => {
  const t = { id: 'x', name: 'x', description: '', builtIn: true, def: true }
  const none = { user: {}, project: {} }
  const userOff = { user: { topics: { x: { enabled: false } } }, project: {} }
  expect(shown(t, none, 'project')).toBe(true)
  expect(shown(t, userOff, 'project')).toBe(false)
  // Turning the user off differs from the default, so it is saved.
  expect(flipped(t, none, 'user')).toBe(false)
  // Turning the user back on matches the default, so the setting goes.
  expect(flipped(t, userOff, 'user')).toBeUndefined()
  // The project differs from the user only while it is set against it.
  expect(flipped(t, none, 'project')).toBe(false)
  expect(flipped(t, { ...none, project: { topics: { x: { enabled: false } } } }, 'project')).toBeUndefined()
  expect(flipped(t, userOff, 'project')).toBe(true)
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
  expect(header({ cwd: ROOT, line: 'off: add an OpenRouter or TypeSafe key in /plugin > Installed > md-scrub > Configure' }, ROOT, false))
    .toEqual({ state: 'off', reason: 'add an OpenRouter or TypeSafe key in /plugin > Installed > md-scrub > Configure' })
  expect(header({ cwd: '/elsewhere', line: 'off: a settings or topic file has an error' }, ROOT, false)).toEqual({ state: 'on' })
  expect(header({ cwd: ROOT, line: '1 topic has an error' }, ROOT, false)).toEqual({ state: 'on', warning: '1 topic has an error' })
  expect(header(undefined, ROOT, true).state).toBe('paused')
  // A key added since the start-up check: that check's 'no key' line no longer holds.
  const noKey = { cwd: ROOT, line: 'off: add an OpenRouter or TypeSafe key in /plugin > Installed > md-scrub > Configure' }
  expect(header(noKey, ROOT, false, 'OpenRouter')).toEqual({ state: 'on', provider: 'OpenRouter' })
  expect(header({ cwd: ROOT, line: 'off: a settings or topic file has an error' }, ROOT, false, 'OpenRouter').state).toBe('off')
  // A start-up line from before TypeSafe keys were accepted still counts as 'no key'.
  expect(header({ cwd: ROOT, line: 'off: add your OpenRouter key in /plugin > Installed > md-scrub > Configure' }, ROOT, false, 'TypeSafe').state).toBe('on')
})

test("a topic's own Jev settings read as one line", () => {
  expect(ownSettings(undefined)).toBe('')
  expect(ownSettings({ model: 'jev-1.14.0', flag: 0.35 })).toBe('model jev-1.14.0 · flag 0.35')
  expect(ownSettings({ model: { typesafe: 'jev-1.14.0', openrouter: 'typesafe/jev-1.14' }, mostly: 0.6 }))
    .toBe('model jev-1.14.0 / typesafe/jev-1.14 · mostly 0.6')
})

test('Jev is reached through TypeSafe when its key is set, else OpenRouter', () => {
  expect(providerName({ typesafe: true, openrouter: true })).toBe('TypeSafe')
  expect(providerName({ openrouter: true })).toBe('OpenRouter')
  expect(providerName({})).toBeUndefined()
})

// ---------- the pane, against a small in-memory file system ----------

function fakeFiles(on: On, files: Map<string, string>, writes: Map<string, string>) {
  const clock = mock.clock(on)
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
  on('fs.stat', (_$, e) => {
    const text = find(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
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
  return clock
}

const PANE_PROPS = {
  title: 'md-scrub', isFocused: true, bodyColumns: 100, placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

function project(extra: Record<string, string> = {}) {
  return new Map<string, string>([
    ['*/.claude-plugin/plugin.json', JSON.stringify({ name: 'md-scrub', version: '9.8.7' })],
    ['*/defaults/config.json', JSON.stringify({ enabled: true, topics: { 'third-party-terms': { enabled: true } } })],
    ['*/defaults/topics/third-party-terms.json', JSON.stringify({ name: 'third-party legal terms', description: 'What other companies say you can or cannot do.' })],
    [`${PROJECT}/config.json`, JSON.stringify({ topics: { 'third-party-terms': { enabled: false } } })],
    [`${USER}/topics/advice.json`, JSON.stringify({ name: 'medical or financial advice', description: 'Recommendations about health or money.' })],
    [`${ROOT}/docs/maps.md`, '# Maps'],
    [`${ROOT}/legal/terms.md`, '# Terms'],
    ...Object.entries(extra),
  ])
}

// A user topic with its own Jev settings.
const advice = (jev: unknown) => JSON.stringify({ name: 'medical or financial advice', description: 'Recommendations about health or money.', jev })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: topics show the result here, and a cell toggles that scope's config.json`, async ($, on) => {
    const files = project()
    const writes = new Map<string, string>()
    fakeFiles(on, files, writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })

    expect((await ui.find({ text: /^md-scrub$/ })) ?? (await ui.find({ text: 'md-scrub' }))).toBeDefined()
    expect(await ui.find({ text: 'Third-party legal terms' })).toBeDefined()
    expect(await ui.find({ text: 'acme-app' })).toBeDefined()
    expect(await ui.find({ text: 'v9.8.7' })).toBeDefined()
    // Not set for the user: it shows the default it inherits (on); the project is set off.
    expect((await ui.find({ key: 'user@t:third-party-terms' }))?.text).toBe('●')
    expect((await ui.find({ key: 'project@t:third-party-terms' }))?.text).toBe('○')

    // On for the project matches the user it inherits from, so the project's setting goes.
    await ui.press({ key: 'project@t:third-party-terms' })
    expect(JSON.parse(writes.get(`${PROJECT}/config.json`)!)).toEqual({})
    // Off for the user differs from the default, so it is saved, and the project follows it.
    await ui.press({ key: 'user@t:third-party-terms' })
    expect(JSON.parse(writes.get(`${USER}/config.json`)!)).toEqual({ topics: { 'third-party-terms': { enabled: false } } })
    expect((await ui.find({ key: 'project@t:third-party-terms' }))?.text).toBe('○')
  })

  test(`${surface}: the header says why md-scrub is off`, async ($, on) => {
    const files = project({ [`${STATE}/setup.json`]: JSON.stringify({ cwd: ROOT, line: 'off: add an OpenRouter or TypeSafe key in /plugin > Installed > md-scrub > Configure' }) })
    fakeFiles(on, files, new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    expect(await ui.find({ text: 'off' })).toBeDefined()
    expect(await ui.find({ text: /add an OpenRouter or TypeSafe key/ })).toBeDefined()
  })

  test(`${surface}: a opens a field in the panel; a match fills it, and Enter adds what it holds`, async ($, on) => {
    const writes = new Map<string, string>()
    fakeFiles(on, project({ [`${PROJECT}/exclusions`]: '# ours\nlegal/\n' }), writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'tab:exclusions' })
    await ui.press({ key: 'addx' })
    expect(await ui.find({ key: 'add' })).toBeDefined()
    await ui.input({ key: 'add', text: 'do', kind: 'change' })
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('m:'))).toEqual(['m:docs/'])
    // Taking a folder fills the field with it and lists what's inside; nothing is added yet.
    await ui.press({ key: 'm:docs/' })
    expect((await ui.find({ key: 'add' }))?.props.value).toBe('docs/')
    expect(await ui.find({ key: 'm:docs/maps.md' })).toBeDefined()
    expect(writes.size).toBe(0)
    await ui.input({ key: 'add', text: 'docs/' })
    expect(writes.get(`${PROJECT}/exclusions`)).toBe('# ours\nlegal/\ndocs/\n')
  })

  test(`${surface}: the field adds to User once switched`, async ($, on) => {
    const writes = new Map<string, string>()
    fakeFiles(on, project(), writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'tab:exclusions' })
    await ui.press({ key: 'addx' })
    expect(await ui.find({ text: 'acme-app' })).toBeDefined()
    await ui.press({ key: 'target' })
    await ui.input({ key: 'add', text: 'notes/' })
    expect(writes.get(`${USER}/exclusions`)).toBe('notes/\n')
    expect(writes.has(`${PROJECT}/exclusions`)).toBe(false)
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
    expect(await ui.find({ text: /in other projects/ })).toBeUndefined()
    expect(await ui.find({ text: /README\.md/ })).toBeUndefined()
    await ui.press({ key: 'l:1' })
    await ui.press({ key: 'e:1' })
    expect(writes.get(`${PROJECT}/exclusions`)).toBe('docs/\n')
    expect(await ui.find({ text: /excluded/ })).toBeDefined()
  })

  test(`${surface}: the header counts topic errors and the legend says what enter does`, async ($, on) => {
    const files = project({ [`${PROJECT}/topics/customer-names.json`]: '{ not json' })
    fakeFiles(on, files, new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    expect(await ui.find({ text: /1 topic has an error/ })).toBeDefined()
    expect(await ui.find({ text: /toggle/ })).toBeDefined()
    // The cells are the stops, so there is no separate key for the User column.
    expect(await ui.find({ key: 'user' })).toBeUndefined()
    await ui.press({ key: 'tab:exclusions' })
    expect(await ui.find({ text: /path exclusion/ })).toBeDefined()
    expect(await ui.find({ text: /toggle/ })).toBeUndefined()
  })

  test(`${surface}: a config file that isn't valid JSON is reported in the panel, not overwritten`, async ($, on) => {
    const files = project({ [`${USER}/config.json`]: '{ broken' })
    const writes = new Map<string, string>()
    fakeFiles(on, files, writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'user@t:third-party-terms' })
    expect(writes.size).toBe(0)
    expect(await ui.find({ text: /isn't valid JSON; fix it first/ })).toBeDefined()
    // Moving to another screen clears it.
    await ui.press({ key: 'tab:log' })
    expect(await ui.find({ text: /isn't valid JSON/ })).toBeUndefined()
  })

  test(`${surface}: each cell is a stop: Enter or a click changes its own scope`, async ($, on) => {
    const files = project({ [`${PROJECT}/exclusions`]: 'legal/\n' })
    const writes = new Map<string, string>()
    fakeFiles(on, files, writes)
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'user@t:third-party-terms' })
    expect(JSON.parse(writes.get(`${USER}/config.json`)!)).toEqual({ topics: { 'third-party-terms': { enabled: false } } })
    await ui.press({ key: 'project@t:third-party-terms' })
    expect(JSON.parse(writes.get(`${PROJECT}/config.json`)!)).toEqual({ topics: { 'third-party-terms': { enabled: true } } })
    await ui.press({ key: 'tab:exclusions' })
    await ui.press({ key: 'user@x:legal/' })
    expect(writes.get(`${USER}/exclusions`)).toBe('legal/\n')
    await ui.press({ key: 'project@x:legal/' })
    expect(writes.get(`${PROJECT}/exclusions`)).toBe('')
  })

  test(`${surface}: off for want of a key, k closes the panel and opens /plugin`, async ($, on) => {
    const noKey = JSON.stringify({ cwd: ROOT, line: 'off: add an OpenRouter or TypeSafe key in /plugin > Installed > md-scrub > Configure' })
    fakeFiles(on, project({ [`${STATE}/setup.json`]: noKey }), new Map())
    const done: string[] = []
    on('ui.close', (_$, e) => { done.push(`close ${e.id}`); return { value: undefined } })
    on('command.run', (_$, e) => { done.push(`/${e.command}`); return {} })
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    expect(await ui.find({ text: /add a Jev key/ })).toBeDefined()
    await ui.press({ key: 'key' })
    expect(done).toEqual(['close md-scrub', '/plugin'])
  })

  test(`${surface}: a key added since start-up turns the header on and names the model and service, with no k`, { options: { typesafe_api_key: 'set' } }, async ($, on) => {
    const noKey = JSON.stringify({ cwd: ROOT, line: 'off: add an OpenRouter or TypeSafe key in /plugin > Installed > md-scrub > Configure' })
    fakeFiles(on, project({ [`${STATE}/setup.json`]: noKey }), new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    expect(await ui.find({ text: /^on$/ })).toBeDefined()
    expect(await ui.find({ text: 'jev-1.13.0 · TypeSafe · v9.8.7' })).toBeDefined()
    expect(await ui.find({ key: 'key' })).toBeUndefined()
  })

  test(`${surface}: a topic whose model ID is for the other service is an error`, { options: { openrouter_api_key: 'set' } }, async ($, on) => {
    fakeFiles(on, project({ [`${USER}/topics/advice.json`]: advice({ model: 'jev-1.14.0' }) }), new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    expect(await ui.find({ text: /1 topic has an error/ })).toBeDefined()
    expect(await ui.find({ text: '✕' })).toBeDefined()
  })

  test(`${surface}: a topic whose model ID fits the service is fine`, { options: { openrouter_api_key: 'set' } }, async ($, on) => {
    fakeFiles(on, project({ [`${USER}/topics/advice.json`]: advice({ model: 'typesafe/jev-1.14', flag: 0.35 }) }), new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    expect(await ui.find({ text: /topic has an error/ })).toBeUndefined()
  })

  test(`${surface}: the log shows only this project, says what a row means and counts the rest`, async ($, on) => {
    const log = [
      { t: '2026-10-11T03:00:00Z', event: 'action', action: 'flagged', file: `${ROOT}/vendor-terms.md`, topics: ['third-party-terms'], reason: 'mostly', share: 96 },
      { t: '2026-10-11T03:01:00Z', event: 'action', action: 'scrubbed', file: '/elsewhere/notes.md', topics: ['third-party-terms'], edits: 1 },
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    fakeFiles(on, project({ [`${STATE}/log.jsonl`]: log }), new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'tab:log' })
    expect(await ui.find({ text: /vendor-terms\.md/ })).toBeDefined()
    expect(await ui.find({ text: /notes\.md/ })).toBeUndefined()
    expect(await ui.find({ text: /1 more row in other projects/ })).toBeDefined()
    expect(await ui.find({ text: /Mostly Third-party legal terms \(96%\)/ })).toBeDefined()
  })

  test(`${surface}: an open panel shows new log rows without a key press`, async ($, on) => {
    const line = (file: string) => JSON.stringify({ t: '2026-10-11T03:00:00Z', event: 'action', action: 'scrubbed', file: `${ROOT}/${file}` }) + '\n'
    const files = project({ [`${STATE}/log.jsonl`]: line('first.md') })
    const clock = fakeFiles(on, files, new Map())
    const ui = await $.ui.mount({ plugin: 'md-scrub', surface, component: 'Pane', props: PANE_PROPS, requestId: 'md-scrub' })
    await ui.press({ key: 'tab:log' })
    await clock.advance(2000)
    files.set(`${STATE}/log.jsonl`, line('first.md') + line('second.md'))
    expect(await ui.find({ text: /second\.md/ })).toBeUndefined()
    await clock.advance(2000)
    expect(await ui.find({ text: /second\.md/ })).toBeDefined()
  })

}

test('/md-scrub exclude takes a path and --user', () => {
  expect(parseExclude('exclude docs/')).toEqual({ pattern: 'docs/', scope: 'project' })
  expect(parseExclude('exclude --user *.draft.md')).toEqual({ pattern: '*.draft.md', scope: 'user' })
  expect(parseExclude(' exclude ')).toEqual({ pattern: '', scope: 'project' })
  expect(parseExclude('')).toBeUndefined()
})

// Focusing the new cell needs a drawn panel, which the kit's ui.open doesn't make: checked on screen.
test('/md-scrub exclude adds to the project, or User with --user, and opens the panel', async ($, on) => {
  const writes = new Map<string, string>()
  fakeFiles(on, project({ [`${PROJECT}/exclusions`]: '# ours\nlegal/\n' }), writes)
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'md-scrub', args: 'exclude docs/' })
  expect(writes.get(`${PROJECT}/exclusions`)).toBe('# ours\nlegal/\ndocs/\n')
  await $.command.run({ command: 'md-scrub', args: 'exclude notes/ --user' })
  expect(writes.get(`${USER}/exclusions`)).toBe('notes/\n')
  expect((await $.command.run({ command: 'md-scrub', args: 'exclude' })).text).toContain('Usage: /md-scrub exclude')
})

test('the typeahead after /md-scrub exclude offers folders and Markdown files, and --user', async () => {
  const tree: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    [ROOT]: [{ name: 'docs', kind: 'dir' }, { name: 'node_modules', kind: 'dir' }, { name: 'app.ts', kind: 'file' }],
    [`${ROOT}/docs`]: [{ name: 'maps.md', kind: 'file' }],
  }
  const list = async (dir: string) => tree[dir] ?? []
  const at = (text: string) => { const start = text.lastIndexOf(' ') + 1; return [text, text.slice(start), start] as const }
  const rows = async (text: string) => (await excludeRows(list, ROOT, ...at(text))).map(r => r.text)
  expect(await rows('/md-scrub exclude do')).toEqual(['docs/'])
  expect(await rows('/md-scrub exclude docs/')).toEqual(['docs/maps.md'])
  expect(await rows('/md-scrub exclude --u')).toEqual(['--user'])
  expect(await rows('please exclude do')).toEqual([])
})

test('the log collapses the same action on the same file within a minute', () => {
  const line = (t: string, action: string, file = '/p/a.md') => JSON.stringify({ t, event: 'action', action, file })
  const text = [
    line('2026-10-11T03:00:00Z', 'flagged'),
    line('2026-10-11T03:00:20Z', 'flagged'),
    line('2026-10-11T03:00:40Z', 'flagged'),
    line('2026-10-11T03:05:00Z', 'flagged'),
    line('2026-10-11T03:05:10Z', 'scrubbed'),
  ].join('\n')
  expect(logActions(text).map(e => `${e.t.slice(11, 16)} ${e.action}`)).toEqual(['03:05 scrubbed', '03:05 flagged', '03:00 flagged'])
})
