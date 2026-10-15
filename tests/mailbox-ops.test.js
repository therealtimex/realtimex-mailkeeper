"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFile } = require("child_process");
const { promisify } = require("util");

const core = require("../skills/mailbox-cleanup/scripts/mailkeeper-core");
const { startImapStub } = require("./fixtures/imap-stub");

const execFileAsync = promisify(execFile);
const OPS = path.join(__dirname, "..", "skills", "mailbox-cleanup", "scripts", "mailbox-ops.js");
const FAKE_HIMALAYA = path.join(__dirname, "fixtures", "fake-himalaya.js");
const FAKE_RTXEXEC = path.join(__dirname, "fixtures", "fake-rtxexec.js");
const HAS_HIMALAYA = spawnSync("himalaya", ["--version"], { stdio: "ignore" }).status === 0;

// Synthetic per-inbox credentials: unique per run, never real secrets.
const SECRET_A = `mk-a-${crypto.randomBytes(10).toString("hex")}`;
const SECRET_B = `mk-b-${crypto.randomBytes(10).toString("hex")}`;
const NOREPLY_QUERY = "no-reply style sender or unsubscribe link in body";

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

function msg(id, addr, subject, { age = 5, flags = [], unsubscribe = false } = {}) {
  return { id: String(id), from: { addr, name: "" }, subject, date: daysAgo(age), flags, unsubscribe };
}

function standardInbox() {
  return [
    msg(1, "noreply@news.example", "Weekly digest"),
    msg(2, "noreply@shop.example", "Your deals this week"),
    msg(3, "noreply@billing.example", "Final notice: payment overdue"),
    msg(4, "no-reply@accounts.example", "Password reset requested"),
    msg(5, "noreply@flagged.example", "Saved for later", { flags: ["Flagged"] }),
    msg(6, "boss@company.example", "Quarterly plan"),
  ];
}

/**
 * A workspace as the plugin would provision it: rules.json plus one
 * contract per inbox, and a fake mailbox per inbox behind fake Himalaya.
 */
function makeWorkspace({ inboxes, promoted = [], workspace = {}, revision = 1 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-ops-"));
  const configFile = path.join(dir, "himalaya.toml");
  fs.writeFileSync(configFile, "# fake\n");
  const mailboxFile = path.join(dir, "fake-mailbox.json");
  const caps = {
    emailAccounts: Object.keys(inboxes),
    mode: "label-only",
    modeCeiling: "label-only",
    ageThresholdDays: 90,
    aggressiveness: "standard",
    promotablePasses: core.PASSES_BY_AGGRESSIVENESS.standard,
    autoFolderPrefix: "Auto",
    protectedDomains: [".gov"],
    vipSenders: [],
    agent: "codex",
    model: null,
    effort: { requested: null, forwarded: null, warning: null },
    ...workspace,
  };
  const accounts = Object.create(null);
  const fake = { accounts: Object.create(null) };
  for (const [name, spec] of Object.entries(inboxes)) {
    const key = core.accountKey(name);
    const relative = core.contractRelativePath(key);
    core.setOwn(accounts, name, { key, contract: relative });
    fs.mkdirSync(path.join(dir, path.dirname(relative)), { recursive: true });
    const body =
      spec.contractText ??
      `# ${name}\n\n## MailKeeper settings\n\n${core.renderPolicyBlock({ ...core.draftPolicy(name, caps), ...spec.policy })}\n`;
    fs.writeFileSync(path.join(dir, relative), body);
    core.setOwn(fake.accounts, name, {
      credential: spec.fakeCredential || { kind: "secret", password: spec.password },
      folders: { INBOX: spec.messages || standardInbox(), ...(spec.folders || {}) },
      ...(spec.fake || {}),
    });
  }
  fs.writeFileSync(mailboxFile, JSON.stringify(fake));
  const rules = {
    schemaVersion: 2,
    revision,
    writtenAt: new Date().toISOString(),
    himalayaConfig: { paths: [configFile], target: configFile, source: "HIMALAYA_CONFIG" },
    config: caps,
    accounts,
    legacyContract: null,
    promoted,
  };
  fs.mkdirSync(path.join(dir, ".mailkeeper"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".mailkeeper", "rules.json"), JSON.stringify(rules, null, 2));

  const transcript = [];
  const ws = {
    dir,
    rules,
    secrets: { "a-imap": SECRET_A, "b-imap": SECRET_B },
    env: {},
    run(...args) {
      const env = {
        ...process.env,
        MAILKEEPER_HIMALAYA_BIN: FAKE_HIMALAYA,
        MAILKEEPER_RTXEXEC_BIN: FAKE_RTXEXEC,
        FAKE_MAILBOX: mailboxFile,
        FAKE_SECRETS: JSON.stringify(ws.secrets),
        FAKE_RTX_SESSION: "1",
        // Never let a test resolve the developer's real Himalaya config.
        HIMALAYA_CONFIG: configFile,
        ...ws.env,
      };
      delete env.MAILKEEPER_IMAP_PASSWORD;
      const result = spawnSync(process.execPath, [OPS, ...args], { cwd: dir, env, encoding: "utf8" });
      transcript.push(result.stdout, result.stderr);
      let json = null;
      try {
        json = JSON.parse(result.stdout);
      } catch {
        /* usage errors print no JSON */
      }
      return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
    },
    mailbox: () => JSON.parse(fs.readFileSync(mailboxFile, "utf8")),
    setFake(name, patch) {
      const state = JSON.parse(fs.readFileSync(mailboxFile, "utf8"));
      Object.assign(state.accounts[name], patch);
      fs.writeFileSync(mailboxFile, JSON.stringify(state));
    },
    writeRules(patch) {
      Object.assign(rules, patch);
      fs.writeFileSync(path.join(dir, ".mailkeeper", "rules.json"), JSON.stringify(rules, null, 2));
    },
    contract: (name) => path.join(dir, core.contractRelativePath(core.accountKey(name))),
    run_: (runId) => JSON.parse(fs.readFileSync(path.join(dir, ".mailkeeper", "runs", `${runId}.json`), "utf8")),
    receipt: (runId) => JSON.parse(fs.readFileSync(path.join(dir, ".mailkeeper", "outbox", `${runId}.json`), "utf8")),
    transcript,
  };
  return ws;
}

const secretA = { kind: "realtimex-secret", passwordRef: "secret://a-imap#password" };
const secretB = { kind: "realtimex-secret", passwordRef: "secret://b-imap#password" };
const ruleB = {
  id: core.ruleId({ account: "b", pass: "no-reply", query: NOREPLY_QUERY, action: "move → Auto/Notifications" }),
  account: "b",
  pass: "no-reply",
  query: NOREPLY_QUERY,
  action: "move → Auto/Notifications",
};

function twoInboxes(extra = {}) {
  return makeWorkspace({
    inboxes: {
      a: { password: SECRET_A, policy: { mode: "label-only", vipSenders: ["news.example"], credential: secretA }, ...(extra.a || {}) },
      b: { password: SECRET_B, policy: { mode: "label-only", ageThresholdDays: 30, credential: secretB }, folders: { "Auto/Notifications": [] }, ...(extra.b || {}) },
    },
    promoted: extra.promoted || [ruleB, { ...ruleB, id: "unscoped", account: undefined }],
    ...(extra.workspace ? { workspace: extra.workspace } : {}),
  });
}

function maintenance(ws, runId, accounts = ["a", "b"]) {
  assert.equal(ws.run("begin", "--run-id", runId, "--trigger", "heartbeat").json.ok, true);
  const steps = {};
  for (const account of accounts) {
    steps[account] = [
      ws.run("snapshot", "--account", account, "--run-id", runId, "--since-last-run"),
      ws.run("triage", "--account", account, "--run-id", runId),
      ws.run("apply", "--account", account, "--promoted-only", "--run-id", runId),
      ws.run("propose", "--account", account, "--run-id", runId),
    ];
  }
  return { steps, submit: ws.run("submit", "--run-id", runId, "--summary", "test") };
}

function assertNoSecrets(ws) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name !== "fake-mailbox.json") files.push(full); // the fake server's own credential store
    }
  };
  walk(ws.dir);
  // Verbatim, encoded, or a recognisable fragment.
  const forms = [SECRET_A, SECRET_B].flatMap((value) => [
    value,
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("hex"),
    value.slice(-12),
  ]);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(forms.some((form) => text.includes(form)), false, `credential found in ${path.relative(ws.dir, file)}`);
  }
  const transcript = ws.transcript.join("\n");
  assert.equal(forms.some((form) => transcript.includes(form)), false, "credential in CLI output");
}

test("each inbox follows its own contract and only its own approved rules", () => {
  const ws = twoInboxes();
  const { steps, submit } = maintenance(ws, "r1");
  for (const account of ["a", "b"]) {
    for (const step of steps[account]) assert.equal(step.json.ok, true, `${account}: ${step.stdout}`);
  }
  const box = ws.mailbox();
  // a shares UIDs, senders and the pass with b, but has no approved rule.
  assert.equal(box.accounts.a.folders.INBOX.length, 6);
  assert.equal(box.calls.some((call) => call.account === "a" && call.op === "message move"), false);
  // b moves only plain no-reply mail: urgent, confirm-first and flagged stay.
  assert.deepEqual(box.accounts.b.folders["Auto/Notifications"].map((m) => m.subject).sort(), ["Weekly digest", "Your deals this week"]);
  assert.deepEqual(box.accounts.b.folders.INBOX.map((m) => m.subject).sort(), [
    "Final notice: payment overdue",
    "Password reset requested",
    "Quarterly plan",
    "Saved for later",
  ]);

  assert.equal(submit.json.outcome, "completed");
  assert.equal(submit.json.guardReleased, true);
  assert.deepEqual(submit.json.accounts.b.movedByDestination, { "Auto/Notifications": 2 });
  assert.equal(submit.json.accounts.b.urgentCount, 1);
  assert.deepEqual(submit.json.accounts.b.urgent, [{ from: "noreply@billing.example", subject: "Final notice: payment overdue" }]);
  assert.equal(submit.json.effortNotApplied, false);
  const receipt = ws.receipt("r1");
  assert.equal(receipt.accounts.a.outcome, "completed");
  assert.equal(receipt.accounts.a.moved, 0);
  assert.equal(receipt.accounts.b.moved, 2);
  assert.match(receipt.accounts.b.contractDigest, /^[0-9a-f]{64}$/);
  assert.ok(receipt.actions.every((a) => a.account === "b" && a.from === "INBOX" && a.to === "Auto/Notifications" && a.ruleId === ruleB.id));
  assert.ok(receipt.urgent.some((u) => u.account === "a") && receipt.urgent.some((u) => u.account === "b"));
  assert.ok(receipt.proposals.every((p) => p.id === core.ruleId(p)));
  assertNoSecrets(ws);
});

test("a contract's VIPs protect only that inbox", () => {
  const ws = twoInboxes({ promoted: [ruleB, { ...ruleB, account: "a", id: core.ruleId({ ...ruleB, account: "a" }) }] });
  maintenance(ws, "r1");
  const box = ws.mailbox();
  const aMoved = box.accounts.a.folders["Auto/Notifications"].map((m) => m.from.addr);
  assert.deepEqual(aMoved, ["noreply@shop.example"], "a's VIP news.example stays");
  assert.ok(box.accounts.b.folders["Auto/Notifications"].some((m) => m.from.addr === "noreply@news.example"));
});

test("--mode can only narrow: a report-only contract never moves", () => {
  const ws = twoInboxes({ a: { password: SECRET_A, policy: { mode: "report-only", credential: secretA } } });
  ws.run("begin", "--run-id", "r1");
  ws.run("snapshot", "--account", "a", "--run-id", "r1");
  ws.run("preview", "--account", "a", "--run-id", "r1", "--pass", "no-reply", "--mode", "archive-promoted");
  const applied = ws.run("apply", "--account", "a", "--run-id", "r1", "--pass", "no-reply", "--mode", "archive-promoted");
  assert.equal(applied.json.ok, true);
  assert.equal(applied.json.mode, "report-only");
  assert.equal(applied.json.dryRun, true);
  assert.equal(ws.mailbox().accounts.a.folders.INBOX.length, 6);
});

