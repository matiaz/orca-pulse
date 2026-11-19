const api = globalThis.orca;
const root = document.getElementById("root");

const STORE_KEY = "pulse.ui.v1";
const IDS = ["activity", "pulls", "git"];
const TITLES = { activity: "Activity", pulls: "Pull requests", git: "Git" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CELL = 10;
const GAP = 2;
const LABEL_WIDTH = 24;
const SHIFT_WEEKS = 4;
const MAX_PRS = 100;
const FLASH_MS = 4000;
const CONFIRM_MS = 3000;
const SEVERITY = {
  merge: "ok",
  "ci failed": "bad",
  conflict: "bad",
  changes: "warn",
  update: "warn",
  review: "info",
  "ci running": "muted",
  waiting: "muted",
  draft: "muted",
};
const GIT_BUSY_KEYS = { stage: "stageAll", message: "message", commit: "commit", pull: "pull", push: "push", pr: "createPr" };
const KIND_LETTERS = { modified: "M", added: "A", deleted: "D", renamed: "R", new: "?", conflict: "U" };
const MARKS = { staged: "●", partial: "◐", unstaged: "○" };
const MARK_LABELS = { staged: "staged", partial: "partly staged", unstaged: "not staged" };
const COMMIT_CHECKS = { passed: "✓ checks passed", running: "● checks running", failed: "✗ checks failed" };

function loadUi() {
  const ui = { order: [...IDS], collapsed: {} };
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(stored?.order) && stored.order.length === IDS.length && IDS.every((id) => stored.order.includes(id))) ui.order = stored.order;
    if (stored?.collapsed && typeof stored.collapsed === "object") {
      for (const id of IDS) ui.collapsed[id] = stored.collapsed[id] === true;
    }
  } catch {}
  return ui;
}

const ui = loadUi();

function saveUi() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(ui));
  } catch {}
}

function isGithubUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.username && !parsed.password && !parsed.port;
  } catch {
    return false;
  }
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(label, onClick, { className = "", aria, title, disabled = false, pressed } = {}) {
  const node = h("button", className, label);
  node.type = "button";
  if (aria) node.setAttribute("aria-label", aria);
  if (title) node.title = title;
  if (pressed !== undefined) node.setAttribute("aria-pressed", String(pressed));
  node.disabled = disabled;
  node.addEventListener("click", onClick);
  return node;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function isoDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function ago(iso) {
  const time = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return null;
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes}m ago`;
  if (minutes < 24 * 60) return `updated ${Math.floor(minutes / 60)}h ago`;
  return `updated ${Math.floor(minutes / 1440)}d ago`;
}

function errorText(error) {
  const message = typeof error?.message === "string" && error.message ? error.message : "request failed";
  return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

let snapshot = null;
let loadError = null;
let localBusy = null;
let confirmUrl = null;
let confirmTimer = null;
let draft = "";
let draftEl = null;
let framePending = false;
const flashes = { activity: null, pulls: null, git: null };
const nodes = new Map();
const keys = new Map();

function schedule() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    try {
      render();
    } catch (error) {
      root.replaceChildren(h("p", "banner", `Render failed: ${errorText(error)}`));
      nodes.clear();
      keys.clear();
    }
  });
}

function flash(section, text, tone = "error") {
  const entry = { text, tone, until: Date.now() + FLASH_MS };
  flashes[section] = entry;
  schedule();
  setTimeout(() => {
    if (flashes[section] === entry) {
      flashes[section] = null;
      schedule();
    }
  }, FLASH_MS + 50);
}

function request(name, input, timeoutMs = 30000) {
  if (!api?.plugin?.request) return Promise.reject(new Error("Orca frame API unavailable"));
  return api.plugin.request(name, input, { timeoutMs });
}

function isSnapshot(value) {
  return Boolean(value && typeof value === "object" && value.heatmap && value.pulls && value.git);
}

function applySnapshot(next) {
  if (!isSnapshot(next)) return;
  snapshot = next;
  loadError = null;
  schedule();
}

async function reload() {
  applySnapshot(await request("pulse.snapshot"));
}

async function act(section, name, input, timeoutMs) {
  try {
    const result = await request(name, input, timeoutMs);
    await reload().catch(() => {});
    return result ?? {};
  } catch (error) {
    flash(section, errorText(error));
    await reload().catch(() => {});
    return null;
  }
}

function openUrl(url, section) {
  if (!isGithubUrl(url) || typeof api?.shell?.openExternal !== "function") return;
  try {
    Promise.resolve(api.shell.openExternal(url)).catch((error) => flash(section, errorText(error)));
  } catch (error) {
    flash(section, errorText(error));
  }
}

function mondayOf(date) {
  return addDays(date, -((date.getDay() + 6) % 7));
}

function formatValue(source, value) {
  if (source === "claude") return `$${value.toFixed(2)}`;
  return `${value} ${value === 1 ? "contribution" : "contributions"}`;
}

const tooltip = h("div", "tooltip");
tooltip.hidden = true;
tooltip.setAttribute("role", "tooltip");
document.body.append(tooltip);

function showTip(target) {
  const text = target?.dataset?.tip;
  if (!text) return hideTip();
  tooltip.textContent = text;
  tooltip.hidden = false;
  const rect = target.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const left = Math.max(4, Math.min(rect.left + rect.width / 2 - width / 2, document.documentElement.clientWidth - width - 4));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(4, rect.top - tooltip.offsetHeight - 4)}px`;
}

