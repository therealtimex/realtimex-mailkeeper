"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MailKeeperService } = require("../runtime/service");
const undoJournal = require("../skills/mailbox-cleanup/scripts/undo-journal");

function fixture(t, execute, profile = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailkeeper-undo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Map();
  const workspace = { id: 1, slug: "fixture", workingDirectory: dir };
  const requests = [];
  const api = {
    getConfig: () => ({ EMAIL_ACCOUNTS: ["new-selection"], AGENT: "cursor" }),
    getStore: () => ({ get: async (key) => structuredClone(store.get(key)), set: async (key, value) => store.set(key, structuredClone(value)) }),
    workspaces: { get: async () => workspace }, heartbeat: { upsertManagedTask: async () => {} },
    email: {
      getHimalayaTarget: async () => ({ source: "bizops", configPath: "/fixture/bizops.toml" }),
      executeHimalaya: async (request) => { requests.push(request); return execute(request, requests.length); },
    },
  };
  store.set("ws-1-profile", profile);
  const state = path.join(dir, ".mailkeeper");
  return { store, workspace, requests, state, service: new MailKeeperService(api),
    // Every new run records moves through the CLI, which creates the journal.
    receipt: (receipt) => { store.set(`ws-1-run-${receipt.runId}`, receipt); undoJournal.ensure(state, receipt.runId); },
    journal: (runId) => undoJournal.read(state, runId) };
}
const confirmed = (request, n) => ({ ok: true, data: [], operationId: `op-${n}`, outcome: "confirmed" });
const undo = (f, runId) => f.service.undoRun(f.workspace, { runId }, { id: 7 });
const threeActions = () => ({ runId: "r", scope: { accounts: ["a"], configPath: "/fixture/bizops.toml" }, actions: [
  { kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }, { kind: "move", account: "a", uid: "2", from: "INBOX", to: "Archive" },
  { kind: "move", account: "a", uid: "3", from: "INBOX", to: "Auto/News" }] });

test("runtime undo sends every receipt account through the authenticated bridge after selection changes", async (t) => {
  const f = fixture(t, confirmed, { emailBindings: { a: "binding-a" } });
  f.receipt({ runId: "original", scope: { accounts: ["a", "b"], configPath: "/fixture/bizops.toml" }, actions: [
    { kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }, { kind: "move", account: "b", uid: "2", from: "INBOX", to: "Auto/Alerts" }] });
  const result = await undo(f, "original");
  assert.equal(result.reversed, 2); assert.deepEqual(result.skipped, []);
  assert.deepEqual(f.requests, [
    { account: "a", operation: "move", from: "Archive", to: "INBOX", uids: ["1"], bindingId: "binding-a" },
    { account: "b", operation: "move", from: "Auto/Alerts", to: "INBOX", uids: ["2"] },
  ]);
  assert.ok(f.store.get("ws-1-run-original").undoneAt);
  assert.ok(f.journal("original").undoneAt);
  assert.equal((await undo(f, "original")).reused, true);

  f.receipt({ runId: "changed", actions: [{ kind: "move", account: "a", uid: "3", from: "INBOX", to: "Archive" }], scope: { accounts: ["a"], configPath: "/fixture/old.toml" } });
  await assert.rejects(undo(f, "changed"), { code: "MAILKEEPER_TARGET_CHANGED" });
  f.receipt({ runId: "legacy", actions: [{ kind: "move", uid: "4", from: "INBOX", to: "Archive" }] });
  await assert.rejects(undo(f, "legacy"), { code: "MAILKEEPER_UNDO_SCOPE_UNKNOWN" },
    "current selection cannot identify a legacy receipt account");
  assert.equal(f.requests.length, 2, "refused undo must not dispatch another move");
});

