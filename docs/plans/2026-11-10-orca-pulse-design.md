# orca-pulse design

Date: 2026-11-10
Status: approved

## Goal

Port [herdr-pulse](https://github.com/matiaz/herdr-pulse) to an [Orca](https://github.com/stablyai/orca) plugin: an activity heatmap, the pull requests waiting on you, and a git panel for the focused workspace, shown in Orca's right sidebar. The project will be open-sourced, so it must be safe by default and easy to audit.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Full port: heatmap, plan limits, pull requests, git panel |
| Review launch | `agent.launch` in an existing Orca workspace for the PR's repo, falling back to the focused workspace. No pre-approved tools. |
| Plan limits | Opt-in setting, off by default. Token kept in memory only, sent only to `api.anthropic.com`. |
| Tests | `node --test` on pure logic, GitHub Actions CI. No npm dependencies. |
| UI | One HTML panel (heatmap needs a custom grid), styled with Orca theme tokens. |
| Language | Plain ESM `.mjs`, no build step, no runtime dependencies. |

## Architecture

```
orca-plugin.json        manifest (trusted-worker)
worker/main.mjs         activate(orca): timers, panel handlers, status bar, notifications
src/sources/*.mjs       github, pulls, claude, limits, git, review (ported from herdr-pulse)
src/lib/*.mjs           exec, store, sanitize, workspace matching, PATH setup
panel/index.html        right-sidebar panel, inline JS and CSS
test/*.test.mjs         node --test
```

The worker owns every side effect (`gh`, `git`, `claude`, `fetch`, reading `~/.claude`). The panel has no network by Orca's design; it only renders snapshots and forwards clicks.

- Panel to worker: `plugin.request('pulse.snapshot')`, `plugin.request('<action>', params)`.
- Worker to panel: `orca.panels.post('pulse.update', snapshot)`.

### Herdr to Orca mapping

| herdr-pulse | orca-pulse |
|---|---|
| Dock pane and `dock.mjs` toggle | Right-sidebar panel plus a `Pulse: Toggle` command running `sidebar.right.toggle` |
| Focused pane cwd | `workspace.changed` (branch, displayName) matched against `workspace.list` paths |
| Review in a new Herdr workspace | `agent.launch` in the matching workspace |
| Keychain token always read | `claude.planLimits` setting, default off |
| `HERDR_PLUGIN_STATE_DIR` | `~/.local/state/orca-pulse` (or `$XDG_STATE_HOME/orca-pulse`) |

New in Orca: a status bar item summarizing the top PR action and the 5h limit, and desktop notifications when a PR becomes mergeable or its CI fails.

## Security model

Capabilities: `workspace:read`, `agent:launch`, `notifications:show`, `settings:own`. No `terminal:*`, `secrets:*` or `workspace:write`.

- **Process execution.** A single `exec()` helper: `execFile` (no shell), binary allowlist (`git`, `gh`, `claude`, `security`, clipboard tools), timeout, output cap.
- **Git hardening.** `-c core.fsmonitor=false`, `-c core.hooksPath=/dev/null`, `-c diff.external=`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff --no-textconv`. Never force-push; pull is fast-forward only. Hooks are disabled through `core.hooksPath`, so repo-supplied code never runs from the plugin.
- **Data leaving the machine.** `gh` and `git` network calls; diffs to the local `claude` CLI only when the user presses "message" or "create pr", with private paths excluded and a 24KB cap; plan limits only when opted in. No telemetry.
- **Untrusted text.** PR titles, branch names, file paths and git output go through `clean()` (strips C0/C1 and bidi controls). The panel renders with `textContent` only.
- **Review launch.** PR URL validated against `^https://github\.com/[\w.-]+/[\w.-]+/pull/\d+$`. The prompt is passed as data to `agent.launch`, never through a shell.
- **Links and clipboard.** Links open through `orca.shell.openExternal` (user gesture required), only `https://github.com/` URLs. Clipboard writes happen in the worker because frames have no clipboard permission.
- **State.** Directory mode 0700, files 0600, atomic writes (tmp file + rename).

## Features

1. **Activity.** Heatmap toggling GitHub contributions and Claude cost, hover tooltip, week scrolling, jump to today. Plan-limit bars (5h, 7d) when enabled; yellow at 70%, red at 90%.
2. **Pull requests.** Authored, assigned and review-requested PRs, ranked: merge > ci failed > conflict > changes > update > review > ci running > waiting > draft. Click opens; copy button; review button launches Claude.
3. **Git.** Focused workspace repo (or discovered child repos with auto-selection). File list with staged marks, ahead/behind, branch PR and checks. Buttons: stage all, message, commit, pull, push, create pr.

### Polling

| Source | Interval |
|---|---|
| git status | 2s (only while the panel is visible or a repo is selected) |
| git fetch | 2m |
| branch PR and checks | 60s |
| pull requests | 2m |
| Claude transcripts | 30s |
| GitHub contributions | 10m for today |
| plan limits | 2m, 10m backoff on 429 |

## Settings

| Key | Type | Default |
|---|---|---|
| `claude.planLimits` | boolean | false |
| `heatmap.defaultSource` | `github` \| `claude` | `github` |
| `notifications.prs` | boolean | true |
| `git.aiMessages` | boolean | true |
| `claude.configDir` | string | `""` (means `~/.claude`) |

## Error handling

- Missing `gh` or `claude`: the box shows an inline hint, never a crash.
- Orca strips most environment variables from workers, so `gh` must be logged in through its keyring. Documented in the README.
- The worker prepends common tool locations (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`) to `PATH`.
- Network failures keep the last cached data and show its age.
- A busy git action disables every git button until it finishes.

## Testing

`node --test` covers: porcelain parsing, PR action ranking, transcript cost and dedupe, private-path filter, `clean()`, PR URL validation, workspace-to-path matching. CI runs on Node 20 and 22 and validates the manifest.

## Repository

README with screenshots and install steps, MIT `LICENSE`, `SECURITY.md` (what is read, what is sent, how to report issues), `CONTRIBUTING.md`, `.gitignore`.
