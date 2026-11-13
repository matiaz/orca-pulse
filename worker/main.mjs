import { applyToolPath, removePrivateTmpDir } from "../src/lib/env.mjs";
import { claude as claudeCli, gh, git, run } from "../src/lib/exec.mjs";
import { readJson, writeJson } from "../src/lib/store.mjs";
import { createClaude, defaultConfigDir } from "../src/sources/claude.mjs";
import { createGit } from "../src/sources/git.mjs";
import { createGithub } from "../src/sources/github.mjs";
import { createLimits } from "../src/sources/limits.mjs";
import { createMerge } from "../src/sources/merge.mjs";
import { createPulls } from "../src/sources/pulls.mjs";
import { createPulse } from "../src/worker/pulse.mjs";

let pulse = null;

function createSources(setting) {
  const getConfigDir = () => defaultConfigDir(setting("claude.configDir"));
  return {
    pulls: createPulls({ gh, readJson, writeJson, now: Date.now }),
    merge: createMerge({ gh }),
    github: createGithub({ gh, readJson, writeJson, now: Date.now }),
    claude: createClaude({ getConfigDir, readJson, writeJson, now: Date.now }),
    limits: createLimits({
      enabled: () => setting("claude.planLimits") === true,
      fetch: globalThis.fetch,
      now: Date.now,
      readJson,
      writeJson,
      getConfigDir,
      run,
    }),
    git: createGit({ git, gh, claude: claudeCli, now: Date.now, aiEnabled: () => setting("git.aiMessages") !== false }),
  };
}

export default async function activate(orca) {
  applyToolPath();
  if (pulse) pulse.dispose();
  pulse = createPulse(orca, { createSources, readJson, writeJson, now: Date.now });
  await pulse.start();
}

export async function deactivate() {
  if (!pulse) return;
  pulse.dispose();
  pulse = null;
  removePrivateTmpDir();
}