function hideTip() {
  tooltip.hidden = true;
}

function shell(id, status, tone) {
  const index = ui.order.indexOf(id);
  const collapsed = ui.collapsed[id] === true;
  const section = h("section", "box");
  section.dataset.id = id;
  const head = h("header", "head");
  const toggle = button("", () => {
    ui.collapsed[id] = !ui.collapsed[id];
    saveUi();
    schedule();
  }, { className: "toggle" });
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-controls", `body-${id}`);
  toggle.append(h("span", "chev", collapsed ? "▸" : "▾"), h("span", "title", TITLES[id]));
  const state = h("span", `status${tone === "error" ? " error" : ""}`, status ?? "");
  if (status) state.title = status;
  const move = h("span", "move");
  move.append(
    button("↑", () => moveSection(id, -1), { className: "flat", aria: `Move ${TITLES[id]} up`, disabled: index === 0 }),
    button("↓", () => moveSection(id, 1), { className: "flat", aria: `Move ${TITLES[id]} down`, disabled: index === ui.order.length - 1 }),
  );
  head.append(toggle, state, move);
  const body = h("div", "body");
  body.id = `body-${id}`;
  body.hidden = collapsed;
  section.append(head, body);
  return { section, body };
}

function moveSection(id, direction) {
  const index = ui.order.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ui.order.length) return;
  [ui.order[index], ui.order[target]] = [ui.order[target], ui.order[index]];
  saveUi();
  schedule();
}

function noteLine(text, tone = "") {
  return h("p", `note ${tone}`.trim(), text);
}

function flashLine(section) {
  const entry = flashes[section];
  return entry ? h("p", `line ${entry.tone}`, entry.text) : null;
}

function weeksFit() {
  const width = root.clientWidth || 300;
  const available = Math.max(0, width - 16 - 18 - LABEL_WIDTH - 4);
  return Math.max(8, Math.min(53, Math.floor((available + GAP) / (CELL + GAP))));
}

