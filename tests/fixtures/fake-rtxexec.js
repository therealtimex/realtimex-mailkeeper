#!/usr/bin/env node
"use strict";

/**
 * Fake `rtxexec --env NAME=secret://ref -- command ...` for tests only.
 * FAKE_SECRETS is a JSON map from secret name to a synthetic value. Like the
 * real tool it refuses before running the child when the session or a
 * secret is missing, and masks known values in the child's output.
 */

const { spawnSync } = require("child_process");

// realtimex-plugin-validator: allow-process-env -- test fixture only; not shipped in the plugin package.
const env = process.env;
const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const bindings = argv.slice(0, split);
const [command, ...args] = argv.slice(split + 1);

if (!env.FAKE_RTX_SESSION) {
  process.stderr.write("rtxexec: No terminal session token. Run rtxexec inside RealTimeX.\n");
  process.exit(1);
}
const secrets = JSON.parse(env.FAKE_SECRETS || "{}");
const injected = {};
for (let i = 0; i < bindings.length; i += 2) {
  if (bindings[i] !== "--env") process.exit(2);
  const [name, ref] = bindings[i + 1].split(/=(.*)/s);
  const secretName = ref.replace(/^secret:\/\//, "").replace(/#.*$/, "");
  if (!Object.prototype.hasOwnProperty.call(secrets, secretName)) {
    process.stderr.write("rtxexec: A referenced secret does not exist.\n");
    process.exit(1);
  }
  injected[name] = secrets[secretName];
}
// Test switch: a slow start before the child runs, for one listing page.
const page = args[args.indexOf("--page") + 1];
if (env.FAKE_RTXEXEC_DELAY_MS && args.includes("--page") && page === env.FAKE_RTXEXEC_DELAY_PAGE) {
  require("fs").writeFileSync(`${env.FAKE_MAILBOX}.wrapper-pid`, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_RTXEXEC_DELAY_MS));
}
const result = spawnSync(command, args, { env: { ...env, ...injected }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const mask = (text) => Object.values(injected).reduce((out, value) => out.split(value).join("****"), String(text || ""));
process.exitCode = result.status ?? 1;
process.stdout.write(mask(result.stdout));
process.stderr.write(mask(result.stderr));