test("rules whose predicate or pass the contract no longer allows are skipped, not widened", () => {
  const ageRule = { id: "age90", account: "b", pass: "age", query: "older than 90 days, unflagged", action: "move → Auto/Aged" };
  const receiptRule = { id: "rcpt", account: "b", pass: "receipt", query: "receipts, order confirmations, shipping notices", action: "move → Auto/Receipts" };
  const ws = twoInboxes({
    promoted: [ageRule, receiptRule],
    b: { password: SECRET_B, policy: { mode: "label-only", aggressiveness: "standard", ageThresholdDays: 30, excludedPasses: ["receipt"], credential: secretB } },
  });
  // b's contract: age 30 days (the rule says 90) and the receipt pass excluded.
  ws.run("begin", "--run-id", "r1");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const applied = ws.run("apply", "--account", "b", "--promoted-only", "--run-id", "r1");
  assert.deepEqual(applied.json.results.map((r) => r.skipped), ["predicate-changed", "not-allowed-by-contract"]);
});

test("a snapshot belonging to another inbox is refused", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1");
  ws.run("snapshot", "--account", "a", "--run-id", "r1");
  const aFile = path.join(ws.dir, ".mailkeeper", "accounts", core.accountKey("a"), "snapshot.json");
  const bFile = path.join(ws.dir, ".mailkeeper", "accounts", core.accountKey("b"), "snapshot.json");
  fs.mkdirSync(path.dirname(bFile), { recursive: true });
  fs.copyFileSync(aFile, bFile);
  const triage = ws.run("triage", "--account", "b", "--run-id", "r1");
  assert.equal(triage.json.code, "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH");
});

test("one blocked inbox does not stop the other, and the run is not reported complete", () => {
  const ws = twoInboxes();
  delete ws.secrets["b-imap"];
  const { steps, submit } = maintenance(ws, "r1");
  assert.equal(steps.a[0].json.ok, true);
  assert.equal(steps.b[0].json.code, "MAILKEEPER_CREDENTIAL_UNAVAILABLE");
  assert.equal(submit.json.outcome, "blocked");
  const receipt = ws.receipt("r1");
  assert.equal(receipt.accounts.a.outcome, "completed");
  assert.deepEqual([receipt.accounts.b.outcome, receipt.accounts.b.code], ["blocked", "MAILKEEPER_CREDENTIAL_UNAVAILABLE"]);
  assertNoSecrets(ws);
});

test("session, wrapper and config problems map to fixed codes", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1");
  ws.env.FAKE_RTX_SESSION = "";
  assert.equal(ws.run("snapshot", "--account", "a", "--run-id", "r1").json.code, "MAILKEEPER_SESSION_UNAVAILABLE");
  ws.env = { MAILKEEPER_RTXEXEC_BIN: path.join(ws.dir, "no-such-rtxexec") };
  assert.equal(ws.run("snapshot", "--account", "a", "--run-id", "r1").json.code, "MAILKEEPER_RTXEXEC_UNAVAILABLE");
  ws.env = {};
  ws.writeRules({ himalayaConfig: { paths: [path.join(ws.dir, "gone.toml")], target: path.join(ws.dir, "gone.toml"), source: "default" } });
  assert.equal(ws.run("snapshot", "--account", "a", "--run-id", "r1").json.code, "MAILKEEPER_HIMALAYA_CONFIG_MISSING");
  fs.rmSync(path.join(ws.dir, ".mailkeeper", "rules.json"));
  assert.equal(ws.run("begin", "--run-id", "r9").json.code, "MAILKEEPER_NOT_CONFIGURED");
  // A crashing tool is not blamed on the user's settings (seen in the live C0 run).
  ws.env = { MAILKEEPER_HIMALAYA_BIN: "/usr/bin/false" };
  assert.equal(ws.run("check", "--account", "a", "--native").json.code, "MAILKEEPER_OPERATION_FAILED");
  assert.equal(ws.run("accounts").json.code, "MAILKEEPER_OPERATION_FAILED");
});

test("an unknown move result is recorded, never replayed, and holds the run guard", () => {
  const ws = twoInboxes();
  ws.setFake("b", { failMove: "unknown" });
  const { steps, submit } = maintenance(ws, "r1");
  const applied = steps.b[2];
  assert.equal(applied.json.code, "MAILKEEPER_MUTATION_UNCERTAIN");
  assert.equal(applied.stdout.includes("connection reset"), false, "raw tool text never leaves");
  assert.equal(submit.json.outcome, "failed");
  assert.equal(submit.json.guardReleased, false);
  assert.equal(ws.receipt("r1").uncertain.length, 1);

  assert.equal(ws.run("begin", "--run-id", "r2").json.code, "MAILKEEPER_RUN_BUSY");
  assert.equal(ws.run("release", "--run-id", "r1").json.code, "MAILKEEPER_MUTATION_UNCERTAIN");
  assert.equal(ws.run("release", "--run-id", "r1", "--reconciled").json.released, true);
  assert.equal(ws.run("begin", "--run-id", "r2").json.ok, true);
});

test("confirmed chunks are kept when a later chunk fails", () => {
  const many = Array.from({ length: 250 }, (_, i) => msg(100 + i, `noreply${i}@bulk.example`, `Promo ${i}`));
  const ws = twoInboxes({ b: { password: SECRET_B, policy: { mode: "label-only", credential: secretB }, messages: many, folders: { "Auto/Notifications": [] }, fake: { failMove: "unknown", failMoveAfter: 1 } } });
  ws.run("begin", "--run-id", "r1");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const applied = ws.run("apply", "--account", "b", "--promoted-only", "--run-id", "r1");
  assert.equal(applied.json.code, "MAILKEEPER_MUTATION_UNCERTAIN");
  assert.equal(applied.json.movedBeforeProblem, 200);
  const run = ws.run_("r1");
  assert.equal(run.actions.length, 200);
  assert.equal(run.uncertain[0].uids.length, 50);
  assert.equal(ws.mailbox().accounts.b.folders["Auto/Notifications"].length, 200);
});

test("a server that refuses the move is a certain failure, not an uncertain one", () => {
  const ws = twoInboxes();
  ws.setFake("b", { failMove: "auth" });
  const { steps, submit } = maintenance(ws, "r1");
  assert.equal(steps.b[2].json.code, "MAILKEEPER_IMAP_CHECK_FAILED");
  assert.equal(submit.json.guardReleased, true);
  assert.equal(ws.receipt("r1").uncertain.length, 0);
});

test("one run at a time across chat, heartbeat and undo", () => {
  const ws = twoInboxes();
  assert.equal(ws.run("begin", "--run-id", "chat-1").json.ok, true);
  assert.equal(ws.run("begin", "--run-id", "hb-1", "--trigger", "heartbeat").json.code, "MAILKEEPER_RUN_BUSY");
  assert.equal(ws.run("snapshot", "--account", "a", "--run-id", "hb-1").json.code, "MAILKEEPER_RUN_BUSY");
  assert.equal(ws.run("undo", "--run-id", "chat-1").json.code, "MAILKEEPER_RUN_BUSY");
});

test("a contract or rule change during a run stops that inbox's moves", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  fs.appendFileSync(ws.contract("b"), "\nNever touch anything from shop.example.\n");
  const applied = ws.run("apply", "--account", "b", "--promoted-only", "--run-id", "r1");
  assert.equal(applied.json.code, "MAILKEEPER_CONTRACT_CHANGED");
  assert.equal(ws.mailbox().accounts.b.folders["Auto/Notifications"].length, 0);

  const ws2 = twoInboxes();
  ws2.run("begin", "--run-id", "r1");
  ws2.run("snapshot", "--account", "b", "--run-id", "r1");
  ws2.writeRules({ revision: 2 });
  assert.equal(ws2.run("apply", "--account", "b", "--promoted-only", "--run-id", "r1").json.code, "MAILKEEPER_CONTRACT_CHANGED");
});

test("an interactive apply needs a preview in the same run", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const early = ws.run("apply", "--account", "b", "--pass", "no-reply", "--run-id", "r1");
  assert.equal(early.json.code, "MAILKEEPER_CONTRACT_CHANGED");
  assert.equal(ws.run_("r1").accounts.b.outcome, null, "a procedural miss does not block the inbox");
  const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1");
  assert.equal(preview.json.count, 2);
  assert.equal(preview.json.confirmFirstLeftInPlace, 1);
  const applied = ws.run("apply", "--account", "b", "--pass", "no-reply", "--run-id", "r1");
  assert.equal(applied.json.results[0].moved, 2);
});

test("a migrated contract without settings is report-only and still readable", () => {
  const ws = makeWorkspace({
    inboxes: {
      legacy: { contractText: "# Mailbox contract — legacy\n\nNever touch: boss@company.example\n", fakeCredential: { kind: "native" }, folders: { "Auto/Notifications": [] } },
    },
    promoted: [{ ...ruleB, account: "legacy", id: "legacy-rule" }],
  });
  const { steps, submit } = maintenance(ws, "r1", ["legacy"]);
  assert.equal(steps.legacy[0].json.ok, true, "snapshot uses the existing native sign-in");
  assert.equal(steps.legacy[2].json.code, "MAILKEEPER_CONTRACT_REVIEW_REQUIRED");
  assert.equal(steps.legacy[2].json.dryRun, true);
  assert.equal(ws.mailbox().accounts.legacy.folders.INBOX.length, 6);
  assert.equal(submit.json.accounts.legacy.code, "MAILKEEPER_CONTRACT_REVIEW_REQUIRED");
});

test("an invalid contract blocks only its own inbox", () => {
  const ws = twoInboxes({ a: { password: SECRET_A, contractText: "# a\n\n```mailkeeper-policy\n{ broken\n```\n" } });
  const { steps, submit } = maintenance(ws, "r1");
  assert.equal(steps.a[2].json.code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(steps.b[2].json.ok, true);
  assert.equal(submit.json.accounts.a.outcome, "blocked");
  assert.equal(submit.json.accounts.b.outcome, "completed");
});

test("undo finds moved messages by sender, subject and date, and reports what it cannot match", () => {
  const twins = [msg(1, "noreply@twin.example", "Same", { age: 3 }), msg(2, "noreply@twin.example", "Same", { age: 3 }), msg(3, "noreply@solo.example", "Solo")];
  twins[1].date = twins[0].date;
  const ws = twoInboxes({ b: { password: SECRET_B, policy: { mode: "label-only", credential: secretB }, messages: twins, folders: { "Auto/Notifications": [] } } });
  maintenance(ws, "r1");
  assert.equal(ws.mailbox().accounts.b.folders["Auto/Notifications"].length, 3);

  const dry = ws.run("undo", "--run-id", "r1", "--dry-run");
  assert.equal(dry.json.reversed, 1);
  assert.deepEqual(dry.json.unresolved.map((u) => u.reason), ["ambiguous", "ambiguous"]);
  assert.equal(ws.mailbox().accounts.b.folders["Auto/Notifications"].length, 3, "dry run moves nothing");

  const undone = ws.run("undo", "--run-id", "r1").json;
  assert.deepEqual([undone.reversed, undone.remaining, undone.undone], [1, 2, false]);
  assert.deepEqual(ws.mailbox().accounts.b.folders.INBOX.map((m) => m.subject), ["Solo"]);
  // The look-alikes stay recoverable, and a second attempt doesn't move Solo again.
  const again = ws.run("undo", "--run-id", "r1").json;
  assert.deepEqual([again.reused, again.reversed, again.alreadyReversed, again.remaining], [undefined, 0, 1, 2]);
  assert.deepEqual(ws.mailbox().accounts.b.folders.INBOX.map((m) => m.subject), ["Solo"]);
  assertNoSecrets(ws);
});

test("mixed-inbox undo checks every inbox before changing any", () => {
  const ws = twoInboxes({ promoted: [ruleB, { ...ruleB, account: "a", id: core.ruleId({ ...ruleB, account: "a" }) }] });
  maintenance(ws, "r1");
  // b's contract loses its credential: undo must refuse before touching a.
  const text = fs.readFileSync(ws.contract("b"), "utf8").replace(/"credential": \{[^}]*\}/, '"credential": null');
  fs.writeFileSync(ws.contract("b"), text);
  const callsBefore = ws.mailbox().calls.length;
  const undone = ws.run("undo", "--run-id", "r1");
  assert.equal(undone.json.code, "MAILKEEPER_CREDENTIAL_UNAVAILABLE");
  assert.equal(ws.mailbox().calls.length, callsBefore, "no inbox was contacted");
});

