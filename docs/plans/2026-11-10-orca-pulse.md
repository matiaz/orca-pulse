# orca-pulse Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port herdr-pulse (heatmap, plan limits, pull requests, git panel) to an Orca `trusted-worker` plugin with one right-sidebar HTML panel.

**Architecture:** A Node worker (`worker/main.mjs`) owns every side effect and polls ported `src/sources/*` modules; it pushes snapshots to a sandboxed HTML panel with `orca.panels.post` and answers panel actions through `orca.panels.handle`. Pure logic lives in small modules covered by `node --test`.

**Tech Stack:** Node 20+ ESM `.mjs`, Orca plugin API 1 (`engines.orca >=1.4.248`), `gh`, `git`, `claude` CLIs. Zero npm dependencies.

**Design:** `docs/plans/2026-11-10-orca-pulse-design.md`

**Reference sources:**
- herdr-pulse: a local clone of the herdr-pulse repo (port logic from `sources/*.mjs`, `lib/store.mjs`, `sections/*.mjs`)
- Orca docs: `<orca-clone>/docs/reference/plugin-{manifest,host-api,authoring,isolated-frames,theme-tokens}.md`, examples in `<orca-clone>/examples/plugins/`. Read-only; never run code from the clone.

**Repo rules:** no code comments in JS/HTML/CSS, English identifiers, no new npm dependencies, never commit (the user commits). Use `rg`/`fd`/`bat`/`eza` in shell.

---

### Task 1: Scaffold

**Files:**
- Create: `package.json` (`"type": "module"`, `"private": true`, `"engines": {"node": ">=20"}`, scripts `test: node --test test/`, `check: node scripts/check-manifest.mjs`)
- Create: `orca-plugin.json`
- Create: `.gitignore` (`node_modules/`, `.DS_Store`, `memory.md`, `*.log`)
- Create: `LICENSE` (MIT, 2026 matiaz)

`orca-plugin.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "pulse",
  "name": "Pulse",
  "version": "0.1.0",
  "description": "Activity heatmap, pull requests waiting on you, and a git panel for the focused workspace.",
  "author": { "name": "matiaz" },
  "repository": "https://github.com/matiaz/orca-pulse",
  "license": "MIT",
  "engines": { "orca": ">=1.4.248" },
  "pluginApi": 1,
  "main": "worker/main.mjs",
  "contributes": {
    "panels": [{ "id": "pulse", "title": "Pulse", "icon": "activity", "entry": "panel/index.html" }],
    "commands": [
      { "id": "pulse.toggle", "title": "Pulse: Toggle sidebar", "action": "sidebar.right.toggle" },
      { "id": "pulse.refresh", "title": "Pulse: Refresh" }
    ],
    "events": [{ "on": "workspace.changed" }, { "on": "workspace.created" }, { "on": "workspace.removed" }],
    "statusBarItems": [{ "id": "summary", "text": "Pulse", "icon": "activity", "command": "pulse.toggle" }],
    "settings": [
      { "key": "claude.planLimits", "title": "Show Claude plan limits", "description": "Reads the Claude Code OAuth token (macOS keychain or ~/.claude/.credentials.json) into memory and sends it only to api.anthropic.com to read your 5-hour and 7-day usage. Never stored or logged.", "type": "boolean", "default": false },
      { "key": "heatmap.defaultSource", "title": "Heatmap source", "type": "string", "enum": ["github", "claude"], "enumLabels": ["GitHub contributions", "Claude cost"], "default": "github" },
      { "key": "notifications.prs", "title": "Notify on pull request changes", "description": "Desktop notification when a pull request becomes ready to merge or its CI fails.", "type": "boolean", "default": true },
      { "key": "git.aiMessages", "title": "AI commit and PR messages", "description": "Sends the staged diff (secret-looking files excluded, 24 KB max) to your local claude CLI when you press message or create pr.", "type": "boolean", "default": true },
      { "key": "claude.configDir", "title": "Claude config folder", "description": "Leave empty to use ~/.claude.", "type": "string", "default": "" }
    ]
  },
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "agent:launch" },
    { "kind": "notifications:show" },
    { "kind": "settings:own" }
  ]
}
```

