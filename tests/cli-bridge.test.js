"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { MailKeeperService } = require("../runtime/service");
const undoJournal = require("../skills/mailbox-cleanup/scripts/undo-journal");
const cli = path.resolve(__dirname, "../skills/mailbox-cleanup/scripts/mailbox-ops.js");
const option = (args, name) => args[args.indexOf(`--${name}`) + 1];

// One workspace shared by the CLI (a fake `rtxexec himalaya` answering moves
// from a queue) and the desktop runtime (a fake host bridge), so both undo
// surfaces act on the same run.
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
  // "crash" logs the move as dispatched, then kills the CLI before it can
  // record the outcome.
  fs.writeFileSync(binary, `#!${process.execPath}
const fs=require('fs'); const args=process.argv.slice(2); if(args[0]==='--version'){console.log(process.env.FAKE_RTXEXEC_VERSION||'0.4.0');process.exit(0);}
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const option=(name)=>args[args.indexOf('--'+name)+1]; const operation=option('operation');
const out=(value,code=0)=>{console.log(JSON.stringify(value));process.exit(code);};
if(operation==='folders')out({ok:true,code:'EMAIL_OPERATION_OK',data:[{name:'INBOX'}]});
if(operation==='add-folder')out({ok:true,code:'EMAIL_OPERATION_OK',data:null,operationId:'op-folder',outcome:'confirmed'});
if(operation==='move'){const moves=JSON.parse(fs.readFileSync(${JSON.stringify(queue)}));const next=moves.shift()||'confirmed';
fs.writeFileSync(${JSON.stringify(queue)},JSON.stringify(moves));
if(next==='crash'){process.kill(process.ppid,'SIGKILL');setTimeout(()=>{},2000);}
else{if(next==='confirmed')out({ok:true,code:'EMAIL_OPERATION_OK',data:null,operationId:'op-ok',outcome:'confirmed'});out(next,1);}}
else process.exit(90);`, { mode: 0o700 });

  const store = new Map();
  const desktopRequests = [];
  let desktopReplies = [];
  const workspace = { id: 1, slug: "fixture", workingDirectory: root };
  const desktop = new MailKeeperService({
    getConfig: () => ({ EMAIL_ACCOUNTS: ["a"], AGENT: "cursor" }),
    getStore: () => ({ get: async (key) => structuredClone(store.get(key)), set: async (key, value) => store.set(key, structuredClone(value)) }),
    workspaces: { get: async () => workspace }, heartbeat: { upsertManagedTask: async () => {} },
    email: {
      getHimalayaTarget: async () => ({ source: "shared", configPath: "/fixture/shared.toml" }),
      executeHimalaya: async (request) => {
        desktopRequests.push(request);
        const next = desktopReplies.shift() || "confirmed";
        return next === "confirmed" ? { ok: true, data: null, operationId: "op-desktop", outcome: "confirmed" } : next;
      },
    },
  });
  return {
    state,
    queueMoves: (moves) => fs.writeFileSync(queue, JSON.stringify(moves)),
    run: (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, MAILKEEPER_RTXEXEC_BIN: binary } }),
    runWith: (env, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } }),
    commands: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    moves() { return this.commands().filter((args) => option(args, "operation") === "move"); },
    read: (file) => JSON.parse(fs.readFileSync(path.join(state, file), "utf8")),
    journal: (runId) => undoJournal.read(state, runId),
    // A submitted run as both surfaces hold it, with its journal.
    seedRun(runId, actions) {
      fs.writeFileSync(path.join(state, "runs", `${runId}.json`), JSON.stringify({ runId, actions }));
      store.set(`ws-1-run-${runId}`, { runId, scope: { accounts: ["a"], configPath: "/fixture/shared.toml" }, actions });
      undoJournal.ensure(state, runId);
    },
    desktopUndo: (runId) => desktop.undoRun(workspace, { runId }, { id: 7 }),
    desktopReplies: (replies) => { desktopReplies = replies; },
    desktopRequests,
  };
}
const uncertain = { ok: false, code: "EMAIL_NETWORK_FAILED", operationId: "op-2", outcome: "uncertain" };
const threeActions = [
  { kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }, { kind: "move", account: "a", uid: "2", from: "INBOX", to: "Archive" },
  { kind: "move", account: "a", uid: "3", from: "INBOX", to: "Auto/News" }];

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
  assert.equal(f.moves().length, 2, "an uncertain move is never replayed automatically");
  assert.ok(f.moves().every((args) => option(args, "plugin") === "fixture-plugin" && option(args, "binding") === "binding-a"));
  assert.ok(f.journal("r1"), "apply creates the run's shared undo journal before its first move");

  assert.equal(f.run("submit", "--run-id", "r1", "--outcome", "failed").status, 0);
  const receipt = f.read("outbox/r1.json");
  assert.equal(receipt.actions.length, 200);
  assert.equal(receipt.attempts[0].operationId, "op-2");
});

