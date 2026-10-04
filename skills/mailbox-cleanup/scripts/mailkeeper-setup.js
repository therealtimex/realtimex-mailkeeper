#!/usr/bin/env node
"use strict";

// realtimex-plugin-validator: allow-process-env -- transport URL, scoped
// terminal credential and route context are host-injected runtime discovery.
// Plugin settings always come from the authenticated plugin endpoint.
async function main(argv, env = process.env, fetchImpl = fetch) {
  const context = JSON.parse(env.RTX_AGENT_CONTEXT_JSON || "{}");
  const workspaceSlug = context.workspaceSlug;
  const token = env.REALTIMEX_TERMINAL_SESSION_TOKEN;
  if (context.schemaVersion !== 1 || !workspaceSlug || !token || !env.REALTIMEX_BASE_URL) throw Error("SETUP_SESSION_REQUIRED");
  const [command, json] = argv;
  const routes = { status: ["GET", "/setup/status"], check: ["POST", "/setup/check"], configure: ["POST", "/setup/configure"],
    account: ["POST", "/setup/account"], connect: ["POST", "/setup/connect"] };
  if (!routes[command]) throw Error("Use status, check, configure <JSON>, account <JSON>, or connect <JSON>.");
  const [method, route] = routes[command];
  const body = { workspaceSlug };
  if (command === "configure" || command === "account") {
    const parsed = JSON.parse(json || "{}");
    if (Object.keys(parsed).some((key) => /password|secret|token|auth|cmd/i.test(key))) throw Error("PRIVATE_CREDENTIAL_REQUIRED");
    body[command === "configure" ? "config" : "account"] = parsed;
  }
  // connect '{"login":"<login id from status>","account":{"name":"work","host":...}}'
  // links a Login the user chose in setup; it never carries a credential.
  if (command === "connect") {
    const parsed = JSON.parse(json || "{}");
    const account = parsed.account || {};
    if (typeof parsed.login !== "string" || Object.keys(parsed).some((key) => !["login", "account"].includes(key)) ||
        Object.keys(account).some((key) => /password|secret|token|auth|cmd|reference/i.test(key))) throw Error("PRIVATE_CREDENTIAL_REQUIRED");
    body.login = parsed.login;
    body.account = account;
  }
  const root = env.REALTIMEX_BASE_URL.replace(/\/+$/, "").replace(/\/cli$/, "");
  const url = new URL(`${root.endsWith("/api") ? root : `${root}/api`}/plugins/com.realtimex.mailkeeper/routes${route}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("LOCAL_HOST_REQUIRED");
  if (method === "GET") url.searchParams.set("workspaceSlug", workspaceSlug);
  const response = await fetchImpl(url, { method, headers: { authorization: `RealtimeX-Terminal ${token}`, "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw Error(result.code || "SETUP_REQUEST_FAILED");
  return result;
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result))).catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.message })); process.exitCode = 1;
});
