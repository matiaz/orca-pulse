import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (message) => errors.push(message);

const ALLOWED_CAPABILITIES = ["workspace:read", "agent:read", "terminal:send", "notifications:show", "settings:own"];
const KNOWN_EVENTS = ["workspace.created", "workspace.removed", "workspace.changed", "agent.status.changed", "editor.typography.changed"];
const SCANNED_DIRS = ["src", "worker", "panel"];
const CODE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".html", ".css"]);
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const FORBIDDEN = [
  { name: "innerHTML", pattern: /\binnerHTML\b/ },
  { name: "outerHTML", pattern: /\bouterHTML\b/ },
  { name: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/ },
  { name: "eval", pattern: /(?<![\w.$])eval\s*\(/ },
  { name: "new Function", pattern: /\bnew\s+Function\s*\(/ },
];

function readJson(file) {
  const full = path.join(root, file);
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (error) {
    fail(`${file}: cannot read (${error.code ?? error.message})`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${file}: invalid JSON (${error.message})`);
    return null;
  }
}

function isFile(relative) {
  if (typeof relative !== "string" || !relative) return false;
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) return false;
  try {
    return fs.statSync(full).isFile();
  } catch {
    return false;
  }
}

function requireString(manifest, key) {
  if (typeof manifest[key] !== "string" || !manifest[key].trim()) fail(`orca-plugin.json: "${key}" must be a non-empty string`);
}

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function checkManifest(manifest, pkg) {
  for (const key of ["id", "name", "version", "execution", "main"]) requireString(manifest, key);
  if (manifest.manifestVersion !== 2) fail(`orca-plugin.json: "manifestVersion" must be 2, got ${JSON.stringify(manifest.manifestVersion)}`);
  if (manifest.execution !== undefined && manifest.execution !== "trusted-worker") fail(`orca-plugin.json: "execution" must be "trusted-worker", got ${JSON.stringify(manifest.execution)}`);
  if (typeof manifest.engines?.orca !== "string" || !manifest.engines.orca.startsWith(">=")) fail('orca-plugin.json: "engines.orca" must be a ">=x.y.z" range');
  if (typeof manifest.main === "string" && !isFile(manifest.main)) fail(`orca-plugin.json: "main" points to a missing file: ${manifest.main}`);

  const panels = manifest.contributes?.panels;
  if (!Array.isArray(panels) || !panels.length) fail("orca-plugin.json: contributes.panels must list at least one panel");
  for (const panel of Array.isArray(panels) ? panels : []) {
    if (typeof panel?.entry !== "string" || !panel.entry.endsWith(".html")) fail(`orca-plugin.json: panel "${panel?.id}" entry must be an .html file`);
    else if (!isFile(panel.entry)) fail(`orca-plugin.json: panel "${panel.id}" entry is missing: ${panel.entry}`);
  }

  if (pkg && typeof manifest.version === "string") {
    if (typeof pkg.version !== "string") fail('package.json: "version" is missing');
    else if (pkg.version !== manifest.version) fail(`version mismatch: orca-plugin.json has ${manifest.version}, package.json has ${pkg.version}`);
  }

  const capabilities = manifest.capabilities;
  if (!Array.isArray(capabilities)) fail("orca-plugin.json: capabilities must be an array");
  const seen = new Set();
  for (const capability of Array.isArray(capabilities) ? capabilities : []) {
    const kind = capability?.kind;
    if (!ALLOWED_CAPABILITIES.includes(kind)) fail(`orca-plugin.json: capability "${kind}" is not in the allowlist in scripts/check-manifest.mjs; review it and update the list on purpose`);
    if (seen.has(kind)) fail(`orca-plugin.json: capability "${kind}" is listed twice`);
    seen.add(kind);
  }

  const events = manifest.contributes?.events ?? [];
  if (!Array.isArray(events)) fail("orca-plugin.json: contributes.events must be an array");
  for (const event of Array.isArray(events) ? events : []) {
    if (!KNOWN_EVENTS.includes(event?.on)) fail(`orca-plugin.json: unknown event "${event?.on}"`);
  }
}

function checkCsp() {
  const file = "panel/index.html";
  let html;
  try {
    html = fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    fail(`${file}: cannot read`);
    return;
  }
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const meta = metas.find((tag) => /http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag));
  if (!meta) {
    fail(`${file}: missing Content-Security-Policy meta tag`);
    return;
  }
  const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(meta);
  const policy = content ? (content[1] ?? content[2]) : "";
  const directives = policy.split(";").map((part) => part.trim().split(/\s+/)).filter((parts) => parts[0]);
  const defaultSrc = directives.find((parts) => parts[0].toLowerCase() === "default-src");
  if (!defaultSrc || defaultSrc.length !== 2 || defaultSrc[1] !== "'none'") fail(`${file}: CSP must set default-src 'none'`);
  for (const keyword of ["'unsafe-inline'", "'unsafe-eval'"]) {
    if (policy.toLowerCase().includes(keyword)) fail(`${file}: CSP must not allow ${keyword}`);
  }
}

function checkSources() {
  for (const dir of SCANNED_DIRS) {
    for (const full of walk(path.join(root, dir))) {
      const relative = path.relative(root, full).split(path.sep).join("/");
      const text = fs.readFileSync(full, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        const match = INVISIBLE.exec(line);
        if (match) fail(`${relative}:${index + 1}: raw invisible or bidi character U+${match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
      });
      if (!CODE_EXTENSIONS.has(path.extname(full))) continue;
      lines.forEach((line, index) => {
        for (const { name, pattern } of FORBIDDEN) {
          if (pattern.test(line)) fail(`${relative}:${index + 1}: forbidden ${name}`);
        }
      });
    }
  }
}

const manifest = readJson("orca-plugin.json");
const pkg = readJson("package.json");
if (manifest) checkManifest(manifest, pkg);
checkCsp();
checkSources();

if (errors.length) {
  for (const message of errors) console.error(`error: ${message}`);
  console.error(`${errors.length} problem${errors.length === 1 ? "" : "s"} found`);
  process.exit(1);
}
console.log("manifest ok");