function limitRow(label, window) {
  const expired = window.resetsAt && Date.parse(window.resetsAt) <= Date.now();
  const pct = expired ? 0 : Math.max(0, Math.min(100, Math.round(window.pct)));
  const row = h("div", `limit${pct >= 90 ? " danger" : pct >= 70 ? " warn" : ""}`);
  const track = h("div", "track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", `${label} usage`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", String(pct));
  const fill = h("div", "fill");
  fill.style.width = `${pct}%`;
  track.append(fill);
  row.append(h("span", "label", label), h("span", "reset", window.resetLabel || ""), track, h("span", "pct", `${pct}%`));
  return row;
}

function limitsBlock(limits) {
  const block = h("div", "limits");
  if (limits.fiveHour) block.append(limitRow("Current session (5 hours)", limits.fiveHour));
  if (limits.sevenDay) block.append(limitRow("Current week (7 days)", limits.sevenDay));
  if (!limits.fiveHour && !limits.sevenDay) block.append(noteLine(limits.error ? "Plan usage unavailable" : "Loading plan usage…"));
  if (limits.error && (limits.fiveHour || limits.sevenDay)) block.append(noteLine(limits.error, "warn"));
  if (limits.hint) block.append(noteLine(limits.hint));
  if (limits.backoffUntil) {
    const until = new Date(limits.backoffUntil);
    if (!Number.isNaN(until.getTime())) block.append(noteLine(`Retrying after ${pad(until.getHours())}:${pad(until.getMinutes())}`));
  }
  return block;
}

function buildActivity() {
  const heatmap = snapshot.heatmap;
  const source = heatmap.source === "claude" ? "claude" : "github";
  const data = heatmap[source] ?? { days: {} };
  const offset = Number.isInteger(heatmap.offset) ? heatmap.offset : 0;
  const status = data.error ?? ago(data.updatedAt) ?? "loading…";
  const { section, body } = shell("activity", status, data.error ? "error" : "");

  const controls = h("div", "row split");
  const seg = h("div", "seg");
  seg.append(
    button("GitHub", () => switchSource("github"), { pressed: source === "github" }),
    button("Claude", () => switchSource("claude"), { pressed: source === "claude" }),
  );
  const nav = h("div", "row");
  nav.append(
    button("‹", () => shiftWeeks(SHIFT_WEEKS), { aria: `Back ${SHIFT_WEEKS} weeks`, title: `Back ${SHIFT_WEEKS} weeks` }),
    button("today", () => shiftWeeks(0), { disabled: offset === 0 }),
    button("›", () => shiftWeeks(-SHIFT_WEEKS), { aria: `Forward ${SHIFT_WEEKS} weeks`, title: `Forward ${SHIFT_WEEKS} weeks`, disabled: offset === 0 }),
  );
  controls.append(seg, nav);
  body.append(controls);

  const weeks = weeksFit();
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const todayKey = isoDay(todayStart);
  const lastMonday = mondayOf(addDays(todayStart, -7 * offset));
  const lastSunday = addDays(lastMonday, 6);
  const end = lastSunday > todayStart ? todayStart : lastSunday;
  const start = addDays(lastMonday, -7 * (weeks - 1));
  const startKey = isoDay(start);
  const endKey = isoDay(end);

  const months = h("div", "hm-months");
  months.style.setProperty("--weeks", String(weeks));
  let lastLabel = -3;
  for (let w = 0; w + 3 <= weeks; w++) {
    const monday = addDays(start, w * 7);
    if (monday.getDate() > 7 || w - lastLabel < 3) continue;
    const label = h("span", "", MONTHS[monday.getMonth()]);
    label.style.gridColumn = `${w + 1} / span 3`;
    months.append(label);
    lastLabel = w;
  }

  const grid = h("div", "hm-grid");
  grid.style.setProperty("--weeks", String(weeks));
  let total = 0;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const key = isoDay(date);
      if (key > endKey) {
        grid.append(h("div", "cell empty"));
        continue;
      }
      const entry = data.days?.[key];
      const value = Array.isArray(entry) && Number.isFinite(entry[0]) ? entry[0] : 0;
      const level = Array.isArray(entry) && Number.isInteger(entry[1]) && entry[1] >= 0 && entry[1] <= 4 ? entry[1] : 0;
      if (key >= startKey) total += value;
      const text = `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}, ${formatValue(source, value)}`;
      const cell = h("div", `cell l${level}${key === todayKey ? " today" : ""}`);
      cell.dataset.tip = text;
      cell.setAttribute("role", "img");
      cell.setAttribute("aria-label", text);
      grid.append(cell);
    }
  }
  grid.addEventListener("pointerover", (event) => showTip(event.target.closest?.(".cell[data-tip]")));
  grid.addEventListener("pointerleave", hideTip);

  const days = h("div", "hm-days");
  days.setAttribute("aria-hidden", "true");
  ["Mon", "", "Wed", "", "Fri", "", ""].forEach((label) => days.append(h("span", "", label)));
  const main = h("div", "hm-main");
  main.append(months, grid);
  const map = h("div", "hm");
  map.append(days, main);
  body.append(map);

  const foot = h("div", "row split");
  foot.append(h("span", "", source === "claude" ? `$${total.toFixed(2)}` : `${total} ${total === 1 ? "contribution" : "contributions"}`));
  const legend = h("span", "legend");
  legend.setAttribute("aria-hidden", "true");
  legend.append("less");
  for (let level = 0; level <= 4; level++) legend.append(h("span", `cell l${level}`));
  legend.append("more");
  foot.append(legend);
  body.append(foot);

  if (data.hint) body.append(noteLine(data.hint));
  if (snapshot.limits?.enabled) body.append(limitsBlock(snapshot.limits));
  const note = flashLine("activity");
  if (note) body.append(note);
  return section;
}

