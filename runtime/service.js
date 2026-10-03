"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { hostFor } = require("./host");
const { resolveProfileConfig } = require("./config");
const mailbox = require("./mailbox");

const PLUGIN_ID = "com.realtimex.mailkeeper";
const TEMPLATE_DIR = path.join(__dirname, "..", "templates");

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

class MailKeeperService {
  constructor(api) {
    this.api = api;
    this.host = hostFor(api);
    this.store = api.getStore();
    this.setupJobs = new Map();
    this.locks = new Map();
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
  // Provisioning
  // -------------------------------------------------------------------------

  async provision(workspace, operation = null) {
    const { config, errors } = this.profileConfig(workspace);
    const profile = (await this.store.get(this.profileKey(workspace))) || {};
    const target = await this.api.email?.getHimalayaTarget({ workspaceId: workspace.id });
    if (!target) throw codedError("Upgrade RealTimeX to use guided setup", "HOST_UNSUPPORTED", 409);
    config.himalayaConfigPath = target.configPath;
    const revision = this.setupRevision(config, target);
    const current = async () => {
      const latest = await this.store.get(this.profileKey(workspace));
      const latestTarget = await this.api.email.getHimalayaTarget({ workspaceId: workspace.id });
      if (latest?.state === "disabled" || (operation && latest?.operationId !== operation) ||
          revision !== this.setupRevision(this.profileConfig(workspace).config, latestTarget)) {
        if (latest?.state === "disabled") await this.host.heartbeat.removeManagedTask(workspace, { id: taskIdentity(workspace.id) });
        throw codedError("Setup changed. Check again.", "SETUP_CHANGED", 409);
      }
    };

    if (errors.length) {
      // Not ready: make sure nothing runs, but keep prior state for repair.
      await this.suspendScheduleForRepair(workspace, operation);
      await this.host.heartbeat.removeManagedTask(workspace, {
        id: taskIdentity(workspace.id),
      });
      await this.updateSetupProfile(workspace, {
        state: "needs_setup", schemaVersion: 1,
        blockers: errors.map((error) => ({ code: "CONFIG_REQUIRED", safeMessage: error, retryable: true })),
        errors,
        updatedAt: new Date().toISOString(),
      }, operation);
      this.api.log?.warn?.("MailKeeper profile not ready", {
        workspace: workspace.slug,
        errors,
      });
      return { state: "config_invalid", errors };
    }

    const readiness = {};
    const authErrors = [];
    for (const account of config.emailAccounts) {
      const probe = await mailbox.checkAccount(account, target);
      await current();
      probe.checkedAt = new Date().toISOString();
      readiness[account] = probe;
      if (!probe.ok) authErrors.push(probe.error);
    }
    if (authErrors.length) {
      await this.suspendScheduleForRepair(workspace, operation);
      await this.host.heartbeat.removeManagedTask(workspace, {
        id: taskIdentity(workspace.id),
      });
      await this.updateSetupProfile(workspace, {
        state: "needs_repair", schemaVersion: 1,
        blockers: Object.entries(readiness).filter(([, check]) => !check.ok).map(([accountRef, check]) => ({
          accountRef, code: check.code, safeMessage: check.error, retryable: true, actionId: "check",
        })),
        accountChecks: readiness, revision,
        errors: authErrors,
        updatedAt: new Date().toISOString(),
      }, operation);
      return { state: "needs_repair", errors: authErrors };
    }

    await current();
    await this.updateSetupProfile(workspace, { state: "preparing", accountChecks: readiness }, operation);
    let thread = profile.threadSlug && await this.host.workspaces.getThread?.(workspace, { slug: profile.threadSlug });
    if (thread?.archivedAt) throw codedError("Open or restore the maintenance thread, then check again.", "THREAD_ARCHIVED", 409);
    thread = thread || await this.host.workspaces.ensureThread(workspace, {
      key: threadKey(workspace.id),
      name: `MailKeeper: ${config.emailAccounts.join(", ")}`.slice(0, 180),
    });

    this.seedContract(workspace, config);

    const rules = await this.ensureRules(workspace, config);
    this.syncRulesFile(workspace, config, rules, readiness);
    await current();

    // Commit scheduler reconciliation and the ready profile under the same
    // lock as suspension, schedule choices and disablement.
    return this.exclusive(workspace, async () => {
    await current();
    const latest = await this.store.get(this.profileKey(workspace));
    const scheduleConfig = this.profileConfig(workspace).config;
    const interval = scheduleConfig.maintenanceEnabled && !latest.scheduleSuspendedForRepair ? scheduleConfig.cadence : "disabled";
    const heartbeat = await this.host.heartbeat.upsertManagedTask(workspace, {
      id: taskIdentity(workspace.id),
      name: `MailKeeper maintenance (${config.emailAccounts.join(", ")})`.slice(0, 120),
      interval,
      executor: "agent",
      agent: config.agent,
      ...(config.model ? { model: config.model } : {}),
      prompt: this.buildMaintenancePrompt(workspace, config, thread, rules),
      threadSlug: thread.slug,
      useProvidedThreadSlug: true,
      directPrompt: true,
      resumeSession: false,
      autoCloseTerminalOnStop: true,
      promptArtifactCategory: "mailkeeper-maintenance",
      promptArtifactRetention: "durable",
    });

    const next = {
      schemaVersion: 1, state: "ready",
      blockers: [], accountChecks: readiness, revision,
      verifiedAt: new Date().toISOString(), operationId: operation,
      errors: [],
      emailAccounts: config.emailAccounts,
      mode: config.mode,
      threadId: thread.id,
      threadSlug: thread.slug,
      taskId: taskIdentity(workspace.id),
      hostBackend: this.host.backend,
      updatedAt: new Date().toISOString(),
    };
    await current();
    const resources = await this.host.heartbeat.getManagedTaskStatus(workspace, { id: next.taskId });
    const readback = await this.host.workspaces.getThread(workspace, { slug: thread.slug });
    const expectedInterval = heartbeat.explicitlyPaused ? "disabled" : interval;
    const freshSchedule = this.profileConfig(workspace).config;
    if (!resources.exists || resources.interval !== expectedInterval ||
        freshSchedule.maintenanceEnabled !== scheduleConfig.maintenanceEnabled || freshSchedule.cadence !== scheduleConfig.cadence ||
        !readback || readback.archivedAt ||
        !fs.existsSync(path.join(workspace.workingDirectory, config.contractPath))) {
      throw codedError("Preparation did not finish. Check again.", "PROVISION_FAILED", 409);
    }
    await current();
    const fresh = await this.store.get(this.profileKey(workspace));
    const saved = { ...fresh, ...next };
    await this.store.set(this.profileKey(workspace), saved);
    return saved;
    });
  }

  async disable(workspace) {
    return this.exclusive(workspace, async () => {
    const profile = (await this.store.get(this.profileKey(workspace))) || {};
    await this.store.set(this.profileKey(workspace), {
      ...profile,
      state: "disabled",
      updatedAt: new Date().toISOString(),
    });
    await this.host.heartbeat.removeManagedTask(workspace, {
      id: taskIdentity(workspace.id),
    });
    // Thread, contract file, rules and run receipts are intentionally kept:
    // they are the user's audit trail and survive re-enable.
    });
  }

  async disableAll() {
    const workspaces = await this.host.workspaces.listEnabledForPlugin();
    for (const workspace of workspaces) await this.disable(workspace);
  }

  async activateAll() {
    const workspaces = await this.host.workspaces.listEnabledForPlugin();
    for (const workspace of workspaces) {
      try {
        await this.beginSetup(workspace);
      } catch (error) {
        // Message carries the detail: the host log line prints only the message.
        this.api.log?.error?.(
          "MailKeeper setup unavailable",
          { code: "PROVISION_FAILED" }
        );
      }
    }
  }

  seedContract(workspace, config) {
    const target = path.join(workspace.workingDirectory, config.contractPath);
    if (fs.existsSync(target)) {
      fs.readFileSync(target, "utf8"); // fail closed for unreadable human policy
      return false;
    }
    const template = fs.readFileSync(
      path.join(TEMPLATE_DIR, "MAILBOX.md"),
      "utf8"
    );
    const vip = config.vipSenders.length
      ? config.vipSenders.map((entry) => `- ${entry}`).join("\n")
      : "- (none yet)";
    const rendered = template
      .replaceAll("{{EMAIL_ACCOUNT}}", config.emailAccounts.join(", "))
      .replaceAll("{{MODE}}", config.mode)
      .replaceAll("{{AGE_THRESHOLD_DAYS}}", String(config.ageThresholdDays))
      .replaceAll("{{AGGRESSIVENESS}}", config.aggressiveness)
      .replaceAll("{{VIP_SENDERS}}", vip)
      .replaceAll("{{PROTECTED_DOMAINS}}", config.protectedDomains.join(", "));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, rendered, "utf8");
    return true;
  }

