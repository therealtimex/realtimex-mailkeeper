"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawnSync } = require("child_process");
const { promisify } = require("util");

const { startImapStub } = require("./fixtures/imap-stub");
const { himalayaArgs, classify } = require("../skills/mailbox-cleanup/scripts/himalaya-runner");

const execFileAsync = promisify(execFile);
const SCRIPTS = path.join(__dirname, "..", "skills", "mailbox-cleanup", "scripts");
const RUNNER = path.join(SCRIPTS, "himalaya-runner.js");
const AUTH = path.join(SCRIPTS, "himalaya-auth.js");
const HAS_HIMALAYA = spawnSync("himalaya", ["--version"], { stdio: "ignore" }).status === 0;
const USER = "probe@example.invalid";

// A synthetic credential: never a real secret, unique per run so a match in
// any captured surface can only be a leak.
const SENTINEL = `mk-sentinel-${crypto.randomBytes(12).toString("hex")}`;

function writeConfig(dir, port, { account = "probe", helperAccount = account, authKey = "cmd" } = {}) {
  const helper = `${JSON.stringify(process.execPath)} ${JSON.stringify(AUTH)} --account ${JSON.stringify(helperAccount)}`;
  const file = path.join(dir, `config-${crypto.randomUUID()}.toml`);
  fs.writeFileSync(
    file,
    [
      `[accounts.${JSON.stringify(account)}]`,
      `email = ${JSON.stringify(USER)}`,
      'backend.type = "imap"',
      'backend.host = "127.0.0.1"',
      `backend.port = ${port}`,
      'backend.encryption.type = "none"',
      `backend.login = ${JSON.stringify(USER)}`,
      'backend.auth.type = "password"',
      `backend.auth.${authKey} = ${JSON.stringify(helper)}`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  return file;
}

async function runRunner(args, { kind = "realtimex-secret", credential = SENTINEL } = {}) {
  const env = { ...process.env, MAILKEEPER_CREDENTIAL_KIND: kind };
  delete env.MAILKEEPER_IMAP_PASSWORD;
  if (credential !== null) env.MAILKEEPER_IMAP_PASSWORD = credential;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [RUNNER, ...args], { env, timeout: 30000 });
    return { exit: 0, stdout, stderr, result: JSON.parse(stdout) };
  } catch (error) {
    return { exit: error.code, stdout: error.stdout, stderr: error.stderr, result: JSON.parse(error.stdout) };
  }
}

/**
 * Forms a leaked credential could take in a diagnostic: verbatim, encoded,
 * or a recognisable fragment of it.
 */
function leakForms(value) {
  const forms = [value, Buffer.from(value).toString("base64"), encodeURIComponent(value), Buffer.from(value).toString("hex")];
  for (let i = 0; i + 12 <= value.length; i += 6) forms.push(value.slice(i, i + 12));
  return forms;
}

function assertNoLeak(run, ...surfaces) {
  for (const surface of [run.stdout, run.stderr, ...surfaces]) {
    for (const form of leakForms(SENTINEL)) {
      assert.equal(String(surface).includes(form), false, "credential (or an encoding or fragment of it) reached a captured surface");
    }
  }
}

test("runner maps operations to bounded Himalaya argv", () => {
  assert.deepEqual(himalayaArgs("folder-list", {}), { command: ["folder", "list"], options: [], positionals: [] });
  // The query is a positional: it is placed after every option, so it can't swallow -a/-c.
  assert.deepEqual(himalayaArgs("envelope-list", { folder: "INBOX", page: "2", size: "200", query: "after 2026-01-01" }), {
    command: ["envelope", "list"],
    options: ["-f", "INBOX", "-p", "2", "-s", "200"],
    positionals: ["after 2026-01-01"],
  });
  assert.deepEqual(himalayaArgs("message-move", { from: "INBOX", to: "Auto/Bulk", uid: ["1", "22"] }), {
    command: ["message", "move"],
    options: ["-f", "INBOX"],
    positionals: ["Auto/Bulk", "1", "22"],
  });
  // Unknown operations, control characters, non-numeric UIDs and no-op moves are refused.
  assert.equal(himalayaArgs("message-delete", { uid: ["1"] }), null);
  assert.equal(himalayaArgs("folder-add", { name: "Auto/\nInjected" }), null);
  assert.equal(himalayaArgs("message-move", { from: "INBOX", to: "Auto/X", uid: ["1;rm"] }), null);
  assert.equal(himalayaArgs("message-move", { from: "INBOX", to: "INBOX", uid: ["1"] }), null);
  assert.equal(himalayaArgs("message-move", { from: "INBOX", to: "X", uid: Array.from({ length: 201 }, (_, i) => String(i + 1)) }), null);
});