async function switchSource(source) {
  if (snapshot) {
    snapshot = { ...snapshot, heatmap: { ...snapshot.heatmap, source } };
    schedule();
  }
  await act("activity", "heatmap.source", { source });
}

function shiftWeeks(weeks) {
  return act("activity", "heatmap.shift", { weeks });
}

const SCOPE_EMPTY = {
  all: "Nothing waiting on you",
  open: "Nothing waiting on you in open workspaces",
  workspace: "Nothing waiting on you in this workspace",
  "no-remote": "The focused workspace has no GitHub remote",
  "no-workspace": "No focused workspace",
};

function emptyText(scope) {
  return SCOPE_EMPTY[scope?.reason] ?? SCOPE_EMPTY[scope?.mode] ?? SCOPE_EMPTY.all;
}

function buildPulls() {
  const pulls = snapshot.pulls;
  const items = Array.isArray(pulls.items) ? pulls.items : [];
  const status = pulls.error ?? [items.length ? `${items.length} open` : null, ago(pulls.updatedAt)].filter(Boolean).join(" · ");
  const { section, body } = shell("pulls", status || "loading…", pulls.error ? "error" : "");
  if (pulls.hint) body.append(noteLine(pulls.hint));
  if (!items.length) {
    if (!pulls.error) body.append(noteLine(emptyText(pulls.scope)));
  } else {
    const list = h("ul", "prs");
    list.style.listStyle = "none";
    for (const item of items.slice(0, MAX_PRS)) list.append(pullRow(item));
    body.append(list);
    if (items.length > MAX_PRS) body.append(noteLine(`+${items.length - MAX_PRS} more`));
  }
  const note = flashLine("pulls");
  if (note) body.append(note);
  return section;
}

function pullRow(item) {
  const row = h("li", "pr");
  const main = h("button", "pr-main");
  main.type = "button";
  main.title = `${item.repo}#${item.number} ${item.title}`;
  main.setAttribute("aria-label", `Open ${item.repo} pull request ${item.number}: ${item.title}`);
  const top = h("span", "pr-top");
  const repoName = String(item.repo ?? "").split("/").pop();
  const author = String(item.author ?? "").replace(/\[bot\]$/, "");
  top.append(h("span", `badge sev-${SEVERITY[item.action] ?? "muted"}`, item.action), h("span", "pr-ref", `${repoName}#${item.number}`), h("span", "pr-author", author));
  main.append(top, h("span", "pr-title", item.title));
  if (typeof item.note === "string" && item.note) main.append(h("span", "pr-note", item.note));
  main.addEventListener("click", () => openUrl(item.url, "pulls"));
  const actions = h("div", "pr-actions");
  const confirming = confirmUrl === item.url;
  actions.append(
    button("copy", () => copyPull(item), { aria: `Copy link to ${item.repo} pull request ${item.number}` }),
    button(confirming ? "Run review?" : "review", () => reviewPull(item), { aria: confirming ? "Confirm review" : `Review ${item.repo} pull request ${item.number}` }),
  );
  row.append(main, actions);
  return row;
}

async function copyPull(item) {
  try {
    const result = await request("pulls.copy", { url: item.url });
    flash("pulls", result?.copied ? "Link copied" : "Copy failed: no clipboard tool found", result?.copied ? "ok" : "error");
  } catch (error) {
    flash("pulls", errorText(error));
  }
}

async function reviewPull(item) {
  if (confirmUrl !== item.url) {
    confirmUrl = item.url;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirmUrl = null;
      schedule();
    }, CONFIRM_MS);
    schedule();
    return;
  }
  clearTimeout(confirmTimer);
  confirmUrl = null;
  schedule();
  try {
    await request("pulls.review", { url: item.url }, 60000);
    flash("pulls", "Review started", "ok");
  } catch (error) {
    flash("pulls", errorText(error));
  }
}

function gitStatus(git) {
  if (git.error) return { text: git.error, tone: "error" };
  if (!git.visible) return { text: "no repo", tone: "" };
  return { text: git.selected?.nameWithOwner || git.selected?.name || "", tone: "" };
}

function checksText(checks) {
  return checks ? ` · checks ${checks}` : "";
}

