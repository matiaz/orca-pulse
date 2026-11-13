import test from "node:test";
import assert from "node:assert/strict";
import { createPulse } from "../src/worker/pulse.mjs";

const URL1 = "https://github.com/acme/app/pull/7";

function makePull(overrides = {}) {
  return { url: URL1, repo: "acme/app", number: 7, title: "Add thing", action: "merge", isDraft: false, author: "me", updatedAt: "2026-11-10T00:00:00Z", mine: true, ...overrides };
}

function fakeSources(state) {
  const calls = [];
  return {
    calls,
    pulls: {
      sync: async () => {
        const notable = state.notable ?? [];
        state.notable = [];
        return { notable };
      },
      snapshot: () => ({ items: state.items, updatedAt: "2026-11-10T00:00:00.000Z", error: null, hint: null }),
    },
    github: { sync: async () => {}, snapshot: () => ({ login: "me", days: {}, updatedAt: null, error: null, hint: null }) },
    claude: { sync: async () => {}, snapshot: () => ({ days: {}, updatedAt: null, error: null, hint: null }) },
    limits: { sync: async () => ({ enabled: false }), snapshot: () => ({ enabled: false }) },
    git: {
      setRoot: (value) => calls.push(["setRoot", value]),
      sync: async () => {},
      select: async (value) => calls.push(["select", value]),
      stageAll: async () => ({}),
      message: async () => ({ message: "main: x" }),
      commit: async (value) => {
        calls.push(["commit", value]);
        return { sha: "abc" };
      },
      pull: async () => ({}),
      push: async () => ({}),
      createPr: async () => ({ url: URL1, number: 7, existing: false }),
      openPrUrl: async () => ({ url: "https://evil.example/x" }),
      snapshot: () => ({ visible: false, repos: [], busy: null, notice: null, ai: true, error: null, hint: null, selected: null }),
    },
  };
}

