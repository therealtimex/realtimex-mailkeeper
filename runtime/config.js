"use strict";

const {
  MODES,
  AGGRESSIVENESS,
  PASSES_BY_AGGRESSIVENESS,
  modeRank,
  validAccountName,
  normalizeSender,
} = require("../skills/mailbox-cleanup/scripts/mailkeeper-core");

const CADENCE_RE = /^(?:\d+d)?(?:\d+h)?(?:\d+m)?$/;

/**
 * Runtime option key that carries reasoning effort for each verified
 * terminal agent. The public plugin API exposes the scalar EFFORT field, not
 * the host's option resolver, so the mapping lives here; add an agent only
 * after its launch has been verified.
 */
const EFFORT_OPTION_KEYS = { codex: "reasoning_effort", claude: "effort" };

/**
 * The scheduler resolves runtime options against the task's explicit model;
 * with Model empty the option is dropped at launch. Forward effort only when
 * a model is selected so the task never claims an effort it will not get.
 */
const EFFORT_NEEDS_MODEL = true;

function text(value, max = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function list(value) {
  return Array.isArray(value)
    ? value.map((entry) => text(entry, 200)).filter(Boolean)
    : [];
}

/**
 * Decide which runtime option (if any) carries the requested effort.
 * Never an error: an effort the launch cannot apply is a warning the next
 * report explains, and the schedule keeps running at the agent's default.
 */
function resolveEffort({ agent, model, effort }) {
  if (!effort) return { requested: null, forwarded: null, runtimeOptionValues: {}, warning: null };
  const optionKey = EFFORT_OPTION_KEYS[agent];
  if (!optionKey) {
    return {
      requested: effort,
      forwarded: null,
      runtimeOptionValues: {},
      warning: { code: "MAILKEEPER_EFFORT_UNSUPPORTED", reason: "unmapped-agent" },
    };
  }
  if (EFFORT_NEEDS_MODEL && !model) {
    return {
      requested: effort,
      forwarded: null,
      runtimeOptionValues: {},
      warning: { code: "MAILKEEPER_EFFORT_UNSUPPORTED", reason: "no-model" },
    };
  }
  return { requested: effort, forwarded: effort, runtimeOptionValues: { [optionKey]: effort }, warning: null };
}

/**
 * Resolve the effective profile for one workspace from the workspace-effective
 * config the host hands us (api.getConfig({ workspaceSlug })).
 *
 * Returns { config, errors }. `errors` non-empty means the profile is not
 * ready and no heartbeat task may be provisioned. Effort compatibility is
 * never an error; it is reported through `config.effort.warning`.
 */
function resolveProfileConfig(raw = {}) {
  const ceiling = text(raw.DEFAULT_MODE_CEILING, 40) || "label-only";
  const requestedMode = text(raw.MODE, 40) || "report-only";
  const effectiveMode =
    modeRank(requestedMode) > modeRank(ceiling) ? ceiling : requestedMode;
  const accounts = Array.isArray(raw.EMAIL_ACCOUNTS)
    ? raw.EMAIL_ACCOUNTS.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  const vipEntries = list(raw.VIP_SENDERS);
  const agent = text(raw.AGENT, 60);
  const model = text(raw.MODEL, 120);

  const config = {
    // global
    modeCeiling: ceiling,
    autoFolderPrefix: text(raw.AUTO_FOLDER_PREFIX, 60) || "Auto",
    protectedDomains: list(raw.PROTECTED_DOMAINS).map((entry) => entry.toLowerCase()),
    retentionDays: Number(raw.RETENTION_DAYS) || 90,
    // workspace
    emailAccounts: [...new Set(accounts)],
    requestedMode,
    mode: effectiveMode,
    modeCappedByCeiling: effectiveMode !== requestedMode,
    cadence: text(raw.CADENCE, 20).toLowerCase() || "1d",
    ageThresholdDays: Number(raw.AGE_THRESHOLD_DAYS) || 90,
    aggressiveness: text(raw.AGGRESSIVENESS, 20).toLowerCase() || "conservative",
    vipSenders: [...new Set(vipEntries.map(normalizeSender).filter(Boolean))],
    agent,
    model,
    effort: resolveEffort({ agent, model, effort: text(raw.EFFORT, 40) }),
  };
  config.promotablePasses =
    PASSES_BY_AGGRESSIVENESS[config.aggressiveness] ||
    PASSES_BY_AGGRESSIVENESS.conservative;

  const errors = [];
  if (!config.emailAccounts.length) errors.push("At least one inbox is required.");
  for (const account of config.emailAccounts) {
    if (!validAccountName(account)) {
      errors.push("An inbox name is empty, too long, or contains control characters.");
    }
  }
  for (const entry of vipEntries) {
    if (!normalizeSender(entry)) {
      errors.push(`VIP sender "${entry.slice(0, 80)}" is not an email address or domain.`);
    }
  }
  if (!MODES.includes(config.modeCeiling)) errors.push("Mode ceiling is invalid.");
  if (!MODES.includes(config.requestedMode)) errors.push("Mode is invalid.");
  if (!CADENCE_RE.test(config.cadence) || !/[1-9]/.test(config.cadence)) {
    errors.push("Cadence must be a positive duration using m, h, or d.");
  }
  if (!AGGRESSIVENESS.includes(config.aggressiveness)) {
    errors.push("Aggressiveness is invalid.");
  }
  if (!(config.ageThresholdDays > 0)) {
    errors.push("Age threshold must be a positive number of days.");
  }
  if (!config.agent) errors.push("Maintenance agent is required.");

  return { config, errors: [...new Set(errors)] };
}

module.exports = {
  MODES,
  AGGRESSIVENESS,
  PASSES_BY_AGGRESSIVENESS,
  EFFORT_OPTION_KEYS,
  resolveEffort,
  resolveProfileConfig,
};
