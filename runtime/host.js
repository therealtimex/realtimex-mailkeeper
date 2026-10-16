"use strict";

/**
 * Host adapter.
 *
 * Every host capability the plugin needs that is not getConfig/getStore or a
 * route goes through here, and nowhere else. MailKeeper uses only the public
 * plugin SDK namespaces:
 *
 *   api.workspaces.get / listEnabledForPlugin / ensureThread
 *   api.heartbeat.readSettings / upsertManagedTask / removeManagedTask
 *
 * A host without them cannot run MailKeeper; it reports one coded error
 * instead of reaching into server internals.
 */

const REQUIRED = {
  workspaces: ["get", "listEnabledForPlugin", "ensureThread"],
  heartbeat: ["readSettings", "upsertManagedTask", "removeManagedTask"],
};

function hasPublicApi(api) {
  return Object.entries(REQUIRED).every(([namespace, methods]) =>
    methods.every((method) => typeof api?.[namespace]?.[method] === "function")
  );
}

const cache = new WeakMap();

function hostFor(api) {
  let host = cache.get(api);
  if (!host) {
    if (!hasPublicApi(api)) {
      const error = new Error(
        "realtimex-mailkeeper needs a RealTimeX host with the public plugin workspaces and heartbeat APIs"
      );
      error.code = "MAILKEEPER_HOST_CAPABILITY_MISSING";
      throw error;
    }
    host = { backend: "public", workspaces: api.workspaces, heartbeat: api.heartbeat };
    cache.set(api, host);
  }
  return host;
}

module.exports = { hostFor, hasPublicApi };