function harness({ hostCall, state = { items: [makePull()] }, extra = {} } = {}) {
  const handlers = new Map();
  const events = new Map();
  const commands = new Map();
  const posts = [];
  const logs = [];
  const hostCalls = [];
  const disposed = [];
  const timers = { intervals: [], timeouts: [], cleared: [] };
  const clock = { now: 1_000_000 };
  const sources = fakeSources(state);
  const orca = {
    log: (message) => logs.push(message),
    settings: { get: async (key) => (extra.settings ?? {})[key] },
    panels: { handle: (name, fn) => handlers.set(name, fn), post: (name, payload) => posts.push([name, payload]) },
    events: { on: (name, fn) => (events.set(name, fn), { dispose: () => disposed.push(name) }) },
    commands: { register: (id, fn) => (commands.set(id, fn), { dispose: () => disposed.push(id) }) },
    host: {
      has: () => true,
      call: async (method, params) => {
        hostCalls.push([method, params]);
        if (hostCall) return hostCall(method, params);
        if (method === "workspace.list") return { workspaces: [], truncated: false };
        if (method === "workspace.readContext") return null;
        return { ok: true };
      },
    },
  };
  const pulse = createPulse(orca, {
    createSources: () => sources,
    readJson: (_name, fallback) => fallback,
    writeJson: () => {},
    now: () => clock.now,
    timers: {
      setInterval: (fn, ms) => {
        const handle = { fn, ms, unref() {} };
        timers.intervals.push(handle);
        return handle;
      },
      clearInterval: (handle) => timers.cleared.push(handle),
      setTimeout: (fn, ms) => {
        const handle = { fn, ms, unref() {} };
        timers.timeouts.push(handle);
        return handle;
      },
      clearTimeout: (handle) => timers.cleared.push(handle),
    },
    startReview: async (args) => {
      hostCalls.push(["review", args.pr.url]);
      return { workspaceId: "w1" };
    },
    resolveRemotes: async () => ({}),
    copyText: async () => true,
    ...extra.deps,
  });
  return { pulse, handlers, events, commands, posts, logs, hostCalls, disposed, timers, clock, sources, state };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const invalidParams = (error) => error.code === "invalid_params";

test("handlers reject bad input with invalid_params", async () => {
  const h = harness();
  await h.pulse.start();
  const cases = [
    ["heatmap.source", { source: "nope" }],
    ["heatmap.shift", { weeks: 9999 }],
    ["heatmap.shift", { weeks: 1.5 }],
    ["pulls.copy", { url: 5 }],
    ["pulls.review", { url: "x".repeat(501) }],
    ["git.select", {}],
    ["git.pickWorkspace", {}],
    ["git.pickWorkspace", { id: 5 }],
    ["git.pickWorkspace", { id: "x".repeat(201) }],
    ["git.pickWorkspace", { id: "w1", extra: 1 }],
    ["git.commit", { message: 1 }],
    ["git.stageAll", { extra: true }],
    ["pulse.snapshot", "str"],
  ];
  for (const [name, input] of cases) {
    await assert.rejects(() => h.handlers.get(name)(input), invalidParams, `${name} ${JSON.stringify(input)}`);
  }
  h.pulse.dispose();
});

test("registers every documented handler and the refresh command", async () => {
  const h = harness();
  await h.pulse.start();
  const names = ["pulse.snapshot", "heatmap.source", "heatmap.shift", "pulls.copy", "pulls.review", "git.select", "git.pickWorkspace", "git.stageAll", "git.message", "git.commit", "git.pull", "git.push", "git.createPr", "git.openPr", "refresh"];
  for (const name of names) assert.equal(typeof h.handlers.get(name), "function", name);
  assert.equal(await h.commands.get("pulse.refresh")(), "Pulse refreshed");
  assert.ok(h.events.has("workspace.changed") && h.events.has("workspace.created") && h.events.has("workspace.removed") && h.events.has("agent.status.changed"));
  assert.equal(h.handlers.has("debug.focus"), false);
  h.pulse.dispose();
});

test("pulls.review and pulls.copy refuse urls that are not in the snapshot", async () => {
  const h = harness();
  await h.pulse.start();
  await assert.rejects(() => h.handlers.get("pulls.review")({ url: "https://github.com/evil/repo/pull/1" }), invalidParams);
  await assert.rejects(() => h.handlers.get("pulls.copy")({ url: "https://github.com/evil/repo/pull/1" }), invalidParams);
  assert.equal(h.hostCalls.some(([name]) => name === "review"), false);
  const result = await h.handlers.get("pulls.review")({ url: URL1 });
  assert.deepEqual(result, { started: true, workspaceId: "w1" });
  assert.deepEqual(await h.handlers.get("pulls.copy")({ url: URL1 }), { copied: true });
  h.pulse.dispose();
});

test("git.openPr refuses non-github urls", async () => {
  const h = harness();
  await h.pulse.start();
  await assert.rejects(() => h.handlers.get("git.openPr")(), invalidParams);
  h.pulse.dispose();
});

test("action errors keep known codes and drop others", async () => {
  const h = harness();
  h.sources.git.stageAll = async () => {
    throw Object.assign(new Error("no repository"), { code: "no_repo" });
  };
  h.sources.git.pull = async () => {
    throw Object.assign(new Error("spawn failed"), { code: "EACCES" });
  };
  await h.pulse.start();
  await assert.rejects(() => h.handlers.get("git.stageAll")(), (e) => e.code === "no_repo");
  await assert.rejects(() => h.handlers.get("git.pull")(), (e) => e.code === undefined && e.message === "spawn failed");
  h.pulse.dispose();
});

test("snapshot posts only when the JSON changes", async () => {
  const h = harness();
  await h.pulse.start();
  h.posts.length = 0;
  h.pulse.flush();
  h.pulse.flush();
  assert.ok(h.posts.length <= 1);
  const before = h.posts.length;
  h.pulse.flush();
  assert.equal(h.posts.length, before);
  h.state.items = [makePull({ action: "ci failed" })];
  h.pulse.flush();
  assert.equal(h.posts.length, before + 1);
  assert.equal(h.posts.at(-1)[0], "pulse.update");
  assert.equal(h.posts.at(-1)[1].pulls.items[0].action, "ci failed");
  h.pulse.dispose();
});

test("posts are throttled to one per 500 ms", async () => {
  const h = harness();
  await h.pulse.start();
  h.posts.length = 0;
  h.timers.timeouts.length = 0;
  h.clock.now += 10_000;
  h.state.items = [makePull({ title: "one" })];
  await h.handlers.get("heatmap.shift")({ weeks: 1 });
  assert.equal(h.posts.length, 1);
  h.state.items = [makePull({ title: "two" })];
  await h.handlers.get("heatmap.shift")({ weeks: 1 });
  assert.equal(h.posts.length, 1);
  assert.equal(h.timers.timeouts.length, 1);
  h.clock.now += 600;
  h.timers.timeouts[0].fn();
  assert.equal(h.posts.length, 2);
  h.pulse.dispose();
});

test("snapshot handler returns the full shape", async () => {
  const h = harness();
  await h.pulse.start();
  const snapshot = await h.handlers.get("pulse.snapshot")();
  assert.deepEqual(Object.keys(snapshot).sort(), ["focus", "git", "heatmap", "limits", "pulls", "updatedAt"]);
  assert.deepEqual(Object.keys(snapshot.heatmap).sort(), ["claude", "github", "offset", "source"]);
  h.pulse.dispose();
});

test("dispose clears the scheduler interval, timers and subscriptions", async () => {
  const h = harness();
  await h.pulse.start();
  assert.equal(h.timers.intervals.length, 1);
  assert.equal(h.timers.intervals[0].ms, 1000);
  h.events.get("workspace.created")();
  h.pulse.dispose();
  for (const handle of h.timers.intervals) assert.ok(h.timers.cleared.includes(handle));
  for (const handle of h.timers.timeouts) assert.ok(h.timers.cleared.includes(handle));
  assert.ok(h.disposed.includes("workspace.changed") && h.disposed.includes("pulse.refresh"));
});

test("workspace.changed points git at the matching workspace", async () => {
  const workspaces = [{ id: "w1", name: "app", path: "/repo/app", branch: "main", hostId: null }, { id: "w2", name: "other", path: "/repo/other", branch: "dev", hostId: "ssh" }];
  const h = harness({ hostCall: async (method) => (method === "workspace.list" ? { workspaces, truncated: true } : null) });
  await h.pulse.start();
  h.events.get("workspace.changed")({ context: { branch: "main", displayName: "app", terminals: [] } });
  h.events.get("workspace.changed")({ context: null });
  const roots = h.sources.calls.filter(([name]) => name === "setRoot").map(([, value]) => value);
  assert.equal(roots.includes("/repo/app"), true);
  assert.equal(roots.at(-1), null);
  assert.ok(h.logs.some((line) => line.includes("truncated")));
  h.pulse.dispose();
});

test("created and removed events refresh the list after a 1 s debounce", async () => {
  const h = harness();
  await h.pulse.start();
  const before = h.hostCalls.filter(([name]) => name === "workspace.list").length;
  h.timers.timeouts.length = 0;
  h.events.get("workspace.created")({});
  h.events.get("workspace.removed")({});
  assert.equal(h.timers.timeouts.length, 2);
  assert.equal(h.timers.timeouts[1].ms, 1000);
  h.timers.timeouts[1].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.hostCalls.filter(([name]) => name === "workspace.list").length, before + 1);
  h.pulse.dispose();
});

