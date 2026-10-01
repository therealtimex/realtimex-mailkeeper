"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MailKeeperService } = require("../runtime/service");
const mailbox = require("../runtime/mailbox");

function fixture(t, initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailkeeper-onboarding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = { id: 1, slug: "fixture-mail", workingDirectory: dir };
  let config = { EMAIL_ACCOUNTS: ["fixture"], AGENT: "cursor", ...initial };
  let target = { configPath: path.join(dir, "email.toml"), revision: "test", source: "fixture" };
  const storeData = new Map();
  let task = null;
  const threads = new Map();
  const api = {
    pluginId: "test-install-id", getConfig: () => structuredClone(config),
    updateConfig: async (patch) => { config = { ...config, ...patch }; },
    email: { getHimalayaTarget: async () => ({ ...target }) },
    getStore: () => ({ get: async (key) => structuredClone(storeData.get(key)), set: async (key, value) => storeData.set(key, structuredClone(value)) }),
    workspaces: { get: async () => workspace, listEnabledForPlugin: async () => [workspace],
      ensureThread: async (_, { key, name }) => { const thread = threads.get(key) || { id: 2, slug: key, name }; threads.set(key, thread); return thread; },
      getThread: async (_, { slug }) => threads.get(slug) || null },
    heartbeat: { readSettings: async () => ({ enabled: true }), removeManagedTask: async () => { task = null; },
      upsertManagedTask: async (_, value) => { task = value; return {}; }, getManagedTaskStatus: async () => task ? { exists: true, interval: task.interval, paused: task.interval === "disabled" } : { exists: false } },
    onboarding: { dispatchPreview: async () => ({ terminalDispatchAccepted: true }) },
  };
  const service = new MailKeeperService(api);
  const original = mailbox.checkAccount;
  mailbox.checkAccount = async () => ({ ok: true, folders: ["INBOX", "Archive"] });
  t.after(() => { mailbox.checkAccount = original; });
  return { api, service, workspace, storeData, threads, setTarget: (next) => { target = next; }, task: () => task,
    ready: async () => { await service.beginSetup(workspace); await service.setupJobs.get(workspace.id)?.promise; return service.setupStatus(workspace); } };
}

