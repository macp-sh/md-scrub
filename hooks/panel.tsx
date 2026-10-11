import type { EngineInterface, On, Register } from 'claude-code'

// The /md-scrub panel: whether md-scrub is working (header), what it looks for (Topics), where it
// doesn't look (Exclusions) and what it did (Log). Settings are plain files, read and written here:
//   built in:  <plugin>/defaults/config.json, defaults/topics/*.json
//   user:      ~/.claude/md-scrub/config.json, topics/*.json, exclusions
//   project:   <project root>/.claude/md-scrub/ (same layout)
//   state:     ~/.claude/md-scrub/state/log.jsonl, setup.json (written by the hooks)

const PANE = 'md-scrub'
const SCOPES = ['user', 'project'] as const
type Scope = (typeof SCOPES)[number]
type Tab = 'topics' | 'exclusions' | 'log'

export type Topic = {
  id: string
  name: string
  description: string
  builtIn: boolean
  def: boolean // on unless a scope says otherwise
  file?: string // the file a person edits: a custom topic's, or a user copy of a built-in one
  error?: string
}
export type Settings = { user: Record<string, unknown>; project: Record<string, unknown> }
export type LogEntry = { t: string; event: string; action?: string; file?: string; reason?: string }
export type Header = { state: 'on' | 'off' | 'paused'; reason?: string; warning?: string }

// ---------- pure helpers (tested) ----------

export const parseJson = (text: string): Record<string, unknown> => {
  const v = JSON.parse(text)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('expected an object')
  return v as Record<string, unknown>
}

/** A topic's setting in one scope's config: true, false, or undefined when not set. */
export function topicSetting(config: Record<string, unknown>, id: string): boolean | undefined {
  const v = (config.topics as Record<string, { enabled?: unknown }> | undefined)?.[id]?.enabled
  return typeof v === 'boolean' ? v : undefined
}

/** Returns the config text with `topics.<id>.enabled` set, or removed for undefined. */
export function withTopicSetting(config: Record<string, unknown>, id: string, value: boolean | undefined): string {
  const next = structuredClone(config)
  const topics = { ...((next.topics as Record<string, Record<string, unknown>>) ?? {}) }
  const entry = { ...(topics[id] ?? {}) }
  if (value === undefined) delete entry.enabled
  else entry.enabled = value
  if (Object.keys(entry).length) topics[id] = entry
  else delete topics[id]
  if (Object.keys(topics).length) next.topics = topics
  else delete next.topics
  return JSON.stringify(next, null, 2) + '\n'
}

/** Project beats user beats the topic's default. */
export const effective = (t: Topic, s: Settings): boolean =>
  topicSetting(s.project, t.id) ?? topicSetting(s.user, t.id) ?? t.def

/** The next value of a cell: not set, then on, then off. */
export const cycle = (v: boolean | undefined): boolean | undefined => (v === undefined ? true : v ? false : undefined)

/** Patterns in an exclusions file: one per line, blank lines and # comments skipped. */
export const patterns = (text: string): string[] =>
  text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

/** The exclusions file with `pattern` added or removed, comments and order kept. */
export function withPattern(text: string, pattern: string, present: boolean): string {
  const lines = text ? text.replace(/\n$/, '').split('\n') : []
  const has = lines.some(l => l.trim() === pattern)
  if (present && !has) lines.push(pattern)
  if (!present) return lines.filter(l => l.trim() !== pattern).join('\n') + (lines.length ? '\n' : '')
  return lines.join('\n') + '\n'
}

/** The action entries of log.jsonl, newest first, `clean` ones left out. */
export function logActions(text: string, limit = 50): LogEntry[] {
  const out: LogEntry[] = []
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue
    let e: LogEntry
    try { e = JSON.parse(line) } catch { continue }
    if (e.event !== 'action' || !e.file || e.action === 'clean') continue
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}

/** Paused when the most recent Jev or action entry, within ten minutes, is an unchecked write. */
export function isPaused(text: string, now: number): boolean {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: LogEntry
    try { e = JSON.parse(lines[i]!) } catch { continue }
    if (e.event !== 'jev' && e.event !== 'action') continue
    return e.event === 'action' && e.action === 'unchecked' && now - Date.parse(e.t) < 10 * 60 * 1000
  }
  return false
}

