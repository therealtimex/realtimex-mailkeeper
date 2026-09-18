"use strict";

/**
 * Host adapter.
 *
 * Every host capability the plugin needs that is not on the public PluginAPI
 * goes through here, and nowhere else. Two backends:
 *
 *   1. `api.workspaces` / `api.heartbeat` — the public SDK namespaces proposed
 *      in realtimex-ai-app#1996. Used automatically when the host provides
 *      them.
 *   2. `@/` shim — the loader in PluginManager.loadPluginEntrypoint resolves
 *      `@/…` against SERVER_ROOT for any plugin entrypoint. This is the same
 *      path the built-in Dogfood plugin uses today. It is undocumented and is
 *      only a bridge until #1996 ships; nothing outside this file may require
 *      `@/`.
 *
 * The surface exposed here is deliberately identical to the #1996 proposal so
 * that once the host lands it, this file collapses to a pass-through.
 */

const path = require("path");

function hasPublicApi(api) {
  return Boolean(
    api &&
      api.workspaces &&
      typeof api.workspaces.get === "function" &&
      api.heartbeat &&
      typeof api.heartbeat.upsertManagedTask === "function"
  );
}

function lazyHostRequire(request) {
  // Isolated so a missing module surfaces as one clear error, not a stack
  // trace from the middle of a lifecycle hook.
  try {
    return require(request);
  } catch (error) {
    const wrapped = new Error(
      `realtimex-mailbox needs host module "${request}" until realtimex-ai-app#1996 exposes it on PluginAPI: ${error.message}`
    );
    wrapped.code = "MAILBOX_HOST_CAPABILITY_MISSING";
    throw wrapped;
  }
}

// ---------------------------------------------------------------------------
// Shim backend (pre-#1996)
// ---------------------------------------------------------------------------

function shimBackend(api) {
  const { Workspace } = lazyHostRequire("@/models/workspace");
  const { WorkspaceThread } = lazyHostRequire("@/models/workspaceThread");
  const { PluginWorkspaceConfig } = lazyHostRequire(
    "@/models/pluginWorkspaceConfig"
  );
  const { workingDataPath } = lazyHostRequire("@/utils/files");
  const {
    readWorkspaceHeartbeatFile,
    writeWorkspaceHeartbeatFileCoordinated,
  } = lazyHostRequire("@/utils/heartbeat/workspaceFileResolver");
  const {
    parseHeartbeatSettingsBlock,
    removeManagedHeartbeatTask,
    upsertManagedHeartbeatTask,
  } = lazyHostRequire("@/utils/heartbeat/taskBlock");

  const workingDirectoryFor = (slug) => path.join(workingDataPath, slug);

  const toPublicWorkspace = (row) =>
    row
      ? {
          id: row.id,
          slug: row.slug,
          name: row.name,
          workingDirectory: workingDirectoryFor(row.slug),
        }
      : null;

  const workspaces = {
    async get(selector = {}) {
      const row = await Workspace.get(
        selector.id ? { id: selector.id } : { slug: selector.slug }
      );
      return toPublicWorkspace(row);
    },

    async listEnabledForPlugin() {
      const rows = await PluginWorkspaceConfig.forPlugin(api.pluginId);
      const out = [];
      for (const row of rows.filter((entry) => entry.enabled === true)) {
        const workspace = await Workspace.get({ id: row.workspace_id });
        if (workspace) out.push(toPublicWorkspace(workspace));
      }
      return out;
    },

    async ensureThread(workspace, { key, name }) {
      const slug = `${key}`.slice(0, 96);
      let thread = await WorkspaceThread.get({
        workspace_id: workspace.id,
        slug,
      });
      if (thread?.archivedAt) {
        const error = new Error(
          `Thread ${slug} is archived and cannot be reused`
        );
        error.code = "MAILBOX_THREAD_ARCHIVED";
        error.statusCode = 409;
        throw error;
      }
      if (!thread) {
        // WorkspaceThread.new reads chat provider/model defaults off the full
        // workspace row, so resolve it rather than passing the public shape.
        const row = await Workspace.get({ id: workspace.id });
        if (!row) {
          const error = new Error(`Workspace ${workspace.slug} does not exist`);
          error.code = "MAILBOX_WORKSPACE_MISSING";
          error.statusCode = 404;
          throw error;
        }
        const created = await WorkspaceThread.new(row, null, { slug, name });
        thread =
          created.thread ||
          (await WorkspaceThread.get({ workspace_id: workspace.id, slug }));
        if (!thread) {
          throw new Error(created.message || `Could not create thread ${slug}`);
        }
      }
      return { id: thread.id, slug: thread.slug, name: thread.name };
    },
  };

  const owner = (workspace) => ({
    pluginId: api.pluginId,
    workspaceId: workspace.id,
  });

  const heartbeat = {
    async readSettings(workspace) {
      const current = readWorkspaceHeartbeatFile(workspace.workingDirectory);
      const settings = current.exists
        ? parseHeartbeatSettingsBlock(current.content || "")
        : null;
      return {
        exists: current.exists,
        enabled: settings?.enabled !== false,
        activeHours: settings?.activeHours || null,
        timezone: settings?.timezone || null,
        autoPilot: settings?.autoPilot === true,
      };
    },

    async upsertManagedTask(workspace, task) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = readWorkspaceHeartbeatFile(workspace.workingDirectory);
        const settings = parseHeartbeatSettingsBlock(current.content || "");
        const explicitlyPaused = current.exists && settings?.enabled === false;
        const update = upsertManagedHeartbeatTask(current.content || "", {
          owner: owner(workspace),
          defaultHeartbeat: { enabled: true },
          task: {
            ...task,
            interval: explicitlyPaused ? "disabled" : task.interval,
          },
        });
        if (!update.changed) return { changed: false, explicitlyPaused };
        try {
          await writeWorkspaceHeartbeatFileCoordinated(
            workspace.workingDirectory,
            { content: update.content, expectedRevision: current.revision },
            { origin: `plugin:${api.pluginId}`, workspace }
          );
          return { changed: true, explicitlyPaused };
        } catch (error) {
          if (error?.code !== "HEARTBEAT_FILE_CONFLICT" || attempt === 3)
            throw error;
        }
      }
      return { changed: false, explicitlyPaused: false };
    },

    async removeManagedTask(workspace, { id }) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = readWorkspaceHeartbeatFile(workspace.workingDirectory);
        const update = removeManagedHeartbeatTask(current.content || "", {
          taskId: id,
          owner: owner(workspace),
        });
        if (!update.changed) return { changed: false };
        try {
          await writeWorkspaceHeartbeatFileCoordinated(
            workspace.workingDirectory,
            { content: update.content, expectedRevision: current.revision },
            { origin: `plugin:${api.pluginId}`, workspace }
          );
          return { changed: true };
        } catch (error) {
          if (error?.code !== "HEARTBEAT_FILE_CONFLICT" || attempt === 3)
            throw error;
        }
      }
      return { changed: false };
    },
  };

  return { backend: "shim", workspaces, heartbeat };
}

// ---------------------------------------------------------------------------
// Public backend (#1996)
// ---------------------------------------------------------------------------

function publicBackend(api) {
  return {
    backend: "public",
    workspaces: api.workspaces,
    heartbeat: api.heartbeat,
  };
}

const cache = new WeakMap();

function hostFor(api) {
  let host = cache.get(api);
  if (!host) {
    host = hasPublicApi(api) ? publicBackend(api) : shimBackend(api);
    cache.set(api, host);
  }
  return host;
}

module.exports = { hostFor, hasPublicApi };
