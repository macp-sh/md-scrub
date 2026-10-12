import { config as settings, jevProvider, log, remainingMs, type Provider } from "./config.ts";
import { jevQuestions, thresholdsFor, type ScrubConfig, type Topic } from "./scrub.ts";
import { topicModel } from "./jev-model.ts";

export const MARKDOWN_FILE = /\.(md|markdown)$/i;

export type KeywordHit = { label: string; line: number; excerpt: string; topic: string };
// `index` is the chunk's place in chunk()'s output. `after` is what joins this chunk to the next: a
// newline, or nothing where an over-long line was split.
export type Chunk = { index: number; body: string; from: number; to: number; after: string };
// `topics` are the ids of the topics that flagged the chunk, so messages only cite those.
export type FlaggedChunk = Chunk & { keywordHits: KeywordHit[]; jevScore?: number; topics: string[] };
// `mostly` is the largest length-weighted share Jev judged mostly one topic (of those over their own
// threshold, when any are), absent when Jev could not score every chunk; `mostlyTopics` are the topics
// over their threshold.
export type Detection = { flagged: FlaggedChunk[]; jevError?: string; mostly?: number; mostlyTopics?: string[] };

export const NO_KEY = "no Jev key set (OpenRouter or TypeSafe)";

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

// An error body's message: OpenRouter's `error.message`, else whatever TypeSafe sent (undocumented).
const errorText = (body: any): string => {
  const m = body?.error?.message ?? body?.error ?? body?.detail ?? body?.message;
  return m === undefined ? "unknown error" : (typeof m === "string" ? m : JSON.stringify(m)).slice(0, 200);
};

type Scores = { p: number; mostly: number; byTopic: Record<string, number>; mostlyByTopic: Record<string, number> };
type Answers = Pick<Scores, "byTopic" | "mostlyByTopic">;

// Every topic's two questions about a chunk: one Jev request per model, so topics that name their own
// model (their `jev.model`) are asked apart from the rest. `p` and `mostly` are the highest scores
// across topics; `byTopic` and `mostlyByTopic` hold each topic's own.
export async function jevScore(text: string, config: ScrubConfig): Promise<Scores | { error: string }> {
  const provider = jevProvider();
  if (!provider) return { error: NO_KEY };
  if (!config.topics.length) return { p: 0, mostly: 0, byTopic: {}, mostlyByTopic: {} };
  const groups = new Map<string, Topic[]>();
  for (const t of config.topics) {
    const model = topicModel(t.jev, provider.id) ?? provider.model;
    groups.set(model, [...(groups.get(model) ?? []), t]);
  }
  const answered = await Promise.all([...groups].map(([model, topics]) => ask(text, topics, model, provider)));
  const failed = answered.find((r): r is { error: string } => "error" in r);
  if (failed) return failed;
  const byTopic = Object.assign({}, ...answered.map((r) => (r as Answers).byTopic));
  const mostlyByTopic = Object.assign({}, ...answered.map((r) => (r as Answers).mostlyByTopic));
  return { p: Math.max(...Object.values<number>(byTopic)), mostly: Math.max(...Object.values<number>(mostlyByTopic)), byTopic, mostlyByTopic };
}

async function ask(text: string, topics: Topic[], model: string, provider: Provider): Promise<Answers | { error: string }> {
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: { chunk: text }, questions: jevQuestions({ topics }) }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(settings.jevTimeoutMs, remainingMs() - 2000))),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Jev HTTP ${res.status} (${provider.name}): ${errorText(body)}`);
    const answers = body.answers ?? {};
    const scores = topics.map((t) => ({ id: t.id, p: answers[t.id]?.noul, mostly: answers[`${t.id}__mostly`]?.noul }));
    if (scores.some((s) => typeof s.p !== "number" || typeof s.mostly !== "number")) return { error: "Jev response missing an answer" };
    // OpenRouter reports a cost; TypeSafe reports tokens only.
    log({
      event: "jev", p: Math.max(...scores.map((s) => s.p)), mostly: Math.max(...scores.map((s) => s.mostly)),
      provider: provider.name, model: body.model, cost: body.usage?.cost, tokens: body.usage?.input_tokens,
    });
    return { byTopic: Object.fromEntries(scores.map((s) => [s.id, s.p])), mostlyByTopic: Object.fromEntries(scores.map((s) => [s.id, s.mostly])) };
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

// Keywords and Jev both run on every chunk. Jev alone decides: keyword hits would also catch text that
// only describes a rule ("never write what vendors' terms prohibit"), so they only guide the clean-up.
// When Jev can't answer for any chunk, nothing is flagged and `jevError` says why: md-scrub stands
// down rather than act on a partial or keyword-only check.
// Jev's "mostly" answers give the share of the whole text that is mainly a topic.
export async function detect(text: string, config: ScrubConfig): Promise<Detection> {
  const chunks = chunk(text).filter((c) => c.body.trim());
  let jevError: string | undefined;
  const results = await pool(chunks, async (c) => {
    const hits = keywordHits(c.body, c.from, config);
    const r = await jevScore(c.body, config);
    if ("error" in r) jevError = r.error;
    const score = "error" in r ? undefined : r;
    // Each topic against its own flag threshold (its `jev.flag`, else the settings').
    const topics = score ? config.topics.filter((t) => score.byTopic[t.id] >= thresholdsFor(t, config).flag).map((t) => t.id) : [];
    return {
      flagged: topics.length ? ({ ...c, keywordHits: hits, jevScore: score?.p, topics } as FlaggedChunk) : null,
      mostly: score?.mostlyByTopic,
      length: c.body.length,
    };
  });
  if (jevError) return { flagged: [], jevError };
  const flagged = results.map((r) => r.flagged).filter((f): f is FlaggedChunk => f !== null);
  // Each topic's length-weighted share of the whole text, against its own mostly threshold.
  const total = results.reduce((n, r) => n + r.length, 0);
  if (!total || !config.topics.length || results.some((r) => !r.mostly)) return { flagged };
  const shares = config.topics.map((t) => ({ t, share: results.reduce((n, r) => n + r.mostly![t.id]! * r.length, 0) / total }));
  const over = shares.filter(({ t, share }) => share >= thresholdsFor(t, config).mostly);
  const mostly = Math.max(...(over.length ? over : shares).map((s) => s.share));
  return { flagged, mostly, mostlyTopics: over.map(({ t }) => t.id) };
}

export function describe(flagged: FlaggedChunk[]): string {
  const parts: string[] = [];
  for (const f of flagged) {
    for (const h of f.keywordHits) parts.push(`line ${h.line}, ${h.label}: "${h.excerpt}"`);
    if (f.jevScore !== undefined) parts.push(`lines ${f.from}-${f.to}: classifier score ${f.jevScore.toFixed(2)}`);
  }
  return parts.join("\n");
}
