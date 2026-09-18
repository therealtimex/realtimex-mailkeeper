"use strict";

const MODES = ["report-only", "label-only", "archive-promoted"];
const AGGRESSIVENESS = ["conservative", "standard", "aggressive"];
const CADENCE_RE = /^(?:\d+d)?(?:\d+h)?(?:\d+m)?$/;

/**
 * Which cleanup passes may be promoted at each aggressiveness level.
 * Mirrors the Vellum inbox-cleanup playbook; "safe" patterns first.
 */
const PASSES_BY_AGGRESSIVENESS = {
  conservative: ["no-reply", "calendar-response", "sketchy-tld"],
  standard: [
    "no-reply",
    "calendar-response",
    "sketchy-tld",
    "receipt",
    "generic-outreach",
    "age",
  ],
  aggressive: [
    "no-reply",
    "calendar-response",
    "sketchy-tld",
    "receipt",
    "generic-outreach",
    "age",
    "personalized-outreach",
    "repeat-sender",
  ],
};

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

function modeRank(mode) {
  return MODES.indexOf(mode);
}

/**
 * Resolve the effective profile for one workspace from the workspace-effective
 * config the host hands us (api.getConfig({ workspaceSlug })).
 *
 * Returns { config, errors }. `errors` non-empty means the profile is not
 * ready and no heartbeat task may be provisioned.
 */
function resolveProfileConfig(raw = {}) {
  const ceiling = text(raw.DEFAULT_MODE_CEILING, 40) || "label-only";
  const requestedMode = text(raw.MODE, 40) || "report-only";
  const effectiveMode =
    modeRank(requestedMode) > modeRank(ceiling) ? ceiling : requestedMode;

  const config = {
    // global
    modeCeiling: ceiling,
    autoFolderPrefix: text(raw.AUTO_FOLDER_PREFIX, 60) || "Auto",
    protectedDomains: list(raw.PROTECTED_DOMAINS),
    retentionDays: Number(raw.RETENTION_DAYS) || 90,
    // workspace
    emailAccount: text(raw.EMAIL_ACCOUNT, 120),
    requestedMode,
    mode: effectiveMode,
    modeCappedByCeiling: effectiveMode !== requestedMode,
    cadence: text(raw.CADENCE, 20).toLowerCase() || "1d",
    ageThresholdDays: Number(raw.AGE_THRESHOLD_DAYS) || 90,
    aggressiveness: text(raw.AGGRESSIVENESS, 20).toLowerCase() || "conservative",
    vipSenders: list(raw.VIP_SENDERS),
    agent: text(raw.AGENT, 60),
    model: text(raw.MODEL, 120),
    contractPath: "MAILBOX.md",
  };
  config.promotablePasses =
    PASSES_BY_AGGRESSIVENESS[config.aggressiveness] ||
    PASSES_BY_AGGRESSIVENESS.conservative;

  const errors = [];
  if (!config.emailAccount) errors.push("Email account is required.");
  if (/[@\s]/.test(config.emailAccount)) {
    errors.push(
      "Email account must be a Himalaya account name, not an address."
    );
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
  resolveProfileConfig,
};
