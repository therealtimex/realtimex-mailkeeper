"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mk-service-"));
const mailboxFile = path.join(sandbox, "mailbox.json");
const himalayaConfig = path.join(sandbox, "config.toml");
fs.writeFileSync(himalayaConfig, "# test config\n");
process.env.MAILKEEPER_HIMALAYA_BIN = path.join(FIXTURES, "fake-himalaya.js");
process.env.FAKE_MAILBOX = mailboxFile;
process.env.HIMALAYA_CONFIG = himalayaConfig;

const core = require("../skills/mailbox-cleanup/scripts/mailkeeper-core");
const { MailKeeperService, taskIdentity } = require("../runtime/service");

function setMailbox(names) {
  const accounts = {};
  for (const name of names) core.setOwn(accounts, name, { credential: { kind: "native" }, folders: { INBOX: [] } });
  fs.writeFileSync(mailboxFile, JSON.stringify({ accounts }));
}

const baseConfig = {
  DEFAULT_MODE_CEILING: "label-only",
  AUTO_FOLDER_PREFIX: "Auto",
  PROTECTED_DOMAINS: [".gov"],
  RETENTION_DAYS: 90,
  EMAIL_ACCOUNTS: ["work", "personal@example.com"],
  MODE: "report-only",
  CADENCE: "1d",
  AGE_THRESHOLD_DAYS: 60,
  AGGRESSIVENESS: "conservative",
  VIP_SENDERS: [],
  AGENT: "codex",
  MODEL: "",
  EFFORT: "",
};

function harness({ config = {}, paused = false } = {}) {
  const dir = fs.mkdtempSync(path.join(sandbox, "ws-"));
  const workspace = { id: 7, slug: "mail", name: "Mail", workingDirectory: dir };
  const store = new Map();
  const calls = { upsert: [], remove: [], ensureThread: 0 };
  const state = { config: { ...baseConfig, ...config } };
  const api = {
    pluginId: "com.realtimex.mailkeeper",
    getConfig: () => state.config,
    getStore: () => ({
      get: async (key) => (store.has(key) ? structuredClone(store.get(key)) : null),
      set: async (key, value) => store.set(key, structuredClone(value)),
    }),
    log: { info() {}, warn() {}, error() {} },
    workspaces: {
      get: async () => workspace,
      listEnabledForPlugin: async () => [workspace],
      ensureThread: async () => {
        calls.ensureThread += 1;
        return { id: 1, slug: "mailkeeper-maintenance-7", name: "MailKeeper maintenance" };
      },
    },
    heartbeat: {
      readSettings: async () => ({ exists: true, enabled: !paused }),
      upsertManagedTask: async (ws, task) => {
        calls.upsert.push(task);
        return { changed: true, explicitlyPaused: paused };
      },
      removeManagedTask: async (ws, selector) => {
        calls.remove.push(selector);
        return { changed: true };
      },
    },
  };
  return { api, service: new MailKeeperService(api), workspace, dir, store, calls, state };
}

function contractPath(dir, name) {
  return path.join(dir, core.contractRelativePath(core.accountKey(name)));
}

