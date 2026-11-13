# Contributing

Thanks for helping. Keep changes small and focused; open an issue first for anything large.

## Setup

You need Node 20 or newer, `git`, and Orca to try the plugin. There is nothing to install.

```sh
npm test          # node --test
npm run check     # manifest, panel CSP and source hygiene checks
orca plugin validate .
```

CI runs `npm run check` and `npm test` on Node 20 and 22.

## Load it in Orca

```sh
orca plugin dev watch .
```

This loads the folder as a development plugin and streams its logs and reloads until Ctrl-C. The first load asks you to approve its access; later code edits reload without asking again, but new capabilities, commands or panels need a new approval. You can also use `orca plugin dev load .` and `orca plugin logs local.pulse`.

## Rules

- **No runtime dependencies.** Use Node's standard library. No build step.
- **No code comments** in `.mjs`, `.html` or `.css` files. Name things clearly instead.
- **Sanitize external text.** Anything from GitHub, git, transcripts or other processes goes through `clean()` or `cleanMultiline()` from `src/lib/sanitize.mjs` before it is cached, logged or shown. Validate URLs with `isPullUrl` or `isGithubUrl`.
- **Panel DOM via `textContent` only.** No `innerHTML`, `eval` or `new Function`; `npm run check` enforces it.
- **Run programs through `src/lib/exec.mjs`.** Never use a shell. Adding a binary to `ALLOWED` needs a reason in the PR.
- **Keep capabilities minimal.** A new capability in `orca-plugin.json` fails `npm run check` until you add it to the allowlist in `scripts/check-manifest.mjs`, and every user has to approve it again. Explain why it is needed.
- **Test pure logic** with `node --test` in `test/`. Pass fakes for `git`, `gh`, `claude` and the clock instead of calling real services.
- Keep `version` in `orca-plugin.json` and `package.json` equal.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Keep the PR description short: what changed and why.
- Report security issues privately, as described in [SECURITY.md](SECURITY.md).
