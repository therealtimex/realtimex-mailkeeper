"use strict";

const fs = require("fs");
const path = require("path");
const { definePlugin } = require("@realtimex/plugin-sdk");
const { MailKeeperService, PLUGIN_ID } = require("./runtime/service");

const SKILL_DIR = path.join(__dirname, "skills", "mailbox-cleanup");

const services = new WeakMap();

function serviceFor(api) {
  let service = services.get(api);
  if (!service) {
    service = new MailKeeperService(api);
    services.set(api, service);
  }
  return service;
}

function errorResponse(response, error) {
  return response.status(error?.statusCode || 500).json({
    ok: false,
    error: error?.statusCode ? error.message : "Internal server error",
    code: error?.code || "MAILKEEPER_INTERNAL_ERROR",
  });
}

/**
 * Resolve the target workspace for a route. Mirrors Dogfood: a terminal
 * session bound to a workspace may not claim a different one.
 */
async function resolveWorkspace(service, request, response, { allowInactive = false } = {}) {
  const claimed = request.body?.workspaceSlug || request.query?.workspaceSlug;
  const bound = request.pluginContext?.scope?.workspaceSlug || request.terminalSession?.context?.workspaceSlug;
  if (claimed && bound && claimed !== bound) {
    return { error: "Claimed workspace does not match the terminal session", status: 403 };
  }
  const slug = String(bound || claimed || "").trim();
  if (!slug) return { error: "workspaceSlug is required", status: 400 };
  const workspace = await service.host.workspaces.get({ slug });
  if (!workspace) return { error: "Workspace does not exist", status: 404 };
  if (!allowInactive) {
    const enabled = (await service.host.workspaces.listEnabledForPlugin()).some(
      (entry) => entry.id === workspace.id
    );
    if (!enabled) return { error: "MailKeeper is not active for this workspace", status: 403 };
  }
  // The host's validatedRequest middleware attaches the session user to
  // response.locals; app-id (agent) calls carry no user, which is what
  // "Authenticated human required" checks for.
  return { workspace, user: response?.locals?.user || null };
}

async function withScope(service, request, response, handler, options = {}) {
  const resolved = await resolveWorkspace(service, request, response, options);
  if (resolved.error) {
    return response.status(resolved.status).json({
      ok: false,
      error: resolved.error,
      code: "MAILKEEPER_SCOPE_INVALID",
    });
  }
  try {
    return await handler(resolved);
  } catch (error) {
    service.api.log?.error?.("MailKeeper request failed", { code: error?.code || "MAILKEEPER_INTERNAL_ERROR" });
    return errorResponse(response, error);
  }
}

function readSkillFiles() {
  const files = {};
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else files[rel] = fs.readFileSync(path.join(dir, entry.name), "utf8");
    }
  };
  walk(SKILL_DIR);
  return files;
}

