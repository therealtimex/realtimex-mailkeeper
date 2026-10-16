"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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
  assert.doesNotMatch(task.prompt, /\(Details/, "reports never show error codes");
  assert.match(task.prompt, /no error codes, no step names/);
  assert.match(task.prompt, /point to this workspace's chat/);

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

  // A contract from an earlier version keeps its old header and wording, byte for byte.
  const older = edited.replace(/^This contract belongs to you\..*$/m, "This contract belongs to you. MailKeeper created it once and never overwrites it.");
  fs.writeFileSync(file, older);
  await service.provision(workspace);
  assert.equal(fs.readFileSync(file, "utf8"), older);
  fs.writeFileSync(file, edited);

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
  const ready = read("provisioning.json");
  assert.equal(ready.state, "ready");
  assert.equal(read("rules.json").provisionAttempt, ready.attempt);
  assert.equal(read("rules.json").schedule.taskId, taskIdentity(7));

  state.config = { ...state.config, AGENT: "" };
  await service.provision(workspace);
  assert.equal(read("provisioning.json").state, "config_invalid");
  assert.notEqual(read("provisioning.json").attempt, read("rules.json").provisionAttempt, "the older rules.json is no longer vouched for");

  state.config = { ...state.config, AGENT: "codex" };
  service.discover = async () => {
    throw new Error("discovery failed");
  };
  await assert.rejects(service.provision(workspace));
  assert.equal(read("provisioning.json").state, "pending", "an attempt that threw never reads as ready");

  await service.disable(workspace);
  assert.equal(read("provisioning.json").state, "disabled");
});

test("a failure anywhere in an attempt leaves it pending, never the earlier ready", async () => {
  setMailbox(["work"]);
  const { service, workspace, state } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  const outcome = () => JSON.parse(fs.readFileSync(path.join(workspace.workingDirectory, ".mailkeeper", "provisioning.json"), "utf8")).state;
  const fail = async () => {
    throw new Error("injected");
  };
  const fresh = async () => {
    await service.provision(workspace);
    assert.equal(outcome(), "ready");
  };

  await fresh();
  const get = service.store.get;
  service.store.get = fail;
  await assert.rejects(service.provision(workspace));
  assert.equal(outcome(), "pending", "profile read failed");
  service.store.get = get;

  await fresh();
  const remove = service.host.heartbeat.removeManagedTask;
  service.host.heartbeat.removeManagedTask = fail;
  state.config = { ...state.config, AGENT: "" };
  await assert.rejects(service.provision(workspace));
  assert.equal(outcome(), "pending", "invalid settings, then removing the task failed");
  state.config = { ...state.config, AGENT: "codex" };
  service.host.heartbeat.removeManagedTask = remove;

  await fresh();
  service.host.heartbeat.removeManagedTask = fail;
  await assert.rejects(service.disable(workspace));
  assert.equal(outcome(), "pending", "disable failed");
});

