import { clean, isGithubUrl } from "../lib/sanitize.mjs";
import { createTerminalMap } from "../lib/terminal-map.mjs";
import { isLocal, matchFocused, resolveWorkspaceId } from "../lib/workspaces.mjs";
import { addDays } from "../lib/days.mjs";
import { createReviewStore } from "../lib/review-store.mjs";
import { git as execGit } from "../lib/exec.mjs";
import { resolveRemotes as defaultResolveRemotes, startReview as defaultStartReview } from "../sources/review.mjs";
import { copyToClipboard } from "./clipboard.mjs";
import { canMerge, mergeKey, pickMerge, pickReview, scopePulls } from "./automation.mjs";
import { createScheduler } from "./scheduler.mjs";
import { buildSnapshot, startOfDay } from "./snapshot.mjs";
import { statusSummary } from "./status.mjs";
import { KEPT_CODES, MAX_OFFSET, friendlyError, invalid, parseCommit, parseNone, parsePath, parseShift, parseSource, parseUrl, parseWorkspaceId } from "./validate.mjs";

export const DEFAULTS = {
  "claude.planLimits": true,
  "heatmap.defaultSource": "github",
  "notifications.prs": true,
  "git.aiMessages": true,
  "claude.configDir": "",
  "pulls.scope": "open",
  "reviews.auto": true,
  "reviews.autoApprove": false,
  "reviews.autoMerge": false,
  "reviews.mergeMethod": "squash",
  "reviews.loopMinutes": 10,
};
const CHOICES = {
  "pulls.scope": ["workspace", "open", "all"],
  "reviews.mergeMethod": ["squash", "merge", "rebase"],
};
const SETTINGS_EVERY_MS = 5000;
const POST_EVERY_MS = 500;
const PANEL_ACTIVE_MS = 60 * 1000;
const REMOTES_EVERY_MS = 60 * 1000;
const LIST_DEBOUNCE_MS = 1000;
const REFRESH_COOLDOWN_MS = 3000;
const MAX_NOTIFICATIONS = 5;
const MAX_CANDIDATES = 100;
const MAX_TERMINALS = 50;
const PANEL_FIELDS = ["url", "repo", "number", "title", "action", "isDraft", "author", "updatedAt", "mine"];
const METHOD_NAMES = { squash: "squash merging", merge: "merge commits", rebase: "rebase merging" };

function busyError(message) {
  const error = new Error(message);
  error.code = "busy";
  return error;
}

function normalizeWorkspace(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.path !== "string") return null;
  return {
    id: item.id,
    name: typeof item.name === "string" ? item.name : "",
    path: item.path,
    branch: typeof item.branch === "string" ? item.branch : null,
    hostId: typeof item.hostId === "string" ? item.hostId : null,
  };
}

function normalizeContext(context) {
  if (!context || typeof context !== "object") return null;
  const id = context.workspaceId;
  return {
    workspaceId: typeof id === "string" && id.length > 0 && id.length <= 2048 ? id : null,
    branch: typeof context.branch === "string" ? context.branch : "",
    displayName: typeof context.displayName === "string" ? context.displayName : "",
    terminals: (Array.isArray(context.terminals) ? context.terminals : [])
      .map((terminal) => terminal?.id)
      .filter((id) => typeof id === "string")
      .slice(0, MAX_TERMINALS),
  };
}

function workspaceLabel(item) {
  const segments = item.path.split(/[\\/]+/).filter(Boolean);
  return clean(segments.slice(-2).join("/"), 80) || clean(item.name, 80) || "workspace";
}

