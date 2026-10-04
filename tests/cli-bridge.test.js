"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cli = path.resolve(__dirname, "../skills/mailbox-cleanup/scripts/mailbox-ops.js");
const option = (args, name) => args[args.indexOf(`--${name}`) + 1];

// A workspace with one account whose snapshot holds `count` no-reply envelopes,
// and a fake `rtxexec himalaya` that answers moves from a queue of outcomes.
function fixture(t, { count = 0, config = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailkeeper-cli-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, ".mailkeeper");
  fs.mkdirSync(path.join(state, "runs"), { recursive: true });
  fs.writeFileSync(path.join(state, "rules.json"), JSON.stringify({ config: { emailAccounts: ["a"], mode: "archive-promoted",
    pluginId: "fixture-plugin", emailBindings: { a: "binding-a" }, autoFolderPrefix: "Auto", promotablePasses: ["no-reply"],
    vipSenders: [], protectedDomains: [], accounts: { a: { archiveFolder: "Archive", sentFolder: "Sent" } }, ...config }, promoted: [] }));
  fs.writeFileSync(path.join(state, "snapshot-a.json"), JSON.stringify({ account: "a", folder: "INBOX", takenAt: "2026-01-01T00:00:00Z",
    repliedTo: [], sentDomains: [], envelopes: Array.from({ length: count }, (_, i) => ({ uid: String(i + 1), folder: "INBOX",
      date: "2020-01-01", ageDays: 2000, fromName: "", fromAddress: "noreply@example.test", fromDomain: "example.test",
      subject: "Notification", flags: [] })) }));
  const log = path.join(root, "commands.jsonl");
  const queue = path.join(root, "moves.json");
  fs.writeFileSync(queue, "[]");
  const binary = path.join(root, "rtxexec");
  fs.writeFileSync(binary, `#!${process.execPath}
const fs=require('fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const option=(name)=>args[args.indexOf('--'+name)+1]; const operation=option('operation');
const out=(value,code=0)=>{console.log(JSON.stringify(value));process.exit(code);};
if(operation==='folders')out({ok:true,code:'EMAIL_OPERATION_OK',data:[{name:'INBOX'}]});
if(operation==='add-folder')out({ok:true,code:'EMAIL_OPERATION_OK',data:null,operationId:'op-folder',outcome:'confirmed'});
if(operation==='move'){const moves=JSON.parse(fs.readFileSync(${JSON.stringify(queue)}));const next=moves.shift()||'confirmed';
fs.writeFileSync(${JSON.stringify(queue)},JSON.stringify(moves));
if(next==='confirmed')out({ok:true,code:'EMAIL_OPERATION_OK',data:null,operationId:'op-ok',outcome:'confirmed'});out(next,1);}
process.exit(90);`, { mode: 0o700 });
  return {
    state,
    queueMoves: (moves) => fs.writeFileSync(queue, JSON.stringify(moves)),
    run: (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, MAILKEEPER_RTXEXEC_BIN: binary } }),
    runWith: (env, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }),
    commands: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    read: (file) => JSON.parse(fs.readFileSync(path.join(state, file), "utf8")),
  };
}
const uncertain = { ok: false, code: "EMAIL_NETWORK_FAILED", operationId: "op-2", outcome: "uncertain" };