test("provision seeds one report-only contract per selected inbox and one task", async () => {
  setMailbox(["work", "personal@example.com", "unselected"]);
  const { service, dir, calls, workspace } = harness();
  const result = await service.provision(workspace);
  assert.equal(result.state, "ready");
  for (const name of ["work", "personal@example.com"]) {
    const parsed = core.parseContract(fs.readFileSync(contractPath(dir, name), "utf8"), name);
    assert.equal(parsed.status, "valid");
    assert.equal(parsed.policy.mode, "report-only");
    assert.equal(parsed.policy.credential, null);
    assert.equal(parsed.policy.ageThresholdDays, 60);
  }
  assert.equal(fs.existsSync(contractPath(dir, "unselected")), false, "never enrol an unselected inbox");
  assert.equal(calls.upsert.length, 1);
  const task = calls.upsert[0];
  assert.equal(task.id, taskIdentity(7));
  assert.equal(task.name, "MailKeeper maintenance");
  assert.equal(task.agent, "codex");
  assert.equal("model" in task, false);
  assert.equal("runtimeOptionValues" in task, false);
  assert.match(task.prompt, /--account 'personal@example\.com'/);
  assert.match(task.prompt, /mailboxes\/work-[0-9a-f]{12}\/MAILBOX\.md/);

  const rules = JSON.parse(fs.readFileSync(path.join(dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.equal(rules.schemaVersion, 2);
  assert.deepEqual(rules.himalayaConfig.paths, [himalayaConfig]);
  assert.equal(rules.accounts.work.key, core.accountKey("work"));
  assert.equal((fs.statSync(path.join(dir, ".mailkeeper", "rules.json")).mode & 0o777).toString(8), "600");
  assert.deepEqual(
    [rules.schedule.cadenceLabel, rules.schedule.heartbeatEnabled, rules.schedule.paused, rules.schedule.threadName],
    ["Daily", true, false, "MailKeeper maintenance"]
  );
});

test("contracts are never overwritten and survive deselection", async () => {
  setMailbox(["work", "personal@example.com"]);
  const { service, dir, workspace, state } = harness();
  await service.provision(workspace);
  const file = contractPath(dir, "work");
  fs.appendFileSync(file, "\nMy own note.\n");
  const edited = fs.readFileSync(file, "utf8");
  await service.provision(workspace);
  assert.equal(fs.readFileSync(file, "utf8"), edited);

  state.config = { ...state.config, EMAIL_ACCOUNTS: ["personal@example.com"] };
  await service.provision(workspace);
  assert.equal(fs.readFileSync(file, "utf8"), edited, "a deselected inbox keeps its contract");
  state.config = { ...state.config, EMAIL_ACCOUNTS: ["work"] };
  await service.provision(workspace);
  assert.equal(fs.readFileSync(file, "utf8"), edited, "reselection reuses it");
});

test("an inbox missing from the email settings is reported, not seeded", async () => {
  setMailbox(["work"]);
  const { service, dir, workspace } = harness();
  const result = await service.provision(workspace);
  assert.equal(result.inboxes["personal@example.com"].code, "MAILKEEPER_ACCOUNT_NOT_FOUND");
  assert.equal(fs.existsSync(contractPath(dir, "personal@example.com")), false);
  assert.equal(result.state, "ready", "the schedule still runs for the inboxes that exist");
});

test("a missing email settings file is reported without blocking provisioning", async () => {
  setMailbox(["work"]);
  const { service, workspace } = harness();
  process.env.HIMALAYA_CONFIG = path.join(sandbox, "absent.toml");
  try {
    const result = await service.provision(workspace);
    assert.equal(result.discovery.code, "MAILKEEPER_HIMALAYA_CONFIG_MISSING");
    assert.equal(result.inboxes.work.code, "MAILKEEPER_HIMALAYA_CONFIG_MISSING");
  } finally {
    process.env.HIMALAYA_CONFIG = himalayaConfig;
  }
});

test("names that collide by case or look like object keys get separate contracts", async () => {
  setMailbox(["Work", "work", "__proto__", "it's \"quoted\""]);
  const { service, dir, workspace, calls } = harness({ config: { EMAIL_ACCOUNTS: ["Work", "work", "__proto__", "it's \"quoted\""] } });
  const result = await service.provision(workspace);
  const files = ["Work", "work", "__proto__", "it's \"quoted\""].map((name) => contractPath(dir, name));
  assert.equal(new Set(files).size, 4);
  for (const name of ["Work", "work", "__proto__", "it's \"quoted\""]) {
    assert.equal(result.inboxes[name].status, "valid", name);
  }
  assert.match(calls.upsert[0].prompt, /--account 'it'\\''s "quoted"'/);
});

test("a symlinked mailboxes directory is refused and nothing is written through it", async () => {
  setMailbox(["work"]);
  const { service, dir, workspace } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  const outside = fs.mkdtempSync(path.join(sandbox, "outside-"));
  fs.symlinkSync(outside, path.join(dir, "mailboxes"));
  const result = await service.provision(workspace);
  assert.equal(result.inboxes.work.status, "invalid");
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("effort is forwarded only with a model, and clearing it rewrites the task", async () => {
  setMailbox(["work"]);
  const { service, workspace, calls, state } = harness({ config: { EMAIL_ACCOUNTS: ["work"], MODEL: "gpt-5", EFFORT: "high" } });
  await service.provision(workspace);
  assert.deepEqual(calls.upsert[0].runtimeOptionValues, { reasoning_effort: "high" });
  assert.equal(calls.upsert[0].model, "gpt-5");

  state.config = { ...state.config, MODEL: "" };
  const noModel = await service.provision(workspace);
  assert.equal(calls.upsert.length, 2, "effort alone never removes the schedule");
  assert.equal(calls.remove.length, 0);
  assert.equal("runtimeOptionValues" in calls.upsert[1], false, "the stale effort key is gone");
  assert.deepEqual(noModel.warnings, [{ code: "MAILKEEPER_EFFORT_UNSUPPORTED", reason: "no-model" }]);
  assert.match(calls.upsert[1].prompt, /Reasoning effort isn't applied because no model is selected/);
  assert.match(calls.upsert[1].prompt, /one is owed this run/);

  state.config = { ...state.config, AGENT: "gemini", MODEL: "pro" };
  await service.provision(workspace);
  assert.equal(calls.upsert.length, 3);
  assert.match(calls.upsert[2].prompt, /doesn't support it for gemini yet/);

  state.config = { ...state.config, AGENT: "claude", MODEL: "opus", EFFORT: "" };
  await service.provision(workspace);
  assert.equal("runtimeOptionValues" in calls.upsert[3], false);
  assert.doesNotMatch(calls.upsert[3].prompt, /EFFORT:/);
});

test("genuinely invalid config removes only this plugin's task", async () => {
  setMailbox(["work"]);
  const { service, workspace, calls } = harness({ config: { AGENT: "" } });
  const result = await service.provision(workspace);
  assert.equal(result.state, "config_invalid");
  assert.deepEqual(calls.remove, [{ id: taskIdentity(7) }]);
  assert.equal(calls.upsert.length, 0);
});

test("each provisioning attempt records its outcome; only a ready one vouches for rules.json", async () => {
  setMailbox(["work"]);
  const { service, workspace, state } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(workspace.workingDirectory, ".mailkeeper", name), "utf8"));

  await service.provision(workspace);
  const rules = read("rules.json");
  assert.deepEqual([read("provisioning.json").state, read("provisioning.json").rulesWrittenAt], ["ready", rules.writtenAt]);
  assert.equal(rules.schedule.taskId, taskIdentity(7));

  state.config = { ...state.config, AGENT: "" };
  await service.provision(workspace);
  assert.deepEqual([read("provisioning.json").state, read("provisioning.json").rulesWrittenAt], ["config_invalid", null]);
  assert.equal(read("rules.json").writtenAt, rules.writtenAt, "the older schedule stays on disk, no longer vouched for");

  state.config = { ...state.config, AGENT: "codex" };
  service.discover = async () => {
    throw new Error("discovery failed");
  };
  await assert.rejects(service.provision(workspace));
  assert.equal(read("provisioning.json").state, "pending", "an attempt that threw never reads as ready");

  await service.disable(workspace);
  assert.equal(read("provisioning.json").state, "disabled");
});

test("a paused workspace stays paused after repair", async () => {
  setMailbox(["work"]);
  const { service, workspace, calls } = harness({ paused: true, config: { EMAIL_ACCOUNTS: ["work"] } });
  const result = await service.provision(workspace);
  assert.equal(result.state, "paused_by_heartbeat");
  const rules = JSON.parse(fs.readFileSync(path.join(workspace.workingDirectory, ".mailkeeper", "rules.json"), "utf8"));
  assert.equal(rules.schedule.paused, true);
  assert.equal(rules.schedule.heartbeatEnabled, false);
  // MailKeeper never asks the host to enable heartbeat; the host keeps the pause.
  assert.equal(calls.upsert.length, 1);
  assert.equal(Object.keys(calls.upsert[0]).some((key) => /enable/i.test(key)), false);
});

test("a single-inbox v0.1.1 contract is copied once and awaits review", async () => {
  setMailbox(["work"]);
  const { service, dir, workspace, store } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  const legacy = "# Mailbox contract — work\n\nNever touch: boss@example.com\n";
  fs.writeFileSync(path.join(dir, "MAILBOX.md"), legacy);
  store.set("ws-7-profile", { state: "ready", emailAccounts: ["work"] });
  const result = await service.provision(workspace);
  assert.equal(result.inboxes.work.status, "review-required");
  assert.equal(result.inboxes.work.code, "MAILKEEPER_CONTRACT_REVIEW_REQUIRED");
  const copied = fs.readFileSync(contractPath(dir, "work"), "utf8");
  assert.ok(copied.startsWith(legacy.trimEnd()));
  assert.equal(fs.readFileSync(path.join(dir, "MAILBOX.md"), "utf8"), legacy, "the original bytes are preserved");

  await service.provision(workspace);
  assert.equal(fs.readFileSync(contractPath(dir, "work"), "utf8"), copied, "migration is idempotent");
});

test("a shared v0.1.1 contract becomes separate drafts that each need review", async () => {
  setMailbox(["a", "b", "c"]);
  const { service, dir, workspace, store, state } = harness({ config: { EMAIL_ACCOUNTS: ["a", "b"] } });
  fs.writeFileSync(path.join(dir, "MAILBOX.md"), "# Mailbox contract — a, b\n");
  store.set("ws-7-profile", { state: "ready", emailAccounts: ["a", "b"] });
  await service.provision(workspace);
  for (const name of ["a", "b"]) {
    const parsed = core.parseContract(fs.readFileSync(contractPath(dir, name), "utf8"), name);
    assert.equal(parsed.status, "review-required");
    assert.equal(parsed.policy.mode, "report-only");
  }
  // An inbox added later is a fresh draft, not a copy of the old shared policy.
  state.config = { ...state.config, EMAIL_ACCOUNTS: ["a", "b", "c"] };
  await service.provision(workspace);
  assert.equal(core.parseContract(fs.readFileSync(contractPath(dir, "c"), "utf8"), "c").status, "valid");
});

test("legacy unscoped approved rules are scoped only when one inbox is proven", async () => {
  setMailbox(["work", "home"]);
  const single = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  single.store.set("ws-7-profile", { emailAccounts: ["work"] });
  single.store.set("ws-7-rules", { revision: 3, promoted: [{ id: "r1", pass: "no-reply", query: "q", action: "a" }], proposed: [] });
  await single.service.provision(single.workspace);
  const scoped = single.store.get("ws-7-rules");
  assert.equal(scoped.promoted[0].account, "work");

  const multi = harness({ config: { EMAIL_ACCOUNTS: ["work", "home"] } });
  multi.store.set("ws-7-profile", { emailAccounts: ["work", "home"] });
  multi.store.set("ws-7-rules", { revision: 3, promoted: [{ id: "r1", pass: "no-reply", query: "q", action: "a" }], proposed: [] });
  await multi.service.provision(multi.workspace);
  const demoted = multi.store.get("ws-7-rules");
  assert.deepEqual(demoted.promoted, []);
  assert.equal(demoted.proposed[0].reviewRequired, true);
  const rulesFile = JSON.parse(fs.readFileSync(path.join(multi.dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.deepEqual(rulesFile.promoted, []);
});

test("receipts keep only account-scoped suggestions, idempotently", async () => {
  setMailbox(["work"]);
  const { service, workspace, store } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  await service.provision(workspace);
  const body = {
    runId: "run-1",
    outcome: "blocked",
    accounts: { work: { outcome: "blocked", code: "MAILKEEPER_IMAP_CHECK_FAILED" } },
    proposals: [
      { account: "work", pass: "no-reply", query: "q", action: "move → Auto/Notifications", count: 9 },
      { pass: "receipt", query: "q", action: "x", count: 5 },
    ],
  };
  await service.submitRun(workspace, body);
  assert.deepEqual(await service.submitRun(workspace, body), { runId: "run-1", reused: true });
  const rules = store.get("ws-7-rules");
  assert.equal(rules.proposed.length, 1);
  assert.equal(rules.proposed[0].id, core.ruleId(body.proposals[0]));
  assert.equal(store.get("ws-7-run-run-1").accounts.work.code, "MAILKEEPER_IMAP_CHECK_FAILED");
});

test("server undo points to the workspace chat", async () => {
  setMailbox(["work"]);
  const { service, workspace } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  await service.submitRun(workspace, { runId: "7f3a", outcome: "completed" });
  await assert.rejects(service.undoRun(workspace, { runId: "7f3a" }, { id: 1 }), { code: "MAILKEEPER_TERMINAL_REQUIRED" });
});

test("heartbeat end releases the run guard unless a move is uncertain", async () => {
  setMailbox(["work"]);
  const { service, workspace, dir, store } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  const state = path.join(dir, ".mailkeeper");
  fs.mkdirSync(path.join(state, "runs"), { recursive: true });
  const finish = async (runId, run) => {
    fs.writeFileSync(path.join(state, "run.lock"), JSON.stringify({ runId }));
    fs.writeFileSync(path.join(state, "runs", `${runId}.json`), JSON.stringify(run));
    store.set("ws-7-active", { runId, startedAt: new Date().toISOString() });
    await service.recordHeartbeatLifecycle({ workspace: { id: 7 }, dispatch: { dispatchStatus: "completed" } });
    return fs.existsSync(path.join(state, "run.lock"));
  };
  assert.equal(await finish("r-ok", { runId: "r-ok", uncertain: [] }), false);
  assert.equal(await finish("r-bad", { runId: "r-bad", uncertain: [{ account: "work" }] }), true);
});

test("a Manual schedule keeps the task disabled and refuses scheduled launches only", async () => {
  setMailbox(["work"]);
  const { service, workspace, calls, state, dir } = harness({ config: { EMAIL_ACCOUNTS: ["work"], CADENCE: "manual" } });
  await service.provision(workspace);
  assert.equal(calls.upsert.length, 1);
  assert.equal(calls.upsert[0].interval, "disabled");
  assert.equal(calls.remove.length, 0, "Manual never removes the task");
  const rules = JSON.parse(fs.readFileSync(path.join(dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.deepEqual([rules.schedule.manual, rules.schedule.cadenceLabel], [true, "Manual"]);

  const scheduled = await service.admitHeartbeat({ workspace: { id: 7 }, trigger: "scheduled" });
  assert.deepEqual(scheduled, { skipLaunch: true, skipReason: "schedule is manual" });
  const manual = await service.admitHeartbeat({ workspace: { id: 7 }, trigger: "manual" });
  assert.ok(manual.mailkeeperRunId, "a person's row Run is admitted");

  state.config = { ...state.config, CADENCE: "1d" };
  await service.provision(workspace);
  assert.equal(calls.upsert[1].interval, "1d", "switching back schedules daily again");
});
