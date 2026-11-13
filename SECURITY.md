# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and click **Report a vulnerability**. Do not open a public issue. There is no security email address.

Include what you found, how to reproduce it, and the Pulse and Orca versions. Only the latest release is supported.

## Threat model

Pulse is a `trusted-worker` Orca plugin. Its worker runs as a separate Node.js process, **unsandboxed, with your user account's privileges**. Orca's approval screen shows the capabilities it asks for, but the worker can still do anything your user can. The measures below limit what Pulse itself does with that access.

### In scope

- Opening a **malicious repository** in Orca: crafted file names, branch names, remotes, PR templates and repo-local git config.
- **Untrusted text** from GitHub (PR titles, logins, repository names), git output and Claude Code transcripts.
- A **compromised panel frame** sending arbitrary requests to the worker.

### Out of scope

- A compromised local `git`, `gh`, `claude` or `security` binary, or anyone who can write to a folder on your `PATH`. The worker appends `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin` to `PATH`.
- A compromised Orca host, another malicious plugin, or an already compromised user account.
- What a Claude Code agent does after a **review** starts, by hand or automatically, beyond the instructions Pulse gives it (see [Claude](#claude)).

## Measures

### Running programs

- **Binary allowlist.** `run()` in `src/lib/exec.mjs` refuses any program outside `git`, `gh`, `claude`, `security`, `pbcopy`, `wl-copy`, `xclip` and `xsel`. On macOS, `security` always runs as `/usr/bin/security`, never from `PATH`.
- **No shell.** Programs start with `child_process.spawn` and an argument array of strings; nothing goes through a shell.
- **Timeouts.** Every call has a timeout (30 s by default; 60 s for fetch, 90 s for `claude`, 2 minutes for commit, merge, push and PR creation). On POSIX each child runs in its own process group, and a timeout kills the whole group with `SIGKILL`.
- **Output caps.** Output is capped (8 MB by default, 1 MB for template blobs); the child is killed when it exceeds the cap.

### Environment

- **`gh`** (`ghEnv`) gets an allowlisted environment: `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `TERM`, `LANG`, `GITHUB_TOKEN`, `GH_TOKEN`, `SSH_AUTH_SOCK`, and variables starting with `LC_`, `XDG_`, `GH_`, `CLAUDE_` or `ANTHROPIC_`, plus `GH_PROMPT_DISABLED=1`, `NO_COLOR=1` and the git hardening below as `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n`, so the git that `gh` runs is hardened too.
- **`claude`** (`claudeEnv`) gets the same list without `GITHUB_TOKEN`, `GH_TOKEN` and `GH_*`, so it never sees a GitHub token.
- For both, `USER` and `LOGNAME` are filled from `os.userInfo()` when the host omits them. `claude` for **message** and **create pr**, and `gh pr create` on the AI path, run in a private `0700` folder Pulse creates under the OS temp folder (`orca-pulse-*`) on first use and deletes when the plugin is deactivated.
- **`git`** (`gitEnv`) gets the worker environment with every `GIT_*` variable, `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE` removed, then `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat` and `LC_ALL=C`.

### Git hardening

- Every git call starts with `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external= -c core.pager=cat -c core.alternateRefsCommand=`, so repository hooks, fsmonitor programs, external diff tools, pagers and alternate-refs commands never run. The list is defined once in `src/lib/exec.mjs` and also passed to `gh` (see above). The first argument must be a subcommand, not an option.
- Diffs add `--no-ext-diff --no-textconv` and run with `GIT_LITERAL_PATHSPECS=1`.
- **Automatic operations never run repo-local commands.** Pulse reads the key names in the repository's local config (`git config --local --name-only --list`, plus `--worktree` when `extensions.worktreeConfig` is set and `config.worktree` exists). The result is cached per repository and read again when `.git/config` or `config.worktree` changes, or after a minute. If the check fails, both automatic operations are treated as unsafe.
  - **Status poll:** paused when any key starts with `filter.`, `include.` or `includeIf.` (clean filters run during `git status`, and includes can bring in keys the check does not see). The Git box shows the branch, read with `git symbolic-ref`, and says why. The automatic status also passes `--ignore-submodules=dirty`, so it does not run git inside submodules with their own config.
  - **Background fetch:** runs only when every key is on an allowlist: `core.repositoryformatversion`, `core.filemode`, `core.bare`, `core.logallrefupdates`, `core.ignorecase`, `core.precomposeunicode`, `core.symlinks`, `extensions.objectFormat`, `extensions.refStorage`, `remote.<name>.url`, `.fetch`, `.prune`, `.tagOpt`, `branch.<name>.remote`, `.merge`, `.rebase`, `user.name`, `user.email`, `commit.gpgSign`, `pull.rebase`, `pull.ff`, `push.default`, `init.defaultBranch`, `gc.auto`, `submodule.<name>.url`, `.active` and `lfs.repositoryformatversion`. Anything else, `core.worktree` and `extensions.worktreeConfig` included, turns it off, and the panel says so.
- **Push** uses an explicit refspec, `refs/heads/<branch>:refs/heads/<branch>`, and never `--force`. The branch name is checked against a strict pattern and `git check-ref-format`; the remote name must match `^[A-Za-z0-9][\w.-]*$`.
- **Pull** is `git fetch` followed by `git merge --ff-only @{upstream}`.
- Commit messages are passed as a single argument after `-m`, followed by `--`.

**User-initiated actions behave like git in a terminal.** Stage all, message, commit, pull, push and create pr run with the hardening above, so hooks, fsmonitor, external diff, pagers and alternate-refs commands stay off, but everything else in the repository's config applies: `filter.*` clean drivers in the status each action starts with, in stage all and in the diffs **message** and **create pr** read, `gpg.program` with `commit.gpgSign` on commit, `core.sshCommand`, `credential.*` helpers and `url.*.insteadOf` on pull and push, and the same for the git that `gh pr create --fill` runs. Repo-local config is not transferred by `git clone`, so this matters for repositories copied in as folders or archives. Use a terminal you control for repositories you do not trust.

### Untrusted text

- Text from GitHub, git and transcripts goes through `clean()` or `cleanMultiline()` in `src/lib/sanitize.mjs` before it is cached, logged or shown. They strip ANSI escape sequences, C0 and C1 control characters, bidi controls and invisible format characters (Unicode `Cf`, including U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 and U+FEFF), and cap the length.
- Cached state is re-validated field by field when it is read back.

### Panel

- The panel is an isolated Orca frame with a strict Content-Security-Policy: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:`. No inline scripts or styles, no network.
- The DOM is built with `createElement` and `textContent` only. `npm run check` fails on `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function`, or raw bidi and invisible characters in `src/`, `worker/` and `panel/`.
- Every worker handler validates its input in `src/worker/validate.mjs`: unexpected fields, wrong types and oversized strings are refused.
- **copy** and **review** accept only a URL already in the worker's own PR list, never text supplied by the panel.

### Links

- PR URLs from GitHub are kept only if they match `isPullUrl`: `^https://github\.com/<owner>/<repo>/pull/<number>$`.
- The panel opens a link only if `isGithubUrl` accepts it: `https:`, host exactly `github.com`, no user, password or port. The worker applies the same check to the branch PR link. Orca's `shell.openExternal` also requires a click.

### State files

- State lives in `$XDG_STATE_HOME/orca-pulse` (default `~/.local/state/orca-pulse`). The folder is created `0700` and refused if it is a symlink or owned by another user.
- Files are written `0600` through an exclusively created temporary file and an atomic rename. File names must match `^[\w-][\w.-]*\.json$`.
- `reviews.json` is re-validated on load: only GitHub PR URLs, numeric times and sanitized error text are kept, and a PR's entry is dropped 14 days after it was last seen in the PR list.

### Claude

- **Plan limits** are on by default and can be turned off in settings. When on, the OAuth token is read on demand for each request (macOS keychain via `/usr/bin/security`, scoped to your account name, or `.credentials.json` in the Claude config folder on other platforms), must be printable ASCII up to 4096 characters, is sent only to `https://api.anthropic.com/api/oauth/usage` with redirects refused and a 10 s timeout, and is never written to disk or logged. Only the usage percentages are cached.
- **message** and **create pr** run `claude -p --model haiku --tools "" --setting-sources "" --strict-mcp-config --no-session-persistence --disable-slash-commands` in Pulse's private temp folder, with the diff on stdin and a system prompt that treats it as untrusted data. Secret-looking paths are excluded and the diff is capped at 24,000 characters. The filter goes by file name only: secrets inside other files are not detected, so they would be sent.
- **Transcripts** are read only as `.jsonl` files under `<claude config folder>/projects`; symlinks are skipped, files are opened with `O_NOFOLLOW`, and line, file and depth limits apply.
- **review** calls Orca's `terminal.create` with a workspace id, a title and the command `claude '<prompt>'`. The prompt is one single-quoted shell argument with embedded quotes escaped (tested against `/bin/sh`), and it is built from the validated PR URL and the owner, repository and number parsed from it. The PR's title, body and author never go into the prompt. The prompt tells the agent to treat all PR content as untrusted data, never as instructions.
- **The review agent acts under your GitHub account.** It posts reviews, inline comments, change requests and approvals with your logged-in `gh`, and for someone else's PR with a change request it keeps a `/loop` follow-up running (every 10 minutes by default, set by `reviews.loopMinutes`) in that Claude Code session until it approves or the PR is merged or closed. The prompt gates approval on GitHub state: every review thread you started must be resolved or answered, and the PR must have new commits or every point must have been answered without a code change. Deciding whether a reply or a commit really fixes an issue is still the agent's judgment, and it reads attacker-controlled PR content (code, descriptions, comments, replies) to make it. The prompt reduces the prompt-injection risk; it does not eliminate it. A crafted PR could still talk the agent into an approval or into running a command.
- The agent runs with your normal Claude Code permission mode and settings. Pulse grants no pre-approved tools, so Claude Code asks according to your settings; if you run Claude Code with permissions bypassed, nothing is asked. Check its permission requests before approving them, and close the session to stop a follow-up loop.
- **Let reviews approve** (`reviews.autoApprove`, off by default) decides whether the agent may approve. When off, the prompt tells it to request changes or leave a "No issues found." comment review, never to approve and never to start the follow-up loop. The prompt never asks the agent to merge and tells it never to merge.

### Auto review and auto merge

- **Auto review** (`reviews.auto`) is **on by default**. Any PR that requests your review, in a repository that is the `origin` of a local Orca workspace, is read by a Claude Code agent **without a click**: anyone who can request your review on such a repository can put content in front of the agent. The same prompt applies, with the PR content marked as untrusted data, and the same prompt-injection caveat. Drafts, your own PRs, PRs you already reviewed and PRs Pulse already started a review for are skipped, and at most one review starts per refresh. The review runs only in a workspace whose `origin` matches the PR's repository, never in the focused workspace as a fallback. Turn it off if you do not want this.
- **Auto merge** (`reviews.autoMerge`) is **off by default**. The worker merges, never the agent. It merges only a PR that:
  - Pulse started a review for (recorded in `reviews.json`);
  - GitHub reports as approved, with your own latest review an approval of the current head commit;
  - GitHub reports as cleanly mergeable (`mergeStateStatus` `CLEAN`, so branch protection and required reviews are satisfied), with the head commit's checks rollup `SUCCESS`. PRs without checks are not merged.
- Right before merging, the worker fetches the PR again with a GraphQL query whose owner, name and number are passed as variables, and re-checks every condition. It then runs `gh pr merge <url> --squash|--merge|--rebase --match-head-commit <sha>`, so GitHub refuses the merge if the head moved after the check. The method comes from a fixed list; any other setting value falls back to `squash`. It never passes `--admin` (no bypassing branch protection or merge queues) and never `--delete-branch`.
- A failed merge is not retried until the head commit, the merge state or the method changes. If the repository does not allow the chosen method, nothing is merged.
- With approve on, auto merge relies on the agent's approval, which comes from reading untrusted PR content. Turn on both only for repositories whose contributors you trust, or keep approve off and approve by hand.

### Other

- No runtime dependencies and no telemetry.
- Worker log lines are sanitized and truncated; tokens are never logged.
