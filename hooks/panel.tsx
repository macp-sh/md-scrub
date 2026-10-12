import type { EngineInterface, On, PluginOptions, Register, RenderChildren, RenderElement } from 'claude-code'

// The /md-scrub panel: whether md-scrub is working (header), what it looks for (Topics), where it
// doesn't look (Exclusions) and what it did (Log). Settings are plain files, read and written here:
//   built in:  <plugin>/defaults/config.json, defaults/topics/*.json
//   user:      ~/.claude/md-scrub/config.json, topics/*.json, exclusions
//   project:   <project root>/.claude/md-scrub/ (same layout)
//   state:     ~/.claude/md-scrub/state/log.jsonl, setup.json (written by the hooks)

const PANE = 'md-scrub'
// The start-up check's line when md-scrub is off for want of an OpenRouter key (src/hooks.ts).
const NEEDS_KEY = /OpenRouter key/
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
export type LogEntry = { t: string; event: string; action?: string; file?: string; reason?: string; topics?: string[]; edits?: number; share?: number }
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

/** What a scope follows while it doesn't set the topic: the project follows the user, then the
 *  default; the user follows the default. */
export const inherited = (t: Topic, s: Settings, scope: Scope): boolean =>
  (scope === 'project' ? topicSetting(s.user, t.id) : undefined) ?? t.def

/** What a cell shows: its scope's setting, else what it inherits. */
export const shown = (t: Topic, s: Settings, scope: Scope): boolean => topicSetting(s[scope], t.id) ?? inherited(t, s, scope)

/** The setting a cell's press saves: the opposite of what it shows, or none when that is what it
 *  inherits anyway, so a scope keeps only what differs from the one beneath it. */
export const flipped = (t: Topic, s: Settings, scope: Scope): boolean | undefined => {
  const next = !shown(t, s, scope)
  return next === inherited(t, s, scope) ? undefined : next
}

/** Patterns in an exclusions file: one per line, blank lines and # comments skipped. */
export const patterns = (text: string): string[] =>
  text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

/** The exclusions file with `pattern` added or removed, comments and order kept. */
export function withPattern(text: string, pattern: string, present: boolean): string {
  const lines = text ? text.replace(/\n$/, '').split('\n') : []
  const has = lines.some(l => l.trim() === pattern)
  if (present && !has) lines.push(pattern)
  if (!present) {
    const kept = lines.filter(l => l.trim() !== pattern)
    return kept.length ? kept.join('\n') + '\n' : ''
  }
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
    const prev = out[out.length - 1]
    if (prev && prev.file === e.file && prev.action === e.action && Math.abs(Date.parse(prev.t) - Date.parse(e.t)) < 60_000) continue
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}

/** This project's log rows, paths made relative, and how many rows belong to other projects. The
 *  log is shared by every project; `roots` is the project root as given and as resolved, since a hook
 *  may record either (`/tmp` and `/private/tmp` on macOS). */
export function projectLog(entries: LogEntry[], roots: string[], limit = 50): { rows: LogEntry[]; others: number } {
  const rows: LogEntry[] = []
  let others = 0
  for (const e of entries) {
    const root = roots.find(r => e.file?.startsWith(r + '/'))
    if (!root) { others++; continue }
    if (rows.length < limit) rows.push({ ...e, file: e.file!.slice(root.length + 1) })
  }
  return { rows, others }
}

