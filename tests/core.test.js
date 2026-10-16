"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const core = require("../skills/mailbox-cleanup/scripts/mailkeeper-core");

const workspace = {
  mode: "label-only",
  ageThresholdDays: 90,
  promotablePasses: core.PASSES_BY_AGGRESSIVENESS.standard,
  vipSenders: ["boss@example.com"],
  protectedDomains: [".gov"],
  autoFolderPrefix: "Auto",
};

function contract(policy, { prose = "# Inbox\n\nNotes.\n" } = {}) {
  return `${prose}\n## MailKeeper settings\n\n${core.renderPolicyBlock(policy)}\n`;
}

function policy(overrides = {}) {
  return { ...core.draftPolicy("work", workspace), ...overrides };
}

test("account keys are readable, stable and distinct for case and look-alike names", () => {
  const key = core.accountKey("work@example.com");
  assert.match(key, /^work-example-com-[0-9a-f]{12}$/);
  assert.equal(core.accountKey("work@example.com"), key);
  assert.notEqual(core.accountKey("Work"), core.accountKey("work"));
  assert.notEqual(core.accountKey("a b"), core.accountKey("a-b"));
  assert.match(core.accountKey("__proto__"), /^proto-[0-9a-f]{12}$/);
  assert.match(core.accountKey("日本"), /^account-[0-9a-f]{12}$/);
  assert.ok(core.accountKey("x".repeat(200)).length <= 53);
  assert.throws(() => core.accountKey(""));
  assert.throws(() => core.accountKey("a\nb"));
});

test("contract paths stay under mailboxes/<key>/", () => {
  const key = core.accountKey("../../etc/passwd");
  assert.doesNotMatch(key, /[./]/);
  assert.equal(core.contractRelativePath(key), `mailboxes/${key}/MAILBOX.md`);
});

test("Himalaya config resolution follows HIMALAYA_CONFIG, then the first existing default", () => {
  const home = "/home/u";
  const none = () => false;
  assert.deepEqual(core.resolveHimalayaConfig({ himalayaConfig: "/x/c.toml", home, exists: () => true }), {
    paths: ["/x/c.toml"], target: "/x/c.toml", source: "HIMALAYA_CONFIG", missing: false,
  });
  const mac = core.resolveHimalayaConfig({ home, platform: "darwin", exists: (f) => f === path.join(home, ".config/himalaya/config.toml") });
  assert.deepEqual(mac.paths, [path.join(home, ".config/himalaya/config.toml")]);
  const macMissing = core.resolveHimalayaConfig({ home, platform: "darwin", exists: none });
  assert.equal(macMissing.missing, true);
  assert.equal(macMissing.target, path.join(home, "Library/Application Support/himalaya/config.toml"));
  assert.deepEqual(core.himalayaConfigCandidates({ home, platform: "linux" }), [
    path.join(home, ".config/himalaya/config.toml"),
    path.join(home, ".himalayarc"),
  ]);
});

test("senders normalise to addresses or domains; unknown patterns are rejected", () => {
  assert.equal(core.normalizeSender("*.Bank.com"), "bank.com");
  assert.equal(core.normalizeSender("@bank.com"), "bank.com");
  assert.equal(core.normalizeSender("Boss@Example.COM"), "boss@example.com");
  assert.equal(core.normalizeSender("*bank*"), null);
  assert.equal(core.normalizeSender("bank"), null);
  assert.equal(core.normalizeSender("a@b@c.com"), null);
  assert.equal(core.senderMatches("bank.com", "x@mail.bank.com", "mail.bank.com"), true);
  assert.equal(core.senderMatches("bank.com", "x@notbank.com", "notbank.com"), false);
  assert.equal(core.senderMatches("boss@example.com", "other@example.com", "example.com"), false);
});

test("a valid contract block parses, with prose left as guidance", () => {
  const parsed = core.parseContract(contract(policy({ vipSenders: ["*.bank.com"] })), "work");
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.code, null);
  assert.deepEqual(parsed.policy.vipSenders, ["bank.com"]);
  assert.match(parsed.digest, /^[0-9a-f]{64}$/);
});

