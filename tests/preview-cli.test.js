"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../skills/mailbox-cleanup/scripts/mailbox-ops.js");

function fixture(t, accounts, { full = false, failAccount = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailkeeper-preview-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, ".mailkeeper");
  fs.mkdirSync(state);
  const rules = { config: { emailAccounts: accounts, mode: "archive-promoted", agent: "fixture-agent", himalayaConfigPath: "/fixture/shared.toml",
    ageThresholdDays: 90, autoFolderPrefix: "Auto", promotablePasses: ["no-reply"], vipSenders: [], protectedDomains: [] }, promotedRules: [{ pass: "no-reply" }] };
  fs.writeFileSync(path.join(state, "rules.json"), JSON.stringify(rules));
  const binary = path.join(root, "himalaya");
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(path.join(root, "commands.jsonl"))},JSON.stringify(args)+'\\n');
if(args[0]!=='envelope'||args[1]!=='list')process.exit(90);
const account=args[args.indexOf('-a')+1]; if(account===${JSON.stringify(failAccount)})process.exit(91);
const page=Number(args[args.indexOf('-p')+1]);
const rows=${full ? "200" : "0"}; console.log(JSON.stringify(Array.from({length:rows},(_,i)=>({id:page*200+i,from:{addr:'noreply@example.test'},subject:i===0?'Final notice':'Notification',date:'2020-01-01',flags:[]}))));`, { mode: 0o700 });
  return { root, state, rules, invoke(runId) {
    const result = spawnSync(process.execPath, [cli, "onboarding-preview", "--run-id", runId], { cwd: root, env: { ...process.env, MAILKEEPER_HIMALAYA_BIN: binary, HIMALAYA_CONFIG: "/wrong/environment.toml" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result;
  }, execute(runId) {
    const result = this.invoke(runId);
    return { result, receipt: JSON.parse(fs.readFileSync(path.join(state, "outbox", `${runId}.json`))),
      commands: fs.existsSync(path.join(root, "commands.jsonl")) ? fs.readFileSync(path.join(root, "commands.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [] };
  } };
}

test("preview is bounded and excludes urgent mail before proposals even in archive mode", (t) => {
  const f = fixture(t, ["a"], { full: true });
  const { receipt, commands } = f.execute("bounded");
  assert.equal(commands.length, 5);
  assert.ok(commands.every((args) => args[0] === "envelope" && args[1] === "list" && args[args.indexOf("-c") + 1] === "/fixture/shared.toml"));
  assert.equal(receipt.mode, "report-only");
  assert.equal(receipt.kind, "onboarding-preview");
  assert.equal(receipt.snapshot.checked, 1000);
  assert.equal(receipt.urgent.length, 5);
  assert.equal(receipt.proposals[0].count, 995);
  assert.deepEqual(receipt.actions, []);
  assert.equal(receipt.accountOutcomes[0].limitReached, true);
  const attached = f.execute("bounded");
  assert.equal(attached.commands.length, 5, "retry must attach without scanning again");
});

test("empty accounts produce a completed receipt for every selected account", (t) => {
  const { receipt } = fixture(t, ["a", "b"]).execute("empty");
  assert.equal(receipt.outcome, "completed");
  assert.equal(receipt.snapshot.checked, 0);
  assert.deepEqual(receipt.accountOutcomes.map((entry) => [entry.account, entry.outcome, entry.checked]), [["a", "completed", 0], ["b", "completed", 0]]);
});

test("one failed account makes the whole preview failed without exposing stderr", (t) => {
  const { receipt } = fixture(t, ["a", "b"], { failAccount: "b" }).execute("partial");
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.accountOutcomes[0].outcome, "completed");
  assert.deepEqual(receipt.accountOutcomes[1], { account: "b", outcome: "failed", code: "PREVIEW_ACCOUNT_FAILED" });
  assert.deepEqual(receipt.actions, []);
});

test("a durable preview reservation preserves its accounts and shared target after reconfiguration", (t) => {
  const f = fixture(t, ["a"]);
  fs.mkdirSync(path.join(f.state, "previews"));
  fs.writeFileSync(path.join(f.state, "previews/frozen.json"), JSON.stringify({ runId: "frozen", kind: "onboarding-preview", rules: f.rules }));
  fs.writeFileSync(path.join(f.state, "rules.json"), JSON.stringify({ config: { ...f.rules.config, emailAccounts: ["changed"], himalayaConfigPath: "/changed.toml" } }));
  const { receipt, commands } = f.execute("frozen");
  assert.deepEqual(receipt.scope.accounts, ["a"]);
  assert.equal(commands[0][commands[0].indexOf("-a") + 1], "a");
  assert.equal(commands[0][commands[0].indexOf("-c") + 1], "/fixture/shared.toml");
});

test("restart settles interrupted account progress once under the original preview identity", (t) => {
  const f = fixture(t, ["a", "b"]);
  fs.mkdirSync(path.join(f.state, "runs"));
  const runPath = path.join(f.state, "runs/interrupted.json");
  fs.writeFileSync(runPath, JSON.stringify({ runId: "interrupted", kind: "onboarding-preview", mode: "report-only",
    scope: { accounts: ["a", "b"], folders: ["INBOX"], maxPages: 5, pageSize: 200 }, startedAt: "2026-01-01T00:00:00Z",
    snapshot: { checked: 2 }, accountOutcomes: [{ account: "a", outcome: "completed", checked: 2 }],
    actions: [], proposals: [{ account: "a", count: 1 }], urgent: [{ account: "a", uid: "2" }], passes: [] }));
  const { receipt, commands } = f.execute("interrupted");
  assert.equal(receipt.runId, "interrupted"); assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.snapshot.checked, 2); assert.equal(receipt.proposals.length, 1); assert.equal(receipt.urgent.length, 1);
  assert.deepEqual(receipt.accountOutcomes[1], { account: "b", outcome: "failed", code: "PREVIEW_INTERRUPTED" });
  assert.deepEqual(commands, [], "interrupted account must not be scanned again");
  const originalReceipt = fs.readFileSync(path.join(f.state, "outbox/interrupted.json"), "utf8");
  f.execute("interrupted");
  assert.equal(fs.readFileSync(path.join(f.state, "outbox/interrupted.json"), "utf8"), originalReceipt);
  assert.deepEqual(fs.readdirSync(path.join(f.state, "outbox")), ["interrupted.json"]);
});

test("restart after reservation file creation produces a failed receipt for every account", (t) => {
  const f = fixture(t, ["a"]);
  fs.mkdirSync(path.join(f.state, "runs"));
  fs.writeFileSync(path.join(f.state, "runs/initial.json"), JSON.stringify({ runId: "initial", kind: "onboarding-preview", mode: "report-only",
    scope: { accounts: ["a"] }, accountOutcomes: [], snapshot: { checked: 0 }, actions: [], proposals: [], urgent: [] }));
  const { receipt } = f.execute("initial");
  assert.equal(receipt.outcome, "failed"); assert.equal(receipt.accountOutcomes[0].code, "PREVIEW_INTERRUPTED");
});

test("duplicate preview attaches while the original process is still alive", (t) => {
  const f = fixture(t, ["a"]);
  fs.mkdirSync(path.join(f.state, "runs"));
  fs.writeFileSync(path.join(f.state, "runs/running.json"), JSON.stringify({ runId: "running", kind: "onboarding-preview", mode: "report-only",
    runnerPid: process.pid, scope: { accounts: ["a"] }, actions: [], proposals: [], urgent: [] }));
  const result = JSON.parse(f.invoke("running").stdout);
  assert.deepEqual(result, { ok: true, runId: "running", reused: true, outcome: "pending" });
  assert.equal(fs.existsSync(path.join(f.state, "outbox")), false);
  assert.equal(fs.existsSync(path.join(f.root, "commands.jsonl")), false);
});
