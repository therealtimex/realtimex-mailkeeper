#!/usr/bin/env node
"use strict";

/**
 * Fake Himalaya 1.2 CLI over a JSON mailbox fixture, for tests only.
 *
 * FAKE_MAILBOX names a JSON file:
 *   { accounts: { <name>: { credential: { kind: "secret", password } | { kind: "native" },
 *                           folders: { INBOX: [ { id, from: { addr, name }, subject, date, flags, unsubscribe } ] },
 *                           nextUid, failMove: null | "unknown" | "auth", failMoveAfter: <n successful moves>,
 *                           listFailPage, listInvalidPage, listRepeatPage, listSlowPage: <page number>,
 *                           listSlowMs, listStderrPage + listStderr (a custom failure),
 *                           listPages: { <page>: [rows as returned, valid or not] } } },
 *     calls: [ { op, account } ] }
 *
 * Like the real tool, a moved message gets a new UID in its destination.
 */

const fs = require("fs");

// realtimex-plugin-validator: allow-process-env -- test fixture only; not shipped in the plugin package.
const env = process.env;
const file = env.FAKE_MAILBOX;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
state.calls = state.calls || [];

function save() {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2));
  fs.renameSync(temp, file);
}

function die(message) {
  process.stderr.write(`Error: \n   0: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const positional = [];
const options = { c: [] };
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  if (token === "-c") options.c.push(argv[++i]);
  else if (token === "-a" || token === "-o" || token === "-f" || token === "-p" || token === "-s") options[token.slice(1)] = argv[++i];
  else if (token === "--quiet") options.quiet = true;
  else positional.push(token);
}

for (const config of options.c) {
  if (!fs.existsSync(config)) die(`Cannot find configuration at ${config}.`);
}

const [group, action, ...rest] = positional;
if (group === "account" && action === "list") {
  process.stdout.write(JSON.stringify(Object.keys(state.accounts).map((name) => ({ name, backend: "IMAP", default: false }))));
} else {
  mailboxCommand();
}

function mailboxCommand() {

const account = state.accounts[options.a];
if (!account) die(`cannot find configuration for account ${options.a}`);
state.calls.push({ op: `${group} ${action}`, account: options.a, ...(group === "envelope" ? { folder: options.f, query: rest.join(" ") } : {}) });
save();

// Authentication, as the real tool would perform it through the auth command.
if (account.credential.kind === "secret") {
  if (env.MAILKEEPER_AUTH_ACCOUNT !== options.a || env.MAILKEEPER_IMAP_PASSWORD !== account.credential.password) {
    die("cannot authenticate to IMAP server");
  }
} else if (env.MAILKEEPER_IMAP_PASSWORD) {
  die("unexpected credential for a native account");
}

const folders = account.folders;
if (group === "folder" && action === "list") {
  process.stdout.write(JSON.stringify(Object.keys(folders).map((name) => ({ name, desc: "" }))));
} else if (group === "folder" && action === "add") {
  folders[rest[0]] = folders[rest[0]] || [];
  save();
  process.stdout.write(JSON.stringify(`Folder ${rest[0]} successfully created!`));
} else if (group === "envelope" && action === "list") {
  const rows = folders[options.f];
  if (!rows) die(`cannot select folder ${options.f}`);
  const query = rest.join(" ");
  let list = rows;
  const after = /^after (\d{4}-\d{2}-\d{2})$/.exec(query);
  if (after) list = list.filter((row) => Date.parse(row.date) > Date.parse(after[1]));
  else if (query === "body unsubscribe") list = list.filter((row) => row.unsubscribe === true);
  const size = Number(options.s);
  const page = Number(options.p);
  // Test switches for one listing page: a transport failure, an answer that
  // isn't a list, or the previous page again (pimalaya/himalaya#668).
  if (account.listFailPage === page) die("connection reset by peer");
  if (account.listStderrPage === page) die(account.listStderr);
  if (account.listSlowPage === page) {
    // Record this process so a test can check it was ended, then outlast the caller.
    fs.writeFileSync(`${file}.slow-pid`, String(process.pid));
    if (account.listSlowStderr) process.stderr.write(account.listSlowStderr);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, account.listSlowMs || 30_000);
  }
  if (account.listPages && account.listPages[page]) {
    process.stdout.write(JSON.stringify(account.listPages[page]));
    return;
  }
  if (account.listInvalidPage === page) {
    process.stdout.write(JSON.stringify({ envelopes: [] }));
    return;
  }
  const shown = account.listRepeatPage === page ? page - 1 : page;
  const slice = list.slice((shown - 1) * size, shown * size);
  if (page > 1 && slice.length === 0) die(`cannot list imap envelopes: page ${page} out of bounds`);
  process.stdout.write(JSON.stringify(slice.map(({ unsubscribe, ...row }) => row)));
} else if (group === "message" && action === "move") {
  const from = options.f;
  const [target, ...uids] = rest;
  if (account.failMove && (account.failMoveAfter ?? 0) <= (account.moves ?? 0)) {
    if (account.failMove === "auth") die("cannot authenticate to IMAP server");
    die("connection reset by peer");
  }
  if (!folders[from] || !folders[target]) die("cannot find folder");
  for (const uid of uids) {
    const index = folders[from].findIndex((row) => String(row.id) === uid);
    if (index === -1) die(`cannot find message ${uid}`);
    const [row] = folders[from].splice(index, 1);
    account.nextUid = (account.nextUid || 1000) + 1;
    folders[target].push({ ...row, id: String(account.nextUid) });
  }
  account.moves = (account.moves ?? 0) + 1;
  save();
  process.stdout.write(JSON.stringify("Message(s) successfully moved!"));
} else {
  die("unsupported command in fake");
}
}
