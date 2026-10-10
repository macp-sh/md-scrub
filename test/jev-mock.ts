// Preloaded into hook processes in tests (bun --preload), so no test reaches OpenRouter. FAKE_JEV picks
// how Jev behaves:
//   score    answers from markers: LICENSING or "licensed under" flags a chunk; MOSTLY flags it and
//            also marks it as mostly the topic
//   down     the network fails
//   error    the service answers HTTP 500
//   missing  a reply without answers
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://openrouter.ai/")) return realFetch(input, init);
  const mode = process.env.FAKE_JEV;
  if (mode === "down") throw new TypeError("Unable to connect");
  if (mode === "error") return Response.json({ error: { message: "upstream failed" } }, { status: 500 });
  if (mode === "missing") return Response.json({ model: "fake-jev", answers: {}, usage: { cost: 0 } });
  if (mode !== "score") throw new Error("set FAKE_JEV whenever a test gives the hooks an OpenRouter key");
  const body = JSON.parse(init.body);
  const chunk: string = body.state.chunk;
  const answers: Record<string, { noul: number }> = {};
  for (const id of Object.keys(body.questions)) {
    const mostly = id.endsWith("__mostly");
    const hit = mostly ? /MOSTLY/.test(chunk) : /LICENSING|MOSTLY|licensed under/.test(chunk);
    answers[id] = { noul: hit ? 0.95 : mostly ? 0.05 : 0.02 };
  }
  return Response.json({ model: "fake-jev", answers, usage: { cost: 0 } });
}) as typeof fetch;
