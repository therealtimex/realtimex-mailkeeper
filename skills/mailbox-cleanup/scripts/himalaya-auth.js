#!/usr/bin/env node
"use strict";

/**
 * himalaya-auth.js — Himalaya's `backend.auth.cmd` for MailKeeper accounts
 * whose password lives in RealTimeX Secrets.
 *
 * Himalaya runs this with its stdout captured on a private pipe. The password
 * reaches it only through MAILKEEPER_IMAP_PASSWORD, which `rtxexec --env`
 * injected into himalaya-runner.js and Himalaya inherited. Nothing here reads
 * a file, takes the value as an argument, or logs it.
 *
 * Not a command for people or agents: it refuses to run unless
 * himalaya-runner.js marked the same account, and never writes to a terminal.
 */

// realtimex-plugin-validator: allow-process-env -- runs inside Himalaya's auth pipe in the agent terminal; the credential arrives only as the rtxexec-injected environment variable.
const env = process.env;

function refuse(code) {
  // Fixed code only: no value, no account name, no environment detail.
  process.stderr.write(`${code}\n`);
  process.exit(3);
}

function accountArgument(argv) {
  const index = argv.indexOf("--account");
  return index === -1 ? null : argv[index + 1] ?? null;
}

const account = accountArgument(process.argv.slice(2));
if (process.stdout.isTTY) refuse("MAILKEEPER_TERMINAL_REQUIRED");
if (!account || env.MAILKEEPER_AUTH_ACCOUNT !== account) {
  refuse("MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH");
}
const credential = env.MAILKEEPER_IMAP_PASSWORD;
if (typeof credential !== "string" || credential.length === 0) {
  refuse("MAILKEEPER_CREDENTIAL_UNAVAILABLE");
}
process.stdout.write(credential);