module.exports = definePlugin({
  id: "com.realtimex.mailkeeper", // must equal PLUGIN_ID in runtime/service.js

  register(api) {
    const service = serviceFor(api);
    const routeOptions = { auth: "internalOrAppId" };

    const setupScope = (request, response, handler) => {
      if (!request.pluginContext?.scope?.workspaceSlug && !request.terminalSession?.context?.workspaceSlug && !response.locals?.user?.id) {
        return response.status(403).json({ ok: false, code: "SETUP_SCOPE_REQUIRED" });
      }
      return withScope(service, request, response, handler);
    };
    api.registerRoute("GET", "/setup/status", (request, response) =>
      setupScope(request, response, async ({ workspace }) => response.json({ ok: true, ...(await service.setupStatus(workspace)) })), routeOptions);
    api.registerRoute("POST", "/setup/check", (request, response) =>
      setupScope(request, response, async ({ workspace }) => response.status(202).json({ ok: true, ...(await service.beginSetup(workspace)) })), routeOptions);
    api.registerRoute("POST", "/setup/configure", (request, response) =>
      setupScope(request, response, async ({ workspace }) => response.status(202).json({ ok: true, ...(await service.configureSetup(workspace, request.body?.config)) })), routeOptions);
    api.registerRoute("POST", "/setup/account", (request, response) =>
      setupScope(request, response, async () => {
        const result = await api.email.configureHimalayaAccount(request.body?.account);
        return response.json({ ok: true, configured: result.configured, revision: result.revision });
      }), routeOptions);
    api.registerRoute("GET", "/setup/card", (request, response) =>
      withScope(service, request, response, async ({ workspace }) => response.json({ items: [await service.setupStatus(workspace)] }),
        { allowInactive: request.pluginContext?.readOnly === true }), { auth: "contribution", availableWhenInactive: true });
    api.registerRoute("GET", "/setup/receipts", (request, response) =>
      withScope(service, request, response, async ({ workspace }) => response.json({ items: await service.previewReceiptItems(workspace, request.pluginContext?.scope?.threadSlug) }),
        { allowInactive: request.pluginContext?.readOnly === true }), { auth: "contribution", availableWhenInactive: true });
    api.registerRoute("POST", "/setup/action", (request, response) =>
      withScope(service, request, response, async ({ workspace, user }) => {
        const action = request.pluginContext.actionId;
        if (action === "setup") return response.json({ ok: true, navigation: { kind: "ai-editor", fieldKey: "MAILKEEPER_SETUP_FILE" } });
        if (action === "check") return response.status(202).json({ ok: true, ...(await service.beginSetup(workspace)) });
        if (action === "credential") {
          const { config } = service.profileConfig(workspace);
          const references = await Promise.all(config.emailAccounts.map(async (accountRef) => ({ accountRef, ...(await api.email.getCredentialReference(accountRef)) })));
          return response.json({ ok: true, credentials: references });
        }
        if (action === "preview") return response.status(202).json({ ok: true, ...(await service.preview(workspace, { request, response })) });
        if (action === "schedule") return response.status(202).json({ ok: true, ...(await service.setSchedule(workspace, request.body?.payload || {}, user)) });
        if (action === "open" || action === "result") {
          const setup = await service.setupStatus(workspace);
          const thread = setup.threadSlug && await service.host.workspaces.getThread(workspace, { slug: setup.threadSlug });
          if (!thread || thread.archivedAt) return response.status(409).json({ ok: false, code: "THREAD_UNAVAILABLE" });
          if (action === "result" && !setup.preview) return response.status(404).json({ ok: false, code: "PREVIEW_RESULT_UNAVAILABLE" });
          return response.json({ ok: true, navigation: { kind: "thread", threadSlug: thread.slug, runId: action === "result" ? setup.preview.runId : null } });
        }
        return response.status(400).json({ ok: false, code: "ACTION_UNKNOWN" });
      }), { auth: "contribution" });
    api.registerRoute("GET", "/runs", (request, response) =>
      withScope(service, request, response, async ({ workspace }) => {
        await service.ingestOutbox(workspace);
        const index = await service.store.get(service.runIndexKey(workspace)) || [];
        const runs = await Promise.all(index.slice(0, 20).map(async ({ runId }) => service.runProjection(await service.store.get(service.runKey(workspace, runId)))));
        return response.json({ ok: true, runs });
      }), routeOptions);

    api.registerWorkspaceSkillProvider("mailkeeper-workspace-skill", async () => [
      {
        name: "mailbox-cleanup",
        displayName: "Mailbox Cleanup",
        description:
          "Multi-pass mailbox cleanup playbook over Himalaya: snapshot, urgency triage, promoted-rule maintenance, proposals, receipts, undo.",
        files: readSkillFiles(),
      },
    ]);

    api.registerRoute(
      "GET",
      "/status",
      (request, response) =>
        withScope(service, request, response, async ({ workspace }) =>
          response.status(200).json({ ok: true, ...(await service.status(workspace)) })
        ),
      routeOptions
    );

    // Options for the EMAIL_ACCOUNTS picker. A workspace configures the plugin
    // before enabling it, so this must answer while inactive; it needs no
    // workspace scope because the account list is host-wide.
    api.registerRoute(
      "GET",
      "/accounts",
      async (request, response) => {
        try {
          return response.status(200).json({ ok: true, ...(await service.accountOptions()) });
        } catch (error) {
          service.api.log?.error?.("MailKeeper account list failed", { error: error.message });
          return errorResponse(response, error);
        }
      },
      { ...routeOptions, availableWhenInactive: true }
    );

    api.registerRoute(
      "POST",
      "/runs",
      (request, response) =>
        withScope(
          service,
          request,
          response,
          async ({ workspace }) => {
            const result = await service.submitRun(workspace, request.body || {});
            return response.status(200).json({ ok: true, ...result });
          },
          { allowInactive: true }
        ),
      { ...routeOptions, availableWhenInactive: true }
    );

    api.registerRoute(
      "POST",
      "/rules/promote",
      (request, response) =>
        withScope(service, request, response, async ({ workspace, user }) => {
          const result = await service.promoteRule(workspace, request.body || {}, user);
          return response.status(200).json({ ok: true, ...result });
        }),
      routeOptions
    );

    api.registerRoute(
      "POST",
      "/rules/demote",
      (request, response) =>
        withScope(service, request, response, async ({ workspace, user }) => {
          const result = await service.demoteRule(workspace, request.body || {}, user);
          return response.status(200).json({ ok: true, ...result });
        }),
      routeOptions
    );

    api.registerRoute(
      "POST",
      "/undo",
      (request, response) =>
        withScope(service, request, response, async ({ workspace, user }) => {
          const result = await service.undoRun(workspace, request.body || {}, user);
          return response.status(200).json({ ok: true, ...result });
        }),
      routeOptions
    );

    api.registerRoute(
      "POST",
      "/repair",
      (request, response) =>
        withScope(service, request, response, async ({ workspace, user }) => {
          if (!user?.id) {
            return response
              .status(403)
              .json({ ok: false, error: "Authenticated human required" });
          }
          const result = await service.beginSetup(workspace);
          return response.status(202).json({ ok: true, ...result });
        }),
      routeOptions
    );
  },

  async activate(api) {
    await serviceFor(api).activateAll();
  },

  async activateWorkspace(api, { workspace }) {
    const resolved = await serviceFor(api).host.workspaces.get({ id: workspace.id });
    await serviceFor(api).beginSetup(resolved || workspace);
  },

  async configureWorkspace(api, { workspace }) {
    const resolved = await serviceFor(api).host.workspaces.get({ id: workspace.id });
    await serviceFor(api).beginSetup(resolved || workspace);
  },

  async deactivateWorkspace(api, { workspace }) {
    const resolved = await serviceFor(api).host.workspaces.get({ id: workspace.id });
    await serviceFor(api).disable(resolved || workspace);
  },

  async deactivate(api) {
    await serviceFor(api).disableAll();
  },

  async admitHeartbeatTask(api, context) {
    return serviceFor(api).admitHeartbeat(context);
  },

  async recordHeartbeatDispatch(api, context) {
    return serviceFor(api).recordHeartbeatDispatch(context);
  },

  async recordHeartbeatLifecycle(api, context) {
    return serviceFor(api).recordHeartbeatLifecycle(context);
  },

  async resolveManagedHeartbeatLaunchPolicy(api, context) {
    return serviceFor(api).resolveHeartbeatLaunchPolicy(context);
  },
});
