"use strict";

// Mailbox semantics belong here; the host renders the same contract for every
// plugin. All text is resolved from this plugin's contribution dictionaries.
const label = (key, values) => ({
  labelKey: `mailkeeper-setup.${key}`,
  ...(values ? { values } : {}),
});
const detail = (id, key, value, type = "text") => ({
  id,
  ...label(key),
  value,
  type,
});
const action = (id, key, rest = {}) => ({ id, ...label(key), ...rest });
const states = {
  needs_setup: "needs-setup",
  checking: "checking",
  preparing: "preparing",
  ready: "ready",
  needs_repair: "needs-repair",
  disabled: "disabled",
};
const recovery = (code) =>
  ({
    CLI_MISSING: "install-recovery",
    CREDENTIAL_MISSING: "credential-recovery",
    AUTH_FAILED: "credential-recovery",
    CONNECTION_FAILED: "network-recovery",
    THREAD_ARCHIVED: "thread-recovery",
    SCHEDULE_CONFLICT: "schedule-recovery",
  })[code] || "repair-connection";
const scheduleReason = (schedule) =>
  ({
    workspace_paused: "heartbeat-paused",
    pending_registration: "registration-pending",
    pending_verification: "verification-pending",
    verification_pending: "verification-pending",
  })[schedule.pauseReason || schedule.runtimeState] || "schedule-unavailable";

function scheduleDetails(setup) {
  const schedule = setup.schedule || {};
  const rows = [
    detail(
      "accounts",
      "result-accounts",
      (setup.scope.accounts || []).join(", "),
    ),
    detail("agent", "result-agent", setup.scope.agent || "—"),
    detail("model", "result-model", setup.scope.model || "—"),
    detail("mode", "effective-mode", setup.maintenanceMode),
    detail(
      "timezone",
      "timezone",
      schedule.timezone || "mailkeeper-setup.schedule-unavailable",
      schedule.timezone ? "text" : "translation",
    ),
    detail(
      "hours",
      "active-hours",
      schedule.activeHours?.start || schedule.activeHours?.end
        ? `${schedule.activeHours.start || "00:00"}–${schedule.activeHours.end || "24:00"}`
        : Object.hasOwn(schedule, "activeHours")
          ? "mailkeeper-setup.all-hours"
          : "mailkeeper-setup.schedule-unavailable",
      schedule.activeHours?.start || schedule.activeHours?.end
        ? "text"
        : "translation",
    ),
  ];
  if (schedule.intent)
    rows.push(
      schedule.nextScheduledRunAt
        ? detail(
            "next",
            "next-at-label",
            schedule.nextScheduledRunAt,
            "datetime",
          )
        : detail(
            "next",
            "next-at-label",
            `mailkeeper-setup.${scheduleReason(schedule)}`,
            "translation",
          ),
    );
  else if (schedule.pauseReason === "workspace_paused")
    rows.push(
      detail(
        "next",
        "next-at-label",
        "mailkeeper-setup.heartbeat-paused",
        "translation",
      ),
    );
  return rows;
}

