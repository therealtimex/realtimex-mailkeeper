"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveProfileConfig, MODES } = require("../runtime/config");

const valid = {
  DEFAULT_MODE_CEILING: "label-only",
  AUTO_FOLDER_PREFIX: "Auto",
  PROTECTED_DOMAINS: [".gov"],
  RETENTION_DAYS: 90,
  EMAIL_ACCOUNTS: ["work"],
  MODE: "report-only",
  CADENCE: "1d",
  AGE_THRESHOLD_DAYS: 90,
  AGGRESSIVENESS: "conservative",
  VIP_SENDERS: ["boss@example.com"],
  AGENT: "codex",
  MODEL: "",
};

test("valid config resolves with no errors", () => {
  const { config, errors } = resolveProfileConfig(valid);
  assert.deepEqual(errors, []);
  assert.equal(config.mode, "report-only");
  assert.deepEqual(config.promotablePasses, ["no-reply", "calendar-response", "sketchy-tld"]);
});

test("workspace mode is capped by the global ceiling", () => {
  const { config } = resolveProfileConfig({ ...valid, MODE: "archive-promoted", DEFAULT_MODE_CEILING: "label-only" });
  assert.equal(config.requestedMode, "archive-promoted");
  assert.equal(config.mode, "label-only");
  assert.equal(config.modeCappedByCeiling, true);
});

test("inbox names are Himalaya account names, which may look like addresses", () => {
  const ok = resolveProfileConfig({ ...valid, EMAIL_ACCOUNTS: ["work", "me@example.com", "My Inbox"] });
  assert.deepEqual(ok.errors, []);
  const bad = resolveProfileConfig({ ...valid, EMAIL_ACCOUNTS: ["work", "line\nbreak", "x".repeat(201)] });
  assert.ok(bad.errors.some((e) => /control characters/.test(e)));
});

test("at least one account is required and duplicates collapse", () => {
  assert.ok(
    resolveProfileConfig({ ...valid, EMAIL_ACCOUNTS: [] }).errors.includes(
      "At least one inbox is required."
    )
  );
  const { config } = resolveProfileConfig({ ...valid, EMAIL_ACCOUNTS: ["a", "a", "b"] });
  assert.deepEqual(config.emailAccounts, ["a", "b"]);
});

test("empty cadence falls back to the daily default", () => {
  const { config, errors } = resolveProfileConfig({ ...valid, CADENCE: "" });
  assert.deepEqual(errors, []);
  assert.equal(config.cadence, "1d");
});

test("cadence must be a positive duration", () => {
  for (const bad of ["0d", "daily", "1w"]) {
    const { errors } = resolveProfileConfig({ ...valid, CADENCE: bad });
    assert.ok(errors.some((e) => /Cadence/.test(e)), `expected cadence error for ${JSON.stringify(bad)}`);
  }
});

test("aggressiveness widens promotable passes", () => {
  const { config } = resolveProfileConfig({ ...valid, AGGRESSIVENESS: "aggressive" });
  assert.ok(config.promotablePasses.includes("personalized-outreach"));
  assert.ok(config.promotablePasses.includes("repeat-sender"));
});

test("mode ladder order is stable", () => {
  assert.deepEqual(MODES, ["report-only", "label-only", "archive-promoted"]);
});

test("effort is forwarded with the agent's option key when a model is selected", () => {
  const codex = resolveProfileConfig({ ...valid, AGENT: "codex", MODEL: "gpt-5", EFFORT: "high" }).config.effort;
  assert.deepEqual(codex, { requested: "high", forwarded: "high", runtimeOptionValues: { reasoning_effort: "high" }, warning: null });
  const claude = resolveProfileConfig({ ...valid, AGENT: "claude", MODEL: "opus", EFFORT: "low" }).config.effort;
  assert.deepEqual(claude.runtimeOptionValues, { effort: "low" });
});

test("empty effort keeps the agent default and forwards nothing", () => {
  for (const EFFORT of ["", "   ", null, undefined]) {
    const { config, errors } = resolveProfileConfig({ ...valid, MODEL: "gpt-5", EFFORT });
    assert.deepEqual(errors, []);
    assert.deepEqual(config.effort, { requested: null, forwarded: null, runtimeOptionValues: {}, warning: null });
  }
});

test("effort that cannot be applied is a warning, never a config error", () => {
  const noModel = resolveProfileConfig({ ...valid, AGENT: "codex", MODEL: "", EFFORT: "high" });
  assert.deepEqual(noModel.errors, []);
  assert.deepEqual(noModel.config.effort.runtimeOptionValues, {});
  assert.deepEqual(noModel.config.effort.warning, { code: "MAILKEEPER_EFFORT_UNSUPPORTED", reason: "no-model" });
  assert.equal(noModel.config.effort.requested, "high");

  const unmapped = resolveProfileConfig({ ...valid, AGENT: "gemini", MODEL: "pro", EFFORT: "high" });
  assert.deepEqual(unmapped.errors, []);
  assert.deepEqual(unmapped.config.effort.warning, { code: "MAILKEEPER_EFFORT_UNSUPPORTED", reason: "unmapped-agent" });
});

test("a missing agent is still a configuration error", () => {
  const { errors } = resolveProfileConfig({ ...valid, AGENT: "", EFFORT: "high" });
  assert.ok(errors.includes("Maintenance agent is required."));
});

test("VIP senders normalise to an address or a domain with its subdomains", () => {
  const { config, errors } = resolveProfileConfig({ ...valid, VIP_SENDERS: ["Boss@Example.com", "*.bank.com", "@school.edu", ".gov.vn"] });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.vipSenders, ["boss@example.com", "bank.com", "school.edu", "gov.vn"]);
  const bad = resolveProfileConfig({ ...valid, VIP_SENDERS: ["*bank*", "not a sender"] });
  assert.equal(bad.errors.filter((e) => /VIP sender/.test(e)).length, 2);
});