test("new setup verifies resources and creates a disabled task", async (t) => {
  const f = fixture(t); const status = await f.ready();
  assert.equal(status.state, "ready"); assert.equal(f.task().interval, "disabled");
  assert.equal(f.api.getConfig().MAINTENANCE_ENABLED, false);
  assert.ok(fs.existsSync(path.join(f.workspace.workingDirectory, "MAILBOX.md")));
});
test("status is cached and does not probe a mailbox", async (t) => {
  const f = fixture(t); mailbox.checkAccount = async () => { throw Error("must not probe"); };
  assert.equal((await f.service.setupStatus(f.workspace)).state, "needs_setup");
});
test("duplicate checks reuse the durable operation", async (t) => {
  const f = fixture(t); let release;
  mailbox.checkAccount = () => new Promise((resolve) => { release = resolve; });
  const first = await f.service.beginSetup(f.workspace);
  const second = await f.service.beginSetup(f.workspace);
  assert.equal(first.operationId, second.operationId); assert.equal(second.reused, true);
  release({ ok: true, folders: ["INBOX"] }); await f.service.setupJobs.get(1).promise;
});
test("each selected account must pass verification", async (t) => {
  const f = fixture(t, { EMAIL_ACCOUNTS: ["good", "bad"] });
  mailbox.checkAccount = async (name) => name === "good" ? { ok: true, folders: ["INBOX"] } : { ok: false, code: "AUTH_FAILED", error: "Review authentication." };
  const status = await f.ready(); assert.equal(status.state, "needs_repair"); assert.equal(f.task(), null);
  assert.equal(status.accountChecks.good.ok, true); assert.equal(status.blockers[0].code, "AUTH_FAILED");
});
test("disable during verification suppresses stale preparation", async (t) => {
  const f = fixture(t); let release;
  mailbox.checkAccount = () => new Promise((resolve) => { release = resolve; });
  await f.service.beginSetup(f.workspace); const job = f.service.setupJobs.get(1).promise;
  await f.service.disable(f.workspace); release({ ok: true, folders: ["INBOX"] }); await job;
  assert.equal((await f.service.setupStatus(f.workspace)).state, "disabled"); assert.equal(f.task(), null);
});
test("configuration change during check fails closed", async (t) => {
  const f = fixture(t); let release;
  mailbox.checkAccount = () => new Promise((resolve) => { release = resolve; });
  await f.service.beginSetup(f.workspace); const job = f.service.setupJobs.get(1).promise;
  await f.api.updateConfig({ EMAIL_ACCOUNTS: ["another"] }); release({ ok: true, folders: ["INBOX"] }); await job;
  assert.equal((await f.service.setupStatus(f.workspace)).state, "needs_repair"); assert.equal(f.task(), null);
});
test("target change invalidates cached readiness", async (t) => {
  const f = fixture(t); await f.ready(); f.setTarget({ revision: "changed", configPath: "new.toml" });
  assert.equal((await f.service.setupStatus(f.workspace)).state, "needs_repair");
});
test("preparation preserves human policy and reuses maintenance thread", async (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.workspace.workingDirectory, "MAILBOX.md"), "human policy");
  await f.ready(); await f.ready();
  assert.equal(fs.readFileSync(path.join(f.workspace.workingDirectory, "MAILBOX.md"), "utf8"), "human policy"); assert.equal(f.threads.size, 1);
});
test("unreadable rules fail without overwriting them", async (t) => {
  const f = fixture(t); fs.mkdirSync(path.join(f.workspace.workingDirectory, ".mailkeeper"));
  const file = path.join(f.workspace.workingDirectory, ".mailkeeper", "rules.json"); fs.writeFileSync(file, "broken JSON");
  assert.equal((await f.ready()).state, "needs_repair"); assert.equal(fs.readFileSync(file, "utf8"), "broken JSON");
});
test("legacy enabled task intent and actual cadence migrate once", async (t) => {
  const f = fixture(t); await f.api.heartbeat.upsertManagedTask(f.workspace, { interval: "4h" });
  await f.api.getStore().set("ws-1-profile", { state: "ready", taskId: "mailkeeper-maintenance-1" });
  await f.ready(); assert.equal(f.api.getConfig().MAINTENANCE_ENABLED, true); assert.equal(f.task().interval, "4h");
  await f.api.updateConfig({ MAINTENANCE_ENABLED: false }); await f.ready(); assert.equal(f.task().interval, "disabled");
});
test("legacy conflict asks for human scheduling choice", async (t) => {
  const f = fixture(t); await f.api.heartbeat.upsertManagedTask(f.workspace, { interval: "4h" });
  await assert.rejects(f.service.beginSetup(f.workspace), { code: "SCHEDULE_CONFLICT" });
  assert.equal(f.task().interval, "4h");
});
test("preview never changes configured mode or schedule and duplicates attach", async (t) => {
  const f = fixture(t, { MODE: "archive-promoted", DEFAULT_MODE_CEILING: "archive-promoted" }); await f.ready();
  const first = await f.service.preview(f.workspace, {}); const second = await f.service.preview(f.workspace, {});
  assert.equal(first.runId, second.runId); assert.equal(f.api.getConfig().MODE, "archive-promoted"); assert.equal(f.task().interval, "disabled");
});
test("preview rejects mutation and partial success receipts", async (t) => {
  const f = fixture(t); await f.ready(); const { runId } = await f.service.preview(f.workspace, {});
  await assert.rejects(f.service.submitRun(f.workspace, { runId, mode: "report-only", outcome: "completed", actions: [{ dryRun: false }] }), { code: "PREVIEW_RECEIPT_INVALID" });
  await assert.rejects(f.service.submitRun(f.workspace, { runId, mode: "report-only", outcome: "completed", actions: [], accountOutcomes: [] }), { code: "PREVIEW_RECEIPT_INVALID" });
  await f.service.submitRun(f.workspace, { runId, mode: "report-only", outcome: "completed", actions: [], snapshot: { checked: 0 }, accountOutcomes: [{ account: "fixture", outcome: "completed" }] });
  assert.equal((await f.service.setupStatus(f.workspace)).preview.actualChanges, 0);
});
test("late unrelated receipt does not release active preview", async (t) => {
  const f = fixture(t); await f.ready(); const { runId } = await f.service.preview(f.workspace, {});
  await f.service.submitRun(f.workspace, { runId: "older-run", outcome: "completed", actions: [] });
  assert.equal((await f.service.setupStatus(f.workspace)).preview.runId, runId);
});
test("preview ceiling survives restart and a changed last-preview pointer", async (t) => {
  const f = fixture(t); await f.ready(); const { runId } = await f.service.preview(f.workspace, {});
  await f.api.getStore().set("ws-1-active", null);
  await f.api.getStore().set("ws-1-profile", { ...await f.api.getStore().get("ws-1-profile"), previewRunId: "newer-preview" });
  const restarted = new MailKeeperService(f.api);
  await assert.rejects(restarted.submitRun(f.workspace, { runId, mode: "archive-promoted", outcome: "completed", actions: [] }), { code: "PREVIEW_RECEIPT_INVALID" });
  await assert.rejects(restarted.submitRun(f.workspace, { runId, mode: "report-only", outcome: "completed", accountOutcomes: [], actions: [] }), { code: "PREVIEW_RECEIPT_INVALID" });
});
test("preview does not attach to active scheduled maintenance", async (t) => {
  const f = fixture(t); await f.ready(); await f.api.getStore().set("ws-1-active", { runId: "maintenance", kind: "maintenance" });
  await assert.rejects(f.service.preview(f.workspace, {}), { code: "RUN_BUSY" });
});
test("ingesting an interrupted preview receipt releases its reservation for a deliberate retry", async (t) => {
  const f = fixture(t); await f.ready(); const { runId } = await f.service.preview(f.workspace, {});
  const outbox = path.join(f.workspace.workingDirectory, ".mailkeeper", "outbox"); fs.mkdirSync(outbox);
  fs.writeFileSync(path.join(outbox, `${runId}.json`), JSON.stringify({ runId, kind: "onboarding-preview", outcome: "failed", mode: "report-only",
    actions: [], proposals: [], urgent: [], accountOutcomes: [{ account: "fixture", outcome: "failed", code: "PREVIEW_INTERRUPTED" }] }));
  const status = await f.service.setupStatus(f.workspace);
  assert.equal(status.preview.runId, runId); assert.equal(status.preview.outcome, "failed");
  assert.equal(f.storeData.get("ws-1-active"), null);
  const retry = await f.service.preview(f.workspace, {}); assert.notEqual(retry.runId, runId);
});
test("setup config refuses global settings and schedule from AI", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.configureSetup(f.workspace, { DEFAULT_MODE_CEILING: "archive-promoted" }), { code: "SETUP_CONFIG_INVALID" });
  await assert.rejects(f.service.configureSetup(f.workspace, { MAINTENANCE_ENABLED: true }), { code: "SETUP_CONFIG_INVALID" });
});
test("heartbeat admission requires readiness and explicit schedule", async (t) => {
  const f = fixture(t); await f.ready(); assert.equal((await f.service.admitHeartbeat({ workspace: { id: 1 } })).skipLaunch, true);
  await f.service.setSchedule(f.workspace, { enabled: true, cadence: "1d" }, { id: 1 }); await f.service.setupJobs.get(1)?.promise;
  assert.ok((await f.service.admitHeartbeat({ workspace: { id: 1 } })).mailkeeperRunId);
});
test("error classifier reads chains and omits private stderr", () => {
  const error = mailbox.classifyError({ stderr: "Error: genericError\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n private-user@test.local token" });
  assert.equal(error.code, "CREDENTIAL_MISSING"); assert.equal(JSON.stringify(error).includes("private-user"), false);
  assert.equal(mailbox.classifyError({ stderr: "Error: genericError\n DNS TLS timeout" }).code, "CONNECTION_FAILED");
  assert.equal(mailbox.classifyError({ code: "ENOENT" }).code, "CLI_MISSING");
});
