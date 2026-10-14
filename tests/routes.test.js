"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mk-routes-"));
const himalayaConfig = path.join(sandbox, "config.toml");
fs.writeFileSync(himalayaConfig, "# test\n");
fs.writeFileSync(path.join(sandbox, "mailbox.json"), JSON.stringify({ accounts: { work: { credential: { kind: "native" }, folders: { INBOX: [] } } } }));
process.env.MAILKEEPER_HIMALAYA_BIN = path.join(__dirname, "fixtures", "fake-himalaya.js");
process.env.FAKE_MAILBOX = path.join(sandbox, "mailbox.json");
process.env.HIMALAYA_CONFIG = himalayaConfig;

// The host provides @realtimex/plugin-sdk at runtime; tests use the bare definition.
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "@realtimex/plugin-sdk") return { definePlugin: (definition) => definition };
  return originalLoad.call(this, request, ...rest);
};
const plugin = require("../index.js");
Module._load = originalLoad;

function harness() {
  const workspace = { id: 7, slug: "mail", name: "Mail", workingDirectory: fs.mkdtempSync(path.join(sandbox, "ws-")) };
  const store = new Map([
    ["ws-7-rules", { schemaVersion: 2, revision: 1, promoted: [{ id: "keep", account: "work", pass: "no-reply", query: "q", action: "a" }], proposed: [{ id: "r1", account: "work", pass: "no-reply", query: "q2", action: "a2" }] }],
  ]);
  const effects = { writes: 0, heartbeat: 0 };
  const routes = new Map();
  const api = {
    pluginId: "com.realtimex.mailkeeper",
    getConfig: () => ({ EMAIL_ACCOUNTS: ["work"], AGENT: "codex", MODE: "label-only", DEFAULT_MODE_CEILING: "label-only", CADENCE: "1d", AGGRESSIVENESS: "conservative", AGE_THRESHOLD_DAYS: 90 }),
    getStore: () => ({
      get: async (key) => (store.has(key) ? structuredClone(store.get(key)) : null),
      set: async (key, value) => {
        effects.writes += 1;
        store.set(key, structuredClone(value));
      },
    }),
    log: { info() {}, warn() {}, error() {} },
    registerRoute: (method, routePath, handler) => routes.set(`${method} ${routePath}`, handler),
    registerWorkspaceSkillProvider: () => {},
    workspaces: {
      get: async () => workspace,
      listEnabledForPlugin: async () => [workspace],
      ensureThread: async () => ({ id: 1, slug: "t", name: "MailKeeper maintenance" }),
    },
    heartbeat: {
      readSettings: async () => ({ enabled: true }),
      upsertManagedTask: async () => {
        effects.heartbeat += 1;
        return { changed: true, explicitlyPaused: false };
      },
      removeManagedTask: async () => {
        effects.heartbeat += 1;
        return { changed: true };
      },
    },
  };
  plugin.register(api);
  const call = async (key, { locals = {}, body = {}, headers = {}, terminalSession } = {}) => {
    const response = {
      locals,
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    const request = { body: { workspaceSlug: "mail", ...body }, query: {}, headers, ...(terminalSession ? { terminalSession } : {}) };
    await routes.get(key)(request, response);
    return response;
  };
  return { call, store, effects };
}

const verified = { user: { id: 7 }, authActor: { kind: "human", id: "7", source: "trusted-loopback-token", interactiveHuman: true } };
const refused = {
  "app-id caller (no user, no actor)": {},
  "terminal request carrying a real user": {
    locals: { user: { id: 7 }, authActor: { kind: "human", id: "7", source: "terminal_session", interactiveHuman: false } },
    terminalSession: { context: { workspaceSlug: "mail" } },
  },
  "user without an actor": { locals: { user: { id: 7 } } },
  "actor not interactive": { locals: { user: { id: 7 }, authActor: { kind: "human", id: "7", source: "bearer", interactiveHuman: false } } },
  "actor for another user": { locals: { user: { id: 7 }, authActor: { kind: "human", id: "8", source: "trusted-loopback-token", interactiveHuman: true } } },
  "spoofed actor in body and header": {
    locals: { user: { id: 7 } },
    body: { authActor: { kind: "human", id: "7", interactiveHuman: true }, interactiveHuman: true, confirmed: true },
    headers: { "x-interactive-human": "true" },
  },
  "local guest": { locals: { ...verified, localGuestMode: true } },
};

for (const route of ["POST /rules/promote", "POST /rules/demote", "POST /repair"]) {
  for (const [name, caller] of Object.entries(refused)) {
    test(`${route} refuses ${name} without side effects`, async () => {
      const { call, store, effects } = harness();
      const before = JSON.stringify([...store]);
      const response = await call(route, { ...caller, body: { ruleId: route.endsWith("promote") ? "r1" : "keep", ...(caller.body || {}) } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.code, "MAILKEEPER_HUMAN_REQUIRED");
      assert.deepEqual(effects, { writes: 0, heartbeat: 0 });
      assert.equal(JSON.stringify([...store]), before);
    });
  }
}

test("a verified interactive person can promote, demote and repair", async () => {
  const { call, store, effects } = harness();
  const promoted = await call("POST /rules/promote", { locals: verified, body: { ruleId: "r1" } });
  assert.equal(promoted.statusCode, 200, JSON.stringify(promoted.body));
  assert.equal(store.get("ws-7-rules").promoted.find((rule) => rule.id === "r1").promotedBy, "7");

  const demoted = await call("POST /rules/demote", { locals: verified, body: { ruleId: "r1" } });
  assert.equal(demoted.statusCode, 200);
  assert.equal(store.get("ws-7-rules").proposed.find((rule) => rule.id === "r1").demotedBy, "7");

  const repaired = await call("POST /repair", { locals: verified });
  assert.equal(repaired.statusCode, 200);
  assert.ok(effects.heartbeat > 0);
});

test("agent-facing routes keep their scoped access", async () => {
  const { call } = harness();
  const status = await call("GET /status", { locals: {} });
  assert.equal(status.statusCode, 200);
  const runs = await call("POST /runs", { locals: {}, body: { runId: "r-agent", outcome: "completed" } });
  assert.equal(runs.statusCode, 200);
});