test("runner classifies failures with fixed codes and treats unknown mutation failures as uncertain", () => {
  assert.equal(classify("folder-list", { error: { code: "ENOENT" } }), "MAILKEEPER_HIMALAYA_UNAVAILABLE");
  assert.equal(classify("folder-list", { signal: "SIGTERM" }), "MAILKEEPER_TIMEOUT");
  assert.equal(classify("message-move", { signal: "SIGTERM" }), "MAILKEEPER_MUTATION_UNCERTAIN");
  assert.equal(classify("folder-list", { stderr: "0: cannot find configuration for account x" }), "MAILKEEPER_ACCOUNT_NOT_FOUND");
  assert.equal(classify("folder-list", { stderr: "Cannot find configuration at /x/config.toml." }), "MAILKEEPER_HIMALAYA_CONFIG_MISSING");
  assert.equal(classify("folder-list", { stderr: "cannot parse config file at /x" }), "MAILKEEPER_HIMALAYA_CONFIG_INVALID");
  assert.equal(classify("folder-list", { stderr: "cannot connect to TCP stream\nOperation not permitted (os error 1)" }), "MAILKEEPER_NETWORK_DENIED");
  assert.equal(classify("folder-list", { stderr: "cannot build IMAP client\nConnection refused (os error 61)" }), "MAILKEEPER_IMAP_CHECK_FAILED");
  // Himalaya's own connect timeout, as observed live (macOS os error 60):
  // nothing was sent, so even a move is a plain timeout, not uncertain.
  const connectTimeout = "cannot build IMAP client\ncannot connect to TCP stream\nOperation timed out (os error 60)";
  assert.equal(classify("folder-list", { stderr: connectTimeout }), "MAILKEEPER_TIMEOUT");
  assert.equal(classify("message-move", { stderr: connectTimeout }), "MAILKEEPER_TIMEOUT");
  assert.equal(classify("message-move", { stderr: "Connection timed out (os error 110)" }), "MAILKEEPER_MUTATION_UNCERTAIN");
  assert.equal(classify("folder-list", { stderr: "something new" }), "MAILKEEPER_OPERATION_FAILED");
  assert.equal(classify("message-move", { stderr: "something new" }), "MAILKEEPER_MUTATION_UNCERTAIN");
});

test("auth helper refuses without the runner's account marker or a credential", () => {
  const base = { ...process.env };
  delete base.MAILKEEPER_IMAP_PASSWORD;
  delete base.MAILKEEPER_AUTH_ACCOUNT;
  const cases = [
    [{}, "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH"],
    [{ MAILKEEPER_AUTH_ACCOUNT: "other", MAILKEEPER_IMAP_PASSWORD: SENTINEL }, "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH"],
    [{ MAILKEEPER_AUTH_ACCOUNT: "probe" }, "MAILKEEPER_CREDENTIAL_UNAVAILABLE"],
  ];
  for (const [extra, code] of cases) {
    const result = spawnSync(process.execPath, [AUTH, "--account", "probe"], {
      env: { ...base, ...extra },
      encoding: "utf8",
    });
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), code);
  }
});

