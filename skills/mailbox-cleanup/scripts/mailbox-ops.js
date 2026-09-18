#!/usr/bin/env node
"use strict";

/**
 * mailbox-ops.js — the only way the mailbox-cleanup skill touches a mailbox.
 *
 * Self-contained on purpose: this file is copied into the workspace by the
 * RealTimeX MailKeeper plugin's workspace-skill provider and runs in the agent's
 * terminal, so it cannot require the plugin runtime.
 *
 *   snapshot  --account <name> [--since-last-run] [--folder INBOX]
 *   triage    --account <name>
 *   preview   --account <name> --pass <pass>
 *   apply     --account <name> (--pass <pass> | --promoted-only) --run-id <id> [--mode <mode>] [--dry-run]
 *   propose   --account <name> --run-id <id>
 *   submit    --run-id <id> --outcome <completed|blocked|failed> [--summary "..."]
 *   undo      --account <name> --run-id <id> [--dry-run]
 *
 * State: <workspace>/.mailkeeper/{rules.json, snapshot.json, runs/, outbox/}
 * rules.json is written by the plugin on every provision and carries the
 * effective config plus the promoted rule set. Never edit it by hand.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.cwd();
const STATE = path.join(ROOT, ".mailkeeper");
// realtimex-plugin-validator: allow-process-env -- this CLI runs in the agent's
// terminal, not the plugin host; the Himalaya binary and TOML path are runtime
// discovery injected by the environment, never plugin configuration.
const HIMALAYA = process.env.MAILKEEPER_HIMALAYA_BIN || "himalaya";
const BATCH = 200;

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

const PASSES = {
  age: {
    action: "archive",
    match: (e, ctx) => e.ageDays > ctx.config.ageThresholdDays && !e.flags.includes("Flagged"),
    describe: (ctx) => `older than ${ctx.config.ageThresholdDays} days, unflagged`,
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
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function fail(message, code = 1) {
  console.error(`error: ${message}`);
  process.exit(code);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function himalaya(account, args, { json = true } = {}) {
  // `-a` / `-c` / `-o` are per-subcommand options in Himalaya, so they go last.
  const tail = ["-a", account, ...(json ? ["-o", "json"] : []), ...(process.env.HIMALAYA_CONFIG ? ["-c", process.env.HIMALAYA_CONFIG] : [])];
  const out = execFileSync(HIMALAYA, [...args, ...tail], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return json && out.trim() ? JSON.parse(out) : out;
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

function listAll(account, folder, query) {
  const out = [];
  const now = Date.now();
  for (let page = 1; page <= 2000; page += 1) {
    let rows;
    try {
      rows = himalaya(account, ["envelope", "list", "-f", folder, "-p", String(page), "-s", String(BATCH), ...(query ? [query] : [])]);
    } catch (error) {
      if (/out of bound/i.test(String(error.stderr || error.message))) break;
      throw error;
    }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) out.push(normalize(row, folder, now));
    process.stderr.write(`\r  page ${page} (${out.length} envelopes)`);
    if (rows.length < BATCH) break;
  }
  process.stderr.write("\n");
  return out;
}

function loadRules() {
  const rules = readJson(path.join(STATE, "rules.json"));
  if (!rules?.config) fail(".mailkeeper/rules.json missing — the MailKeeper plugin writes it on provision. Is the plugin enabled for this workspace?");
  return rules;
}

function loadSnapshot() {
  const snapshot = readJson(path.join(STATE, "snapshot.json"));
  if (!snapshot?.envelopes) fail("no snapshot — run `mailbox-ops.js snapshot` first");
  return snapshot;
}

function buildContext(rules, snapshot) {
  const config = rules.config;
  const identity = readJson(path.join(STATE, "identity.json"), null);
  const senderCounts = new Map();
  for (const e of snapshot.envelopes) senderCounts.set(e.fromAddress, (senderCounts.get(e.fromAddress) || 0) + 1);
  const repliedTo = new Set(snapshot.repliedTo || []);
  const knownDomains = new Set([...(snapshot.sentDomains || []), ...(identity?.knownDomains || [])]);
  const vip = (config.vipSenders || []).map((v) => v.toLowerCase());
  const protectedDomains = (config.protectedDomains || []).map((d) => d.toLowerCase());
  const isProtected = (e) =>
    vip.some((v) => e.fromAddress === v || e.fromDomain === v || e.fromDomain.endsWith(`.${v}`) || e.fromAddress.endsWith(v)) ||
    protectedDomains.some((d) => e.fromDomain === d.replace(/^\./, "") || e.fromDomain.endsWith(d)) ||
    e.flags.includes("Flagged");
  return { config, identity, senderCounts, repliedTo, knownDomains, isProtected };
}

function urgentHits(snapshot) {
  return snapshot.envelopes.filter((e) => URGENT_RE.test(e.subject) || URGENT_DOMAIN_RE.test(e.fromDomain));
}

function candidates(passName, ctx, snapshot, urgent) {
  const pass = PASSES[passName];
  if (!pass) fail(`unknown pass "${passName}"; one of ${Object.keys(PASSES).join(", ")}`);
  const urgentUids = new Set(urgent.map((e) => e.uid));
  return snapshot.envelopes.filter((e) => !urgentUids.has(e.uid) && !ctx.isProtected(e) && pass.match(e, ctx));
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

function targetFolder(passName, ctx, mode) {
  const pass = PASSES[passName];
  if (pass.action === "archive") {
    if (mode === "archive-promoted") return ctx.config.archiveFolder;
    return `${ctx.config.autoFolderPrefix}/Aged`; // label-only downgrade
  }
  return `${ctx.config.autoFolderPrefix}/${pass.action}`;
}

function ensureFolder(account, name) {
  const folders = himalaya(account, ["folder", "list"]);
  if (Array.isArray(folders) && folders.some((f) => f.name === name)) return;
  himalaya(account, ["folder", "add", name], { json: false });
}

function move(account, uids, from, to, dryRun) {
  const actions = [];
  for (let i = 0; i < uids.length; i += BATCH) {
    const chunk = uids.slice(i, i + BATCH);
    if (!dryRun) himalaya(account, ["message", "move", "-f", from, to, ...chunk], { json: false });
    for (const uid of chunk) actions.push({ kind: "move", uid, from, to, dryRun });
  }
  return actions;
}

function runFile(runId) {
  return path.join(STATE, "runs", `${runId}.json`);
}

function loadRun(runId, { create = false } = {}) {
  const existing = readJson(runFile(runId));
  if (existing) return existing;
  if (!create) fail(`unknown run ${runId}`);
  return { runId, startedAt: new Date().toISOString(), actions: [], proposals: [], urgent: [], passes: [] };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
  snapshot(args) {
    const account = args.account || fail("--account required");
    const folder = args.folder || "INBOX";
    const rules = loadRules();
    const previous = readJson(path.join(STATE, "snapshot.json"));
    let query = "";
    if (args["since-last-run"] && previous?.takenAt) {
      query = `after ${previous.takenAt.slice(0, 10)}`;
    }
    console.error(`snapshot ${account}/${folder}${query ? ` (${query})` : " (full)"}`);
    const fresh = listAll(account, folder, query);
    let envelopes = fresh;
    if (query && previous?.envelopes) {
      const seen = new Set(fresh.map((e) => e.uid));
      envelopes = [...fresh, ...previous.envelopes.filter((e) => !seen.has(e.uid))];
    }
    // Body signal enrichment: one server-side search instead of N fetches.
    let bodyUnsubscribe = new Set();
    try {
      bodyUnsubscribe = new Set(listAll(account, folder, "body unsubscribe").map((e) => e.uid));
    } catch (error) {
      console.error(`  (body search unavailable: ${String(error.message).split("\n")[0]})`);
    }
    for (const e of envelopes) e.bodyUnsubscribe = bodyUnsubscribe.has(e.uid);
    // Reply signal: senders we have written to.
    let sentTo = [];
    try {
      sentTo = listAll(account, rules.config.sentFolder || "Sent", "").map((e) => e.fromAddress);
    } catch {
      /* no Sent folder on this server */
    }
    const snapshot = {
      account,
      folder,
      takenAt: new Date().toISOString(),
      envelopes,
      repliedTo: [...new Set(sentTo)],
      sentDomains: [...new Set(sentTo.map((a) => a.split("@").pop()).filter(Boolean))],
    };
    writeJson(path.join(STATE, "snapshot.json"), snapshot);
    console.log(JSON.stringify({ ok: true, envelopes: envelopes.length, takenAt: snapshot.takenAt }));
  },

  triage(args) {
    const snapshot = loadSnapshot();
    const hits = urgentHits(snapshot);
    if (args["run-id"]) {
      const run = loadRun(args["run-id"], { create: true });
      run.urgent = hits.map((e) => ({ uid: e.uid, from: e.fromAddress, subject: e.subject, date: e.date }));
      writeJson(runFile(run.runId), run);
    }
    console.log(JSON.stringify({ ok: true, urgent: hits.length, items: hits.slice(0, 50).map((e) => `${e.fromAddress} — ${e.subject.slice(0, 90)}`) }, null, 2));
  },

  preview(args) {
    const passName = args.pass || fail("--pass required");
    const rules = loadRules();
    const snapshot = loadSnapshot();
    const ctx = buildContext(rules, snapshot);
    const list = candidates(passName, ctx, snapshot, urgentHits(snapshot));
    console.log(JSON.stringify({ ok: true, pass: passName, rule: PASSES[passName].describe(ctx), target: targetFolder(passName, ctx, rules.config.mode), ...summarize(list) }, null, 2));
  },

  apply(args) {
    const account = args.account || fail("--account required");
    const runId = args["run-id"] || fail("--run-id required");
    const rules = loadRules();
    const snapshot = loadSnapshot();
    const ctx = buildContext(rules, snapshot);
    const mode = args.mode || rules.config.mode;
    const dryRun = args["dry-run"] === true || mode === "report-only";
    const urgent = urgentHits(snapshot);
    const run = loadRun(runId, { create: true });
    run.mode = mode;

    let plan;
    if (args["promoted-only"]) {
      plan = (rules.promoted || []).map((rule) => ({ pass: rule.pass, ruleId: rule.id }));
    } else if (args.pass) {
      plan = [{ pass: args.pass, ruleId: null }];
    } else {
      fail("--pass <name> or --promoted-only required");
    }

    const results = [];
    for (const step of plan) {
      const list = candidates(step.pass, ctx, snapshot, urgent);
      const to = targetFolder(step.pass, ctx, mode);
      if (!dryRun && list.length) ensureFolder(account, to);
      const actions = move(account, list.map((e) => e.uid), snapshot.folder, to, dryRun).map((a) => ({ ...a, pass: step.pass, ruleId: step.ruleId }));
      run.actions.push(...actions);
      run.passes.push({ pass: step.pass, ruleId: step.ruleId, moved: dryRun ? 0 : list.length, previewed: list.length, to, dryRun });
      results.push({ pass: step.pass, to, dryRun, ...summarize(list) });
    }
    if (!dryRun) {
      const moved = new Set(run.actions.filter((a) => !a.dryRun).map((a) => a.uid));
      snapshot.envelopes = snapshot.envelopes.filter((e) => !moved.has(e.uid));
      writeJson(path.join(STATE, "snapshot.json"), snapshot);
    }
    writeJson(runFile(runId), run);
    console.log(JSON.stringify({ ok: true, runId, mode, dryRun, results }, null, 2));
  },

  propose(args) {
    const runId = args["run-id"] || fail("--run-id required");
    const rules = loadRules();
    const snapshot = loadSnapshot();
    const ctx = buildContext(rules, snapshot);
    const urgent = urgentHits(snapshot);
    const promotedPasses = new Set((rules.promoted || []).map((r) => r.pass));
    const run = loadRun(runId, { create: true });
    const proposals = [];
    for (const passName of rules.config.promotablePasses || []) {
      if (promotedPasses.has(passName)) continue;
      const list = candidates(passName, ctx, snapshot, urgent);
      if (list.length < 5) continue; // not worth a rule
      proposals.push({
        pass: passName,
        query: PASSES[passName].describe(ctx),
        action: `move → ${targetFolder(passName, ctx, rules.config.mode)}`,
        ...summarize(list),
      });
    }
    run.proposals = proposals;
    writeJson(runFile(runId), run);
    console.log(JSON.stringify({ ok: true, runId, proposals: proposals.length, passes: proposals.map((p) => `${p.pass}: ${p.count}`) }, null, 2));
  },

  submit(args) {
    const runId = args["run-id"] || fail("--run-id required");
    const outcome = args.outcome || "completed";
    if (!["completed", "blocked", "failed"].includes(outcome)) fail("--outcome must be completed|blocked|failed");
    const run = loadRun(runId);
    const receipt = {
      schemaVersion: 1,
      runId,
      outcome,
      mode: run.mode || null,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      actions: run.actions.filter((a) => !a.dryRun),
      proposals: run.proposals || [],
      urgent: run.urgent || [],
      passes: run.passes || [],
      summary: String(args.summary || "").slice(0, 4000),
    };
    writeJson(path.join(STATE, "outbox", `${runId}.json`), receipt);
    writeJson(runFile(runId), { ...run, submittedAt: receipt.finishedAt, outcome });
    console.log(JSON.stringify({ ok: true, runId, actions: receipt.actions.length, proposals: receipt.proposals.length, urgent: receipt.urgent.length, queued: `.mailkeeper/outbox/${runId}.json` }));
  },

  undo(args) {
    const account = args.account || fail("--account required");
    const runId = args["run-id"] || fail("--run-id required");
    const dryRun = args["dry-run"] === true;
    const run = loadRun(runId);
    if (run.undoneAt) fail(`run ${runId} already undone at ${run.undoneAt}`);
    const groups = new Map();
    for (const a of run.actions) {
      if (a.kind !== "move" || a.dryRun) continue;
      const key = `${a.to}→${a.from}`;
      if (!groups.has(key)) groups.set(key, { from: a.to, to: a.from, uids: [] });
      groups.get(key).uids.push(a.uid);
    }
    let reversed = 0;
    const skipped = [];
    for (const g of groups.values()) {
      try {
        reversed += move(account, g.uids, g.from, g.to, dryRun).length;
      } catch (error) {
        skipped.push({ from: g.from, to: g.to, count: g.uids.length, error: String(error.message).split("\n")[0] });
      }
    }
    if (!dryRun) writeJson(runFile(runId), { ...run, undoneAt: new Date().toISOString() });
    console.log(JSON.stringify({ ok: true, runId, dryRun, reversed, skipped }, null, 2));
  },
};

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command || !commands[command]) {
  console.error(`usage: mailbox-ops.js <${Object.keys(commands).join("|")}> [options]`);
  process.exit(2);
}
try {
  commands[command](args);
} catch (error) {
  fail(String(error.stderr || error.message).split("\n").slice(0, 3).join(" "));
}
