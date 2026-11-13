import test from "node:test";
import assert from "node:assert/strict";
import { copyToClipboard } from "../src/worker/clipboard.mjs";

test("darwin uses pbcopy with the value on stdin", async () => {
  const calls = [];
  const run = async (bin, args, opts) => {
    calls.push([bin, args, opts.input]);
    return { code: 0 };
  };
  assert.equal(await copyToClipboard("https://github.com/a/b/pull/1", { platform: "darwin", run }), true);
  assert.deepEqual(calls, [["pbcopy", [], "https://github.com/a/b/pull/1"]]);
});

test("linux falls through missing tools", async () => {
  const calls = [];
  const run = async (bin, args) => {
    calls.push(bin);
    if (bin === "wl-copy") throw Object.assign(new Error("nope"), { code: "ENOENT" });
    if (bin === "xclip") return { code: 1 };
    return { code: 0 };
  };
  assert.equal(await copyToClipboard("v", { platform: "linux", run }), true);
  assert.deepEqual(calls, ["wl-copy", "xclip", "xsel"]);
});

test("returns false when nothing works", async () => {
  const run = async () => {
    throw new Error("x");
  };
  assert.equal(await copyToClipboard("v", { platform: "linux", run }), false);
});