function buildGit() {
  const git = snapshot.git;
  const state = gitStatus(git);
  const { section, body } = shell("git", state.text, state.tone);
  draftEl = null;
  const focus = snapshot.focus;
  if (focus && focus.via === null && Array.isArray(focus.candidates) && focus.candidates.length) {
    body.append(noteLine("Which workspace is focused?"));
    const select = h("select");
    select.setAttribute("aria-label", "Focused workspace");
    const placeholder = h("option", "", "Choose a workspace");
    placeholder.value = "";
    placeholder.selected = true;
    select.append(placeholder);
    for (const candidate of focus.candidates) {
      const option = h("option", "", candidate.label);
      option.value = candidate.id;
      select.append(option);
    }
    select.addEventListener("change", async () => {
      if (!select.value) return;
      try {
        await request("git.pickWorkspace", { id: select.value });
      } catch (error) {
        flash("git", errorText(error));
      }
      await reload().catch(() => {});
    });
    body.append(select);
    body.append(noteLine("Pulse remembers this, and learns it automatically once an agent runs in a workspace."));
    const pickNote = flashLine("git");
    if (pickNote) body.append(pickNote);
    return section;
  }
  if (!git.visible || !git.selected) {
    body.append(noteLine("No GitHub repo in the focused workspace"));
    if (git.hint) body.append(noteLine(git.hint));
    return section;
  }
  const selected = git.selected;
  const busyName = localBusy ?? (git.busy ? GIT_BUSY_KEYS[git.busy] ?? git.busy : null);
  const busy = Boolean(busyName);

  if (Array.isArray(git.repos) && git.repos.length > 1) {
    const select = h("select");
    select.setAttribute("aria-label", "Repository");
    select.disabled = busy;
    for (const repo of git.repos) {
      const option = h("option", "", repo.name);
      option.value = repo.path;
      option.selected = repo.path === selected.path;
      select.append(option);
    }
    select.addEventListener("change", () => gitRun("select", () => act("git", "git.select", { path: select.value }), false));
    body.append(select);
  }

  const head = h("div", "git-head");
  head.append(h("span", "branch", selected.branch));
  if (selected.ahead || selected.behind) head.append(h("span", "muted", `↑${selected.ahead} ↓${selected.behind}`));
  if (selected.pr) {
    head.append(button(`PR #${selected.pr.number}${checksText(selected.pr.checks)}`, () => openUrl(selected.pr.url, "git"), { className: "link", aria: `Open pull request ${selected.pr.number}` }));
  } else if (selected.commit && COMMIT_CHECKS[selected.commit.checks]) {
    const { commit } = selected;
    head.append(
      button(COMMIT_CHECKS[commit.checks], () => openUrl(commit.url, "git"), {
        className: `link checks-${commit.checks}`,
        aria: `Open checks for commit ${commit.sha.slice(0, 7)}`,
        title: `Checks of ${commit.sha.slice(0, 7)}, the latest pushed commit`,
      }),
    );
  }
  body.append(head);

  if (selected.files.length) {
    const list = h("ul", "files");
    list.style.listStyle = "none";
    for (const file of selected.files) {
      const item = h("li", "file");
      item.title = file.path;
      const kind = h("span", `kind kind-${file.kind}`, KIND_LETTERS[file.kind] ?? "M");
      kind.setAttribute("aria-label", file.kind);
      const mark = h("span", "mark", MARKS[file.staged] ?? MARKS.unstaged);
      mark.setAttribute("aria-label", MARK_LABELS[file.staged] ?? MARK_LABELS.unstaged);
      const path = h("span", "path");
      path.append(h("bdi", "", file.path));
      item.append(kind, mark, path);
      list.append(item);
    }
    body.append(list);
    if (selected.more > 0) body.append(noteLine(`+${selected.more} more`));
  } else {
    body.append(noteLine("Working tree clean"));
  }

  const area = h("textarea");
  area.rows = 3;
  area.maxLength = 500;
  area.placeholder = "Commit message (empty uses the branch name)";
  area.setAttribute("aria-label", "Commit message");
  area.value = draft;
  area.addEventListener("input", () => {
    draft = area.value;
  });
  draftEl = area;
  body.append(area);

  const actions = h("div", "actions");
  const make = (key, label, work) => {
    const node = button("", work, { disabled: busy, aria: label });
    if (busyName === key) node.append(h("span", "spinner"));
    node.append(label);
    return node;
  };
  actions.append(make("stageAll", "stage all", () => gitRun("stageAll", () => act("git", "git.stageAll"))));
  if (git.ai) {
    actions.append(
      make("message", "message", () =>
        gitRun("message", async () => {
          const result = await act("git", "git.message", undefined, 120000);
          if (result && typeof result.message === "string") {
            draft = result.message;
            if (draftEl) draftEl.value = draft;
          }
        }),
      ),
    );
  }
  actions.append(
    make("commit", "commit", () =>
      gitRun("commit", async () => {
        const result = await act("git", "git.commit", draft.trim() ? { message: draft } : {}, 120000);
        if (result) {
          draft = "";
          if (draftEl) draftEl.value = "";
        }
      }),
    ),
    make("pull", "pull", () => gitRun("pull", () => act("git", "git.pull", undefined, 120000))),
    make("push", "push", () => gitRun("push", () => act("git", "git.push", undefined, 120000))),
  );
  if (selected.pr) {
    const open = button(`pr #${selected.pr.number}`, () => openUrl(selected.pr.url, "git"), { disabled: busy, aria: `Open pull request ${selected.pr.number}` });
    actions.append(open);
  } else {
    actions.append(
      make("createPr", "create pr", () =>
        gitRun("createPr", async () => {
          const result = await act("git", "git.createPr", undefined, 120000);
          if (result?.url) openUrl(result.url, "git");
        }),
      ),
    );
  }
  body.append(actions);

  const local = flashLine("git");
  if (local) body.append(local);
  else if (git.notice?.text) body.append(h("p", `line ${git.notice.tone === "error" ? "error" : "ok"}`, git.notice.text));
  if (git.hint) body.append(noteLine(git.hint));
  return section;
}

