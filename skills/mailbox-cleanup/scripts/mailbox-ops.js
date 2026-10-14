#!/usr/bin/env node
"use strict";

/**
 * mailbox-ops.js — the only way the mailbox-cleanup skill touches a mailbox.
 *
 * Copied into the workspace by the RealTimeX MailKeeper plugin's workspace
 * skill provider and run in the agent's terminal. It requires only its
 * sibling files, never the plugin runtime.
 *
 * Setup (no run needed):
 *   accounts                                  inboxes looked after here vs available
 *   config-check   --account <name>           describe the inbox's email settings (no values)
 *   account-config --account <name> --email <addr> --host <imap host> [--port 993]
 *                  [--encryption tls|start-tls|none] [--login <user>] [--replace]
 *                                            write a new inbox entry for a Secrets password;
 *                                            --replace repairs that exact existing entry
 *   check          --account <name> [--password-ref <Login reference> | --native]
 *                                            read-only connection check (lists folders, changes nothing)
 *   contract-init  --account <name> [--password-ref <Login reference> | --native]
 *                                            create the inbox's draft contract if it has none
 *   contract-set   --account <name> [--mode m] [--age n] [--aggressiveness a] [--vip a,b]
 *                  [--exclude p,q] [--archive-folder f|none] [--sent-folder f|none]
 *                  [--password-ref <Login reference> | --native] [--confirm-review]
 *                                            change only the contract's settings block
 *   contract-check --account <name>           validate and summarise the inbox contract
 *   status                                    setup state per inbox and the schedule
 *
 * Runs (one run guard per workspace, shared by chat, heartbeat and undo):
 *   begin    --run-id <id> [--account <name> ...] [--trigger chat|heartbeat]
 *   snapshot --account <name> --run-id <id> [--since-last-run] [--folder INBOX]
 *   triage   --account <name> --run-id <id>
 *   preview  --account <name> --run-id <id> --pass <pass>
 *   apply    --account <name> --run-id <id> (--pass <pass> | --promoted-only) [--mode <mode>] [--dry-run]
 *   propose  --account <name> --run-id <id>
 *   submit   --run-id <id> [--summary "..."]
 *   undo     --run-id <id> [--account <name>] [--dry-run]
 *   release  --run-id <id> [--reconciled]
 *
 * Every result is one JSON object on stdout. Failures carry a fixed
 * MAILKEEPER_* code and message; tool output and credentials never appear.
 *
 * State: <workspace>/.mailkeeper/{rules.json, accounts/<key>/snapshot.json,
 * runs/<runId>.json, outbox/<runId>.json, run.lock}. rules.json is written by
 * the plugin. Each inbox's policy is its contract at mailboxes/<key>/MAILBOX.md.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const core = require("./mailkeeper-core");

const ROOT = process.cwd();
const STATE = path.join(ROOT, ".mailkeeper");
const RUNNER = path.join(__dirname, "himalaya-runner.js");
const AUTH_HELPER = path.join(__dirname, "himalaya-auth.js");
// realtimex-plugin-validator: allow-process-env -- this CLI runs in the agent's terminal, not the plugin host; the Himalaya/rtxexec binaries and Himalaya config location are runtime discovery, never plugin configuration.
const env = process.env;
const HIMALAYA = env.MAILKEEPER_HIMALAYA_BIN || "himalaya";
const RTXEXEC = env.MAILKEEPER_RTXEXEC_BIN || "rtxexec";
const BATCH = 200;
const RUNNER_TIMEOUT_MS = 120_000;

const MESSAGES = {
  MAILKEEPER_NOT_CONFIGURED: "MailKeeper isn't configured for this workspace yet.",
  MAILKEEPER_HIMALAYA_UNAVAILABLE: "The Himalaya email tool isn't available on this computer.",
  MAILKEEPER_HIMALAYA_VERSION_UNSUPPORTED: "This version of the Himalaya email tool isn't supported.",
  MAILKEEPER_HIMALAYA_CONFIG_MISSING: "The email settings file doesn't exist yet.",
  MAILKEEPER_HIMALAYA_CONFIG_INVALID: "The email settings file has a problem that needs repair.",
  MAILKEEPER_ACCOUNT_NOT_FOUND: "This inbox isn't selected for the workspace or isn't in the email settings.",
  MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH: "This inbox's contract or settings belong to a different inbox.",
  MAILKEEPER_ACCOUNT_EXISTS: "The email settings already have an inbox entry with this name or address.",
  MAILKEEPER_CONTRACT_REVIEW_REQUIRED: "This inbox's contract needs the user's review; only reporting until then.",
  MAILKEEPER_CONTRACT_INVALID: "This inbox's contract settings can't be read; only reporting until fixed.",
  MAILKEEPER_CONTRACT_CHANGED: "The contract or approved rules changed during this run; preview again before changing anything.",
  MAILKEEPER_CREDENTIAL_UNAVAILABLE: "The saved password for this inbox can't be used.",
  MAILKEEPER_RTXEXEC_UNAVAILABLE: "The RealTimeX secret runner isn't available in this terminal.",
  MAILKEEPER_SESSION_UNAVAILABLE: "This terminal has no RealTimeX workspace session.",
  MAILKEEPER_IMAP_CHECK_FAILED: "Couldn't connect or sign in to this inbox.",
  MAILKEEPER_NETWORK_DENIED: "This terminal isn't allowed to use the network.",
  MAILKEEPER_TIMEOUT: "The mail server didn't answer in time.",
  MAILKEEPER_RUN_BUSY: "I couldn't confirm whether MailKeeper's previous run has ended, so I won't start another.",
  MAILKEEPER_MUTATION_UNCERTAIN: "The last move's result is unknown; changes stopped for this inbox and it won't be repeated.",
  MAILKEEPER_TERMINAL_REQUIRED: "This must run from the workspace chat or terminal.",
  MAILKEEPER_OPERATION_FAILED: "Something went wrong.",
};

class MailKeeperFailure extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = MESSAGES[code] ? code : "MAILKEEPER_OPERATION_FAILED";
    this.detail = detail;
  }
}

function failure(code, detail) {
  return new MailKeeperFailure(code, detail);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Pass definitions
// ---------------------------------------------------------------------------

const OUTREACH_PHRASES = [
  "quick question",
  "checking in",
  "following up",
  "touching base",
  "circle back",
  "just wanted to",
  "any thoughts",
  "bumping this",
];
const NOREPLY_LOCALPARTS = /^(no-?reply|donotreply|do-not-reply|notifications?|noreply-|mailer-daemon|bounce)/i;
const CALENDAR_PREFIX = /^(accepted|declined|tentative|invitation|updated invitation|canceled event|cancelled event):/i;
const RECEIPT_RE = /\b(receipt|order confirmation|your order|has shipped|shipped|delivered|invoice paid|payment received|thank you for your (order|purchase))\b/i;
const SKETCHY_TLDS = new Set(["shop", "biz", "xyz", "info", "club", "online", "top", "icu", "cfd", "sbs"]);
const URGENT_RE = /\b(overdue|suspension|suspended|collections|final notice|legal|subpoena|action required|past due|account (will be )?(closed|terminated))\b/i;
const URGENT_DOMAIN_RE = /\.gov(\.[a-z]{2})?$/i;
/** "Always ask first": never moved by any pass, only listed. */
const CONFIRM_FIRST_RE = /\b(invoice(?! paid)|statement|payment (failed|declined|due|overdue|reminder)|chargeback|contract|legal notice|subpoena|dmca|password reset|reset your password|new sign-?in|sign-?in attempt|verification code|security (alert|code|notice)|two-factor|2fa|suspicious (activity|sign-?in)|tax|irs|government)\b/i;

const PASSES = {
  age: {
    action: "archive",
    match: (e, ctx) => e.ageDays > ctx.policy.ageThresholdDays && !e.flags.includes("Flagged"),
    describe: (ctx) => `older than ${ctx.policy.ageThresholdDays} days, unflagged`,
  },
  "personalized-outreach": {
    action: "Outreach",
    match: (e, ctx) => {
      const names = ctx.identity?.firstNames || [];
      const companies = ctx.identity?.company || [];
      if (!names.length && !companies.length) return false;
      const subject = e.subject.toLowerCase();
      const hit = [...names, ...companies].some((n) => n && subject.includes(n.toLowerCase()));
      return hit && !ctx.knownDomains.has(e.fromDomain);
    },
    describe: () => "your name or company in subject from an unknown domain",
  },
  "generic-outreach": {
    action: "Outreach",
    match: (e) => OUTREACH_PHRASES.some((p) => e.subject.toLowerCase().includes(p)),
    describe: () => `subject contains ${OUTREACH_PHRASES.slice(0, 3).map((p) => `"${p}"`).join(", ")}…`,
  },
  "no-reply": {
    action: "Notifications",
    match: (e) => NOREPLY_LOCALPARTS.test(e.fromAddress.split("@")[0] || "") || e.bodyUnsubscribe === true,
    describe: () => "no-reply style sender or unsubscribe link in body",
  },
  "calendar-response": {
    action: "Calendar",
    match: (e) => CALENDAR_PREFIX.test(e.subject),
    describe: () => "calendar accept/decline/invitation subjects",
  },
  receipt: {
    action: "Receipts",
    match: (e) => RECEIPT_RE.test(e.subject),
    describe: () => "receipts, order confirmations, shipping notices",
  },
  "sketchy-tld": {
    action: "Suspicious",
    match: (e) => SKETCHY_TLDS.has(e.fromDomain.split(".").pop() || ""),
    describe: () => `sender TLD in ${[...SKETCHY_TLDS].map((t) => "." + t).join(" ")}`,
  },
  "repeat-sender": {
    action: "Bulk",
    match: (e, ctx) => (ctx.senderCounts.get(e.fromAddress) || 0) >= 20 && !ctx.repliedTo.has(e.fromAddress),
    describe: () => "20+ messages from one sender, none replied to",
  },
};

// ---------------------------------------------------------------------------
// Arguments and state files
// ---------------------------------------------------------------------------

const REPEATABLE = new Set(["account"]);

function parseArgs(argv) {
  const args = { _: [], account: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;
    if (REPEATABLE.has(key)) args[key].push(value);
    else args[key] = value;
  }
  return args;
}

function oneAccount(args) {
  if (args.account.length !== 1 || typeof args.account[0] !== "string") {
    throw failure("MAILKEEPER_ACCOUNT_NOT_FOUND", { reason: "exactly one --account is required" });
  }
  return args.account[0];
}

function runIdOf(args) {
  const runId = args["run-id"];
  if (typeof runId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(runId)) {
    throw failure("MAILKEEPER_OPERATION_FAILED", { reason: "--run-id is required (letters, digits, . _ -)" });
  }
  return runId;
}

/** A path under .mailkeeper that passes through no symlink. */
function statePath(...parts) {
  const target = path.join(STATE, ...parts);
  let current = ROOT;
  for (const part of path.relative(ROOT, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw failure("MAILKEEPER_OPERATION_FAILED", { reason: "state path is a symlink" });
    } catch (error) {
      if (error instanceof MailKeeperFailure) throw error;
      break;
    }
  }
  return target;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Atomic, owner-only JSON write: temp file in the same directory, then rename. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}

