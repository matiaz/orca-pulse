# Pulse

A right-sidebar panel for [Orca](https://github.com/stablyai/orca) that keeps three things in view while you work:

- **Activity.** Your GitHub contributions or your Claude Code spend, drawn as a contribution calendar.
- **Pull requests.** Every open PR you authored, are assigned to, or were asked to review, ranked by what it needs from you next.
- **Git.** The changes in the focused workspace, with buttons to stage, write a commit message with Claude, commit, pull, push, and open a pull request.

Pulse is a port of [herdr-pulse](https://github.com/matiaz/herdr-pulse). It is plain Node ESM with no runtime dependencies and no build step.

## Requirements

| Tool | Needed for | Notes |
| --- | --- | --- |
| Orca 1.4.248 or newer | everything | The manifest's `engines.orca` is `>=1.4.248`. |
| `git` | Git box | Commits use the name and email git is configured with. |
| [GitHub CLI](https://cli.github.com) (`gh`) | heatmap (GitHub view), pull requests, branch PR, create pr | Log in with `gh auth login`. See the note below. |
| [Claude Code](https://claude.com/claude-code) (`claude`) | **message**, **create pr** descriptions, **review** | Optional. Must be logged in. **review** also needs the `code-review` plugin in Claude Code: `/plugin install code-review@claude-plugins-official`. |
| `pbcopy` (macOS), or `wl-copy`, `xclip` or `xsel` (Linux) | copying PR links | |

Pulse runs on macOS and Linux.

> **`gh` must be logged in through its keyring.** Orca starts plugin workers without your shell environment, so a `GH_TOKEN` exported in `~/.zshrc` is not visible to Pulse. Run `gh auth login` and check with `gh auth status`. The worker appends `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin` to `PATH` so it can find `gh`, `git` and `claude`.

## Install

Pulse runs code on your machine (`trusted-worker`), so Orca asks you to approve it. The first install or load stops with `approval_required` (exit code 3) and prints what Pulse would be granted plus the exact command to re-run with `--approve <fingerprint>`. Read the list, then re-run that command.

**From GitHub:**

```sh
orca plugin install matiaz/orca-pulse
# read the grants, then re-run the printed command:
orca plugin install matiaz/orca-pulse --approve <fingerprint>
```

Orca installs the newest `vX.Y.Z` tag, or the default branch if there is none, pinned to the exact commit. Update later with `orca plugin update matiaz.pulse`; an update that asks for new access needs a new approval.

**From a clone:**

```sh
git clone https://github.com/matiaz/orca-pulse.git
orca plugin dev load ./orca-pulse
# read the grants, then re-run the printed command:
orca plugin dev load ./orca-pulse --approve <fingerprint>
```

A development folder overrides an installed plugin with the same key, and Orca reloads it when files change. `orca plugin dev unload ./orca-pulse` removes it.

**Then open it:** run **Pulse: Toggle sidebar** from the command palette, click the **Pulse** status bar item, or run `orca plugin open <plugin-key>`. `orca plugin list` shows the key (`matiaz.pulse` for a GitHub install, `local.pulse` for a folder). If Orca says plugins are off, turn them on in Settings → Plugins or with `orca plugin system on`.

## Features

### Activity heatmap

Toggle between two sources:

- **GitHub:** the contribution counts from your GitHub profile calendar, fetched with `gh api graphql`. Today's counts refresh every 10 minutes; up to 5 years of history.
- **Claude:** the estimated daily cost of your Claude Code usage, computed from the session transcripts in `~/.claude/projects` and priced at public API rates. It is an estimate, not a bill, and covers only this machine. Pulse keeps its own daily totals, so the calendar keeps your history after Claude Code deletes old transcripts.

Hover a day for its value. **‹** and **›** page 4 weeks at a time, **today** jumps back. The chosen source and position are remembered.

### Claude plan limits

On by default. Shows your 5-hour and 7-day usage as bars (yellow at 70%, red at 90%) with reset times. These are the numbers Claude Code's `/usage` shows and need a Claude Pro or Max login. Turn off **Show Claude plan limits** if you don't want Pulse to read your Claude Code OAuth token.

When enabled, Pulse reads your Claude Code OAuth token on each refresh: from the macOS keychain (`Claude Code-credentials`) on macOS, or from `<claude config folder>/.credentials.json` on other platforms. It sends the token only to `https://api.anthropic.com/api/oauth/usage`, every 2 minutes, backing off 10 minutes after a 401, 403 or 429. The token is never stored or logged; only the percentages are cached.

### Pull requests

Every open PR where you are the author, an assignee, or a requested reviewer, across all repositories `gh` can see (50 per search). Each row shows a badge, `repo#123`, the author and the title. Click a row to open it on GitHub.

Rows are sorted by badge, in this order, then by most recently updated:

| Badge | Meaning |
| --- | --- |
| `merge` | GitHub reports it can be merged. |
| `ci failed` | Checks on the latest commit failed or errored. |
| `conflict` | It has merge conflicts with its base branch. |
| `changes` | A reviewer requested changes. |
| `update` | The branch is behind its base and must be updated before merging. |
| `review` | Someone asked you to review it. Your own PRs never get this badge. |
| `ci running` | Checks are still running. |
| `waiting` | Nothing for you to do yet, for example waiting on a reviewer. |
| `draft` | It is a draft. |

Buttons on each row:

- **copy** copies the PR link to the clipboard.
- **review** asks for a second click (**Run review?**) within 3 seconds, then starts a Claude Code agent with Orca's `agent.launch`. It runs in the local workspace whose `origin` is the PR's repository (the focused one if several match), or in the focused workspace. See [Review](#review).

#### Review

The agent runs `/code-review:code-review <url>` from the Claude Code `code-review` plugin, which scores each issue from 0 to 100, and then posts the result with your logged-in `gh` account instead of the plugin's own comment:

| Situation | What the agent posts |
| --- | --- |
| Someone else's PR, an issue scored 80 or more | One review with **Request changes**, a short body and one inline comment per issue, on the head commit. Then it starts a follow-up loop. |
| Someone else's PR, nothing scored 80 or more (or the plugin stopped because the change is simple) | An approval: "Looks good to me". No loop. |
| Your own PR | GitHub does not let you approve or request changes on your own PR, so it posts the findings as a comment review with inline comments, or a "Looks good to me" comment. No loop. |
| The PR is closed, a draft, or you already reviewed it | Nothing. |

The follow-up loop runs `/loop 30m` (Claude Code's built-in loop) in the same session. Every 30 minutes it reads the PR's state, your review threads and the commits since the reviewed one, and:

- stops without posting if the PR was merged or closed;
- approves ("All feedback addressed. Looks good to me.") and stops, only when every thread you started is resolved or answered by someone else, and the PR has new commits or every point was answered without needing a code change;
- otherwise posts nothing and waits for the next run.

The loop lives in that Claude Code session: **keep its terminal open**, or the follow-up stops. The agent gets no pre-approved tools, so Claude Code asks before acting, according to your own Claude Code settings. Nothing it posts mentions Claude or AI.

### Git box

Shows the GitHub repository of the focused workspace (see [How the focused workspace is detected](#how-the-focused-workspace-is-detected)). Only repositories whose `origin` remote is on GitHub are shown. If the workspace folder is not itself a repository, Pulse looks up to 3 folders deep for up to 12 GitHub repositories, picks the one with the most recently changed files, and shows a dropdown to switch.

It lists the branch, commits ahead and behind, changed files with their staged state, and the branch's open PR with its check status.

| Button | What it does |
| --- | --- |
| **stage all** | `git add -A`. |
| **message** | Sends the file list and diff (staged changes if any are staged, otherwise all changes) to your local `claude` CLI and puts a one-line message, prefixed with the branch name, in the commit box. Shown only when **AI commit and PR messages** is on. |
| **commit** | Commits the staged changes. An empty message uses the branch name. |
| **pull** | Fetches, then fast-forwards to the upstream branch. Diverged branches are left for you to handle in a terminal. |
| **push** | Pushes `refs/heads/<branch>` to the branch's configured remote (default `origin`), setting the upstream on first push. Never force-pushes. |
| **create pr** | Needs the branch pushed. With AI messages on, `claude` writes the title and description from the commits, the diff and the repository's PR template; otherwise `gh pr create --fill`. Opens the new PR. If one already exists it opens that instead. |
| **pr #N** | Opens the branch's existing PR. |

Files whose paths look like secrets (`.env*`, keys and certificates such as `*.pem`, `*.key`, `*.p8`, `*.p12`, `*.ppk`, `*.gpg`, `*.asc`, `id_rsa` or `id_dsa`, `.ovpn` profiles, `kubeconfig`, `*service-account*.json`, `.htpasswd`, `.dockercfg`, `.netrc`, `.npmrc`, Terraform state, lockfiles, any path containing `secret` or `credential`) are left out of what is sent to `claude`, and the diff is capped at 24,000 characters. The filter goes by file name only: a secret inside an ordinary file is sent.

> Pulse runs git with hooks disabled, so `pre-commit`, `commit-msg` and `pre-push` hooks do **not** run for commits and pushes made from the panel. Use a terminal when you need them.

In the background, Pulse reads `git status` every 2 seconds, runs `git fetch --prune origin` every 2 minutes, and looks up the branch's PR every 60 seconds. These automatic git operations never run commands defined by the repository's own git config:

- **Status** is paused for repositories whose local config defines `filter.*` drivers (Git LFS installed with `--local`, for example) or `include` directives. The Git box then shows the branch without the file list. Stage, commit, pull and push still work.
- **Fetch** runs only when every key in the repository's local config is on a short list of known safe keys (remotes, branch tracking, user name and email, and similar); otherwise it is skipped.

Buttons you press behave like running git in a terminal. See [SECURITY.md](SECURITY.md).

### Status bar and notifications

- **Status bar:** a summary of the most urgent PR badge (for example `2 to merge` or `1 CI failed`), plus the 5-hour plan usage when plan limits are on. Its color follows the worst state, and the tooltip lists every count. Clicking it toggles the sidebar.
- **Notifications:** a desktop notification when a PR newly becomes `merge` (**Ready to merge**) or `ci failed` (**CI failed**), at most 5 per refresh. Turn it off with **Notify on pull request changes**.
- **Pulse: Refresh** in the command palette refreshes every source at once.

### Refresh intervals

| Source | Interval |
| --- | --- |
| git status | 2 s |
| git fetch | 2 min |
| branch PR and checks | 60 s |
| pull requests | 2 min |
| Claude transcripts | 30 s |
| GitHub contributions (today) | 10 min |
| plan limits | 2 min, 10 min backoff |

## Settings

Under Settings → Plugins → Pulse.

| Key | Title | Default | Meaning |
| --- | --- | --- | --- |
| `claude.planLimits` | Show Claude plan limits | `true` | Read the Claude Code OAuth token and fetch 5-hour and 7-day usage from `api.anthropic.com`. |
| `heatmap.defaultSource` | Heatmap source | `github` | Source shown until you pick one in the panel: `github` (GitHub contributions) or `claude` (Claude cost). After you pick, the panel remembers your choice. |
| `notifications.prs` | Notify on pull request changes | `true` | Desktop notification when a PR becomes ready to merge or its CI fails. |
| `git.aiMessages` | AI commit and PR messages | `true` | Show **message** and let **create pr** write the title and description with your local `claude` CLI. When off, **create pr** uses `gh pr create --fill`. |
| `claude.configDir` | Claude config folder | `""` | Absolute path to the Claude Code config folder, used for transcripts and (outside macOS) credentials. Empty uses `$CLAUDE_CONFIG_DIR` if the worker sees it, otherwise `~/.claude`. |

## How the focused workspace is detected

The Git box follows the workspace you are focused on in Orca. Only local workspaces count; SSH workspaces are ignored.

1. **Exact:** on Orca host API 1.7 and newer, the focused-workspace context includes `workspaceId`, and Pulse uses it directly.
2. **Learned from agents:** on older hosts the context has only the branch, display name and terminal ids. Each `agent.status.changed` event tells Pulse which workspace a terminal belongs to, and Pulse remembers that mapping. When you focus a workspace, its terminals identify it.
3. **By name:** otherwise Pulse matches the display name and branch against Orca's workspace list, when exactly one workspace matches.
4. **Picker:** if nothing matches, the Git box asks **Which workspace is focused?** once. Your choice is also learned for those terminals, so you are not asked again for them.

## Permissions

Pulse asks Orca for these capabilities, and nothing else:

| Capability | Why |
| --- | --- |
| `workspace:read` | Read the focused workspace and the workspace list, and hear when workspaces are focused, created or removed, to drive the Git box and pick where reviews run. |
| `agent:read` | Hear `agent.status.changed`, to learn which terminal belongs to which workspace on hosts without `workspaceId`. |
| `agent:launch` | Start the Claude Code agent for **review**. |
| `notifications:show` | PR notifications. |
| `settings:own` | Read Pulse's own settings. |

It does not ask for `terminal:send`, `terminal:read`, `workspace:write`, `storage:own` or `secrets:own`. Updating the status bar item needs no capability.

As a `trusted-worker` plugin, the worker still runs as a Node process with your user account's access. [SECURITY.md](SECURITY.md) describes how it limits what it runs.

## Privacy

There is no telemetry. What leaves your machine:

| Destination | When | What |
| --- | --- | --- |
| GitHub, via `gh` | Every refresh | PR searches, contribution counts, the current branch's PR; `gh pr create` when you press **create pr**. After you confirm **review**, the Claude Code agent posts reviews, comments and approvals with your `gh` account. |
| Your git remotes, via `git` | Background fetch, **pull**, **push** | Normal git traffic. |
| Anthropic, via your `claude` CLI | Only when you press **message** or **create pr** | Branch name, file list, commit subjects, the PR template and the diff, with secret-looking files excluded and the diff capped at 24,000 characters. |
| Anthropic, via the Claude Code agent | Only when you confirm **review** | Whatever the agent reads while reviewing, like any Claude Code session. |
| `api.anthropic.com` | Every 2 minutes while **Show Claude plan limits** is on (the default) | Your Claude Code OAuth token, to read your usage. |

What stays local:

- Claude Code transcripts are read from `<claude config folder>/projects`; only the usage, model, timestamp and message ids are used.
- Pulse's state lives in `$XDG_STATE_HOME/orca-pulse` (default `~/.local/state/orca-pulse`): caches of PRs, contributions, Claude daily totals and plan-limit percentages, the heatmap view, and the terminal-to-workspace map. The folder is `0700` and the files `0600`. Delete it to reset Pulse.
- The panel stores the box order and collapsed state in its own browser storage.

## Troubleshooting

- **"Run gh auth login"** or **"gh not found"**: install `gh` and run `gh auth login`; see the keyring note under [Requirements](#requirements).
- **"No GitHub repo in the focused workspace"**: the workspace's `origin` is not on GitHub, or it has no repository within 3 folders.
- **"Background fetch is off for this repo…"**: the repository's local git config has a key outside the safe list. Pull and push still work.
- **"Automatic status is paused…"**: the repository's local git config defines filter drivers or includes other config. Stage, commit, pull and push still work; use a terminal to see the file list.
- Worker logs: `orca plugin logs <plugin-key>`.

## Development

```sh
npm test          # node --test, no dependencies to install
npm run check     # validates orca-plugin.json, the panel CSP and source hygiene
orca plugin validate .
orca plugin dev watch .   # load this folder and stream logs and reloads
```

Tests need Node 20 or newer and `git`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