test("runner refuses a missing or unknown credential kind before starting Himalaya", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-cred-"));
  const config = writeConfig(dir, 1);
  const missing = await runRunner(["folder-list", "--account", "probe", "--config", config], { credential: null });
  assert.equal(missing.result.code, "MAILKEEPER_CREDENTIAL_UNAVAILABLE");
  const unknown = await runRunner(["folder-list", "--account", "probe", "--config", config], { kind: "plaintext" });
  assert.equal(unknown.result.code, "MAILKEEPER_CREDENTIAL_UNAVAILABLE");
  const relative = await runRunner(["folder-list", "--account", "probe", "--config", "config.toml"]);
  assert.equal(relative.result.code, "MAILKEEPER_HIMALAYA_CONFIG_MISSING");
  assertNoLeak(missing);
  assertNoLeak(unknown, fs.readFileSync(config, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Secrets credential reaches Himalaya only through the auth pipe", { skip: !HAS_HIMALAYA && "himalaya not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-cred-"));
  const stub = await startImapStub({ user: USER, password: SENTINEL });
  try {
    for (const authKey of ["cmd", "command"]) {
      const config = writeConfig(dir, stub.port, { authKey });
      const run = await runRunner(["folder-list", "--account", "probe", "--config", config, "--timeout-ms", "15000"]);
      assert.equal(run.result.ok, true, `auth.${authKey}`);
      assert.deepEqual(run.result.data.map((folder) => folder.name), ["INBOX", "Archive"]);
      assertNoLeak(run, fs.readFileSync(config, "utf8"));
    }
    assert.equal(stub.log.filter((event) => event.login === "accepted").length, 2);

    const wrong = await runRunner(
      ["folder-list", "--account", "probe", "--config", writeConfig(dir, stub.port), "--timeout-ms", "15000"],
      { credential: `${SENTINEL}-wrong` }
    );
    assert.equal(wrong.result.code, "MAILKEEPER_IMAP_CHECK_FAILED");
    assertNoLeak(wrong);

    // A stanza whose helper names another account is refused by the helper,
    // so a selector mix-up can never hand this credential to another inbox.
    const mismatched = await runRunner([
      "folder-list", "--account", "probe", "--config", writeConfig(dir, stub.port, { helperAccount: "other" }), "--timeout-ms", "15000",
    ]);
    assert.equal(mismatched.result.ok, false);
    assertNoLeak(mismatched);

    const notConfigured = await runRunner(["folder-list", "--account", "other", "--config", writeConfig(dir, stub.port)]);
    assert.equal(notConfigured.result.code, "MAILKEEPER_ACCOUNT_NOT_FOUND");
  } finally {
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a filtered listing signs in as the requested inbox, never the default account", { skip: !HAS_HIMALAYA && "himalaya not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-argv-"));
  const stub = await startImapStub({ user: USER, password: SENTINEL });
  const marker = path.join(dir, "decoy-auth-ran");
  try {
    // A default account whose auth command leaves a marker if Himalaya ever
    // resolves it, ahead of the inbox the runner asks for.
    const decoy = [
      "[accounts.decoy]",
      "default = true",
      'email = "decoy@example.invalid"',
      'backend.type = "imap"',
      'backend.host = "127.0.0.1"',
      "backend.port = 9",
      'backend.encryption.type = "none"',
      'backend.login = "decoy@example.invalid"',
      'backend.auth.type = "password"',
      `backend.auth.cmd = ${JSON.stringify(`/usr/bin/touch ${JSON.stringify(marker)}`)}`,
      "",
    ].join("\n");
    const config = writeConfig(dir, stub.port);
    fs.writeFileSync(config, decoy + fs.readFileSync(config, "utf8"));
    for (const query of ["body unsubscribe", "after 2026-01-01"]) {
      const run = await runRunner([
        "envelope-list", "--account", "probe", "--config", config,
        "--folder", "INBOX", "--page", "1", "--size", "2", "--query", query, "--timeout-ms", "15000",
      ]);
      assert.equal(fs.existsSync(marker), false, `the default account's auth never runs for "${query}"`);
      assertNoLeak(run, fs.readFileSync(config, "utf8"));
    }
    assert.ok(stub.log.some((event) => event.login === "accepted"), "the requested inbox signed in");
  } finally {
    await stub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unreachable and silent servers map to fixed codes", { skip: !HAS_HIMALAYA && "himalaya not installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mk-cred-"));
  const closed = await startImapStub({ user: USER, password: SENTINEL });
  const closedPort = closed.port;
  await closed.close();
  const refused = await runRunner(["folder-list", "--account", "probe", "--config", writeConfig(dir, closedPort)]);
  assert.equal(refused.result.code, "MAILKEEPER_IMAP_CHECK_FAILED");

  const hang = await startImapStub({ mode: "hang" });
  try {
    const silent = await runRunner(["folder-list", "--account", "probe", "--config", writeConfig(dir, hang.port), "--timeout-ms", "2000"]);
    assert.equal(silent.result.code, "MAILKEEPER_TIMEOUT");
    assertNoLeak(silent);
  } finally {
    await hang.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
