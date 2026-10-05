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
  assert.equal(status.preview, null);
  assert.ok(!status.checklist.some((step) => ["preview", "schedule"].includes(step.id)));
});
test("rules.json gives the CLI this plugin's id and the stored bindings, never a config path", async (t) => {
  const f = fixture(t);
  await f.api.getStore().set("ws-1-profile", { emailBindings: { fixture: "binding-1" } });
  await f.ready();
  const { config } = JSON.parse(fs.readFileSync(path.join(f.workspace.workingDirectory, ".mailkeeper", "rules.json"), "utf8"));
  assert.equal(config.pluginId, "test-install-id");
  assert.deepEqual(config.emailBindings, { fixture: "binding-1" });
  assert.equal("himalayaConfigPath" in config, false);
});
test("status is cached and does not probe a mailbox", async (t) => {
  const f = fixture(t); mailbox.checkAccount = async () => { throw Error("must not probe"); };
  assert.equal((await f.service.setupStatus(f.workspace)).state, "needs_setup");
});
test("inactive projection retains facts without reading the email target or ingesting receipts", async (t) => {
  const f = fixture(t); await f.ready();
  const before = structuredClone([...f.storeData]);
  f.api.email.getHimalayaTarget = async () => { throw Error("must not read target"); };
  f.service.ingestOutbox = async () => { throw Error("must not ingest"); };
  const status = await f.service.setupStatus(f.workspace, { cached: true });
  assert.equal(status.state, "disabled"); assert.equal(status.stale, true);
  assert.equal(status.hostSupported, true); assert.ok(status.threadSlug);
  assert.deepEqual([...f.storeData], before);
});
test("disable and re-enable retain saved schedule intent without resuming execution", async (t) => {
  const f = fixture(t); await f.ready();
  await f.service.setSchedule(f.workspace, { enabled: true, cadence: "3d" }, { id: 1 });
  await f.service.setupJobs.get(1)?.promise;
  assert.equal(f.task().interval, "3d");
  await f.service.disable(f.workspace); assert.equal(f.task(), null);
  await f.ready();
  const status = await f.service.setupStatus(f.workspace);
  assert.equal(status.state, "ready");
  assert.equal(status.schedule.intent, true); assert.equal(status.schedule.cadence, "3d");
  assert.equal(status.schedule.suspendedForRepair, true);
  assert.equal(f.task().interval, "disabled");
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
test("a check without an authenticated caller keeps readiness and the saved schedule", async (t) => {
  const f = fixture(t); await f.ready();
  await f.service.setSchedule(f.workspace, { enabled: true, cadence: "3d" }, { id: 1 });
  await f.service.setupJobs.get(1)?.promise;
  const before = await f.service.setupStatus(f.workspace);
  mailbox.checkAccount = async () => ({ ok: false, code: "CONTEXT_REQUIRED", error: "Open setup." });
  await f.service.activateAll(); await f.service.setupJobs.get(1)?.promise;
  const status = await f.service.setupStatus(f.workspace);
  assert.equal(status.state, "ready"); assert.equal(status.verifiedAt, before.verifiedAt);
  assert.equal(status.schedule.suspendedForRepair, false); assert.equal(f.task().interval, "3d");
  assert.deepEqual(status.blockers, []);
});
test("an observed failure is kept when a later account loses its caller", async (t) => {
  const f = fixture(t, { EMAIL_ACCOUNTS: ["a", "b"] }); await f.ready();
  await f.service.setSchedule(f.workspace, { enabled: true, cadence: "3d" }, { id: 1 });
  await f.service.setupJobs.get(1)?.promise;
  mailbox.checkAccount = async (name) => name === "a"
    ? { ok: false, code: "AUTH_FAILED", error: "Review authentication." }
    : { ok: false, code: "CONTEXT_REQUIRED", error: "Open setup." };
  await f.service.activateAll(); await f.service.setupJobs.get(1)?.promise;
  const status = await f.service.setupStatus(f.workspace);
  assert.equal(status.state, "needs_repair");
  assert.deepEqual(status.blockers.map((entry) => [entry.accountRef, entry.code]), [["a", "AUTH_FAILED"], ["b", "CONTEXT_REQUIRED"]]);
  assert.equal(status.schedule.suspendedForRepair, true); assert.equal(f.task(), null);
});
test("a deferred check never restores over disablement, drift or an existing suspension", async (t) => {
  const deferred = async () => ({ ok: false, code: "CONTEXT_REQUIRED", error: "Open setup." });
  // Disabled while the deferred check is in flight.
  const disabled = fixture(t); await disabled.ready(); let release;
  mailbox.checkAccount = () => new Promise((resolve) => { release = resolve; });
  await disabled.service.activateAll(); const job = disabled.service.setupJobs.get(1).promise;
  await disabled.service.disable(disabled.workspace); release(await deferred()); await job;
  assert.equal((await disabled.service.setupStatus(disabled.workspace)).state, "disabled"); assert.equal(disabled.task(), null);
  // Known drift stays visible.
  const drift = fixture(t); await drift.ready(); drift.setTarget({ revision: "changed", configPath: "new.toml" });
  mailbox.checkAccount = deferred;
  await drift.service.activateAll(); await drift.service.setupJobs.get(1)?.promise;
  assert.equal((await drift.service.setupStatus(drift.workspace)).state, "needs_repair");
  // An existing repair suspension is never cleared.
  const suspended = fixture(t); await suspended.ready();
  await suspended.service.setSchedule(suspended.workspace, { enabled: true, cadence: "3d" }, { id: 1 });
  await suspended.service.setupJobs.get(1)?.promise;
  await suspended.api.getStore().set("ws-1-profile", { ...(await suspended.api.getStore().get("ws-1-profile")), scheduleSuspendedForRepair: true });
  mailbox.checkAccount = deferred;
  await suspended.service.activateAll(); await suspended.service.setupJobs.get(1)?.promise;
  assert.equal((await suspended.service.setupStatus(suspended.workspace)).schedule.suspendedForRepair, true);
});
test("plugin disablement is a real failure, not a deferred startup check", async (t) => {
  const f = fixture(t); await f.ready();
  mailbox.checkAccount = async () => ({ ok: false, code: "PLUGIN_DISABLED", error: "Enable MailKeeper." });
  await f.service.activateAll(); await f.service.setupJobs.get(1)?.promise;
  const status = await f.service.setupStatus(f.workspace);
  assert.equal(status.state, "needs_repair"); assert.equal(status.blockers[0].code, "PLUGIN_DISABLED");
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
test("unchanged setup Apply and cadence-only edits preserve a healthy saved schedule", async (t) => {
  const f = fixture(t, { MAINTENANCE_ENABLED: true, CADENCE: "4h" });
  const before = await f.ready();
  for (const patch of [{ AGENT: "cursor" }, { CADENCE: "12h" }]) {
    await f.service.configureSetup(f.workspace, patch);
    await f.service.setupJobs.get(1)?.promise;
    const status = await f.service.setupStatus(f.workspace);
    assert.equal(status.state, "ready");
    assert.equal(status.schedule.suspendedForRepair, false);
    assert.equal(status.schedule.intent, true);
    assert.equal(status.threadSlug, before.threadSlug);
    assert.equal(status.preview, null);
    assert.equal(f.task().interval, f.api.getConfig().CADENCE);
  }
});
test("error classifier reads chains and omits private stderr", () => {
  const error = mailbox.classifyError({ stderr: "Error: genericError\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n private-user@test.local token" });
  assert.equal(error.code, "CREDENTIAL_MISSING"); assert.equal(JSON.stringify(error).includes("private-user"), false);
  assert.equal(mailbox.classifyError({ stderr: "Error: genericError\n DNS TLS timeout" }).code, "CONNECTION_FAILED");
  assert.equal(mailbox.classifyError({ code: "ENOENT" }).code, "CLI_MISSING");
});

test("blocked launch settles its original receipt and preserves verified connection evidence", async (t) => {
  const f = fixture(t); const before = await f.ready();
  f.api.onboarding.dispatchPreview = async () => ({ terminalDispatchAccepted: false });
  const result = await f.service.preview(f.workspace, {});
  assert.equal(result.accepted, false); assert.equal(result.code, "PREVIEW_DISPATCH_BLOCKED");
  const after = await f.service.setupStatus(f.workspace);
  assert.equal(after.state, "ready"); assert.equal(after.verifiedAt, before.verifiedAt);
  assert.equal(after.preview.runId, result.runId); assert.equal(after.preview.outcome, "blocked");
  assert.equal(after.preview.failureCode, "AGENT_LAUNCH_UNKNOWN"); assert.equal(f.storeData.get("ws-1-active"), null);
  const items = await f.service.previewReceiptItems(f.workspace, after.threadSlug);
  assert.equal(items[0].id, result.runId); assert.equal(items[0].status.code, "blocked");
  assert.equal(items[0].details.find((entry) => entry.id === "changes").value, 0);
  assert.deepEqual(await f.service.previewReceiptItems(f.workspace, "foreign-thread"), []);
  await f.service.disable(f.workspace);
  assert.equal((await f.service.previewReceiptItems(f.workspace, after.threadSlug))[0].id, result.runId);
});
test("known agent failures retain curated recovery and unknown transport attempts remain reserved", async (t) => {
  const f = fixture(t); await f.ready();
  f.api.onboarding.dispatchPreview = async () => { throw Object.assign(new Error("private raw stderr"), { code: "AGENT_UNAVAILABLE", statusCode: 409 }); };
  const blocked = await f.service.preview(f.workspace, {});
  assert.equal(blocked.preview.failureCode, "AGENT_UNAVAILABLE");
  assert.equal(JSON.stringify(blocked).includes("private raw stderr"), false);
  f.api.onboarding.dispatchPreview = async () => { throw Error("uncertain network response"); };
  const pending = await f.service.preview(f.workspace, {});
  assert.equal(pending.uncertain, true);
  assert.equal((await f.service.preview(f.workspace, {})).runId, pending.runId);
  assert.equal((await f.service.setupStatus(f.workspace)).preview.outcome, "pending");
});
test("partial and empty outcomes are distinct and prior preview receipts survive a new attempt", async (t) => {
  const f = fixture(t, { EMAIL_ACCOUNTS: ["a", "b"] }); await f.ready();
  const first = await f.service.preview(f.workspace, {});
  await f.service.submitRun(f.workspace, { runId: first.runId, mode: "report-only", outcome: "failed", snapshot: { checked: 4 }, accountOutcomes: [{ account: "a", outcome: "completed" }, { account: "b", outcome: "failed" }] });
  assert.equal((await f.service.setupStatus(f.workspace)).preview.outcome, "partial");
  const second = await f.service.preview(f.workspace, {});
  await f.service.submitRun(f.workspace, { runId: second.runId, mode: "report-only", outcome: "completed", snapshot: { checked: 0 }, accountOutcomes: [{ account: "a", outcome: "completed" }, { account: "b", outcome: "completed" }] });
  const setup = await f.service.setupStatus(f.workspace);
  const items = await f.service.previewReceiptItems(f.workspace, setup.threadSlug);
  assert.equal(items[0].status.code, "empty"); assert.equal(items.find((entry) => entry.id === first.runId).status.code, "partial");
  assert.deepEqual(setup.scope.accounts, ["a", "b"]);
});

test("expired receipts retain scope but never claim a pending scan or zero findings", async (t) => {
  const f = fixture(t); await f.ready();
  const { runId } = await f.service.preview(f.workspace, {});
  await f.api.getStore().set("ws-1-active", null);
  const setup = await f.service.setupStatus(f.workspace);
  assert.equal(setup.preview.runId, runId); assert.equal(setup.preview.outcome, "unavailable");
  assert.equal(setup.state, "ready");
  const [item] = await f.service.previewReceiptItems(f.workspace, setup.threadSlug);
  assert.equal(item.status.code, "unavailable");
  assert.deepEqual(item.details.filter((entry) => ["checked", "urgent", "proposed", "changes"].includes(entry.id)), []);
  assert.equal(item.details.find((entry) => entry.id === "accounts").value, "fixture");
});

test("scheduled repair keeps intent but checks and Apply cannot resume execution", async (t) => {
  const f = fixture(t, { MAINTENANCE_ENABLED: true, CADENCE: "4h", MODE: "label-only" });
  await f.ready();
  assert.equal(f.task().interval, "4h");
  await f.ready();
  assert.equal(f.task().interval, "4h", "healthy existing schedule stays healthy");
  mailbox.checkAccount = async () => ({ ok: false, code: "AUTH_FAILED", error: "Review authentication." });
  const failed = await f.ready();
  assert.equal(failed.schedule.intent, true);
  assert.equal(failed.schedule.cadence, "4h");
  assert.equal(failed.schedule.suspendedForRepair, true);
  assert.equal(failed.schedule.exists, false);
  assert.equal(failed.schedule.nextScheduledRunAt, null);
  mailbox.checkAccount = async () => ({ ok: true, folders: ["INBOX"] });
  const repaired = await f.ready();
  assert.equal(repaired.state, "ready");
  assert.equal(f.task().interval, "disabled");
  await f.service.configureSetup(f.workspace, { AGENT: "cursor" });
  await f.service.setupJobs.get(1)?.promise;
  assert.equal(f.task().interval, "disabled");
  assert.equal(f.api.getConfig().MODE, "label-only");
  assert.equal(f.api.getConfig().MAINTENANCE_ENABLED, true);
  assert.equal((await f.service.admitHeartbeat({ workspace: { id: 1 } })).skipLaunch, true);
  await assert.rejects(f.service.setSchedule(f.workspace, { enabled: true, cadence: "4h" }, { id: 1 }), { code: "SCHEDULE_SUSPENDED" });
  await assert.rejects(f.service.setSchedule(f.workspace, { enabled: true, cadence: "4h", resume: true }, {}), { code: "HUMAN_REQUIRED" });
  await assert.rejects(f.service.setSchedule(f.workspace, { enabled: true, cadence: "1d", resume: true }, { id: 1 }), { code: "SCHEDULE_CHANGED" });
  await f.service.setSchedule(f.workspace, { enabled: true, cadence: "4h", resume: true }, { id: 1 });
  await f.service.setupJobs.get(1)?.promise;
  assert.equal(f.task().interval, "4h");
  assert.equal((await f.service.setupStatus(f.workspace)).schedule.suspendedForRepair, false);
});

test("an already-failed saved schedule is conservatively suspended after restart", async (t) => {
  const f = fixture(t, { MAINTENANCE_ENABLED: true, CADENCE: "12h" });
  await f.api.getStore().set("ws-1-profile", { schemaVersion: 1, scheduleMigrated: true, state: "needs_repair", taskId: "mailkeeper-maintenance-1" });
  const ready = await f.ready();
  assert.equal(ready.state, "ready");
  assert.equal(ready.schedule.suspendedForRepair, true);
  assert.equal(f.task().interval, "disabled");
});

test("resume preserves workspace pause and rejects a stale queued occurrence", async (t) => {
  const f = fixture(t, { MAINTENANCE_ENABLED: true, CADENCE: "4h" });
  await f.ready();
  mailbox.checkAccount = async () => ({ ok: false, code: "AUTH_FAILED", error: "Review authentication." });
  await f.ready();
  mailbox.checkAccount = async () => ({ ok: true, folders: ["INBOX"] });
  const upsert = f.api.heartbeat.upsertManagedTask;
  f.api.heartbeat.upsertManagedTask = async (workspace, value) => { await upsert(workspace, { ...value, interval: "disabled" }); return { explicitlyPaused: true }; };
  const read = f.api.heartbeat.getManagedTaskStatus;
  f.api.heartbeat.getManagedTaskStatus = async () => ({ ...await read(), paused: true, pauseReason: "workspace_paused" });
  f.api.heartbeat.readSettings = async () => ({ enabled: false, timezone: "UTC" });
  await f.ready();
  await f.service.setSchedule(f.workspace, { enabled: true, cadence: "4h", resume: true }, { id: 1 });
  await f.service.setupJobs.get(1)?.promise;
  const status = await f.service.setupStatus(f.workspace);
  assert.equal(status.state, "ready");
  assert.equal(status.schedule.suspendedForRepair, false);
  assert.equal(status.schedule.pauseReason, "workspace_paused");
  assert.equal(f.task().interval, "disabled");
  assert.equal(f.api.getConfig().MAINTENANCE_ENABLED, true);
  assert.equal((await f.service.admitHeartbeat({ workspace: { id: 1 } })).skipLaunch, true);
});

test("failed resume readback restores suspension before removing the owned task", async (t) => {
  const f = fixture(t, { MAINTENANCE_ENABLED: true, CADENCE: "4h" });
  await f.ready();
  mailbox.checkAccount = async () => ({ ok: false, code: "AUTH_FAILED", error: "Review authentication." });
  await f.ready();
  mailbox.checkAccount = async () => ({ ok: true, folders: ["INBOX"] });
  await f.ready();
  const read = f.api.heartbeat.getManagedTaskStatus;
  f.api.heartbeat.getManagedTaskStatus = async () => ({ ...await read(), interval: "disabled" });
  const remove = f.api.heartbeat.removeManagedTask;
  let persistedBeforeRemoval = false;
  f.api.heartbeat.removeManagedTask = async (...args) => { persistedBeforeRemoval = f.storeData.get("ws-1-profile").scheduleSuspendedForRepair === true; return remove(...args); };
  await f.service.setSchedule(f.workspace, { enabled: true, cadence: "4h", resume: true }, { id: 1 });
  await f.service.setupJobs.get(1)?.promise;
  assert.equal((await f.service.setupStatus(f.workspace)).state, "needs_repair");
  assert.equal(persistedBeforeRemoval, true);
  assert.equal(f.task(), null);
  assert.equal(f.api.getConfig().CADENCE, "4h");
});

test("disable waits for scheduler reconciliation and keeps the latest repair suspension", async (t) => {
  const f = fixture(t, { MAINTENANCE_ENABLED: true, CADENCE: "4h" });
  await f.ready();
  await f.api.getStore().set("ws-1-profile", { ...f.storeData.get("ws-1-profile"), scheduleSuspendedForRepair: true });
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const upsert = f.api.heartbeat.upsertManagedTask;
  f.api.heartbeat.upsertManagedTask = async (...args) => { started(); await new Promise((resolve) => { release = resolve; }); return upsert(...args); };
  await f.service.beginSetup(f.workspace);
  const job = f.service.setupJobs.get(1).promise;
  await began;
  const disable = f.service.disable(f.workspace);
  release(); await Promise.all([job, disable]);
  assert.equal(f.storeData.get("ws-1-profile").state, "disabled");
  assert.equal(f.storeData.get("ws-1-profile").scheduleSuspendedForRepair, true);
  assert.equal(f.task(), null);
});

// Secrets setup: the host picker sends only the selection; MailKeeper keeps
// non-secret facts, and the setup task links the Login through the host.
function withLogins(f, { choices, configure } = {}) {
  const calls = [];
  Object.assign(f.api.email, {
    executeHimalaya: async () => ({ ok: true, data: [] }),
    getLoginChoices: async () => choices || [
      { id: "login-1", reference: "secret://work#password", passwordField: "password", email: "person@example.test", displayName: "Work", providerHint: "gmail" },
      { id: "login-2", reference: "secret://bare#password", passwordField: "password", email: "", needsMetadata: true, displayName: "Bare", providerHint: "custom" },
    ],
    configureSecretsAccount: async (input) => { calls.push(input); if (configure) return configure(input); return { configured: true, bindingId: "binding-9", bindingRevision: "r", target: {} }; },
  });
  return calls;
}
const pick = { id: "login-1", reference: "secret://work#password", passwordField: "password" };

test("a chosen Login is kept as non-secret facts and validated against the host's choices", async (t) => {
  const f = fixture(t); withLogins(f);
  assert.deepEqual(await f.service.selectLogin(f.workspace, { selection: pick }), { selected: true, email: "person@example.test", providerHint: "gmail" });
  const profile = await f.api.getStore().get("ws-1-profile");
  assert.deepEqual(Object.keys(profile.emailLoginSelections["login-1"]).sort(),
    ["displayName", "email", "loginId", "passwordField", "providerHint", "reference", "selectedAt"]);
  assert.deepEqual((await f.service.setupStatus(f.workspace)).emailLogins.selected,
    [{ login: "login-1", email: "person@example.test", displayName: "Work", providerHint: "gmail" }]);
  await assert.rejects(f.service.selectLogin(f.workspace, { selection: { ...pick, password: "x" } }), { code: "LOGIN_SELECTION_INVALID" });
  await assert.rejects(f.service.selectLogin(f.workspace, { selection: { ...pick, reference: "secret://other#password" } }), { code: "LOGIN_UNAVAILABLE" });
  const bare = { id: "login-2", reference: "secret://bare#password", passwordField: "password" };
  await assert.rejects(f.service.selectLogin(f.workspace, { selection: bare }), { code: "LOGIN_EMAIL_REQUIRED" });
  assert.equal((await f.service.selectLogin(f.workspace, { selection: bare, email: "bare@example.test" })).email, "bare@example.test");
});

test("connecting stores the binding before the check and adds the account", async (t) => {
  const f = fixture(t); const calls = withLogins(f);
  await f.service.selectLogin(f.workspace, { selection: pick });
  const seen = [];
  mailbox.checkAccount = async (name, options) => { seen.push([name, options.bindingId]); return { ok: true, folders: ["INBOX"] }; };
  const result = await f.service.connectAccount(f.workspace, { login: "login-1", account: { name: "work" } });
  await f.service.setupJobs.get(1)?.promise;
  assert.equal(result.configured, true);
  assert.deepEqual(calls, [{ account: { name: "work", email: "person@example.test", login: "person@example.test",
    host: "imap.gmail.com", port: 993, encryption: "tls", revision: "test" }, selection: pick }]);
  const profile = await f.api.getStore().get("ws-1-profile");
  assert.deepEqual([profile.emailBindings, profile.emailLoginIds, profile.emailLoginSelections],
    [{ work: "binding-9" }, { work: "login-1" }, {}]);
  assert.ok(f.api.getConfig().EMAIL_ACCOUNTS.includes("work"));
  assert.ok(seen.some(([name, binding]) => name === "work" && binding === "binding-9"), "the check uses the stored binding");
  assert.equal((await f.service.setupStatus(f.workspace)).state, "ready");
});

test("connecting in a new workspace before an agent is chosen still adds the account", async (t) => {
  const f = fixture(t, { EMAIL_ACCOUNTS: [], AGENT: "" }); withLogins(f);
  await f.service.selectLogin(f.workspace, { selection: pick });
  const result = await f.service.connectAccount(f.workspace, { login: "login-1", account: { name: "work" } });
  await f.service.setupJobs.get(1)?.promise;
  assert.equal(result.configured, true);
  assert.deepEqual(f.api.getConfig().EMAIL_ACCOUNTS, ["work"]);
  const status = await f.service.setupStatus(f.workspace);
  assert.deepEqual(status.blockers.map((entry) => entry.safeMessage), ["Maintenance agent is required."]);
  await assert.rejects(f.service.configureSetup(f.workspace, { MODE: "bogus" }), { code: "SETUP_CONFIG_INVALID" });
  assert.deepEqual(f.api.getConfig().EMAIL_ACCOUNTS, ["work"]);
});

test("connect refuses unknown Logins, missing server details and host failures without storing a binding", async (t) => {
  const f = fixture(t);
  withLogins(f, { configure: () => { throw Object.assign(new Error("raw"), { code: "SECRET_SCOPE_DENIED" }); } });
  await assert.rejects(f.service.connectAccount(f.workspace, { login: "login-1", account: { name: "work" } }), { code: "LOGIN_NOT_SELECTED" });
  await f.service.selectLogin(f.workspace, { selection: { id: "login-2", reference: "secret://bare#password", passwordField: "password" }, email: "bare@example.test" });
  await assert.rejects(f.service.connectAccount(f.workspace, { login: "login-2", account: { name: "bare" } }), { code: "ACCOUNT_SERVER_REQUIRED" });
  await assert.rejects(f.service.connectAccount(f.workspace, { login: "login-2", account: { name: "bad name" } }), { code: "ACCOUNT_NAME_INVALID" });
  await assert.rejects(f.service.connectAccount(f.workspace, { login: "login-2",
    account: { name: "bare", host: "imap.example.test", port: 993, encryption: "tls" } }), { code: "SECRET_SCOPE_DENIED" });
  const profile = await f.api.getStore().get("ws-1-profile");
  assert.equal(profile.emailBindings, undefined);
  assert.ok(profile.emailLoginSelections["login-2"], "a failed connect keeps the selection for a retry");
});

test("choosing the Login an account already uses re-checks it after a sign-in update", async (t) => {
  const f = fixture(t); const calls = withLogins(f);
  await f.service.selectLogin(f.workspace, { selection: pick });
  await f.service.connectAccount(f.workspace, { login: "login-1", account: { name: "work" } });
  await f.service.setupJobs.get(1)?.promise;
  const again = await f.service.selectLogin(f.workspace, { selection: pick, account: "work" });
  await f.service.setupJobs.get(1)?.promise;
  assert.equal(again.account, "work"); assert.equal(again.accepted, true);
  assert.equal(calls.length, 1, "no second configuration");
  assert.deepEqual((await f.api.getStore().get("ws-1-profile")).emailLoginSelections, {});
});
