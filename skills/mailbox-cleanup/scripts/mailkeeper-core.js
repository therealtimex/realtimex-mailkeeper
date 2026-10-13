"use strict";

/**
 * mailkeeper-core.js — rules shared by the plugin runtime and the workspace
 * CLI: inbox identity, Himalaya config resolution, the per-inbox contract
 * block, and how workspace settings and a contract combine into one policy.
 *
 * It lives in the skill directory so the workspace copy of mailbox-ops.js can
 * require it without reaching into the plugin runtime.
 */

const crypto = require("crypto");
const path = require("path");

const MODES = ["report-only", "label-only", "archive-promoted"];
const AGGRESSIVENESS = ["conservative", "standard", "aggressive"];

/** Which cleanup passes may be promoted at each aggressiveness level. */
const PASSES_BY_AGGRESSIVENESS = {
  conservative: ["no-reply", "calendar-response", "sketchy-tld"],
  standard: ["no-reply", "calendar-response", "sketchy-tld", "receipt", "generic-outreach", "age"],
  aggressive: [
    "no-reply",
    "calendar-response",
    "sketchy-tld",
    "receipt",
    "generic-outreach",
    "age",
    "personalized-outreach",
    "repeat-sender",
  ],
};
const ALL_PASSES = PASSES_BY_AGGRESSIVENESS.aggressive;
/** Passes that rely on reply history, which needs this inbox's Sent folder. */
const PASSES_NEEDING_SENT = ["personalized-outreach", "repeat-sender"];

const POLICY_BLOCK = "mailkeeper-policy";
const POLICY_FIELDS = new Set([
  "version",
  "account",
  "mode",
  "ageThresholdDays",
  "aggressiveness",
  "vipSenders",
  "excludedPasses",
  "archiveFolder",
  "sentFolder",
  "credential",
  "reviewRequired",
]);
const PASSWORD_REF = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:#password)?$/;
const MAX_ACCOUNT_NAME = 200;

function modeRank(mode) {
  return MODES.indexOf(mode);
}

function narrowestMode(...modes) {
  return modes
    .filter((mode) => MODES.includes(mode))
    .reduce((lowest, mode) => (modeRank(mode) < modeRank(lowest) ? mode : lowest), "archive-promoted");
}

// ---------------------------------------------------------------------------
// Inbox identity
// ---------------------------------------------------------------------------

/** Himalaya account names are user text: reject empty, overlong or control characters. */
function validAccountName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_ACCOUNT_NAME &&
    !/[\u0000-\u001f\u007f]/.test(name)
  );
}

/**
 * Stable directory key for one account: a readable slug plus 12 hex
 * characters of SHA-256 over the exact name, so `Work` and `work` (or two
 * names that slug alike) never share a contract.
 */
