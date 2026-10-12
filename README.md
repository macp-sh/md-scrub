# md-scrub

[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)](https://code.claude.com/docs/en/plugins/install) [![Release](https://img.shields.io/github/v/release/macp-sh/md-scrub)](https://github.com/macp-sh/md-scrub/releases/latest) [![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

**A Claude Code plugin that enforces what Claude writes in Markdown.**

![Claude writes a Markdown file, a PreToolUse hook catches it, Jev classifies it against your topics, and if anything is flagged, Haiku 5.5 adjusts the file; the status line shows what changed](.github/assets/how-it-works.svg)

Claude Code writes a lot of Markdown. You can tell Claude what never to put in it, and it will follow that most of the time, but not every time. md-scrub enforces it: it checks the Markdown Claude writes before it's saved and removes anything you've ruled out.

## Install

You'll need Claude Code v2.1.287 or later on macOS or Linux, [Bun](https://bun.sh), and an API key for Jev from either [OpenRouter](https://openrouter.ai) or [TypeSafe](https://console.typesafe.ai/keys), its maker. Checking costs a fraction of a cent per file.

Inside a Claude Code session, run:

```
/plugin install md-scrub --marketplace macp-sh/claude-plugins
```

Claude Code asks for a key for Jev when the plugin is enabled: an OpenRouter key or a TypeSafe key, whichever you have (if you set both, TypeSafe's is used). If you installed from a shell, or want to change the key later, open `/plugin`, go to Installed, select md-scrub and choose Configure; until a key is set, md-scrub stays off and the status line says so. To get updates automatically, open `/plugin`, go to Marketplaces, select `macp-sh` and choose Enable auto-update. To remove md-scrub, run `claude plugin uninstall md-scrub@macp-sh`.

## What it does

- **Scrubs unwanted content** from Markdown that Claude writes or edits, before it's saved, and tells Claude what changed.
- **Checks files written by commands and scripts** at the end of each turn, and scrubs them there.
- **Flags whole documents** that are mostly unwanted content, such as a saved terms of service page: they're left as written, and Claude and you are told, so you decide.
- **Never blocks a write.** If Jev isn't responding, md-scrub stands down and says so.
- **Leaves alone** files you edit yourself, and licence files such as `LICENSE` and `NOTICE`.

md-scrub ships with one example topic, `third-party-terms`, which stops Claude writing **third-party legal terms** into `.md` files: what another company's terms of service, licence or policy says you can or can't do. Your own project's licence, and mentions like "zod (MIT)", are left alone.

## Add your own topics

A topic is a JSON file describing content to keep out, such as vendor documentation pasted in verbatim, unverified performance claims, or medical and financial advice. Topics are checked by sending text to Jev, so don't use them for secrets or personal data; a dedicated secret scanner such as GitGuardian's ggshield suits those better.

Topics live in a `topics` folder at one of two scopes, as in Claude Code's own settings: **user**, `~/.claude/md-scrub/topics/` (you, in every project), and **project**, `.claude/md-scrub/topics/` in the project (everyone working in it, once committed). The file name is the topic's id. For example, `vendor-docs.json`:

```json
{
  "name": "copied vendor documentation",
  "description": "Passages pasted verbatim from another company's documentation or website.",
  "examples": {
    "is": ["To create a webhook, open the Dashboard, choose Developers, then Webhooks, and click Add endpoint."],
    "isNot": ["Our webhook handler checks the signature before processing an event."]
  }
}
```

`is` lists examples to remove and `isNot` examples to keep. A few of each makes the topic more accurate. The built-in topic, [`third-party-terms.json`](defaults/topics/third-party-terms.json), shows every field but one; to change it, copy it into your topics (the panel's **c** does this) and edit the copy.

That one is `jev`, for a topic that needs its own Jev settings. Each part is optional:

```json
"jev": { "model": "jev-1.14.0", "flag": 0.35, "mostly": 0.6 }
```

`flag` and `mostly` replace the thresholds in `config.json` for this topic only. `model` picks the Jev model for this topic; write it as your service names it, `jev-…` for TypeSafe or `typesafe/…` for OpenRouter. An ID for the other service is an error, which turns that topic off and shows it in the panel. A project topic shared by people on different services can give both: `"model": { "typesafe": "jev-1.14.0", "openrouter": "typesafe/jev-1.14" }`. md-scrub's thresholds were tuned for its own model, so a topic with another model may need its own thresholds too.

## How it works

1. **A PreToolUse hook** catches every Markdown write from Claude's Write and Edit tools before it's saved, so the check can't be skipped. A Stop hook checks files that commands and scripts wrote at the end of each turn.
2. **[Jev](https://docs.typesafe.ai)**, a fast classifier reached through OpenRouter or TypeSafe directly, scores the new text against your topics. Most writes stop here and are saved as written.
3. **Claude Haiku 5.5** runs only when Jev flags something. It runs through `claude -p` (Claude Code's headless mode) with your existing login, so there's no Anthropic API key to set up, and proposes the smallest edits that remove the flagged text. md-scrub accepts edits that only delete text, then has Jev check the result again. If it can't remove something safely, it leaves the text and tells Claude what to remove.
4. **A Claude Code mod** shows what md-scrub changed in the status line.

## The /md-scrub panel

Type `/md-scrub` in a session to see and change what md-scrub does:

| Tab | For |
| :- | :- |
| **Topics** | Switch each topic on or off for **User** (every project) or this project |
| **Path exclusions** | Files and folders md-scrub never checks, such as `legal/`, at either scope; **a** adds one, with matching folders and files to pick from (or type `/md-scrub exclude <path>`, adding `--user` for every project) |
| **Log** | What md-scrub scrubbed or flagged recently; **e** excludes a file or its folder |

## Settings files

The panel writes plain files, which you can also edit or commit. They live in `~/.claude/md-scrub/` (user) and `.claude/md-scrub/` in the project (project overrides user).

| To | File | Contents |
| :- | :- | :- |
| Switch md-scrub off | `config.json` | `{ "enabled": false }` |
| Turn off the built-in topic, keep your own | `config.json` | `{ "topics": { "third-party-terms": { "enabled": false } } }` |
| Exclude files or folders | `exclusions` | One per line, such as `legal/` or `docs/privacy.md` |

## Privacy and cost

The Markdown Claude writes is checked by the [Jev](https://docs.typesafe.ai) classifier (run by TypeSafe), through OpenRouter or directly from TypeSafe, depending on your key. Text that needs removing is also sent to Claude Haiku through your own Claude Code account. md-scrub's own log keeps scores and costs, never your text.

Checking costs a fraction of a cent per file. Removing something adds a few seconds.

## Licence

MIT. See [LICENSE](LICENSE).