export function createPulse(orca, deps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const resolveRemotes = deps.resolveRemotes ?? ((list) => defaultResolveRemotes(execGit, list));
  const startReview = deps.startReview ?? defaultStartReview;
  const copyText = deps.copyText ?? ((value) => copyToClipboard(value));
  const subscriptions = [];
  const settings = new Map(Object.entries(DEFAULTS));
  const setting = (key) => settings.get(key);
  const choice = (key) => (CHOICES[key].includes(setting(key)) ? setting(key) : DEFAULTS[key]);
  const flag = (key) => (typeof setting(key) === "boolean" ? setting(key) : DEFAULTS[key]);
  const { pulls, github, claude, limits, git, merge } = deps.createSources(setting);

  const log = (message) => {
    try {
      orca.log(clean(message, 200));
    } catch {}
  };
  const logError = (label, error) => {
    if (KEPT_CODES.has(error?.code)) return;
    log(`${label}: ${clean(error?.code ?? "", 30)} ${clean(error?.message ?? error, 120)}`.replace(/\s+/g, " "));
  };
  const hasHost = (name) => (typeof orca.host?.has === "function" ? orca.host.has(name) !== false : true);

  let disposed = false;
  let lastPanelAt = -Infinity;
  let lastJson = null;
  let lastPostAt = -Infinity;
  let postTimer = null;
  let listTimer = null;
  let lastStatus = null;
  let lastForceAt = -Infinity;
  let settingsAt = -Infinity;
  let settingsPending = null;
  let workspaces = [];
  let context = null;
  let focusedId = null;
  let focusVia = null;
  let pickedId = null;
  let pickedKey = "";
  let hasRoot = false;
  let remotes = Object.create(null);
  let remotesAt = -Infinity;
  let truncatedLogged = false;
  const reviewing = new Set();
  const reviews = createReviewStore({ readJson: deps.readJson, writeJson: deps.writeJson, now });
  const terminalMap = createTerminalMap({ readJson: deps.readJson, writeJson: deps.writeJson, now });
  const terminalKey = () => (context?.terminals ?? []).slice().sort().join(",");

  function loadView() {
    let stored = null;
    try {
      stored = deps.readJson("view.json", null);
    } catch {}
    return {
      source: stored?.source === "github" || stored?.source === "claude" ? stored.source : null,
      offset: Number.isInteger(stored?.offset) && stored.offset >= 0 && stored.offset <= MAX_OFFSET ? stored.offset : 0,
    };
  }
  const view = loadView();
  const currentSource = () => view.source ?? (setting("heatmap.defaultSource") === "claude" ? "claude" : "github");

  function persistView() {
    try {
      deps.writeJson("view.json", { source: view.source, offset: view.offset });
    } catch (error) {
      logError("view save", error);
    }
  }

  function heatmapRange() {
    if (view.offset === 0) return {};
    const to = addDays(startOfDay(now()), -7 * view.offset);
    return { from: addDays(to, -364), to };
  }

  function refreshSettings(force = false) {
    if (settingsPending) return settingsPending;
    if (!force && now() - settingsAt < SETTINGS_EVERY_MS) return Promise.resolve();
    settingsAt = now();
    settingsPending = Promise.all(
      Object.keys(DEFAULTS).map(async (key) => {
        try {
          const value = await orca.settings.get(key);
          if (value !== undefined && value !== null) settings.set(key, value);
        } catch (error) {
          logError("settings", error);
        }
      }),
    ).finally(() => {
      settingsPending = null;
    });
    return settingsPending;
  }

  function focusView() {
    const candidates =
      focusVia === null
        ? workspaces
            .filter(isLocal)
            .slice(0, MAX_CANDIDATES)
            .map((item) => ({ id: item.id, label: workspaceLabel(item) }))
        : [];
    return { via: focusVia, workspaceId: focusedId, candidates };
  }

  function panelItem(item) {
    const out = {};
    for (const key of PANEL_FIELDS) out[key] = item[key];
    const note = reviews.get(item.url)?.mergeError;
    if (note) out.note = note;
    return out;
  }

  const scoped = (items) => scopePulls(items.filter((item) => item.listed !== false), { scope: choice("pulls.scope"), workspaces, remotes, focusedId });

  function scopedPulls() {
    const snapshot = pulls.snapshot();
    const { items, scope } = scoped(snapshot.items);
    return { ...snapshot, items, scope };
  }

  function pullsView() {
    const view = scopedPulls();
    return { ...view, items: view.items.map(panelItem) };
  }

  function currentSnapshot() {
    return buildSnapshot({
      view: { source: currentSource(), offset: view.offset },
      github: github.snapshot(),
      claude: claude.snapshot(),
      limits: limits.snapshot(),
      pulls: pullsView(),
      git: git.snapshot(),
      focus: focusView(),
      now: now(),
    });
  }

  function flush() {
    if (disposed) return false;
    try {
      const snapshot = currentSnapshot();
      const json = JSON.stringify(snapshot);
      if (json === lastJson) return false;
      lastJson = json;
      lastPostAt = now();
      orca.panels.post("pulse.update", snapshot);
      return true;
    } catch (error) {
      logError("post", error);
      return false;
    }
  }

  function emit() {
    if (disposed) return;
    const wait = lastPostAt + POST_EVERY_MS - now();
    if (wait > 0) {
      if (postTimer) return;
      postTimer = timers.setTimeout(() => {
        postTimer = null;
        flush();
      }, wait);
      postTimer?.unref?.();
      return;
    }
    flush();
  }

  function background(label, work) {
    Promise.resolve()
      .then(work)
      .catch((error) => logError(label, error))
      .then(emit);
  }

  async function updateStatusBar() {
    if (disposed || !hasHost("statusBar.update")) return;
    const summary = statusSummary(scopedPulls(), limits.snapshot());
    const json = JSON.stringify(summary);
    if (json === lastStatus) return;
    try {
      await orca.host.call("statusBar.update", { id: "summary", ...summary });
      lastStatus = json;
    } catch (error) {
      logError("status bar", error);
    }
  }

  async function alert(title, body) {
    if (setting("notifications.prs") === false || !hasHost("notifications.show")) return;
    try {
      await orca.host.call("notifications.show", { title, body: clean(body, 200) });
    } catch (error) {
      logError("notify", error);
    }
  }

  async function notify(notable) {
    if (!Array.isArray(notable) || !notable.length) return;
    for (const item of scoped(notable).items.slice(0, MAX_NOTIFICATIONS)) {
      await alert(item.action === "merge" ? "Ready to merge" : "CI failed", `${item.repo}#${item.number} ${item.title}`);
    }
  }

  async function autoReview(items) {
    if (!flag("reviews.auto")) return;
    const pr = pickReview(items, { workspaces, remotes, store: reviews });
    if (!pr || reviewing.has(pr.url)) return;
    reviewing.add(pr.url);
    reviews.record(pr.url);
    try {
      await startReview({ host: orca.host, pr, focusedId, workspaces, remotes, autoApprove: flag("reviews.autoApprove"), loopMinutes: setting("reviews.loopMinutes"), fallback: false });
      await alert("Review started", `Pulse started reviewing ${pr.repo}#${pr.number}`);
    } catch (error) {
      reviews.update(pr.url, { launchError: clean(error?.message ?? error, 200) || "launch failed" });
      log(`auto review: ${clean(error?.message ?? error, 120)}`);
    } finally {
      reviewing.delete(pr.url);
    }
  }

  async function autoMerge(items) {
    if (!flag("reviews.autoMerge")) return;
    const method = choice("reviews.mergeMethod");
    const pr = pickMerge(items, reviews, method);
    if (!pr) return;
    const { pr: fresh, allowed } = await merge.check(pr);
    if (!canMerge(fresh, reviews.get(pr.url), method)) return;
    const key = mergeKey(fresh, method);
    if (allowed?.[method] !== true) {
      reviews.update(pr.url, { mergeError: `Not merged: this repository does not allow ${METHOD_NAMES[method]}`, mergeKey: key });
      return;
    }
    const label = `${pr.repo}#${pr.number}`;
    try {
      await merge.merge(fresh, method);
      reviews.update(pr.url, { mergeError: null, mergeKey: key });
      await alert("Pull request merged", `Pulse merged ${label}`);
    } catch (error) {
      const message = clean(error?.message ?? error, 200) || "merge failed";
      reviews.update(pr.url, { mergeError: `Merge failed: ${message}`, mergeKey: key });
      await alert("Merge failed", `${label}: ${message}`);
    }
  }

  async function automate() {
    const items = pulls.snapshot().items;
    reviews.seen(items.map((item) => item.url));
    for (const [label, work] of [["auto review", autoReview], ["auto merge", autoMerge]]) {
      try {
        await work(items);
      } catch (error) {
        logError(label, error);
      }
    }
  }

  async function syncPulls(force = false) {
    const result = await pulls.sync(force);
    if (result?.fetched) await refreshRemotes(false);
    await notify(result?.notable);
    if (result?.fetched) await automate();
    await updateStatusBar();
    emit();
  }

  async function syncLimits(force = false) {
    await limits.sync(force);
    await updateStatusBar();
    emit();
  }

  async function syncGithub(force = false) {
    await github.sync(force, heatmapRange());
    emit();
  }

  async function syncClaude(force = false) {
    await claude.sync(force);
    emit();
  }

  async function syncGit(force = false) {
    await git.sync(force);
    emit();
  }

  const gitWanted = () => now() - lastPanelAt < PANEL_ACTIVE_MS || hasRoot;

  const scheduler = createScheduler({
    now,
    timers,
    before: () => refreshSettings(false),
    onError: logError,
    tasks: [
      { name: "git", everyMs: 2000, when: gitWanted, run: () => syncGit(false) },
      { name: "pulls", run: () => syncPulls(false) },
      { name: "github", run: () => syncGithub(false) },
      { name: "claude", run: () => syncClaude(false) },
      { name: "limits", run: () => syncLimits(false) },
    ],
  });

  async function forceAll() {
    if (now() - lastForceAt < REFRESH_COOLDOWN_MS) return;
    lastForceAt = now();
    await refreshSettings(true);
    const jobs = [() => syncPulls(true), () => syncGithub(true), () => syncClaude(true), () => syncLimits(true), () => syncGit(true)];
    const results = await Promise.allSettled(jobs.map((job) => Promise.resolve().then(job)));
    for (const result of results) if (result.status === "rejected") logError("refresh", result.reason);
    emit();
  }

  function applyFocus() {
    let match = null;
    const picked = pickedId ? workspaces.find((item) => item.id === pickedId && isLocal(item)) : null;
    if (context?.workspaceId) match = matchFocused(context, workspaces, terminalMap);
    else if (picked) match = { workspace: picked, via: "pick" };
    else match = matchFocused(context, workspaces, terminalMap);
    focusVia = match?.via ?? null;
    focusedId = match?.workspace.id ?? null;
    hasRoot = Boolean(match?.workspace.path);
    git.setRoot(match?.workspace.path ?? null);
  }

  async function refreshRemotes(force) {
    if (!force && now() - remotesAt < REMOTES_EVERY_MS) return;
    remotesAt = now();
    try {
      remotes = await resolveRemotes(workspaces);
    } catch (error) {
      logError("remotes", error);
    }
  }

  async function loadWorkspaces() {
    if (!hasHost("workspace.list")) return;
    try {
      const result = await orca.host.call("workspace.list", {});
      workspaces = (Array.isArray(result?.workspaces) ? result.workspaces : []).map(normalizeWorkspace).filter(Boolean);
      if (result?.truncated === true) {
        if (!truncatedLogged) {
          truncatedLogged = true;
          log("workspace list truncated");
        }
      } else {
        terminalMap.prune(workspaces.map((item) => item.id));
      }
    } catch (error) {
      logError("workspace.list", error);
    }
    applyFocus();
  }

  async function loadContext() {
    if (!hasHost("workspace.readContext")) return;
    try {
      context = normalizeContext(await orca.host.call("workspace.readContext", {}));
    } catch (error) {
      logError("workspace.readContext", error);
    }
  }

  function scheduleListRefresh() {
    if (disposed) return;
    if (listTimer) timers.clearTimeout(listTimer);
    listTimer = timers.setTimeout(() => {
      listTimer = null;
      background("workspaces", async () => {
        await loadWorkspaces();
        await refreshRemotes(false);
        await git.sync(true);
      });
    }, LIST_DEBOUNCE_MS);
    listTimer?.unref?.();
  }

  function findPull(url) {
    const item = pulls.snapshot().items.find((entry) => entry.url === url);
    if (!item) throw invalid("unknown pull request");
    return item;
  }

  function handle(name, parse, work) {
    orca.panels.handle(name, async (input) => {
      try {
        lastPanelAt = now();
        const params = parse(input);
        return await work(params);
      } catch (error) {
        logError(name, error);
        throw friendlyError(error);
      }
    });
  }

  async function gitAction(work) {
    try {
      return await work();
    } finally {
      emit();
    }
  }

  function register() {
    handle("pulse.snapshot", parseNone, async () => {
      background("tick", () => scheduler.tick());
      return currentSnapshot();
    });
    handle("heatmap.source", parseSource, async ({ source }) => {
      view.source = source;
      persistView();
      if (source === "github") background("github", () => syncGithub(false));
      emit();
      return { source };
    });
    handle("heatmap.shift", parseShift, async ({ weeks }) => {
      view.offset = weeks === 0 ? 0 : Math.min(MAX_OFFSET, Math.max(0, view.offset + weeks));
      persistView();
      if (currentSource() === "github") background("github", () => syncGithub(false));
      emit();
      return { offset: view.offset };
    });
    handle("pulls.copy", parseUrl, async ({ url }) => {
      const item = findPull(url);
      return { copied: await copyText(item.url) };
    });
    handle("pulls.review", parseUrl, async ({ url }) => {
      const item = findPull(url);
      if (reviewing.has(item.url)) throw busyError("review already starting");
      reviewing.add(item.url);
      try {
        await refreshRemotes(false);
        const result = await startReview({ host: orca.host, pr: item, focusedId, workspaces, remotes, autoApprove: flag("reviews.autoApprove"), loopMinutes: setting("reviews.loopMinutes") });
        reviews.record(item.url);
        return { started: true, workspaceId: result.workspaceId };
      } finally {
        reviewing.delete(item.url);
      }
    });
    handle("git.select", parsePath, ({ path }) => gitAction(async () => {
      await git.select(path);
      return { ok: true };
    }));
    handle("git.pickWorkspace", parseWorkspaceId, ({ id }) => gitAction(async () => {
      const item = workspaces.find((entry) => entry.id === id && isLocal(entry));
      if (!item) throw invalid("unknown workspace");
      for (const terminalId of context?.terminals ?? []) terminalMap.learn(terminalId, item.id);
      pickedId = item.id;
      pickedKey = terminalKey();
      applyFocus();
      background("git", () => git.sync(true));
      return { ok: true };
    }));
    handle("git.stageAll", parseNone, () => gitAction(() => git.stageAll()));
    handle("git.message", parseNone, () => gitAction(() => git.message()));
    handle("git.commit", parseCommit, ({ message }) => gitAction(() => git.commit(message)));
    handle("git.pull", parseNone, () => gitAction(() => git.pull()));
    handle("git.push", parseNone, () => gitAction(() => git.push()));
    handle("git.createPr", parseNone, () => gitAction(() => git.createPr()));
    handle("git.openPr", parseNone, async () => {
      const result = await git.openPrUrl();
      if (!isGithubUrl(result?.url)) throw invalid("invalid pull request url");
      return { url: result.url };
    });
    handle("refresh", parseNone, async () => {
      await forceAll();
      return { ok: true };
    });

    subscriptions.push(
      orca.commands.register("pulse.refresh", async () => {
        try {
          await forceAll();
        } catch (error) {
          logError("pulse.refresh", error);
        }
        return "Pulse refreshed";
      }),
    );
    subscriptions.push(
      orca.events.on("workspace.changed", (payload) => {
        try {
          context = normalizeContext(payload?.context);
          if (pickedId && terminalKey() !== pickedKey) pickedId = null;
          applyFocus();
          background("git", () => git.sync(true));
        } catch (error) {
          logError("workspace.changed", error);
        }
      }),
    );
    subscriptions.push(
      orca.events.on("agent.status.changed", (payload) => {
        try {
          const terminalId = payload?.terminalId;
          if (typeof terminalId !== "string") return;
          const workspaceId = resolveWorkspaceId(payload?.workspaceListId, workspaces) ?? resolveWorkspaceId(payload?.workspaceId, workspaces);
          if (!workspaceId) return;
          terminalMap.learn(terminalId, workspaceId);
          if (terminalMap.resolve([terminalId]) !== workspaceId) return;
          if (!context?.terminals.includes(terminalId)) return;
          if (focusVia !== null && focusVia !== "name") return;
          applyFocus();
          background("git", () => git.sync(true));
        } catch (error) {
          logError("agent.status.changed", error);
        }
      }),
    );
    for (const event of ["workspace.created", "workspace.removed"]) {
      subscriptions.push(orca.events.on(event, scheduleListRefresh));
    }
  }

  return {
    async start() {
      try {
        register();
      } catch (error) {
        logError("register", error);
      }
      try {
        await refreshSettings(true);
        await loadContext();
        await loadWorkspaces();
        await refreshRemotes(true);
      } catch (error) {
        logError("start", error);
      }
      scheduler.start();
      background("tick", () => scheduler.tick());
    },
    dispose() {
      disposed = true;
      scheduler.stop();
      if (postTimer) timers.clearTimeout(postTimer);
      if (listTimer) timers.clearTimeout(listTimer);
      postTimer = null;
      listTimer = null;
      terminalMap.flush();
      for (const subscription of subscriptions.splice(0)) {
        try {
          subscription?.dispose?.();
        } catch {}
      }
    },
    flush,
    tick: () => scheduler.tick(),
    forceAll,
    snapshot: currentSnapshot,
  };
}
