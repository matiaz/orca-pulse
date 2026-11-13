import test from "node:test";
import assert from "node:assert/strict";
import { clean, isPullUrl, isGithubUrl, isPrivatePath } from "../src/lib/sanitize.mjs";

test("clean strips bidi override characters", () => {
  assert.equal(clean("\u202eevil"), "evil");
  assert.equal(clean("a\u2066b\u2069c\u200ed\u200fe\u061cf"), "abcdef");
});

test("clean strips invisible format characters", () => {
  assert.equal(clean("a\u200bb"), "ab");
  assert.equal(clean("a\u{E0041}b"), "ab");
  assert.equal(clean("\ufeffa"), "a");
  assert.equal(clean("a\u00adb"), "ab");
  assert.equal(clean("a\ufe0fb"), "ab");
});

test("clean turns line and paragraph separators into spaces", () => {
  assert.equal(clean("a\u2028b\u2029c"), "a b c");
});

test("clean strips ANSI CSI sequences completely", () => {
  assert.equal(clean("\x1b[31mred\x1b[0m"), "red");
  assert.equal(clean("\x1b[1;38;5;196mx\x1b[K"), "x");
});

test("clean strips OSC sequences", () => {
  assert.equal(clean("\x1b]0;title\x07text"), "text");
  assert.equal(clean("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link");
});

test("clean strips remaining control chars, DEL and C1", () => {
  assert.equal(clean("a\x00b\x07c\x7fd\x85e\x9bf"), "abcdef");
  assert.equal(clean("a\x1bb"), "ab");
});

test("clean collapses whitespace", () => {
  assert.equal(clean("a\n\tb"), "a b");
  assert.equal(clean("  a   b \r\n c  "), "a b c");
});

test("clean coerces non-strings", () => {
  assert.equal(clean(null), "");
  assert.equal(clean(undefined), "");
  assert.equal(clean(42), "42");
});

test("clean truncates with ellipsis", () => {
  const out = clean("x".repeat(300));
  assert.equal(out.length, 200);
  assert.ok(out.endsWith("…"));
  assert.equal(clean("abcdef", 4), "abc…");
  assert.equal(clean("abcd", 4), "abcd");
});

test("isPullUrl", () => {
  assert.equal(isPullUrl("https://github.com/o-1/r.x/pull/42"), true);
  assert.equal(isPullUrl("https://github.com/a/b/pull/1/files"), false);
  assert.equal(isPullUrl("http://github.com/a/b/pull/1"), false);
  assert.equal(isPullUrl("https://github.com.evil.com/a/b/pull/1"), false);
  assert.equal(isPullUrl("https://github.com/a/b/pull/1;rm"), false);
  assert.equal(isPullUrl(null), false);
  assert.equal(isPullUrl(5), false);
});

test("isGithubUrl", () => {
  assert.equal(isGithubUrl("https://github.com/x/y"), true);
  assert.equal(isGithubUrl("https://user@github.com/x"), false);
  assert.equal(isGithubUrl("https://user:pw@github.com/x"), false);
  assert.equal(isGithubUrl("https://github.com:444/x"), false);
  assert.equal(isGithubUrl("javascript:alert(1)"), false);
  assert.equal(isGithubUrl("http://github.com/x"), false);
  assert.equal(isGithubUrl("https://github.com.evil.com/x"), false);
  assert.equal(isGithubUrl("nope"), false);
  assert.equal(isGithubUrl(undefined), false);
});

test("isPrivatePath true cases", () => {
  for (const p of [
    "config/.env.local", ".env", "certs/server.PEM", "a/b.key", "x.p12", "x.pfx",
    "home/id_rsa", "id_rsa.pub", "id_ed25519", "id_ecdsa", "my_secret.txt", "Secrets.json",
    "aws/credentials", "credentials.json", "package-lock.json", "a/yarn.lock", "pnpm-lock.yaml",
    "bun.lockb", "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock", "go.sum",
    "flake.lock", "deno-lock.json", "x/npm-shrinkwrap.json",
    "secrets/prod.yaml", "a/Secrets/b/c.txt", "credentials/aws.json", "my-credential-store/x.json",
    ".npmrc", "a/.netrc", ".pypirc", ".git-credentials", "infra/terraform.tfstate",
    "infra/terraform.tfstate.backup", "prod.tfvars", "a/app.jks", "a/release.keystore", "vault.kdbx",
    "a\\secrets\\b.yaml", "AuthKey_ABC123.p8", "putty.ppk", "backup.tar.gpg", "keys/private.asc",
    "vpn/office.ovpn", "home/id_dsa", "id_dsa.pub", "kubeconfig", ".kube/KubeConfig", "gcp-service-account.json",
    "deploy/my-service-account-prod.json", ".htpasswd", "a/.dockercfg",
  ]) assert.equal(isPrivatePath(p), true, p);
});

test("isPrivatePath false cases", () => {
  for (const p of ["src/env.ts", "README.md", "src/keyboard.js", "environment.md", "", "src/tfvars.md", "docs/npmrc.md", "docs/service-account.md", "src/kubeconfig.ts", "src/gpg.js"]) {
    assert.equal(isPrivatePath(p), false, p);
  }
  assert.equal(isPrivatePath(null), false);
});

import { capText, cleanMultiline } from "../src/lib/sanitize.mjs";

test("cleanMultiline keeps newlines and strips controls, escapes and invisibles", () => {
  assert.equal(cleanMultiline("a\r\nb\u0000c\u001b[31md\u001b[0m\u202ee"), "a\nbcde");
  assert.equal(cleanMultiline("x\u200by\tz"), "xy\tz");
  assert.equal(cleanMultiline("a\n\n\n\n\nb  \nc"), "a\n\nb\nc");
  assert.equal(cleanMultiline("a\u2028b"), "a\nb");
});

test("cleanMultiline caps length and tolerates non-strings", () => {
  assert.equal(cleanMultiline("abcdef", 3), "abc");
  assert.equal(cleanMultiline(null), "");
});

test("cleanMultiline keeps ZWJ, variation selectors and tabs", () => {
  assert.equal(cleanMultiline("\u{1F468}\u200d\u{1F469}"), "\u{1F468}\u200d\u{1F469}");
  assert.equal(cleanMultiline("❤️"), "❤️");
  assert.equal(cleanMultiline("a\tb\n\tc"), "a\tb\n\tc");
});

test("cleanMultiline strips bidi, tag, zero-width and soft-hyphen characters", () => {
  for (const ch of ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "؜", "\u200b", "\ufeff", "­", "\u{E0041}", "\u{E0001}", "⁠"]) {
    assert.equal(cleanMultiline(`a${ch}b`), "ab", ch.codePointAt(0).toString(16));
  }
});

test("cleanMultiline closes a code fence left open by truncation", () => {
  const text = "```js\nconst a = 1;\nconst b = 2;\n```\n";
  const cut = cleanMultiline(`${text}\n\`\`\`\nlong tail that is cut`, 24);
  assert.equal((cut.match(/```/g) ?? []).length % 2, 0);
  assert.ok(cut.endsWith("\n```"));
  assert.equal(cleanMultiline("```a```", 100), "```a```");
});

test("capText drops a dangling high surrogate", () => {
  assert.equal(capText("ab\u{1F600}", 3), "ab");
  assert.equal(capText("ab\u{1F600}", 4), "ab\u{1F600}");
  assert.equal(capText(null, 3), "");
});