async function gitRun(key, work, markBusy = true) {
  if (localBusy) return;
  if (markBusy) localBusy = key;
  schedule();
  try {
    await work();
  } finally {
    localBusy = null;
    schedule();
  }
}

function sectionKey(id) {
  const base = [ui.collapsed[id] === true, ui.order.indexOf(id), Math.floor(Date.now() / 60000)];
  if (id === "activity") return JSON.stringify([...base, snapshot.heatmap, snapshot.limits, flashes.activity?.text, weeksFit()]);
  if (id === "pulls") return JSON.stringify([...base, snapshot.pulls, flashes.pulls?.text, confirmUrl]);
  return JSON.stringify([...base, snapshot.git, snapshot.focus, flashes.git?.text, localBusy]);
}

const BUILDERS = { activity: buildActivity, pulls: buildPulls, git: buildGit };

function render() {
  hideTip();
  if (!snapshot) {
    nodes.clear();
    keys.clear();
    root.replaceChildren(h("p", "banner", loadError ? `Pulse could not load: ${loadError}` : "Loading…"));
    return;
  }
  for (const id of ui.order) {
    const key = sectionKey(id);
    if (nodes.has(id) && keys.get(id) === key) continue;
    const previous = nodes.get(id);
    const refocus = previous && document.activeElement instanceof HTMLTextAreaElement && previous.contains(document.activeElement);
    const selection = refocus ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const scrolls = previous ? [...previous.querySelectorAll("ul.prs, ul.files")].map((el) => [el.className, el.scrollTop]) : [];
    const next = BUILDERS[id]();
    if (previous && previous.parentNode === root) previous.replaceWith(next);
    for (const [className, top] of scrolls) {
      const el = next.querySelector(`ul.${className}`);
      if (el) el.scrollTop = top;
    }
    nodes.set(id, next);
    keys.set(id, key);
    if (refocus && draftEl) {
      draftEl.focus();
      try {
        draftEl.setSelectionRange(selection[0], selection[1]);
      } catch {}
    }
  }
  const wanted = ui.order.map((id) => nodes.get(id));
  const same = root.children.length === wanted.length && wanted.every((node, index) => root.children[index] === node);
  if (!same) root.replaceChildren(...wanted);
}

async function start() {
  if (!api?.plugin?.request) {
    loadError = "Orca frame API unavailable";
    schedule();
    return;
  }
  try {
    api.plugin.on("pulse.update", applySnapshot);
  } catch (error) {
    loadError = errorText(error);
  }
  const load = async () => {
    try {
      await reload();
    } catch (error) {
      loadError = errorText(error);
      schedule();
      if (!snapshot) setTimeout(load, 3000);
    }
  };
  await load();
}

schedule();
if (typeof ResizeObserver === "function") new ResizeObserver(schedule).observe(root);
setInterval(schedule, 30000);
start();
