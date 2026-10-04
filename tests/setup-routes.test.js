"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const mailbox = require("../runtime/mailbox");
const { MailKeeperService } = require("../runtime/service");
const originalLoad = Module._load;
let plugin;
try {
  Module._load = function (name, ...args) { return name === "@realtimex/plugin-sdk" ? { definePlugin: (definition) => definition } : originalLoad.call(this, name, ...args); };
  plugin = require("../index");
} finally { Module._load = originalLoad; }

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailkeeper-route-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = { id: 1, slug: "fictional", workingDirectory: dir };
  const data = new Map(), routes = new Map(), references = [];
  let task = null;
  const api = {
    pluginId: "installed", getConfig: () => ({ EMAIL_ACCOUNTS: ["working", "failed"], AGENT: "cursor", MAINTENANCE_ENABLED: false }),
    email: { getHimalayaTarget: async () => ({ revision: "fixture", configPath: "/fictional/config.toml" }),
      getCredentialReference: async (account) => { references.push(account); return { supported: true, route: "keychain-access", service: "fictional-service", account: "fictional@example.test" }; } },
    getStore: () => ({ get: async (key) => structuredClone(data.get(key)), set: async (key, value) => data.set(key, structuredClone(value)) }),
    workspaces: { get: async () => workspace, listEnabledForPlugin: async () => [workspace], ensureThread: async () => ({ id: 2, slug: "maintenance" }), getThread: async () => ({ id: 2, slug: "maintenance" }) },
    heartbeat: { upsertManagedTask: async (_, value) => { task = value; return {}; }, removeManagedTask: async () => { task = null; }, getManagedTaskStatus: async () => task ? { exists: true, interval: task.interval } : { exists: false }, readSettings: async () => ({ enabled: true }) },
    registerRoute: (method, route, handler) => routes.set(method + " " + route, handler), registerWorkspaceSkillProvider: () => {},
  };
  plugin.register(api);
  const probe = mailbox.checkAccount;
  mailbox.checkAccount = async () => ({ ok: true, folders: ["INBOX"] });
  t.after(() => { mailbox.checkAccount = probe; });
  const service = new MailKeeperService(api);
  const invoke = async (method, route, { actionId, surface = "workspace-plugin-editor", threadSlug = null, payload = {} } = {}) => {
    const response = { statusCode: 200, locals: { user: { id: 1 } }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await routes.get(method + " " + route)({ pluginContext: { actionId, surface, scope: { workspaceSlug: "fictional", threadSlug } }, body: { payload } }, response);
    return response;
  };
  return { service, workspace, data, references, invoke };
}

test("credential guidance validates the selected failed account before reading its reference", async (t) => {
  const f = fixture(t);
  f.data.set("ws-1-profile", { schemaVersion: 1, state: "needs_repair", blockers: [{ accountRef: "failed", code: "AUTH_FAILED" }], accountChecks: { working: { ok: true }, failed: { ok: false } } });
  for (const [accountRef, status] of [["unselected", 400], ["working", 409]])
    assert.equal((await f.invoke("POST", "/setup/action", { actionId: "credential", payload: { accountRef } })).statusCode, status);
  assert.deepEqual(f.references, []);
  const result = await f.invoke("POST", "/setup/action", { actionId: "credential", payload: { accountRef: "failed" } });
  assert.equal(result.statusCode, 200); assert.deepEqual(f.references, ["failed"]);
  assert.deepEqual(result.body.dialog.actions[0].payload, { accountRef: "failed" });
  assert.equal(result.body.dialog.fields, undefined);
  assert.equal(f.data.get("ws-1-profile").state, "needs_repair");
  mailbox.checkAccount = async (name) => name === "working" ? { ok: true, folders: ["INBOX"] } : { ok: false, code: "AUTH_FAILED", error: "Authentication failed." };
  await f.invoke("POST", "/setup/action", { actionId: "check", payload: { accountRef: "failed" } });
  // The contribution and helper services share the same durable profile.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.data.get("ws-1-profile").state, "needs_repair");
  assert.deepEqual(f.references, ["failed"]);
});

test("first usage appears without receipts and foreign threads cannot access or invoke it", async (t) => {
  const f = fixture(t);
  await f.service.beginSetup(f.workspace); await f.service.setupJobs.get(1).promise;
  const own = await f.invoke("GET", "/setup/receipts", { surface: "chat-history", threadSlug: "maintenance" });
  assert.equal(own.body.items.length, 1);
  assert.equal(own.body.items[0].id, "mailkeeper-usage");
  assert.ok(own.body.items[0].actions.find((action) => action.id === "preview").confirmation);
  assert.deepEqual((await f.invoke("GET", "/setup/receipts", { surface: "chat-history", threadSlug: "foreign" })).body.items, []);
  assert.equal((await f.invoke("POST", "/setup/action", { actionId: "preview", surface: "chat-history", threadSlug: "foreign" })).statusCode, 403);
  assert.equal(f.data.get("ws-1-active"), undefined);
});

test("setup entry only saves non-secret continuation and opens the bound declared editor", async (t) => {
  const f = fixture(t);
  const result = await f.invoke("POST", "/setup/action", { actionId: "setup", surface: "workspace-plugin-card" });
  assert.deepEqual(result.body.navigation, { kind: "ai-editor", fieldKey: "MAILKEEPER_SETUP_FILE" });
  assert.deepEqual(f.data.get("ws-1-profile"), { setupStarted: true });
  assert.deepEqual(f.references, []);
});

test("a Login is selected only from the setup editor surface, as non-secret facts", async (t) => {
  const f = fixture(t);
  const selection = { id: "login-1", reference: "secret://work#password", passwordField: "password" };
  f.service.api.email.getLoginChoices = async () => [{ ...selection, email: "person@example.test", displayName: "Work", providerHint: "gmail" }];
  const card = await f.invoke("POST", "/setup/action", { actionId: "select-login", surface: "workspace-plugin-card", payload: { selection } });
  assert.equal(card.statusCode, 400);
  const editor = await f.invoke("POST", "/setup/action", { actionId: "select-login", payload: { selection } });
  assert.equal(editor.statusCode, 200);
  assert.deepEqual(editor.body, { ok: true, selected: true, email: "person@example.test", providerHint: "gmail" });
  assert.equal(f.data.get("ws-1-profile").emailLoginSelections["login-1"].email, "person@example.test");
});