  /**
   * `.mailkeeper/rules.json` is the contract between the plugin and the
   * workspace-side `mailbox-ops.js`: effective config + promoted rules.
   * Rewritten on every provision; the script never edits it.
   */
  syncRulesFile(workspace, config, rules, readiness = {}) {
    const accounts = {};
    for (const account of config.emailAccounts) {
      const folders = readiness[account]?.folders || [];
      accounts[account] = {
        archiveFolder: folders.includes("[Gmail]/All Mail")
          ? "[Gmail]/All Mail"
          : "Archive",
        sentFolder:
          folders.find((name) => /^(\[Gmail\]\/)?Sent( Mail)?$/i.test(name)) ||
          "Sent",
      };
    }
    const target = path.join(workspace.workingDirectory, ".mailkeeper", "rules.json");
    if (fs.existsSync(target)) JSON.parse(fs.readFileSync(target, "utf8"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify(
        {
          revision: rules.revision,
          writtenAt: new Date().toISOString(),
          config: {
            himalayaConfigPath: config.himalayaConfigPath || null,
            emailAccounts: config.emailAccounts,
            accounts,
            mode: config.mode,
            ageThresholdDays: config.ageThresholdDays,
            aggressiveness: config.aggressiveness,
            promotablePasses: config.promotablePasses,
            autoFolderPrefix: config.autoFolderPrefix,
            protectedDomains: config.protectedDomains,
            vipSenders: [...new Set([...config.vipSenders, ...(rules.vipSenders || [])])],
          },
          promoted: rules.promoted,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  /**
   * Pick up receipts the agent queued in `.mailkeeper/outbox/` and record them.
   * Called on heartbeat lifecycle events and status reads; no watcher needed.
   */
  async ingestOutbox(workspace) {
    const dir = path.join(workspace.workingDirectory, ".mailkeeper", "outbox");
    if (!fs.existsSync(dir)) return { ingested: 0 };
    let ingested = 0;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const full = path.join(dir, file);
      let body;
      try {
        body = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch (error) {
        this.api.log?.warn?.("MailKeeper receipt unreadable", { file, code: "RECEIPT_UNREADABLE" });
        fs.renameSync(full, `${full}.invalid`);
        continue;
      }
      try {
        await this.submitRun(workspace, body);
        fs.unlinkSync(full);
        ingested += 1;
      } catch (error) {
        this.api.log?.warn?.("MailKeeper receipt rejected", { file, code: "RECEIPT_REJECTED" });
        fs.renameSync(full, `${full}.rejected`);
      }
    }
    return { ingested };
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  async ensureRules(workspace, config) {
    let rules = await this.store.get(this.rulesKey(workspace));
    if (!rules) {
      rules = {
        revision: 0,
        promoted: [],
        proposed: [],
        vipSenders: config.vipSenders,
        updatedAt: new Date().toISOString(),
      };
      await this.store.set(this.rulesKey(workspace), rules);
    }
    return rules;
  }

  async promoteRule(workspace, body, user) {
    if (!user?.id)
      throw codedError("Authenticated human required", "MAILKEEPER_HUMAN_REQUIRED", 403);
    const { config, errors } = this.profileConfig(workspace);
    if (errors.length)
      throw codedError(errors.join(" "), "MAILKEEPER_CONFIG_NOT_READY", 409);
    const rules = await this.ensureRules(workspace, config);
    const ruleId = text(body.ruleId, 120);
    const proposal = rules.proposed.find((entry) => entry.id === ruleId);
    if (!proposal)
      throw codedError(`Unknown proposed rule ${ruleId}`, "MAILKEEPER_RULE_UNKNOWN", 404);
    if (!config.promotablePasses.includes(proposal.pass)) {
      throw codedError(
        `Pass "${proposal.pass}" is not promotable at aggressiveness "${config.aggressiveness}"`,
        "MAILKEEPER_RULE_NOT_PROMOTABLE",
        409
      );
    }
    rules.proposed = rules.proposed.filter((entry) => entry.id !== ruleId);
    rules.promoted.push({
      ...proposal,
      promotedAt: new Date().toISOString(),
      promotedBy: user.id,
    });
    rules.revision += 1;
    rules.updatedAt = new Date().toISOString();
    await this.store.set(this.rulesKey(workspace), rules);
    await this.provision(workspace); // refresh the prompt with the new rule set
    return { ruleId, revision: rules.revision };
  }

  async demoteRule(workspace, body, user) {
    if (!user?.id)
      throw codedError("Authenticated human required", "MAILKEEPER_HUMAN_REQUIRED", 403);
    const rules = await this.store.get(this.rulesKey(workspace));
    const ruleId = text(body.ruleId, 120);
    const rule = rules?.promoted?.find((entry) => entry.id === ruleId);
    if (!rule)
      throw codedError(`Unknown promoted rule ${ruleId}`, "MAILKEEPER_RULE_UNKNOWN", 404);
    rules.promoted = rules.promoted.filter((entry) => entry.id !== ruleId);
    rules.proposed.push({ ...rule, demotedAt: new Date().toISOString() });
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
   * Record a run receipt submitted by the maintenance agent via the
   * plugin-owned helper (templates/submit-run.cjs). Idempotent on runId.
   */
  async submitRun(workspace, body) {
    const runId = text(body.runId, 80);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw codedError("Valid runId is required", "MAILKEEPER_RUN_INVALID", 400);
    const existing = await this.store.get(this.runKey(workspace, runId));
    if (existing) return { runId, reused: true };

    let outcome = text(body.outcome, 20);
    const active = await this.store.get(this.activeRunKey(workspace));
    const profile = await this.store.get(this.profileKey(workspace));
    const reservation = await this.store.get(`ws-${workspace.id}-preview-${runId}`);
    const previewScope = reservation?.scope || (active?.runId === runId ? active.scope : null);
    const isPreview = Boolean(reservation || active?.runId === runId && active.kind === "onboarding-preview" || profile?.previewRunId === runId);
    if (isPreview && (body.mode !== "report-only" || (body.actions || []).some((action) => action.dryRun !== true))) {
      throw codedError("Preview receipts must have zero mailbox changes", "PREVIEW_RECEIPT_INVALID", 400);
    }
    if (isPreview && outcome === "completed" && (!Array.isArray(body.accountOutcomes) ||
        !previewScope?.accounts?.length || previewScope.accounts.some((account) => !body.accountOutcomes.some((entry) => entry.account === account && entry.outcome === "completed")))) {
      throw codedError("Preview requires every selected account outcome", "PREVIEW_RECEIPT_INVALID", 400);
    }
    if (!["completed", "blocked", "failed"].includes(outcome)) {
      throw codedError(
        "outcome must be completed, blocked, or failed",
        "MAILKEEPER_RUN_INVALID",
        400
      );
    }
    const reservedScope = await this.store.get(`ws-${workspace.id}-scope-${runId}`);
    const target = !isPreview && !reservedScope && await this.api.email?.getHimalayaTarget({ workspaceId: workspace.id });
    const runScope = isPreview ? previewScope : reservedScope || (active?.runId === runId && active.scope) || {
      accounts: this.profileConfig(workspace).config.emailAccounts,
      configPath: target?.configPath || null,
    };
    const receipt = {
      runId,
      workspaceId: workspace.id,
      outcome,
      mode: text(body.mode, 40),
      startedAt: text(body.startedAt, 40),
      finishedAt: new Date().toISOString(),
      snapshot: body.snapshot && typeof body.snapshot === "object" ? body.snapshot : null,
      scope: runScope,
      accountOutcomes: Array.isArray(body.accountOutcomes) ? body.accountOutcomes : [],
      failureCode: ["AGENT_UNAVAILABLE", "AGENT_SIGN_IN_REQUIRED", "AGENT_ACCESS_DENIED", "THREAD_UNAVAILABLE", "AGENT_LAUNCH_UNKNOWN"].includes(body.failureCode) ? body.failureCode : isPreview && outcome === "blocked" ? "AGENT_LAUNCH_UNKNOWN" : null,
      // Every mutation, by UID, so /undo can reverse it exactly.
      actions: Array.isArray(body.actions) ? body.actions.slice(0, 5000) : [],
      // Things the agent found but was not allowed to act on.
      proposals: Array.isArray(body.proposals) ? body.proposals.slice(0, 200) : [],
      // Urgency triage hits: never touched, always surfaced.
      urgent: Array.isArray(body.urgent) ? body.urgent.slice(0, 200) : [],
      summary: text(body.summary, 4000),
      undoneAt: null,
    };
    await this.store.set(this.runKey(workspace, runId), receipt);

    const index = (await this.store.get(this.runIndexKey(workspace))) || [];
    index.unshift({ runId, outcome, finishedAt: receipt.finishedAt, actions: receipt.actions.length });
    await this.store.set(this.runIndexKey(workspace), index.slice(0, 500));

    // Fold proposals into the rules ledger so a human can promote them.
    if (receipt.proposals.length) {
      const { config } = this.profileConfig(workspace);
      const rules = await this.ensureRules(workspace, config);
      const known = new Set([
        ...rules.promoted.map((entry) => entry.id),
        ...rules.proposed.map((entry) => entry.id),
      ]);
      for (const proposal of receipt.proposals) {
        const id = text(proposal.id, 120) || ruleIdFor(proposal);
        if (known.has(id)) continue;
        rules.proposed.push({ ...proposal, id, firstSeenRunId: runId });
        known.add(id);
      }
      rules.updatedAt = new Date().toISOString();
      await this.store.set(this.rulesKey(workspace), rules);
    }

    const latestActive = await this.store.get(this.activeRunKey(workspace));
    if (latestActive?.runId === runId) await this.store.set(this.activeRunKey(workspace), null);
    return { runId, reused: false, actions: receipt.actions.length };
  }

  async undoRun(workspace, body, user) {
    if (!user?.id)
      throw codedError("Authenticated human required", "MAILKEEPER_HUMAN_REQUIRED", 403);
    const runId = text(body.runId, 80);
    const receipt = await this.store.get(this.runKey(workspace, runId));
    if (!receipt) throw codedError(`Unknown run ${runId}`, "MAILKEEPER_RUN_UNKNOWN", 404);
    if (receipt.undoneAt)
      return { runId, reused: true, undoneAt: receipt.undoneAt };
    const target = await this.api.email?.getHimalayaTarget({ workspaceId: workspace.id });
    if (!target?.configPath) throw codedError("Upgrade RealTimeX to undo against the shared email target", "HOST_UNSUPPORTED", 409);
    if (receipt.scope?.configPath && receipt.scope.configPath !== target.configPath) {
      throw codedError("Restore the run's email configuration before undoing it", "MAILKEEPER_TARGET_CHANGED", 409);
    }
    // Account selection may have changed since the run. Reverse the accounts
    // actually recorded, and only infer an untagged legacy action when unique.
    const scopeAccounts = receipt.scope?.accounts || [];
    const actionsByAccount = new Map();
    for (const action of receipt.actions) {
      if (action.kind !== "move" || action.dryRun) continue;
      const account = action.account || (scopeAccounts.length === 1 && scopeAccounts[0]);
      if (!account) throw codedError("The receipt does not identify this action's account", "MAILKEEPER_UNDO_SCOPE_UNKNOWN", 409);
      if (!actionsByAccount.has(account)) actionsByAccount.set(account, []);
      actionsByAccount.get(account).push(action);
    }
    const result = { reversed: 0, skipped: [], dryRun: body.dryRun === true };
    for (const [account, actions] of actionsByAccount) {
      const partial = await mailbox.undoActions(account, actions, {
        dryRun: result.dryRun,
        configPath: target.configPath,
      });
      result.reversed += partial.reversed;
      result.skipped.push(...partial.skipped.map((entry) => ({ account, ...entry })));
    }
    if (!body.dryRun) {
      receipt.undoneAt = new Date().toISOString();
      receipt.undoneBy = user.id;
      await this.store.set(this.runKey(workspace, runId), receipt);
    }
    return { runId, reused: false, ...result };
  }

  // -------------------------------------------------------------------------
  // Options for the EMAIL_ACCOUNTS picker (optionsRoutePath: /accounts)
  // -------------------------------------------------------------------------

  async accountOptions() {
    const target = await this.api.email?.getHimalayaTarget();
    const accounts = await mailbox.listAccounts(target || {});
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
   * is how RUN_ID reaches the maintenance prompt.
   */
  async admitHeartbeat(context) {
    const workspace = await this.host.workspaces.get({ id: context.workspace?.id });
    if (!workspace) {
      return { skipLaunch: true, skipReason: "workspace missing" };
    }
    return this.exclusive(workspace, async () => {
    const { config, errors } = this.profileConfig(workspace);
    const setup = await this.setupStatus(workspace);
    if (!config.maintenanceEnabled || setup.state !== "ready" || setup.schedule.suspendedForRepair ||
        setup.schedule.paused || setup.schedule.interval === "disabled" || setup.schedule.pauseReason === "workspace_paused") {
      return { skipLaunch: true, skipReason: "setup or schedule not ready" };
    }
    if (errors.length) {
      return { skipLaunch: true, skipReason: `config_invalid: ${errors.join(" ")}` };
    }
    const active = await this.store.get(this.activeRunKey(workspace));
    if (active && (active.kind === "onboarding-preview" || Date.now() - Date.parse(active.startedAt) < 6 * 60 * 60 * 1000)) {
      return { skipLaunch: true, skipReason: `run ${active.runId} still in flight` };
    }
    const runId = crypto.randomUUID();
    const scope = { accounts: config.emailAccounts, configPath: (await this.api.email.getHimalayaTarget({ workspaceId: workspace.id })).configPath };
    await this.store.set(`ws-${workspace.id}-scope-${runId}`, scope);
    await this.store.set(this.activeRunKey(workspace), {
      runId,
      heartbeatRunId: context.heartbeatRunId || null,
      startedAt: new Date().toISOString(),
      scope,
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
   * `dispatch.dispatchStatus` is the host's classification of the executor
   * event: anything other than `running` ends the occurrence. Ingest whatever
   * the agent queued and release the single-flight lock.
   */
  async recordHeartbeatLifecycle(context) {
    const status = String(context.dispatch?.dispatchStatus || "").toLowerCase();
    if (!status || status === "running") return;
    const workspace = await this.host.workspaces.get({ id: context.workspace?.id });
    if (!workspace) return;
    await this.ingestOutbox(workspace); // submitRun clears the lock on success
    const active = await this.store.get(this.activeRunKey(workspace));
    if (active?.kind !== "onboarding-preview") await this.store.set(this.activeRunKey(workspace), null);
  }

  async resolveHeartbeatLaunchPolicy() {
    // Read-only mailbox work; no extra confinement beyond the host default.
    return {};
  }

  // -------------------------------------------------------------------------
  // Prompt
  // -------------------------------------------------------------------------

  buildMaintenancePrompt(workspace, config, thread, rules) {
    const promoted = rules.promoted.length
      ? rules.promoted
          .map((rule) => `- [${rule.pass}] ${rule.id}: ${rule.query} → ${rule.action}`)
          .join("\n")
      : "- (none promoted yet — this run is report-only regardless of MODE)";
    return [
      `You are the MailKeeper maintenance agent for ${config.emailAccounts.length === 1 ? "account" : "accounts"} ${config.emailAccounts.map((a) => `"${a}"`).join(", ")} in workspace "${workspace.slug}".`,
      `Use the workspace skill "mailbox-cleanup". Read ${config.contractPath} first; it is the human-owned policy and outranks this prompt.`,
      "",
      `MODE: ${config.mode}${config.modeCappedByCeiling ? ` (capped from ${config.requestedMode} by the global ceiling)` : ""}`,
      `AGE THRESHOLD: ${config.ageThresholdDays} days`,
      `AGGRESSIVENESS: ${config.aggressiveness} (promotable passes: ${config.promotablePasses.join(", ")})`,
      `AUTO FOLDER PREFIX: ${config.autoFolderPrefix}`,
      `PROTECTED DOMAINS (never touch): ${config.protectedDomains.join(", ") || "(none)"}`,
      "",
      "PROMOTED RULES (the only rules you may execute unattended):",
      promoted,
      "",
      "Procedure (run from the workspace root; RUN_ID is `mailkeeperRunId` from your launch metadata, or a fresh UUID if absent). Every account below is a separate checklist — do not submit until each one has all four checks:",
      ...config.emailAccounts.flatMap((account, index) => [
        `Account ${index + 1} of ${config.emailAccounts.length} — "${account}":`,
        `  [ ] node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js snapshot --account ${account} --since-last-run`,
        `  [ ] node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js triage --account ${account} --run-id RUN_ID   # urgency first; hits are never touched`,
        `  [ ] node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js apply --account ${account} --promoted-only --mode ${config.mode} --run-id RUN_ID`,
        `  [ ] node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js propose --account ${account} --run-id RUN_ID   # dry-run the rest, emit proposals`,
      ]),
      "Finally, exactly once:",
      "  [ ] node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js submit --run-id RUN_ID --outcome completed --summary \"...\"   # exit only after ok:true",
      "A large mailbox snapshot can take several minutes; run it in the foreground and wait for its JSON result rather than backgrounding it.",
      "",
      "Never delete or trash. Never act on VIP senders, protected domains, or urgent hits. Never invent rules; propose them.",
      `Post a short human-readable summary in thread "${thread.slug}" when done, or exactly HEARTBEAT_OK if nothing changed and nothing was proposed.`,
    ].join("\n");
  }
}

Object.assign(MailKeeperService.prototype, require("./onboarding"));

function ruleIdFor(proposal) {
  return crypto
    .createHash("sha256")
    .update(`${proposal.pass}:${proposal.query}:${proposal.action}`)
    .digest("hex")
    .slice(0, 16);
}

module.exports = { MailKeeperService, PLUGIN_ID, taskIdentity };
