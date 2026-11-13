import { clean } from "../lib/sanitize.mjs";

const MAX_TEXT = 500;
export const MAX_SHIFT = 520;
export const MAX_OFFSET = 260;
export const KEPT_CODES = new Set(["busy", "no_repo", "invalid_params", "ai_disabled", "no_pr"]);

export function invalid(message) {
  const error = new Error(message);
  error.code = "invalid_params";
  return error;
}

function fields(input, allowed) {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw invalid("input must be an object");
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw invalid(`unexpected field: ${clean(key, 40)}`);
  }
  return input;
}

function text(value, name, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  if (value.length > MAX_TEXT) throw invalid(`${name} is too long`);
  return value;
}

export function parseNone(input) {
  fields(input, []);
  return {};
}

export function parseSource(input) {
  const { source } = fields(input, ["source"]);
  if (source !== "github" && source !== "claude") throw invalid("source must be github or claude");
  return { source };
}

export function parseShift(input) {
  const { weeks } = fields(input, ["weeks"]);
  if (!Number.isInteger(weeks) || weeks < -MAX_SHIFT || weeks > MAX_SHIFT) throw invalid("weeks must be an integer between -520 and 520");
  return { weeks };
}

export function parseUrl(input) {
  const url = text(fields(input, ["url"]).url, "url");
  if (!url) throw invalid("url is required");
  return { url };
}

export function parsePath(input) {
  const value = text(fields(input, ["path"]).path, "path");
  if (!value) throw invalid("path is required");
  return { path: value };
}

export function parseWorkspaceId(input) {
  const id = fields(input, ["id"]).id;
  if (typeof id !== "string" || !id || id.length > 200) throw invalid("id must be a string of at most 200 characters");
  return { id };
}

export function parseCommit(input) {
  const message = text(fields(input, ["message"]).message, "message", { optional: true });
  return { message: message && message.trim() ? message : undefined };
}

export function friendlyError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const message = clean(error?.message ?? error, 300) || "request failed";
  const result = new Error(message);
  if (code && KEPT_CODES.has(code)) result.code = code;
  return result;
}
