import type { Register, EngineInterface } from 'claude-code'

// md-scrub's hooks run beneath this mod and write progress records to its state folder:
// $XDG_STATE_HOME/md-scrub, else ~/.local/state/md-scrub (see src/config.ts).
let stateDir: string | undefined
const SHOW_AFTER_MS = 300 // fast checks never flash a "running" line
const POLL_MS = 250
const OUTCOME_MS = 6000 // how long a clean-up or block stays on the line before it clears
// Phases md-scrub only reaches once it has found unwanted content; earlier phases stay off the line.
const FOUND = /^(cleaning|re-checking)/

type CallRecord = {
  id: string
  file: string
  phase: string
  startedAt: number
  outcome?: 'clean' | 'cleaned' | 'blocked' | 'moved'
  edits?: number
  reason?: string
}

const safe = (s: string) => s.replace(/[^\w-]/g, '')
const base = (p: string) => p.split('/').pop() ?? p
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

async function stateFolder($: EngineInterface): Promise<string> {
  if (stateDir) return stateDir
  const { stdout } = await $.process.run(['sh', '-c', 'printf %s "${XDG_STATE_HOME:-$HOME/.local/state}/md-scrub"'])
  stateDir = stdout
  return stateDir
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined // not written (md-scrub ignored the call) or mid-rename
  }
}

// Claude Code prefixes each line with the plugin's name, so the lines start at the verb.
// Only outcomes where md-scrub acted; a clean pass shows nothing.
export function outcomeLine(r: CallRecord): string | undefined {
  if (r.outcome === 'cleaned') return `cleaned ${base(r.file)}${r.edits ? ` (${plural(r.edits, 'edit')})` : ''}`
  if (r.outcome === 'blocked') return `blocked ${r.reason ?? base(r.file)}`
  if (r.outcome === 'moved') return `moved ${r.file} to the scratchpad`
  return undefined
}

export function progressLine(r: CallRecord): string | undefined {
  return !r.outcome && FOUND.test(r.phase) ? `cleaning ${base(r.file)}…` : undefined
}

// A setup problem from session start (src/progress.ts SETUP_FILE), shown whenever nothing else is.
let warning: string | undefined

async function refreshWarning($: EngineInterface, cwd: string) {
  const s = await readJson<{ cwd: string | null; line: string | null }>($, `${await stateFolder($)}/setup.json`)
  warning = s?.line && s.cwd === cwd ? s.line : undefined
  if (!showing) $.ui.status(warning)
}

// The pending clear of an outcome line.
let clear: { cancel: () => void } | undefined
// Whether this mod's line is on screen, so a quiet call never touches the status line.
let showing = false

// Shows md-scrub's progress once it has found something, then the outcome, then clears.
async function watch<R>($: EngineInterface, id: string, run: () => Promise<R>): Promise<R> {
  const path = `${await stateFolder($)}/calls/${safe(id)}.json`
  const startedAt = await $.clock.now()
  const fresh = (r: CallRecord | undefined) => (r && r.startedAt >= startedAt - 1000 ? r : undefined)
  let poll: { cancel: () => void } | undefined
  const delay = $.clock.after(SHOW_AFTER_MS, () => {
    poll = $.clock.every(POLL_MS, async () => {
      const r = fresh(await readJson<CallRecord>($, path))
      const line = r && progressLine(r)
      if (line) {
        clear?.cancel()
        clear = undefined
        showing = true
        $.ui.status(line)
      }
    })
  })
  try {
    return await run()
  } finally {
    delay.cancel()
    poll?.cancel()
    const r = fresh(await readJson<CallRecord>($, path))
    const line = r && outcomeLine(r)
    if (line) {
      clear?.cancel()
      showing = true
      $.ui.status(line)
      clear = $.clock.after(OUTCOME_MS, () => {
        clear = undefined
        showing = false
        $.ui.status(warning)
      })
    } else if (r && showing && !clear) {
      showing = false // a progress line whose call ended clean
      $.ui.status(warning)
    }
  }
}

export const register: Register = on => {
  // A reload leaves the previous load's line on screen: start from the last setup check, which a
  // reload doesn't rerun. A new session reruns it in classic.SessionStart, below.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refreshWarning($, e.cwd)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await refreshWarning($, e.cwd)
    return result
  }).catch(($, e, next) => next(e))

  // Display only: if anything here fails, md-scrub's own hooks beneath still decide (next is replay-safe).
  on('classic.PreToolUse', ($, e, next) => watch($, e.tool_use_id, () => next(e))).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => watch($, `stop-${e.session_id}`, () => next(e))).catch(($, e, next) => next(e))
}
