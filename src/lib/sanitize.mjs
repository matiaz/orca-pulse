const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]?/g;
const ESC_PAIR = /\x1b[@-Z\\-_]/g;
const SPACES = /[\t\n\r\v\f\u2028\u2029]+/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}]/gu;

export function clean(text, max = 200) {
  const value = String(text ?? "")
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_PAIR, "")
    .replace(SPACES, " ")
    .replace(CONTROLS, "")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : value;
}

export function isPullUrl(url) {
  return typeof url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url);
}

export function isGithubUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.username && !parsed.password && !parsed.port;
  } catch {
    return false;
  }
}

const EXACT_NAMES = new Set(["npm-shrinkwrap.json", "go.sum", "bun.lockb", ".npmrc", ".netrc", ".pypirc", "kubeconfig", ".htpasswd", ".dockercfg"]);
const NAME_PATTERNS = [
  /^\.env/,
  /\.(pem|key|p12|pfx|p8|ppk|gpg|asc|ovpn|jks|keystore|kdbx|tfvars)$/,
  /\.tfstate(\.backup)?$/,
  /^id_(rsa|dsa|ed25519|ecdsa)/,
  /service-account.*\.json$/,
  /\.lock$/,
  /-lock\.[a-z]+$/,
];

export function isPrivatePath(filePath) {
  if (typeof filePath !== "string" || !filePath) return false;
  const segments = filePath.toLowerCase().split(/[\\/]/).filter(Boolean);
  if (!segments.length) return false;
  if (segments.some((segment) => segment.includes("secret") || segment.includes("credential"))) return true;
  const name = segments[segments.length - 1];
  return EXACT_NAMES.has(name) || NAME_PATTERNS.some((pattern) => pattern.test(name));
}

const MULTILINE_INVISIBLE = /(?!\u200d)\p{Cf}|[\u{E0000}-\u{E007F}]/gu;

export function cleanMultiline(text, max = 8000) {
  const value = String(text ?? "")
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC_PAIR, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(MULTILINE_INVISIBLE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  const cut = chars.slice(0, max).join("");
  return (cut.match(/```/g) ?? []).length % 2 ? `${cut}\n\`\`\`` : cut;
}

export function capText(text, max) {
  const value = String(text ?? "").slice(0, max);
  return /[\ud800-\udbff]$/.test(value) ? value.slice(0, -1) : value;
}