test("start survives failing host calls", async () => {
  const h = harness({ hostCall: async () => { throw Object.assign(new Error("unavailable"), { code: "unavailable" }); } });
  await h.pulse.start();
  assert.ok(h.logs.length > 0);
  assert.equal(typeof (await h.handlers.get("pulse.snapshot")()).pulls, "object");
  h.pulse.dispose();
});

test("notifications are capped, titled and respect the setting", async () => {
  const notable = Array.from({ length: 8 }, (_, i) => makePull({ number: i + 1, url: `https://github.com/acme/app/pull/${i + 1}`, action: i % 2 ? "ci failed" : "merge", title: "t".repeat(400) }));
  const h = harness({ state: { items: [makePull()], notable } });
  await h.pulse.start();
  await settle();
  const shown = h.hostCalls.filter(([name]) => name === "notifications.show");
  assert.equal(shown.length, 5);
  assert.equal(shown[0][1].title, "Ready to merge");
  assert.equal(shown[1][1].title, "CI failed");
  assert.ok(shown.every(([, params]) => params.body.length <= 200));
  h.pulse.dispose();

  const quiet = harness({ state: { items: [makePull()], notable }, extra: { settings: { "notifications.prs": false } } });
  await quiet.pulse.start();
  await settle();
  assert.equal(quiet.hostCalls.some(([name]) => name === "notifications.show"), false);
  quiet.pulse.dispose();
});