test("setup helpers describe inboxes and contracts without credential values", () => {
  const ws = twoInboxes();
  const check = ws.run("check", "--account", "b");
  assert.deepEqual([check.json.ok, check.json.changed], [true, false]);
  assert.ok(check.json.folders.includes("INBOX"));
  const contract = ws.run("contract-check", "--account", "b");
  assert.equal(contract.json.status, "valid");
  assert.deepEqual(contract.json.settings.signIn, { kind: "realtimex-secret", login: "b-imap" });
  assert.equal(contract.stdout.includes("secret://"), false);
  assert.equal(ws.run("check", "--account", "not-selected").json.code, "MAILKEEPER_ACCOUNT_NOT_FOUND");
  assertNoSecrets(ws);
});

test("setup works before the inbox is selected and never overwrites a contract", () => {
  const ws = twoInboxes();
  // A third inbox exists in the email settings but is not selected yet.
  const box = ws.mailbox();
  box.accounts.c = { credential: { kind: "secret", password: SECRET_A }, folders: { INBOX: [], Archive: [], Sent: [] } };
  fs.writeFileSync(path.join(ws.dir, "fake-mailbox.json"), JSON.stringify(box));

  assert.equal(ws.run("check", "--account", "c").json.code, "MAILKEEPER_CREDENTIAL_UNAVAILABLE");
  assert.equal(ws.run("check", "--account", "c", "--login", "a-imap").json.code, "MAILKEEPER_CREDENTIAL_UNAVAILABLE", "names are never turned into references");
  const checked = ws.run("check", "--account", "c", "--password-ref", "secret://a-imap");
  assert.deepEqual(checked.json.folders, ["INBOX", "Archive", "Sent"]);
  assert.equal(checked.json.changed, false);

  const created = ws.run("contract-init", "--account", "c", "--password-ref", "secret://a-imap");
  assert.equal(created.json.created, true);
  const file = ws.contract("c");
  const draft = fs.readFileSync(file, "utf8");
  assert.match(draft, /^# c — MailKeeper contract/);
  assert.equal(core.parseContract(draft, "c").policy.mode, "report-only");
  assert.equal(ws.run("contract-init", "--account", "c").json.created, false);
  assert.equal(fs.readFileSync(file, "utf8"), draft);
  assert.equal(ws.run("check", "--account", "not-in-settings").json.code, "MAILKEEPER_ACCOUNT_NOT_FOUND");
  assert.equal(ws.run("check", "--account", "nobody@example.com").json.code, "MAILKEEPER_ACCOUNT_NOT_FOUND", "an address is valid only when discovered");
  assert.equal(core.parseContract(draft, "c").policy.credential.passwordRef, "secret://a-imap#password");
  assertNoSecrets(ws);
});

test("contract-set changes only the settings block and never implies review consent", () => {
  const legacyText = "# Mailbox contract — legacy\n\nMy own words about this inbox.\n";
  const ws = makeWorkspace({ inboxes: { legacy: { contractText: legacyText, fakeCredential: { kind: "native" } } } });
  const set = (...args) => ws.run("contract-set", "--account", "legacy", ...args);

  const prefilled = set("--native", "--vip", "*.bank.com,boss@company.example", "--archive-folder", "Archive");
  assert.equal(prefilled.json.status, "review-required", "a pre-filled block is not confirmation");
  let text = fs.readFileSync(ws.contract("legacy"), "utf8");
  assert.ok(text.startsWith(legacyText.trimEnd()), "the user's prose is untouched");
  assert.deepEqual(core.parseContract(text, "legacy").policy.vipSenders, ["bank.com", "boss@company.example"]);

  assert.equal(set("--vip", "*bank*").json.code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(set("--mode", "delete-all").json.code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(set("--mode", "label-only").json.status, "review-required");

  assert.equal(set("--confirm-review").json.status, "valid");
  text = fs.readFileSync(ws.contract("legacy"), "utf8");
  assert.ok(text.startsWith(legacyText.trimEnd()));
  assert.equal((text.match(/```mailkeeper-policy/g) || []).length, 1);
  assert.equal(set("--age", "45").json.status, "valid");
});

test("clearing a review marker cannot exceed the workspace caps or approve a rule", () => {
  const ws = makeWorkspace({
    inboxes: {
      legacy: {
        password: SECRET_A,
        policy: { mode: "archive-promoted", aggressiveness: "aggressive", archiveFolder: "Archive", reviewRequired: true, credential: secretA },
        folders: { Archive: [], "Auto/Notifications": [] },
      },
    },
    workspace: { mode: "label-only", modeCeiling: "label-only", aggressiveness: "conservative", promotablePasses: core.PASSES_BY_AGGRESSIVENESS.conservative },
  });
  const rulesBefore = fs.readFileSync(path.join(ws.dir, ".mailkeeper", "rules.json"), "utf8");
  assert.equal(ws.run("contract-set", "--account", "legacy", "--confirm-review").json.status, "valid");
  const checked = ws.run("contract-check", "--account", "legacy").json;
  assert.equal(checked.settings.mode, "archive-promoted", "the contract still says what it asks for");
  assert.equal(checked.effectiveMode, undefined);
  assert.equal(checked.settings.effectiveMode, "label-only", "the workspace cap still applies");
  assert.deepEqual(checked.promotablePasses, ["no-reply", "calendar-response", "sketchy-tld"]);
  assert.equal(fs.readFileSync(path.join(ws.dir, ".mailkeeper", "rules.json"), "utf8"), rulesBefore, "no rule was approved");
  const { steps } = maintenance(ws, "r1", ["legacy"]);
  assert.deepEqual(steps.legacy[2].json.results, [], "with no approved rule, nothing runs");
  assert.equal(ws.mailbox().accounts.legacy.folders.INBOX.length, 6);
});

test("begin records its terminal session; another run's guard is reported as unconfirmed, not running", () => {
  const ws = twoInboxes();
  const lock = () => JSON.parse(fs.readFileSync(path.join(ws.dir, ".mailkeeper", "run.lock"), "utf8"));
  ws.env = { RTX_AGENT_CONTEXT_JSON: JSON.stringify({ schemaVersion: 1, terminalSessionId: "t-1" }), REALTIMEX_TERMINAL_SESSION_ID: "t-1" };
  assert.equal(ws.run("begin", "--run-id", "r1", "--trigger", "heartbeat").json.ok, true);
  assert.deepEqual(lock().owner, { terminalSessionId: "t-1" });
  assert.deepEqual(ws.run_("r1").owner, { terminalSessionId: "t-1" });

  ws.env = { RTX_AGENT_CONTEXT_JSON: JSON.stringify({ schemaVersion: 1, terminalSessionId: "t-2" }), REALTIMEX_TERMINAL_SESSION_ID: "t-2" };
  const busy = ws.run("begin", "--run-id", "r2").json;
  assert.equal(busy.code, "MAILKEEPER_RUN_BUSY");
  assert.deepEqual(
    [busy.heldBy, busy.heldByTrigger, busy.ownerRecorded, busy.ownerState, typeof busy.heldSince, busy.heldRunMoved],
    ["r1", "heartbeat", true, "unknown", "string", 0]
  );
  assert.doesNotMatch(busy.message || "", /in progress|already running/i, "never claims the other run is running");

  fs.rmSync(path.join(ws.dir, ".mailkeeper", "run.lock"));
  ws.env = { RTX_AGENT_CONTEXT_JSON: JSON.stringify({ schemaVersion: 1, terminalSessionId: "t-3" }), REALTIMEX_TERMINAL_SESSION_ID: "t-other" };
  ws.run("begin", "--run-id", "r3");
  assert.deepEqual(lock().owner, { terminalSessionId: null }, "disagreeing sources record no owner");
});

test("status reads the admission projection as last observed, never as a confirmed hold", () => {
  const ws = twoInboxes();
  ws.writeRules({ provisionAttempt: "a1", schedule: { cadence: "manual", manual: true } });
  const file = path.join(ws.dir, ".mailkeeper", "admission.json");
  const admission = () => ws.run("status").json.schedule.admission;
  const now = new Date().toISOString();
  const held = (extra = {}) => JSON.stringify({ schemaVersion: 1, state: "held", runId: "r1", trigger: "manual", admittedAt: now, observedAt: now, ...extra });
  const unknown = { lastObserved: "unknown", current: "unconfirmed" };

  assert.deepEqual(admission(), unknown, "no projection");
  fs.writeFileSync(file, "{");
  assert.deepEqual(admission(), unknown, "corrupt");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, state: "clear", observedAt: now }));
  assert.deepEqual(admission(), unknown, "unsupported version");
  fs.writeFileSync(file, held({ admittedAt: "not a time" }));
  assert.deepEqual(admission(), unknown, "a malformed admission time is unknown, never clear");
  fs.writeFileSync(file, held({ observedAt: undefined }));
  assert.deepEqual(admission(), unknown, "no observation time");
  const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, held({ admittedAt: old }));
  assert.equal(admission().lastObserved, "unknown", "a hold past its window may have been replaced by an unwritten admission");

  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, state: "clear", observedAt: now }));
  assert.deepEqual(admission(), { lastObserved: "none", current: "unconfirmed", observedAt: now }, "a clear copy is never a promise");

  fs.writeFileSync(file, held());
  assert.deepEqual(
    [admission().lastObserved, admission().current, admission().runId, admission().trigger, admission().since, admission().begin],
    ["held", "unconfirmed", "r1", "manual", now, "not_observed"]
  );
  fs.mkdirSync(path.join(ws.dir, ".mailkeeper", "runs"), { recursive: true });
  fs.writeFileSync(path.join(ws.dir, ".mailkeeper", "runs", "r1.json"), JSON.stringify({ runId: "someone-else" }));
  assert.equal(admission().begin, "unknown", "a journal naming another run is not begin evidence");
  fs.writeFileSync(path.join(ws.dir, ".mailkeeper", "runs", "r1.json"), JSON.stringify({ runId: "r1" }));
  assert.equal(admission().begin, "observed");
});

test("status reports the four setup criteria per inbox and the schedule", () => {
  const ws = twoInboxes();
  ws.writeRules({ schedule: { cadence: "1d", paused: true, threadSlug: "mailkeeper-maintenance-7" } });
  fs.writeFileSync(path.join(ws.dir, "HEARTBEAT.md"), "heartbeat:\n  enabled: false\ntasks: []\n");
  let status = ws.run("status").json;
  assert.deepEqual(status.inboxes.map((i) => i.setupComplete), [false, false], "no connection check yet");
  ws.run("check", "--account", "a");
  status = ws.run("status").json;
  assert.deepEqual(status.inboxes.map((i) => [i.name, i.setupComplete]), [["a", true], ["b", false]]);
  assert.equal(status.schedule.paused, true);
  assert.equal(status.agent, "codex");
  assert.equal(status.agentLabel, "Codex CLI");
});

test("status reads whether the heartbeat is on now, not as of the last settings save", () => {
  const ws = twoInboxes();
  ws.writeRules({ provisionAttempt: "a1", schedule: { taskId: "mailkeeper-maintenance-7", cadence: "manual", cadenceLabel: "Manual", manual: true, heartbeatEnabled: true, paused: false } });
  fs.writeFileSync(path.join(ws.dir, ".mailkeeper", "provisioning.json"), JSON.stringify({ schemaVersion: 1, attempt: "a1", state: "ready" }));
  const heartbeat = path.join(ws.dir, "HEARTBEAT.md");
  const schedule = () => ws.run("status").json.schedule;
  const state = () => [schedule().heartbeatEnabled, schedule().paused];

  assert.deepEqual(state(), [true, false], "no HEARTBEAT.md: the heartbeat is on, the host's default");
  assert.deepEqual([schedule().applied, schedule().manual, schedule().scheduled], [true, true, false]);

  // Pause and resume in heartbeat settings, with no MailKeeper settings save.
  fs.writeFileSync(heartbeat, "heartbeat:\n  enabled: false\n  timezone: UTC\ntasks:\n  - id: mailkeeper-maintenance-7\n    name: MailKeeper maintenance\n    prompt: |-\n      a: b\n");
  assert.deepEqual(state(), [false, true], "paused after the save");
  assert.deepEqual([schedule().manual, schedule().cadence], [true, "manual"], "Manual is kept beside the pause");
  fs.writeFileSync(heartbeat, "heartbeat:\n  enabled: true\n  timezone: UTC\ntasks: []\n");
  assert.deepEqual(state(), [true, false], "resumed");

  fs.rmSync(heartbeat);
  fs.mkdirSync(heartbeat);
  assert.deepEqual(state(), [null, null], "a path that isn't a file is unknown, not absent");
  fs.rmdirSync(heartbeat);
  if (process.getuid?.() !== 0) {
    fs.writeFileSync(heartbeat, "heartbeat:\n  enabled: true\n");
    fs.chmodSync(heartbeat, 0o000);
    assert.deepEqual(state(), [null, null], "a file this terminal can't read is unknown, never the saved state");
    fs.chmodSync(heartbeat, 0o600);
  }
});

test("a schedule is claimed only from the ready provisioning that wrote rules.json, with its task in place", () => {
  const ws = twoInboxes();
  const taskId = "mailkeeper-maintenance-7";
  ws.writeRules({ provisionAttempt: "a1", schedule: { taskId, cadence: "1d", cadenceLabel: "Daily", manual: false, heartbeatEnabled: true, paused: false } });
  const provisioning = (state, attempt = "a2") =>
    fs.writeFileSync(path.join(ws.dir, ".mailkeeper", "provisioning.json"), JSON.stringify({ schemaVersion: 1, attempt, state }));
  const heartbeat = (enabled, tasks) =>
    fs.writeFileSync(path.join(ws.dir, "HEARTBEAT.md"), `heartbeat:\n  enabled: ${enabled}\n  timezone: UTC\ntasks:\n${tasks}`);
  const managed = (interval) =>
    `  - id: ${taskId}\n    name: MailKeeper maintenance\n    interval: ${interval}\n    agent: codex\n    runtime-options:\n      effort: high\n` +
    "    prompt: |-\n      Inbox 1 of 1 — a: b\n        - not: a task\n    owner:\n      pluginId: p\n      workspaceId: 7\n";
  const pick = () => {
    const { applied, outcome, cadence, manual, scheduled, task } = ws.run("status").json.schedule;
    return { applied, outcome, cadence, manual, scheduled, task };
  };

  heartbeat(true, managed("1d"));
  assert.deepEqual(pick(), { applied: null, outcome: null, cadence: null, manual: null, scheduled: null, task: null }, "no provisioning record: nothing is claimed");

  provisioning("ready", "a1");
  assert.deepEqual(pick(), { applied: true, outcome: "ready", cadence: "1d", manual: false, scheduled: true, task: { found: true, interval: "1d" } });

  heartbeat(false, managed("disabled"));
  assert.equal(pick().scheduled, false, "provisioned while paused: the host keeps the task off");
  heartbeat(true, managed("disabled"));
  assert.deepEqual([pick().scheduled, pick().task], [false, { found: true, interval: "disabled" }], "resuming alone doesn't schedule it");
  heartbeat(true, "  - id: someone-else\n    name: Other\n    interval: 1d\n    prompt: do it\n");
  assert.deepEqual([pick().scheduled, pick().task], [false, { found: false, interval: null }], "task missing");
  heartbeat(true, managed("1d") + managed("1d"));
  assert.deepEqual([pick().scheduled, pick().task], [null, null], "a duplicated task id can't be read");
  fs.writeFileSync(path.join(ws.dir, "HEARTBEAT.md"), `---\ntitle: x\n---\nheartbeat:\n  enabled: true\ntasks:\n${managed("1d")}`);
  assert.equal(pick().scheduled, null, "front matter is outside what this reader follows");

  heartbeat(true, managed("1d"));
  provisioning("ready", "a2");
  assert.deepEqual([pick().applied, pick().cadence, pick().scheduled], [null, null, null], "ready, but for another rules.json");
  provisioning("ready", "");
  assert.equal(pick().applied, null, "a ready outcome without an attempt vouches for nothing");
  provisioning("config_invalid");
  assert.deepEqual([pick().applied, pick().outcome, pick().cadence, pick().manual], [false, "config_invalid", null, null]);
  provisioning("pending");
  assert.deepEqual([pick().applied, pick().outcome], [false, "pending"]);
});

test("the setup closing is chosen in order; a current ready schedule reaches Manual or the scheduled closing", () => {
  const ws = twoInboxes();
  const taskId = "mailkeeper-maintenance-7";
  const file = path.join(ws.dir, "HEARTBEAT.md");
  const rules = (schedule) => ws.writeRules({ provisionAttempt: "a1", schedule: { taskId, ...schedule } });
  const provisioning = (state, attempt = "a1") =>
    fs.writeFileSync(path.join(ws.dir, ".mailkeeper", "provisioning.json"), JSON.stringify({ schemaVersion: 1, attempt, state }));
  const heartbeat = (enabled, interval) =>
    fs.writeFileSync(file, `heartbeat:\n  enabled: ${enabled}\ntasks:\n  - id: ${taskId}\n    name: MailKeeper maintenance\n    interval: ${interval}\n    executor: agent\n    prompt: |-\n      check\n`);
  const closing = () => ws.run("status").json.schedule.closing;

  rules({ cadence: "manual", cadenceLabel: "Manual", manual: true });
  provisioning("ready");
  heartbeat(true, "disabled");
  assert.equal(closing(), "manual", "outcome ready, applied, Manual");
  heartbeat(false, "disabled");
  assert.equal(closing(), "manual", "Manual wins over a paused heartbeat");
  fs.writeFileSync(file, "heartbeat:\n  enabled: [\n");
  assert.equal(closing(), "manual", "Manual wins over an unknown pause");

  rules({ cadence: "1d", cadenceLabel: "Daily", manual: false });
  heartbeat(true, "1d");
  assert.equal(closing(), "scheduled", "an active Daily schedule");
  heartbeat(false, "1d");
  assert.equal(closing(), "paused");
  fs.writeFileSync(file, "heartbeat:\n  enabled: [\n");
  assert.equal(closing(), "pause_unknown");
  heartbeat(true, "disabled");
  assert.equal(closing(), "task_inactive", "on, but the task isn't on the schedule");
  fs.writeFileSync(file, "---\nx: 1\n---\nheartbeat:\n  enabled: true\n");
  assert.equal(closing(), "unreadable", "task can't be read");

  heartbeat(true, "1d");
  for (const outcome of ["config_invalid", "pending", "disabled"]) {
    provisioning(outcome);
    assert.equal(closing(), outcome);
  }
  provisioning("something-new");
  assert.equal(closing(), "unreadable", "an outcome this build doesn't know");
  provisioning("ready", "a2");
  assert.equal(closing(), "unreadable", "ready, but for another rules.json");
  fs.rmSync(path.join(ws.dir, ".mailkeeper", "provisioning.json"));
  assert.equal(closing(), "unreadable", "no provisioning record");
});

test("the heartbeat readers agree with the host parser or say unknown", () => {
  // Each case records the host's answer at the pinned parser revision. Set
  // MAILKEEPER_HOST_TASKBLOCK to a host taskBlock.js to re-check them live.
  const hostFile = process.env.MAILKEEPER_HOST_TASKBLOCK;
  const host = hostFile ? require(hostFile) : null;

  const settings = require("./fixtures/heartbeat-settings-parity.json");
  const ws = twoInboxes();
  ws.writeRules({ provisionAttempt: "a1", schedule: { taskId: "mailkeeper-maintenance-7", cadence: "1d", manual: false } });
  fs.writeFileSync(path.join(ws.dir, ".mailkeeper", "provisioning.json"), JSON.stringify({ schemaVersion: 1, attempt: "a1", state: "ready" }));
  for (const { name, text, host: recorded, expected } of settings.cases) {
    if (host) assert.equal(host.parseHeartbeatSettingsBlock(text)?.enabled !== false, recorded, `host changed: ${name}`);
    fs.writeFileSync(path.join(ws.dir, "HEARTBEAT.md"), text);
    const enabled = ws.run("status").json.schedule.heartbeatEnabled;
    assert.equal(enabled, expected, name);
    assert.ok(enabled === recorded || enabled === null, `never the opposite of the host: ${name}`);
  }

  const tasks = require("./fixtures/heartbeat-task-parity.json");
  for (const { name, text, host: recorded, expected } of tasks.cases) {
    if (host) {
      const mine = (host.parseTaskBlock(text) || []).filter((task) => String(task.id || "") === tasks.taskId);
      const live = mine.length === 1 ? { found: true, interval: mine[0].interval ?? null, cron: mine[0].cron ?? null } : mine.length ? { duplicate: true } : { found: false };
      assert.deepEqual(live, recorded, `host changed: ${name}`);
    }
    fs.writeFileSync(path.join(ws.dir, "HEARTBEAT.md"), text);
    const task = ws.run("status").json.schedule.task;
    assert.deepEqual(task, expected, name);
    if (task) {
      assert.equal(task.found, recorded.found === true, `never the opposite of the host: ${name}`);
      if (task.found) assert.deepEqual([task.interval, recorded.cron], [recorded.interval, null], `same interval, no cron: ${name}`);
    }
  }
});

test("the migration notice is owed once; the review status stays until confirmed", () => {
  const ws = makeWorkspace({ inboxes: { legacy: { contractText: "# old\n", fakeCredential: { kind: "native" } } } });
  ws.writeRules({ legacyContract: "MAILBOX.md" });
  const first = ws.run("begin", "--run-id", "r1").json;
  assert.equal(first.inboxes.legacy.migrationNotice, true);
  assert.equal(first.inboxes.legacy.code, "MAILKEEPER_CONTRACT_REVIEW_REQUIRED");
  ws.run("submit", "--run-id", "r1");
  const second = ws.run("begin", "--run-id", "r2").json;
  assert.equal(second.inboxes.legacy.migrationNotice, undefined);
  assert.equal(second.inboxes.legacy.code, "MAILKEEPER_CONTRACT_REVIEW_REQUIRED");
});

// ---------------------------------------------------------------------------
// Containment: a capped, unfiltered read (the full one is tracked in #6)
// ---------------------------------------------------------------------------

function bulkInbox(n, firstId = 1001) {
  return Array.from({ length: n }, (_, i) => msg(firstId + i, `person${i}@bulk.example`, `Note ${i}`));
}

function listCalls(ws, account, folder = "INBOX") {
  return ws.mailbox().calls.filter((call) => call.op === "envelope list" && call.account === account && call.folder === folder);
}

const REPEAT_QUERY = "20+ messages from one sender, none replied to";
const repeatRuleB = {
  id: core.ruleId({ account: "b", pass: "repeat-sender", query: REPEAT_QUERY, action: "move → Auto/Repeat" }),
  account: "b",
  pass: "repeat-sender",
  query: REPEAT_QUERY,
  action: "move → Auto/Repeat",
};

test("the read stops at five pages: only a short or empty last page is a complete read", () => {
  for (const [size, complete, pages] of [
    [200, true, 2],
    [999, true, 5],
    [1000, false, 5],
  ]) {
    const ws = twoInboxes({ b: { messages: bulkInbox(size) } });
    ws.run("begin", "--run-id", "r1");
    const snap = ws.run("snapshot", "--account", "b", "--run-id", "r1", "--since-last-run").json;
    assert.equal(snap.ok, true, `${size}`);
    assert.deepEqual(snap.coverage, {
      complete,
      verified: false,
      stopReason: complete ? null : "budget",
      code: null,
      folder: "INBOX",
      inboxRead: size,
      replyHistory: "unavailable",
      unsubscribeSignal: "not-checked",
    });
    const calls = listCalls(ws, "b");
    assert.equal(calls.length, pages, `${size}: pages read`);
    assert.ok(calls.every((call) => call.query === ""), "never a filtered or dated query");
    assert.equal(ws.mailbox().calls.some((call) => call.folder === "Sent"), false, "Sent is not read");
  }
});

test("a folder-scoped read records its folder, so a complete folder is never read as the whole inbox", () => {
  const folderMessages = [...standardInbox().slice(0, 2), msg(900, "colleague@people.example", "Stays")];
  const ws = twoInboxes({ b: { messages: bulkInbox(1000), folders: { "Auto/Notifications": [], "MailKeeper Test": folderMessages } } });
  ws.run("begin", "--run-id", "r1", "--account", "b");
  const inbox = ws.run("snapshot", "--account", "b", "--run-id", "r1").json;
  assert.deepEqual([inbox.coverage.folder, inbox.coverage.complete, inbox.coverage.stopReason], ["INBOX", false, "budget"]);
  const folder = ws.run("snapshot", "--account", "b", "--run-id", "r1", "--folder", "MailKeeper Test").json;
  assert.deepEqual([folder.coverage.folder, folder.coverage.complete, folder.coverage.inboxRead], ["MailKeeper Test", true, 3]);
  const applied = ws.run("apply", "--account", "b", "--promoted-only", "--run-id", "r1").json;
  assert.deepEqual([applied.dryRun, applied.results[0].moved], [false, 2], "the folder's complete read allows its moves");
  const submit = ws.run("submit", "--run-id", "r1", "--summary", "t").json;
  assert.deepEqual([submit.accounts.b.outcome, submit.accounts.b.coverage.folder], ["completed", "MailKeeper Test"]);
});

test("a repeated page, an answer that isn't a list, or a later failure stops the read and keeps what was read", () => {
  for (const [patch, stopReason, read] of [
    [{ listRepeatPage: 2 }, "no_progress", 200],
    [{ listInvalidPage: 2 }, "invalid_response", 200],
    [{ listFailPage: 3 }, "transport", 400],
  ]) {
    const ws = twoInboxes({ b: { messages: bulkInbox(450) } });
    ws.setFake("b", patch);
    ws.run("begin", "--run-id", "r1");
    const snap = ws.run("snapshot", "--account", "b", "--run-id", "r1").json;
    assert.equal(snap.ok, true, stopReason);
    assert.deepEqual([snap.coverage.complete, snap.coverage.stopReason, snap.coverage.inboxRead], [false, stopReason, read]);
    assert.equal(snap.coverage.code, stopReason === "transport" ? "MAILKEEPER_OPERATION_FAILED" : null);
    const submit = ws.run("submit", "--run-id", "r1", "--summary", "t").json;
    assert.deepEqual([submit.accounts.b.outcome, submit.accounts.b.code], ["partial", null]);
    assert.equal(submit.outcome, "blocked", "a partial read is never a completed run");
  }
  // Nothing read at all is a failure, not a partial read.
  for (const patch of [{ listFailPage: 1 }, { listInvalidPage: 1 }]) {
    const ws = twoInboxes();
    ws.setFake("b", patch);
    ws.run("begin", "--run-id", "r1");
    assert.equal(ws.run("snapshot", "--account", "b", "--run-id", "r1").json.code, "MAILKEEPER_OPERATION_FAILED");
    assert.equal(ws.run("submit", "--run-id", "r1", "--summary", "t").json.accounts.b.outcome, "failed");
  }
});

test("an inbox read in part only reports, while a fully read inbox in the same run still moves", () => {
  const ruleA = { ...ruleB, account: "a", id: core.ruleId({ ...ruleB, account: "a" }) };
  const ws = twoInboxes({
    promoted: [ruleA, ruleB],
    a: { folders: { "Auto/Notifications": [] } },
    b: { messages: [...standardInbox(), ...bulkInbox(1000)] },
  });
  const { steps, submit } = maintenance(ws, "r1");
  const applyA = steps.a[2].json;
  const applyB = steps.b[2].json;
  assert.deepEqual([applyA.dryRun, applyA.reportOnly, applyA.results[0].moved], [false, undefined, 1]);
  assert.deepEqual([applyB.dryRun, applyB.reportOnly], [true, "partial-coverage"]);
  assert.deepEqual([applyB.results[0].count, applyB.results[0].moved], [2, 0], "found, but not moved");
  const box = ws.mailbox();
  assert.equal(box.calls.some((call) => call.account === "b" && call.op === "message move"), false);
  assert.equal(box.accounts.b.folders["Auto/Notifications"].length, 0);

  // A chat plan for b says it is report-only, and an interactive apply moves nothing.
  ws.run("begin", "--run-id", "r2", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r2");
  const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r2").json;
  assert.deepEqual([preview.wouldMove, preview.reportOnly, preview.coverage.inboxRead], [false, "partial-coverage", 1000]);
  assert.deepEqual(preview.uncheckedSignals, ["unsubscribe-link"]);
  const applied = ws.run("apply", "--account", "b", "--pass", "no-reply", "--run-id", "r2").json;
  assert.deepEqual([applied.dryRun, applied.results[0].moved], [true, 0]);

  assert.equal(submit.json.outcome, "blocked");
  const receipt = ws.receipt("r1");
  assert.deepEqual([receipt.accounts.a.outcome, receipt.accounts.a.moved], ["completed", 1]);
  assert.deepEqual([receipt.accounts.b.outcome, receipt.accounts.b.moved], ["partial", 0]);
  assert.deepEqual([receipt.accounts.b.coverage.stopReason, receipt.accounts.b.coverage.inboxRead], ["budget", 1000]);
  assert.ok(receipt.actions.every((action) => action.account === "a"));
});

test("only this run's own complete read supports a move: an earlier run's snapshot is report-only", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1", "--account", "b");
  assert.equal(ws.run("snapshot", "--account", "b", "--run-id", "r1").json.coverage.complete, true);
  ws.run("submit", "--run-id", "r1", "--summary", "t");
  // r2 skips its own snapshot; the file on disk is r1's complete read.
  ws.run("begin", "--run-id", "r2", "--account", "b");
  const promoted = ws.run("apply", "--account", "b", "--promoted-only", "--run-id", "r2").json;
  assert.deepEqual([promoted.dryRun, promoted.reportOnly, promoted.results[0].moved], [true, "partial-coverage", 0]);
  const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r2").json;
  assert.deepEqual([preview.wouldMove, preview.reportOnly], [false, "partial-coverage"]);
  const direct = ws.run("apply", "--account", "b", "--pass", "no-reply", "--run-id", "r2").json;
  assert.deepEqual([direct.dryRun, direct.results[0].moved], [true, 0]);
  assert.equal(ws.mailbox().calls.some((call) => call.op === "message move"), false);
  assert.equal(ws.run("submit", "--run-id", "r2", "--summary", "t").json.accounts.b.outcome, "skipped");
});

test("passes that need reply history are off, and say so instead of finding nothing", () => {
  const friend = Array.from({ length: 25 }, (_, i) => msg(100 + i, "friend@people.example", `Hello ${i}`));
  const ws = twoInboxes({
    workspace: { promotablePasses: core.PASSES_BY_AGGRESSIVENESS.aggressive },
    b: {
      policy: { mode: "label-only", aggressiveness: "aggressive", sentFolder: "Sent", credential: secretB },
      messages: [...standardInbox(), ...friend],
      folders: { "Auto/Notifications": [], Sent: [] },
    },
  });
  ws.run("begin", "--run-id", "r1", "--account", "b");
  assert.equal(ws.run("snapshot", "--account", "b", "--run-id", "r1").json.replyHistory, false);
  const preview = ws.run("preview", "--account", "b", "--pass", "repeat-sender", "--run-id", "r1").json;
  assert.deepEqual([preview.skipped, preview.wouldMove, preview.count], ["reply-history-unavailable", false, 0]);
  const applied = ws.run("apply", "--account", "b", "--pass", "repeat-sender", "--run-id", "r1").json;
  assert.deepEqual(applied.results.map((r) => r.skipped), ["reply-history-unavailable"]);
  const proposed = ws.run("propose", "--account", "b", "--run-id", "r1").json;
  assert.deepEqual(proposed.unavailable.map((u) => `${u.pass}:${u.skipped}`).sort(), [
    "personalized-outreach:reply-history-unavailable",
    "repeat-sender:reply-history-unavailable",
  ]);
  assert.equal(ws.mailbox().calls.some((call) => call.op === "message move"), false);
});

test("an approved rule this version skips or reduces is owed one notice per inbox, marked surfaced at submit", () => {
  const ruleA = { ...ruleB, account: "a", id: core.ruleId({ ...ruleB, account: "a" }) };
  const ws = twoInboxes({ promoted: [ruleA, ruleB, repeatRuleB], a: { folders: { "Auto/Notifications": [] } } });
  const first = ws.run("begin", "--run-id", "r1").json;
  assert.deepEqual(first.inboxes.a.ruleNotices, [{ ruleId: ruleA.id, pass: "no-reply", rule: NOREPLY_QUERY, kind: "reduced" }]);
  assert.deepEqual(first.inboxes.b.ruleNotices, [
    { ruleId: ruleB.id, pass: "no-reply", rule: NOREPLY_QUERY, kind: "reduced" },
    { ruleId: repeatRuleB.id, pass: "repeat-sender", rule: REPEAT_QUERY, kind: "skipped" },
  ]);
  const notices = () => JSON.parse(fs.readFileSync(path.join(ws.dir, ".mailkeeper", "notices.json"), "utf8"));
  assert.equal(notices().rules, undefined, "owed, not yet surfaced");

  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const applied = ws.run("apply", "--account", "b", "--promoted-only", "--run-id", "r1").json;
  assert.deepEqual(applied.results.map((r) => [r.ruleId, r.skipped || null, r.moved ?? null]), [
    [ruleB.id, null, 2],
    [repeatRuleB.id, "reply-history-unavailable", null],
  ]);
  assert.deepEqual(applied.results[0].uncheckedSignals, ["unsubscribe-link"]);
  const submit = ws.run("submit", "--run-id", "r1", "--summary", "t").json;
  assert.deepEqual(submit.accounts.b.ruleNotices.map((n) => n.kind), ["reduced", "skipped"]);
  assert.deepEqual(submit.accounts.a.ruleNotices.map((n) => n.ruleId), [ruleA.id]);
  assert.deepEqual(Object.keys(notices().rules["containment-1"]).sort(), [`a\n${ruleA.id}`, `b\n${ruleB.id}`, `b\n${repeatRuleB.id}`].sort());

  const second = ws.run("begin", "--run-id", "r2").json;
  assert.equal(second.inboxes.a.ruleNotices, undefined);
  assert.equal(second.inboxes.b.ruleNotices, undefined);
});

test("undo never moves from a folder it couldn't list to its end, not even a single visible match", () => {
  const ws = twoInboxes();
  maintenance(ws, "r1");
  const folders = ws.mailbox().accounts.b.folders;
  const moved = folders["Auto/Notifications"];
  assert.equal(moved.length, 2);
  // A listing that reached its end can say a message wasn't found.
  ws.setFake("b", { folders: { ...folders, "Auto/Notifications": [moved[0]] } });
  const ended = ws.run("undo", "--run-id", "r1", "--dry-run").json;
  assert.deepEqual([ended.reversed, ended.remaining, ended.unresolved.map((u) => u.reason)], [1, 1, ["not-found"]]);

  // A look-alike of a moved message at the top, the originals beyond the cap.
  const twin = { ...moved[0], id: "9001" };
  ws.setFake("b", { folders: { ...folders, "Auto/Notifications": [twin, ...bulkInbox(1000, 5001), ...moved] } });
  const before = listCalls(ws, "b", "Auto/Notifications").length;
  const undone = ws.run("undo", "--run-id", "r1").json;
  assert.deepEqual([undone.reversed, undone.remaining, undone.undone], [0, 2, false]);
  assert.deepEqual(undone.unresolved.map((u) => [u.reason, u.stopReason]), [
    ["folder-not-fully-checked", "budget"],
    ["folder-not-fully-checked", "budget"],
  ]);
  assert.equal(undone.retryMayHelp, false, "a folder too large to check isn't helped by trying again");
  assert.ok(undone.unresolved.every((u) => u.from === "Auto/Notifications" && u.to === "INBOX"));

  const calls = listCalls(ws, "b", "Auto/Notifications").slice(before);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.query === ""));
  assert.equal(ws.mailbox().accounts.b.folders["Auto/Notifications"].length, 1003, "nothing moved back, not even the look-alike");
  // A connection problem part-way through the listing is one a retry may get past.
  ws.setFake("b", { listFailPage: 2 });
  const dropped = ws.run("undo", "--run-id", "r1", "--dry-run").json;
  assert.deepEqual([dropped.reversed, dropped.retryMayHelp, dropped.unresolved[0].stopReason], [0, true, "transport"]);
  ws.setFake("b", { listFailPage: null });

  // The run stays undoable: once the folder can be listed to its end, it is.
  ws.setFake("b", { folders });
  const later = ws.run("undo", "--run-id", "r1").json;
  assert.deepEqual([later.reversed, later.remaining, later.undone], [2, 0, true]);
  assert.equal(ws.run("undo", "--run-id", "r1").json.reused, true);
});

test("an undo move never confirmed blocks the next undo until it is reconciled", () => {
  const ws = twoInboxes();
  maintenance(ws, "r1");
  ws.run("undo", "--run-id", "r1", "--dry-run");
  const undoFile = path.join(ws.dir, ".mailkeeper", "runs", "undo-r1.json");
  const lock = path.join(ws.dir, ".mailkeeper", "run.lock");
  // As left by a crash after the move was sent, before it was confirmed.
  const journal = JSON.parse(fs.readFileSync(undoFile, "utf8"));
  const destination = ws.mailbox().accounts.b.folders["Auto/Notifications"];
  journal.pending = { account: "b", from: "Auto/Notifications", to: "INBOX", uids: destination.map((e) => e.id), undoOf: "r1", at: new Date().toISOString() };
  fs.writeFileSync(undoFile, JSON.stringify(journal));
  fs.writeFileSync(lock, JSON.stringify({ runId: "undo-r1", trigger: "undo", startedAt: new Date().toISOString() }));
  const callsBefore = ws.mailbox().calls.length;
  const lockBefore = fs.readFileSync(lock, "utf8");

  for (const args of [["--dry-run"], []]) {
    const refused = ws.run("undo", "--run-id", "r1", ...args).json;
    assert.equal(refused.code, "MAILKEEPER_MUTATION_UNCERTAIN", args.join(" "));
  }
  assert.equal(ws.mailbox().calls.length, callsBefore, "no listing or move");
  assert.deepEqual(JSON.parse(fs.readFileSync(undoFile, "utf8")).pending, journal.pending, "the pending move is kept");
  assert.equal(fs.readFileSync(lock, "utf8"), lockBefore, "the guard is kept");
  assert.equal(ws.run_("r1").undoneAt, undefined);

  // After the person checks the inbox, reconciling releases it; nothing is replayed.
  assert.equal(ws.run("release", "--run-id", "undo-r1", "--reconciled").json.released, true);
  assert.equal(ws.mailbox().calls.length, callsBefore);
  const after = ws.run("undo", "--run-id", "r1").json;
  assert.deepEqual([after.reversed, after.undone], [2, true]);
});

test("a partial undo stays recoverable across destinations, inboxes and attempts, sharing one read budget per inbox", () => {
  const CAL_QUERY = "calendar accept/decline/invitation subjects";
  const calendar = {
    id: core.ruleId({ account: "b", pass: "calendar-response", query: CAL_QUERY, action: "move → Auto/Calendar" }),
    account: "b",
    pass: "calendar-response",
    query: CAL_QUERY,
    action: "move → Auto/Calendar",
  };
  const ruleA = { ...ruleB, account: "a", id: core.ruleId({ ...ruleB, account: "a" }) };
  const ws = twoInboxes({
    promoted: [ruleA, ruleB, calendar],
    a: { folders: { "Auto/Notifications": [] } },
    b: {
      messages: [...standardInbox(), msg(7, "alice@people.example", "Accepted: Planning sync"), msg(8, "bob@people.example", "Declined: Lunch")],
      folders: { "Auto/Notifications": [], "Auto/Calendar": [] },
    },
  });
  maintenance(ws, "r1");
  const receipt = ws.receipt("r1");
  assert.deepEqual(receipt.accounts.a.movedByDestination, { "Auto/Notifications": 1 });
  assert.deepEqual(receipt.accounts.b.movedByDestination, { "Auto/Notifications": 2, "Auto/Calendar": 2 });

  const moves = (account) => ws.mailbox().calls.filter((c) => c.account === account && c.op === "message move").length;
  const lists = (account) => ws.mailbox().calls.filter((c) => c.account === account && c.op === "envelope list").length;
  const original = ws.mailbox().accounts.b.folders;
  ws.setFake("b", { folders: { ...original, "Auto/Calendar": [...bulkInbox(1000, 5001), ...original["Auto/Calendar"]] } });
  const listsBefore = lists("b");
  const first = ws.run("undo", "--run-id", "r1", "--account", "b").json;
  assert.deepEqual([first.reversed, first.remaining, first.undone], [2, 3, false]);
  assert.deepEqual(first.unresolved.map((u) => [u.from, u.reason]), [
    ["Auto/Calendar", "folder-not-fully-checked"],
    ["Auto/Calendar", "folder-not-fully-checked"],
  ]);
  assert.equal(lists("b") - listsBefore, 5, "one budget for both of b's folders");
  assert.equal(ws.run_("r1").undoneAt, undefined);

  ws.setFake("b", { folders: { ...ws.mailbox().accounts.b.folders, "Auto/Calendar": original["Auto/Calendar"] } });
  const movesBefore = moves("b");
  const second = ws.run("undo", "--run-id", "r1", "--account", "b").json;
  assert.deepEqual([second.reversed, second.alreadyReversed, second.remaining, second.undone], [2, 2, 1, false]);
  assert.equal(moves("b") - movesBefore, 1, "only the calendar folder moved; the reversed messages weren't touched again");

  // a's move is still owed: the run is undone only once every inbox is.
  const third = ws.run("undo", "--run-id", "r1").json;
  assert.deepEqual([third.reversed, third.alreadyReversed, third.remaining, third.undone], [1, 4, 0, true]);
  assert.equal(ws.run("undo", "--run-id", "r1").json.reused, true);
  const box = ws.mailbox().accounts;
  assert.equal(box.a.folders.INBOX.length, 6);
  assert.equal(box.b.folders.INBOX.length, 8);
  assert.deepEqual([box.b.folders["Auto/Notifications"].length, box.b.folders["Auto/Calendar"].length], [0, 0]);
});

test("older journals: dry-run entries never count, and moves without sender, subject and date are never guessed", () => {
  const ws = twoInboxes();
  fs.mkdirSync(path.join(ws.dir, ".mailkeeper", "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(ws.dir, ".mailkeeper", "runs", "legacy-1.json"),
    JSON.stringify({
      runId: "legacy-1",
      startedAt: daysAgo(30),
      actions: [
        { kind: "move", account: "b", uid: "1", from: "INBOX", to: "Auto/Notifications", dryRun: false },
        { kind: "move", account: "b", uid: "2", from: "INBOX", to: "Auto/Notifications", dryRun: true },
      ],
    })
  );
  const undone = ws.run("undo", "--run-id", "legacy-1").json;
  assert.deepEqual([undone.reversed, undone.remaining, undone.undone], [0, 1, false]);
  assert.deepEqual(undone.unresolved.map((u) => [u.uid, u.reason]), [["1", "no-fingerprint"]]);
  assert.equal((ws.mailbox().calls || []).some((call) => call.account === "b"), false, "the inbox isn't contacted");
});

test("pages with repeated, overlapping or unusable rows never count as a complete read", () => {
  const raw = (id, extra = {}) => ({ ...msg(id, `p${id}@people.example`, `Hello ${id}`), ...extra });
  const full = bulkInbox(200);
  for (const [name, messages, listPages, stopReason, read] of [
    ["within-page duplicate", standardInbox(), { 1: [raw(1), raw(1), raw(2)] }, "overlap", 2],
    ["missing id", standardInbox(), { 1: [raw(1), raw(2, { id: undefined })] }, "invalid_response", 1],
    ["bad uid", standardInbox(), { 1: [raw(1), raw("abc")] }, "invalid_response", 1],
    ["flags not a list", standardInbox(), { 1: [raw(1), raw(2, { flags: "Flagged" })] }, "invalid_response", 1],
    ["no sender", standardInbox(), { 1: [raw(1), raw(2, { from: null })] }, "invalid_response", 1],
    ["overlap with page 1", full, { 2: [full[199], raw(9999)] }, "overlap", 201],
    ["longer than asked", standardInbox(), { 1: bulkInbox(201) }, "invalid_response", 201],
  ]) {
    const ws = twoInboxes({ b: { messages } });
    ws.setFake("b", { listPages });
    ws.run("begin", "--run-id", "r1", "--account", "b");
    const snap = ws.run("snapshot", "--account", "b", "--run-id", "r1").json;
    assert.equal(snap.ok, true, name);
    assert.deepEqual([snap.coverage.complete, snap.coverage.stopReason, snap.coverage.inboxRead], [false, stopReason, read], name);
    const applied = ws.run("apply", "--account", "b", "--promoted-only", "--run-id", "r1").json;
    assert.deepEqual([applied.dryRun, applied.reportOnly], [true, "partial-coverage"], name);
    assert.equal(ws.mailbox().calls.some((call) => call.op === "message move"), false, name);
  }
  // Nothing usable on the first page is a failure, not an empty inbox.
  const ws = twoInboxes();
  ws.setFake("b", { listPages: { 1: [{ id: "1" }] } });
  ws.run("begin", "--run-id", "r1", "--account", "b");
  assert.equal(ws.run("snapshot", "--account", "b", "--run-id", "r1").json.code, "MAILKEEPER_OPERATION_FAILED");
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a page still running at the deadline is cut off, and its read process and runner end, even if it ignores SIGTERM", () => {
  for (const ignoreTerm of [false, true]) {
    const ws = twoInboxes({ b: { messages: bulkInbox(450) } });
    ws.setFake("b", {
      listSlowPage: 2,
      listSlowMs: 30_000,
      listIgnoreTerm: ignoreTerm,
      // Out-of-bounds text from a read that then times out is still not an end.
      listSlowStderr: "Error: \n   0: cannot list imap envelopes: page 2 out of bounds\n",
    });
    ws.env.MAILKEEPER_READ_DEADLINE_MS = "3000";
    ws.run("begin", "--run-id", "r1", "--account", "b");
    const started = Date.now();
    const snap = ws.run("snapshot", "--account", "b", "--run-id", "r1").json;
    const took = Date.now() - started;
    assert.ok(took < 6_000, `ignoreTerm ${ignoreTerm}: the read ended at its deadline (${took} ms)`);
    assert.deepEqual(
      [snap.coverage.complete, snap.coverage.stopReason, snap.coverage.inboxRead, snap.coverage.code],
      [false, "deadline", 200, "MAILKEEPER_TIMEOUT"]
    );
    const { pid, runner } = JSON.parse(fs.readFileSync(path.join(ws.dir, "fake-mailbox.json.slow-pid"), "utf8"));
    assert.equal(alive(pid), false, `ignoreTerm ${ignoreTerm}: the read process is gone`);
    assert.equal(alive(runner), false, `ignoreTerm ${ignoreTerm}: its runner is gone`);
  }
});

test("the runner ends at the deadline even when Himalaya has exited but something it started holds the pipes", () => {
  const ws = twoInboxes({ b: { messages: bulkInbox(450) } });
  ws.setFake("b", { listPipeHolderPage: 2, listSlowMs: 20_000 });
  ws.env.MAILKEEPER_READ_DEADLINE_MS = "3000";
  ws.run("begin", "--run-id", "r1", "--account", "b");
  const started = Date.now();
  const snap = ws.run("snapshot", "--account", "b", "--run-id", "r1").json;
  const took = Date.now() - started;
  const { pid, runner, holder } = JSON.parse(fs.readFileSync(path.join(ws.dir, "fake-mailbox.json.slow-pid"), "utf8"));
  try {
    assert.ok(took < 6_000, `the runner returned at its deadline, not through the wrapper's (${took} ms)`);
    assert.deepEqual([snap.coverage.complete, snap.coverage.stopReason, snap.coverage.code], [false, "deadline", "MAILKEEPER_TIMEOUT"]);
    assert.equal(alive(pid), false, "Himalaya is gone");
    assert.equal(alive(runner), false, "the runner is gone");
  } finally {
    // The pipe holder is the fixture's own; MailKeeper doesn't manage it.
    if (alive(holder)) process.kill(holder, "SIGKILL");
  }
});

test("a wrapper that starts late never starts the read, and one stuck past the deadline is ended", () => {
  for (const delay of [6_000, 9_000]) {
    const ws = twoInboxes({ b: { messages: bulkInbox(450) } });
    Object.assign(ws.env, { MAILKEEPER_READ_DEADLINE_MS: "3000", FAKE_RTXEXEC_DELAY_PAGE: "2", FAKE_RTXEXEC_DELAY_MS: String(delay) });
    ws.run("begin", "--run-id", "r1", "--account", "b");
    const started = Date.now();
    const snap = ws.run("snapshot", "--account", "b", "--run-id", "r1").json;
    const took = Date.now() - started;
    // 6 s: the runner starts after the deadline and runs nothing. 9 s: the
    // wrapper is killed at the deadline plus its margin, before it starts one.
    assert.ok(took < Math.min(delay, 8_000) + 1_500, `delay ${delay}: returned after ${took} ms`);
    assert.deepEqual([snap.coverage.complete, snap.coverage.stopReason, snap.coverage.inboxRead], [false, "deadline", 200], `delay ${delay}`);
    const wrapper = Number(fs.readFileSync(path.join(ws.dir, "fake-mailbox.json.wrapper-pid"), "utf8"));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay === 9_000 ? 2_000 : 0);
    assert.equal(alive(wrapper), false, `delay ${delay}: the wrapper is gone`);
    assert.equal(listCalls(ws, "b").some((call) => call.page === 2), false, `delay ${delay}: page 2 was never read`);
  }
});

test("only Himalaya's own page-past-the-end answer ends a listing; other failures that mention bounds don't", () => {
  for (const [name, stderr] of [
    ["another bounds error", "index out of bounds while parsing a header"],
    ["another page", "cannot list imap envelopes: page 7 out of bounds"],
    ["with a further cause", "cannot list imap envelopes: page 2 out of bounds\n   1: connection reset"],
  ]) {
    const ws = twoInboxes({ b: { messages: bulkInbox(450) } });
    ws.setFake("b", { listStderrPage: 2, listStderr: stderr });
    ws.run("begin", "--run-id", "r1", "--account", "b");
    const snap = ws.run("snapshot", "--account", "b", "--run-id", "r1").json;
    assert.deepEqual([snap.coverage.complete, snap.coverage.stopReason, snap.coverage.inboxRead], [false, "transport", 200], name);
  }
});

// ---------------------------------------------------------------------------
// Release: urgent items in every plan, and undo advice before a move
// ---------------------------------------------------------------------------

const snapshotHash = (ws, account) =>
  crypto.createHash("sha256").update(fs.readFileSync(path.join(ws.dir, ".mailkeeper", "accounts", core.accountKey(account), "snapshot.json"))).digest("hex");
const tenNoReply = () => Array.from({ length: 10 }, (_, i) => msg(300 + i, `noreply@n${i}.example`, `Digest ${i}`));

test("a chat preview shows urgent items from the read itself, and the receipt keeps them, without a separate triage", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.deepEqual(preview.urgentLeftInPlace, { total: 1, items: [{ from: "noreply@billing.example", subject: "Final notice: payment overdue" }], more: 0 });
  const applied = ws.run("apply", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.equal(applied.results[0].moved, 2);
  assert.ok(ws.mailbox().accounts.b.folders.INBOX.some((m) => m.subject === "Final notice: payment overdue"), "urgent mail stays");
  const submit = ws.run("submit", "--run-id", "r1", "--summary", "t").json;
  assert.deepEqual([submit.accounts.b.urgentChecked, submit.accounts.b.urgentCount], [true, 1]);
  assert.deepEqual(ws.receipt("r1").urgent.map((u) => [u.account, u.subject, u.folder]), [["b", "Final notice: payment overdue", "INBOX"]]);
});

test("a newer read replaces earlier urgent results, a failed read is never nothing urgent, and inboxes stay separate", () => {
  const ws = twoInboxes({ b: { folders: { "Auto/Notifications": [], Quiet: [msg(700, "friend@people.example", "Lunch?")] } } });
  ws.run("begin", "--run-id", "r1");
  ws.run("snapshot", "--account", "a", "--run-id", "r1");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  assert.deepEqual(ws.run_("r1").urgent.map((u) => u.account).sort(), ["a", "b"]);
  ws.run("snapshot", "--account", "b", "--run-id", "r1", "--folder", "Quiet");
  const run = ws.run_("r1");
  assert.deepEqual(run.urgent.map((u) => u.account), ["a"], "b's INBOX results are replaced by its Quiet read; a's stay");
  assert.deepEqual([run.urgentChecks.b.ok, run.urgentChecks.b.folder, run.urgentChecks.b.total], [true, "Quiet", 0]);
  ws.setFake("b", { listFailPage: 1 });
  assert.equal(ws.run("snapshot", "--account", "b", "--run-id", "r1").json.code, "MAILKEEPER_OPERATION_FAILED");
  const submit = ws.run("submit", "--run-id", "r1", "--summary", "t").json;
  assert.deepEqual([submit.accounts.b.urgentChecked, submit.accounts.b.urgentCount], [false, 0]);
  assert.deepEqual([submit.accounts.a.urgentChecked, submit.accounts.a.urgentCount], [true, 1]);
});

test("a preview lists at most ten urgent items and gives the total", () => {
  const urgentMail = Array.from({ length: 12 }, (_, i) => msg(800 + i, `billing${i}@shop.example`, `Final notice ${i}`));
  const ws = twoInboxes({ b: { messages: [...standardInbox().slice(0, 2), ...urgentMail] } });
  ws.run("begin", "--run-id", "r1", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.deepEqual([preview.urgentLeftInPlace.total, preview.urgentLeftInPlace.items.length, preview.urgentLeftInPlace.more], [12, 10, 2]);
});

test("undo advice: an absent destination is found by the folder list, a report-only plan gets none, and the source snapshot is untouched", () => {
  const ws = twoInboxes({ b: { folders: {} } });
  ws.run("begin", "--run-id", "r1", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const before = snapshotHash(ws, "b");
  const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.deepEqual([preview.from, preview.target, preview.targetExists], ["INBOX", "Auto/Notifications", false]);
  assert.deepEqual([preview.undoAdvisory.state, preview.undoAdvisory.reason, preview.undoAdvisory.plannedCount], ["no-obstacle", null, 2]);
  assert.equal(snapshotHash(ws, "b"), before, "the source snapshot is unchanged");
  assert.equal(listCalls(ws, "b", "Auto/Notifications").length, 0, "an absent folder isn't listed");

  const reportOnly = twoInboxes({ b: { policy: { mode: "report-only", credential: secretB } } });
  reportOnly.run("begin", "--run-id", "r1", "--account", "b");
  reportOnly.run("snapshot", "--account", "b", "--run-id", "r1");
  const calls = reportOnly.mailbox().calls.length;
  const plain = reportOnly.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.deepEqual([plain.wouldMove, plain.undoAdvisory, plain.targetExists], [false, null, null]);
  assert.equal(reportOnly.mailbox().calls.length, calls, "no destination check for a plan that moves nothing");
});

test("undo advice at the size boundary: 989 + 10 can still be checked, 990 + 10 can't", () => {
  for (const [existing, state, reason] of [
    [989, "no-obstacle", null],
    [990, "limit", "size"],
  ]) {
    const ws = twoInboxes({ b: { messages: tenNoReply(), folders: { "Auto/Notifications": bulkInbox(existing, 5001) } } });
    ws.run("begin", "--run-id", "r1", "--account", "b");
    ws.run("snapshot", "--account", "b", "--run-id", "r1");
    const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
    assert.deepEqual([preview.targetExists, preview.undoAdvisory.state, preview.undoAdvisory.reason], [true, state, reason], `${existing}`);
  }
});

test("undo advice failures stay local: the inbox isn't failed and its snapshot is untouched", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const before = snapshotHash(ws, "b");
  ws.setFake("b", { failFolderList: true });
  const preview = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.equal(preview.ok, true);
  assert.deepEqual([preview.targetExists, preview.undoAdvisory.state, preview.undoAdvisory.reason], [null, "unknown", "check-failed"]);
  assert.equal(ws.run_("r1").accounts.b.outcome, null, "the inbox isn't failed");
  assert.equal(snapshotHash(ws, "b"), before);
});

test("undo advice flags look-alikes among the moves and in the destination", () => {
  const twin = msg(1, "noreply@twin.example", "Same");
  const twin2 = { ...twin, id: "2" };
  const ws = twoInboxes({ b: { messages: [twin, twin2], folders: { "Auto/Notifications": [] } } });
  ws.run("begin", "--run-id", "r1", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const among = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.deepEqual([among.undoAdvisory.state, among.undoAdvisory.reason, among.undoAdvisory.lookAlikeCount], ["limit", "look-alike", 2]);

  const ws2 = twoInboxes({ b: { messages: [twin], folders: { "Auto/Notifications": [{ ...twin, id: "900" }] } } });
  ws2.run("begin", "--run-id", "r1", "--account", "b");
  ws2.run("snapshot", "--account", "b", "--run-id", "r1");
  const present = ws2.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.deepEqual([present.undoAdvisory.state, present.undoAdvisory.reason, present.undoAdvisory.lookAlikeCount], ["limit", "look-alike", 1]);
});

test("undo advice shares one allowance per inbox: two folders that only overflow together, and an allowance used up", () => {
  const calendar = () => Array.from({ length: 10 }, (_, i) => msg(400 + i, `p${i}@people.example`, `Accepted: Meeting ${i}`));
  const ws = twoInboxes({
    b: { messages: [...tenNoReply(), ...calendar()], folders: { "Auto/Notifications": bulkInbox(399, 5001), "Auto/Calendar": bulkInbox(399, 7001) } },
  });
  ws.run("begin", "--run-id", "r1", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  const first = ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json;
  assert.deepEqual([first.undoAdvisory.state, first.undoAdvisory.reason], ["no-obstacle", null]);
  const second = ws.run("preview", "--account", "b", "--pass", "calendar-response", "--run-id", "r1").json;
  assert.deepEqual([second.undoAdvisory.state, second.undoAdvisory.reason], ["limit", "combined-size"]);

  const used = twoInboxes({
    b: { messages: [...tenNoReply(), ...calendar()], folders: { "Auto/Notifications": bulkInbox(900, 5001), "Auto/Calendar": [] } },
  });
  used.run("begin", "--run-id", "r1", "--account", "b");
  used.run("snapshot", "--account", "b", "--run-id", "r1");
  assert.equal(used.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1").json.undoAdvisory.state, "no-obstacle");
  const after = used.run("preview", "--account", "b", "--pass", "calendar-response", "--run-id", "r1").json;
  assert.deepEqual([after.undoAdvisory.state, after.undoAdvisory.reason], ["unknown", "allowance-used"]);
});

test("the receipt carries the undo advice for moves made, and unassessed for scheduled or changed plans", () => {
  const ws = twoInboxes();
  ws.run("begin", "--run-id", "r1", "--account", "b");
  ws.run("snapshot", "--account", "b", "--run-id", "r1");
  ws.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1");
  ws.run("apply", "--account", "b", "--pass", "no-reply", "--run-id", "r1");
  ws.run("submit", "--run-id", "r1", "--summary", "t");
  assert.deepEqual(ws.receipt("r1").accounts.b.undoAdvisories, [{ destination: "Auto/Notifications", state: "no-obstacle", reason: null }]);

  const scheduled = twoInboxes();
  maintenance(scheduled, "r1");
  assert.deepEqual(scheduled.receipt("r1").accounts.b.undoAdvisories, [{ destination: "Auto/Notifications", state: "unassessed", reason: null }]);

  const changed = twoInboxes();
  changed.run("begin", "--run-id", "r1", "--account", "b");
  changed.run("snapshot", "--account", "b", "--run-id", "r1");
  changed.run("preview", "--account", "b", "--pass", "no-reply", "--run-id", "r1");
  const box = changed.mailbox().accounts.b.folders;
  changed.setFake("b", { folders: { ...box, INBOX: [...box.INBOX, msg(77, "noreply@late.example", "Late arrival")] } });
  changed.run("snapshot", "--account", "b", "--run-id", "r1");
  changed.run("apply", "--account", "b", "--pass", "no-reply", "--run-id", "r1");
  changed.run("submit", "--run-id", "r1", "--summary", "t");
  assert.deepEqual(changed.receipt("r1").accounts.b.undoAdvisories.map((u) => u.state), ["unassessed"], "the advice was for a different plan");
});

// ---------------------------------------------------------------------------
// With the real Himalaya binary
// ---------------------------------------------------------------------------

function setupWorkspace(configFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-setup-"));
  fs.mkdirSync(path.join(dir, ".mailkeeper"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".mailkeeper", "rules.json"),
    JSON.stringify({
      schemaVersion: 2,
      revision: 0,
      himalayaConfig: { paths: fs.existsSync(configFile) ? [configFile] : [], target: configFile, source: "HIMALAYA_CONFIG" },
      config: { emailAccounts: [], mode: "report-only", promotablePasses: [], protectedDomains: [], vipSenders: [], autoFolderPrefix: "Auto", ageThresholdDays: 90 },
      accounts: {},
      promoted: [],
    })
  );
  return dir;
}

function cli(dir, args, env = {}) {
  const result = spawnSync(process.execPath, [OPS, ...args], {
    cwd: dir,
    env: { ...process.env, MAILKEEPER_HIMALAYA_BIN: "himalaya", HIMALAYA_CONFIG: path.join(dir, "no-real-config.toml"), ...env },
    encoding: "utf8",
  });
  return { ...result, json: JSON.parse(result.stdout) };
}

test("real Himalaya: a full page followed by the page past the end is a complete read", { skip: !HAS_HIMALAYA && "himalaya not installed" }, async () => {
  const password = `mk-pages-${crypto.randomBytes(10).toString("hex")}`;
  for (const [messages, pages] of [
    [0, 1],
    [200, 2],
    [201, 2],
  ]) {
    const stub = await startImapStub({ user: "w@example.com", password, messages });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mk-pages-"));
    const configFile = path.join(home, "config.toml");
    try {
      const dir = setupWorkspace(configFile);
      cli(dir, ["account-config", "--account", "work", "--email", "w@example.com", "--host", "127.0.0.1", "--port", String(stub.port), "--encryption", "none"]);
      const rulesFile = path.join(dir, ".mailkeeper", "rules.json");
      const rules = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
      rules.himalayaConfig.paths = [configFile];
      rules.config.emailAccounts = ["work"];
      const key = core.accountKey("work");
      rules.accounts.work = { key, contract: core.contractRelativePath(key) };
      fs.mkdirSync(path.join(dir, "mailboxes", key), { recursive: true });
      const credential = { kind: "realtimex-secret", passwordRef: "secret://work-imap#password" };
      fs.writeFileSync(
        path.join(dir, core.contractRelativePath(key)),
        `# work\n\n${core.renderPolicyBlock({ ...core.draftPolicy("work", { ageThresholdDays: 90 }), credential })}\n`
      );
      fs.writeFileSync(rulesFile, JSON.stringify(rules));
      const env = {
        ...process.env,
        MAILKEEPER_HIMALAYA_BIN: "himalaya",
        HIMALAYA_CONFIG: configFile,
        MAILKEEPER_RTXEXEC_BIN: FAKE_RTXEXEC,
        FAKE_SECRETS: JSON.stringify({ "work-imap": password }),
        FAKE_RTX_SESSION: "1",
      };
      const run = async (...args) => {
        const { stdout } = await execFileAsync(process.execPath, [OPS, ...args], { cwd: dir, env }).catch((error) => error);
        return JSON.parse(stdout);
      };
      assert.equal((await run("begin", "--run-id", "r1")).ok, true);
      const snap = await run("snapshot", "--account", "work", "--run-id", "r1");
      assert.deepEqual([snap.coverage.complete, snap.coverage.stopReason, snap.coverage.inboxRead], [true, null, messages], `${messages} messages`);
      assert.equal(stub.log.filter((event) => event.login === "accepted").length, pages, `${messages} messages: pages read`);
    } finally {
      await stub.close();
    }
  }
});

test("account-config writes only the chosen inbox's entry, with no password", { skip: !HAS_HIMALAYA && "himalaya not installed" }, () => {
  const sentinel = `inline-${crypto.randomBytes(8).toString("hex")}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mk-cfg-"));
  const configFile = path.join(home, "config.toml");
  const other = [
    '[accounts."other"]',
    'email = "other@example.com"',
    'backend.type = "imap"',
    'backend.host = "imap.example.com"',
    "backend.port = 993",
    'backend.login = "other@example.com"',
    'backend.auth.type = "password"',
    `backend.auth.raw = "${sentinel}"`,
    "",
  ].join("\n");
  fs.writeFileSync(configFile, other);
  const dir = setupWorkspace(configFile);

  const created = cli(dir, ["account-config", "--account", "work@example.com", "--email", "work@example.com", "--host", "imap.example.com"]);
  assert.equal(created.json.ok, true, created.stdout);
  const written = fs.readFileSync(configFile, "utf8");
  assert.ok(written.startsWith(other.trimEnd()), "other inboxes are preserved byte for byte");
  assert.match(written, /\[accounts\."work@example\.com"\]/);
  assert.match(written, /backend\.auth\.cmd = ".*himalaya-auth\.js' --account 'work@example\.com'"/);
  assert.equal((fs.statSync(configFile).mode & 0o777).toString(8), "600");

  const described = cli(dir, ["config-check", "--account", "other"]);
  assert.equal(described.json.inlineSecret, true);
  assert.equal(described.stdout.includes(sentinel), false, "values are never echoed");
  assert.equal(cli(dir, ["config-check", "--account", "work@example.com"]).json.signIn, "mailkeeper-secrets");

  // An existing entry is never overwritten without an explicit repair.
  assert.equal(cli(dir, ["account-config", "--account", "other", "--email", "other@example.com", "--host", "imap.example.com"]).json.code, "MAILKEEPER_ACCOUNT_EXISTS");
  const replaced = cli(dir, ["account-config", "--account", "other", "--email", "other@example.com", "--host", "imap.example.com", "--replace"]);
  assert.equal(replaced.json.removedInlineSecret, true);
  assert.equal(fs.readFileSync(configFile, "utf8").includes(sentinel), false);
  assert.equal(replaced.stdout.includes(sentinel), false);

  fs.appendFileSync(configFile, '\n[accounts.nested.backend]\ntype = "imap"\n');
  assert.equal(cli(dir, ["account-config", "--account", "nested", "--email", "n@example.com", "--host", "imap.example.com"]).json.code, "MAILKEEPER_HIMALAYA_CONFIG_INVALID");
});

test("account-config keeps existing names and aliases and never merges by address", { skip: !HAS_HIMALAYA && "himalaya not installed" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mk-cfg-"));
  const configFile = path.join(home, "config.toml");
  const alias = ['[accounts.work]', 'email = "Work@Example.com"', 'backend.type = "imap"', 'backend.host = "imap.example.com"', "backend.port = 993",
    'backend.login = "work@example.com"', 'backend.auth.type = "password"', 'backend.auth.cmd = "security find-generic-password -w -s work"', ""].join("\n");
  fs.writeFileSync(configFile, alias);
  const dir = setupWorkspace(configFile);

  const sameAddress = cli(dir, ["account-config", "--account", "work@example.com", "--email", "work@example.com", "--host", "imap.example.com"]);
  assert.deepEqual([sameAddress.json.code, sameAddress.json.existingAccount], ["MAILKEEPER_ACCOUNT_EXISTS", "work"]);
  const caseVariant = cli(dir, ["account-config", "--account", "WORK", "--email", "other@example.com", "--host", "imap.example.com"]);
  assert.deepEqual([caseVariant.json.code, caseVariant.json.existingAccount], ["MAILKEEPER_ACCOUNT_EXISTS", "work"]);
  assert.equal(fs.readFileSync(configFile, "utf8"), alias, "the alias is untouched");

  const fresh = cli(dir, ["account-config", "--account", "home@example.com", "--email", "home@example.com", "--host", "imap.example.com"]);
  assert.equal(fresh.json.ok, true);
  const listed = cli(dir, ["accounts"]).json.inboxes.map((i) => i.name).sort();
  assert.deepEqual(listed, ["home@example.com", "work"], "an email-shaped name survives discovery exactly");
});

test("account-config creates a missing settings file at the pinned location", { skip: !HAS_HIMALAYA && "himalaya not installed" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mk-cfg-"));
  const configFile = path.join(home, "himalaya", "config.toml");
  const dir = setupWorkspace(configFile);
  assert.equal(cli(dir, ["accounts"]).json.code, "MAILKEEPER_HIMALAYA_CONFIG_MISSING");
  const created = cli(dir, ["account-config", "--account", "work", "--email", "w@example.com", "--host", "imap.example.com"]);
  assert.equal(created.json.created, true);
  assert.ok(fs.existsSync(configFile));
});

test("the setup path signs in through Secrets end to end, and discovery runs no auth command", { skip: !HAS_HIMALAYA && "himalaya not installed" }, async () => {
  const password = `mk-e2e-${crypto.randomBytes(10).toString("hex")}`;
  const stub = await startImapStub({ user: "w@example.com", password });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mk-e2e-"));
  const configFile = path.join(home, "config.toml");
  const marker = path.join(home, "native-auth-ran");
  try {
    const dir = setupWorkspace(configFile);
    cli(dir, ["account-config", "--account", "work", "--email", "w@example.com", "--host", "127.0.0.1", "--port", String(stub.port), "--encryption", "none"]);
    assert.equal(fs.readFileSync(configFile, "utf8").includes(password), false, "the Secrets inbox's entry holds no password");
    // A second inbox signs in natively with a command that leaves a marker.
    fs.appendFileSync(
      configFile,
      [
        "",
        '[accounts."native"]',
        'email = "w@example.com"',
        'backend.type = "imap"',
        'backend.host = "127.0.0.1"',
        `backend.port = ${stub.port}`,
        'backend.encryption.type = "none"',
        'backend.login = "w@example.com"',
        'backend.auth.type = "password"',
        `backend.auth.cmd = ${JSON.stringify(`sh -c 'touch ${marker}; printf %s ${password}'`)}`,
        "",
      ].join("\n")
    );
    const rulesFile = path.join(dir, ".mailkeeper", "rules.json");
    const rules = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
    rules.himalayaConfig.paths = [configFile];
    rules.config.emailAccounts = ["work", "native"];
    for (const [name, credential] of [["work", { kind: "realtimex-secret", passwordRef: "secret://work-imap#password" }], ["native", { kind: "himalaya-native" }]]) {
      const key = core.accountKey(name);
      rules.accounts[name] = { key, contract: core.contractRelativePath(key) };
      fs.mkdirSync(path.join(dir, "mailboxes", key), { recursive: true });
      fs.writeFileSync(
        path.join(dir, core.contractRelativePath(key)),
        `# ${name}\n\n${core.renderPolicyBlock({ ...core.draftPolicy(name, { ageThresholdDays: 90 }), credential })}\n`
      );
    }
    fs.writeFileSync(rulesFile, JSON.stringify(rules));
    const env = {
      ...process.env,
      MAILKEEPER_HIMALAYA_BIN: "himalaya",
      HIMALAYA_CONFIG: configFile,
      MAILKEEPER_RTXEXEC_BIN: FAKE_RTXEXEC,
      FAKE_SECRETS: JSON.stringify({ "work-imap": password }),
      FAKE_RTX_SESSION: "1",
    };
    const run = async (...args) => {
      const { stdout } = await execFileAsync(process.execPath, [OPS, ...args], { cwd: dir, env }).catch((error) => error);
      return { stdout, json: JSON.parse(stdout) };
    };
    const listed = await run("accounts");
    assert.deepEqual(listed.json.inboxes.map((i) => i.name).sort(), ["native", "work"]);
    assert.equal(fs.existsSync(marker), false, "discovery never runs an auth command");

    const checked = await run("check", "--account", "work");
    assert.deepEqual(checked.json.folders, ["INBOX", "Archive"]);
    assert.equal(checked.stdout.includes(password), false);

    await run("check", "--account", "native");
    assert.equal(fs.existsSync(marker), true, "the native command runs for the authenticated check");
  } finally {
    await stub.close();
  }
});
