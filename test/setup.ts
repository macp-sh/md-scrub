// Loaded before every test file, so local runs match CI: no real state folder, no real home folder
// for hook processes (and so no ~/.config/md-scrub layers), and no OpenRouter key from the environment.
// Bun's os.homedir() in this process keeps the real home despite HOME; tests needing the user layer
// set HOME on a spawned hook instead.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "md-scrub-test-state-"));
process.env.HOME = mkdtempSync(join(tmpdir(), "md-scrub-test-home-"));
process.env.OPENROUTER_API_KEY = "";
delete process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
delete process.env.CLAUDE_PLUGIN_OPTION_JEV_ON_ERROR;
delete process.env.CLAUDE_PLUGIN_ROOT;
delete process.env.FAKE_JEV;