test("status bar is updated with the summary", async () => {
  const h = harness();
  await h.pulse.start();
  await settle();
  const update = h.hostCalls.find(([name]) => name === "statusBar.update");
  assert.ok(update);
  assert.equal(update[1].id, "summary");
  assert.equal(update[1].text, "1 to merge");
  assert.equal(update[1].tone, "success");
  h.pulse.dispose();
});

const localWs = (id, path, extra = {}) => ({ id, name: "main", path, branch: "main", hostId: "local", ...extra });
const twoLocal = [localWs("w1", "/work/dev/alpha"), localWs("w2", "/work/projects/beta"), localWs("w3", "/srv/r", { hostId: "ssh:abc" })];
const mainContext = (ids = ["t1"]) => ({ branch: "main", displayName: "main", terminals: ids.map((id) => ({ id, title: "Claude Code" })) });

function ambiguous({ context = mainContext(), workspaces = twoLocal, extra } = {}) {
  return harness({
    extra,
    hostCall: async (method) => {
      if (method === "workspace.list") return { workspaces, truncated: false };
      if (method === "workspace.readContext") return context;
      return null;
    },
  });
}

const rootsOf = (h) => h.sources.calls.filter(([name]) => name === "setRoot").map(([, value]) => value);
const focusOf = async (h) => (await h.handlers.get("pulse.snapshot")()).focus;

test("local workspaces with hostId local are matched by name", async () => {
  const workspaces = [localWs("w1", "/work/dev/alpha", { name: "solo", branch: "solo" })];
  const h = ambiguous({ workspaces, context: { branch: "solo", displayName: "solo", terminals: [] } });
  await h.pulse.start();
  assert.equal(rootsOf(h).at(-1), "/work/dev/alpha");
  assert.deepEqual(await focusOf(h), { via: "name", workspaceId: "w1", candidates: [] });
  h.pulse.dispose();
});

test("ambiguous focus offers local candidates with short labels only", async () => {
  const h = ambiguous();
  await h.pulse.start();
  const focus = await focusOf(h);
  assert.equal(focus.via, null);
  assert.equal(focus.workspaceId, null);
  assert.deepEqual(focus.candidates, [{ id: "w1", label: "dev/alpha" }, { id: "w2", label: "projects/beta" }]);
  assert.equal(JSON.stringify(focus).includes("/work"), false);
  h.pulse.dispose();
});

test("candidates are capped at 100 and empty without local workspaces", async () => {
  const many = Array.from({ length: 130 }, (_, i) => localWs(`w${i}`, `/a/b${i}`));
  const h = ambiguous({ workspaces: many });
  await h.pulse.start();
  assert.equal((await focusOf(h)).candidates.length, 100);
  h.pulse.dispose();
  const none = ambiguous({ workspaces: [localWs("w9", "/a/b", { hostId: "ssh:1" })] });
  await none.pulse.start();
  assert.deepEqual(await focusOf(none), { via: null, workspaceId: null, candidates: [] });
  none.pulse.dispose();
});