test("an uncertain CLI undo stays unresolved and a later CLI undo makes no mutation", (t) => {
  const f = fixture(t);
  f.seedRun("r2", threeActions);
  f.queueMoves(["confirmed", uncertain]);
  const first = f.run("undo", "--run-id", "r2");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).skipped, [{ account: "a", from: "Auto/News", to: "INBOX", count: 1,
    code: "EMAIL_NETWORK_FAILED", attempt: { operationId: "op-2", outcome: "uncertain" } }]);
  assert.equal(f.read("runs/r2.json").undoneAt, undefined);
  assert.deepEqual(f.journal("r2").unresolved.map(({ uids, operationId }) => ({ uids, operationId })), [{ uids: ["3"], operationId: "op-2" }]);
  const second = f.run("undo", "--run-id", "r2");
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /MAILKEEPER_UNDO_UNRESOLVED/);
  assert.equal(f.moves().length, 2, "no further mutation");
});

test("a not_started CLI undo chunk is retried and confirmed reversals are not", (t) => {
  const f = fixture(t);
  f.seedRun("r2", threeActions);
  f.queueMoves(["confirmed", { ok: false, code: "EMAIL_OPERATION_CANCELLED", operationId: "op-2", outcome: "not_started" }]);
  assert.equal(f.run("undo", "--run-id", "r2").status, 0);
  assert.deepEqual(f.journal("r2").unresolved, []);
  const second = f.run("undo", "--run-id", "r2");
  assert.equal(JSON.parse(second.stdout).reversed, 1);
  assert.deepEqual([option(f.moves()[2], "from"), option(f.moves()[2], "uids")], ["Auto/News", "3"]);
  assert.ok(f.read("runs/r2.json").undoneAt);
});

test("a CLI killed after dispatching a move leaves it pending, and neither surface replays it", async (t) => {
  const f = fixture(t);
  f.seedRun("r2", threeActions);
  f.queueMoves(["crash"]);
  const crashed = f.run("undo", "--run-id", "r2");
  assert.equal(crashed.signal, "SIGKILL");
  assert.equal(f.journal("r2").pending.length, 1, "the dispatched chunk was recorded before launch");
  const retry = f.run("undo", "--run-id", "r2");
  assert.match(retry.stderr, /MAILKEEPER_UNDO_UNRESOLVED/, "a dead lock holder is no evidence the move did not happen");
  await assert.rejects(f.desktopUndo("r2"), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  assert.equal(f.moves().length, 1); assert.equal(f.desktopRequests.length, 0);
});

test("an uncertain undo on either surface blocks the other", async (t) => {
  const cliFirst = fixture(t);
  cliFirst.seedRun("r2", threeActions);
  cliFirst.queueMoves(["confirmed", uncertain]);
  cliFirst.run("undo", "--run-id", "r2");
  await assert.rejects(cliFirst.desktopUndo("r2"), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  assert.equal(cliFirst.desktopRequests.length, 0);

  const desktopFirst = fixture(t);
  desktopFirst.seedRun("r2", threeActions);
  desktopFirst.desktopReplies(["confirmed", uncertain]);
  await desktopFirst.desktopUndo("r2");
  const cli = desktopFirst.run("undo", "--run-id", "r2");
  assert.match(cli.stderr, /MAILKEEPER_UNDO_UNRESOLVED/);
  assert.equal(desktopFirst.moves().length, 0);
});

test("a confirmed undo on either surface is never redispatched by the other", async (t) => {
  const cliFirst = fixture(t);
  cliFirst.seedRun("r2", threeActions);
  assert.equal(JSON.parse(cliFirst.run("undo", "--run-id", "r2").stdout).reversed, 3);
  assert.equal((await cliFirst.desktopUndo("r2")).reused, true);
  assert.equal(cliFirst.desktopRequests.length, 0);

  const desktopFirst = fixture(t);
  desktopFirst.seedRun("r2", threeActions);
  assert.equal((await desktopFirst.desktopUndo("r2")).reversed, 3);
  // The CLI's own run file still lacks undoneAt: it must reread the journal
  // under the lock rather than trust its earlier copy.
  assert.equal(desktopFirst.read("runs/r2.json").undoneAt, undefined);
  const cli = desktopFirst.run("undo", "--run-id", "r2");
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).reused, true);
  assert.equal(desktopFirst.moves().length, 0);
});

