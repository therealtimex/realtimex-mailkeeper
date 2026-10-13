"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { hostFor, hasPublicApi } = require("../runtime/host");

function publicApi() {
  return {
    pluginId: "com.realtimex.mailkeeper",
    workspaces: { get: async () => null, listEnabledForPlugin: async () => [], ensureThread: async () => ({}) },
    heartbeat: { readSettings: async () => ({}), upsertManagedTask: async () => ({}), removeManagedTask: async () => ({}) },
  };
}

test("uses the public SDK namespaces", () => {
  const api = publicApi();
  assert.equal(hasPublicApi(api), true);
  const host = hostFor(api);
  assert.equal(host.backend, "public");
  assert.equal(host.workspaces, api.workspaces);
  assert.equal(host.heartbeat, api.heartbeat);
});

test("a host without the public APIs reports one coded error", () => {
  assert.throws(() => hostFor({ pluginId: "com.realtimex.mailkeeper" }), { code: "MAILKEEPER_HOST_CAPABILITY_MISSING" });
  const partial = publicApi();
  delete partial.workspaces.ensureThread;
  assert.equal(hasPublicApi(partial), false);
  assert.throws(() => hostFor(partial), { code: "MAILKEEPER_HOST_CAPABILITY_MISSING" });
});

test("no plugin file reaches into server internals", () => {
  const root = path.join(__dirname, "..");
  const files = ["index.js", ...fs.readdirSync(path.join(root, "runtime")).map((f) => `runtime/${f}`)];
  const skill = path.join(root, "skills", "mailbox-cleanup", "scripts");
  files.push(...fs.readdirSync(skill).map((f) => `skills/mailbox-cleanup/scripts/${f}`));
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(/require\(\s*["']@\//.test(source), false, `${file} requires a server-internal module`);
  }
});
