import test from "node:test";
import assert from "node:assert/strict";
import { describeError, ghGraphql, HINT_INSTALL_GH, HINT_AUTH_GH } from "../src/lib/ghcall.mjs";

test("describeError maps ENOENT to the install hint", () => {
  const out = describeError(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
  assert.equal(out.hint, "Install the GitHub CLI (gh) and run gh auth login");
  assert.equal(out.hint, HINT_INSTALL_GH);
  assert.ok(out.error.length > 0);
});

test("describeError maps auth failures to the login hint", () => {
  for (const message of ["To get started with GitHub CLI, please run:  gh auth login", "gh: Bad credentials (HTTP 401)", "You are not logged in to any hosts"]) {
    assert.equal(describeError(new Error(message)).hint, HINT_AUTH_GH, message);
  }
  assert.equal(HINT_AUTH_GH, "Run gh auth login");
});

test("describeError cleans the message and gives no hint otherwise", () => {
  const out = describeError(new Error("boom\u202e\x1b[31m red"));
  assert.equal(out.error, "boom red");
  assert.equal(out.hint, null);
});

test("ghGraphql returns data on success and passes args through", async () => {
  let received;
  const gh = async (args) => {
    received = args;
    return { code: 0, stdout: JSON.stringify({ data: { a: 1 } }), stderr: "" };
  };
  assert.deepEqual(await ghGraphql(gh, ["-f", "query=q"]), { a: 1 });
  assert.deepEqual(received, ["api", "graphql", "-f", "query=q"]);
});

test("ghGraphql throws a cleaned error on non-zero exit", async () => {
  const gh = async () => ({ code: 4, stdout: "", stderr: "gh: please run gh auth login\n" });
  await assert.rejects(() => ghGraphql(gh, []), /gh auth login/);
});

test("ghGraphql throws on invalid JSON and on missing data", async () => {
  await assert.rejects(() => ghGraphql(async () => ({ code: 0, stdout: "nope", stderr: "" }), []), /invalid/);
  await assert.rejects(() => ghGraphql(async () => ({ code: 0, stdout: "{}", stderr: "" }), []), /unexpected/);
});

test("ghGraphql lets ENOENT propagate", async () => {
  const gh = async () => {
    throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  };
  const error = await ghGraphql(gh, []).catch((e) => e);
  assert.equal(error.code, "ENOENT");
});