test("an earlier attempt never publishes over a newer one", async () => {
  setMailbox(["work"]);
  const { service, workspace } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(workspace.workingDirectory, ".mailkeeper", name), "utf8"));
  const set = service.store.set;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  service.store.set = async (key, value) => {
    if (first && key === service.profileKey(workspace)) {
      first = false;
      await blocked; // A has written rules.json and waits here
    }
    return set(key, value);
  };

  const a = service.provision(workspace);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const b = service.provision(workspace);
  const newer = read("provisioning.json");
  assert.equal(newer.state, "pending", "B is recorded the moment it is requested");

  release();
  await a;
  assert.deepEqual([read("provisioning.json").state, read("provisioning.json").attempt], ["pending", newer.attempt], "A finished but didn't publish over B");
  await b;
  assert.deepEqual([read("provisioning.json").state, read("provisioning.json").attempt], ["ready", newer.attempt]);
  assert.equal(read("rules.json").provisionAttempt, newer.attempt, "ready vouches for B's own rules.json");
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
  assert.equal(scoped.promoted[0].scopedFrom, "v0.1.1-single-account");
  const singleFile = JSON.parse(fs.readFileSync(path.join(single.dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.deepEqual([singleFile.promoted.length, singleFile.legacyUnscopedRules, singleFile.legacyRulesKept], [1, 0, { work: 1 }]);

  const multi = harness({ config: { EMAIL_ACCOUNTS: ["work", "home"] } });
  multi.store.set("ws-7-profile", { emailAccounts: ["work", "home"] });
  multi.store.set("ws-7-rules", { revision: 3, promoted: [{ id: "r1", pass: "no-reply", query: "q", action: "a" }], proposed: [] });
  await multi.service.provision(multi.workspace);
  const demoted = multi.store.get("ws-7-rules");
  assert.deepEqual(demoted.promoted, []);
  assert.equal(demoted.proposed[0].reviewRequired, true);
  const rulesFile = JSON.parse(fs.readFileSync(path.join(multi.dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.deepEqual(rulesFile.promoted, []);
  assert.deepEqual([rulesFile.legacyUnscopedRules, rulesFile.legacyRulesKept], [1, {}], "the disposition reaches the workspace");

  // Mixed: an account-scoped rule is kept, an unscoped one becomes a suggestion.
  const mixed = harness({ config: { EMAIL_ACCOUNTS: ["work", "home"] } });
  mixed.store.set("ws-7-profile", { emailAccounts: ["work", "home"] });
  mixed.store.set("ws-7-rules", {
    revision: 3,
    promoted: [
      { id: "r1", pass: "no-reply", query: "q", action: "a", account: "home" },
      { id: "r2", pass: "no-reply", query: "q", action: "a" },
    ],
    proposed: [],
  });
  await mixed.service.provision(mixed.workspace);
  const mixedFile = JSON.parse(fs.readFileSync(path.join(mixed.dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.deepEqual(
    [mixedFile.promoted.map((r) => [r.id, r.account]), mixedFile.legacyUnscopedRules, mixedFile.legacyRulesKept],
    [[["r1", "home"]], 1, { home: 1 }]
  );

  // No recorded inbox history: the scope isn't inferred from today's selection.
  const unknown = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  unknown.store.set("ws-7-profile", {});
  unknown.store.set("ws-7-rules", { revision: 3, promoted: [{ id: "r1", pass: "no-reply", query: "q", action: "a" }], proposed: [] });
  await unknown.service.provision(unknown.workspace);
  const unknownFile = JSON.parse(fs.readFileSync(path.join(unknown.dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.deepEqual([unknownFile.promoted, unknownFile.legacyUnscopedRules, unknownFile.legacyRulesKept], [[], 1, {}]);

  // Already converted before this version: approved rules exist, but nothing
  // records that the conversion kept them. Unknown, and never backfilled.
  const earlier = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  earlier.store.set("ws-7-rules", {
    schemaVersion: 2,
    revision: 4,
    promoted: [{ id: "r1", pass: "no-reply", query: "q", action: "a", account: "work" }],
    proposed: [],
  });
  await earlier.service.provision(earlier.workspace);
  await earlier.service.provision(earlier.workspace);
  const earlierFile = JSON.parse(fs.readFileSync(path.join(earlier.dir, ".mailkeeper", "rules.json"), "utf8"));
  assert.deepEqual([earlierFile.promoted.length, earlierFile.legacyRulesKept], [1, null]);
  assert.equal(earlier.store.get("ws-7-rules").legacyMigration, undefined);
});

test("the kept-rules record is exact for any inbox name, from the conversion through rules.json to begin", async () => {
  const names = ["__proto__", "constructor", "toString"];
  setMailbox(names);
  const { service, dir, workspace, store } = harness({ config: { EMAIL_ACCOUNTS: names } });
  fs.writeFileSync(path.join(dir, "MAILBOX.md"), "# Mailbox contract\n\nMy old shared rules.\n");
  // All three were 0.1 inboxes, so each gets the copied contract and the first-report notice.
  store.set("ws-7-profile", { emailAccounts: names });
  store.set("ws-7-rules", {
    revision: 3,
    promoted: [
      { id: "r1", pass: "no-reply", query: "q", action: "a" }, // no inbox: becomes a suggestion
      { id: "r2", pass: "no-reply", query: "q", action: "a", account: "__proto__" },
      { id: "r3", pass: "age", query: "q", action: "a", account: "toString" },
      { id: "r4", pass: "no-reply", query: "q", action: "a", account: "toString" },
      { id: "r5", pass: "no-reply", query: "q", action: "a", account: "constructor" },
    ],
    proposed: [],
  });
  await service.provision(workspace);

  const kept = JSON.parse(fs.readFileSync(path.join(dir, ".mailkeeper", "rules.json"), "utf8")).legacyRulesKept;
  assert.deepEqual(Object.keys(kept).sort(), [...names].sort());
  for (const [name, count] of [["__proto__", 1], ["constructor", 1], ["toString", 2]]) {
    assert.equal(core.own(kept, name), count, name);
  }

  const begun = spawnSync(process.execPath, [path.join(__dirname, "..", "skills", "mailbox-cleanup", "scripts", "mailbox-ops.js"), "begin", "--run-id", "r1"], {
    cwd: dir,
    encoding: "utf8",
  });
  const output = JSON.parse(begun.stdout);
  const inboxes = output.inboxes;
  assert.equal(output.legacyUnscopedRules, 1);
  for (const [name, count] of [["__proto__", 1], ["constructor", 1], ["toString", 2]]) {
    assert.equal(core.own(inboxes, name).migrationNotice, true, name);
    assert.equal(core.own(inboxes, name).rulesKept, count, `${name}: its own count, nobody else's`);
  }
});

const OPS = path.join(__dirname, "..", "skills", "mailbox-cleanup", "scripts", "mailbox-ops.js");

/** Run the workspace CLI in a provisioned workspace, as the agent would. */
function ops(dir, ...args) {
  const result = spawnSync(process.execPath, [OPS, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, MAILKEEPER_RTXEXEC_BIN: path.join(FIXTURES, "fake-rtxexec.js"), FAKE_RTX_SESSION: "1", FAKE_SECRETS: "{}" },
  });
  return JSON.parse(result.stdout);
}

function readPolicy(dir, name) {
  return core.parseContract(fs.readFileSync(contractPath(dir, name), "utf8"), name);
}

const NATIVE = { kind: "himalaya-native" };

/**
 * A check is current only for an inbox that has an entry in the pinned email
 * settings, so these tests give their inboxes one and restore the shared file.
 */
async function withStanzas(names, fn) {
  const original = fs.readFileSync(himalayaConfig, "utf8");
  fs.writeFileSync(himalayaConfig, original + names.map((name) => `[accounts.${name}]\nemail = "${name}@example.com"\n`).join("\n"));
  try {
    await fn();
  } finally {
    fs.writeFileSync(himalayaConfig, original);
  }
}

test("a migrated single inbox keeps its sign-in through the review and reads after it", async () => {
  await withStanzas(["work"], async () => {
    setMailbox(["work"]);
    const { service, dir, workspace, store } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
    const legacy = "# Mailbox contract — work\n\nNever touch: boss@example.com\n";
    fs.writeFileSync(path.join(dir, "MAILBOX.md"), legacy);
    store.set("ws-7-profile", { state: "ready", emailAccounts: ["work"] });
    await service.provision(workspace);
    const read = (runId) => {
      assert.equal(ops(dir, "begin", "--run-id", runId).ok, true);
      const snapshot = ops(dir, "snapshot", "--account", "work", "--run-id", runId);
      ops(dir, "submit", "--run-id", runId, "--summary", "test");
      return snapshot;
    };

    assert.equal(read("before-review").ok, true, "the copied contract reads with its Himalaya sign-in");
    // The review's pre-filled draft is written before the person answers.
    assert.equal(ops(dir, "contract-set", "--account", "work").status, "review-required");
    assert.deepEqual(readPolicy(dir, "work").policy.credential, NATIVE, "the first settings block keeps the sign-in");
    assert.equal(read("review-pending").ok, true);
    assert.equal(ops(dir, "contract-set", "--account", "work", "--confirm-review").status, "valid");
    assert.deepEqual(readPolicy(dir, "work").policy.credential, NATIVE);
    assert.equal(read("after-review").ok, true, "the run after the review reads the inbox");

    assert.equal(fs.readFileSync(path.join(dir, "MAILBOX.md"), "utf8"), legacy);
    const status = ops(dir, "status").inboxes[0];
    assert.equal(status.lastCheck, null, "reviewing and running record no connection check");
    assert.equal(status.setupComplete, false);
    assert.equal(ops(dir, "check", "--account", "work").ok, true);
    const checked = ops(dir, "status").inboxes[0];
    assert.deepEqual([checked.lastCheck.current, checked.setupComplete], [true, true]);
  });
});

test("a shared v0.1.1 contract's drafts each keep their own inbox's sign-in", async () => {
  await withStanzas(["a", "b"], async () => {
    setMailbox(["a", "b"]);
    const { service, dir, workspace, store } = harness({ config: { EMAIL_ACCOUNTS: ["a", "b"] } });
    fs.writeFileSync(path.join(dir, "MAILBOX.md"), "# Mailbox contract — a, b\n");
    store.set("ws-7-profile", { state: "ready", emailAccounts: ["a", "b"] });
    await service.provision(workspace);
    for (const name of ["a", "b"]) {
      const parsed = readPolicy(dir, name);
      assert.deepEqual([parsed.status, parsed.policy.account, parsed.policy.credential], ["review-required", name, NATIVE]);
    }
    assert.equal(ops(dir, "begin", "--run-id", "r1").ok, true);
    for (const name of ["a", "b"]) assert.equal(ops(dir, "snapshot", "--account", name, "--run-id", "r1").ok, true, `${name} reads before the review`);
    ops(dir, "submit", "--run-id", "r1", "--summary", "test");

    for (const name of ["a", "b"]) ops(dir, "contract-set", "--account", name, "--confirm-review");
    assert.equal(ops(dir, "begin", "--run-id", "r2").ok, true);
    for (const name of ["a", "b"]) {
      assert.deepEqual(readPolicy(dir, name).policy.credential, NATIVE);
      assert.equal(ops(dir, "snapshot", "--account", name, "--run-id", "r2").ok, true, `${name} reads after the review`);
    }
    ops(dir, "submit", "--run-id", "r2", "--summary", "test");

    // A check vouches only for its own inbox.
    assert.equal(ops(dir, "check", "--account", "a").ok, true);
    const [a, b] = ops(dir, "status").inboxes;
    assert.deepEqual([a.lastCheck.current, b.lastCheck], [true, null]);
  });
});

test("an inbox added after the update starts with no sign-in, and choosing one keeps a pending review", async () => {
  await withStanzas(["a", "b", "c"], async () => {
    setMailbox(["a", "b", "c"]);
    const { service, dir, workspace, store, state } = harness({ config: { EMAIL_ACCOUNTS: ["a", "b"] } });
    fs.writeFileSync(path.join(dir, "MAILBOX.md"), "# Mailbox contract — a, b\n");
    store.set("ws-7-profile", { state: "ready", emailAccounts: ["a", "b"] });
    await service.provision(workspace);
    const before = fs.readFileSync(contractPath(dir, "a"), "utf8");
    state.config = { ...state.config, EMAIL_ACCOUNTS: ["a", "b", "c"] };
    await service.provision(workspace);
    assert.equal(fs.readFileSync(contractPath(dir, "a"), "utf8"), before, "reprovision leaves existing contracts alone");
    const added = readPolicy(dir, "c");
    assert.deepEqual([added.status, added.policy.credential], ["valid", null], "the old root file doesn't make a new inbox a 0.1 inbox");

    // No sign-in recorded: its own blocked condition, before any server contact.
    assert.equal(ops(dir, "begin", "--run-id", "r1").ok, true);
    assert.equal(ops(dir, "snapshot", "--account", "c", "--run-id", "r1").code, "MAILKEEPER_CREDENTIAL_NOT_CONFIGURED");
    const receipt = ops(dir, "submit", "--run-id", "r1", "--summary", "test");
    assert.equal(receipt.ok, true);
    assert.equal(ops(dir, "check", "--account", "c").code, "MAILKEEPER_CREDENTIAL_NOT_CONFIGURED");

    // The person's choice is written, then the normal check uses it.
    ops(dir, "contract-set", "--account", "c", "--native");
    assert.deepEqual(readPolicy(dir, "c").policy.credential, NATIVE);
    assert.equal(ops(dir, "check", "--account", "c").ok, true);
    assert.equal(ops(dir, "status").inboxes[2].lastCheck.current, true);

    // Choosing a sign-in never confirms a pending review.
    ops(dir, "contract-set", "--account", "a", "--password-ref", "secret://a-login");
    const a = readPolicy(dir, "a");
    assert.deepEqual([a.status, a.policy.credential.kind], ["review-required", "realtimex-secret"]);
  });
});

test("a contract's own sign-in, null included, is what runs, checks and status use", () => {
  const blockless = core.parseContract("# Old shared text\n", "a");
  assert.deepEqual(core.contractCredential(blockless), NATIVE, "only a contract with no block yet inherits its Himalaya sign-in");
  const typedNull = core.parseContract(core.renderPolicyBlock(core.draftPolicy("a", { ageThresholdDays: 90 }, { reviewRequired: true })), "a");
  assert.equal(typedNull.status, "review-required");
  assert.equal(core.contractCredential(typedNull), null, "a block's null is kept, even while its review is pending");
  assert.equal(core.effectivePolicy({ mode: "report-only" }, typedNull).credential, null);
  const invalid = core.parseContract("```mailkeeper-policy\n{\n```\n", "a");
  assert.equal(core.contractCredential(invalid), null, "an unreadable contract gets no fallback");
});

test("a one-off check sign-in doesn't make a contract's missing sign-in current", async () => {
  await withStanzas(["a"], async () => {
    setMailbox(["a"]);
    const { service, dir, workspace } = harness({ config: { EMAIL_ACCOUNTS: ["a"] } });
    await service.provision(workspace);
    assert.equal(readPolicy(dir, "a").policy.credential, null);
    assert.equal(ops(dir, "check", "--account", "a", "--native").ok, true);
    const status = ops(dir, "status").inboxes[0];
    assert.deepEqual([status.lastCheck.ok, status.lastCheck.current, status.setupComplete], [true, false, false]);
    assert.equal(readPolicy(dir, "a").policy.credential, null, "check never rewrites the contract");
  });
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

test("the run list carries each inbox's read coverage, from fixed values only", async () => {
  setMailbox(["work", "home"]);
  const { service, workspace } = harness({ config: { EMAIL_ACCOUNTS: ["work", "home"] } });
  await service.submitRun(workspace, {
    runId: "run-1",
    outcome: "blocked",
    accounts: {
      work: { outcome: "completed", coverage: { complete: true, stopReason: null, inboxRead: 42, folder: "Receipts" } },
      home: { outcome: "partial", coverage: { complete: false, stopReason: "budget", inboxRead: 1000, code: "x" } },
      odd: { outcome: "all good", coverage: { complete: "yes", stopReason: "<b>", inboxRead: -1 } },
    },
  });
  const [run] = (await service.status(workspace)).recentRuns;
  assert.equal(run.outcome, "blocked");
  assert.deepEqual(run.inboxes, {
    work: { outcome: "completed", readComplete: true, stopReason: null, inboxRead: 42, folder: "Receipts" },
    home: { outcome: "partial", readComplete: false, stopReason: "budget", inboxRead: 1000, folder: null },
    odd: { outcome: null, readComplete: false, stopReason: null, inboxRead: null, folder: null },
  });
});

test("server undo points to the workspace chat", async () => {
  setMailbox(["work"]);
  const { service, workspace } = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  await service.submitRun(workspace, { runId: "7f3a", outcome: "completed" });
  await assert.rejects(service.undoRun(workspace, { runId: "7f3a" }, { id: 1 }), { code: "MAILKEEPER_TERMINAL_REQUIRED" });
});

function runFixture() {
  setMailbox(["work"]);
  const h = harness({ config: { EMAIL_ACCOUNTS: ["work"] } });
  const state = path.join(h.dir, ".mailkeeper");
  fs.mkdirSync(path.join(state, "runs"), { recursive: true });
  fs.mkdirSync(path.join(state, "outbox"), { recursive: true });
  const lock = path.join(state, "run.lock");
  return {
    ...h,
    lock,
    active: () => h.store.get("ws-7-active") || null,
    // An admitted run: the marker, the helper's file guard and its journal.
    start(runId, heartbeatRunId, journal = {}) {
      h.store.set("ws-7-active", { runId, heartbeatRunId, startedAt: new Date().toISOString() });
      fs.writeFileSync(lock, JSON.stringify({ runId }));
      const file = path.join(state, "runs", `${runId}.json`);
      const valid = { schemaVersion: 2, runId, requested: ["work"], accounts: {}, actions: [], uncertain: [], pending: null };
      fs.writeFileSync(file, typeof journal === "string" ? journal : JSON.stringify({ ...valid, ...journal }));
    },
    receipt(runId) {
      fs.writeFileSync(path.join(state, "outbox", `${runId}.json`), JSON.stringify({ runId, outcome: "blocked" }));
    },
    end(heartbeatRunId, { state: executorState = "task_completed", dispatch = { success: true, managed: false, reason: "dispatch_not_found" } } = {}) {
      return h.service.recordHeartbeatLifecycle({ workspace: { id: 7 }, dispatch, event: { state: executorState, heartbeatRunId } });
    },
  };
}

test("a person's Run that ends releases the next Run and chat; only its own occurrence can end it", async () => {
  const f = runFixture();
  f.start("r1", "hb-1");
  await f.end("hb-1", { state: "task_blocked" });
  assert.equal(f.active(), null, "marker released");
  assert.equal(fs.existsSync(f.lock), false, "guard released, so chat begin can start");
  const next = await f.service.admitHeartbeat({ workspace: { id: 7 }, trigger: "manual", heartbeatRunId: "hb-2" });
  assert.ok(next.mailkeeperRunId, "the next Run is admitted");

  // A crash before submit: the session exits, no receipt. Cleanup only.
  f.start("r3", "hb-3");
  await f.end("hb-3", { state: "session_exited" });
  assert.deepEqual([f.active(), fs.existsSync(f.lock)], [null, false]);
  assert.equal(f.store.get("ws-7-run-r3") ?? null, null, "no receipt is invented for a crashed run");

  // A dispatched (scheduled) run: the dispatch is recorded and the executor reports its end.
  f.start("r4", "hb-4");
  await f.end("hb-4", { dispatch: { success: true, managed: true, status: "completed" } });
  assert.equal(f.active(), null);
  // An explicit exit without an exit code: the host leaves it delivery_unknown, but the session ended.
  f.start("r5", "hb-5");
  await f.end("hb-5", { state: "session_exited", dispatch: { success: true, managed: true, status: "delivery_unknown", resolutionRequired: true } });
  assert.deepEqual([f.active(), fs.existsSync(f.lock)], [null, false]);
});

test("lifecycle events that don't end this occurrence change nothing", async () => {
  const f = runFixture();
  f.start("r1", "hb-1");
  const untouched = () => assert.deepEqual([f.active()?.runId, fs.existsSync(f.lock)], ["r1", true]);
  await f.end("hb-old");
  untouched();
  await f.end("");
  untouched();
  for (const state of ["session_active", "task_started", "launch_received", "resume_failed", "write_failed", "activity_event_persisted"]) {
    await f.end("hb-1", { state });
    untouched();
  }
  await f.end("hb-1", { dispatch: { success: true, managed: false, reason: "non_state_event" } });
  untouched();
  await f.end("hb-1", { state: "task_completed", dispatch: { success: true, managed: true, status: "running" } });
  untouched(); // contradictory: the host still has the dispatch running
  await f.end("hb-1", { dispatch: { success: false, managed: true, reason: "stale_fence" } });
  untouched();
  // A final dispatch status isn't an end event on its own.
  await f.end("hb-1", { state: "delivery_unknown", dispatch: { success: true, managed: true, status: "delivery_unknown", resolutionRequired: true } });
  untouched();
  for (const state of ["session_stale", "task_needs_input"]) {
    await f.end("hb-1", { state, dispatch: { success: true, managed: true, status: "failed" } });
    untouched();
  }
  await f.end("hb-1", { state: "resume_failed", dispatch: { success: true, managed: true, status: "completed", duplicate: true } });
  untouched();
});

test("receipts end only their own run; a duplicate reconciles its own stale marker", async () => {
  const f = runFixture();
  f.start("new-run", "hb-new");
  await f.service.submitRun(f.workspace, { runId: "old-run", outcome: "blocked" });
  assert.equal(f.active()?.runId, "new-run", "an old receipt never clears a newer run");
  assert.equal(fs.existsSync(f.lock), true);

  await f.service.submitRun(f.workspace, { runId: "new-run", outcome: "completed" });
  assert.equal(f.active(), null);
  f.store.set("ws-7-active", { runId: "new-run", heartbeatRunId: "hb-new", startedAt: new Date().toISOString() });
  const again = await f.service.submitRun(f.workspace, { runId: "new-run", outcome: "completed" });
  assert.deepEqual([again.reused, f.active()], [true, null], "the duplicate clears its own stale marker");
});

test("a submitted receipt admits the next Run, and a late event from that run can't release it", async () => {
  const f = runFixture();
  f.start("a", "hb-a");
  f.receipt("a");
  const b = await f.service.admitHeartbeat({ workspace: { id: 7 }, trigger: "manual", heartbeatRunId: "hb-b" });
  assert.ok(b.mailkeeperRunId, "A's receipt is ingested before the in-flight check");
  fs.writeFileSync(f.lock, JSON.stringify({ runId: b.mailkeeperRunId }));
  await f.end("hb-a");
  assert.deepEqual([f.active()?.runId, JSON.parse(fs.readFileSync(f.lock, "utf8")).runId], [b.mailkeeperRunId, b.mailkeeperRunId]);
});

test("the guard stays for pending, uncertain or unreadable journals", async () => {
  for (const [name, journal] of [
    ["pending", { pending: { account: "work" } }],
    ["uncertain", { uncertain: [{ account: "work" }] }],
    ["corrupt", "{"],
    ["null", "null"],
    ["empty object", "{}"],
    ["array", "[]"],
    ["another run's journal", { runId: "someone-else" }],
    ["uncertain as an object", { uncertain: { account: "work" } }],
    ["no schema version", { schemaVersion: undefined }],
    ["pending missing", { pending: undefined }],
  ]) {
    const f = runFixture();
    f.start("r1", "hb-1", journal);
    await f.end("hb-1");
    assert.equal(fs.existsSync(f.lock), true, `${name}: guard kept`);
  }
  const f = runFixture();
  f.start("r1", "hb-1");
  fs.rmSync(path.join(path.dirname(f.lock), "runs", "r1.json"));
  await f.end("hb-1");
  assert.equal(fs.existsSync(f.lock), false, "no journal at all: the run ended before begin");
});

test("each matching lifecycle event records the executor's host identity, never erasing it", async () => {
  const f = runFixture();
  f.start("r1", "hb-1");
  const event = (heartbeatRunId, fields, state = "session_started") =>
    f.service.recordHeartbeatLifecycle({ workspace: { id: 7 }, dispatch: { success: true, managed: false, reason: "dispatch_not_found" }, event: { state, heartbeatRunId, ...fields } });
  const owners = () => (f.active()?.owners || []).map(({ runtimeSessionId, ptySessionId }) => ({ runtimeSessionId, ptySessionId }));
  const sidecar = path.join(path.dirname(f.lock), "runs", "r1.owner.json");

  await event("hb-1", { runtimeSessionId: "cli-agent:p1" });
  assert.deepEqual(owners(), [{ runtimeSessionId: "cli-agent:p1", ptySessionId: null }], "a nonterminal event is enough");
  await event("hb-1", { runtimeSessionId: "cli-agent:p1", ptySessionId: "p1" });
  assert.deepEqual(owners(), [{ runtimeSessionId: "cli-agent:p1", ptySessionId: "p1" }], "a later event fills a missing field");
  await event("hb-1", {});
  await event("hb-1", { ptySessionId: "p1" });
  assert.deepEqual(owners(), [{ runtimeSessionId: "cli-agent:p1", ptySessionId: "p1" }], "absent fields never erase known ones");
  await event("hb-other", { runtimeSessionId: "cli-agent:x", ptySessionId: "x" });
  assert.equal(owners().length, 1, "another occurrence's identity is ignored");
  await event("hb-1", { runtimeSessionId: "cli-agent:p2", ptySessionId: "p2" });
  assert.deepEqual(owners().map((owner) => owner.ptySessionId), ["p1", "p2"], "a fallback session is added, not substituted");
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")).owners.map((owner) => owner.ptySessionId), ["p1", "p2"]);

  await event("hb-1", { ptySessionId: "p2" }, "task_completed");
  assert.equal(f.active(), null, "the end event still ends the run");
  assert.equal(JSON.parse(fs.readFileSync(sidecar, "utf8")).runId, "r1", "the owner record stays with the run's journal");
});

test("a failed owner-file write is repaired when the same event repeats", async () => {
  const f = runFixture();
  f.start("r1", "hb-1");
  const sidecar = path.join(path.dirname(f.lock), "runs", "r1.owner.json");
  const event = () =>
    f.service.recordHeartbeatLifecycle({
      workspace: { id: 7 },
      dispatch: { success: true, managed: false, reason: "dispatch_not_found" },
      event: { state: "session_started", heartbeatRunId: "hb-1", runtimeSessionId: "cli-agent:p1", ptySessionId: "p1" },
    });
  fs.mkdirSync(path.join(sidecar, "blocked"), { recursive: true }); // the first write can't replace a directory
  await assert.rejects(event());
  assert.equal(f.active().owners, undefined, "the marker isn't updated ahead of the owner file");
  fs.rmSync(sidecar, { recursive: true });
  await event();
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")).owners.map((owner) => owner.ptySessionId), ["p1"]);
  assert.deepEqual(f.active().owners.map((owner) => owner.ptySessionId), ["p1"]);
  fs.rmSync(sidecar);
  await event();
  assert.equal(fs.existsSync(sidecar), true, "an identical event restores a missing owner file");
});

test("readAdmission is read-only and reports begin evidence without inferring a stop", async () => {
  const f = runFixture();
  const state = path.dirname(f.lock);
  f.store.set("ws-7-active", { runId: "r1", heartbeatRunId: "hb-1", trigger: "manual", startedAt: new Date().toISOString() });
  f.receipt("old-run");
  const snapshot = () => [JSON.stringify(f.active()), fs.existsSync(f.lock), fs.readdirSync(path.join(state, "outbox")).join(",")];
  const before = snapshot();

  let view = await f.service.readAdmission(f.workspace);
  assert.deepEqual([view.state, view.runId, view.trigger, view.begin], ["held", "r1", "manual", "not_observed"], "a marker with no journal");
  await f.service.readAdmission(f.workspace);
  assert.deepEqual(snapshot(), before, "repeated reads leave the outbox, marker and guard unchanged");

  fs.writeFileSync(f.lock, JSON.stringify({ runId: "r1" }));
  assert.equal((await f.service.readAdmission(f.workspace)).begin, "observed", "its guard is held");
  fs.rmSync(f.lock);
  for (const bytes of ["{}", "not json", JSON.stringify({ runId: "r2" })]) {
    fs.writeFileSync(path.join(state, "runs", "r1.json"), bytes);
    assert.equal((await f.service.readAdmission(f.workspace)).begin, "unknown", `a file that isn't r1's journal: ${bytes}`);
  }
  fs.writeFileSync(path.join(state, "runs", "r1.json"), JSON.stringify({ runId: "r1", actions: [] }));
  view = await f.service.readAdmission(f.workspace);
  assert.deepEqual([view.state, view.begin], ["held", "observed"], "a journal never hides the hold");

  f.store.set("ws-7-active", { runId: "r1", startedAt: new Date(Date.now() - 7 * 3600 * 1000).toISOString() });
  assert.equal((await f.service.readAdmission(f.workspace)).state, "clear", "past the shared admission window");
});

test("the admission projection follows the store through admission, end, stale events and failures", async () => {
  const f = runFixture();
  const projection = path.join(path.dirname(f.lock), "admission.json");
  const read = () => JSON.parse(fs.readFileSync(projection, "utf8"));

  const a = await f.service.admitHeartbeat({ workspace: { id: 7 }, trigger: "manual", heartbeatRunId: "hb-a" });
  assert.deepEqual([read().state, read().runId, read().trigger], ["held", a.mailkeeperRunId, "manual"]);
  assert.equal("begin" in read(), false, "the projection carries the hold, not a liveness claim");

  // A's receipt admits B; a late end event from A can't clear B's projection.
  f.receipt(a.mailkeeperRunId);
  const b = await f.service.admitHeartbeat({ workspace: { id: 7 }, trigger: "scheduled", heartbeatRunId: "hb-b" });
  await f.end("hb-a");
  assert.deepEqual([read().state, read().runId], ["held", b.mailkeeperRunId]);

  // A stale clear copy can outlive a new admission whose write failed: the
  // helper reads it as last observed and unconfirmed, never as a promise.
  await f.end("hb-b");
  fs.rmSync(projection);
  fs.mkdirSync(path.join(projection, "blocked"), { recursive: true });
  const c = await f.service.admitHeartbeat({ workspace: { id: 7 }, trigger: "manual", heartbeatRunId: "hb-c" });
  assert.ok(c.mailkeeperRunId, "the admission still stands when its projection write fails");
  fs.rmSync(projection, { recursive: true });
  fs.writeFileSync(projection, JSON.stringify({ schemaVersion: 1, state: "clear", observedAt: new Date().toISOString() }));
  await f.service.status(f.workspace);
  assert.deepEqual([read().state, read().runId], ["held", c.mailkeeperRunId], "the next change rebuilds it from the store");
  await f.end("hb-c");

  // A failed projection write leaves a stale copy; the next change repairs it.
  const d = await f.service.admitHeartbeat({ workspace: { id: 7 }, trigger: "scheduled", heartbeatRunId: "hb-d" });
  assert.equal(read().runId, d.mailkeeperRunId);
  fs.rmSync(projection);
  fs.mkdirSync(path.join(projection, "blocked"), { recursive: true });
  await f.end("hb-d");
  assert.equal(f.active(), null, "the end still ends the run");
  fs.rmSync(projection, { recursive: true });
  await f.service.status(f.workspace);
  assert.equal(read().state, "clear", "repaired on the next change");

  // Plugin start rebuilds it from the store, whatever the file says.
  f.store.set("ws-7-active", { runId: "r9", heartbeatRunId: "hb-9", startedAt: new Date().toISOString() });
  fs.writeFileSync(projection, "corrupt");
  await f.service.reconcileAdmission(f.workspace);
  assert.deepEqual([read().state, read().runId], ["held", "r9"]);
});

test("concurrent admissions start at most one run", async () => {
  const f = runFixture();
  const results = await Promise.all(
    ["hb-a", "hb-b", "hb-c"].map((heartbeatRunId) => f.service.admitHeartbeat({ workspace: { id: 7 }, trigger: "manual", heartbeatRunId }))
  );
  assert.equal(results.filter((result) => result.mailkeeperRunId).length, 1);
  assert.equal(results.filter((result) => result.skipLaunch).length, 2);
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
