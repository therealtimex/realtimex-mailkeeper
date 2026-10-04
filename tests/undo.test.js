"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MailKeeperService } = require("../runtime/service");

function fixture(execute, profile = {}) {
  const store = new Map();
  const workspace = { id: 1, slug: "fixture" };
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
  return { store, workspace, requests, service: new MailKeeperService(api) };
}
const confirmed = (request, n) => ({ ok: true, data: [], operationId: `op-${n}`, outcome: "confirmed" });

test("runtime undo sends every receipt account through the authenticated bridge after selection changes", async () => {
  const f = fixture(confirmed, { emailBindings: { a: "binding-a" } });
  f.store.set("ws-1-run-original", { runId: "original", scope: { accounts: ["a", "b"], configPath: "/fixture/bizops.toml" }, actions: [
    { kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }, { kind: "move", account: "b", uid: "2", from: "INBOX", to: "Auto/Alerts" }] });
  const result = await f.service.undoRun(f.workspace, { runId: "original" }, { id: 7 });
  assert.equal(result.reversed, 2); assert.deepEqual(result.skipped, []);
  assert.deepEqual(f.requests, [
    { account: "a", operation: "move", from: "Archive", to: "INBOX", uids: ["1"], bindingId: "binding-a" },
    { account: "b", operation: "move", from: "Auto/Alerts", to: "INBOX", uids: ["2"] },
  ]);
  assert.ok(f.store.get("ws-1-run-original").undoneAt);
  assert.equal((await f.service.undoRun(f.workspace, { runId: "original" }, { id: 7 })).reused, true);

  f.store.set("ws-1-run-changed", { actions: [{ kind: "move", account: "a", uid: "3", from: "INBOX", to: "Archive" }], scope: { accounts: ["a"], configPath: "/fixture/old.toml" } });
  await assert.rejects(f.service.undoRun(f.workspace, { runId: "changed" }, { id: 7 }), { code: "MAILKEEPER_TARGET_CHANGED" });
  f.store.set("ws-1-run-legacy", { actions: [{ kind: "move", uid: "4", from: "INBOX", to: "Archive" }] });
  await assert.rejects(f.service.undoRun(f.workspace, { runId: "legacy" }, { id: 7 }), { code: "MAILKEEPER_UNDO_SCOPE_UNKNOWN" },
    "current selection cannot identify a legacy receipt account");
  assert.equal(f.requests.length, 2, "refused undo must not dispatch another move");
});

const threeActions = { runId: "r", scope: { accounts: ["a"], configPath: "/fixture/bizops.toml" }, actions: [
  { kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }, { kind: "move", account: "a", uid: "2", from: "INBOX", to: "Archive" },
  { kind: "move", account: "a", uid: "3", from: "INBOX", to: "Auto/News" }] };

test("a reversal whose final validation was lost stays unresolved and blocks every later undo", async () => {
  // The server moved UID 3 back, but final validation was lost: the host
  // reports the admitted operation as uncertain.
  const f = fixture((request, n) => request.from === "Auto/News"
    ? { ok: false, code: "EMAIL_CONTEXT_UNAVAILABLE", operationId: `op-${n}`, outcome: "uncertain" } : confirmed(request, n));
  f.store.set("ws-1-run-r", structuredClone(threeActions));
  const first = await f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 });
  assert.equal(first.reversed, 2);
  assert.equal(first.skipped[0].attempt.outcome, "uncertain");
  let receipt = f.store.get("ws-1-run-r");
  assert.equal(receipt.undoneAt, undefined);
  assert.deepEqual(receipt.undo.unresolved.map(({ at, ...entry }) => entry),
    [{ account: "a", from: "Auto/News", to: "INBOX", uids: ["3"], operationId: "op-2", outcome: "uncertain" }]);

  await assert.rejects(f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 }), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  assert.equal(f.requests.length, 2, "a human retry is not reconciliation: no further mutation");

  // Trimming the display history never makes unresolved work eligible again.
  receipt = f.store.get("ws-1-run-r");
  receipt.undo.attempts = Array.from({ length: 25 }, (_, i) => ({ at: String(i), reversed: 0, skipped: [] })).slice(-20);
  f.store.set("ws-1-run-r", receipt);
  await assert.rejects(f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 }), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
  assert.equal(f.requests.length, 2);
});

test("proven not_started work is retried, confirmed reversals never are", async () => {
  let refuse = true;
  const f = fixture((request, n) => refuse && request.from === "Auto/News"
    ? { ok: false, code: "EMAIL_OPERATION_CANCELLED", operationId: `op-${n}`, outcome: "not_started" } : confirmed(request, n));
  f.store.set("ws-1-run-r", structuredClone(threeActions));
  const first = await f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 });
  assert.equal(first.reversed, 2);
  assert.deepEqual(f.store.get("ws-1-run-r").undo.unresolved, []);
  refuse = false;
  const second = await f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 });
  assert.equal(second.reversed, 1);
  assert.deepEqual(f.requests.slice(2), [{ account: "a", operation: "move", from: "Auto/News", to: "INBOX", uids: ["3"] }]);
  assert.ok(f.store.get("ws-1-run-r").undoneAt);
});

test("a malformed success reply is uncertain, not a reason to retry", async () => {
  const f = fixture((request) => request.from === "Auto/News" ? { ok: true, data: null } : confirmed(request, 1));
  f.store.set("ws-1-run-r", structuredClone(threeActions));
  await f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 });
  assert.equal(f.store.get("ws-1-run-r").undo.unresolved[0].outcome, "uncertain");
  await assert.rejects(f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 }), { code: "MAILKEEPER_UNDO_UNRESOLVED" });
});

test("overlapping undo requests for one run cannot both dispatch", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(async (request, n) => { await gate; return confirmed(request, n); });
  f.store.set("ws-1-run-r", structuredClone(threeActions));
  const first = f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 }), { code: "MAILKEEPER_UNDO_BUSY" });
  release();
  assert.equal((await first).reversed, 3);
  assert.equal(f.requests.length, 2);
});

test("undo fails fast when the host has no authenticated email runner", async () => {
  const f = fixture(confirmed);
  delete f.service.api.email.executeHimalaya;
  f.store.set("ws-1-run-x", { scope: { accounts: ["a"] }, actions: [{ kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }] });
  await assert.rejects(f.service.undoRun(f.workspace, { runId: "x" }, { id: 7 }), { code: "HOST_UNSUPPORTED" });
});