/** One line on what a log row means, topics named by `name`. */
export function logDetail(e: LogEntry, name: (id: string) => string): string {
  const topics = (e.topics ?? []).map(name).join(', ')
  if (e.action === 'scrubbed') return `${topics || 'Scrubbed'}${e.edits ? ` · ${e.edits} ${e.edits === 1 ? 'edit' : 'edits'}` : ''}`
  if (e.action === 'flagged' && e.reason === 'mostly') return `Mostly ${topics || 'unwanted'}${e.share ? ` (${e.share}%)` : ''}; saved as written for you to review`
  if (e.action === 'flagged' && e.reason === 'clean-up failed') return `${topics ? topics + '; ' : ''}the clean-up failed, so it was saved as written`
  if (e.action === 'flagged') return `${topics ? topics + '; ' : ''}saved as written for you to review`
  if (e.action === 'unchecked') return `Not checked${e.reason ? `: ${e.reason}` : ''}`
  return e.action ?? ''
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
export function header(setup: { cwd?: string | null; line?: string | null } | undefined, root: string, paused: boolean, hasKey = false): Header {
  let line = setup?.line && (!setup.cwd || setup.cwd === root) ? setup.line : undefined
  // The start-up check found no key, but one has been added since: the hooks read it on their next run.
  if (hasKey && line && NEEDS_KEY.test(line)) line = undefined
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
const folderOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '')
const nameOf = (f: string) => f.slice(f.lastIndexOf('/') + 1)
const tilde = (path: string, home: string) => (path.startsWith(home + '/') ? '~' + path.slice(home.length) : path)
const parent = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : undefined)
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.venv', 'target'])

// ---------- loading ----------

type Paths = { home: string; root: string; user: string; project: string; builtIn: string; state: string; projectName: string }
type Data = { version?: string; topics: Topic[]; settings: Settings; exclusions: Record<Scope, string[]>; log: LogEntry[]; otherLog: number; header: Header; logError?: string }

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
  const real = await $.fs.stat(p.root, { resolve: true }).then(s => s.realPath).catch(() => undefined)
  const log = projectLog(logActions(logText, Infinity), [...new Set([p.root, ...(real ? [real] : [])])])
  const manifest = await readConfig($, `${$.plugin.root}/.claude-plugin/plugin.json`)
  return {
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    topics: [...byId.values()],
    settings,
    exclusions,
    log: log.rows,
    otherLog: log.others,
    header: header(setup, p.root, isPaused(logText, await $.clock.now()), hasKey),
    logError,
  }
}

// ---------- view state (module-level: a reload starts it afresh) ----------

let tab: Tab = 'topics'
let focused: string | undefined
// Whether the plugin's OpenRouter key option is set, from the options it loaded with (a change in
// /plugin reloads it). Only its presence is read; the value never reaches the panel.
let hasKey = false
let adding: { query: string; target: Scope; suggestions: string[] } | undefined
let choice: { row: number; options: string[] } | undefined
let cache: { p: Paths; data: Data } | undefined
// A problem with the last action. Shown in the panel, since the pane holds toasts while it's open.
let message: string | undefined
// The open panel's log watch, and the log's size and time when it last looked.
let ticker: { cancel: () => void } | undefined
let logStamp = ''

