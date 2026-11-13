import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError, parseCommit, parseNone, parsePath, parseWorkspaceId, parseShift, parseSource, parseUrl } from "../src/worker/validate.mjs";

const rejects = (fn, input) => assert.throws(() => fn(input), (error) => error.code === "invalid_params");

test("parseSource accepts only github or claude", () => {
  assert.deepEqual(parseSource({ source: "claude" }), { source: "claude" });
  for (const bad of [undefined, null, {}, { source: "x" }, { source: 1 }, { source: "github", extra: 1 }, [], "github"]) rejects(parseSource, bad);
});

test("parseShift requires integers in range", () => {
  assert.deepEqual(parseShift({ weeks: 0 }), { weeks: 0 });
  assert.deepEqual(parseShift({ weeks: -520 }), { weeks: -520 });
  assert.deepEqual(parseShift({ weeks: 520 }), { weeks: 520 });
  for (const bad of [{ weeks: 521 }, { weeks: -521 }, { weeks: 1.5 }, { weeks: "4" }, { weeks: NaN }, {}, undefined]) rejects(parseShift, bad);
});

test("parseUrl and parsePath require bounded strings", () => {
  assert.deepEqual(parseUrl({ url: "https://github.com/a/b/pull/1" }), { url: "https://github.com/a/b/pull/1" });
  for (const bad of [{}, { url: "" }, { url: 5 }, { url: "x".repeat(501) }, { url: "a", more: 1 }]) rejects(parseUrl, bad);
  assert.deepEqual(parsePath({ path: "/tmp/repo" }), { path: "/tmp/repo" });
  for (const bad of [{}, { path: "" }, { path: {} }, { path: "y".repeat(501) }]) rejects(parsePath, bad);
});

test("parseCommit treats blank messages as absent and bounds length", () => {
  assert.deepEqual(parseCommit(undefined), { message: undefined });
  assert.deepEqual(parseCommit({}), { message: undefined });
  assert.deepEqual(parseCommit({ message: "   " }), { message: undefined });
  assert.deepEqual(parseCommit({ message: "fix: a" }), { message: "fix: a" });
  for (const bad of [{ message: 5 }, { message: "z".repeat(501) }, { message: "a", other: 1 }, "x"]) rejects(parseCommit, bad);
});

test("parseNone accepts empty input only", () => {
  assert.deepEqual(parseNone(undefined), {});
  assert.deepEqual(parseNone({}), {});
  rejects(parseNone, { a: 1 });
  rejects(parseNone, JSON.parse('{"__proto__": {}}'));
});

test("friendlyError keeps known codes and strips the rest", () => {
  const busy = Object.assign(new Error("another action is running"), { code: "busy" });
  assert.equal(friendlyError(busy).code, "busy");
  const other = Object.assign(new Error("boom\u001b[31m"), { code: "ENOENT" });
  const mapped = friendlyError(other);
  assert.equal(mapped.code, undefined);
  assert.equal(mapped.message, "boom");
  assert.equal(friendlyError("text").message, "text");
});

test("parseWorkspaceId requires a bounded id and nothing else", () => {
  assert.deepEqual(parseWorkspaceId({ id: "identity:wt2:local:abc" }), { id: "identity:wt2:local:abc" });
  assert.deepEqual(parseWorkspaceId({ id: "x".repeat(200) }), { id: "x".repeat(200) });
  for (const bad of [undefined, null, {}, { id: "" }, { id: 5 }, { id: "x".repeat(201) }, { id: "a", extra: 1 }, [], "a"]) rejects(parseWorkspaceId, bad);
});