test("missing, duplicate, malformed and foreign blocks never fall back to permissive defaults", () => {
  assert.equal(core.parseContract("# Old contract\n\nNo block.\n", "work").status, "review-required");
  const twice = contract(policy()) + "\n" + core.renderPolicyBlock(policy());
  assert.equal(core.parseContract(twice, "work").code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(core.parseContract("```mailkeeper-policy\n{not json\n```\n", "work").code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(core.parseContract(contract(policy({ allowDelete: true })), "work").code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(core.parseContract(contract(policy({ mode: "delete-everything" })), "work").code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(core.parseContract(contract(policy({ vipSenders: ["*bank*"] })), "work").code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(core.parseContract(contract(policy({ excludedPasses: ["nope"] })), "work").code, "MAILKEEPER_CONTRACT_INVALID");
  assert.equal(
    core.parseContract(contract(policy({ credential: { kind: "realtimex-secret", passwordRef: "hunter2" } })), "work").code,
    "MAILKEEPER_CONTRACT_INVALID"
  );
  assert.equal(core.parseContract(contract(policy()), "personal").code, "MAILKEEPER_ACCOUNT_IDENTITY_MISMATCH");
});

test("a block awaiting review is report-only until confirmed", () => {
  const parsed = core.parseContract(contract(policy({ mode: "label-only", reviewRequired: true })), "work");
  assert.equal(parsed.status, "review-required");
  assert.equal(core.effectivePolicy(workspace, parsed).mode, "report-only");
});

test("effective policy only ever narrows", () => {
  const strict = core.parseContract(contract(policy({ mode: "report-only" })), "work");
  // A malicious --mode cannot raise a report-only contract.
  assert.equal(core.effectivePolicy(workspace, strict, { requestedMode: "archive-promoted" }).mode, "report-only");

  const loose = core.parseContract(contract(policy({ mode: "archive-promoted", aggressiveness: "aggressive" })), "work");
  const effective = core.effectivePolicy(workspace, loose);
  assert.equal(effective.mode, "label-only", "contract cannot exceed the workspace mode");
  assert.deepEqual(effective.promotablePasses, ["no-reply", "calendar-response", "sketchy-tld", "receipt", "generic-outreach", "age"]);
  assert.equal(core.effectivePolicy(workspace, loose, { requestedMode: "report-only" }).mode, "report-only");

  const narrowed = core.parseContract(contract(policy({ aggressiveness: "conservative", excludedPasses: ["no-reply"] })), "work");
  assert.deepEqual(core.effectivePolicy(workspace, narrowed).promotablePasses, ["calendar-response", "sketchy-tld"]);
});

test("passes that need reply history stay off without a Sent folder", () => {
  const wide = { ...workspace, promotablePasses: core.PASSES_BY_AGGRESSIVENESS.aggressive };
  const noSent = core.parseContract(contract(policy({ aggressiveness: "aggressive" })), "work");
  const withSent = core.parseContract(contract(policy({ aggressiveness: "aggressive", sentFolder: "Sent" })), "work");
  assert.ok(!core.effectivePolicy(wide, noSent).promotablePasses.includes("repeat-sender"));
  assert.ok(core.effectivePolicy(wide, withSent).promotablePasses.includes("repeat-sender"));
});

test("account VIPs add to workspace VIPs and the age threshold is the contract's", () => {
  const parsed = core.parseContract(contract(policy({ vipSenders: ["school.edu"], ageThresholdDays: 30 })), "work");
  const effective = core.effectivePolicy(workspace, parsed);
  assert.deepEqual(effective.vipSenders, ["boss@example.com", "school.edu"]);
  assert.equal(effective.ageThresholdDays, 30);
});

test("credentials: none until setup, the contract's reference after, native for unreviewed legacy text", () => {
  assert.equal(core.effectivePolicy(workspace, core.parseContract(contract(policy()), "work")).credential, null);
  const secret = { kind: "realtimex-secret", passwordRef: "secret://work-imap#password" };
  assert.deepEqual(core.effectivePolicy(workspace, core.parseContract(contract(policy({ credential: secret })), "work")).credential, secret);
  const legacy = core.effectivePolicy(workspace, core.parseContract("# Old shared contract\n", "work"));
  assert.deepEqual(legacy.credential, { kind: "himalaya-native" });
  assert.equal(legacy.mode, "report-only");
});

test("rule identity includes the exact account", () => {
  const rule = { pass: "no-reply", query: "q", action: "move → Auto/Notifications" };
  assert.notEqual(core.ruleId({ ...rule, account: "work" }), core.ruleId({ ...rule, account: "Work" }));
  assert.equal(core.ruleId({ ...rule, account: "work" }), core.ruleId({ ...rule, account: "work" }));
});

test("shell quoting survives quotes and dollars", () => {
  assert.equal(core.shellQuote("it's $HOME"), "'it'\\''s $HOME'");
});
