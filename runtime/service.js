"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { hostFor } = require("./host");
const { CADENCE_MANUAL, resolveProfileConfig } = require("./config");
const mailbox = require("./mailbox");
const core = require("../skills/mailbox-cleanup/scripts/mailkeeper-core");

const PLUGIN_ID = "com.realtimex.mailkeeper";
const CONTRACT_TEMPLATE = path.join(__dirname, "..", "skills", "mailbox-cleanup", "templates", "MAILBOX.md");
const LEGACY_CONTRACT = "MAILBOX.md";
const SKILL_CLI = ".agents/skills/mailbox-cleanup/scripts/mailbox-ops.js";
const { shellQuote } = core;
const MANIFEST = require("../realtimex.plugin.json");
const THREAD_NAME = "MailKeeper maintenance";

/** The settings label for a cadence ("Daily"), or the raw value for a custom one. */
function cadenceLabel(cadence) {
  const field = MANIFEST.configSchema.find((entry) => entry.key === "CADENCE");
  return field?.options?.find((option) => option.value === cadence)?.label || `Every ${cadence}`;
}

function codedError(message, code, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function text(value, max = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function taskIdentity(workspaceId) {
  return `mailkeeper-maintenance-${workspaceId}`;
}

function threadKey(workspaceId) {
  return `mailkeeper-maintenance-${workspaceId}`;
}

/**
 * Resolve `relative` under `root`, refusing a path that escapes it or passes
 * through an existing symlink, so a planted link cannot redirect a write.
 */
function safeWorkspacePath(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw codedError("Path escapes the workspace", "MAILKEEPER_CONTRACT_INVALID", 409);
  }
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw codedError("Path passes through a symlink", "MAILKEEPER_CONTRACT_INVALID", 409);
    }
  }
  return target;
}

/** Write JSON atomically and owner-only: temp file in the same directory, then rename. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}

// The end of a heartbeat occurrence, as the host reports it to the managed
// lifecycle hook (server/models/heartbeatSource.js recordExecutorLifecycle and
// server/utils/heartbeat/executorLifecycle.js). Both a dispatched run
// (`managed: true`) and a person's Run (`reason: "dispatch_not_found"`) need
// an explicit executor end event: a final dispatch status alone isn't one
// (delivery_unknown is unresolved, task_needs_input and session_stale map to
// failed, and a duplicate final status comes back for any later event).
const EXECUTOR_END_STATES = new Set([
  "task_completed",
  "task_blocked",
  "task_failed",
  "session_exited",
  "session_failed",
  "launch_failed",
]);

function heartbeatOccurrenceEnded(context) {
  const dispatch = context?.dispatch || {};
  if (dispatch.success !== true) return false;
  if (dispatch.managed !== true && dispatch.reason !== "dispatch_not_found") return false;
  if (dispatch.managed === true && String(dispatch.status || "").toLowerCase() === "running") return false;
  const event = context?.event || {};
  return EXECUTOR_END_STATES.has(String(event.state || event.status || "").trim().toLowerCase());
}

/**
 * The host-issued executor identity on a lifecycle event (runtime session and
 * PTY session), or null when the event carries neither.
 */
function executorOwner(event) {
  const pick = (value) => (typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value) ? value : null);
  const runtimeSessionId = pick(event?.runtimeSessionId);
  const ptySessionId = pick(event?.ptySessionId);
  return runtimeSessionId || ptySessionId ? { runtimeSessionId, ptySessionId } : null;
}

/**
 * Whether a run journal proves that run `runId` left no move pending or in
 * doubt: it must be this run's journal, in the shape the helper writes.
 */
function journalAllowsRelease(run, runId) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return false;
  if (run.schemaVersion !== 2 || run.runId !== runId) return false;
  if (!Array.isArray(run.requested) || !Array.isArray(run.actions) || !Array.isArray(run.uncertain)) return false;
  if (!run.accounts || typeof run.accounts !== "object" || Array.isArray(run.accounts)) return false;
  return run.pending === null && run.uncertain.length === 0;
}

class MailKeeperService {
  constructor(api) {
    this.api = api;
    this.host = hostFor(api);
    this.store = api.getStore();
    this.provisioningQueues = new Map();
    this.runStateQueues = new Map();
  }

  // -------------------------------------------------------------------------
  // Store keys (all per-workspace; plugin store is already plugin-scoped)
  // -------------------------------------------------------------------------

