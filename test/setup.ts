// Loaded before every test file, so local runs match CI: a temporary home (so no real
// ~/.claude/md-scrub settings or state, here or in hook processes) and no key from the environment.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "md-scrub-test-home-"));
process.env.OPENROUTER_API_KEY = "";
process.env.TYPESAFE_API_KEY = "";
delete process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
delete process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY;
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_PLUGIN_ROOT;
delete process.env.FAKE_JEV;