test("candidate labels are sanitized", async () => {
  const h = ambiguous({ workspaces: [localWs("w1", "/a/\u001b[31mred/\u0007x"), localWs("w2", "/only")] });
  await h.pulse.start();
  const labels = (await focusOf(h)).candidates.map((entry) => entry.label);
  assert.equal(labels[0], "red/x");
  assert.equal(labels[1], "only");
  h.pulse.dispose();
});

test("agent.status.changed teaches the map and refocuses an unresolved workspace", async () => {
  const h = ambiguous();
  await h.pulse.start();
  h.events.get("agent.status.changed")({ workspaceId: "w2", terminalId: "t1", paneKey: "p", state: "working" });
  assert.equal(rootsOf(h).at(-1), "/work/projects/beta");
  assert.deepEqual(await focusOf(h), { via: "terminal", workspaceId: "w2", candidates: [] });
  h.pulse.dispose();
});

test("agent.status.changed resolves Orca's raw repo::path workspace id", async () => {
  const h = ambiguous();
  await h.pulse.start();
  h.events.get("agent.status.changed")({ workspaceId: "repo-9f2::/work/projects/beta", terminalId: "t1", paneKey: "p", state: "done" });
  assert.equal(rootsOf(h).at(-1), "/work/projects/beta");
  assert.deepEqual(await focusOf(h), { via: "terminal", workspaceId: "w2", candidates: [] });
  h.pulse.dispose();
});

test("agent.status.changed prefers workspaceListId and ignores unknown paths", async () => {
  const h = ambiguous();
  await h.pulse.start();
  const fire = h.events.get("agent.status.changed");
  fire({ workspaceId: "repo::/nowhere", terminalId: "t1" });
  fire({ workspaceId: "repo::/srv/r", terminalId: "t1" });
  assert.equal((await focusOf(h)).via, null);
  fire({ workspaceId: "repo::/work/dev/alpha", workspaceListId: "w2", terminalId: "t1" });
  assert.deepEqual(await focusOf(h), { via: "terminal", workspaceId: "w2", candidates: [] });
  h.pulse.dispose();
});

test("context.workspaceId focuses the exact workspace and beats a pick", async () => {
  const h = ambiguous({ context: { ...mainContext(), workspaceId: "w1" } });
  await h.pulse.start();
  assert.deepEqual(await focusOf(h), { via: "context", workspaceId: "w1", candidates: [] });
  h.events.get("workspace.changed")({ context: { ...mainContext(["t9"]), workspaceId: "w2" } });
  assert.equal(rootsOf(h).at(-1), "/work/projects/beta");
  assert.deepEqual(await focusOf(h), { via: "context", workspaceId: "w2", candidates: [] });
  h.events.get("workspace.changed")({ context: { ...mainContext(["t9"]), workspaceId: "w3" } });
  assert.equal((await focusOf(h)).via, null);
  h.pulse.dispose();
});

test("agent.status.changed upgrades a name match to a terminal match", async () => {
  const workspaces = [localWs("w1", "/a/one", { name: "only", branch: "only" }), localWs("w2", "/a/two", { name: "other", branch: "other" })];
  const h = ambiguous({ workspaces, context: { branch: "only", displayName: "only", terminals: [{ id: "t1" }] } });
  await h.pulse.start();
  assert.equal((await focusOf(h)).via, "name");
  h.events.get("agent.status.changed")({ workspaceId: "w2", terminalId: "t1" });
  assert.deepEqual(await focusOf(h), { via: "terminal", workspaceId: "w2", candidates: [] });
  h.pulse.dispose();
});

