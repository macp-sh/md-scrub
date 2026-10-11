# Contributing

Bug reports and ideas are welcome as [issues](https://github.com/macp-sh/md-scrub/issues).

## Proposing a topic

A topic is one JSON file in `defaults/topics/`; its file name is its id (lowercase kebab-case). [`third-party-terms.json`](defaults/topics/third-party-terms.json) shows every field.

- **Content judged by meaning, not secrets.** Topics are checked by sending text to OpenRouter, so topics for credentials or personal data don't belong here.
- **Off by default.** Add `"<id>": { "enabled": false }` under `topics` in `defaults/config.json`, so people switch it on in `/md-scrub`.
- **Examples on both sides.** At least five passages that should be removed and five similar ones that should stay. Jev is sensitive to wording, so near misses matter most.
- **Measured.** Add labelled cases to `eval/cases/` and include the output of the eval scripts in the pull request (see below). Keep a few cases aside as a holdout you didn't tune against.

## Development

```sh
bun test                    # hook tests, offline (fakes stand in for Jev and Haiku)
claude plugin test .        # status line and panel tests
claude plugin validate .    # manifest and hooks
claude --plugin-dir .       # run Claude Code with this checkout
bun eval/passages.ts        # classifier evals; need OPENROUTER_API_KEY. Also documents.ts, clean.ts, and "holdout"
```