/** What the header says, from setup.json (the start-up check) and the log. */
export function header(setup: { cwd?: string | null; line?: string | null } | undefined, root: string, paused: boolean): Header {
  const line = setup?.line && (!setup.cwd || setup.cwd === root) ? setup.line : undefined
  const off = line?.match(/^(off|not running): (.*)$/)
  if (off) return { state: 'off', reason: off[2] }
  if (paused) return { state: 'paused', reason: "OpenRouter isn't responding", warning: line }
  return { state: 'on', warning: line }
}

/** True when `file` (relative to the project) is covered by one of the patterns. */
export function isExcluded(file: string, list: string[]): boolean {
  return list.some(p => {
    if (p.endsWith('/')) return file.startsWith(p) || file.includes('/' + p)
    if (!p.includes('*')) return file === p || file.endsWith('/' + p)
    const re = new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
    return re.test(file) || re.test(file.split('/').pop() ?? '')
  })
}

export const relative = (file: string, root: string) => (file.startsWith(root + '/') ? file.slice(root.length + 1) : file)
const tilde = (path: string, home: string) => (path.startsWith(home + '/') ? '~' + path.slice(home.length) : path)
const parent = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : undefined)
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.venv', 'target'])

// ---------- loading ----------

type Paths = { home: string; root: string; user: string; project: string; builtIn: string; state: string; projectName: string }
type Data = { topics: Topic[]; settings: Settings; exclusions: Record<Scope, string[]>; log: LogEntry[]; header: Header; logError?: string }

async function paths($: EngineInterface): Promise<Paths> {
  const home = (await $.env.get('HOME')) ?? ''
  const root = await $.session.root()
  return {
    home, root,
    user: `${home}/.claude/md-scrub`,
    project: `${root}/.claude/md-scrub`,
    builtIn: `${$.plugin.root}/defaults`,
    state: `${home}/.claude/md-scrub/state`,
    projectName: root.split('/').filter(Boolean).pop() ?? 'project',
  }
}

const readText = ($: EngineInterface, path: string) => $.fs.read(path).catch(() => '')
async function readConfig($: EngineInterface, path: string): Promise<Record<string, unknown>> {
  const text = await readText($, path)
  try { return text.trim() ? parseJson(text) : {} } catch { return {} }
}
async function topicFiles($: EngineInterface, dir: string): Promise<string[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  return entries.filter(e => e.kind === 'file' && e.name.endsWith('.json')).map(e => e.name.slice(0, -5)).sort()
}

async function load($: EngineInterface, p: Paths): Promise<Data> {
  const builtInConfig = await readConfig($, `${p.builtIn}/config.json`)
  const byId = new Map<string, Topic>()
  for (const [layer, dir] of [['builtIn', `${p.builtIn}/topics`], ['user', `${p.user}/topics`], ['project', `${p.project}/topics`]] as const) {
    for (const id of await topicFiles($, dir)) {
      const file = `${dir}/${id}.json`
      const t = byId.get(id) ?? { id, name: id, description: '', builtIn: layer === 'builtIn', def: true }
      if (layer === 'builtIn') t.def = topicSetting(builtInConfig, id) ?? true
      else t.file = file
      try {
        const json = parseJson(await $.fs.read(file))
        if (typeof json.name === 'string') t.name = json.name
        if (typeof json.description === 'string') t.description = json.description
      } catch (err) {
        t.error = `${tilde(file, p.home)}: ${(err as Error).message}`
      }
      byId.set(id, t)
    }
  }
  const settings = { user: await readConfig($, `${p.user}/config.json`), project: await readConfig($, `${p.project}/config.json`) }
  const exclusions = {
    user: patterns(await readText($, `${p.user}/exclusions`)),
    project: patterns(await readText($, `${p.project}/exclusions`)),
  }
  let logText = ''
  let logError: string | undefined
  try { logText = await $.fs.read(`${p.state}/log.jsonl`) } catch (err) {
    if (await $.fs.exists(`${p.state}/log.jsonl`)) logError = 'The log is too large to read here.'
  }
  let setup: { cwd?: string | null; line?: string | null } | undefined
  try { setup = parseJson(await $.fs.read(`${p.state}/setup.json`)) as typeof setup } catch {}
  return {
    topics: [...byId.values()],
    settings,
    exclusions,
    log: logActions(logText),
    header: header(setup, p.root, isPaused(logText, await $.clock.now())),
    logError,
  }
}