// Every draw reads the files afresh (they're small), so edits made elsewhere show too; actions
// use what the last draw read.
function refresh($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

function say($: EngineInterface, text: string) {
  message = text
  refresh($)
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
  const row = focusedRow()
  const id = row?.startsWith('t:') ? row.slice(2) : undefined
  return d.topics.find(t => t.id === id) ?? d.topics[0]
}

// ---------- actions ----------

async function setTopic($: EngineInterface, id: string, scope: Scope) {
  if (!cache) return
  message = undefined
  const { p, data } = cache
  const path = `${scope === 'user' ? p.user : p.project}/config.json`
  const text = await readText($, path)
  let config: Record<string, unknown>
  try { config = text.trim() ? parseJson(text) : {} } catch {
    say($, `${tilde(path, p.home)} isn't valid JSON; fix it first.`)
    return
  }
  const t = data.topics.find(t => t.id === id)
  if (!t) return
  await $.fs.write(path, withTopicSetting(config, id, flipped(t, data.settings, scope)))
  refresh($)
}

async function setPattern($: EngineInterface, pattern: string, scope: Scope, present: boolean) {
  if (!cache || !pattern) return
  message = undefined
  const path = `${scope === 'user' ? cache.p.user : cache.p.project}/exclusions`
  await $.fs.write(path, withPattern(await readText($, path), pattern, present))
  refresh($)
}

async function openFile($: EngineInterface, path: string) {
  try { await $.process.run(['open', path]) } catch {
    await $.process.run(['xdg-open', path]).catch(() => say($, `Couldn't open ${path}; open it yourself.`))
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
// Rows the body keeps even when its list is short, the same on every tab so switching doesn't jump:
// at least the first, up to the second where the terminal has room. The rest of the panel (header,
// rules, tabs, legend and margins) takes CHROME_ROWS.
const BODY_ROWS = [12, 18] as const
const CHROME_ROWS = 8
// md-scrub's own colours; Claude Code's theme colours are kept for what they already mean (success,
// error, warning).
const ORANGE = '#d97757'
const SELECTED = '#3a3835'
const TABS = [['topics', 'Topics'], ['exclusions', 'Exclusions'], ['log', 'Log']] as const
const TAB_GAP = 3
// How often an open panel looks for new log rows.
const LOG_POLL_MS = 2000
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const glyph = (v: boolean | undefined) => (v === undefined ? Glyph.unset : v ? Glyph.on : Glyph.off)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// The row the focus is on, from the key of the Button holding it. In Topics and Exclusions the scope
// cells are the stops, keyed `<scope>@<row key>`: the arrows walk them in order (User, then the
// project, then the next row) and Enter or a click changes the one under the focus.
const focusedRow = () => (focused?.includes('@') ? focused.slice(focused.indexOf('@') + 1) : undefined)
const focusedPattern = () => (focusedRow()?.startsWith('x:') ? focusedRow()!.slice(2) : undefined)
const focusedLog = () => (focused?.startsWith('l:') ? Number(focused.slice(2)) : focused?.startsWith('e:') ? choice?.row : undefined)

// While the panel is open, redraws when the log changes, so new rows show without a key press.
function watchLog($: EngineInterface) {
  ticker = $.clock.every(LOG_POLL_MS, async () => {
    if (!cache) return
    const s = await $.fs.stat(`${cache.p.state}/log.jsonl`).catch(() => undefined)
    const stamp = s ? `${s.size}:${s.mtimeMs}` : ''
    if (stamp === logStamp) return
    logStamp = stamp
    refresh($)
  })
}

// status.ts's session.start hook registers the /md-scrub command (a module takes one unmatched hook per
// event, and $ can't be passed across files); `register` below does it when this module loads alone.
export function registerPanel(on: On, options: PluginOptions = {}) {
  hasKey = typeof options.openrouter_api_key === 'string' && options.openrouter_api_key !== ''

  on('command.run', { command: 'md-scrub' }, async $ => {
    tab = 'topics'; adding = undefined; choice = undefined; focused = undefined; message = undefined
    // Opened as a dialog: the arrows walk its buttons (otherwise they scroll) and Esc closes it.
    await $.ui.open({ id: PANE, title: 'md-scrub', focus: true, closeOnEscape: true, holdToasts: true })
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
    if (!ticker) watchLog($)
    const { data } = cache
    const hd = data.header // not `h`: that's the JSX factory
    const width = Math.max(40, e.props.bodyColumns)
    // The scope columns start just after the longest name.
    const longest = Math.max(12, ...data.topics.map(t => t.name.length + 2), ...data.exclusions.user.map(x => x.length), ...data.exclusions.project.map(x => x.length))
    const nameWidth = Math.min(longest + 5, 44, width - 22)
    const scopeWidth = (s: Scope) => (s === 'user' ? 9 : Math.max(9, p.projectName.length + 2))
    const rule = <Text dimColor>{'─'.repeat(width)}</Text>
    const broken = data.topics.filter(t => t.error).length
    const topicName = (id: string) => sentence(data.topics.find(t => t.id === id)?.name ?? id)

    const bodyRows = Math.max(BODY_ROWS[0], Math.min(BODY_ROWS[1], e.props.scroll.bodyRows - CHROME_ROWS))
    const head = (
      <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" flexShrink={1} flexWrap="wrap">
        <Text bold color={ORANGE}>md-scrub</Text>
        <Text> · </Text>
        <Text color={hd.state === 'on' ? 'success' : hd.state === 'paused' ? 'warning' : 'error'}>{hd.state}</Text>
        {hd.reason ? <Text dimColor> · {hd.reason}</Text> : null}
        {hd.warning ? <Text color="warning"> · {hd.warning}</Text> : null}
        {!hd.warning && hd.state !== 'off' && broken ? <Text color="error"> · {plural(broken, 'topic has an error', 'topics have errors')}</Text> : null}
      </Box>
      {data.version ? <Box marginLeft={2}><Text dimColor>v{data.version}</Text></Box> : null}
      </Box>
    )
    // Each tab is drawn `1: Topics`; the bar beneath the current one spans the same cells.
    const tabWidth = (label: string) => label.length + 3
    const tabs = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={TAB_GAP}>
          {TABS.map(([t, label], i) => (
            <Box width={tabWidth(label)}>
              <Button key={`tab:${t}`} plain hotkey={String(i + 1)} dimColor={t !== tab}
                onPress={() => { tab = t; adding = undefined; choice = undefined; message = undefined; $.ui.invalidate('ui.render') }}>
                <Text bold={t === tab}>{label}</Text>
              </Button>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" gap={TAB_GAP}>
          {TABS.map(([t, label]) => (
            <Box width={tabWidth(label)}><Text color={ORANGE}>{t === tab ? '━'.repeat(tabWidth(label)) : ' '}</Text></Box>
          ))}
        </Box>
      </Box>
    )
    const columns = (
      <Box flexDirection="row">
        <Box width={nameWidth}><Text> </Text></Box>
        <Box width={scopeWidth('user')} justifyContent="center"><Text dimColor>User</Text></Box>
        <Box width={scopeWidth('project')} justifyContent="center"><Text dimColor>{p.projectName}</Text></Box>
      </Box>
    )
    // A list row: highlighted while the focus is in it, and under the pointer.
    const row = (key: string, selected: boolean, children: RenderChildren) => (
      <Box key={key} flexDirection="row" backgroundColor={selected ? SELECTED : undefined} hover={{ backgroundColor: SELECTED }}>{children}</Box>
    )
    // A scope cell: a stop for the arrows; Enter or a click changes that scope.
    const cell = (rowKey: string, s: Scope, text: string, dim: boolean, onPress: () => void, colour?: string, autoFocus?: true) => (
      <Box width={scopeWidth(s)} justifyContent="center">
        <Button key={`${s}@${rowKey}`} plain dimColor={dim} autoFocus={autoFocus} onPress={onPress}><Text color={colour}>{text}</Text></Button>
      </Box>
    )

    let body
    // The key legend: what the arrows and Enter do here, then this tab's own keys as buttons.
    let enter = ''
    const actions: RenderElement[] = []
    if (tab === 'topics') {
      const sel = selectedTopic(data)
      body = (
        <Box flexDirection="column" flexGrow={1}>
          {columns}
          {data.topics.map((t, i) => {
            const active = !t.error && effective(t, data.settings)
            return row(`row:${t.id}`, sel?.id === t.id, <Box flexDirection="row">
              <Box width={nameWidth}>
                <Text dimColor={!active} wrap="truncate">
                  {t.error ? <Text color="error">✕</Text> : <Text color={active ? 'success' : undefined}>{active ? Glyph.on : Glyph.off}</Text>}
                  <Text bold={active}> {sentence(t.name)}</Text>
                </Text>
              </Box>
              {SCOPES.map(s => {
                const v = t.error ? undefined : shown(t, data.settings, s)
                return cell(`t:${t.id}`, s, glyph(v), false, () => { if (!t.error) void setTopic($, t.id, s) },
                  v ? 'success' : undefined, i === 0 && s === 'user' ? true : undefined)
              })}
            </Box>)
          })}
          <Box flexGrow={1} />
          <Box flexDirection="column" marginTop={1}>
            {sel?.error ? <Text color="error" wrap="truncate-end">{sel.error}</Text> : <Text dimColor>{sel?.description}</Text>}
            {sel && !sel.error ? <Text color="subtle" wrap="truncate-middle">{sel.file ? tilde(sel.file, p.home) : 'built into md-scrub'}</Text> : null}
          </Box>
        </Box>
      )
      enter = 'toggle'
      if (sel?.file) actions.push(<Button key="open" plain hotkey="o" dimColor onPress={() => { if (sel?.file) void openFile($, sel.file) }}>open</Button>)
      if (sel?.builtIn && !sel.file) actions.push(<Button key="copy" plain hotkey="c" dimColor onPress={() => { if (sel) void copyTopic($, sel) }}>copy to edit</Button>)
    } else if (tab === 'exclusions') {
      const all = [...new Set([...data.exclusions.user, ...data.exclusions.project])]
      // With the focus elsewhere (a tab), the first row is highlighted.
      const current = focusedPattern() ?? all[0]
      const toggle = (x: string | undefined, s: Scope) => { if (x) void setPattern($, x, s, !data.exclusions[s].includes(x)) }
      const add = (pattern: string, target: Scope) => {
        adding = undefined
        if (!pattern) return refresh($)
        // The new row, focused, shows it was added.
        void setPattern($, pattern, target, true).then(() => $.ui.focus({ requestId: PANE, key: `${target}@x:${pattern}` })).catch(() => {})
      }
      body = (
        <Box flexDirection="column" flexGrow={1}>
          {columns}
          {all.length === 0 && !adding ? <Text dimColor>No exclusions.</Text> : null}
          {all.map(x => row(`xrow:${x}`, !adding && current === x, <Box flexDirection="row">
            <Box width={nameWidth}>
              <Text wrap="truncate">{x}</Text>
            </Box>
            {SCOPES.map(s => data.exclusions[s].includes(x)
              ? cell(`x:${x}`, s, Glyph.on, false, () => toggle(x, s), 'success')
              : cell(`x:${x}`, s, Glyph.unset, true, () => toggle(x, s)))}
          </Box>))}
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
                  onSubmit={(value: string) => add(value.trim(), adding?.target ?? 'project')} />
                <Button key="target" plain dimColor
                  onPress={() => { if (adding) { adding.target = adding.target === 'project' ? 'user' : 'project'; $.ui.invalidate('ui.render') } }}>
                  <Text dimColor>adds to </Text><Text color={ORANGE}>{adding.target === 'project' ? p.projectName : 'User'}</Text>
                </Button>
              </Box>
              {adding.suggestions.map(s => (
                <Button key={`s:${s}`} plain dimColor onPress={() => add(s, adding?.target ?? 'project')}>
                  {'  ' + s}
                </Button>
              ))}
              <Text dimColor>folder/ = everything in it · * = any name</Text>
            </Box>
          ) : (
            <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" marginTop={1}>
              <Button key="addx" plain hotkey="a" dimColor
                onPress={async () => { message = undefined; adding = { query: '', target: 'project', suggestions: cache ? await suggest($, cache.p.root, '') : [] }; $.ui.invalidate('ui.render') }}>path exclusion</Button>
            </Box>
          )}
        </Box>
      )
      if (adding) enter = 'add'
      else if (all.length) enter = 'toggle'
    } else {
      const current = focusedLog() ?? 0
      const pick = (i: number) => {
        const r = data.log[i]
        if (!r?.file) return
        message = undefined
        choice = { row: i, options: [r.file, parent(r.file)].filter((x): x is string => !!x) }
        $.ui.invalidate('ui.render')
      }
      const shown = data.log[current]
      body = (
        <Box flexDirection="column" flexGrow={1}>
          {data.logError ? <Text dimColor>{data.logError}</Text> : null}
          {!data.logError && data.log.length === 0 ? <Text dimColor>Nothing scrubbed or flagged in {p.projectName} yet.</Text> : null}
          {data.log.map((r, i) => {
            const file = r.file ?? ''
            const excluded = isExcluded(file, [...data.exclusions.user, ...data.exclusions.project])
            const d = new Date(r.t)
            const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
            const colour = r.action === 'scrubbed' ? ORANGE : r.action === 'flagged' || r.action === 'unchecked' ? 'warning' : undefined
            return (
              <Box flexDirection="column">
                {row(`lrow:${i}`, current === i, <Box flexDirection="row">
                  <Box width={7}><Text dimColor>{time}</Text></Box>
                  <Box width={11}><Text color={colour}>{r.action ?? ''}</Text></Box>
                  <Button key={`l:${i}`} plain onPress={() => pick(i)}>
                    {/* At full strength under the focus, so the inverted file reads as one block. */}
                    <Text dimColor={focused !== `l:${i}`}>{folderOf(file)}</Text>{nameOf(file)}
                  </Button>
                  {excluded ? <Text dimColor> · excluded</Text> : null}
                </Box>)}
                {choice?.row === i ? (
                  <Box flexDirection="row" gap={1} marginLeft={18}>
                    <Text dimColor>Exclude for {p.projectName}:</Text>
                    {choice.options.map((o, k) => (
                      <Button key={`e:${k}`} plain autoFocus={k === choice!.options.length - 1 ? true : undefined}
                        onPress={() => { choice = undefined; void setPattern($, o, 'project', true) }}>{o}</Button>
                    ))}
                    <Text dimColor>· enter</Text>
                  </Box>
                ) : null}
              </Box>
            )
          })}
          {data.otherLog ? <Text dimColor>{plural(data.otherLog, 'more row', 'more rows')} in other projects</Text> : null}
          <Box flexGrow={1} />
          {shown ? <Box marginTop={1}><Text dimColor wrap="truncate-end">{logDetail(shown, topicName)}</Text></Box> : null}
        </Box>
      )
      if (data.log.length) actions.push(<Button key="exclude" plain hotkey="e" dimColor onPress={() => pick(current)}>exclude</Button>)
    }

    const hint = (k: string, d: string) => <Text>{k}<Text dimColor> {d}</Text></Text>
    // Off for want of a key: `k` closes the panel and opens Claude Code's own /plugin screen, where the
    // key is typed into its Configure form and kept in secure storage, never in this panel.
    if (hd.state === 'off' && NEEDS_KEY.test(hd.reason ?? '')) {
      actions.push(<Button key="key" plain hotkey="k" dimColor onPress={async () => {
        await $.ui.close({ id: PANE })
        await $.command.run({ command: 'plugin' })
      }}>add OpenRouter key</Button>)
    }
    const legend = [hint('↑↓', 'move'), ...(enter ? [hint('enter', enter)] : []), ...actions, hint('1-3', 'screen'), hint('esc', 'close')]
    const keys = (
      <Box flexDirection="row" flexWrap="wrap">
        {legend.flatMap((item, i) => (i ? [<Text dimColor> · </Text>, item] : [item]))}
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        {head}
        {rule}
        {tabs}
        <Box flexDirection="column" marginTop={1} minHeight={bodyRows}>{body}</Box>
        {message ? <Text color="error">{message}</Text> : null}
        {rule}
        {keys}
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    adding = undefined; choice = undefined; cache = undefined; message = undefined
    ticker?.cancel(); ticker = undefined; logStamp = ''
    return next(e)
  }).catch(($, e, next) => next(e))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'md-scrub', description: 'Choose what md-scrub checks and see what it did' })
    return next(e)
  })
  registerPanel(on, options)
}