function loadRules() {
  const rules = readJson(statePath("rules.json"));
  if (rules?.schemaVersion !== 2 || !rules.config) throw failure("MAILKEEPER_NOT_CONFIGURED");
  return rules;
}

// ---------------------------------------------------------------------------
// Inboxes and contracts
// ---------------------------------------------------------------------------

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The Himalaya config this terminal would use, for setup before the plugin pins one. */
function localHimalayaConfig() {
  return core.resolveHimalayaConfig({
    himalayaConfig: env.HIMALAYA_CONFIG || "",
    home: os.homedir(),
    platform: process.platform,
    appData: env.APPDATA || "",
    exists: isFile,
  });
}

/** The config file pinned by the plugin, so chat, heartbeat and undo agree. */
function pinnedConfig(rules) {
  const pinned = rules?.himalayaConfig;
  if (pinned && Array.isArray(pinned.paths)) {
    const paths = pinned.paths.filter((file) => path.isAbsolute(file) && isFile(file));
    return {
      paths,
      target: pinned.target,
      source: pinned.source,
      missing: paths.length === 0 || paths.length !== pinned.paths.length,
    };
  }
  return localHimalayaConfig();
}

// The host reads heartbeat settings and tasks from HEARTBEAT.md with
// server/utils/heartbeat/taskBlock.js (parseHeartbeatSettingsBlock and
// parseTaskBlock, tested at sha256 6968d4725a15546ed4e925c3562c54bc8d26a3f0ca906f3303c15872621532ec).
// These readers pick the same text and parse a strict YAML subset; anything
// outside it makes the answer unknown rather than a guess.

/** Front-matter `heartbeat:`/`main-task:` blocks, as the host extracts them. */
function heartbeatFrontMatter(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const after = trimmed.slice(3);
  const close = after.indexOf("\n---");
  if (close === -1) return null;
  const lines = after.slice(0, close).split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^(heartbeat|main-task)\s*:/.test(lines[i].trim())) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() && !/^\s/.test(lines[j]) && /^[\w-]+\s*:/.test(lines[j].trim())) {
        end = j;
        break;
      }
    }
    blocks.push(...lines.slice(i, end));
    i = end - 1;
  }
  return blocks.length ? blocks.join("\n") : null;
}