// ---------- view state (module-level: a reload starts it afresh) ----------

let tab: Tab = 'topics'
let focused: string | undefined
let adding: { query: string; target: Scope; suggestions: string[] } | undefined
let choice: { row: number; options: string[] } | undefined
let cache: { p: Paths; data: Data } | undefined

// Every draw reads the files afresh (they're small), so edits made elsewhere show too; actions
// use what the last draw read.
function refresh($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

async function suggest($: EngineInterface, root: string, query: string): Promise<string[]> {
  const dir = query.includes('/') ? query.slice(0, query.lastIndexOf('/') + 1) : ''
  const rest = query.slice(dir.length).toLowerCase()
  const entries = await $.fs.list(dir ? `${root}/${dir}` : root).catch(() => [])
  return entries
    .filter(e => !SKIP.has(e.name) && !e.name.startsWith('.') && (e.kind === 'dir' || e.name.endsWith('.md')))
    .filter(e => e.name.toLowerCase().startsWith(rest))
    .map(e => dir + e.name + (e.kind === 'dir' ? '/' : ''))
    .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))
    .slice(0, 6)
}

const selectedTopic = (d: Data) => {
  const id = focused?.startsWith('t:') ? focused.split(':')[1] : undefined
  return d.topics.find(t => t.id === id) ?? d.topics[0]
}

// ---------- actions ----------

async function setTopic($: EngineInterface, id: string, scope: Scope) {
  if (!cache) return
  const { p, data } = cache
  const path = `${scope === 'user' ? p.user : p.project}/config.json`
  const text = await readText($, path)
  let config: Record<string, unknown>
  try { config = text.trim() ? parseJson(text) : {} } catch {
    $.ui.toast(`md-scrub: ${tilde(path, p.home)} isn't valid JSON; fix it first`)
    return
  }
  await $.fs.write(path, withTopicSetting(config, id, cycle(topicSetting(data.settings[scope], id))))
  refresh($)
}

async function setPattern($: EngineInterface, pattern: string, scope: Scope, present: boolean) {
  if (!cache || !pattern) return
  const path = `${scope === 'user' ? cache.p.user : cache.p.project}/exclusions`
  await $.fs.write(path, withPattern(await readText($, path), pattern, present))
  refresh($)
}

async function openFile($: EngineInterface, path: string) {
  try { await $.process.run(['open', path]) } catch {
    await $.process.run(['xdg-open', path]).catch(() => $.ui.toast(`md-scrub: open ${path} yourself`))
  }
}

async function copyTopic($: EngineInterface, t: Topic) {
  if (!cache || !t.builtIn || t.file) return
  const target = `${cache.p.user}/topics/${t.id}.json`
  await $.fs.write(target, await $.fs.read(`${cache.p.builtIn}/topics/${t.id}.json`))
  refresh($)
  await openFile($, target)
}

// ---------- drawing ----------

const Glyph = { on: '●', off: '○', unset: '·' }
const glyph = (v: boolean | undefined) => (v === undefined ? Glyph.unset : v ? Glyph.on : Glyph.off)

