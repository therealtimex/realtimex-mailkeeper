"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveProfileConfig, MODES } = require("../runtime/config");

const valid = {
  DEFAULT_MODE_CEILING: "label-only",
  AUTO_FOLDER_PREFIX: "Auto",
  PROTECTED_DOMAINS: [".gov"],
  RETENTION_DAYS: 90,
  EMAIL_ACCOUNT: "work",
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

test("email account must be a Himalaya account name, not an address", () => {
  const { errors } = resolveProfileConfig({ ...valid, EMAIL_ACCOUNT: "me@example.com" });
  assert.ok(errors.some((e) => /account name/.test(e)));
});

test("missing account is an error", () => {
  const { errors } = resolveProfileConfig({ ...valid, EMAIL_ACCOUNT: "" });
  assert.ok(errors.includes("Email account is required."));
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