test("a reversal whose final validation was lost stays unresolved in the journal and blocks every later undo", async (t) => {
  // The server moved UID 3 back, but final validation was lost: the host
  // reports the admitted operation as uncertain.
  const f = fixture(t, (request, n) => request.from === "Auto/News"
    ? { ok: false, code: "EMAIL_CONTEXT_UNAVAILABLE", operationId: `op-${n}`, outcome: "uncertain" } : confirmed(request, n));
  f.receipt(threeActions());
  const first = await undo(f, "r");
  assert.equal(first.reversed, 2);
  assert.equal(first.skipped[0].attempt.outcome, "uncertain");
  assert.equal(f.store.get("ws-1-run-r").undoneAt, undefined);
  assert.deepEqual(f.journal("r").unresolved.map(({ uids, operationId }) => ({ uids, operationId })), [{ uids: ["3"], operationId: "op-2" }]);
  await assert.rejects(undo(f, "r"), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  assert.equal(f.requests.length, 2, "a human retry is not reconciliation: no further mutation");
});

test("proven not_started work is retried, confirmed reversals never are", async (t) => {
  let refuse = true;
  const f = fixture(t, (request, n) => refuse && request.from === "Auto/News"
    ? { ok: false, code: "EMAIL_OPERATION_CANCELLED", operationId: `op-${n}`, outcome: "not_started" } : confirmed(request, n));
  f.receipt(threeActions());
  assert.equal((await undo(f, "r")).reversed, 2);
  assert.deepEqual(f.journal("r").unresolved, []);
  refuse = false;
  assert.equal((await undo(f, "r")).reversed, 1);
  assert.deepEqual(f.requests.slice(2), [{ account: "a", operation: "move", from: "Auto/News", to: "INBOX", uids: ["3"] }]);
  assert.ok(f.store.get("ws-1-run-r").undoneAt);
});

test("absent, empty or malformed mutation replies are uncertain; a typed refusal is not_started", async (t) => {
  for (const reply of [undefined, null, {}, { ok: true, data: null }, { ok: false }]) {
    const f = fixture(t, (request) => request.from === "Auto/News" ? reply : confirmed(request, 1));
    f.receipt(threeActions());
    await undo(f, "r");
    assert.equal(f.journal("r").unresolved.length, 1, JSON.stringify(reply));
    await assert.rejects(undo(f, "r"), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  }
  const refused = fixture(t, (request) => request.from === "Auto/News" ? { ok: false, code: "EMAIL_AUTH_FAILED" } : confirmed(request, 1));
  refused.receipt(threeActions());
  await undo(refused, "r");
  assert.deepEqual(refused.journal("r").unresolved, [], "a refusal before admission launched nothing");
});

test("overlapping undo requests for one run cannot both dispatch", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, async (request, n) => { await gate; return confirmed(request, n); });
  f.receipt(threeActions());
  const first = undo(f, "r");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(undo(f, "r"), { code: "MAILKEEPER_UNDO_BUSY" });
  release();
  assert.equal((await first).reversed, 3);
  assert.equal(f.requests.length, 2);
});

test("a crash after dispatch leaves the chunk pending, and restart never replays it", async (t) => {
  const f = fixture(t, confirmed);
  f.receipt(threeActions());
  // A previous process recorded the chunk pending, dispatched, then died
  // before storing the outcome; its lock file names a dead process.
  const journal = f.journal("r");
  journal.pending.push({ attemptId: "dead", account: "a", from: "Auto/News", to: "INBOX", uids: ["3"], at: "2026-01-01T00:00:00Z" });
  fs.writeFileSync(path.join(f.state, "undo", "r.json"), JSON.stringify(journal));
  fs.writeFileSync(path.join(f.state, "undo", "r.lock"), "999999999");
  await assert.rejects(undo(f, "r"), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  assert.equal(f.requests.length, 0);
});

test("a run that predates the journal is adopted without replaying a recorded completion", async (t) => {
  const f = fixture(t, confirmed);
  f.store.set("ws-1-run-old", { ...threeActions(), runId: "old" });
  fs.mkdirSync(path.join(f.state, "runs"), { recursive: true });
  fs.writeFileSync(path.join(f.state, "runs", "old.json"), JSON.stringify({ runId: "old", actions: [], undoneAt: "2026-01-01T00:00:00Z" }));
  const result = await undo(f, "old");
  assert.equal(result.reused, true); assert.equal(f.requests.length, 0);
  assert.equal(f.journal("old").undoneAt, "2026-01-01T00:00:00Z");

  f.store.set("ws-1-run-fresh", { ...threeActions(), runId: "fresh" });
  assert.equal((await undo(f, "fresh")).reversed, 3, "the desktop adopts a pre-journal run it can see both records of");
});

test("undo fails fast when the host has no authenticated email runner", async (t) => {
  const f = fixture(t, confirmed);
  delete f.service.api.email.executeHimalaya;
  f.receipt({ runId: "x", scope: { accounts: ["a"] }, actions: [{ kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }] });
  await assert.rejects(undo(f, "x"), { code: "HOST_UNSUPPORTED" });
});

test("the journal treats a dispatch failure without a proven outcome as uncertain", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "mailkeeper-journal-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  undoJournal.ensure(state, "j");
  const actions = [{ account: "a", uid: "1", from: "INBOX", to: "Archive" }];
  const result = await undoJournal.reverse({ stateDir: state, runId: "j", actions, dispatch: async () => { throw new Error("transport"); } });
  assert.equal(result.skipped[0].attempt.outcome, "uncertain");
  assert.equal(undoJournal.read(state, "j").unresolved.length, 1);
  let dispatched = false;
  await assert.rejects(undoJournal.reverse({ stateDir: state, runId: "j", actions, dispatch: async () => { dispatched = true; } }),
    { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  assert.equal(dispatched, false);
});