// status.ts's session.start hook registers the /md-scrub command (a module takes one unmatched hook per
// event, and $ can't be passed across files); `register` below does it when this module loads alone.
export function registerPanel(on: On) {

  on('command.run', { command: 'md-scrub' }, async $ => {
    tab = 'topics'; adding = undefined; choice = undefined; focused = undefined
    await $.ui.open({ id: PANE, title: 'md-scrub', focus: true, closeOnEscape: true })
    return {}
  })

  // Display only: if tracking the focus fails, the move goes ahead.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    focused = e.element
    $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined // mobile draws no text field
    const p = await paths($)
    cache = { p, data: await load($, p) }
    const { data } = cache
    const hd = data.header // not `h`: that's the JSX factory
    const width = Math.max(40, e.props.bodyColumns)
    const nameWidth = Math.min(40, width - 22)

    const head = (
      <Box flexDirection="row">
        <Text bold color="claude">md-scrub</Text>
        <Text> · </Text>
        <Text color={hd.state === 'on' ? 'success' : hd.state === 'paused' ? 'warning' : 'error'}>{hd.state}</Text>
        {hd.reason ? <Text dimColor> · {hd.reason}</Text> : null}
        {hd.warning ? <Text color="warning"> · {hd.warning}</Text> : null}
      </Box>
    )
    const tabs = (
      <Box flexDirection="row" gap={3} marginTop={1}>
        {(['topics', 'exclusions', 'log'] as const).map((t, i) => (
          <Button key={`tab:${t}`} plain hotkey={String(i + 1)} dimColor={t !== tab}
            onPress={() => { tab = t; adding = undefined; choice = undefined; $.ui.invalidate('ui.render') }}>
            {t === 'topics' ? 'Topics' : t === 'exclusions' ? 'Exclusions' : 'Log'}
          </Button>
        ))}
      </Box>
    )
    const columns = (
      <Box flexDirection="row">
        <Box width={nameWidth}><Text> </Text></Box>
        <Box width={9} justifyContent="center"><Text dimColor>User</Text></Box>
        <Box width={Math.max(9, p.projectName.length + 2)} justifyContent="center"><Text dimColor>{p.projectName}</Text></Box>
      </Box>
    )

    let body
    let foot: string[] = []
    if (tab === 'topics') {
      const sel = selectedTopic(data)
      body = (
        <Box flexDirection="column">
          {columns}
          {data.topics.map(t => {
            const active = !t.error && effective(t, data.settings)
            return (
              <Box key={`row:${t.id}`} flexDirection="row">
                <Box width={nameWidth}>
                  <Text dimColor={!active} wrap="truncate">{t.error ? <Text color="error">✕</Text> : <Text color={active ? 'success' : undefined}>{active ? Glyph.on : Glyph.off}</Text>} {t.name}</Text>
                </Box>
                {SCOPES.map(s => (
                  <Box width={s === 'user' ? 9 : Math.max(9, p.projectName.length + 2)} justifyContent="center">
                    <Button key={`t:${t.id}:${s}`} plain dimColor={topicSetting(data.settings[s], t.id) === undefined}
                      label={glyph(topicSetting(data.settings[s], t.id))}
                      onPress={() => { if (!t.error) void setTopic($, t.id, s) }} />
                  </Box>
                ))}
              </Box>
            )
          })}
          <Box flexDirection="column" marginTop={1}>
            {sel?.error ? <Text color="error">{sel.error}</Text> : <Text dimColor>{sel?.description}</Text>}
            {sel && !sel.error ? (
              <Text color="subtle">{sel.file ? tilde(sel.file, p.home) : 'built into md-scrub · c copies it to your topics to edit'}</Text>
            ) : null}
          </Box>
        </Box>
      )
      foot = ['o', 'c']
    } else if (tab === 'exclusions') {
      const all = [...new Set([...data.exclusions.user, ...data.exclusions.project])]
      body = (
        <Box flexDirection="column">
          {columns}
          {all.length === 0 && !adding ? <Text dimColor>No exclusions.</Text> : null}
          {all.map(x => (
            <Box key={`xrow:${x}`} flexDirection="row">
              <Box width={nameWidth}><Text wrap="truncate">{x}</Text></Box>
              {SCOPES.map(s => {
                const present = data.exclusions[s].includes(x)
                return (
                  <Box width={s === 'user' ? 9 : Math.max(9, p.projectName.length + 2)} justifyContent="center">
                    <Button key={`x:${x}:${s}`} plain dimColor={!present} label={present ? Glyph.on : Glyph.unset}
                      onPress={() => void setPattern($, x, s, !present)} />
                  </Box>
                )
              })}
            </Box>
          ))}
          {adding && Input ? (
            <Box flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={2}>
                <Input key="add" autoFocus label="Exclude" placeholder="path, folder/ or *.md" value={adding.query} submitLabel="add"
                  onInput={async (value: string) => {
                    if (!adding || !cache) return
                    adding.query = value
                    adding.suggestions = await suggest($, cache.p.root, value)
                    $.ui.invalidate('ui.render')
                  }}
                  onSubmit={(value: string) => {
                    const target = adding?.target ?? 'project'
                    adding = undefined
                    void setPattern($, value.trim(), target, true)
                  }} />
                <Button key="target" plain dimColor
                  onPress={() => { if (adding) { adding.target = adding.target === 'project' ? 'user' : 'project'; $.ui.invalidate('ui.render') } }}>
                  for {adding.target === 'project' ? p.projectName : 'User'}
                </Button>
              </Box>
              {adding.suggestions.map(s => (
                <Button key={`s:${s}`} plain dimColor onPress={() => { const target = adding?.target ?? 'project'; adding = undefined; void setPattern($, s, target, true) }}>
                  {'  ' + s}
                </Button>
              ))}
            </Box>
          ) : null}
        </Box>
      )
      foot = ['a']
    } else {
      body = (
        <Box flexDirection="column">
          {data.logError ? <Text dimColor>{data.logError}</Text> : null}
          {!data.logError && data.log.length === 0 ? <Text dimColor>Nothing scrubbed or flagged yet.</Text> : null}
          {data.log.map((r, i) => {
            const file = relative(r.file ?? '', p.root)
            const excluded = isExcluded(file, [...data.exclusions.user, ...data.exclusions.project])
            const d = new Date(r.t)
            const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
            const colour = r.action === 'scrubbed' ? 'claude' : r.action === 'flagged' || r.action === 'unchecked' ? 'warning' : undefined
            return (
              <Box key={`lrow:${i}`} flexDirection="column">
                <Button key={`l:${i}`} plain onPress={() => { choice = { row: i, options: [file, parent(file)].filter((x): x is string => !!x) }; $.ui.invalidate('ui.render') }}>
                  <Text dimColor>{time}  </Text><Text color={colour}>{(r.action ?? '').padEnd(10)}</Text>{file}{excluded ? <Text dimColor> · excluded</Text> : null}
                </Button>
                {choice?.row === i ? (
                  <Box flexDirection="row" gap={2} marginLeft={8}>
                    <Text dimColor>Exclude for {p.projectName}:</Text>
                    {choice.options.map((o, k) => (
                      <Button key={`e:${k}`} plain autoFocus={k === choice!.options.length - 1 ? true : undefined}
                        onPress={() => { choice = undefined; void setPattern($, o, 'project', true) }}>{o}</Button>
                    ))}
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      )
      foot = ['e']
    }

    const sel = selectedTopic(data)
    const actions = (
      <Box flexDirection="row" gap={2} marginTop={1}>
        {foot.includes('o') ? <Button key="open" plain hotkey="o" dimColor onPress={() => { if (sel?.file) void openFile($, sel.file) }}>open</Button> : null}
        {foot.includes('c') ? <Button key="copy" plain hotkey="c" dimColor onPress={() => { if (sel) void copyTopic($, sel) }}>copy to edit</Button> : null}
        {foot.includes('a') ? <Button key="addx" plain hotkey="a" dimColor
          onPress={async () => { adding = { query: '', target: 'project', suggestions: cache ? await suggest($, cache.p.root, '') : [] }; $.ui.invalidate('ui.render') }}>add</Button> : null}
        {foot.includes('e') ? <Button key="exclude" plain hotkey="e" dimColor
          onPress={() => {
            const i = focused?.startsWith('l:') ? Number(focused.slice(2)) : 0
            const r = data.log[i]
            if (!r) return
            const file = relative(r.file ?? '', p.root)
            choice = { row: i, options: [file, parent(file)].filter((x): x is string => !!x) }
            $.ui.invalidate('ui.render')
          }}>exclude</Button> : null}
        <Text dimColor>· enter switches · esc closes</Text>
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        {head}
        {tabs}
        <Box flexDirection="column" marginTop={1}>{body}</Box>
        {actions}
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    adding = undefined; choice = undefined; cache = undefined
    return next(e)
  }).catch(($, e, next) => next(e))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'md-scrub', description: 'Choose what md-scrub checks and see what it did' })
    return next(e)
  })
  registerPanel(on)
}
