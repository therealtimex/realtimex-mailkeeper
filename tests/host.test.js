"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { hostFor, hasPublicApi } = require("../runtime/host");

test("prefers the public SDK namespaces when the host provides them", () => {
  const api = {
    pluginId: "com.realtimex.mailbox",
    workspaces: { get: async () => null, listEnabledForPlugin: async () => [], ensureThread: async () => ({}) },
    heartbeat: { readSettings: async () => ({}), upsertManagedTask: async () => ({}), removeManagedTask: async () => ({}) },
  };
  assert.equal(hasPublicApi(api), true);
  const host = hostFor(api);
  assert.equal(host.backend, "public");
  assert.equal(host.workspaces, api.workspaces);
  assert.equal(host.heartbeat, api.heartbeat);
});

test("falls back to the shim and reports a clear error outside the host", () => {
  const api = { pluginId: "com.realtimex.mailbox" };
  assert.equal(hasPublicApi(api), false);
  // Outside a RealTimeX server process the @/ modules do not resolve; the
  // adapter must surface that as one coded error rather than a raw stack.
  assert.throws(() => hostFor(api), { code: "MAILBOX_HOST_CAPABILITY_MISSING" });
});
