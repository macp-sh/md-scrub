import { config as settings, apiKey, log, remainingMs } from "./config.ts";
import { jevQuestions, type ScrubConfig } from "./scrub.ts";

export const MARKDOWN_FILE = /\.(md|markdown)$/i;

export type KeywordHit = { label: string; line: number; excerpt: string; topic: string };
// `index` is the chunk's place in chunk()'s output. `after` is what joins this chunk to the next: a
// newline, or nothing where an over-long line was split.
export type Chunk = { index: number; body: string; from: number; to: number; after: string };
// `topics` are the ids of the topics that flagged the chunk, so messages only cite those.
export type FlaggedChunk = Chunk & { keywordHits: KeywordHit[]; jevScore?: number; topics: string[] };
// `mostly` is the length-weighted share Jev judged mostly a topic, absent when Jev could not score every chunk.
export type Detection = { flagged: FlaggedChunk[]; jevError?: string; mostly?: number };

export const NO_KEY = "OPENROUTER_API_KEY not set";

export function keywordHits(text: string, firstLine: number, config: ScrubConfig): KeywordHit[] {
  const hits: KeywordHit[] = [];
  const regexes = config.topics.flatMap((t) => t.regexes.map((r) => ({ ...r, topic: t.id })));
  text.split("\n").forEach((line, i) => {
    for (const { label, re, topic } of regexes) {
      const m = line.match(re);
      if (!m) continue;
      const at = m.index ?? 0;
      const excerpt = line.slice(Math.max(0, at - 30), at + m[0].length + 30).trim();
      hits.push({ label, line: firstLine + i, excerpt, topic });
      break; // one label per line keeps reports short
    }
  });
  return hits;
}

// Splits text into chunks of about chunkChars, at blank lines where possible. A line longer than
// chunkChars (minified HTML, a pasted page) is cut at spaces so no chunk outgrows a Jev request.
// Joining every chunk's body and `after` gives back the original text exactly.
export function chunk(text: string): Chunk[] {
  const max = settings.chunkChars;
  const segments: { text: string; line: number; after: string }[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const end = i === lines.length - 1 ? "" : "\n";
    let rest = line;
    while (rest.length > max) {
      const space = rest.lastIndexOf(" ", max);
      const cut = space > max / 2 ? space + 1 : max;
      segments.push({ text: rest.slice(0, cut), line: i + 1, after: "" });
      rest = rest.slice(cut);
    }
    segments.push({ text: rest, line: i + 1, after: end });
  });

  const chunks: Chunk[] = [];
  let buf: typeof segments = [];
  let size = 0;
  segments.forEach((seg, i) => {
    buf.push(seg);
    size += seg.text.length + seg.after.length;
    const paragraphEnd = seg.after === "\n" && seg.text.trim() === "";
    if ((size >= max && paragraphEnd) || size >= max * 2 || seg.after === "" && size >= max || i === segments.length - 1) {
      const last = buf[buf.length - 1]!;
      chunks.push({
        index: chunks.length,
        body: buf.map((b, j) => b.text + (j < buf.length - 1 ? b.after : "")).join(""),
        from: buf[0]!.line,
        to: last.line,
        after: last.after,
      });
      buf = [];
      size = 0;
    }
  });
  return chunks;
}

export const joinChunks = (chunks: { body: string; after: string }[]) => chunks.map((c) => c.body + c.after).join("");

type Scores = { p: number; mostly: number; byTopic: Record<string, number> };

// Every topic's two questions about a chunk, in one Jev request. `p` and `mostly` are the highest
// scores across topics; `byTopic` holds each topic's own score.
export async function jevScore(text: string, config: ScrubConfig): Promise<Scores | { error: string }> {
  const key = apiKey();
  if (!key) return { error: NO_KEY };
  if (!config.topics.length) return { p: 0, mostly: 0, byTopic: {} };
  try {
    const res = await fetch(settings.jevUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.jevModel, state: { chunk: text }, questions: jevQuestions(config) }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(settings.jevTimeoutMs, remainingMs() - 2000))),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Jev HTTP ${res.status}: ${body.error?.message ?? "unknown error"}`);
    const answers = body.answers ?? {};
    const scores = config.topics.map((t) => ({ id: t.id, p: answers[t.id]?.noul, mostly: answers[`${t.id}__mostly`]?.noul }));
    if (scores.some((s) => typeof s.p !== "number" || typeof s.mostly !== "number")) return { error: "Jev response missing an answer" };
    const p = Math.max(...scores.map((s) => s.p));
    const mostly = Math.max(...scores.map((s) => s.mostly));
    log({ event: "jev", p, mostly, model: body.model, cost: body.usage?.cost ?? 0 });
    return { p, mostly, byTopic: Object.fromEntries(scores.map((s) => [s.id, s.p])) };
  } catch (e: any) {
    return { error: e?.message?.startsWith("Jev") ? e.message : `Jev: ${e?.message ?? e}` };
  }
}

export async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = settings.concurrency): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Keywords and Jev both run on every chunk. Jev decides when it can answer: keyword hits alone would
// also catch text that only describes a rule ("never write what vendors' terms prohibit"), so they
// serve as hints for the clean-up. When Jev can't answer, keywords decide on their own.
// Jev's "mostly" answers give the share of the whole text that is mainly a topic.
export async function detect(text: string, config: ScrubConfig): Promise<Detection> {
  const chunks = chunk(text).filter((c) => c.body.trim());
  let jevError: string | undefined;
  const results = await pool(chunks, async (c) => {
    const hits = keywordHits(c.body, c.from, config);
    const r = await jevScore(c.body, config);
    if ("error" in r) jevError = r.error;
    const score = "error" in r ? undefined : r;
    const topics = score
      ? Object.entries(score.byTopic).filter(([, p]) => p >= config.thresholds.flag).map(([id]) => id)
      : [...new Set(hits.map((h) => h.topic))];
    return {
      flagged: topics.length ? ({ ...c, keywordHits: hits, jevScore: score?.p, topics } as FlaggedChunk) : null,
      mostly: score?.mostly,
      length: c.body.length,
    };
  });
  const total = results.reduce((n, r) => n + r.length, 0);
  const mostly =
    results.every((r) => r.mostly !== undefined) && total
      ? results.reduce((n, r) => n + r.mostly! * r.length, 0) / total
      : undefined;
  return { flagged: results.map((r) => r.flagged).filter((f): f is FlaggedChunk => f !== null), jevError, mostly };
}

export function describe(flagged: FlaggedChunk[]): string {
  const parts: string[] = [];
  for (const f of flagged) {
    for (const h of f.keywordHits) parts.push(`line ${h.line}, ${h.label}: "${h.excerpt}"`);
    if (f.jevScore !== undefined) parts.push(`lines ${f.from}-${f.to}: classifier score ${f.jevScore.toFixed(2)}`);
  }
  return parts.join("\n");
}
