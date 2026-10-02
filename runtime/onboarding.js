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
    const reservation = profile.previewRunId ? await this.store.get(`ws-${workspace.id}-preview-${profile.previewRunId}`) : null;
    const schedule = await this.host.heartbeat.getManagedTaskStatus?.(workspace, { id: `mailkeeper-maintenance-${workspace.id}` }) || { exists: false };
    const heartbeatSettings = await this.host.heartbeat.readSettings?.(workspace) || {};
    const previewStatus = preview ? this.runProjection(preview) : active?.kind === "onboarding-preview" ? { runId: active.runId, outcome: "pending", scope: active.scope, startedAt: active.startedAt } : profile.previewRunId ? { runId: profile.previewRunId, outcome: "unavailable", scope: reservation?.scope, startedAt: reservation?.startedAt } : null;
    return { schemaVersion: 1, state, stale, blockers: profile.blockers || [],
      missingFields: errors.length ? [!config.emailAccounts.length && "EMAIL_ACCOUNTS", !config.agent && "AGENT"].filter(Boolean) : [],
      operationId: profile.operationId || null, verifiedAt: profile.verifiedAt || null,
      accountChecks: profile.accountChecks || {}, threadSlug: profile.threadSlug || null,
      workspaceName: workspace.name || workspace.slug,
      taskName: "MailKeeper",
      preview: previewStatus,
      scope: { accounts: config.emailAccounts, folders: ["INBOX"], agent: config.agent, model: config.model, mode: "report-only", maxPages: 5, pageSize: 200 },
      maintenanceMode: config.mode,
      checklist: this.setupChecklist({ state, stale, profile, config, errors, preview: previewStatus, schedule }),
      schedule: { intent: config.maintenanceEnabled, cadence: config.cadence, timezone: heartbeatSettings.timezone, activeHours: heartbeatSettings.activeHours, ...schedule },
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
      const reservation = { runId, kind: "onboarding-preview", startedAt: now(), scope: setup.scope, threadSlug: profile.threadSlug, revision: profile.revision };
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
            await this.submitRun(workspace, { runId, outcome: "blocked", mode: "report-only", actions: [], failureCode: "AGENT_LAUNCH_UNKNOWN" });
            return { accepted: false, runId, code: "PREVIEW_DISPATCH_BLOCKED", preview: (await this.setupStatus(workspace)).preview };
          }
          return { accepted: true, uncertain: true, runId };
        }
        return { accepted: true, runId };
      } catch (error) {
        // An unknown transport failure may follow dispatch. Preserve identity;
        // retries attach until the original receipt arrives.
        if (error.statusCode) {
          await this.submitRun(workspace, { runId, outcome: "blocked", mode: "report-only", actions: [], failureCode: error.code });
          return { accepted: false, runId, code: "PREVIEW_DISPATCH_BLOCKED", preview: (await this.setupStatus(workspace)).preview };
        }
        return { accepted: true, uncertain: true, code: "PREVIEW_STATUS_UNCERTAIN", runId };
      }
    });
  },

  runProjection(receipt) {
    const partial = receipt.outcome === "failed" && receipt.accountOutcomes?.some((entry) => entry.outcome === "completed");
    return { runId: receipt.runId, outcome: partial ? "partial" : receipt.outcome, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
      failureCode: receipt.failureCode || (receipt.outcome === "blocked" ? "AGENT_LAUNCH_UNKNOWN" : null),
      checked: receipt.snapshot?.checked || 0, urgent: receipt.urgent.length,
      proposed: receipt.proposals.reduce((count, entry) => count + (Number(entry.count) || 0), 0),
      actualChanges: receipt.actions.filter((action) => !action.dryRun).length,
      scope: receipt.scope || null, accountOutcomes: receipt.accountOutcomes || [],
    };
  },

  setupChecklist({ state, stale, profile, config, errors, preview, schedule }) {
    const codes = (profile.blockers || []).map((entry) => entry.code);
    const checked = Object.values(profile.accountChecks || {});
    const connected = checked.length > 0 && checked.every((entry) => entry.ok) && !stale;
    return [
      { id: "tools", state: codes.includes("CLI_MISSING") ? "failed" : checked.length ? "completed" : "awaiting" },
      { id: "connection", state: state === "checking" ? "active" : connected ? "completed" : codes.some((code) => ["CREDENTIAL_MISSING", "AUTH_FAILED", "CONNECTION_FAILED"].includes(code)) ? "failed" : "awaiting" },
      { id: "settings", state: errors.length ? "awaiting" : "completed" },
      { id: "prepare", state: state === "preparing" ? "active" : state === "ready" ? "completed" : codes.includes("PROVISION_FAILED") ? "failed" : "awaiting" },
      { id: "preview", state: preview?.outcome === "completed" ? "completed" : ["blocked", "failed", "partial"].includes(preview?.outcome) ? "failed" : preview?.outcome === "pending" ? "active" : "awaiting" },
      { id: "schedule", state: config.maintenanceEnabled && schedule?.exists && schedule?.runtimeState === "configured" ? "completed" : "awaiting" },
    ];
  },

  async previewReceiptItems(workspace, threadSlug) {
    const setup = await this.setupStatus(workspace);
    if (!threadSlug || threadSlug !== setup.threadSlug || !setup.preview) return [];
    const index = await this.store.get(this.runIndexKey(workspace)) || [];
    const runs = [setup.preview];
    for (const { runId } of index.slice(0, 20)) {
      if (runId === setup.preview.runId) continue;
      const reserved = await this.store.get(`ws-${workspace.id}-preview-${runId}`);
      if (!reserved || reserved.threadSlug && reserved.threadSlug !== threadSlug) continue;
      const receipt = await this.store.get(this.runKey(workspace, runId));
      if (receipt) runs.push(this.runProjection(receipt));
    }
    return runs.map((run) => this.previewReceiptItem(run));
  },

  previewReceiptItem(run) {
    const outcome = run.outcome === "completed" && run.checked === 0 ? "empty" : run.outcome;
    const labelKey = `mailkeeper-setup.outcome-${outcome}`;
    const detail = (id, labelKey, value, type = "text") => ({ id, labelKey: `mailkeeper-setup.${labelKey}`, value, type });
    const recovery = { AGENT_UNAVAILABLE: "install", AGENT_SIGN_IN_REQUIRED: "sign-in", AGENT_ACCESS_DENIED: "access" }[run.failureCode] || "unknown";
    return { id: run.runId, anchor: { timestamp: Date.parse(run.finishedAt || run.startedAt) || 0 },
      status: { code: outcome, labelKey, summaryKey: labelKey, values: { agent: run.scope?.agent || "" }, tone: outcome === "completed" || outcome === "empty" ? "success" : outcome === "pending" ? "progress" : "warning" },
      details: [
        detail("time", "result-time", Date.parse(run.finishedAt || run.startedAt), "datetime"),
        detail("accounts", "result-accounts", (run.scope?.accounts || []).join(", ")),
        detail("folders", "result-folders", (run.scope?.folders || ["INBOX"]).join(", ")),
        detail("limit", "result-limit", (run.scope?.maxPages || 5) * (run.scope?.pageSize || 200)),
        detail("agent", "result-agent", run.scope?.agent || "—"),
        { id: "model", labelKey: "chat_window.terminal_session_model_label", value: run.scope?.model || "—", type: "text" },
        detail("mode", "effective-mode", "report-only"),
        ...(!["pending", "unavailable"].includes(outcome) ? [detail("checked", "result-checked", run.checked ?? 0), detail("urgent", "result-urgent", run.urgent ?? 0),
          detail("proposed", "result-proposed", run.proposed ?? 0), detail("changes", "result-changes", run.actualChanges ?? 0)] : []),
        ...(["blocked", "failed", "partial", "pending"].includes(run.outcome) ? [detail("recovery", "result-recovery", run.outcome === "blocked" ? run.failureCode === "THREAD_UNAVAILABLE" ? "mailkeeper-setup.thread-recovery" : `mailkeeper-setup.agent-${recovery}` : run.outcome === "pending" ? "mailkeeper-setup.preview-pending" : "mailkeeper-setup.preview-failed", "translation")] : []),
        ...(run.accountOutcomes || []).flatMap((entry, i) => [detail(`account-${i}`, "result-accounts", entry.account), detail(`outcome-${i}`, "result-outcome", `mailkeeper-setup.outcome-${entry.outcome === "completed" ? "completed" : "failed"}`, "translation")]),
      ], actions: [],
    };
  },
};