test("a second undo of the same run is refused while one is running, from either surface", async (t) => {
  const f = fixture(t);
  f.seedRun("r2", threeActions);
  fs.writeFileSync(path.join(f.state, "undo", "r2.lock"), JSON.stringify({ pid: process.pid, token: "live-holder" }));
  const result = f.run("undo", "--run-id", "r2");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MAILKEEPER_UNDO_BUSY/);
  await assert.rejects(f.desktopUndo("r2"), { code: "MAILKEEPER_UNDO_BUSY" });
  assert.deepEqual(f.commands(), []); assert.equal(f.desktopRequests.length, 0);
});

test("the CLI refuses a run that predates the journal and points to the app", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, "runs", "old.json"), JSON.stringify({ runId: "old", actions: threeActions }));
  const result = f.run("undo", "--run-id", "old");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MAILKEEPER_UNDO_LEGACY/);
  assert.deepEqual(f.commands(), []);
});

test("missing rtxexec or pre-bridge rules fail safely without launching Himalaya", (t) => {
  const f = fixture(t);
  const missing = f.runWith({ MAILKEEPER_RTXEXEC_BIN: path.join(os.tmpdir(), "no-such-rtxexec") }, "snapshot", "--account", "a");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /\(RTXEXEC_UNAVAILABLE\)\. Install rtxexec 0\.4\.0 or later with `npm install -g @realtimex\/rtxexec@0\.4\.0`/);

  const old = fixture(t, { config: { pluginId: undefined } });
  const stale = old.run("snapshot", "--account", "a");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /predates authenticated email access/);
  assert.deepEqual(old.commands(), []);
});

test("an rtxexec older than 0.4.0 is refused with the install remedy before any host call", (t) => {
  for (const version of ["0.3.0", "0.4", "rtxexec"]) {
    const f = fixture(t);
    const old = f.runWith({ MAILKEEPER_RTXEXEC_BIN: path.join(f.state, "..", "rtxexec"), FAKE_RTXEXEC_VERSION: version }, "snapshot", "--account", "a");
    assert.notEqual(old.status, 0, version);
    assert.match(old.stderr, /\(RTXEXEC_UPGRADE_REQUIRED\)\. Install rtxexec 0\.4\.0 or later with `npm install -g @realtimex\/rtxexec@0\.4\.0`, then run the command again\./);
    assert.deepEqual(f.commands(), []);
  }
  for (const version of ["0.4.0", "0.10.2", "1.0.0"]) {
    const f = fixture(t);
    const current = f.runWith({ MAILKEEPER_RTXEXEC_BIN: path.join(f.state, "..", "rtxexec"), FAKE_RTXEXEC_VERSION: version }, "snapshot", "--account", "a");
    assert.doesNotMatch(current.stderr, /RTXEXEC_UPGRADE_REQUIRED/, version);
    assert.equal(f.commands()[0][0], "himalaya", version);
  }
});