  profileKey(workspace) {
    return `ws-${workspace.id}-profile`;
  }
  rulesKey(workspace) {
    return `ws-${workspace.id}-rules`;
  }
  runKey(workspace, runId) {
    return `ws-${workspace.id}-run-${runId}`;
  }
  runIndexKey(workspace) {
    return `ws-${workspace.id}-runs`;
  }
  activeRunKey(workspace) {
    return `ws-${workspace.id}-active`;
  }
  inboxKeysKey(workspace) {
    return `ws-${workspace.id}-inbox-keys`;
  }
  migrationKey(workspace) {
    return `ws-${workspace.id}-migration`;
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  profileConfig(workspace) {
    // Read fresh every time: workspace saves do not reload the plugin. Pass the
    // id as well as the slug: the host resolves ids directly, while slugs go
    // through a cache that can lag a storage-user switch.
    const raw =
      this.api.getConfig({ workspaceId: workspace.id, workspaceSlug: workspace.slug }) || {};
    return resolveProfileConfig(raw);
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /** Account names from the resolved Himalaya config; never authenticates. */
  async discover() {
    const himalayaConfig = mailbox.resolveConfig();
    try {
      const accounts = await mailbox.listAccounts(himalayaConfig);
      return { himalayaConfig, accounts, code: null };
    } catch (error) {
      return { himalayaConfig, accounts: null, code: error.code || "MAILKEEPER_OPERATION_FAILED" };
    }
  }

  // -------------------------------------------------------------------------
  // Provisioning
  // -------------------------------------------------------------------------

  /**
   * Provision (or disable) one workspace. Each call first records a new
   * pending attempt, before any work that can fail and before waiting for an
   * earlier call on the same workspace, so the CLI never reads an older
   * schedule as current. Calls on one workspace then run one at a time, and
   * an attempt publishes its outcome only while it is still the latest.
   */
  async provision(workspace) {
    return this.serializeProvisioning(workspace, (attempt) => this.provisionAttempt(workspace, attempt));
  }

  async disable(workspace) {
    return this.serializeProvisioning(workspace, (attempt) => this.disableAttempt(workspace, attempt));
  }

  serializeProvisioning(workspace, work) {
    const attempt = crypto.randomUUID();
    this.recordProvisioning(workspace, attempt, "pending");
    const key = String(workspace.id);
    const prior = this.provisioningQueues.get(key) || Promise.resolve();
    const run = prior.then(() => work(attempt));
    const settled = run.catch(() => {});
    this.provisioningQueues.set(key, settled);
    settled.then(() => {
      if (this.provisioningQueues.get(key) === settled) this.provisioningQueues.delete(key);
    });
    return run;
  }

  async provisionAttempt(workspace, attempt) {
    const { config, errors } = this.profileConfig(workspace);
    const profile = (await this.store.get(this.profileKey(workspace))) || {};

    if (errors.length) {
      // Not ready: make sure nothing runs, but keep prior state for repair.
      await this.host.heartbeat.removeManagedTask(workspace, {
        id: taskIdentity(workspace.id),
      });
      await this.store.set(this.profileKey(workspace), {
        ...profile,
        state: "config_invalid",
        errors,
        updatedAt: new Date().toISOString(),
      });
      this.api.log?.warn?.("MailKeeper profile not ready", {
        workspace: workspace.slug,
        errors,
      });
      this.publishProvisioning(workspace, attempt, "config_invalid");
      return { state: "config_invalid", errors };
    }

    // Provisioned means scheduled and configured, not "IMAP verified": the
    // terminal checks each inbox when a run starts.
    const discovery = await this.discover();
    const thread = await this.host.workspaces.ensureThread(workspace, {
      key: threadKey(workspace.id),
      name: THREAD_NAME,
    });
    const inboxes = await this.syncInboxes(workspace, config, discovery, profile);
    const rules = await this.ensureRules(workspace, config, profile);

    const heartbeat = await this.host.heartbeat.upsertManagedTask(workspace, {
      id: taskIdentity(workspace.id),
      name: "MailKeeper maintenance",
      // Manual keeps the task (a row Run still works) but never schedules it.
      interval: config.cadence === CADENCE_MANUAL ? "disabled" : config.cadence,
      executor: "agent",
      agent: config.agent,
      ...(config.model ? { model: config.model } : {}),
      // Rewriting the whole task drops any effort key a previous save wrote.
      ...(Object.keys(config.effort.runtimeOptionValues).length
        ? { runtimeOptionValues: config.effort.runtimeOptionValues }
        : {}),
      prompt: this.buildMaintenancePrompt(workspace, config, thread, rules, inboxes),
      threadSlug: thread.slug,
      useProvidedThreadSlug: true,
      directPrompt: true,
      resumeSession: false,
      autoCloseTerminalOnStop: true,
      promptArtifactCategory: "mailkeeper-maintenance",
      promptArtifactRetention: "durable",
    });
    const settings = await this.host.heartbeat.readSettings(workspace);
    this.syncRulesFile(workspace, config, rules, discovery, inboxes, attempt, {
      taskId: taskIdentity(workspace.id),
      cadence: config.cadence,
      cadenceLabel: cadenceLabel(config.cadence),
      manual: config.cadence === CADENCE_MANUAL,
      heartbeatEnabled: settings?.enabled !== false,
      paused: heartbeat.explicitlyPaused === true || settings?.enabled === false,
      activeHours: settings?.activeHours || null,
      timezone: settings?.timezone || null,
      threadSlug: thread.slug,
      threadName: thread.name || THREAD_NAME,
    });

    const next = {
      state: heartbeat.explicitlyPaused ? "paused_by_heartbeat" : "ready",
      errors: [],
      warnings: config.effort.warning ? [config.effort.warning] : [],
      emailAccounts: config.emailAccounts,
      inboxes: Object.fromEntries(
        Object.entries(inboxes).map(([name, inbox]) => [name, { key: inbox.key, status: inbox.status, code: inbox.code }])
      ),
      discovery: { code: discovery.code, configSource: discovery.himalayaConfig.source },
      effort: { requested: config.effort.requested, forwarded: config.effort.forwarded },
      mode: config.mode,
      threadId: thread.id,
      threadSlug: thread.slug,
      taskId: taskIdentity(workspace.id),
      hostBackend: this.host.backend,
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(this.profileKey(workspace), next);
    this.publishProvisioning(workspace, attempt, "ready");
    return next;
  }

  async disableAttempt(workspace, attempt) {
    await this.host.heartbeat.removeManagedTask(workspace, {
      id: taskIdentity(workspace.id),
    });
    const profile = (await this.store.get(this.profileKey(workspace))) || {};
    await this.store.set(this.profileKey(workspace), {
      ...profile,
      state: "disabled",
      updatedAt: new Date().toISOString(),
    });
    this.publishProvisioning(workspace, attempt, "disabled");
    // Thread, contracts, rules and run receipts are intentionally kept:
    // they are the user's audit trail and survive re-enable.
  }

  async disableAll() {
    const workspaces = await this.host.workspaces.listEnabledForPlugin();
    for (const workspace of workspaces) await this.disable(workspace);
  }

  async activateAll() {
    const workspaces = await this.host.workspaces.listEnabledForPlugin();
    for (const workspace of workspaces) {
      try {
        await this.provision(workspace);
      } catch (error) {
        this.api.log?.error?.(`MailKeeper boot provision failed for ${workspace.slug}`, {
          workspace: workspace.slug,
          code: error?.code || null,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Inbox contracts
  // -------------------------------------------------------------------------

  /**
   * One contract per selected inbox at mailboxes/<key>/MAILBOX.md. A contract
   * is created only when absent and never rewritten afterwards; removing an
   * inbox from the selection leaves its contract in place for later reuse.
   */
  async syncInboxes(workspace, config, discovery, profile) {
    const root = workspace.workingDirectory;
    const keys = (await this.store.get(this.inboxKeysKey(workspace))) || {};
    const migration = await this.ensureMigration(workspace, config, profile);
    const discovered = discovery.accounts ? new Set(discovery.accounts.map((entry) => entry.name)) : null;
    const inboxes = Object.create(null);

    for (const name of config.emailAccounts) {
      const key = core.accountKey(name);
      const relative = core.contractRelativePath(key);
      const inbox = { key, contract: relative, status: "missing", code: null, migrated: null };
      core.setOwn(inboxes, name, inbox);

      if (Object.prototype.hasOwnProperty.call(keys, key) && keys[key] !== name) {
        inbox.status = "invalid";
        inbox.code = "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH";
        continue;
      }
      let file;
      try {
        file = safeWorkspacePath(root, relative);
      } catch (error) {
        inbox.status = "invalid";
        inbox.code = error.code;
        continue;
      }

      if (!fs.existsSync(file)) {
        if (!discovered) {
          inbox.code = discovery.code;
          continue;
        }
        if (!discovered.has(name)) {
          inbox.code = "MAILKEEPER_ACCOUNT_NOT_FOUND";
          continue;
        }
        inbox.migrated = this.seedContract(root, file, name, config, migration);
      }
      keys[key] = name;
      const parsed = core.parseContract(fs.readFileSync(file, "utf8"), name);
      inbox.status = parsed.status;
      inbox.code = parsed.code;
      if (!inbox.code && discovered && !discovered.has(name)) inbox.code = "MAILKEEPER_ACCOUNT_NOT_FOUND";
    }

    await this.store.set(this.inboxKeysKey(workspace), keys);
    return inboxes;
  }

  /**
   * Record, once, how a v0.1.1 root MAILBOX.md maps onto per-inbox contracts.
   * The root file itself is never modified or moved.
   */
  async ensureMigration(workspace, config, profile) {
    const existing = await this.store.get(this.migrationKey(workspace));
    if (existing) return existing;
    const legacy = path.join(workspace.workingDirectory, LEGACY_CONTRACT);
    let stat = null;
    try {
      stat = fs.lstatSync(legacy);
    } catch {
      /* no legacy contract */
    }
    const record = stat?.isFile()
      ? {
          legacy: LEGACY_CONTRACT,
          legacyDigest: core.digest(fs.readFileSync(legacy, "utf8")),
          previouslySelected: Array.isArray(profile.emailAccounts) && profile.emailAccounts.length
            ? profile.emailAccounts
            : config.emailAccounts,
          recordedAt: new Date().toISOString(),
        }
      : { legacy: null, previouslySelected: [], recordedAt: new Date().toISOString() };
    await this.store.set(this.migrationKey(workspace), record);
    return record;
  }

  seedContract(root, file, name, config, migration) {
    const fromLegacy = Boolean(migration.legacy) && migration.previouslySelected.includes(name);
    let content;
    let migrated = null;
    if (fromLegacy && migration.previouslySelected.length === 1) {
      // The only inbox the old shared contract governed: carry its full text
      // over. Without a settings block it stays report-only until reviewed.
      const legacy = fs.readFileSync(path.join(root, migration.legacy), "utf8");
      content = [
        legacy.trimEnd(),
        "",
        "## About this copy",
        "",
        `This contract was copied from your old shared MAILBOX.md, which is kept for reference but no longer used. Until you review it with the agent, MailKeeper only reports for ${name} and moves nothing. Ask the agent to “review the ${name} contract.”`,
        "",
      ].join("\n");
      migrated = "copied";
    } else {
      const policy = core.draftPolicy(name, config, { reviewRequired: fromLegacy });
      const note = fromLegacy
        ? `\nYour old MAILBOX.md, which applied to all inboxes, is kept at the workspace root for reference but is no longer used. Review with the agent how its preferences apply to ${name}; until then MailKeeper only reports for this inbox.\n`
        : "";
      content = core.renderContract(fs.readFileSync(CONTRACT_TEMPLATE, "utf8"), {
        account: name,
        protectedDomains: config.protectedDomains,
        policy,
        note,
      });
      migrated = fromLegacy ? "review" : null;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    safeWorkspacePath(root, path.relative(root, file));
    try {
      fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error; // created concurrently: keep theirs
    }
    return migrated;
  }

  /**
   * `.mailkeeper/rules.json` is the contract between the plugin and the
   * workspace-side `mailbox-ops.js`: workspace caps, the pinned Himalaya
   * config, inbox keys, and account-scoped approved rules. It is a generated
   * view, rewritten on every provision; the contracts stay the user's policy.
   */
  syncRulesFile(workspace, config, rules, discovery, inboxes, attempt, schedule) {
    const target = safeWorkspacePath(workspace.workingDirectory, path.join(".mailkeeper", "rules.json"));
    writeJsonAtomic(target, {
      schemaVersion: 2,
      revision: rules.revision,
      writtenAt: new Date().toISOString(),
      // The provisioning attempt that wrote this file; see recordProvisioning.
      provisionAttempt: attempt,
      himalayaConfig: {
        paths: discovery.himalayaConfig.paths,
        target: discovery.himalayaConfig.target,
        source: discovery.himalayaConfig.source,
      },
      config: {
        emailAccounts: config.emailAccounts,
        mode: config.mode,
        modeCeiling: config.modeCeiling,
        ageThresholdDays: config.ageThresholdDays,
        aggressiveness: config.aggressiveness,
        promotablePasses: config.promotablePasses,
        autoFolderPrefix: config.autoFolderPrefix,
        protectedDomains: config.protectedDomains,
        vipSenders: config.vipSenders,
        agent: config.agent,
        model: config.model || null,
        effort: {
          requested: config.effort.requested,
          forwarded: config.effort.forwarded,
          warning: config.effort.warning,
        },
      },
      // As of this provision; settings saves and repairs refresh it.
      schedule,
      accounts: Object.fromEntries(
        Object.entries(inboxes).map(([name, inbox]) => [name, { key: inbox.key, contract: inbox.contract }])
      ),
      legacyContract: fs.existsSync(path.join(workspace.workingDirectory, LEGACY_CONTRACT)) ? LEGACY_CONTRACT : null,
      promoted: rules.promoted.filter((rule) => typeof rule.account === "string"),
    });
  }

  /**
   * The latest provisioning attempt and its outcome, for the workspace CLI:
   * `pending` from the moment an attempt is requested (and after one that
   * threw), then `config_invalid`, `disabled`, or `ready`. A ready outcome
   * vouches only for the rules.json whose `provisionAttempt` is this attempt.
   */
  recordProvisioning(workspace, attempt, state) {
    if (!workspace?.workingDirectory || !fs.existsSync(workspace.workingDirectory)) return;
    const target = safeWorkspacePath(workspace.workingDirectory, path.join(".mailkeeper", "provisioning.json"));
    writeJsonAtomic(target, { schemaVersion: 1, attempt, state, at: new Date().toISOString() });
  }

  /** Record an attempt's outcome unless a newer attempt has been requested since. */
  publishProvisioning(workspace, attempt, state) {
    const file = path.join(workspace.workingDirectory, ".mailkeeper", "provisioning.json");
    let latest = null;
    try {
      latest = JSON.parse(fs.readFileSync(file, "utf8")).attempt;
    } catch {
      latest = null;
    }
    if (latest !== attempt) return false;
    this.recordProvisioning(workspace, attempt, state);
    return true;
  }


  /**
   * Admission, lifecycle, receipts and status reads all touch the active run
   * marker, the receipt store and the file guard, so they run one at a time
   * per workspace. Public entry points queue here; the `...Locked` helpers
   * assume the queue is held and never queue again.
   */
  withRunState(workspace, work) {
    const key = String(workspace.id);
    const prior = this.runStateQueues.get(key) || Promise.resolve();
    const run = prior.then(work);
    const settled = run.catch(() => {});
    this.runStateQueues.set(key, settled);
    settled.then(() => {
      if (this.runStateQueues.get(key) === settled) this.runStateQueues.delete(key);
    });
    return run;
  }

  /** Clear the active run marker only if it is still `runId`'s. */
  async clearActiveRun(workspace, runId) {
    const active = await this.store.get(this.activeRunKey(workspace));
    if (!runId || active?.runId !== runId) return false;
    await this.store.set(this.activeRunKey(workspace), null);
    return true;
  }

  /**
   * Pick up receipts the agent queued in `.mailkeeper/outbox/` and record them.
   * Called on admission, heartbeat lifecycle events and status reads.
   */
  async ingestOutbox(workspace) {
    return this.withRunState(workspace, () => this.ingestOutboxLocked(workspace));
  }

  async ingestOutboxLocked(workspace) {
    const dir = path.join(workspace.workingDirectory, ".mailkeeper", "outbox");
    if (!fs.existsSync(dir)) return { ingested: 0 };
    let ingested = 0;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const full = path.join(dir, file);
      let body;
      try {
        body = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        this.api.log?.warn?.("MailKeeper receipt unreadable", { file });
        fs.renameSync(full, `${full}.invalid`);
        continue;
      }
      try {
        await this.submitRunLocked(workspace, body);
        fs.unlinkSync(full);
        ingested += 1;
      } catch (error) {
        this.api.log?.warn?.("MailKeeper receipt rejected", { file, code: error?.code || null });
        fs.renameSync(full, `${full}.rejected`);
      }
    }
    return { ingested };
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  /**
   * Approved rules are scoped to one inbox. A v0.1.1 rule without an account
   * is kept with that account only when the old profile had exactly one
   * inbox; otherwise it goes back to the suggestions, flagged for review,
   * rather than defaulting to whichever inbox happens to be first.
   */
  async ensureRules(workspace, config, profile = {}) {
    let rules = await this.store.get(this.rulesKey(workspace));
    if (!rules) {
      rules = {
        schemaVersion: 2,
        revision: 0,
        promoted: [],
        proposed: [],
        updatedAt: new Date().toISOString(),
      };
      await this.store.set(this.rulesKey(workspace), rules);
      return rules;
    }
    if (rules.schemaVersion === 2) return rules;

    const previous = Array.isArray(profile.emailAccounts) ? profile.emailAccounts : [];
    const soleAccount = previous.length === 1 ? previous[0] : null;
    const promoted = [];
    const proposed = [...(rules.proposed || [])].map((rule) =>
      typeof rule.account === "string" ? rule : { ...rule, reviewRequired: true }
    );
    for (const rule of rules.promoted || []) {
      if (typeof rule.account === "string") promoted.push(rule);
      else if (soleAccount) promoted.push({ ...rule, account: soleAccount, scopedFrom: "v0.1.1-single-account" });
      else proposed.push({ ...rule, reviewRequired: true, demotedReason: "legacy-unscoped" });
    }
    rules = {
      ...rules,
      schemaVersion: 2,
      promoted,
      proposed,
      revision: (rules.revision || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(this.rulesKey(workspace), rules);
    return rules;
  }

  /**
   * `human` is the verified interactive person from the route gate
   * ({ userId, source }); nothing here builds one from a bare user ID.
   */
  async promoteRule(workspace, body, human) {
    if (!human?.userId)
      throw codedError("Authenticated human required", "MAILKEEPER_HUMAN_REQUIRED", 403);
    const { config, errors } = this.profileConfig(workspace);
    if (errors.length)
      throw codedError(errors.join(" "), "MAILKEEPER_CONFIG_NOT_READY", 409);
    const rules = await this.ensureRules(workspace, config);
    const ruleId = text(body.ruleId, 120);
    const proposal = rules.proposed.find((entry) => entry.id === ruleId);
    if (!proposal)
      throw codedError(`Unknown proposed rule ${ruleId}`, "MAILKEEPER_RULE_UNKNOWN", 404);
    if (typeof proposal.account !== "string" || !config.emailAccounts.includes(proposal.account)) {
      throw codedError("Rule is not scoped to a selected inbox", "MAILKEEPER_RULE_NOT_PROMOTABLE", 409);
    }
    if (!config.promotablePasses.includes(proposal.pass)) {
      throw codedError(
        `Pass "${proposal.pass}" is not promotable at aggressiveness "${config.aggressiveness}"`,
        "MAILKEEPER_RULE_NOT_PROMOTABLE",
        409
      );
    }
    rules.proposed = rules.proposed.filter((entry) => entry.id !== ruleId);
    const { reviewRequired, demotedReason, ...rule } = proposal;
    rules.promoted.push({
      ...rule,
      promotedAt: new Date().toISOString(),
      promotedBy: human.userId,
    });
    rules.revision += 1;
    rules.updatedAt = new Date().toISOString();
    await this.store.set(this.rulesKey(workspace), rules);
    await this.provision(workspace); // refresh rules.json and the prompt
    return { ruleId, revision: rules.revision };
  }

  async demoteRule(workspace, body, human) {
    if (!human?.userId)
      throw codedError("Authenticated human required", "MAILKEEPER_HUMAN_REQUIRED", 403);
    const rules = await this.store.get(this.rulesKey(workspace));
    const ruleId = text(body.ruleId, 120);
    const rule = rules?.promoted?.find((entry) => entry.id === ruleId);
    if (!rule)
      throw codedError(`Unknown promoted rule ${ruleId}`, "MAILKEEPER_RULE_UNKNOWN", 404);
    rules.promoted = rules.promoted.filter((entry) => entry.id !== ruleId);
    rules.proposed.push({ ...rule, demotedAt: new Date().toISOString(), demotedBy: human.userId });
    rules.revision += 1;
    rules.updatedAt = new Date().toISOString();
    await this.store.set(this.rulesKey(workspace), rules);
    await this.provision(workspace);
    return { ruleId, revision: rules.revision };
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  /**
   * Record a run receipt the workspace helper queued in the outbox.
   * Idempotent on runId.
   */
  async submitRun(workspace, body) {
    return this.withRunState(workspace, () => this.submitRunLocked(workspace, body));
  }

  async submitRunLocked(workspace, body) {
    const runId = text(body.runId, 80);
    if (!runId) throw codedError("runId is required", "MAILKEEPER_RUN_INVALID", 400);
    const existing = await this.store.get(this.runKey(workspace, runId));
    if (existing) {
      // A repeated receipt only reconciles its own run's stale marker.
      await this.clearActiveRun(workspace, runId);
      return { runId, reused: true };
    }

    const outcome = text(body.outcome, 20);
    if (!["completed", "blocked", "failed"].includes(outcome)) {
      throw codedError(
        "outcome must be completed, blocked, or failed",
        "MAILKEEPER_RUN_INVALID",
        400
      );
    }
    const accounts =
      body.accounts && typeof body.accounts === "object" && !Array.isArray(body.accounts)
        ? body.accounts
        : {};
    const receipt = {
      runId,
      workspaceId: workspace.id,
      outcome,
      trigger: text(body.trigger, 20) || null,
      startedAt: text(body.startedAt, 40),
      finishedAt: new Date().toISOString(),
      rulesRevision: Number.isInteger(body.rulesRevision) ? body.rulesRevision : null,
      // Per inbox: outcome, fixed code, contract digest and effective mode.
      accounts,
      // Every confirmed move with its account, source and destination.
      actions: Array.isArray(body.actions) ? body.actions.slice(0, 5000) : [],
      // Moves whose result is unknown; never replayed automatically.
      uncertain: Array.isArray(body.uncertain) ? body.uncertain.slice(0, 200) : [],
      // Things found but not allowed to act on.
      proposals: Array.isArray(body.proposals) ? body.proposals.slice(0, 200) : [],
      // Urgency triage hits: never touched, always surfaced.
      urgent: Array.isArray(body.urgent) ? body.urgent.slice(0, 200) : [],
      effort: body.effort && typeof body.effort === "object" ? body.effort : null,
      summary: text(body.summary, 4000),
      undoneAt: null,
    };
    await this.store.set(this.runKey(workspace, runId), receipt);

    const index = (await this.store.get(this.runIndexKey(workspace))) || [];
    index.unshift({ runId, outcome, finishedAt: receipt.finishedAt, actions: receipt.actions.length });
    await this.store.set(this.runIndexKey(workspace), index.slice(0, 500));

    // Fold account-scoped suggestions into the rules ledger so a human can
    // approve them; a suggestion without an inbox is never recorded.
    const scoped = receipt.proposals.filter((proposal) => typeof proposal?.account === "string");
    if (scoped.length) {
      const { config } = this.profileConfig(workspace);
      const rules = await this.ensureRules(workspace, config);
      const known = new Set([
        ...rules.promoted.map((entry) => entry.id),
        ...rules.proposed.map((entry) => entry.id),
      ]);
      for (const proposal of scoped) {
        const id = text(proposal.id, 120) || core.ruleId(proposal);
        if (known.has(id)) continue;
        rules.proposed.push({ ...proposal, id, firstSeenRunId: runId });
        known.add(id);
      }
      rules.updatedAt = new Date().toISOString();
      await this.store.set(this.rulesKey(workspace), rules);
    }

    // A receipt ends only its own run: an older one never clears a newer run.
    await this.clearActiveRun(workspace, runId);
    return { runId, reused: false, actions: receipt.actions.length };
  }

  /**
   * Mailbox access needs the terminal credential path, which the plugin
   * server cannot borrow. Undo therefore always happens in the workspace chat.
   */
  async undoRun(workspace, body, user) {
    if (!user?.id)
      throw codedError("Authenticated human required", "MAILKEEPER_HUMAN_REQUIRED", 403);
    const runId = text(body.runId, 80);
    const receipt = await this.store.get(this.runKey(workspace, runId));
    if (!receipt) throw codedError(`Unknown run ${runId}`, "MAILKEEPER_RUN_UNKNOWN", 404);
    throw codedError(
      `Undo runs in the workspace chat. Ask the agent: “undo MailKeeper run ${runId}”.`,
      "MAILKEEPER_TERMINAL_REQUIRED",
      409
    );
  }

  // -------------------------------------------------------------------------
  // Options for the EMAIL_ACCOUNTS picker (optionsRoutePath: /accounts)
  // -------------------------------------------------------------------------

  async accountOptions() {
    const accounts = await mailbox.listAccounts();
    return {
      options: accounts.map((account) => ({
        value: account.name,
        label: account.name,
        description: [account.backend, account.isDefault ? "default" : ""]
          .filter(Boolean)
          .join(" · "),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async status(workspace) {
    await this.ingestOutbox(workspace);
    const { config, errors } = this.profileConfig(workspace);
    const profile = (await this.store.get(this.profileKey(workspace))) || null;
    const rules = (await this.store.get(this.rulesKey(workspace))) || null;
    const runs = (await this.store.get(this.runIndexKey(workspace))) || [];
    const heartbeat = await this.host.heartbeat.readSettings(workspace);
    return {
      workspace: { id: workspace.id, slug: workspace.slug },
      profile,
      config: {
        emailAccounts: config.emailAccounts,
        mode: config.mode,
        modeCeiling: config.modeCeiling,
        modeCappedByCeiling: config.modeCappedByCeiling,
        cadence: config.cadence,
        aggressiveness: config.aggressiveness,
        promotablePasses: config.promotablePasses,
        ageThresholdDays: config.ageThresholdDays,
        autoFolderPrefix: config.autoFolderPrefix,
        protectedDomains: config.protectedDomains,
        agent: config.agent,
        model: config.model || null,
        effort: {
          requested: config.effort.requested,
          forwarded: config.effort.forwarded,
          warning: config.effort.warning,
        },
      },
      errors,
      heartbeat,
      rules: rules
        ? {
            revision: rules.revision,
            promoted: rules.promoted,
            proposed: rules.proposed,
          }
        : null,
      recentRuns: runs.slice(0, 20),
      hostBackend: this.host.backend,
    };
  }

  // -------------------------------------------------------------------------
  // Heartbeat hooks
  // -------------------------------------------------------------------------

  /**
   * Scheduler admission. The host honours `{ skipLaunch, skipReason }`; every
   * other returned key is merged into the launch metadata the agent sees, which
   * is how RUN_ID reaches the maintenance prompt. Effort compatibility never
   * skips a run.
   */
  async admitHeartbeat(context) {
    const workspace = await this.host.workspaces.get({ id: context.workspace?.id });
    if (!workspace) {
      return { skipLaunch: true, skipReason: "workspace missing" };
    }
    const { config, errors } = this.profileConfig(workspace);
    if (errors.length) {
      return { skipLaunch: true, skipReason: `config_invalid: ${errors.join(" ")}` };
    }
    // Re-read the schedule: an occurrence queued before Manual was chosen
    // must not run. A person's row Run (trigger "manual") still does.
    if (config.cadence === CADENCE_MANUAL && context.trigger !== "manual") {
      return { skipLaunch: true, skipReason: "schedule is manual" };
    }
    return this.withRunState(workspace, async () => {
      // A run that submitted its receipt has ended, whatever the host reported.
      await this.ingestOutboxLocked(workspace);
      const active = await this.store.get(this.activeRunKey(workspace));
      if (active && Date.now() - Date.parse(active.startedAt) < 6 * 60 * 60 * 1000) {
        return { skipLaunch: true, skipReason: `run ${active.runId} still in flight` };
      }
      const runId = crypto.randomUUID();
      await this.store.set(this.activeRunKey(workspace), {
        runId,
        heartbeatRunId: context.heartbeatRunId || null,
        startedAt: new Date().toISOString(),
      });
      return { mailkeeperRunId: runId };
    });
  }

  async recordHeartbeatDispatch(context) {
    this.api.log?.info?.("MailKeeper maintenance dispatched", {
      workspace: context.workspace?.slug,
      heartbeatRunId: context.heartbeatRunId || null,
    });
  }

  /**
   * Lifecycle events of one heartbeat occurrence. Each event for the
   * occurrence the marker was admitted for (`event.heartbeatRunId`) records
   * the executor's host identity. Its end event then ingests its receipt and
   * releases its run guard (unless a move is pending or uncertain, or its
   * journal can't be read) and its active marker. Events for any other
   * occurrence do nothing.
   */
  async recordHeartbeatLifecycle(context) {
    const occurrence = String(context?.event?.heartbeatRunId || "").trim();
    if (!occurrence) return;
    const ended = heartbeatOccurrenceEnded(context);
    const owner = executorOwner(context.event);
    if (!ended && !owner) return;
    const workspace = await this.host.workspaces.get({ id: context.workspace?.id });
    if (!workspace) return;
    await this.withRunState(workspace, async () => {
      const active = await this.store.get(this.activeRunKey(workspace));
      if (!active?.runId || active.heartbeatRunId !== occurrence) return;
      if (owner) await this.recordRunOwner(workspace, active, owner);
      if (!ended) return;
      await this.ingestOutboxLocked(workspace);
      this.releaseRunGuard(workspace, active.runId);
      await this.clearActiveRun(workspace, active.runId);
    });
  }

  /**
   * Add an executor identity to the active run's owners, on the marker and
   * beside its journal (`runs/<runId>.owner.json`). A later event never
   * erases a known field; a new session for the same occurrence (the host's
   * fallback chain) is added, not substituted.
   */
  async recordRunOwner(workspace, active, owner) {
    const owners = Array.isArray(active.owners) ? active.owners.map((entry) => ({ ...entry })) : [];
    const same = owners.find(
      (entry) =>
        (owner.runtimeSessionId && entry.runtimeSessionId === owner.runtimeSessionId) ||
        (owner.ptySessionId && entry.ptySessionId === owner.ptySessionId)
    );
    if (same) {
      if (same.runtimeSessionId && owner.runtimeSessionId && same.runtimeSessionId !== owner.runtimeSessionId) return;
      if (same.ptySessionId && owner.ptySessionId && same.ptySessionId !== owner.ptySessionId) return;
      const before = JSON.stringify(same);
      same.runtimeSessionId ||= owner.runtimeSessionId;
      same.ptySessionId ||= owner.ptySessionId;
      if (JSON.stringify(same) === before) return;
    } else {
      owners.push({ ...owner, firstSeenAt: new Date().toISOString() });
    }
    await this.store.set(this.activeRunKey(workspace), { ...active, owners });
    const target = safeWorkspacePath(
      workspace.workingDirectory,
      path.join(".mailkeeper", "runs", `${path.basename(active.runId)}.owner.json`)
    );
    writeJsonAtomic(target, { schemaVersion: 1, runId: active.runId, heartbeatRunId: active.heartbeatRunId, owners });
  }

  releaseRunGuard(workspace, runId) {
    const state = path.join(workspace.workingDirectory, ".mailkeeper");
    let guard;
    try {
      guard = JSON.parse(fs.readFileSync(path.join(state, "run.lock"), "utf8"));
    } catch {
      return false;
    }
    if (guard?.runId !== runId) return false;
    let text = null;
    try {
      text = fs.readFileSync(path.join(state, "runs", `${path.basename(runId)}.json`), "utf8");
    } catch (error) {
      // No journal: the run ended before `begin` wrote one, so nothing was
      // attempted. An unreadable journal could hide a pending move: keep it.
      if (error?.code !== "ENOENT") return false;
    }
    if (text !== null) {
      let run;
      try {
        run = JSON.parse(text);
      } catch {
        return false;
      }
      if (!journalAllowsRelease(run, runId)) return false;
    }
    fs.rmSync(path.join(state, "run.lock"), { force: true });
    return true;
  }

  async resolveHeartbeatLaunchPolicy() {
    // Mailbox work runs through the skill helper; no extra confinement beyond
    // the host default.
    return {};
  }

  // -------------------------------------------------------------------------
  // Prompt
  // -------------------------------------------------------------------------

  buildMaintenancePrompt(workspace, config, thread, rules, inboxes) {
    const accounts = config.emailAccounts;
    const cli = `node ${SKILL_CLI}`;
    const approved = (account) => {
      const list = rules.promoted.filter((rule) => rule.account === account);
      return list.length
        ? list.map((rule) => `      - [${rule.pass}] ${rule.id}: ${rule.query} → ${rule.action}`).join("\n")
        : "      - (none approved — this inbox is report-only on scheduled runs)";
    };
    const effortNote = config.effort.warning
      ? config.effort.warning.reason === "unmapped-agent"
        ? `EFFORT: the requested reasoning effort "${config.effort.requested}" isn't applied: MailKeeper doesn't support it for ${config.agent} yet. Say so in this run's report (one line), even if nothing else happened.`
        : `EFFORT: the requested reasoning effort "${config.effort.requested}" isn't applied because no model is selected in MailKeeper settings. Say so in this run's report (one line: "Reasoning effort isn't applied because no model is selected in MailKeeper settings. Choose a model to use it."), even if nothing else happened.`
      : null;
    return [
      `You are the MailKeeper maintenance agent for workspace "${workspace.slug}". It looks after ${accounts.length} ${accounts.length === 1 ? "inbox" : "inboxes"}.`,
      'Use the workspace skill "mailbox-cleanup". Each inbox follows its own contract, listed below; read it before working on that inbox. The contract outranks this prompt. The root MAILBOX.md, if present, is an old file kept for reference and is not policy.',
      "",
      `WORKSPACE CAPS: mode ${config.mode}${config.modeCappedByCeiling ? ` (capped from ${config.requestedMode} by the global ceiling)` : ""}; aggressiveness ${config.aggressiveness}; protected domains ${config.protectedDomains.join(", ") || "(none)"}. A contract can only be stricter; the helper enforces both.`,
      ...(effortNote ? [effortNote] : []),
      "",
      "Procedure (run from the workspace root; RUN_ID is `mailkeeperRunId` from your launch metadata, or a fresh UUID if absent):",
      `  [ ] ${cli} begin --run-id RUN_ID --trigger heartbeat`,
      ...accounts.flatMap((account, index) => [
        `  Inbox ${index + 1} of ${accounts.length} — ${account} (contract: ${core.own(inboxes, account)?.contract || "not created yet"})`,
        "    Approved rules for this inbox:",
        approved(account),
        `    [ ] ${cli} snapshot --account ${shellQuote(account)} --run-id RUN_ID --since-last-run`,
        `    [ ] ${cli} triage   --account ${shellQuote(account)} --run-id RUN_ID   # urgency first; hits are never touched`,
        `    [ ] ${cli} apply    --account ${shellQuote(account)} --promoted-only --run-id RUN_ID`,
        `    [ ] ${cli} propose  --account ${shellQuote(account)} --run-id RUN_ID`,
      ]),
      `  [ ] ${cli} submit --run-id RUN_ID --summary "..."   # exactly once; exit only after ok:true`,
      "",
      "If a step fails for one inbox, the helper records that inbox as blocked or failed with a fixed code. Skip that inbox's remaining steps and continue with the next one. Never retry a move whose result the helper reports as uncertain.",
      "A large mailbox snapshot can take several minutes; run it in the foreground and wait for its JSON result.",
      "Never delete, trash or reply. Never act on protected senders, flagged messages, confirm-first categories or urgent hits. Never invent rules; suggest them.",
      "",
      `Report in thread "${thread.slug}": one section per inbox, the inbox name first, then what happened and what changed (from the helper's results), then one next action; for anything the person should ask, point to this workspace's chat. Write nothing else: no error codes, no step names, no notes about lessons, tools or instructions, and a run ID only when something moved and can be undone. Never include message bodies, credentials or raw tool output.`,
      `Reply exactly HEARTBEAT_OK only if every inbox was checked and nothing moved, nothing was suggested, nothing is urgent, nothing failed, and no explanation is owed${effortNote ? " (one is owed this run: see EFFORT)" : ""}.`,
    ].join("\n");
  }
}

module.exports = { MailKeeperService, PLUGIN_ID, taskIdentity, shellQuote, safeWorkspacePath };