test("an interrupted apply keeps confirmed chunks and the uncertain attempt on its receipt", (t) => {
  const f = fixture(t, { count: 201 });
  f.queueMoves(["confirmed", uncertain]);
  const result = f.run("apply", "--account", "a", "--pass", "no-reply", "--run-id", "r1");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Mailbox operation failed \(EMAIL_NETWORK_FAILED\)/);
  assert.doesNotMatch(result.stderr, /op-2|binding-a/);
  const run = f.read("runs/r1.json");
  assert.equal(run.actions.length, 200, "the confirmed chunk stays undoable");
  assert.deepEqual(run.attempts, [{ account: "a", from: "INBOX", to: "Auto/Notifications", uids: ["201"],
    operationId: "op-2", outcome: "uncertain", code: "EMAIL_NETWORK_FAILED", pass: "no-reply", ruleId: null }]);
  assert.deepEqual(f.read("snapshot-a.json").envelopes, [], "an uncertain move waits for a fresh snapshot readback");
  const moves = f.commands().filter((args) => option(args, "operation") === "move");
  assert.equal(moves.length, 2, "an uncertain move is never replayed automatically");
  assert.ok(moves.every((args) => option(args, "plugin") === "fixture-plugin" && option(args, "binding") === "binding-a"));

  assert.equal(f.run("submit", "--run-id", "r1", "--outcome", "failed").status, 0);
  const receipt = f.read("outbox/r1.json");
  assert.equal(receipt.actions.length, 200);
  assert.equal(receipt.attempts[0].operationId, "op-2");
});

const threeActions = { runId: "r2", actions: [
  { kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }, { kind: "move", account: "a", uid: "2", from: "INBOX", to: "Archive" },
  { kind: "move", account: "a", uid: "3", from: "INBOX", to: "Auto/News" }] };

test("an uncertain undo stays unresolved and a later CLI undo makes no mutation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "runs/r2.json"), JSON.stringify(threeActions));
  f.queueMoves(["confirmed", uncertain]);
  const first = f.run("undo", "--run-id", "r2");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).skipped, [{ account: "a", from: "Auto/News", to: "INBOX", count: 1,
    code: "EMAIL_NETWORK_FAILED", attempt: { operationId: "op-2", outcome: "uncertain" } }]);
  const run = f.read("runs/r2.json");
  assert.equal(run.undoneAt, undefined);
  assert.deepEqual(run.undo.unresolved.map(({ at, ...entry }) => entry),
    [{ account: "a", from: "Auto/News", to: "INBOX", uids: ["3"], operationId: "op-2" }]);

  const second = f.run("undo", "--run-id", "r2");
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /MAILKEEPER_UNDO_UNRESOLVED/);
  assert.equal(f.commands().filter((args) => option(args, "operation") === "move").length, 2, "no further mutation");
});

test("a not_started undo chunk is retried and confirmed reversals are not", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "runs/r2.json"), JSON.stringify(threeActions));
  f.queueMoves(["confirmed", { ok: false, code: "EMAIL_OPERATION_CANCELLED", operationId: "op-2", outcome: "not_started" }]);
  assert.equal(f.run("undo", "--run-id", "r2").status, 0);
  assert.deepEqual(f.read("runs/r2.json").undo.unresolved, []);
  const second = f.run("undo", "--run-id", "r2");
  assert.equal(JSON.parse(second.stdout).reversed, 1);
  const moves = f.commands().filter((args) => option(args, "operation") === "move");
  assert.deepEqual([option(moves[2], "from"), option(moves[2], "uids")], ["Auto/News", "3"]);
  assert.ok(f.read("runs/r2.json").undoneAt);
});

test("a second CLI undo of the same run is refused while one is running", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "runs/r2.json"), JSON.stringify(threeActions));
  fs.writeFileSync(path.join(f.state, "runs/r2.undo.lock"), String(process.pid)); // live holder
  const result = f.run("undo", "--run-id", "r2");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MAILKEEPER_UNDO_BUSY/);
  assert.deepEqual(f.commands(), []);
});

test("missing rtxexec or pre-bridge rules fail safely without launching Himalaya", (t) => {
  const f = fixture(t);
  const missing = f.runWith({ MAILKEEPER_RTXEXEC_BIN: path.join(os.tmpdir(), "no-such-rtxexec") }, "snapshot", "--account", "a");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /\(RTXEXEC_UNAVAILABLE\)/);

  const old = fixture(t, { config: { pluginId: undefined } });
  const stale = old.run("snapshot", "--account", "a");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /predates authenticated email access/);
  assert.deepEqual(old.commands(), []);
});
