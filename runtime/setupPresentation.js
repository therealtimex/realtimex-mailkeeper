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
  if (schedule.suspendedForRepair) {
    rows.push(detail("next", "next-at-label", "mailkeeper-setup.execution-stopped", "translation"),
      detail("task", "task-state", `mailkeeper-setup.${schedule.exists ? "execution-stopped" : "task-unavailable"}`, "translation"));
    if (schedule.pauseReason === "workspace_paused")
      rows.push(detail("pause", "schedule", "mailkeeper-setup.heartbeat-paused", "translation"));
  } else if (schedule.intent)
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

function fullPresentation(setup, service) {
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
    status: label(setup.schedule.suspendedForRepair
      ? setup.state === "ready" ? "schedule-stopped-ready" : "schedule-stopped-repair"
      : setup.schedule.intent ? "schedule-saved" : "not-scheduled"),
    details: setup.schedule.intent || setup.schedule.suspendedForRepair
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
              disabled: setup.schedule.suspendedForRepair,
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
  if (setup.state === "ready" && setup.schedule.suspendedForRepair)
    actions.push(action("resume-schedule", "resume-schedule", {
      form: {
        title: label("resume-schedule"), description: label("resume-confirm"),
        details: [detail("cadence", "schedule", `mailkeeper-setup.cadence-${setup.schedule.cadence}`, "translation"), ...scheduleDetails(setup)],
        actions: [action("resume", "resume-schedule", {
          actionId: "schedule", variant: "primary",
          payload: { enabled: true, cadence: setup.schedule.cadence, resume: true },
        })],
      },
    }));
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
    title: label("sign-in-account", { account: references[0]?.accountRef || "" }),
    description: label("keychain-instructions"),
    details,
    notices: [{ id: "update", ...label("keychain-edit") }, { id: "return", ...label("credential-return") }],
    actions: [action("check", "saved-check", { variant: "primary",
      payload: { accountRef: references[0]?.accountRef },
      disabled: references.some((entry) => !entry.supported || entry.route !== "keychain-access"),
    })],
  };
}

function setupPresentation(setup, service) {
  const full = fullPresentation(setup, service);
  const setupStarted = setup.setupStarted || Boolean(setup.verifiedAt);
  const connected = setup.state === "ready" && !setup.stale;
  const failed = (setup.blockers || []).find((entry) => ["AUTH_FAILED", "CREDENTIAL_MISSING", "CONNECTION_FAILED"].includes(entry.code));
  const canOpen = connected || (setup.state === "disabled" && setup.threadSlug);
  return {
    ...full, checklist: [], missingFields: [], notices: [],
    status: connected ? label("ready") : failed
      ? label(failed.code === "CONNECTION_FAILED" ? "retry-connection" : "sign-in-account", { account: failed.accountRef }) : setupStarted
      ? label(setup.missingFields?.length ? "next-settings" : states[setup.state] || "needs-setup")
      : label("connect-invite"),
    sections: full.sections.filter((section) => section.id === "connection" && (connected || failed)
      || section.id === "schedule" && (setup.schedule.intent || setup.schedule.suspendedForRepair))
      .map((section) => ({ ...section, details: section.id === "connection"
        ? section.details.filter((row) => row.id !== "verified") : [] })),
    actions: canOpen
      ? full.actions.filter((entry) => entry.id === "open").map((entry) => ({ ...entry, variant: "primary" }))
      : [action("setup", failed?.code === "CONNECTION_FAILED" ? "retry-connection"
        : failed ? "reconnect-account" : setupStarted ? "continue" : "setup", { variant: "primary" })],
  };
}

function journeyPresentation(setup, service) {
  const full = fullPresentation(setup, service);
  const pending = ["checking", "preparing"].includes(setup.state);
  const repairs = (setup.blockers || []).filter((entry) => entry.accountRef && ["CREDENTIAL_MISSING", "AUTH_FAILED", "CONNECTION_FAILED"].includes(entry.code));
  const repairActions = repairs.map((entry, i) => action(`repair-${i}`,
    entry.code === "CONNECTION_FAILED" ? "retry-connection" : "sign-in-account", {
      values: { account: entry.accountRef },
      actionId: entry.code === "CONNECTION_FAILED" ? "check" : "credential",
      payload: { accountRef: entry.accountRef }, disabled: pending,
    }));
  return { ...full, pending,
    notices: full.notices.map((notice) => notice.labelKey === "mailkeeper-setup.credential-recovery"
      ? { id: notice.id, ...label("credential-return") } : notice),
    sections: full.sections.filter((section) => section.id === "connection"),
    actions: [
      ...repairActions,
      ...full.actions.filter((entry) => (entry.id === "check" && !repairs.length && !setup.missingFields?.length)
        || (entry.id === "open" && setup.state === "ready")).map((entry) => entry.id === "check" ? { ...entry, disabled: pending } : entry),
    ],
  };
}

function usagePresentation(setup, service) {
  const full = fullPresentation(setup, service);
  return {
    id: "mailkeeper-usage", expanded: true, actionContract: 2,
    status: { code: full.pending ? "pending" : setup.state, ...label("open"),
      values: { name: "MailKeeper" }, summaryKey: "mailkeeper-setup.usage-intro" },
    details: full.sections.flatMap((section) => [
      { id: `status-${section.id}`, ...section.title, value: section.status.labelKey, type: "translation" },
      ...(section.details || []).map((row) => ({ ...row, id: `${section.id}-${row.id}` })),
    ]),
    handledActionIds: full.handledActionIds,
    actions: [
      ...full.actions.filter((entry) => ["preview", "result", "schedule", "resume-schedule", "agent-settings", "heartbeat-settings"].includes(entry.id)),
      ...setupPresentation(setup, service).actions.filter((entry) => entry.id === "setup")
        .map((entry) => ({ ...entry, variant: "outline" })),
    ],
  };
}

module.exports = { setupPresentation, journeyPresentation, usagePresentation, credentialDialog };
