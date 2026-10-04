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

test("an interrupted undo keeps confirmed reversals and the uncertain attempt; a retry sends only the rest", async () => {
  let fail = true;
  const f = fixture((request, n) => fail && request.to === "INBOX" && request.from === "Auto/News"
    ? { ok: false, code: "EMAIL_NETWORK_FAILED", operationId: `op-${n}`, outcome: "uncertain" } : confirmed(request, n));
  f.store.set("ws-1-run-r", { runId: "r", scope: { accounts: ["a"], configPath: "/fixture/bizops.toml" }, actions: [
    { kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }, { kind: "move", account: "a", uid: "2", from: "INBOX", to: "Archive" },
    { kind: "move", account: "a", uid: "3", from: "INBOX", to: "Auto/News" }] });

  const first = await f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 });
  assert.equal(first.reversed, 2);
  assert.deepEqual(first.skipped, [{ account: "a", from: "Auto/News", to: "INBOX", uids: ["3"], code: "CONNECTION_FAILED",
    error: "Check the connection and provider settings, then retry.",
    attempt: { from: "Auto/News", to: "INBOX", uids: ["3"], operationId: "op-2", outcome: "uncertain" } }]);
  const receipt = f.store.get("ws-1-run-r");
  assert.equal(receipt.undoneAt, undefined, "an interrupted undo stays retryable");
  assert.equal(receipt.undo.reversed.length, 2);
  assert.equal(receipt.undo.attempts[0].skipped[0].attempt.operationId, "op-2");

  fail = false;
  const second = await f.service.undoRun(f.workspace, { runId: "r" }, { id: 7 });
  assert.equal(second.reversed, 1); assert.deepEqual(second.skipped, []);
  assert.deepEqual(f.requests.slice(2), [{ account: "a", operation: "move", from: "Auto/News", to: "INBOX", uids: ["3"] }],
    "confirmed reversals are never sent again");
  assert.ok(f.store.get("ws-1-run-r").undoneAt);
  assert.equal(f.store.get("ws-1-run-r").undo.attempts.length, 2);
});

test("undo fails fast when the host has no authenticated email runner", async () => {
  const f = fixture(confirmed);
  delete f.service.api.email.executeHimalaya;
  f.store.set("ws-1-run-x", { scope: { accounts: ["a"] }, actions: [{ kind: "move", account: "a", uid: "1", from: "INBOX", to: "Archive" }] });
  await assert.rejects(f.service.undoRun(f.workspace, { runId: "x" }, { id: 7 }), { code: "HOST_UNSUPPORTED" });
});