function setupPresentation(setup, service) {
  const pending =
    ["checking", "preparing"].includes(setup.state) ||
    setup.preview?.outcome === "pending";
  const preview = setup.preview;
  const receipt = preview && service.previewReceiptItem(preview);
  const sections = [
    {
      id: "connection",
      title: label("connection"),
      status: label(states[setup.state] || "needs-setup"),
      historicalWhenStale: true,
      details: [
        ...(setup.verifiedAt
          ? [
              detail(
                "verified",
                "verified-at-label",
                setup.verifiedAt,
                "datetime",
              ),
            ]
          : []),
        ...Object.entries(setup.accountChecks || {}).map(
          ([account, check]) => ({
            id: account,
            label: account,
            value: `mailkeeper-setup.${setup.stale ? "historical" : check.ok ? "ready" : "needs-repair"}`,
            type: "translation",
          }),
        ),
      ],
    },
  ];
  if (receipt)
    sections.push({
      id: "preview",
      title: label("view-preview"),
      status: {
        labelKey: receipt.status.labelKey,
        values: receipt.status.values,
      },
      details: receipt.details,
    });
  sections.push({
    id: "schedule",
    title: label("schedule"),
    status: label(setup.schedule.intent ? "schedule-saved" : "not-scheduled"),
    details: setup.schedule.intent
      ? [
          detail(
            "cadence",
            "schedule",
            `mailkeeper-setup.cadence-${setup.schedule.cadence}`,
            "translation",
          ),
          ...scheduleDetails(setup),
        ]
      : [],
  });
  const namedMissing = Boolean(setup.missingFields?.length);
  const notices = [
    ...new Map(
      (setup.blockers || [])
        .filter(
          (entry) =>
            !namedMissing ||
            !["CONFIG_REQUIRED", "CONFIG_INVALID", "PROFILE_INVALID"].includes(
              entry.code,
            ),
        )
        .map((entry) => [`${entry.code}:${entry.accountRef || ""}`, entry]),
    ).values(),
  ].map((entry, i) => ({ id: `blocker-${i}`, ...label(recovery(entry.code)) }));
  const actions = [
    action("setup", setup.operationId ? "continue" : "setup", {
      variant: "primary",
    }),
    action("check", "check", { disabled: pending }),
  ];
  if (["ready", "disabled"].includes(setup.state))
    actions.push(
      action(
        "preview",
        ["blocked", "failed", "partial", "unavailable"].includes(
          preview?.outcome,
        )
          ? "retry-preview"
          : "preview",
        {
          disabled: pending || setup.state !== "ready",
          confirmation: {
            icon: "eye",
            message: label("preview-confirm", {
              accounts: setup.scope.accounts.join(", "),
              agent: setup.scope.agent,
              count: setup.scope.maxPages * setup.scope.pageSize,
            }),
          },
        },
      ),
    );
  if (preview?.outcome === "pending")
    actions.push(action("refresh", "check-status", { kind: "refresh" }));
  if (setup.threadSlug) {
    const navigation = { kind: "thread", threadSlug: setup.threadSlug };
    actions.push(
      action("open", "open", {
        values: { name: "MailKeeper" },
        readOnlyNavigation: navigation,
        errorMessage: label("open-failed"),
      }),
    );
    if (preview)
      actions.push(
        action("result", "view-preview", {
          readOnlyNavigation: { ...navigation, runId: preview.runId },
          errorMessage: label("open-failed"),
        }),
      );
  }
  if (preview?.outcome === "blocked")
    actions.push(
      action("agent-settings", "agent-settings", {
        kind: "navigate",
        navigation: {
          kind: "terminal-agent-settings",
          provider: preview.scope?.agent,
        },
      }),
    );
  actions.push(action("credential", "private-credential"));
  if (
    ["ready", "disabled"].includes(setup.state) ||
    setup.blockers.some((entry) => entry.code === "SCHEDULE_CONFLICT")
  )
    actions.push(
      action("schedule", "schedule", {
        form: {
          title: label("schedule"),
          description: label("schedule-confirm"),
          details: scheduleDetails(setup),
          fields: [
            {
              key: "cadence",
              type: "select",
              ...label("schedule"),
              value: setup.schedule.cadence,
              options: ["4h", "12h", "1d", "3d", "7d"].map((value) => ({
                value,
                ...label(`cadence-${value}`),
              })),
            },
          ],
          actions: [
            action("keep-manual", "keep-manual", {
              actionId: "schedule",
              payload: { enabled: false },
            }),
            action("enable-schedule", "enable-schedule", {
              actionId: "schedule",
              payload: { enabled: true },
              variant: "primary",
            }),
          ],
        },
      }),
    );
  if (setup.schedule.pauseReason === "workspace_paused")
    actions.push(
      action("heartbeat-settings", "heartbeat-settings", {
        kind: "navigate",
        navigation: { kind: "heartbeat-settings" },
      }),
    );
  return {
    schemaVersion: 2,
    state: setup.state,
    status: label(states[setup.state] || "needs-setup"),
    stale: setup.stale,
    pending,
    hostSupported: setup.hostSupported,
    taskName: "MailKeeper",
    workspaceName: setup.workspaceName,
    threadSlug: setup.threadSlug,
    missingFields: setup.missingFields,
    sections,
    notices,
    actions,
    handledActionIds: preview?.outcome === "blocked" ? ["preview"] : [],
    checklist: setup.checklist.map((entry) => ({
      ...entry,
      ...label(`step-${entry.id}`),
    })),
    editor: {
      title: label("editor-title", {
        name: "MailKeeper",
        workspace: setup.workspaceName,
      }),
      description: label("editor-intro"),
      archivedMessage: label("archived-setup"),
    },
  };
}

function credentialDialog(references) {
  const details = references.flatMap((reference, i) =>
    reference.supported && reference.route === "keychain-access"
      ? [
          {
            id: `reference-${i}`,
            label: reference.accountRef,
            value: reference.accountRef,
          },
          detail(`service-${i}`, "keychain-service", reference.service),
          detail(`account-${i}`, "keychain-account", reference.account),
        ]
      : [
          {
            id: `unsupported-${i}`,
            label: reference.accountRef,
            value: "mailkeeper-setup.private-unsupported",
            type: "translation",
          },
        ],
  );
  return {
    title: label("private-credential"),
    description: label("keychain-instructions"),
    details,
    notices: [{ id: "update", ...label("keychain-edit") }],
    actions: [action("check", "saved-check", { variant: "primary" })],
  };
}

module.exports = { setupPresentation, credentialDialog };