test("agent.status.changed for other terminals or bad payloads changes nothing", async () => {
  const h = ambiguous();
  await h.pulse.start();
  const before = rootsOf(h).length;
  const fire = h.events.get("agent.status.changed");
  fire({ workspaceId: "w2", terminalId: "other" });
  fire({ workspaceId: null, terminalId: "t1" });
  fire({ workspaceId: "w2" });
  fire({ workspaceId: "bad id", terminalId: "t1" });
  fire(null);
  fire(undefined);
  fire("x");
  assert.equal(rootsOf(h).length, before);
  assert.equal((await focusOf(h)).via, null);
  h.pulse.dispose();
});

test("agent.status.changed does not override a terminal or picked focus", async () => {
  const h = ambiguous();
  await h.pulse.start();
  await h.handlers.get("git.pickWorkspace")({ id: "w1" });
  const roots = rootsOf(h).length;
  h.events.get("agent.status.changed")({ workspaceId: "w2", terminalId: "t1" });
  assert.equal(rootsOf(h).length, roots);
  assert.deepEqual(await focusOf(h), { via: "pick", workspaceId: "w1", candidates: [] });
  h.pulse.dispose();
});

test("git.pickWorkspace validates the id against local workspaces", async () => {
  const h = ambiguous();
  await h.pulse.start();
  await assert.rejects(() => h.handlers.get("git.pickWorkspace")({ id: "nope" }), invalidParams);
  await assert.rejects(() => h.handlers.get("git.pickWorkspace")({ id: "w3" }), invalidParams);
  assert.equal((await focusOf(h)).via, null);
  h.pulse.dispose();
});

test("git.pickWorkspace sets the root from the workspace list and remembers the terminals", async () => {
  const h = ambiguous({ context: mainContext(["t1", "t2"]) });
  await h.pulse.start();
  const result = await h.handlers.get("git.pickWorkspace")({ id: "w2" });
  assert.deepEqual(result, { ok: true });
  assert.equal(rootsOf(h).at(-1), "/work/projects/beta");
  assert.deepEqual(await focusOf(h), { via: "pick", workspaceId: "w2", candidates: [] });
  h.events.get("workspace.changed")({ context: mainContext(["t2"]) });
  assert.deepEqual(await focusOf(h), { via: "terminal", workspaceId: "w2", candidates: [] });
  assert.equal(rootsOf(h).at(-1), "/work/projects/beta");
  h.pulse.dispose();
});

test("a pick without terminals lasts until the terminal set changes", async () => {
  const h = ambiguous({ context: mainContext([]) });
  await h.pulse.start();
  await h.handlers.get("git.pickWorkspace")({ id: "w1" });
  assert.equal(rootsOf(h).at(-1), "/work/dev/alpha");
  h.events.get("workspace.changed")({ context: mainContext([]) });
  assert.deepEqual(await focusOf(h), { via: "pick", workspaceId: "w1", candidates: [] });
  h.events.get("workspace.changed")({ context: mainContext(["t9"]) });
  const focus = await focusOf(h);
  assert.equal(focus.via, null);
  assert.equal(rootsOf(h).at(-1), null);
  h.pulse.dispose();
});

test("the terminal map is pruned on list refresh and flushed on dispose", async () => {
  const writes = [];
  const stored = { entries: [{ terminalId: "t1", workspaceId: "gone", at: 5 }, { terminalId: "t2", workspaceId: "w1", at: 4 }] };
  const h = ambiguous({
    context: mainContext(["t1"]),
    extra: { deps: { readJson: (name, fallback) => (name === "terminals.json" ? stored : fallback), writeJson: (name, value) => writes.push([name, value]) } },
  });
  await h.pulse.start();
  assert.equal((await focusOf(h)).via, null);
  h.pulse.dispose();
  const saved = writes.filter(([name]) => name === "terminals.json").at(-1);
  assert.deepEqual(saved[1].entries.map((entry) => entry.workspaceId), ["w1"]);
});

test("workspace.changed handler keeps working when agent events throw", async () => {
  const h = ambiguous();
  await h.pulse.start();
  assert.doesNotThrow(() => h.events.get("agent.status.changed")({ get terminalId() { throw new Error("x"); } }));
  h.pulse.dispose();
});
