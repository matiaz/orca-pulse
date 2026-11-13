import { clean } from "./sanitize.mjs";

export const HINT_INSTALL_GH = "Install the GitHub CLI (gh) and run gh auth login";
export const HINT_AUTH_GH = "Run gh auth login";

const AUTH_PATTERN = /gh auth login|not logged in|bad credentials|http 401|authentication required/i;

export function describeError(error) {
  if (error?.code === "ENOENT") return { error: "gh not found", hint: HINT_INSTALL_GH };
  const message = clean(error?.message ?? error);
  return { error: message || "request failed", hint: AUTH_PATTERN.test(message) ? HINT_AUTH_GH : null };
}

export async function ghGraphql(gh, args) {
  const result = await gh(["api", "graphql", ...args]);
  if (result.code !== 0) throw new Error(clean(result.stderr || result.stdout || `gh exited with ${result.code}`));
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error("invalid response from gh");
  }
  if (!body?.data) throw new Error(clean(body?.errors?.[0]?.message ?? "unexpected response from gh"));
  return body.data;
}
