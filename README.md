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

Orca installs the newest `vX.Y.Z` tag, or the default branch if there is none, pinned to the exact commit. Releases are listed in [CHANGELOG.md](CHANGELOG.md), and `orca plugin list` shows the version you have.

**Updating:** Orca does not update plugins on its own. Run `orca plugin update matiaz.pulse` to move to the newest release tag; an update that asks for new access needs a new approval, printed the same way as on install. Settings and Pulse's state are kept.

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

Every open PR where you are the author, an assignee, or a requested reviewer (50 per search). Each row shows a badge, `repo#123`, the author and the title. Click a row to open it on GitHub.

**Pull requests to show** picks which of them the list shows. A PR matches a workspace when its `owner/name` equals the GitHub repository of the workspace's `origin` remote, ignoring case. Only local workspaces count.

| Value | Shows |
| --- | --- |
| `open` (default) | PRs in repositories open in any local Orca workspace. |
| `workspace` | PRs in the focused workspace's repository. Empty, with a note, when the focused workspace has no GitHub remote. |
| `all` | Every PR from the searches, in any repository `gh` can see. |

Notifications and the status bar use the same list.

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
- **review** asks for a second click (**Run review?**) within 3 seconds, then opens a background terminal with Orca's `terminal.create` that runs `claude` with the review prompt. It runs in the local workspace whose `origin` is the PR's repository (the focused one if several match), or in the focused workspace. See [Review](#review).

A row can show a short warning under the title when an automatic merge failed or was skipped. See [Auto merge](#auto-merge).

#### Review

The agent runs `/code-review:code-review <url>` from the Claude Code `code-review` plugin, which scores each issue from 0 to 100, and then posts the result with your logged-in `gh` account instead of the plugin's own comment:

What it posts depends on **Let reviews approve** (off by default):

| Situation | Approve off (default) | Approve on |
| --- | --- | --- |
| Someone else's PR, an issue scored 80 or more | One review with **Request changes**, a short body and one inline comment per issue, on the head commit. No loop. | The same review, then a follow-up loop. |
| Someone else's PR, nothing scored 80 or more (or the plugin stopped because the change is simple) | A comment review: "No issues found." | An approval: "Looks good to me". No loop. |
| Your own PR | GitHub does not let you approve or request changes on your own PR, so it posts the findings as a comment review with inline comments, or a "Looks good to me" comment. No loop. | Same. |
| The PR is closed, a draft, or you already reviewed it | Nothing. | Nothing. |

The agent never merges. The follow-up loop (approve on only) runs `/loop` (Claude Code's built-in loop) in the same session, every 10 minutes by default (set by **Follow-up loop interval**). Each run reads the PR's state, your review threads and the commits since the reviewed one, and:

- stops without posting if the PR was merged or closed;
- approves ("All feedback addressed. Looks good to me.") and stops, only when every thread you started is resolved or answered by someone else, and the PR has new commits or every point was answered without needing a code change;
- otherwise posts nothing and waits for the next run.

The loop lives in that Claude Code session: **keep its terminal open**, or the follow-up stops. The agent gets no pre-approved tools, so Claude Code asks before acting, according to your own Claude Code settings. Nothing it posts mentions Claude or AI.

#### Auto review

With **Review requested pull requests automatically** on (the default), Pulse starts the same review by itself after each PR refresh, for at most one PR per refresh. A PR qualifies when:

- someone requested your review on it, it is not a draft and you did not author it;
- its repository is the `origin` of a local Orca workspace (whatever **Pull requests to show** is set to), and the review runs in that workspace;
- you have not reviewed it yet on GitHub;
- Pulse has not started a review for it before, automatically or from the **review** button.

Pulse shows a notification, "Pulse started reviewing repo#123". If the agent cannot be started, Pulse logs the error and does not try that PR again.

#### Auto merge

With **Merge pull requests Pulse reviewed** on (off by default), the worker merges a PR after a refresh when all of these hold:

- Pulse started a review for it (automatically or from the **review** button);
- GitHub's review decision is **Approved**, and your own latest review is an approval of the current head commit;
- GitHub reports the merge state as clean and the checks on the head commit passed. PRs without checks are not merged.

Right before merging, Pulse fetches that PR again and checks every condition. It then runs `gh pr merge <url> --squash` (or `--merge` / `--rebase`, from **Merge method**) with `--match-head-commit`, so GitHub refuses the merge if new commits arrived. It never passes `--admin` and never deletes the branch. At most one PR is merged per refresh.

A successful merge sends "Pulse merged repo#123". A failed merge shows the error on the PR row and sends a notification; Pulse tries again only after the head commit or the merge state changes. If the repository does not allow the chosen merge method, the row says so and nothing is merged.

With approve off and merge on, you approve by hand and Pulse merges afterwards.

### Git box

Shows the GitHub repository of the focused workspace (see [How the focused workspace is detected](#how-the-focused-workspace-is-detected)). Only repositories whose `origin` remote is on GitHub are shown. If the workspace folder is not itself a repository, Pulse looks up to 3 folders deep for up to 12 GitHub repositories, picks the one with the most recently changed files, and shows a dropdown to switch.

It lists the branch, commits ahead and behind, changed files with their staged state, and the branch's open PR with its check status.

When the branch has no open PR, it shows the CI result of the latest pushed commit (the upstream branch's tip) instead: `✓ checks passed`, `● checks running` or `✗ checks failed`. Clicking it opens that commit's checks on GitHub. Nothing is shown when the branch has no upstream, its commit has no checks, or automatic status is paused for the repository.

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

In the background, Pulse reads `git status` every 2 seconds, runs `git fetch --prune origin` every 2 minutes, and looks up the branch's PR, or the checks of its latest pushed commit, every 60 seconds and right after a push. These automatic git operations never run commands defined by the repository's own git config:

- **Status** is paused for repositories whose local config defines `filter.*` drivers (Git LFS installed with `--local`, for example) or `include` directives. The Git box then shows the branch without the file list. Stage, commit, pull and push still work.
- **Fetch** runs only when every key in the repository's local config is on a short list of known safe keys (remotes, branch tracking, user name and email, and similar); otherwise it is skipped.

Buttons you press behave like running git in a terminal. See [SECURITY.md](SECURITY.md).

### Status bar and notifications

- **Status bar:** a summary of the most urgent PR badge (for example `2 to merge` or `1 CI failed`), plus the 5-hour plan usage when plan limits are on. Its color follows the worst state, and the tooltip lists every count. Clicking it toggles the sidebar.
- **Notifications:** a desktop notification when a PR newly becomes `merge` (**Ready to merge**) or `ci failed` (**CI failed**), at most 5 per refresh, and when Pulse starts a review, merges a PR or fails to merge one. Turn them off with **Notify on pull request changes**.
- **Pulse: Refresh** in the command palette refreshes every source at once.

### Refresh intervals

| Source | Interval |
| --- | --- |
| git status | 2 s |
| git fetch | 2 min |
| branch PR and checks, or pushed commit checks | 60 s, and right after a push |
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
| `notifications.prs` | Notify on pull request changes | `true` | Desktop notification when a PR becomes ready to merge or its CI fails, and when Pulse starts a review or merges. |
| `git.aiMessages` | AI commit and PR messages | `true` | Show **message** and let **create pr** write the title and description with your local `claude` CLI. When off, **create pr** uses `gh pr create --fill`. |
| `claude.configDir` | Claude config folder | `""` | Absolute path to the Claude Code config folder, used for transcripts and (outside macOS) credentials. Empty uses `$CLAUDE_CONFIG_DIR` if the worker sees it, otherwise `~/.claude`. |
| `pulls.scope` | Pull requests to show | `open` | `workspace`, `open` or `all`. See [Pull requests](#pull-requests). |
| `reviews.auto` | Review requested pull requests automatically | `true` | Start the review on PRs that request your review, without a click. See [Auto review](#auto-review). |
| `reviews.autoApprove` | Let reviews approve | `false` | Let the review approve clean PRs and run the follow-up loop. Applies to auto review and the **review** button. |
| `reviews.autoMerge` | Merge pull requests Pulse reviewed | `false` | Merge PRs Pulse reviewed once GitHub says they are ready. See [Auto merge](#auto-merge). |
| `reviews.mergeMethod` | Merge method | `squash` | `squash`, `merge` or `rebase`, passed to `gh pr merge`. |
| `reviews.loopMinutes` | Follow-up loop interval (minutes) | `10` | How often the follow-up loop runs, from 1 to 1440 minutes. Applies to reviews started after the change. |

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
| `terminal:send` | Open one background terminal per review that runs `claude` with the review prompt, for **review** and auto review. Pulse never types into existing terminals. |
| `notifications:show` | PR notifications. |
| `settings:own` | Read Pulse's own settings. |

It does not ask for `agent:launch`, `terminal:read`, `workspace:write`, `storage:own` or `secrets:own`. Updating the status bar item needs no capability.

As a `trusted-worker` plugin, the worker still runs as a Node process with your user account's access. [SECURITY.md](SECURITY.md) describes how it limits what it runs.

## Privacy

There is no telemetry. What leaves your machine:

| Destination | When | What |
| --- | --- | --- |
| GitHub, via `gh` | Every refresh | PR searches, contribution counts, the current branch's PR and the check status of its latest pushed commit; `gh pr create` when you press **create pr**; `gh pr merge` when auto merge is on. After you confirm **review**, or when auto review starts one, the Claude Code agent posts reviews, comments and approvals with your `gh` account. |
| Your git remotes, via `git` | Background fetch, **pull**, **push** | Normal git traffic. |
| Anthropic, via your `claude` CLI | Only when you press **message** or **create pr** | Branch name, file list, commit subjects, the PR template and the diff, with secret-looking files excluded and the diff capped at 24,000 characters. |
| Anthropic, via the Claude Code agent | When you confirm **review**, or when auto review starts one (on by default) | Whatever the agent reads while reviewing, like any Claude Code session. |
| `api.anthropic.com` | Every 2 minutes while **Show Claude plan limits** is on (the default) | Your Claude Code OAuth token, to read your usage. |

What stays local:

- Claude Code transcripts are read from `<claude config folder>/projects`; only the usage, model, timestamp and message ids are used.
- Pulse's state lives in `$XDG_STATE_HOME/orca-pulse` (default `~/.local/state/orca-pulse`): caches of PRs, contributions, Claude daily totals and plan-limit percentages, the heatmap view, the terminal-to-workspace map, and the PRs Pulse started a review for (`reviews.json`, with merge errors; entries are dropped 14 days after the PR leaves the list). The folder is `0700` and the files `0600`. Delete it to reset Pulse.
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
