const only = (items) => (items.length === 1 ? items[0] : null);

export function isLocal(item) {
  return Boolean(item) && (item.hostId === null || item.hostId === "local");
}

const RAW_SEPARATOR = "::";

export function resolveWorkspaceId(raw, workspaces) {
  if (typeof raw !== "string" || !raw) return null;
  const local = workspaces.filter(isLocal);
  const direct = local.find((item) => item.id === raw);
  if (direct) return direct.id;
  const at = raw.indexOf(RAW_SEPARATOR);
  if (at <= 0) return null;
  const path = raw.slice(at + RAW_SEPARATOR.length);
  return only(local.filter((item) => item.path === path))?.id ?? null;
}

export function matchFocused(context, workspaces, terminalMap) {
  if (!context) return null;
  const local = workspaces.filter(isLocal);
  if (context.workspaceId) {
    const exact = local.find((item) => item.id === context.workspaceId);
    return exact ? { workspace: exact, via: "context" } : null;
  }
  const ids = (Array.isArray(context.terminals) ? context.terminals : []).map((terminal) => (typeof terminal === "string" ? terminal : terminal?.id));
  const learned = terminalMap?.resolve(ids) ?? null;
  const known = learned ? local.find((item) => item.id === learned) : null;
  if (known) return { workspace: known, via: "terminal" };
  const { branch, displayName } = context;
  const found =
    only(local.filter((item) => item.name === displayName && item.branch === branch)) ||
    only(local.filter((item) => item.name === displayName)) ||
    (branch ? only(local.filter((item) => item.branch === branch)) : null);
  return found ? { workspace: found, via: "name" } : null;
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_][\w.-]*$/;

export function parseRemote(url) {
  if (typeof url !== "string") return null;
  const match =
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url) ||
    /^(?:https:\/\/|ssh:\/\/)(?:[^/@\s]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || !OWNER.test(match[1]) || !REPO.test(match[2])) return null;
  return `${match[1]}/${match[2]}`;
}

export function matchRepo(nameWithOwner, workspaces, remotesByPath, focusedId) {
  const target = String(nameWithOwner).toLowerCase();
  const found = workspaces.filter((item) => isLocal(item) && String(remotesByPath?.[item.path] ?? "").toLowerCase() === target);
  return found.find((item) => item.id === focusedId) ?? found[0] ?? null;
}