function accountKey(name) {
  if (!validAccountName(name)) throw new Error("invalid account name");
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "account";
  const hash = crypto.createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

function contractRelativePath(key) {
  return path.posix.join("mailboxes", key, "MAILBOX.md");
}

// ---------------------------------------------------------------------------
// Himalaya config resolution
// ---------------------------------------------------------------------------

/**
 * The default search list of the installed Himalaya 1.2: the platform config
 * directory, then ~/.config, then ~/.himalayarc. Himalaya uses the first file
 * that exists and, when none does, starts an interactive wizard; MailKeeper
 * therefore always passes the resolved file explicitly.
 */
function himalayaConfigCandidates({ home, platform = process.platform, appData } = {}) {
  const configDir =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? appData || path.join(home, "AppData", "Roaming")
        : path.join(home, ".config");
  return [...new Set([
    path.join(configDir, "himalaya", "config.toml"),
    path.join(home, ".config", "himalaya", "config.toml"),
    path.join(home, ".himalayarc"),
  ])];
}

/**
 * Resolve the config file every MailKeeper surface must use.
 * `HIMALAYA_CONFIG` wins when set, matching Himalaya itself.
 * Returns { paths, target, source, missing }: `paths` is what to pass with
 * `-c`; `target` is where setup creates the file when it is missing.
 */
function resolveHimalayaConfig({ himalayaConfig, home, platform, appData, exists }) {
  if (himalayaConfig) {
    const file = path.resolve(himalayaConfig);
    return { paths: exists(file) ? [file] : [], target: file, source: "HIMALAYA_CONFIG", missing: !exists(file) };
  }
  const candidates = himalayaConfigCandidates({ home, platform, appData });
  const found = candidates.find((file) => exists(file));
  return found
    ? { paths: [found], target: found, source: "default", missing: false }
    : { paths: [], target: candidates[0], source: "default", missing: true };
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Normalise one protected-sender entry. An address matches exactly; a domain
 * matches itself and its subdomains, so `*.bank.com`, `@bank.com` and
 * `.bank.com` all mean `bank.com`. Anything else is rejected rather than kept
 * as a pattern that would silently protect nothing.
 */
function normalizeSender(entry) {
  const raw = String(entry ?? "").trim().toLowerCase();
  const stripped = raw.replace(/^\*\./, "").replace(/^[@.]/, "");
  if (stripped.includes("@")) {
    const [local, domain, extra] = stripped.split("@");
    if (extra === undefined && local && /^[^\s*]+$/.test(local) && DOMAIN_RE.test(domain)) return stripped;
    return null;
  }
  return DOMAIN_RE.test(stripped) ? stripped : null;
}

function senderMatches(entry, address, domain) {
  return entry.includes("@")
    ? address === entry
    : domain === entry || domain.endsWith(`.${entry}`);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

function digest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function cleanFolder(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateCredential(credential) {
  if (credential === null) return true;
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return false;
  const keys = Object.keys(credential);
  if (credential.kind === "himalaya-native") return keys.length === 1;
  if (credential.kind === "realtimex-secret") {
    return keys.length === 2 && typeof credential.passwordRef === "string" && PASSWORD_REF.test(credential.passwordRef);
  }
  return false;
}

/**
 * Parse one inbox contract. The typed block is the only part the helper
 * enforces; prose stays guidance for the agent.
 *
 *   status "valid"           — block present and valid
 *   status "review-required" — no block yet (e.g. migrated v0.1.1 text) or
 *                              the block still awaits the user's review
 *   status "invalid"         — malformed, duplicate, unknown field or
 *                              another account's block: no mutations
 */
function parseContract(text, account) {
  const source = String(text ?? "");
  const blocks = [...source.matchAll(new RegExp("^```" + POLICY_BLOCK + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$", "gm"))];
  const result = { digest: digest(source), policy: null };
  if (blocks.length === 0) return { ...result, status: "review-required", code: "MAILKEEPER_CONTRACT_REVIEW_REQUIRED" };
  if (blocks.length > 1) return { ...result, status: "invalid", code: "MAILKEEPER_CONTRACT_INVALID" };

  let policy;
  try {
    policy = JSON.parse(blocks[0][1]);
  } catch {
    return { ...result, status: "invalid", code: "MAILKEEPER_CONTRACT_INVALID" };
  }
  const invalid = { ...result, status: "invalid", code: "MAILKEEPER_CONTRACT_INVALID" };
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return invalid;
  if (Object.keys(policy).some((key) => !POLICY_FIELDS.has(key))) return invalid;
  if (policy.account !== account) {
    return { ...result, status: "invalid", code: "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH" };
  }
  const vipSenders = Array.isArray(policy.vipSenders) ? policy.vipSenders.map(normalizeSender) : null;
  const ok =
    policy.version === 1 &&
    MODES.includes(policy.mode) &&
    AGGRESSIVENESS.includes(policy.aggressiveness) &&
    Number.isInteger(policy.ageThresholdDays) &&
    policy.ageThresholdDays >= 1 &&
    policy.ageThresholdDays <= 3650 &&
    vipSenders !== null &&
    vipSenders.every(Boolean) &&
    Array.isArray(policy.excludedPasses) &&
    policy.excludedPasses.every((pass) => ALL_PASSES.includes(pass)) &&
    (policy.archiveFolder === null || cleanFolder(policy.archiveFolder)) &&
    (policy.sentFolder === null || cleanFolder(policy.sentFolder)) &&
    validateCredential(policy.credential) &&
    (policy.reviewRequired === undefined || typeof policy.reviewRequired === "boolean");
  if (!ok) return invalid;

  const normalized = { ...policy, vipSenders: [...new Set(vipSenders)], reviewRequired: policy.reviewRequired === true };
  return normalized.reviewRequired
    ? { ...result, status: "review-required", code: "MAILKEEPER_CONTRACT_REVIEW_REQUIRED", policy: normalized }
    : { ...result, status: "valid", code: null, policy: normalized };
}

/** Render the typed block for a new contract. */
function renderPolicyBlock(policy) {
  return ["```" + POLICY_BLOCK, JSON.stringify(policy, null, 2), "```"].join("\n");
}

/**
 * Render a new inbox contract from the skill's template. Only the settings
 * block carries enforceable values; the prose points to it rather than
 * repeating them, so the two cannot drift apart.
 */
function renderContract(template, { account, protectedDomains = [], policy, note = "" }) {
  return template
    .replaceAll("{{INBOX}}", account)
    .replaceAll("{{MIGRATION_NOTE}}", note)
    .replaceAll("{{PROTECTED_DOMAINS}}", protectedDomains.join(", ") || "none")
    .replaceAll("{{POLICY_BLOCK}}", renderPolicyBlock(policy));
}

/**
 * Replace the settings block of an existing contract, leaving every other
 * byte as the user wrote it. A contract without a block (a migrated v0.1.1
 * text) gets one appended under its own heading.
 */
function replacePolicyBlock(text, policy) {
  const source = String(text);
  const block = renderPolicyBlock(policy);
  const re = new RegExp("^```" + POLICY_BLOCK + "[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n```[ \\t]*$", "gm");
  const matches = source.match(re) || [];
  if (matches.length > 1) return null;
  if (matches.length === 1) return source.replace(re, () => block);
  return `${source.trimEnd()}\n\n## MailKeeper settings\n\nMailKeeper reads this block to enforce your contract. Ask the agent to change it; you don't need to edit it.\n\n${block}\n`;
}

/**
 * Seed policy for a new inbox: always report-only, no credential until setup,
 * no folders until setup resolves them from this inbox.
 */
function draftPolicy(account, workspace, { reviewRequired = false } = {}) {
  return {
    version: 1,
    account,
    mode: "report-only",
    ageThresholdDays: workspace.ageThresholdDays,
    aggressiveness: "conservative",
    vipSenders: [],
    excludedPasses: [],
    archiveFolder: null,
    sentFolder: null,
    credential: null,
    ...(reviewRequired ? { reviewRequired: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Effective policy
// ---------------------------------------------------------------------------

/**
 * Combine workspace settings (already capped by the global ceiling) with one
 * inbox contract. Each layer can only narrow: the contract cannot raise the
 * mode or widen promotable passes, `requestedMode` (from `--mode`) can only
 * lower the mode, and a contract awaiting review is report-only.
 */
function effectivePolicy(workspace, contract, { requestedMode } = {}) {
  const policy = contract?.policy || null;
  const reportOnly = !policy || contract.status !== "valid";
  const mode = reportOnly
    ? "report-only"
    : narrowestMode(workspace.mode, policy.mode, requestedMode || "archive-promoted");
  const workspacePasses = workspace.promotablePasses || [];
  const accountPasses = policy ? PASSES_BY_AGGRESSIVENESS[policy.aggressiveness] : [];
  const excluded = new Set(policy?.excludedPasses || []);
  if (!policy?.sentFolder) for (const pass of PASSES_NEEDING_SENT) excluded.add(pass);
  return {
    mode,
    ageThresholdDays: policy?.ageThresholdDays || workspace.ageThresholdDays,
    promotablePasses: workspacePasses.filter((pass) => accountPasses.includes(pass) && !excluded.has(pass)),
    excludedPasses: [...excluded],
    vipSenders: [...new Set([...(workspace.vipSenders || []), ...(policy?.vipSenders || [])])],
    protectedDomains: workspace.protectedDomains || [],
    archiveFolder: policy?.archiveFolder || null,
    sentFolder: policy?.sentFolder || null,
    // A migrated v0.1.1 contract has no settings block yet; it keeps the
    // sign-in its Himalaya entry already had, for read-only work only.
    credential: policy ? policy.credential : contract?.status === "review-required" ? { kind: "himalaya-native" } : null,
    autoFolderPrefix: workspace.autoFolderPrefix || "Auto",
  };
}

/**
 * Own-property access for objects keyed by inbox name: a name such as
 * `__proto__` must be an ordinary entry, never the object's prototype.
 */
function own(object, key) {
  return object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
  return value;
}

/** Quote one value for a POSIX shell command line. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Rule identity: the exact account plus the full predicate and action. */
function ruleId({ account, pass, query, action }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([String(account), String(pass), String(query), String(action)]))
    .digest("hex")
    .slice(0, 16);
}

module.exports = {
  MODES,
  AGGRESSIVENESS,
  PASSES_BY_AGGRESSIVENESS,
  ALL_PASSES,
  PASSES_NEEDING_SENT,
  POLICY_BLOCK,
  modeRank,
  narrowestMode,
  validAccountName,
  accountKey,
  contractRelativePath,
  himalayaConfigCandidates,
  resolveHimalayaConfig,
  normalizeSender,
  senderMatches,
  digest,
  parseContract,
  renderPolicyBlock,
  renderContract,
  replacePolicyBlock,
  draftPolicy,
  effectivePolicy,
  ruleId,
  shellQuote,
  own,
  setOwn,
};