/** The body text from the first line matching `start` to a heading (or `stop`). */
function heartbeatBodyBlock(text, start, stop = null) {
  const lines = text.split("\n");
  const first = lines.findIndex(start);
  if (first === -1) return null;
  const block = [lines[first]];
  for (const line of lines.slice(first + 1)) {
    if (/^#{1,6}\s/.test(line) || (stop && stop.test(line.trim()))) break;
    block.push(line);
  }
  return block.join("\n");
}

const UNSUPPORTED = Symbol("unsupported YAML");
const YAML_KEY = String.raw`(?:([A-Za-z_][A-Za-z0-9_.-]*)|"([^"\\#]*)"|'((?:[^'#]|'')*)')`;
const YAML_KEY_LINE = new RegExp(String.raw`^${YAML_KEY}\s*:(?:\s+(.*))?$`);
// Plain scalars YAML 1.2 types as numbers, booleans or null.
const YAML_TYPED =
  /^(?:[-+]?[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\.[0-9_]+(?:[eE][-+]?[0-9]+)?|0o[0-7_]+|0x[0-9a-fA-F_]+|0b[01_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|null|Null|NULL|~|true|True|TRUE|false|False|FALSE)$/;

/** A key's text; typed plain keys (`1`, `TRUE`, `null`) may collide, so they are unsupported. */
function yamlKey(match) {
  if (match[1] !== undefined) {
    if (/^(true|false|null)$/i.test(match[1])) throw UNSUPPORTED;
    return match[1];
  }
  return match[2] ?? match[3].replace(/''/g, "'");
}

/** A one-line scalar: a string, `{ typed }` for typed plain text, or null when empty. */
function yamlScalar(raw) {
  const text = raw.replace(/^\s*#.*$/, "").trim();
  if (!text) return null;
  let match = /^"([^"\\]*)"\s*(?:#.*)?$/.exec(text);
  if (match) return match[1];
  match = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
  if (match) return match[1].replace(/''/g, "'");
  const plain = text.replace(/\s+#.*$/, "");
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(plain) || /:(\s|$)|\s#/.test(plain)) throw UNSUPPORTED;
  return YAML_TYPED.test(plain) ? { typed: plain } : plain;
}

/** A flat flow mapping with no comments: a Map, or UNSUPPORTED thrown. */
function yamlFlowMap(raw) {
  const match = /^\{([^{}[\]#]*)\}$/.exec(raw.trim());
  if (!match) throw UNSUPPORTED;
  const map = new Map();
  if (!match[1].trim()) return map;
  for (const part of match[1].split(",")) {
    const entry = new RegExp(String.raw`^\s*${YAML_KEY}\s*:(?:\s+(.*?))?\s*$`).exec(part);
    if (!entry) throw UNSUPPORTED;
    const key = yamlKey(entry);
    if (map.has(key)) throw UNSUPPORTED;
    map.set(key, entry[4] === undefined ? null : yamlScalar(entry[4]));
  }
  return map;
}

// Characters YAML rejects (C0/C1 controls, non-characters, lone surrogates,
// a lone CR) and whitespace JavaScript trims but YAML doesn't treat as space.
const YAML_REJECTED_CHARS =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFE\uFFFF\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|\r(?!\n)|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Parse a strict YAML subset: block mappings (Map), block sequences (Array),
 * one-line scalars, literal/folded block scalars and flat flow mappings,
 * indented with spaces only, consuming the whole text. Returns UNSUPPORTED
 * for anything else: duplicate or typed keys, anchors, aliases, tags, tabs,
 * directives, continuation lines, nested flow, explicit or ambiguous block
 * indentation, compact sequences at a mapping's own indent, trailing text
 * outside the document, and characters YAML rejects.
 */
function yamlDocument(text) {
  if (YAML_REJECTED_CHARS.test(text)) return UNSUPPORTED;
  const lines = text.split(/\r?\n/);
  let i = 0;
  const indentOf = (line) => /^ */.exec(line)[0].length;
  const next = () => {
    while (i < lines.length && /^ *(#.*)?$/.test(lines[i])) i += 1;
    if (i >= lines.length) return null;
    const line = lines[i];
    if (/^ *\t/.test(line) || /^(---|\.\.\.|%)/.test(line)) throw UNSUPPORTED;
    return line;
  };
  const isItem = (body) => body === "-" || body.startsWith("- ");

  function node(indent) {
    const line = next();
    if (indentOf(line) !== indent) throw UNSUPPORTED;
    return isItem(line.trim()) ? sequence(indent) : mapping(indent, null);
  }

  function mapping(indent, first) {
    const map = new Map();
    let pending = first;
    for (;;) {
      let key;
      let rest;
      if (pending) {
        ({ key, rest } = pending);
        pending = null;
      } else {
        const line = next();
        if (line === null || indentOf(line) < indent) break;
        if (indentOf(line) > indent || isItem(line.trim())) throw UNSUPPORTED;
        const match = YAML_KEY_LINE.exec(line.trim());
        if (!match) throw UNSUPPORTED;
        key = yamlKey(match);
        rest = match[4];
        i += 1;
      }
      if (map.has(key)) throw UNSUPPORTED;
      map.set(key, value(rest, indent));
    }
    return map;
  }

  function sequence(indent) {
    const list = [];
    for (;;) {
      const line = next();
      if (line === null || indentOf(line) < indent) break;
      const body = line.trim();
      if (indentOf(line) > indent || !isItem(body)) throw UNSUPPORTED;
      i += 1;
      const after = body.slice(1);
      const rest = after.trim();
      const match = rest ? YAML_KEY_LINE.exec(rest) : null;
      if (match) {
        const column = indent + 1 + (after.length - after.trimStart().length);
        list.push(mapping(column, { key: yamlKey(match), rest: match[4] }));
      } else {
        list.push(value(rest, indent));
      }
    }
    return list;
  }

  function value(rest, indent) {
    const text = (rest ?? "").replace(/^\s*#.*$/, "").trim();
    if (!text) {
      const line = next();
      return line === null || indentOf(line) <= indent ? null : node(indentOf(line));
    }
    const block = /^([|>])([-+]?)\s*(?:#.*)?$/.exec(text);
    if (block) return blockScalar(indent, block[2]);
    let result;
    if (text.startsWith("{")) result = yamlFlowMap(text);
    else if (/^\[\s*\]$/.test(text)) result = [];
    else result = yamlScalar(text);
    const line = next();
    if (line !== null && indentOf(line) > indent) throw UNSUPPORTED; // continuation line
    return result;
  }

  function blockScalar(indent, chomp) {
    const content = [];
    let column = null;
    let blankWidth = 0; // widest all-space line before the first content line
    while (i < lines.length) {
      const line = lines[i];
      if (/^ *$/.test(line)) {
        // An all-space line wider than the content indent is content in YAML,
        // and before the first content line it can be an indentation error.
        if (column === null) blankWidth = Math.max(blankWidth, line.length);
        else if (line.length > column) throw UNSUPPORTED;
        content.push("");
        i += 1;
        continue;
      }
      if (/^ *\t/.test(line)) throw UNSUPPORTED;
      const n = indentOf(line);
      if (n <= indent) break;
      if (column === null) {
        if (blankWidth > n) throw UNSUPPORTED;
        column = n;
      }
      if (n < column) throw UNSUPPORTED;
      content.push(line.slice(column));
      i += 1;
    }
    while (content.length && content[content.length - 1] === "") content.pop();
    if (!content.length) {
      if (chomp === "+" || blankWidth > indent) throw UNSUPPORTED;
      return "";
    }
    return content.join("\n") + (chomp === "-" ? "" : "\n");
  }

  try {
    if (next() === null) return null;
    const root = node(indentOf(next()));
    if (next() !== null) throw UNSUPPORTED; // text the document didn't consume
    return root;
  } catch (error) {
    if (error === UNSUPPORTED) return UNSUPPORTED;
    throw error;
  }
}

/** A parsed value as the host's String(...) sees it, or UNSUPPORTED when that depends on YAML typing. */
function yamlText(parsed) {
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed === "string") return parsed;
  return UNSUPPORTED;
}

/**
 * Whether this workspace's heartbeat is on now, as the host's readSettings
 * reads it. A missing file, block or `enabled` value means on (the host's
 * default), and only false (any case, quoted or not) pauses. Null (unknown)
 * for a read error, a path that isn't a file, or YAML outside the subset.
 */
function heartbeatEnabledNow() {
  const file = path.join(ROOT, "HEARTBEAT.md");
  let text;
  try {
    if (!fs.statSync(file).isFile()) return null;
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? true : null;
  }
  // The host uses the front-matter blocks when they parse to a mapping, else the body block.
  const front = heartbeatFrontMatter(text);
  let doc = front === null ? null : yamlDocument(front);
  if (doc === UNSUPPORTED) return null;
  if (!(doc instanceof Map)) {
    const body = heartbeatBodyBlock(text, (line) => /^(heartbeat|main-task)\s*:/.test(line.trim()), /^tasks\s*:/);
    doc = body === null ? null : yamlDocument(body);
    if (doc === UNSUPPORTED) return null;
  }
  const settings = doc instanceof Map ? doc.get("heartbeat") : null;
  if (!(settings instanceof Map)) return true;
  const enabled = settings.get("enabled");
  // The host stringifies collections (["false"] reads as "false"); not followed here.
  if (enabled instanceof Map || Array.isArray(enabled)) return null;
  if (enabled && typeof enabled === "object" && "typed" in enabled) {
    return enabled.typed.toLowerCase() !== "false";
  }
  return typeof enabled !== "string" || enabled.trim().toLowerCase() !== "false";
}

/**
 * This workspace's heartbeat task `taskId` as the host's parseTaskBlock would
 * return it: `{ interval }`, null when the host's task list provably doesn't
 * contain it, or undefined when that can't be established here (front matter,
 * YAML outside the subset, a list the host would set aside for its older
 * formats, typed values, a duplicated id, or any `cron` key on the task).
 */
function managedTaskNow(taskId) {
  const file = path.join(ROOT, "HEARTBEAT.md");
  let text;
  try {
    if (!fs.statSync(file).isFile()) return undefined;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (text.trimStart().startsWith("---")) return undefined;
  const body = heartbeatBodyBlock(text, (line) => /^(heartbeat|main-task|tasks)\s*:/.test(line));
  const doc = body === null ? UNSUPPORTED : yamlDocument(body);
  if (!(doc instanceof Map) || !Array.isArray(doc.get("tasks"))) return undefined;
  const settings = doc.get("heartbeat");
  const yamlOnly = /^\s+(runtime-options|runtimeOptions|runtime-option-values|runtimeOptionValues|skills)\s*:\s*(?:$|[[{])/m.test(text);
  if (!yamlOnly && !(settings instanceof Map || Array.isArray(settings) || (typeof settings === "string" && settings))) {
    return undefined;
  }
  const accepted = [];
  for (const item of doc.get("tasks")) {
    if (!(item instanceof Map)) continue;
    const fields = {};
    for (const key of ["id", "name", "interval", "executor", "command", "prompt"]) {
      const text = yamlText(item.get(key));
      if (text === UNSUPPORTED) return undefined;
      fields[key] = text;
    }
    if (!String(fields.name ?? "").trim()) continue;
    const executor = String(fields.executor ?? "").trim().toLowerCase();
    if (executor === "shell" ? !String(fields.command ?? "").trim() : !fields.prompt) continue;
    accepted.push({ ...fields, cron: item.has("cron") });
  }
  if (!accepted.length) return undefined;
  const mine = accepted.filter((task) => String(task.id ?? "").trim() === taskId);
  if (mine.length > 1 || mine[0]?.cron) return undefined;
  if (!mine.length) return null;
  return { interval: mine[0].interval === null ? null : mine[0].interval.trim() };
}

/**
 * The schedule as it is now. rules.json's schedule counts only while the
 * latest provisioning attempt is the ready one that wrote it; then a schedule
 * is claimed only when the heartbeat is on and the host's task list has the
 * managed task with that interval. Each value is null when it can't be
 * established.
 */
function scheduleNow(rules) {
  const saved = rules.schedule || {};
  const provisioning = readJson(statePath("provisioning.json"));
  const outcome = typeof provisioning?.state === "string" ? provisioning.state : null;
  const attempt = typeof provisioning?.attempt === "string" && provisioning.attempt ? provisioning.attempt : null;
  const current = outcome === "ready" && attempt !== null && rules.provisionAttempt === attempt;
  const enabled = heartbeatEnabledNow();
  let task = null;
  let scheduled = null;
  if (current && saved.manual === true) {
    scheduled = false;
  } else if (current) {
    const found = typeof saved.taskId === "string" ? managedTaskNow(saved.taskId) : undefined;
    task = found === undefined ? null : { found: Boolean(found), interval: found?.interval ?? null };
    if (found === null) scheduled = false;
    else if (found && enabled !== null) {
      scheduled = enabled && String(found.interval || "").toLowerCase() === String(saved.cadence).toLowerCase();
    }
  }
  const schedule = {
    applied: outcome === null || (outcome === "ready" && !current) ? null : outcome === "ready",
    outcome,
    cadence: current ? saved.cadence ?? null : null,
    cadenceLabel: current ? saved.cadenceLabel ?? null : null,
    manual: current ? saved.manual === true : null,
    threadSlug: saved.threadSlug ?? null,
    threadName: saved.threadName ?? null,
    heartbeatEnabled: enabled,
    paused: enabled === null ? null : !enabled,
    task,
    scheduled,
  };
  return { ...schedule, closing: scheduleClosing(schedule) };
}

/**
 * Which setup closing applies, first match wins (SKILL.md, "Settings and
 * schedule"): a known unapplied outcome; anything that isn't a current
 * applied `ready`; Manual; paused or pause unknown; task not active or
 * unknown; scheduled.
 */
function scheduleClosing(schedule) {
  if (schedule.applied === false && ["config_invalid", "pending", "disabled"].includes(schedule.outcome)) {
    return schedule.outcome;
  }
  if (schedule.outcome !== "ready" || schedule.applied !== true || schedule.manual === null) return "unreadable";
  if (schedule.manual) return "manual";
  if (schedule.paused === true) return "paused";
  if (schedule.paused === null) return "pause_unknown";
  if (schedule.scheduled === false) return "task_inactive";
  if (schedule.scheduled === null) return "unreadable";
  return "scheduled";
}

function contractFile(key) {
  const relative = core.contractRelativePath(key);
  const target = path.join(ROOT, relative);
  let current = ROOT;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw failure("MAILKEEPER_CONTRACT_INVALID", { reason: "contract path is a symlink" });
    } catch (error) {
      if (error instanceof MailKeeperFailure) throw error;
      break;
    }
  }
  return { relative, target };
}

/**
 * Resolve one inbox for this workspace: selected, key matches the plugin's
 * record, contract read live, and the effective policy computed from the
 * workspace caps and that contract alone.
 */
function inboxFor(rules, account, { requestedMode } = {}) {
  if (!core.validAccountName(account) || !rules.config.emailAccounts.includes(account)) {
    throw failure("MAILKEEPER_ACCOUNT_NOT_FOUND", { account: core.validAccountName(account) ? account : null });
  }
  const key = core.accountKey(account);
  const recorded = Object.prototype.hasOwnProperty.call(rules.accounts || {}, account) ? rules.accounts[account] : null;
  if (!recorded || recorded.key !== key) throw failure("MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH", { account });
  const file = contractFile(key);
  let text;
  try {
    text = fs.readFileSync(file.target, "utf8");
  } catch {
    throw failure("MAILKEEPER_CONTRACT_INVALID", { account, contract: file.relative, reason: "contract missing" });
  }
  const contract = core.parseContract(text, account);
  const policy = core.effectivePolicy(rules.config, contract, {
    requestedMode: requestedMode && core.MODES.includes(requestedMode) ? requestedMode : undefined,
  });
  return { account, key, contractPath: file.relative, contract, policy };
}

// ---------------------------------------------------------------------------
// Mailbox access through himalaya-runner.js
// ---------------------------------------------------------------------------

function lastJsonLine(stdout) {
  const lines = String(stdout || "").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && "ok" in parsed && "op" in parsed) return parsed;
    } catch {
      /* not the runner's line */
    }
  }
  return null;
}

/**
 * Run one bounded operation for one inbox with that inbox's own credential.
 * A Secrets password is resolved by rtxexec into the runner's environment;
 * this process only ever handles the reference.
 */
function mailboxOp(rules, inbox, op, opArgs = [], { mutating = false } = {}) {
  const config = pinnedConfig(rules);
  if (config.missing) throw failure("MAILKEEPER_HIMALAYA_CONFIG_MISSING", { account: inbox.account });
  const credential = inbox.policy.credential;
  if (!credential) throw failure("MAILKEEPER_CREDENTIAL_UNAVAILABLE", { account: inbox.account });

  const runnerArgs = [
    RUNNER, op,
    "--account", inbox.account,
    ...config.paths.flatMap((file) => ["--config", file]),
    "--timeout-ms", String(RUNNER_TIMEOUT_MS),
    ...opArgs,
  ];
  const childEnv = { ...env, MAILKEEPER_CREDENTIAL_KIND: credential.kind };
  delete childEnv.MAILKEEPER_IMAP_PASSWORD;
  delete childEnv.MAILKEEPER_AUTH_ACCOUNT;
  const [command, args] =
    credential.kind === "realtimex-secret"
      ? [RTXEXEC, ["--env", `MAILKEEPER_IMAP_PASSWORD=${credential.passwordRef}`, "--", process.execPath, ...runnerArgs]]
      : [process.execPath, runnerArgs];
  const result = spawnSync(command, args, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    timeout: RUNNER_TIMEOUT_MS + 30_000,
  });
  if (result.error?.code === "ENOENT") {
    throw failure(command === RTXEXEC ? "MAILKEEPER_RTXEXEC_UNAVAILABLE" : "MAILKEEPER_OPERATION_FAILED", { account: inbox.account });
  }
  const parsed = lastJsonLine(result.stdout);
  if (!parsed) {
    if (result.error?.code === "ETIMEDOUT") {
      throw failure(mutating ? "MAILKEEPER_MUTATION_UNCERTAIN" : "MAILKEEPER_TIMEOUT", { account: inbox.account });
    }
    // rtxexec refused before the runner started: no mailbox was contacted.
    if (credential.kind === "realtimex-secret") {
      const sessionMissing = /terminal session|inside RealTimeX/i.test(String(result.stderr || ""));
      throw failure(sessionMissing ? "MAILKEEPER_SESSION_UNAVAILABLE" : "MAILKEEPER_CREDENTIAL_UNAVAILABLE", { account: inbox.account });
    }
    throw failure(mutating ? "MAILKEEPER_MUTATION_UNCERTAIN" : "MAILKEEPER_OPERATION_FAILED", { account: inbox.account });
  }
  if (!parsed.ok) throw failure(parsed.code, { account: inbox.account });
  return parsed.data;
}

function folderNames(rules, inbox) {
  const folders = mailboxOp(rules, inbox, "folder-list");
  return Array.isArray(folders) ? folders.map((folder) => String(folder?.name || "")).filter(Boolean) : [];
}

function normalize(row, folder, now) {
  const addr = String(row.from?.addr || "").toLowerCase();
  const date = row.date ? Date.parse(row.date) : NaN;
  return {
    uid: String(row.id),
    folder,
    date: row.date || null,
    ageDays: Number.isFinite(date) ? Math.floor((now - date) / 86_400_000) : 0,
    fromName: row.from?.name || "",
    fromAddress: addr,
    fromDomain: addr.includes("@") ? addr.split("@").pop() : "",
    subject: row.subject || "",
    flags: Array.isArray(row.flags) ? row.flags : [],
  };
}

function listAll(rules, inbox, folder, query) {
  const out = [];
  const now = Date.now();
  for (let page = 1; page <= 2000; page += 1) {
    const rows = mailboxOp(rules, inbox, "envelope-list", [
      "--folder", folder, "--page", String(page), "--size", String(BATCH), ...(query ? ["--query", query] : []),
    ]);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) out.push(normalize(row, folder, now));
    if (rows.length < BATCH) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runs and the workspace run guard
// ---------------------------------------------------------------------------

function runFile(runId) {
  return statePath("runs", `${runId}.json`);
}

function lockFile() {
  return statePath("run.lock");
}

function readLock() {
  return readJson(lockFile());
}

/**
 * The terminal session this helper runs in, as the host injected it: the
 * agent context's `terminalSessionId`, or the older variable. Null when
 * neither is set or they disagree.
 */
function terminalSessionId() {
  let fromContext = null;
  try {
    const context = JSON.parse(env.RTX_AGENT_CONTEXT_JSON || "null");
    if (typeof context?.terminalSessionId === "string") fromContext = context.terminalSessionId;
  } catch {
    fromContext = null;
  }
  const legacy = env.REALTIMEX_TERMINAL_SESSION_ID || null;
  if (fromContext && legacy && fromContext !== legacy) return null;
  const id = fromContext || legacy;
  return id && /^[A-Za-z0-9:._-]{1,128}$/.test(id) ? id : null;
}

/**
 * One run at a time per workspace, across chat, heartbeat and undo. The
 * guard is a file created exclusively and owned by a run ID, recording the
 * terminal session that took it; it is never taken over just because time
 * passed. Another run's guard means its end isn't confirmed, not that it is
 * still running: this helper can't tell.
 */
function acquireGuard(runId, trigger, owner) {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(lockFile(), JSON.stringify({ runId, trigger, startedAt: new Date().toISOString(), owner }), {
      flag: "wx",
      mode: 0o600,
    });
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const lock = readLock();
  if (lock?.runId !== runId) {
    // Confirmed moves the earlier run recorded, so the person hears their undo is kept.
    const held = typeof lock?.runId === "string" ? readJson(runFile(lock.runId)) : null;
    throw failure("MAILKEEPER_RUN_BUSY", {
      heldBy: lock?.runId || null,
      heldRunMoved: held?.runId === lock?.runId && Array.isArray(held?.actions) ? held.actions.length : null,
      heldSince: typeof lock?.startedAt === "string" ? lock.startedAt : null,
      heldByTrigger: typeof lock?.trigger === "string" ? lock.trigger : null,
      ownerRecorded: Boolean(lock?.owner?.terminalSessionId),
      ownerState: "unknown",
    });
  }
}

function releaseGuard(runId, run) {
  const lock = readLock();
  if (lock?.runId !== runId) return false;
  if (run?.pending || run?.uncertain?.length) return false;
  fs.rmSync(lockFile(), { force: true });
  return true;
}

function newRun(runId, rules, requested, trigger, owner) {
  return {
    schemaVersion: 2,
    runId,
    trigger,
    // The terminal session that began the run (null when not injected).
    owner,
    startedAt: new Date().toISOString(),
    rulesRevision: rules.revision,
    effort: rules.config.effort || null,
    requested,
    accounts: {},
    actions: [],
    uncertain: [],
    pending: null,
    proposals: [],
    urgent: [],
    passes: [],
    previews: {},
  };
}

/** Record an inbox's contract identity the first time a run touches it. */
function enrollAccount(run, inbox) {
  if (!run.requested.includes(inbox.account)) run.requested.push(inbox.account);
  if (!core.own(run.accounts, inbox.account)) {
    core.setOwn(run.accounts, inbox.account, {
      key: inbox.key,
      contract: inbox.contractPath,
      contractDigest: inbox.contract.digest,
      contractStatus: inbox.contract.status,
      mode: inbox.policy.mode,
      steps: [],
      outcome: null,
      code: inbox.contract.code,
    });
  }
  return core.own(run.accounts, inbox.account);
}

/**
 * Load the run for a per-inbox command: the guard must belong to it, and a
 * run started implicitly (no `begin`) covers every selected inbox.
 */
function runFor(args, rules) {
  const runId = runIdOf(args);
  let run = readJson(runFile(runId));
  if (run?.submittedAt) throw failure("MAILKEEPER_OPERATION_FAILED", { reason: `run ${runId} was already submitted` });
  const owner = run?.owner || { terminalSessionId: terminalSessionId() };
  acquireGuard(runId, run?.trigger || "chat", owner);
  if (!run) run = newRun(runId, rules, [...rules.config.emailAccounts], "chat", owner);
  return run;
}

function saveRun(run) {
  writeJson(runFile(run.runId), run);
}

const BLOCKING_CODES = new Set([
  "MAILKEEPER_HIMALAYA_UNAVAILABLE",
  "MAILKEEPER_HIMALAYA_VERSION_UNSUPPORTED",
  "MAILKEEPER_HIMALAYA_CONFIG_MISSING",
  "MAILKEEPER_HIMALAYA_CONFIG_INVALID",
  "MAILKEEPER_ACCOUNT_NOT_FOUND",
  "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH",
  "MAILKEEPER_CONTRACT_INVALID",
  "MAILKEEPER_CONTRACT_CHANGED",
  "MAILKEEPER_CREDENTIAL_UNAVAILABLE",
  "MAILKEEPER_RTXEXEC_UNAVAILABLE",
  "MAILKEEPER_SESSION_UNAVAILABLE",
  "MAILKEEPER_IMAP_CHECK_FAILED",
  "MAILKEEPER_NETWORK_DENIED",
  "MAILKEEPER_TIMEOUT",
]);

/** Mark one inbox blocked or failed in the run; other inboxes carry on. */
function recordFailure(run, account, code) {
  const entry = core.own(run.accounts, account);
  if (!entry) return;
  const outcome = BLOCKING_CODES.has(code) ? "blocked" : "failed";
  if (entry.outcome !== "failed") {
    entry.outcome = outcome;
    entry.code = code;
  }
}

/**
 * Re-check, right before a mutation, that the inbox is still selected and
 * that neither its contract nor the approved rules changed since the run
 * first read them.
 */
function revalidate(run, rules, account) {
  const fresh = loadRules();
  if (!fresh.config.emailAccounts.includes(account)) throw failure("MAILKEEPER_ACCOUNT_NOT_FOUND", { account });
  if (fresh.revision !== run.rulesRevision) throw failure("MAILKEEPER_CONTRACT_CHANGED", { account, reason: "approved rules changed" });
  const inbox = inboxFor(fresh, account);
  if (inbox.contract.digest !== core.own(run.accounts, account)?.contractDigest) {
    throw failure("MAILKEEPER_CONTRACT_CHANGED", { account, reason: "contract changed" });
  }
  return inbox;
}

// ---------------------------------------------------------------------------
// Snapshot and passes
// ---------------------------------------------------------------------------

function snapshotFile(inbox) {
  return statePath("accounts", inbox.key, "snapshot.json");
}

function loadSnapshot(inbox) {
  const snapshot = readJson(snapshotFile(inbox));
  if (!snapshot?.envelopes) {
    throw failure("MAILKEEPER_OPERATION_FAILED", { account: inbox.account, procedural: true, reason: "no snapshot yet; run snapshot first" });
  }
  // A snapshot written for another inbox must never drive this one.
  if (snapshot.account !== inbox.account || snapshot.key !== inbox.key) {
    throw failure("MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH", { account: inbox.account });
  }
  return snapshot;
}

function buildContext(rules, inbox, snapshot) {
  const policy = inbox.policy;
  const identity = readJson(statePath("identity.json"), null);
  const senderCounts = new Map();
  for (const e of snapshot.envelopes) senderCounts.set(e.fromAddress, (senderCounts.get(e.fromAddress) || 0) + 1);
  const repliedTo = new Set(snapshot.repliedTo || []);
  const knownDomains = new Set([...(snapshot.sentDomains || []), ...(identity?.knownDomains || [])]);
  const protectedDomains = policy.protectedDomains.map((d) => d.toLowerCase());
  const isProtected = (e) =>
    policy.vipSenders.some((entry) => core.senderMatches(entry, e.fromAddress, e.fromDomain)) ||
    protectedDomains.some((d) => e.fromDomain === d.replace(/^\./, "") || e.fromDomain.endsWith(d.startsWith(".") ? d : `.${d}`)) ||
    e.flags.includes("Flagged");
  const isConfirmFirst = (e) => CONFIRM_FIRST_RE.test(e.subject);
  return { rules, policy, identity, senderCounts, repliedTo, knownDomains, isProtected, isConfirmFirst };
}

function urgentHits(snapshot) {
  return snapshot.envelopes.filter((e) => URGENT_RE.test(e.subject) || URGENT_DOMAIN_RE.test(e.fromDomain));
}

function candidates(passName, ctx, snapshot, urgent) {
  const pass = PASSES[passName];
  if (!pass) throw failure("MAILKEEPER_OPERATION_FAILED", { procedural: true, reason: `unknown pass; one of ${Object.keys(PASSES).join(", ")}` });
  const urgentUids = new Set(urgent.map((e) => e.uid));
  return snapshot.envelopes.filter(
    (e) => !urgentUids.has(e.uid) && !ctx.isProtected(e) && !ctx.isConfirmFirst(e) && pass.match(e, ctx)
  );
}

function summarize(list) {
  const bySender = new Map();
  for (const e of list) bySender.set(e.fromAddress, (bySender.get(e.fromAddress) || 0) + 1);
  const top = [...bySender.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    count: list.length,
    topSenders: top.map(([sender, n]) => ({ sender, count: n })),
    sampleSubjects: list.slice(0, 10).map((e) => `${e.fromAddress} — ${e.subject.slice(0, 90)}`),
  };
}

/** Destination for a pass at a mode, or null when this inbox can't take it. */
function targetFolder(passName, ctx, mode) {
  const pass = PASSES[passName];
  if (pass.action === "archive") {
    if (mode === "archive-promoted") return ctx.policy.archiveFolder; // null: no archive folder set
    return `${ctx.policy.autoFolderPrefix}/Aged`; // label-only downgrade
  }
  return `${ctx.policy.autoFolderPrefix}/${pass.action}`;
}

function ensureFolder(rules, inbox, name) {
  if (folderNames(rules, inbox).includes(name)) return;
  mailboxOp(rules, inbox, "folder-add", ["--name", name]);
}

/**
 * Move UIDs in chunks. Before each chunk the intended move is written to the
 * run as `pending`; a confirmed chunk becomes actions, an unknown result
 * becomes `uncertain` and stops further moves for this inbox. Confirmed
 * chunks are kept whatever happens later.
 */
function moveChunks(run, rules, inbox, envelopes, from, to, extra) {
  let moved = 0;
  for (let i = 0; i < envelopes.length; i += BATCH) {
    const chunk = envelopes.slice(i, i + BATCH);
    run.pending = { account: inbox.account, from, to, uids: chunk.map((e) => e.uid), ...extra, at: new Date().toISOString() };
    saveRun(run);
    try {
      mailboxOp(rules, inbox, "message-move", ["--from", from, "--to", to, ...chunk.flatMap((e) => ["--uid", e.uid])], { mutating: true });
    } catch (error) {
      if (error.code === "MAILKEEPER_MUTATION_UNCERTAIN") run.uncertain.push(run.pending);
      run.pending = null;
      saveRun(run);
      throw error;
    }
    for (const e of chunk) {
      run.actions.push({
        kind: "move",
        account: inbox.account,
        uid: e.uid,
        from,
        to,
        date: e.date,
        fromAddress: e.fromAddress,
        subject: e.subject.slice(0, 200),
        ...extra,
      });
    }
    run.pending = null;
    moved += chunk.length;
    saveRun(run);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Himalaya config stanza (setup)
// ---------------------------------------------------------------------------

const TABLE_RE = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/;

function accountTableName(header) {
  // [accounts.name] or [accounts."name"] (with optional sub-table suffix)
  const match = /^accounts\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))(\..*)?$/.exec(header);
  if (!match) return null;
  const name = match[1] !== undefined ? JSON.parse(`"${match[1]}"`) : match[2];
  return { name, subTable: Boolean(match[3]) };
}

/** Locate one account's stanza by table headers only; values are never parsed out. */
function findStanza(lines, account) {
  let start = -1;
  let end = lines.length;
  let subTables = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const header = TABLE_RE.exec(lines[i]);
    if (!header) continue;
    const table = accountTableName(header[1]);
    if (start !== -1 && end === lines.length && !(table && table.name === account && table.subTable)) end = i;
    if (table && table.name === account) {
      if (table.subTable) subTables += 1;
      else if (start === -1) start = i;
    }
  }
  return { start, end, subTables };
}

function keyName(line) {
  const match = /^\s*([A-Za-z0-9_.\-"]+)\s*=/.exec(line);
  return match ? match[1].replace(/"/g, "") : null;
}

/** Describe a stanza by key names only; never echo values. */
function describeStanza(lines, stanza) {
  const keys = lines.slice(stanza.start + 1, stanza.end).map(keyName).filter(Boolean);
  const authLine = lines
    .slice(stanza.start + 1, stanza.end)
    .find((line) => /^(backend\.auth\.(cmd|command))\s*=/.test(line.trim()));
  const inlineSecret = keys.some((key) => /(^|\.)(raw|password|passwd)$/.test(key) && !/auth\.type$/.test(key));
  let auth = "none";
  if (authLine) auth = authLine.includes(AUTH_HELPER) ? "mailkeeper-secrets" : authLine.includes("himalaya-auth.js") ? "mailkeeper-secrets-moved" : "command";
  else if (keys.some((key) => /keyring/.test(key))) auth = "keyring";
  else if (inlineSecret) auth = "inline-secret";
  return { keys, auth, inlineSecret };
}

/** Inbox names and their `email` values (non-secret), by table header and key only. */
function listStanzas(lines) {
  const entries = [];
  let current = null;
  for (const line of lines) {
    const header = TABLE_RE.exec(line);
    if (header) {
      const table = accountTableName(header[1]);
      current = table && !table.subTable ? { name: table.name, email: null } : null;
      if (current) entries.push(current);
      continue;
    }
    const email = current && /^\s*email\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(line);
    if (email) {
      try {
        current.email = JSON.parse(email[1]).toLowerCase();
      } catch {
        /* not a plain basic string: ignore */
      }
    }
  }
  return entries;
}

function renderStanza({ account, email, host, port, encryption, login }) {
  const helper = [process.execPath, AUTH_HELPER].map(core.shellQuote).join(" ") + ` --account ${core.shellQuote(account)}`;
  // JSON string escapes are valid TOML basic-string escapes.
  return [
    `[accounts.${JSON.stringify(account)}]`,
    `email = ${JSON.stringify(email)}`,
    'backend.type = "imap"',
    `backend.host = ${JSON.stringify(host)}`,
    `backend.port = ${port}`,
    `backend.encryption.type = ${JSON.stringify(encryption)}`,
    `backend.login = ${JSON.stringify(login)}`,
    'backend.auth.type = "password"',
    `backend.auth.cmd = ${JSON.stringify(helper)}`,
  ];
}

/**
 * Account names in one Himalaya config file, without signing in. Throws a
 * fixed code: a config Himalaya cannot parse is invalid; any other failure of
 * the tool itself is not blamed on the user's settings.
 */
function himalayaAccounts(file) {
  const result = spawnSync(HIMALAYA, ["account", "list", "-o", "json", "--quiet", "-c", file], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error?.code === "ENOENT") throw failure("MAILKEEPER_HIMALAYA_UNAVAILABLE");
  if (result.status !== 0) {
    throw failure(/cannot (parse|read) config/i.test(String(result.stderr || "")) ? "MAILKEEPER_HIMALAYA_CONFIG_INVALID" : "MAILKEEPER_OPERATION_FAILED");
  }
  try {
    const rows = JSON.parse(result.stdout || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch {
    throw failure("MAILKEEPER_OPERATION_FAILED");
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Setup: inboxes that may not be selected yet
// ---------------------------------------------------------------------------

const CONTRACT_TEMPLATE = path.join(__dirname, "..", "templates", "MAILBOX.md");
/**
 * Display names the RealTimeX settings picker shows for terminal agents, for
 * the setup closing message only. An unknown agent shows its key.
 */
const AGENT_LABELS = {
  antigravity: "Antigravity CLI",
  grok: "Grok CLI",
  devin: "Devin CLI",
  gemini: "Gemini CLI",
  claude: "Claude Code",
  codex: "Codex CLI",
  qwen: "Qwen Code",
  rtx: "RealtimeX Agent",
  opencode: "OpenCode",
  cursor: "Cursor Agent",
  copilot: "GitHub Copilot",
  kiro: "Kiro CLI",
  kimi: "Kimi CLI",
  kilocode: "Kilocode",
  droid: "Factory Droid",
  goose: "Goose",
  iflow: "iFlow CLI",
  pi: "Pi Coding Agent",
};
const DEFAULT_CAPS = {
  mode: "report-only",
  ageThresholdDays: 90,
  promotablePasses: [],
  vipSenders: [],
  protectedDomains: [],
  autoFolderPrefix: "Auto",
};

/**
 * Setup-time view of one inbox. Setup connects and drafts a contract before
 * the user selects the inbox in settings, so it needs only the inbox to be
 * in the email settings, never the workspace selection.
 */
function setupInbox(account) {
  if (!core.validAccountName(account)) throw failure("MAILKEEPER_ACCOUNT_NOT_FOUND");
  const rules = readJson(statePath("rules.json"));
  const config = rules?.schemaVersion === 2 ? pinnedConfig(rules) : localHimalayaConfig();
  if (config.missing) throw failure("MAILKEEPER_HIMALAYA_CONFIG_MISSING", { file: config.target });
  const listed = himalayaAccounts(config.paths[0]);
  if (!listed.some((row) => row?.name === account)) throw failure("MAILKEEPER_ACCOUNT_NOT_FOUND", { account });
  const key = core.accountKey(account);
  const recorded = core.own(rules?.accounts, account);
  if (recorded && recorded.key !== key) throw failure("MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH", { account });
  const file = contractFile(key);
  const text = isFile(file.target) ? fs.readFileSync(file.target, "utf8") : null;
  return {
    account,
    key,
    file,
    text,
    contract: text === null ? null : core.parseContract(text, account),
    rules: rules?.schemaVersion === 2 ? rules : null,
    caps: rules?.schemaVersion === 2 ? rules.config : DEFAULT_CAPS,
    selected: Boolean(rules?.config?.emailAccounts?.includes(account)),
  };
}

/**
 * `--password-ref <reference>` or `--native`, as a contract credential. The
 * reference is the Login's exact `reference` from Secrets metadata; only the
 * documented `#password` field selector is added, never a name rebuilt from
 * what the user typed.
 */
function credentialFromArgs(args) {
  if (args.native === true) return { kind: "himalaya-native" };
  if (args.login !== undefined) {
    throw failure("MAILKEEPER_CREDENTIAL_UNAVAILABLE", { reason: "use --password-ref with the Login's exact reference from Secrets metadata" });
  }
  if (typeof args["password-ref"] === "string") {
    const reference = args["password-ref"];
    const passwordRef = reference.includes("#") ? reference : `${reference}#password`;
    const credential = { kind: "realtimex-secret", passwordRef };
    if (!core.parseContract(core.renderPolicyBlock({ ...core.draftPolicy("x", DEFAULT_CAPS), credential }), "x").policy) {
      throw failure("MAILKEEPER_CREDENTIAL_UNAVAILABLE", { reason: "--password-ref must be a Login's secret reference" });
    }
    return credential;
  }
  return undefined;
}

function listArg(value) {
  if (value === undefined) return undefined;
  if (value === true || value === "none") return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function checkFile(key) {
  return statePath("accounts", key, "check.json");
}

function writeContract(file, before, content) {
  // Refuse to overwrite an edit made since we read the contract.
  const current = isFile(file.target) ? fs.readFileSync(file.target, "utf8") : null;
  if (current !== before) throw failure("MAILKEEPER_CONTRACT_CHANGED", { reason: "the contract changed meanwhile; read it again" });
  const temp = path.join(path.dirname(file.target), `.MAILBOX.md.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  fs.renameSync(temp, file.target);
}

/**
 * Run one per-inbox step inside a run. Whatever fails is recorded against
 * that inbox (blocked or failed, with its fixed code) so the run carries on
 * with the others; procedural mistakes such as a missing preview are not.
 */
function perInbox(args, body, { requestedMode } = {}) {
  const rules = loadRules();
  const run = runFor(args, rules);
  const account = oneAccount(args);
  try {
    const inbox = inboxFor(rules, account, { requestedMode });
    const entry = enrollAccount(run, inbox);
    const result = body({ rules, run, account, inbox, entry });
    saveRun(run);
    output({ ok: true, runId: run.runId, ...result });
  } catch (error) {
    if (run.requested.includes(account) && !error.detail?.procedural) {
      if (!core.own(run.accounts, account)) core.setOwn(run.accounts, account, { steps: [], outcome: null, code: null });
      recordFailure(run, account, error.code || "MAILKEEPER_OPERATION_FAILED");
      if (error instanceof MailKeeperFailure) {
        error.detail = { ...error.detail, account, movedBeforeProblem: run.actions.filter((a) => a.account === account).length };
      }
    }
    saveRun(run);
    throw error;
  }
}

const commands = {
  accounts() {
    const rules = readJson(statePath("rules.json"));
    const config = rules?.schemaVersion === 2 ? pinnedConfig(rules) : localHimalayaConfig();
    const local = localHimalayaConfig();
    const selected = rules?.config?.emailAccounts || [];
    let available = [];
    let code = null;
    if (config.missing) code = "MAILKEEPER_HIMALAYA_CONFIG_MISSING";
    else {
      try {
        available = himalayaAccounts(config.paths[0]).map((row) => String(row?.name || "")).filter(core.validAccountName);
      } catch (error) {
        code = error.code;
      }
    }
    const inboxes = [...new Set([...selected, ...available])].map((name) => {
      const key = core.accountKey(name);
      const { relative, target } = contractFile(key);
      let contract = { status: "missing", code: null };
      if (isFile(target)) {
        const parsed = core.parseContract(fs.readFileSync(target, "utf8"), name);
        contract = { status: parsed.status, code: parsed.code };
      }
      return {
        name,
        lookedAfterHere: selected.includes(name),
        inEmailSettings: available.includes(name),
        contract: relative,
        contractStatus: contract.status,
        code: selected.includes(name) && !available.includes(name) && !code ? "MAILKEEPER_ACCOUNT_NOT_FOUND" : contract.code,
      };
    });
    output({
      ok: !code,
      ...(code ? { code, message: MESSAGES[code] } : {}),
      emailSettings: { file: config.target, exists: !config.missing, source: config.source },
      ...(rules && local.target !== config.target ? { terminalWouldUse: local.target } : {}),
      configured: Boolean(rules?.schemaVersion === 2),
      inboxes,
    });
  },

  "config-check"(args) {
    const account = oneAccount(args);
    const rules = readJson(statePath("rules.json"));
    const config = rules?.schemaVersion === 2 ? pinnedConfig(rules) : localHimalayaConfig();
    if (config.missing) throw failure("MAILKEEPER_HIMALAYA_CONFIG_MISSING", { file: config.target });
    const lines = fs.readFileSync(config.paths[0], "utf8").split("\n");
    const stanza = findStanza(lines, account);
    if (stanza.start === -1) {
      output({ ok: true, account, file: config.paths[0], exists: false });
      return;
    }
    const description = describeStanza(lines, stanza);
    output({
      ok: true,
      account,
      file: config.paths[0],
      exists: true,
      keys: description.keys,
      signIn: description.auth,
      inlineSecret: description.inlineSecret,
      subTables: stanza.subTables,
      repairable: stanza.subTables === 0,
    });
  },

  "account-config"(args) {
    const account = oneAccount(args);
    if (!core.validAccountName(account)) throw failure("MAILKEEPER_ACCOUNT_NOT_FOUND");
    const email = String(args.email || "");
    const host = String(args.host || "");
    const port = Number(args.port || 993);
    const encryption = String(args.encryption || (port === 993 ? "tls" : "start-tls"));
    const login = String(args.login || email);
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !/^[A-Za-z0-9.-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw failure("MAILKEEPER_HIMALAYA_CONFIG_INVALID", { reason: "check --email, --host and --port" });
    }
    if (!["tls", "start-tls", "none"].includes(encryption) || !login || /[\u0000-\u001f]/.test(login)) {
      throw failure("MAILKEEPER_HIMALAYA_CONFIG_INVALID", { reason: "check --encryption and --login" });
    }
    const rules = readJson(statePath("rules.json"));
    const config = rules?.schemaVersion === 2 ? pinnedConfig(rules) : localHimalayaConfig();
    const file = config.paths[0] || config.target;
    const before = isFile(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = before ? before.split("\n") : [];
    const stanza = findStanza(lines, account);
    if (stanza.subTables) {
      throw failure("MAILKEEPER_HIMALAYA_CONFIG_INVALID", { reason: "this inbox's entry uses sub-tables; repair it by hand" });
    }
    // Existing names and aliases are the user's: never rename, merge or
    // silently overwrite one. The user picks the existing entry, a distinct
    // name, or (--replace) an explicit repair of this exact entry.
    const others = listStanzas(lines).filter((entry) => entry.name !== account);
    const sameName = others.find((entry) => entry.name.toLowerCase() === account.toLowerCase());
    const sameAddress = others.find((entry) => entry.email && entry.email === email.toLowerCase());
    if (sameName || sameAddress) {
      throw failure("MAILKEEPER_ACCOUNT_EXISTS", { account, existingAccount: (sameName || sameAddress).name });
    }
    if (stanza.start !== -1 && args.replace !== true) {
      throw failure("MAILKEEPER_ACCOUNT_EXISTS", { account, existingAccount: account });
    }
    const replaced = stanza.start === -1 ? null : describeStanza(lines, stanza);
    const stanzaLines = renderStanza({ account, email, host, port, encryption, login });
    const next =
      stanza.start === -1
        ? [...lines, "", ...stanzaLines]
        : [...lines.slice(0, stanza.start), ...stanzaLines, "", ...lines.slice(stanza.end)];
    const content = `${next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, "")}\n`;

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(file), `.mailkeeper-${crypto.randomUUID()}.toml`);
    fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    try {
      let listed = [];
      try {
        listed = himalayaAccounts(temp);
      } catch (error) {
        if (error.code === "MAILKEEPER_HIMALAYA_UNAVAILABLE") throw error;
      }
      if (!listed.some((row) => row?.name === account)) {
        throw failure("MAILKEEPER_HIMALAYA_CONFIG_INVALID", { reason: "the updated settings did not validate" });
      }
      // Refuse to overwrite an edit made while we were working.
      const current = isFile(file) ? fs.readFileSync(file, "utf8") : "";
      if (core.digest(current) !== core.digest(before)) {
        throw failure("MAILKEEPER_HIMALAYA_CONFIG_INVALID", { reason: "the settings file changed meanwhile; run again" });
      }
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    output({
      ok: true,
      account,
      file,
      created: !before,
      replacedEntry: Boolean(replaced),
      // A replaced entry that held a password in the file: that password has
      // been exposed on disk and should be changed with the provider.
      removedInlineSecret: Boolean(replaced?.inlineSecret),
      signIn: "mailkeeper-secrets",
    });
  },

  "contract-check"(args) {
    const rules = loadRules();
    const inbox = inboxFor(rules, oneAccount(args));
    const policy = inbox.contract.policy;
    output({
      ok: inbox.contract.status === "valid",
      account: inbox.account,
      contract: inbox.contractPath,
      status: inbox.contract.status,
      ...(inbox.contract.code ? { code: inbox.contract.code, message: MESSAGES[inbox.contract.code] } : {}),
      legacyContract: rules.legacyContract || null,
      settings: policy
        ? {
            mode: policy.mode,
            effectiveMode: inbox.policy.mode,
            ageThresholdDays: policy.ageThresholdDays,
            aggressiveness: policy.aggressiveness,
            vipSenders: policy.vipSenders,
            excludedPasses: policy.excludedPasses,
            archiveFolder: policy.archiveFolder,
            sentFolder: policy.sentFolder,
            signIn: policy.credential
              ? policy.credential.kind === "realtimex-secret"
                ? { kind: "realtimex-secret", login: policy.credential.passwordRef.replace(/^secret:\/\//, "").replace(/#.*$/, "") }
                : { kind: "himalaya-native" }
              : null,
            reviewRequired: policy.reviewRequired,
          }
        : null,
      workspaceVipSenders: rules.config.vipSenders,
      promotablePasses: inbox.policy.promotablePasses,
    });
  },

  /**
   * Read-only connection check: lists folders and changes nothing. Works
   * before the inbox is selected, with the credential the contract names or
   * one given for this check.
   */
  check(args) {
    const setup = setupInbox(oneAccount(args));
    const credential = credentialFromArgs(args) ?? setup.contract?.policy?.credential ?? (setup.contract?.status === "review-required" ? { kind: "himalaya-native" } : null);
    const inbox = { account: setup.account, key: setup.key, policy: { credential } };
    let folders;
    try {
      folders = folderNames(setup.rules, inbox);
    } catch (error) {
      writeJson(checkFile(setup.key), { account: setup.account, ok: false, code: error.code, at: new Date().toISOString() });
      throw error;
    }
    writeJson(checkFile(setup.key), { account: setup.account, ok: true, signIn: credential.kind, at: new Date().toISOString() });
    output({ ok: true, account: setup.account, changed: false, folders });
  },

  /** Create this inbox's draft contract if it has none: report-only, never overwritten. */
  "contract-init"(args) {
    const setup = setupInbox(oneAccount(args));
    if (setup.text !== null) {
      output({ ok: true, account: setup.account, contract: setup.file.relative, created: false, status: setup.contract.status });
      return;
    }
    const credential = credentialFromArgs(args) ?? null;
    const policy = { ...core.draftPolicy(setup.account, setup.caps), credential };
    const content = core.renderContract(fs.readFileSync(CONTRACT_TEMPLATE, "utf8"), {
      account: setup.account,
      protectedDomains: setup.caps.protectedDomains,
      policy,
    });
    fs.mkdirSync(path.dirname(setup.file.target), { recursive: true });
    contractFile(setup.key); // re-check: no symlink appeared on the way
    try {
      fs.writeFileSync(setup.file.target, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      output({ ok: true, account: setup.account, contract: setup.file.relative, created: false });
      return;
    }
    output({ ok: true, account: setup.account, contract: setup.file.relative, created: true, status: "valid" });
  },

  /**
   * Change this inbox's settings block, leaving the prose exactly as the user
   * wrote it. Only `--confirm-review` clears a pending review, and only after
   * the user has said yes to the summary.
   */
  "contract-set"(args) {
    const setup = setupInbox(oneAccount(args));
    if (setup.text === null) throw failure("MAILKEEPER_CONTRACT_INVALID", { reason: "no contract yet; run contract-init" });
    const base = setup.contract.policy || core.draftPolicy(setup.account, setup.caps, { reviewRequired: true });
    const next = { ...base };
    if (typeof args.mode === "string") next.mode = args.mode;
    if (args.age !== undefined) next.ageThresholdDays = Number(args.age);
    if (typeof args.aggressiveness === "string") next.aggressiveness = args.aggressiveness;
    const vip = listArg(args.vip);
    if (vip) {
      const normalized = vip.map(core.normalizeSender);
      if (!normalized.every(Boolean)) {
        throw failure("MAILKEEPER_CONTRACT_INVALID", { reason: "each --vip entry must be an address or a domain", rejected: vip.filter((entry, i) => !normalized[i]) });
      }
      next.vipSenders = [...new Set(normalized)];
    }
    const excluded = listArg(args.exclude);
    if (excluded) next.excludedPasses = excluded;
    if (args["archive-folder"] !== undefined) next.archiveFolder = args["archive-folder"] === "none" ? null : String(args["archive-folder"]);
    if (args["sent-folder"] !== undefined) next.sentFolder = args["sent-folder"] === "none" ? null : String(args["sent-folder"]);
    const credential = credentialFromArgs(args);
    if (credential !== undefined) next.credential = credential;
    if (args["confirm-review"] === true) delete next.reviewRequired;
    else if (base.reviewRequired) next.reviewRequired = true;
    else delete next.reviewRequired;

    const content = core.replacePolicyBlock(setup.text, next);
    if (content === null) throw failure("MAILKEEPER_CONTRACT_INVALID", { reason: "the contract has more than one settings block; keep one" });
    const parsed = core.parseContract(content, setup.account);
    if (parsed.status === "invalid") throw failure("MAILKEEPER_CONTRACT_INVALID", { reason: "check the values given" });
    writeContract(setup.file, setup.text, content);
    output({ ok: true, account: setup.account, contract: setup.file.relative, status: parsed.status, changed: content !== setup.text });
  },

  /**
   * Where setup stands for each inbox, by the four completion criteria:
   * selected here, a maintenance agent chosen, a valid contract, and a
   * successful read-only check. Cadence is as of the last settings save; whether
   * the heartbeat is on is read now, so a pause made since then shows.
   */
  status() {
    const rules = readJson(statePath("rules.json"));
    const configured = rules?.schemaVersion === 2;
    const selected = configured ? rules.config.emailAccounts : [];
    const agentChosen = Boolean(configured && rules.config.agent);
    const inboxes = selected.map((name) => {
      const key = core.accountKey(name);
      const { relative, target } = contractFile(key);
      const contract = isFile(target) ? core.parseContract(fs.readFileSync(target, "utf8"), name) : { status: "missing", code: null };
      const check = readJson(checkFile(key));
      return {
        name,
        contract: relative,
        contractStatus: contract.status,
        code: contract.code,
        lastCheck: check ? { ok: check.ok === true, at: check.at, code: check.code || null } : null,
        setupComplete: agentChosen && contract.status === "valid" && check?.ok === true,
      };
    });
    output({
      ok: true,
      configured,
      agent: configured ? rules.config.agent || null : null,
      agentLabel: configured && rules.config.agent ? core.own(AGENT_LABELS, rules.config.agent) || rules.config.agent : null,
      model: configured ? rules.config.model || null : null,
      effort: configured ? rules.config.effort || null : null,
      schedule: configured ? scheduleNow(rules) : null,
      legacyContract: configured ? rules.legacyContract || null : null,
      inboxes,
    });
  },

  begin(args) {
    const rules = loadRules();
    const runId = runIdOf(args);
    if (readJson(runFile(runId))) throw failure("MAILKEEPER_OPERATION_FAILED", { reason: `run ${runId} already exists` });
    const trigger = args.trigger === "heartbeat" ? "heartbeat" : "chat";
    const requested = args.account.length ? [...new Set(args.account)] : [...rules.config.emailAccounts];
    for (const account of requested) {
      if (!rules.config.emailAccounts.includes(account)) throw failure("MAILKEEPER_ACCOUNT_NOT_FOUND", { account });
    }
    const owner = { terminalSessionId: terminalSessionId() };
    acquireGuard(runId, trigger, owner);
    const run = newRun(runId, rules, requested, trigger, owner);
    const inboxes = Object.create(null);
    const notices = readJson(statePath("notices.json")) || {};
    notices.migration = notices.migration || {};
    for (const account of requested) {
      try {
        const entry = enrollAccount(run, inboxFor(rules, account));
        core.setOwn(inboxes, account, { contract: entry.contract, status: entry.contractStatus, mode: entry.mode, code: entry.code });
        // The v0.1.1 migration explanation is owed once per inbox; the
        // review-needed code itself stays on every run until confirmed.
        if (entry.contractStatus === "review-required" && rules.legacyContract && !core.own(notices.migration, account)) {
          core.setOwn(notices.migration, account, new Date().toISOString());
          core.own(inboxes, account).migrationNotice = true;
        }
        if (entry.contractStatus === "invalid") recordFailure(run, account, entry.code);
      } catch (error) {
        core.setOwn(run.accounts, account, { steps: [], outcome: null, code: null });
        recordFailure(run, account, error.code);
        core.setOwn(inboxes, account, { code: error.code, message: MESSAGES[error.code] });
      }
    }
    saveRun(run);
    writeJson(statePath("notices.json"), notices);
    output({ ok: true, runId, trigger, inboxes, effort: run.effort, legacyContract: rules.legacyContract || null });
  },

  snapshot(args) {
    perInbox(args, ({ rules, run, account, inbox, entry }) => {
      const folder = typeof args.folder === "string" ? args.folder : "INBOX";
      const previous = readJson(snapshotFile(inbox));
      const usable = previous?.account === account && previous?.key === inbox.key ? previous : null;
      const query = args["since-last-run"] && usable?.takenAt ? `after ${usable.takenAt.slice(0, 10)}` : "";
      const fresh = listAll(rules, inbox, folder, query);
      let envelopes = fresh;
      if (query && usable?.envelopes) {
        const seen = new Set(fresh.map((e) => e.uid));
        envelopes = [...fresh, ...usable.envelopes.filter((e) => !seen.has(e.uid) && e.folder === folder)];
      }
      // Body signal enrichment: one server-side search instead of N fetches.
      let bodyUnsubscribe = new Set();
      try {
        bodyUnsubscribe = new Set(listAll(rules, inbox, folder, "body unsubscribe").map((e) => e.uid));
      } catch (error) {
        if (error.code !== "MAILKEEPER_OPERATION_FAILED") throw error;
      }
      for (const e of envelopes) e.bodyUnsubscribe = bodyUnsubscribe.has(e.uid);
      // Reply history needs this inbox's own Sent folder; without one the
      // passes that depend on it stay off.
      let sentTo = [];
      if (inbox.policy.sentFolder) sentTo = listAll(rules, inbox, inbox.policy.sentFolder, "").map((e) => e.fromAddress);
      const snapshot = {
        account,
        key: inbox.key,
        folder,
        takenAt: new Date().toISOString(),
        envelopes,
        repliedTo: [...new Set(sentTo)],
        sentDomains: [...new Set(sentTo.map((a) => a.split("@").pop()).filter(Boolean))],
        replyHistory: Boolean(inbox.policy.sentFolder),
      };
      writeJson(snapshotFile(inbox), snapshot);
      // A successful read clears an earlier blocked attempt in this run.
      if (entry.outcome === "blocked") {
        entry.outcome = null;
        entry.code = inbox.contract.code;
      }
      entry.steps.push("snapshot");
      return { account, envelopes: envelopes.length, replyHistory: snapshot.replyHistory, takenAt: snapshot.takenAt };
    });
  },

  triage(args) {
    perInbox(args, ({ run, account, inbox, entry }) => {
      const hits = urgentHits(loadSnapshot(inbox));
      run.urgent = [
        ...run.urgent.filter((e) => e.account !== account),
        ...hits.map((e) => ({ account, uid: e.uid, from: e.fromAddress, subject: e.subject.slice(0, 200), date: e.date })),
      ];
      entry.steps.push("triage");
      return { account, urgent: hits.length, items: hits.slice(0, 50).map((e) => `${e.fromAddress} — ${e.subject.slice(0, 90)}`) };
    });
  },

  preview(args) {
    perInbox(
      args,
      ({ rules, run, account, inbox, entry }) => {
        const passName = typeof args.pass === "string" ? args.pass : "";
        const snapshot = loadSnapshot(inbox);
        const ctx = buildContext(rules, inbox, snapshot);
        const urgent = urgentHits(snapshot);
        const list = candidates(passName, ctx, snapshot, urgent);
        // Matches held back as "always ask first" (urgent hits are reported separately).
        const urgentUids = new Set(urgent.map((e) => e.uid));
        const confirmFirst = snapshot.envelopes.filter(
          (e) => !urgentUids.has(e.uid) && ctx.isConfirmFirst(e) && PASSES[passName].match(e, ctx)
        ).length;
        const target = targetFolder(passName, ctx, inbox.policy.mode);
        core.setOwn(run.previews, account, {
          ...(core.own(run.previews, account) || {}),
          [passName]: { contractDigest: entry.contractDigest, rulesRevision: run.rulesRevision, count: list.length, at: new Date().toISOString() },
        });
        entry.steps.push(`preview:${passName}`);
        return {
          account,
          pass: passName,
          rule: PASSES[passName].describe(ctx),
          mode: inbox.policy.mode,
          wouldMove: inbox.policy.mode !== "report-only" && Boolean(target) && !inbox.policy.excludedPasses.includes(passName),
          target,
          excluded: inbox.policy.excludedPasses.includes(passName),
          confirmFirstLeftInPlace: confirmFirst,
          ...summarize(list),
        };
      },
      { requestedMode: args.mode }
    );
  },

  apply(args) {
    perInbox(
      args,
      ({ rules, run, account, inbox, entry }) => {
        if (run.uncertain.some((u) => u.account === account)) throw failure("MAILKEEPER_MUTATION_UNCERTAIN", { account });
        if (inbox.contract.status === "invalid") throw failure(inbox.contract.code || "MAILKEEPER_CONTRACT_INVALID", { account });
        if (inbox.contract.status === "review-required") {
          // Report-only until the user reviews the contract: nothing to apply.
          entry.steps.push("apply");
          return { account, mode: "report-only", dryRun: true, results: [], code: inbox.contract.code, message: MESSAGES[inbox.contract.code] };
        }
        const snapshot = loadSnapshot(inbox);
        const ctx = buildContext(rules, inbox, snapshot);
        const mode = inbox.policy.mode;
        const dryRun = args["dry-run"] === true || mode === "report-only";
        const urgent = urgentHits(snapshot);

        let plan;
        if (args["promoted-only"]) {
          // Only this inbox's approved rules, and only while each predicate is
          // still exactly what this inbox's contract describes.
          plan = (rules.promoted || [])
            .filter((rule) => rule.account === account)
            .map((rule) => {
              if (!PASSES[rule.pass]) return { pass: rule.pass, ruleId: rule.id, skip: "unsupported" };
              if (!inbox.policy.promotablePasses.includes(rule.pass)) return { pass: rule.pass, ruleId: rule.id, skip: "not-allowed-by-contract" };
              if (rule.query !== PASSES[rule.pass].describe(ctx)) return { pass: rule.pass, ruleId: rule.id, skip: "predicate-changed" };
              return { pass: rule.pass, ruleId: rule.id };
            });
        } else if (typeof args.pass === "string" && PASSES[args.pass]) {
          if (inbox.policy.excludedPasses.includes(args.pass)) {
            plan = [{ pass: args.pass, ruleId: null, skip: "excluded-by-contract" }];
          } else {
            const preview = core.own(core.own(run.previews, account), args.pass);
            if (!dryRun && (!preview || preview.contractDigest !== entry.contractDigest || preview.rulesRevision !== run.rulesRevision)) {
              throw failure("MAILKEEPER_CONTRACT_CHANGED", { account, procedural: true, reason: "preview this pass in this run before applying" });
            }
            plan = [{ pass: args.pass, ruleId: null }];
          }
        } else {
          throw failure("MAILKEEPER_OPERATION_FAILED", { procedural: true, reason: "--pass <name> or --promoted-only required" });
        }

        const results = [];
        for (const step of plan) {
          if (step.skip) {
            results.push({ account, pass: step.pass, ruleId: step.ruleId, skipped: step.skip });
            continue;
          }
          const list = candidates(step.pass, ctx, snapshot, urgent);
          const to = targetFolder(step.pass, ctx, mode);
          if (!to) {
            results.push({ account, pass: step.pass, ruleId: step.ruleId, skipped: "no-archive-folder", ...summarize(list) });
            continue;
          }
          let moved = 0;
          if (!dryRun && list.length) {
            revalidate(run, rules, account);
            ensureFolder(rules, inbox, to);
            moved = moveChunks(run, rules, inbox, list, snapshot.folder, to, { pass: step.pass, ruleId: step.ruleId });
            // Drop moved messages from this inbox's cache by account and
            // source folder, not by UID alone.
            const movedUids = new Set(run.actions.filter((a) => a.account === account && a.from === snapshot.folder).map((a) => a.uid));
            snapshot.envelopes = snapshot.envelopes.filter((e) => !(e.folder === snapshot.folder && movedUids.has(e.uid)));
            writeJson(snapshotFile(inbox), snapshot);
          }
          run.passes.push({ account, pass: step.pass, ruleId: step.ruleId, moved, previewed: list.length, to, dryRun });
          results.push({ account, pass: step.pass, ruleId: step.ruleId, to, dryRun, moved, ...summarize(list) });
        }
        entry.steps.push("apply");
        return { account, mode, dryRun, results };
      },
      { requestedMode: args.mode }
    );
  },

  propose(args) {
    perInbox(args, ({ rules, run, account, inbox, entry }) => {
      const snapshot = loadSnapshot(inbox);
      const ctx = buildContext(rules, inbox, snapshot);
      const urgent = urgentHits(snapshot);
      const approved = new Set(
        (rules.promoted || []).filter((rule) => rule.account === account).map((rule) => `${rule.pass}\n${rule.query}`)
      );
      const proposals = [];
      for (const passName of inbox.policy.promotablePasses) {
        const query = PASSES[passName].describe(ctx);
        if (approved.has(`${passName}\n${query}`)) continue;
        const list = candidates(passName, ctx, snapshot, urgent);
        if (list.length < 5) continue; // not worth a rule
        // Describe the move the rule would make once approved; a report-only
        // inbox suggests the label-only move.
        const target = targetFolder(passName, ctx, inbox.policy.mode === "report-only" ? "label-only" : inbox.policy.mode);
        if (!target) continue;
        const action = `move → ${target}`;
        proposals.push({ id: core.ruleId({ account, pass: passName, query, action }), account, pass: passName, query, action, ...summarize(list) });
      }
      run.proposals = [...run.proposals.filter((p) => p.account !== account), ...proposals];
      entry.steps.push("propose");
      return { account, proposals: proposals.length, passes: proposals.map((p) => `${p.pass}: ${p.count}`) };
    });
  },

  submit(args) {
    const runId = runIdOf(args);
    const run = readJson(runFile(runId));
    if (!run) throw failure("MAILKEEPER_OPERATION_FAILED", { reason: `unknown run ${runId}` });
    if (run.submittedAt) {
      output({ ok: true, runId, reused: true, queued: `.mailkeeper/outbox/${runId}.json` });
      return;
    }
    if (run.pending) {
      // A move was started but never confirmed: its outcome is unknown.
      run.uncertain.push(run.pending);
      run.pending = null;
    }
    const accounts = Object.create(null);
    for (const account of run.requested) {
      const entry = core.own(run.accounts, account) || { steps: [], outcome: null, code: null };
      let outcome = entry.outcome;
      let code = entry.code;
      if (run.uncertain.some((u) => u.account === account)) {
        outcome = "failed";
        code = "MAILKEEPER_MUTATION_UNCERTAIN";
      } else if (!outcome) {
        outcome = entry.steps.includes("snapshot") ? "completed" : "skipped";
      }
      core.setOwn(accounts, account, {
        outcome,
        code: outcome === "completed" ? entry.code || null : code || null,
        contract: entry.contract || null,
        contractDigest: entry.contractDigest || null,
        mode: entry.mode || null,
        moved: run.actions.filter((a) => a.account === account).length,
        // Report material: what moved where, what was suggested, what is urgent.
        movedByDestination: run.actions
          .filter((a) => a.account === account)
          .reduce((counts, a) => ({ ...counts, [a.to]: (counts[a.to] || 0) + 1 }), {}),
        suggestions: run.proposals.filter((p) => p.account === account).length,
        urgent: run.urgent.filter((u) => u.account === account).slice(0, 5).map((u) => ({ from: u.from, subject: u.subject })),
        urgentCount: run.urgent.filter((u) => u.account === account).length,
      });
    }
    const outcomes = Object.values(accounts).map((a) => a.outcome);
    const outcome = outcomes.includes("failed")
      ? "failed"
      : outcomes.length && outcomes.every((o) => o === "completed")
        ? "completed"
        : "blocked";
    const receipt = {
      schemaVersion: 2,
      runId,
      trigger: run.trigger,
      outcome,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      rulesRevision: run.rulesRevision,
      accounts,
      actions: run.actions,
      uncertain: run.uncertain,
      proposals: run.proposals,
      urgent: run.urgent,
      passes: run.passes,
      effort: run.effort,
      summary: String(args.summary || "").slice(0, 4000),
    };
    writeJson(statePath("outbox", `${runId}.json`), receipt);
    run.submittedAt = receipt.finishedAt;
    run.outcome = outcome;
    run.accountsOutcome = accounts;
    saveRun(run);
    const released = releaseGuard(runId, run);
    output({
      ok: true,
      runId,
      outcome,
      accounts,
      actions: receipt.actions.length,
      uncertain: receipt.uncertain.length,
      proposals: receipt.proposals.length,
      urgent: receipt.urgent.length,
      guardReleased: released,
      // The report owes one line when the requested effort was not applied.
      effortNotApplied: Boolean(run.effort?.warning),
      effortWarning: run.effort?.warning || null,
      queued: `.mailkeeper/outbox/${runId}.json`,
    });
  },

  /**
   * Reverse a run's confirmed moves. IMAP gives a message a new UID in its
   * destination folder, so a moved message is found again by its recorded
   * sender, subject and date; a message that matches none or several is
   * reported as unresolved instead of guessed.
   */
  undo(args) {
    const rules = loadRules();
    const runId = runIdOf(args);
    const dryRun = args["dry-run"] === true;
    const only = args.account.length ? oneAccount(args) : null;
    const run = readJson(runFile(runId));
    if (!run) throw failure("MAILKEEPER_OPERATION_FAILED", { reason: `unknown run ${runId}` });
    if (run.undoneAt) {
      output({ ok: true, runId, reused: true, undoneAt: run.undoneAt });
      return;
    }
    const actions = (run.actions || []).filter((a) => a.kind === "move" && (!only || a.account === only));
    const accounts = [...new Set(actions.map((a) => a.account))];
    // Preflight every inbox before touching any of them.
    const inboxes = new Map();
    for (const account of accounts) {
      const inbox = inboxFor(rules, account);
      if (!inbox.policy.credential) throw failure("MAILKEEPER_CREDENTIAL_UNAVAILABLE", { account });
      inboxes.set(account, inbox);
    }
    const undoRunId = `undo-${runId}`.slice(0, 80);
    const undoOwner = { terminalSessionId: terminalSessionId() };
    acquireGuard(undoRunId, "undo", undoOwner);
    const undoRun = readJson(runFile(undoRunId)) || newRun(undoRunId, rules, accounts, "undo", undoOwner);
    if (undoRun.uncertain?.length) throw failure("MAILKEEPER_MUTATION_UNCERTAIN");
    const report = { reversed: 0, unresolved: [] };
    try {
      for (const account of accounts) {
        const inbox = inboxes.get(account);
        enrollAccount(undoRun, inbox);
        const groups = new Map();
        for (const action of actions.filter((a) => a.account === account)) {
          const key = `${action.to}\n${action.from}`;
          if (!groups.has(key)) groups.set(key, { from: action.to, to: action.from, items: [] });
          groups.get(key).items.push(action);
        }
        for (const group of groups.values()) {
          const dates = group.items.map((a) => Date.parse(a.date)).filter(Number.isFinite);
          const since = dates.length ? new Date(Math.min(...dates) - 86_400_000).toISOString().slice(0, 10) : "";
          const present = listAll(rules, inbox, group.from, since ? `after ${since}` : "");
          const matches = [];
          for (const action of group.items) {
            const hits = present.filter(
              (e) => e.fromAddress === action.fromAddress && e.subject.slice(0, 200) === action.subject && e.date === action.date
            );
            if (hits.length === 1) matches.push(hits[0]);
            else report.unresolved.push({ account, uid: action.uid, from: group.from, to: group.to, reason: hits.length ? "ambiguous" : "not-found" });
          }
          if (!dryRun && matches.length) {
            report.reversed += moveChunks(undoRun, rules, inbox, matches, group.from, group.to, { undoOf: runId });
          } else if (dryRun) {
            report.reversed += matches.length;
          }
        }
      }
    } finally {
      saveRun(undoRun);
      releaseGuard(undoRunId, undoRun);
    }
    if (!dryRun) {
      run.undoneAt = new Date().toISOString();
      run.undo = { reversed: report.reversed, unresolved: report.unresolved.length };
      saveRun(run);
    }
    output({ ok: true, runId, dryRun, reversed: report.reversed, unresolved: report.unresolved });
  },

  release(args) {
    const runId = runIdOf(args);
    const run = readJson(runFile(runId));
    const lock = readLock();
    if (lock?.runId !== runId) {
      output({ ok: true, runId, released: false, heldBy: lock?.runId || null });
      return;
    }
    if (run && (run.pending || run.uncertain?.length)) {
      if (args.reconciled !== true) throw failure("MAILKEEPER_MUTATION_UNCERTAIN");
      // The user checked the inbox: keep the record, stop blocking.
      run.reconciled = [...(run.reconciled || []), ...(run.pending ? [run.pending] : []), ...run.uncertain];
      run.pending = null;
      run.uncertain = [];
      saveRun(run);
    }
    fs.rmSync(lockFile(), { force: true });
    output({ ok: true, runId, released: true });
  },
};

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || !commands[command]) {
    process.stderr.write(`usage: mailbox-ops.js <${Object.keys(commands).join("|")}> [options]\n`);
    process.exitCode = 2;
    return;
  }
  try {
    commands[command](args);
  } catch (error) {
    const code = error instanceof MailKeeperFailure ? error.code : "MAILKEEPER_OPERATION_FAILED";
    // Fixed code and message plus our own bounded details; never raw error text.
    // exitCode, not exit(): stdout to a pipe may still be flushing.
    process.exitCode = 1;
    output({ ok: false, code, message: MESSAGES[code], ...(error instanceof MailKeeperFailure ? error.detail : {}) });
  }
}

if (require.main === module) main();

module.exports = { PASSES, CONFIRM_FIRST_RE, findStanza, describeStanza, renderStanza, accountTableName, listStanzas };
