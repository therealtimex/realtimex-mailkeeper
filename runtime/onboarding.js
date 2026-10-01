"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveProfileConfig } = require("./config");

const fault = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const now = () => new Date().toISOString();
const editable = new Set(["EMAIL_ACCOUNTS", "AGENT", "MODEL", "MODE", "CADENCE", "AGE_THRESHOLD_DAYS", "AGGRESSIVENESS", "VIP_SENDERS"]);

module.exports = {
  async exclusive(workspace, operation) {
    const previous = this.locks.get(workspace.id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.locks.set(workspace.id, pending);
    try { return await pending; }
    finally { if (this.locks.get(workspace.id) === pending) this.locks.delete(workspace.id); }
  },

  setupRevision(config, target) {
    // Schedule intent is independent of account verification.
    const { maintenanceEnabled, cadence, himalayaConfigPath, ...verificationConfig } = config;
    return crypto.createHash("sha256").update(JSON.stringify({ verificationConfig, target })).digest("hex");
  },

  async migrateSchedule(workspace) {
    const profile = await this.store.get(this.profileKey(workspace)) || {};
    if (profile.scheduleMigrated) return;
    const raw = this.api.getConfig({ workspaceId: workspace.id, workspaceSlug: workspace.slug }) || {};
    if (!Object.hasOwn(raw, "MAINTENANCE_ENABLED")) {
      const task = await this.host.heartbeat.getManagedTaskStatus(workspace, { id: `mailkeeper-maintenance-${workspace.id}` });
      const legacy = ["ready", "paused_by_heartbeat"].includes(profile.state) && Boolean(profile.taskId);
      // Conflicting historical intent is a human decision; don't rewrite it.
      if (legacy !== Boolean(task.exists)) {
        await this.store.set(this.profileKey(workspace), { ...profile, schemaVersion: 1,
          state: "needs_repair", blockers: [{ code: "SCHEDULE_CONFLICT", actionId: "schedule", retryable: false }], scheduleConflict: true });
        return;
      }
      await this.api.updateConfig({ MAINTENANCE_ENABLED: legacy,
        ...(legacy && task.interval && task.interval !== "disabled" ? { CADENCE: task.interval } : {}),
      }, { workspaceId: workspace.id, workspaceSlug: workspace.slug });
    }
    await this.store.set(this.profileKey(workspace), { ...profile, scheduleMigrated: true });
  },

  async beginSetup(workspace) {
    return this.exclusive(workspace, async () => {
      const running = this.setupJobs.get(workspace.id);
      if (running) {
        const profile = await this.store.get(this.profileKey(workspace));
        if (profile?.operationId !== running.operationId) throw fault("CHECK_FINISHING");
        return { accepted: true, operationId: running.operationId, reused: true };
      }
      if (!this.api.email || !this.host.heartbeat.getManagedTaskStatus) throw fault("HOST_UNSUPPORTED");
      await this.migrateSchedule(workspace);
      const profile = await this.store.get(this.profileKey(workspace)) || {};
      if (profile.scheduleConflict) throw fault("SCHEDULE_CONFLICT");
      const operationId = profile.state === "checking" || profile.state === "preparing" ? profile.operationId || crypto.randomUUID() : crypto.randomUUID();
      await this.store.set(this.profileKey(workspace), { ...profile, schemaVersion: 1, state: "checking", operationId, blockers: [], updatedAt: now() });
      const job = { operationId };
      this.setupJobs.set(workspace.id, job);
      job.promise = Promise.resolve().then(() => this.provision(workspace, operationId)).catch(async (error) => {
        const current = await this.store.get(this.profileKey(workspace)) || {};
        if (current.operationId !== operationId || current.state === "disabled") return;
        await this.store.set(this.profileKey(workspace), { ...current, state: "needs_repair",
          blockers: [{ code: ["THREAD_ARCHIVED", "SETUP_CHANGED"].includes(error.code) ? error.code : "PROVISION_FAILED", retryable: true, actionId: "check" }], updatedAt: now() });
      }).finally(() => { if (this.setupJobs.get(workspace.id) === job) this.setupJobs.delete(workspace.id); });
      return { accepted: true, operationId, reused: false };
    });
  },

  async setupStatus(workspace) {
    await this.ingestOutbox(workspace);
    const profile = await this.store.get(this.profileKey(workspace)) || {};
    const { config, errors } = this.profileConfig(workspace);
    const target = await this.api.email?.getHimalayaTarget({ workspaceId: workspace.id });
    let state = profile.schemaVersion === 1 ? profile.state : "needs_setup";
    const stale = Boolean(profile.revision && target && profile.revision !== this.setupRevision(config, target));
    if (stale && state === "ready") state = "needs_repair";
    if (errors.length && !["checking", "preparing", "disabled"].includes(state)) state = "needs_setup";
    const active = await this.store.get(this.activeRunKey(workspace));
    const preview = profile.previewRunId ? await this.store.get(this.runKey(workspace, profile.previewRunId)) : null;
    const schedule = await this.host.heartbeat.getManagedTaskStatus?.(workspace, { id: `mailkeeper-maintenance-${workspace.id}` }) || { exists: false };
    return { schemaVersion: 1, state, stale, blockers: profile.blockers || [],
      missingFields: errors.length ? [!config.emailAccounts.length && "EMAIL_ACCOUNTS", !config.agent && "AGENT"].filter(Boolean) : [],
      operationId: profile.operationId || null, verifiedAt: profile.verifiedAt || null,
      accountChecks: profile.accountChecks || {}, threadSlug: profile.threadSlug || null,
      preview: preview ? this.runProjection(preview) : active?.kind === "onboarding-preview" ? { runId: active.runId, outcome: "pending" } : null,
      scope: { accounts: config.emailAccounts, folders: ["INBOX"], agent: config.agent, mode: "report-only", maxPages: 5, pageSize: 200 },
      schedule: { intent: config.maintenanceEnabled, cadence: config.cadence, ...schedule },
      hostSupported: Boolean(target && this.host.heartbeat.getManagedTaskStatus),
      emailTarget: target ? { source: target.source, revision: target.revision } : null,
    };
  },

  async configureSetup(workspace, patch) {
    if (!patch || Array.isArray(patch) || typeof patch !== "object" || Object.keys(patch).some((key) => !editable.has(key))) throw fault("SETUP_CONFIG_INVALID", 400);
    const raw = this.api.getConfig({ workspaceId: workspace.id });
    const candidate = resolveProfileConfig({ ...raw, ...patch });
    if (candidate.errors.length) throw fault("SETUP_CONFIG_INVALID", 400);
    await this.exclusive(workspace, async () => {
      await this.api.updateConfig(patch, { workspaceId: workspace.id, workspaceSlug: workspace.slug });
      const profile = await this.store.get(this.profileKey(workspace)) || {};
      await this.store.set(this.profileKey(workspace), { ...profile, state: "needs_setup", operationId: null });
    });
    return this.beginSetup(workspace);
  },

  async setSchedule(workspace, payload, user) {
    if (!user?.id) throw fault("HUMAN_REQUIRED", 403);
    if (typeof payload.enabled !== "boolean" || !["4h", "12h", "1d", "3d", "7d"].includes(payload.cadence)) throw fault("SCHEDULE_INVALID", 400);
    const setup = await this.setupStatus(workspace);
    const before = await this.store.get(this.profileKey(workspace));
    if (setup.state !== "ready" && !before?.scheduleConflict) throw fault("SETUP_NOT_READY");
    await this.api.updateConfig({ MAINTENANCE_ENABLED: payload.enabled, CADENCE: payload.cadence }, { workspaceId: workspace.id, workspaceSlug: workspace.slug });
    const profile = await this.store.get(this.profileKey(workspace));
    await this.store.set(this.profileKey(workspace), { ...profile, scheduleConflict: false, scheduleMigrated: true });
    return this.beginSetup(workspace);
  },

  async preview(workspace, context) {
    return this.exclusive(workspace, async () => {
      const setup = await this.setupStatus(workspace);
      if (setup.state !== "ready") throw fault("SETUP_NOT_READY");
      const active = await this.store.get(this.activeRunKey(workspace));
      if (active) {
        if (active.kind !== "onboarding-preview") throw fault("RUN_BUSY");
        return { accepted: true, runId: active.runId, reused: true };
      }
      const runId = crypto.randomUUID();
      const profile = await this.store.get(this.profileKey(workspace));
      const reservation = { runId, kind: "onboarding-preview", startedAt: now(), scope: setup.scope, revision: profile.revision };
      // Preserve the immutable ceiling even after another run becomes active.
      await this.store.set(`ws-${workspace.id}-preview-${runId}`, reservation);
      const rules = JSON.parse(fs.readFileSync(path.join(workspace.workingDirectory, ".mailkeeper", "rules.json"), "utf8"));
      const reservedFile = path.join(workspace.workingDirectory, ".mailkeeper", "previews", `${runId}.json`);
      fs.mkdirSync(path.dirname(reservedFile), { recursive: true });
      fs.writeFileSync(reservedFile, JSON.stringify({ ...reservation, rules }), { mode: 0o600 });
      await this.store.set(this.activeRunKey(workspace), reservation);
      await this.store.set(this.profileKey(workspace), { ...profile, previewRunId: runId });
      const prompt = `Run MailKeeper's first preview in workspace ${workspace.slug}. Read MAILBOX.md. Execute exactly: node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js onboarding-preview --run-id ${runId}. This finite run snapshots INBOX (at most five pages per account), triages urgency before dry-run proposals, and queues one receipt. It is report-only even when workspace MODE or promoted rules permit changes. Never move, add folders, delete, send, or promote rules. Do not change settings or schedule. Summarize checked count, urgent count, proposals and actual mailbox changes (must be zero); do not quote messages or credentials.`;
      try {
        const result = await this.host.dispatchPreview({ ...context, workspace, threadSlug: profile.threadSlug, taskId: profile.taskId, runId, prompt });
        if (result?.terminalDispatchAccepted !== true) {
          if (result?.code === "TERMINAL_DISPATCH_REQUIRED" || result?.terminalDispatchAccepted === false) {
            await this.submitRun(workspace, { runId, outcome: "blocked", mode: "report-only", actions: [], summary: "Preview could not start. Review the maintenance agent." });
            throw fault("PREVIEW_DISPATCH_BLOCKED");
          }
          return { accepted: true, uncertain: true, runId };
        }
        return { accepted: true, runId };
      } catch (error) {
        // An unknown transport failure may follow dispatch. Preserve identity;
        // retries attach until the original receipt arrives.
        if (error.statusCode && error.code !== "PREVIEW_DISPATCH_BLOCKED") await this.submitRun(workspace, { runId, outcome: "blocked", mode: "report-only", actions: [] });
        throw fault(error.statusCode ? error.code || "PREVIEW_DISPATCH_BLOCKED" : "PREVIEW_STATUS_UNCERTAIN");
      }
    });
  },

  runProjection(receipt) {
    return { runId: receipt.runId, outcome: receipt.outcome, finishedAt: receipt.finishedAt,
      checked: receipt.snapshot?.checked || 0, urgent: receipt.urgent.length,
      proposed: receipt.proposals.reduce((count, entry) => count + (Number(entry.count) || 0), 0),
      actualChanges: receipt.actions.filter((action) => !action.dryRun).length,
      scope: receipt.scope || null, accountOutcomes: receipt.accountOutcomes || [],
    };
  },
};
