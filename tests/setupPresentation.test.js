"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  setupPresentation,
  credentialDialog,
} = require("../runtime/setupPresentation");
const onboarding = require("../runtime/onboarding");
const manifest = require("../realtimex.plugin.json");
const service = { previewReceiptItem: onboarding.previewReceiptItem };
function fixture(patch = {}) {
  return {
    state: "ready",
    hostSupported: true,
    stale: false,
    blockers: [],
    missingFields: [],
    accountChecks: { fixture: { ok: true } },
    workspaceName: "Fixture",
    threadSlug: "maintenance",
    verifiedAt: "2026-10-01T10:00:00Z",
    scope: {
      accounts: ["fixture"],
      folders: ["INBOX"],
      maxPages: 5,
      pageSize: 200,
      agent: "cursor",
      model: "fixture-model",
    },
    maintenanceMode: "report-only",
    schedule: {
      intent: false,
      cadence: "1d",
      timezone: "UTC",
      activeHours: null,
    },
    checklist: [{ id: "connection", state: "completed" }],
    ...patch,
  };
}
test("MailKeeper declares a reusable presentation and owns every mailbox label", () => {
  const raw = fixture();
  const before = JSON.stringify(raw);
  const view = setupPresentation(raw, service);
  assert.equal(view.schemaVersion, 2);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(view.status.labelKey, "mailkeeper-setup.ready");
  assert.equal(view.checklist[0].labelKey, "mailkeeper-setup.step-connection");
  const preview = view.actions.find((entry) => entry.id === "preview");
  assert.deepEqual(preview.confirmation.message.values, {
    accounts: "fixture",
    agent: "cursor",
    count: 1000,
  });
  const declared = new Set(
    manifest.capabilities.ui_contributions[0].actions.map((entry) => entry.id),
  );
  for (const entry of view.actions) {
    if (entry.form)
      for (const choice of entry.form.actions)
        assert.ok(declared.has(choice.actionId || choice.id));
    else if (!entry.kind || entry.kind === "invoke")
      assert.ok(declared.has(entry.id));
  }
});
test("pending and unavailable runs remain distinct from a successful empty preview", () => {
  for (const outcome of ["pending", "unavailable", "blocked"]) {
    const raw = fixture({
      preview: {
        runId: "original",
        outcome,
        checked: 0,
        urgent: 0,
        proposed: 0,
        actualChanges: 0,
        scope: fixture().scope,
      },
    });
    const view = setupPresentation(raw, service);
    const result = view.sections.find((entry) => entry.id === "preview");
    assert.equal(result.status.labelKey, `mailkeeper-setup.outcome-${outcome}`);
    assert.equal(
      view.actions.find((entry) => entry.id === "result").readOnlyNavigation
        .runId,
      "original",
    );
    if (["pending", "unavailable"].includes(outcome))
      assert.ok(!result.details.some((entry) => entry.id === "checked"));
    if (outcome === "pending")
      assert.equal(
        view.actions.find((entry) => entry.id === "preview").disabled,
        true,
      );
  }
});
test("completed, empty and partial previews keep the original counters and account outcomes", () => {
  for (const [outcome, checked, label] of [
    ["completed", 3, "completed"],
    ["completed", 0, "empty"],
    ["partial", 3, "partial"],
  ]) {
    const view = setupPresentation(
      fixture({
        preview: {
          runId: "original",
          outcome,
          checked,
          urgent: 1,
          proposed: 2,
          actualChanges: 0,
          scope: fixture().scope,
          accountOutcomes: [{ account: "fixture", outcome: "completed" }],
        },
      }),
      service,
    );
    const result = view.sections.find((entry) => entry.id === "preview");
    assert.equal(result.status.labelKey, `mailkeeper-setup.outcome-${label}`);
    assert.equal(
      result.details.find((entry) => entry.id === "checked").value,
      checked,
    );
    assert.equal(
      result.details.find((entry) => entry.id === "changes").value,
      0,
    );
  }
});
test("schedule choices preserve manual intent, cadence, ceiling and paused facts", () => {
  const view = setupPresentation(
    fixture({
      schedule: {
        intent: true,
        cadence: "4h",
        timezone: "UTC",
        activeHours: { start: "09:00", end: "17:00" },
        pauseReason: "workspace_paused",
      },
    }),
    service,
  );
  const form = view.actions.find((entry) => entry.id === "schedule").form;
  assert.equal(form.fields[0].value, "4h");
  assert.deepEqual(
    form.actions.map((entry) => entry.payload.enabled),
    [false, true],
  );
  assert.equal(
    form.details.find((entry) => entry.id === "mode").value,
    "report-only",
  );
  assert.equal(
    form.details.find((entry) => entry.id === "next").value,
    "mailkeeper-setup.heartbeat-paused",
  );
});
test("private entry dialog contains references and guidance, without password fields", () => {
  const dialog = credentialDialog([
    {
      accountRef: "fixture",
      supported: true,
      route: "keychain-access",
      service: "fixture-keychain",
      account: "fixture@example.test",
    },
  ]);
  assert.equal(dialog.fields, undefined);
  assert.equal(
    dialog.details.find((entry) => entry.id === "service-0").value,
    "fixture-keychain",
  );
  assert.equal(dialog.actions[0].id, "check");
});
test("all contribution dictionaries preserve translations for MailKeeper's domain", () => {
  for (const contribution of manifest.capabilities.ui_contributions) {
    assert.equal(Object.keys(contribution.options.messages).length, 22);
    for (const dictionary of Object.values(contribution.options.messages)) {
      assert.equal(
        typeof dictionary["mailkeeper-setup.editor-intro"],
        "string",
      );
      assert.equal(
        typeof dictionary["mailkeeper-setup.preview-confirm"],
        "string",
      );
    }
  }
});
