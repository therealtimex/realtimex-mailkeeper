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
    // Read fresh every time: workspace saves do not reload the plugin.
    const raw = this.api.getConfig({ workspaceSlug: workspace.slug }) || {};
    return resolveProfileConfig(raw);
  }

  // -------------------------------------------------------------------------
  // Provisioning
  // -------------------------------------------------------------------------

  async provision(workspace) {
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
      return { state: "config_invalid", errors };
    }

    const readiness = await mailbox.checkAccount(config.emailAccount);
    if (!readiness.ok) {
      await this.host.heartbeat.removeManagedTask(workspace, {
        id: taskIdentity(workspace.id),
      });
      await this.store.set(this.profileKey(workspace), {
        ...profile,
        state: "auth_missing",
        errors: [readiness.error],
        updatedAt: new Date().toISOString(),
      });
      return { state: "auth_missing", errors: [readiness.error] };
    }

    const thread = await this.host.workspaces.ensureThread(workspace, {
      key: threadKey(workspace.id),
      name: `MailKeeper: ${config.emailAccount}`,
    });

    this.seedContract(workspace, config);

    const rules = await this.ensureRules(workspace, config);
    this.syncRulesFile(workspace, config, rules, readiness.folders);

    const heartbeat = await this.host.heartbeat.upsertManagedTask(workspace, {
      id: taskIdentity(workspace.id),
      name: `MailKeeper maintenance (${config.emailAccount})`,
      interval: config.cadence,
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
      state: heartbeat.explicitlyPaused ? "paused_by_heartbeat" : "ready",
      errors: [],
      emailAccount: config.emailAccount,
      mode: config.mode,
      threadId: thread.id,
      threadSlug: thread.slug,
      taskId: taskIdentity(workspace.id),
      hostBackend: this.host.backend,
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(this.profileKey(workspace), next);
    return next;
  }

  async disable(workspace) {
    await this.host.heartbeat.removeManagedTask(workspace, {
      id: taskIdentity(workspace.id),
    });
    const profile = (await this.store.get(this.profileKey(workspace))) || {};
    await this.store.set(this.profileKey(workspace), {
      ...profile,
      state: "disabled",
      updatedAt: new Date().toISOString(),
    });
    // Thread, contract file, rules and run receipts are intentionally kept:
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
        this.api.log?.error?.("MailKeeper boot provision failed", {
          workspace: workspace.slug,
          error: error.message,
        });
      }
    }
  }

  seedContract(workspace, config) {
    const target = path.join(workspace.workingDirectory, config.contractPath);
    if (fs.existsSync(target)) return false; // never overwrite user edits
    const template = fs.readFileSync(
      path.join(TEMPLATE_DIR, "MAILBOX.md"),
      "utf8"
    );
    const vip = config.vipSenders.length
      ? config.vipSenders.map((entry) => `- ${entry}`).join("\n")
      : "- (none yet)";
    const rendered = template
      .replaceAll("{{EMAIL_ACCOUNT}}", config.emailAccount)
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
  syncRulesFile(workspace, config, rules, folders = []) {
    const archiveFolder = folders.includes("[Gmail]/All Mail")
      ? "[Gmail]/All Mail"
      : "Archive";
    const sentFolder =
      folders.find((name) => /^(\[Gmail\]\/)?Sent( Mail)?$/i.test(name)) || "Sent";
    const target = path.join(workspace.workingDirectory, ".mailkeeper", "rules.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify(
        {
          revision: rules.revision,
          writtenAt: new Date().toISOString(),
          config: {
            emailAccount: config.emailAccount,
            mode: config.mode,
            ageThresholdDays: config.ageThresholdDays,
            aggressiveness: config.aggressiveness,
            promotablePasses: config.promotablePasses,
            autoFolderPrefix: config.autoFolderPrefix,
            protectedDomains: config.protectedDomains,
            vipSenders: [...new Set([...config.vipSenders, ...(rules.vipSenders || [])])],
            archiveFolder,
            sentFolder,
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
        this.api.log?.warn?.("MailKeeper receipt unreadable", { file, error: error.message });
        fs.renameSync(full, `${full}.invalid`);
        continue;
      }
      try {
        await this.submitRun(workspace, body);
        fs.unlinkSync(full);
        ingested += 1;
      } catch (error) {
        this.api.log?.warn?.("MailKeeper receipt rejected", { file, error: error.message });
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
    if (!runId) throw codedError("runId is required", "MAILKEEPER_RUN_INVALID", 400);
    const existing = await this.store.get(this.runKey(workspace, runId));
    if (existing) return { runId, reused: true };

    const outcome = text(body.outcome, 20);
    if (!["completed", "blocked", "failed"].includes(outcome)) {
      throw codedError(
        "outcome must be completed, blocked, or failed",
        "MAILKEEPER_RUN_INVALID",
        400
      );
    }
    const receipt = {
      runId,
      workspaceId: workspace.id,
      outcome,
      mode: text(body.mode, 40),
      startedAt: text(body.startedAt, 40),
      finishedAt: new Date().toISOString(),
      snapshot: body.snapshot && typeof body.snapshot === "object" ? body.snapshot : null,
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

    await this.store.set(this.activeRunKey(workspace), null);
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
    const { config, errors } = this.profileConfig(workspace);
    if (errors.length)
      throw codedError(errors.join(" "), "MAILKEEPER_CONFIG_NOT_READY", 409);
    const result = await mailbox.undoActions(config.emailAccount, receipt.actions, {
      dryRun: body.dryRun === true,
    });
    if (!body.dryRun) {
      receipt.undoneAt = new Date().toISOString();
      receipt.undoneBy = user.id;
      await this.store.set(this.runKey(workspace, runId), receipt);
    }
    return { runId, reused: false, ...result };
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
        emailAccount: config.emailAccount,
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

  async admitHeartbeat(context) {
    const workspace = await this.host.workspaces.get({ id: context.workspace?.id });
    if (!workspace) throw codedError("Workspace missing", "MAILKEEPER_WORKSPACE_MISSING", 404);
    const { errors } = this.profileConfig(workspace);
    if (errors.length) {
      return { admitted: false, reason: `config_invalid: ${errors.join(" ")}` };
    }
    const active = await this.store.get(this.activeRunKey(workspace));
    if (active && Date.now() - Date.parse(active.startedAt) < 6 * 60 * 60 * 1000) {
      return { admitted: false, reason: `run ${active.runId} still in flight` };
    }
    const runId = crypto.randomUUID();
    await this.store.set(this.activeRunKey(workspace), {
      runId,
      heartbeatRunId: context.heartbeatRunId || null,
      startedAt: new Date().toISOString(),
    });
    return { admitted: true, runId };
  }

  async recordHeartbeatDispatch(context) {
    this.api.log?.info?.("MailKeeper maintenance dispatched", {
      workspace: context.workspace?.slug,
      heartbeatRunId: context.heartbeatRunId || null,
    });
  }

  async recordHeartbeatLifecycle(context) {
    // A terminal exit without a receipt means the agent never called
    // submit-run; release the single-flight lock so the next tick can run.
    if (["stopped", "failed", "exited"].includes(String(context.event?.type || ""))) {
      const workspace = await this.host.workspaces.get({ id: context.workspace?.id });
      if (!workspace) return;
      await this.ingestOutbox(workspace); // submitRun clears the lock on success
      await this.store.set(this.activeRunKey(workspace), null);
    }
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
      `You are the MailKeeper maintenance agent for account "${config.emailAccount}" in workspace "${workspace.slug}".`,
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
      "Procedure (run from the workspace root; RUN_ID is the runId in your launch metadata, or a fresh UUID):",
      `1. node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js snapshot --account ${config.emailAccount} --since-last-run`,
      `2. node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js triage --account ${config.emailAccount} --run-id RUN_ID   # urgency first; hits are never touched`,
      `3. node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js apply --account ${config.emailAccount} --promoted-only --mode ${config.mode} --run-id RUN_ID`,
      `4. node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js propose --account ${config.emailAccount} --run-id RUN_ID   # dry-run the rest, emit proposals`,
      "5. node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js submit --run-id RUN_ID --outcome completed --summary \"...\"   # exactly once; exit only after ok:true",
      "",
      "Never delete or trash. Never act on VIP senders, protected domains, or urgent hits. Never invent rules; propose them.",
      `Post a short human-readable summary in thread "${thread.slug}" when done, or exactly HEARTBEAT_OK if nothing changed and nothing was proposed.`,
    ].join("\n");
  }
}

function ruleIdFor(proposal) {
  return crypto
    .createHash("sha256")
    .update(`${proposal.pass}:${proposal.query}:${proposal.action}`)
    .digest("hex")
    .slice(0, 16);
}

module.exports = { MailKeeperService, PLUGIN_ID, taskIdentity };
