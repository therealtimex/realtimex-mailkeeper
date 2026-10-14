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

  const undone = ws.run("undo", "--run-id", "r1");
  assert.equal(undone.json.reversed, 1);
  const box = ws.mailbox();
  assert.deepEqual(box.accounts.b.folders.INBOX.map((m) => m.subject), ["Solo"]);
  assert.equal(ws.run("undo", "--run-id", "r1").json.reused, true);
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

test("status reports the four setup criteria per inbox and the schedule", () => {
  const ws = twoInboxes();
  ws.writeRules({ schedule: { cadence: "1d", paused: true, threadSlug: "mailkeeper-maintenance-7" } });
  let status = ws.run("status").json;
  assert.deepEqual(status.inboxes.map((i) => i.setupComplete), [false, false], "no connection check yet");
  ws.run("check", "--account", "a");
  status = ws.run("status").json;
  assert.deepEqual(status.inboxes.map((i) => [i.name, i.setupComplete]), [["a", true], ["b", false]]);
  assert.equal(status.schedule.paused, true);
  assert.equal(status.agent, "codex");
  assert.equal(status.agentLabel, "Codex CLI");
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
