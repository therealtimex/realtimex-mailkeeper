"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const mailbox = require("../runtime/mailbox");
const { hostFor } = require("../runtime/host");

const emailFor = (executeHimalaya) => hostFor({ workspaces: { get: async () => null }, heartbeat: { upsertManagedTask: async () => {} },
  email: { getHimalayaTarget: async () => ({}), ...(executeHimalaya ? { executeHimalaya } : {}) } }).email;

test("connection checks keep the host's classified failure instead of collapsing it", async () => {
  for (const [hostCode, code] of [["EMAIL_AUTH_FAILED", "AUTH_FAILED"], ["EMAIL_CONTEXT_UNAVAILABLE", "CONTEXT_REQUIRED"],
    ["SECRET_SCOPE_DENIED", "CREDENTIAL_SCOPE_DENIED"], ["EMAIL_BINARY_UNAVAILABLE", "CLI_MISSING"]]) {
    const probe = await mailbox.checkAccount("fixture", { email: emailFor(async () => ({ ok: false, code: hostCode })) });
    assert.equal(probe.ok, false); assert.equal(probe.code, code, hostCode);
  }
  const unsupported = await mailbox.checkAccount("fixture", { email: emailFor(null) });
  assert.equal(unsupported.code, "HOST_UNSUPPORTED");
  const ready = await mailbox.checkAccount("fixture", { email: emailFor(async () => ({ ok: true, data: [{ name: "INBOX" }] })) });
  assert.deepEqual(ready, { ok: true, folders: ["INBOX"] });
});

test("an interrupted chunked move reports confirmed chunks and the failed attempt", async () => {
  const uids = Array.from({ length: 201 }, (_, i) => String(i + 1));
  const requests = [];
  const email = emailFor(async (request) => {
    requests.push(request);
    return requests.length === 1 ? { ok: true, data: null, operationId: "op-1", outcome: "confirmed" }
      : { ok: false, code: "EMAIL_OPERATION_CANCELLED", operationId: "op-2", outcome: "not_started" };
  });
  const result = await mailbox.undoActions("fixture", uids.map((uid) => ({ kind: "move", uid, from: "INBOX", to: "Archive" })), { email });
  assert.equal(result.reversed, 200);
  assert.deepEqual(result.skipped, [{ from: "Archive", to: "INBOX", uids: ["201"], code: "CONNECTION_FAILED",
    error: "Check the connection and provider settings, then retry.",
    attempt: { from: "Archive", to: "INBOX", uids: ["201"], operationId: "op-2", outcome: "not_started" } }]);
});

test("a thrown host failure leaves a move's outcome uncertain", async () => {
  const email = emailFor(async () => { throw new Error("transport"); });
  await assert.rejects(mailbox.move("fixture", ["1"], { to: "Archive", email }),
    (error) => error.code === "CONNECTION_FAILED" && error.attempt.outcome === "uncertain" && error.completed.length === 0);
});