Verify `pulse.toggle` and `statusBarItems` field names against `plugin-manifest.md` and the JSON schema in `<orca-clone>/docs/schemas/plugins/`. If `$schema` URL path differs, use the real one.

**Step: Checkpoint** – `node -e "JSON.parse(require('fs').readFileSync('orca-plugin.json'))"` prints nothing.

---

### Task 2: `src/lib/sanitize.mjs` (TDD)

Exports:
- `clean(text, max = 200)` – string coerce, strip C0 (except none kept), DEL, C1, bidi overrides/isolates (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C), collapse whitespace, truncate with `…`. Port from herdr-pulse `clean()`.
- `isPullUrl(url)` – `/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/`.
- `isGithubUrl(url)` – `https://github.com/` prefix, parses with `new URL`, no credentials, host exactly `github.com`.
- `isPrivatePath(path)` – port `PRIVATE_PATHS` from herdr-pulse `sources/git.mjs` (`.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, `*secret*`, lockfiles), case-insensitive, matched on basename.

**Test:** `test/sanitize.test.mjs` – bidi `‮evil` stripped; `\x1b[31m` escape removed; newline collapsed; `isPullUrl` rejects `https://github.com/a/b/pull/1/files`, `http://`, `https://github.com.evil.com/...`, `https://github.com/a/b/pull/1;rm`; `isPrivatePath` true for `config/.env.local`, `certs/server.PEM`, `package-lock.json`, false for `src/env.ts`.

Run: `node --test test/sanitize.test.mjs` – FAIL first, then PASS.

---

### Task 3: `src/lib/exec.mjs` and `src/lib/env.mjs`

`env.mjs`:
- `toolPath()` – prepend `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` to `process.env.PATH` (dedupe). Call once at activate.

`exec.mjs`:
- `ALLOWED = new Set(['git','gh','claude','security','pbcopy','wl-copy','xclip','xsel'])`
- `run(bin, args, { cwd, input, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024, env })` → `{ code, stdout, stderr }`. Throws `Error('binary not allowed')` if `bin` not in `ALLOWED`. Uses `execFile` (never `shell: true`), `windowsHide`, kills on timeout, rejects with `code: 'ENOENT'` preserved so callers can show "install X".
- `git(cwd, args, opts)` – prepends `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat`. Do not override `credential.helper` (push auth needs it). Env adds `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`, `LC_ALL=C`.
- `gh(args, opts)`, `claude(args, opts)`.

**Test:** `test/exec.test.mjs` – `run('sh', ['-c','echo x'])` rejects; `run('git', ['--version'])` resolves code 0 (skip if git missing).

---

### Task 4: `src/lib/store.mjs`

Port herdr-pulse `lib/store.mjs`: `STATE_DIR` = `$XDG_STATE_HOME/orca-pulse` or `~/.local/state/orca-pulse`, mkdir 0o700, `readJson(name, fallback)`, `writeJson(name, value)` atomic (tmp + rename, mode 0o600), `quartileLevels`. Reject names containing `/` or `..`.

**Test:** `test/store.test.mjs` with `XDG_STATE_HOME` set to a temp dir: round-trip, file mode `0o600`, rejects `../x`.

---

### Task 5: Pull requests (`src/sources/pulls.mjs`) (TDD on ranking)

Port herdr-pulse `sources/pulls.mjs`: one `gh api graphql` with three searches (author, assignee, review-requested; first 50), merged by URL; `actionOf(pr, viewer)` and priority sort (merge > ci failed > conflict > changes > update > review > ci running > waiting > draft; ties by `updatedAt` desc); cache `pulls.json`; `sync(force)` every 2 min. Every string through `clean()`. Drop items whose `url` fails `isPullUrl`.

Export pure `actionOf`, `rankPulls`, `diffNotable(prev, next)` → list of `{ url, title, action }` that newly became `merge` or `ci failed` (for notifications).

**Test:** `test/pulls.test.mjs` – fixtures for each action, ordering, tie by `updatedAt`, `diffNotable` only reports transitions.

---

### Task 6: Heatmap sources (`src/sources/github.mjs`, `src/sources/claude.mjs`)

Port both verbatim in behavior:
- github: `viewer.contributionsCollection` in ≤364-day chunks, cache `github.json`, refetch today after 10 min.
- claude: incremental scan of `<configDir>/projects/**/*.jsonl` (configDir from setting, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`), byte offsets in `claude-scan.json`, dedupe `message.id:requestId`, price table, fast ×2, daily max into `claude-history.json`. Read files with streams; skip symlinks outside configDir; cap per-line length 2 MB.

Export pure `costOf(usage, model, speed)` and `parseLines(text, seen)`.

**Test:** `test/claude.test.mjs` – cost for a known model/usage; dedupe; fast multiplier; malformed lines ignored.

---

### Task 7: Plan limits (`src/sources/limits.mjs`)

Port herdr-pulse `sources/limits.mjs`, gated: `sync()` returns `{ enabled: false }` without touching keychain when `claude.planLimits` is false. Token read via `run('security', ['find-generic-password','-s','Claude Code-credentials','-w'])` on darwin, else `~/.claude/.credentials.json`; held in a local variable only for the request; `fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer …', 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000), redirect: 'error' })`. Never log errors containing the token (log `status` only). Poll 2 min, 429 → 10 min backoff. Cache only `{ five_hour, seven_day, fetchedAt }`.

Export pure `parseLimits(json)` and `resetLabel(iso, now)`.

**Test:** `test/limits.test.mjs` – parse, reset label relative and weekday forms.

---

### Task 8: Workspace matching (`src/lib/workspaces.mjs`) (TDD)

- `matchFocused(context, workspaces)` – `context` is `workspace.changed`/`readContext` answer `{ branch, displayName }`; `workspaces` from `workspace.list`. Only local (`hostId === null`). Prefer exact `name === displayName && branch === branch`; else `name === displayName`; else unique `branch` match; else `null`.
- `matchRepo(nameWithOwner, workspaces, remotesByPath)` – return the workspace whose git remote `origin` matches `owner/repo` (remotes resolved by caller via `git remote get-url origin`), preferring the focused one.
- `parseRemote(url)` – `git@github.com:o/r.git`, `https://github.com/o/r(.git)`, `ssh://git@github.com/o/r` → `o/r`; non-GitHub → null.

**Test:** `test/workspaces.test.mjs` – each rule, remote formats, remote hosts ignored.

---

### Task 9: Git source (`src/sources/git.mjs`) (TDD on parsers)

Port herdr-pulse `sources/git.mjs`, replacing `findTarget()` with a `setRoot(path)` the worker calls from workspace matching. Keep: porcelain v1 `-z` parsing, child-repo discovery (depth 3, max 12 repos, 400 dirs, skip list, rescan 30 s), auto-select by newest mtime with 5 s hold, GitHub-remote requirement, fetch every 2 min, branch PR + `statusCheckRollup` every 60 s, actions (stage all, message, commit, pull ff-only, push with `--set-upstream` first time never force, create pr with template lookup). Claude calls: `claude -p --model haiku --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence --disable-slash-commands` with cwd `os.tmpdir()`, diff input via stdin, `isPrivatePath` exclusions, 24 KB diff cap, 8 KB template cap. `git.aiMessages` false → message button hidden and create pr uses `gh pr create --fill`.

Export pure `parsePorcelain(buf)`, `summarize(files)`.

**Test:** `test/git.test.mjs` – porcelain with rename, conflict, partial staging, NUL-separated paths with spaces and newlines.

---

### Task 10: Review launch (`src/sources/review.mjs`)

`startReview(orca, pr, { focusedId, workspaces, remotes })`:
1. `isPullUrl(pr.url)` else throw `invalid_params`.
2. Pick workspace via `matchRepo`, fallback focused; none → throw with message "Open a workspace to run the review in".
3. `orca.host.call('agent.launch', { workspaceId, agent: 'claude', prompt })`. Prompt ported from herdr-pulse (`/code-review:code-review <url>` + inline comments, REQUEST_CHANGES/approve, COMMENT on own PRs). No allowed-tools flags.

**Test:** `test/review.test.mjs` with a fake `orca.host.call` capturing params; rejects bad URL; picks matching workspace.

---

### Task 11: Worker (`worker/main.mjs`)

`export default async function activate(orca)`:
- `toolPath()`.
- State: `context`, `workspaces`, sources.
- `orca.events.on('workspace.changed', …)` → store context, re-match, `git.setRoot(path)`. `workspace.created/removed` → refresh `workspace.list`.
- Timers per design table; git 2 s timer only runs while a panel has requested a snapshot in the last 30 s or a root is set (cheap `status` only). Clear all timers in `deactivate`.
- `orca.panels.handle`: `pulse.snapshot`, `heatmap.source`, `heatmap.shift`, `pulls.copy` (worker clipboard), `pulls.review`, `git.select`, `git.stageAll`, `git.message`, `git.commit`, `git.pull`, `git.push`, `git.createPr`, `refresh`. Validate every input (types, lengths ≤ 500, enums); throw `Object.assign(new Error(msg), { code: 'invalid_params' })`.
- Push snapshot with `orca.panels.post('pulse.update', snapshot)` on change (shallow JSON compare, ≤ 256 KiB).
- `orca.commands.register('pulse.toggle', () => orca.host.call('commands.run', …))` – NOTE: `commands.run` needs `workspace:write`. Instead implement toggle as a declarative command `{ "action": "sidebar.right.toggle" }` in the manifest and drop the worker registration. `pulse.refresh` forces all syncs.
- Status bar: `statusBar.update({ id: 'summary', text, tone, tooltip })` from top PR action and 5 h limit.
- Notifications: `diffNotable` → `notifications.show` when `notifications.prs` is true; never on first sync.
- Settings read with `orca.settings.get(key)` on each sync (cheap) so changes apply without restart.

Verify `orca.events`, `orca.settings`, `orca.panels`, `orca.commands` shapes against `<orca-clone>/examples/plugins/*/main.mjs` and `plugin-authoring.md`.

---

### Task 12: Panel (`panel/index.html`, `panel/app.mjs`, `panel/style.css`)

- Three collapsible sections (Activity, Pull requests, Git); order + collapsed in `localStorage` (try/catch).
- Rendering only with `document.createElement` + `textContent`; no `innerHTML` anywhere (checked in Task 14).
- Heatmap: CSS grid 7 rows × N weeks fitted to panel width, 5-level palette from Orca tokens (`--orca-*`, see `plugin-theme-tokens.md`) with fallbacks, today outlined, hover tooltip, `←/→` week buttons, today button, source toggle.
- Limits: two bars, warning ≥ 70 %, danger ≥ 90 %, reset label.
- Pulls: rows with action badge, repo#num, title; row click → `orca.shell.openExternal(url)` after `isGithubUrl` check in the panel too; copy and review buttons.
- Git: repo picker, ahead/behind, PR + checks line, file list with kind + staged mark, buttons disabled while busy, notices 4 s.
- Errors: each section shows its `error`/`hint` from the snapshot.
- `orca.plugin.request('pulse.snapshot')` on load, `orca.plugin.on('pulse.update', render)`.

Verify the frame API names (`orca.plugin.request`, `orca.plugin.on`, `orca.shell.openExternal`) in `plugin-isolated-frames.md` and `plugin-authoring.md`.

---

### Task 13: Docs

- `README.md` – what it is, screenshot placeholders, requirements (Orca ≥ 1.4.248, Node 20+, `gh auth login`, optional `claude`), install (`orca plugin install matiaz/orca-pulse`, dev: Settings → Plugins → Development folders or `orca plugin dev load .`), settings table, permissions table explaining each capability, data that leaves the machine, credits to herdr-pulse.
- `SECURITY.md` – what is read, what is executed, what is sent where, reporting via GitHub private advisories.
- `CONTRIBUTING.md` – `npm test`, `npm run check`, no runtime deps, no comments style, PR expectations.

---

### Task 14: Checks and CI

- `scripts/check-manifest.mjs` – validates `orca-plugin.json` required fields, capability list equals the design list, no `innerHTML`/`eval`/`new Function`/`shell: true` in `src/`, `worker/`, `panel/` (simple `readdir` + regex), every `run()` binary literal in `ALLOWED`.
- `.github/workflows/ci.yml` – `actions/checkout@v4`, `actions/setup-node@v4` matrix 20/22, `npm test`, `npm run check`. `permissions: contents: read`.

---

### Task 15: Verification

- `npm test` all green; `npm run check` clean.
- If `orca` CLI available: `orca plugin validate .` (ask the user before running anything that loads the plugin into their Orca).
- Manual: user loads the dev folder in Orca and confirms each box.
