"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  setupPresentation,
  journeyPresentation,
  usagePresentation,
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
test("ready card leads into usage without requiring preview or scheduling", () => {
  const raw = fixture();
  const before = JSON.stringify(raw);
  const view = setupPresentation(raw, service);
  assert.equal(view.schemaVersion, 2);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(view.status.labelKey, "mailkeeper-setup.ready");
  assert.deepEqual(view.checklist, []);
  assert.deepEqual(view.actions.map((entry) => entry.id), ["open", "setup"]);
  assert.equal(view.actions[0].variant, "primary");
  assert.equal(view.actions[1].variant, "outline");
  assert.deepEqual(view.actions[1].navigation, { kind: "ai-editor", fieldKey: "MAILKEEPER_SETUP_FILE" });
  const usage = usagePresentation(raw, service);
  assert.equal(usage.expanded, true);
  assert.equal(usage.actionContract, 2);
  const preview = usage.actions.find((entry) => entry.id === "preview");
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
    const card = setupPresentation(raw, service);
    assert.equal(card.status.labelKey, "mailkeeper-setup.ready");
    assert.deepEqual(card.actions.map((entry) => entry.id), ["open", "setup"]);
    const view = usagePresentation(raw, service);
    const result = view.details.find((entry) => entry.id === "status-preview");
    assert.equal(result.value, `mailkeeper-setup.outcome-${outcome}`);
    assert.equal(
      view.actions.find((entry) => entry.id === "result").readOnlyNavigation
        .runId,
      "original",
    );
    if (["pending", "unavailable"].includes(outcome))
      assert.ok(!view.details.some((entry) => entry.id === "preview-checked"));
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
    const view = usagePresentation(
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
    assert.equal(view.details.find((entry) => entry.id === "status-preview").value, `mailkeeper-setup.outcome-${label}`);
    assert.equal(
      view.details.find((entry) => entry.id === "preview-checked").value,
      checked,
    );
    assert.equal(
      view.details.find((entry) => entry.id === "preview-changes").value,
      0,
    );
  }
});
test("schedule choices preserve manual intent, cadence, ceiling and paused facts", () => {
  const view = usagePresentation(
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
  assert.equal(dialog.actions[0].labelKey, "mailkeeper-setup.saved-check");
  assert.deepEqual(dialog.actions[0].payload, { accountRef: "fixture" });
  assert.equal(dialog.title.values.account, "fixture");
  assert.ok(dialog.notices.some((entry) => entry.labelKey === "mailkeeper-setup.credential-return"));
});
test("all contribution dictionaries preserve translations for MailKeeper's domain", () => {
  for (const contribution of manifest.capabilities.ui_contributions) {
    assert.equal(Object.keys(contribution.options.messages).length, 22);
    for (const dictionary of Object.values(contribution.options.messages)) {
      assert.equal(
        typeof dictionary["mailkeeper-setup.editor-intro"],
        "string",
      );
      assert.equal(typeof dictionary["mailkeeper-setup.connect-invite"], "string");
      if (contribution.surface === "chat-history")
        assert.equal(typeof dictionary["mailkeeper-setup.preview-confirm"], "string");
    }
  }
});

test("fresh and saved cards offer one setup journey with no credential destination", () => {
  for (const started of [false, true]) {
    const view = setupPresentation(fixture({ state: "needs_setup", setupStarted: started, operationId: "automatic-enable-check", verifiedAt: null, threadSlug: null,
      accountChecks: {}, missingFields: ["EMAIL_ACCOUNTS", "AGENT"] }), service);
    assert.deepEqual(view.actions.map((entry) => entry.id), ["setup"]);
    assert.equal(view.actions[0].labelKey, `mailkeeper-setup.${started ? "continue" : "setup"}`);
    assert.deepEqual(view.missingFields, []);
    assert.deepEqual(view.checklist, []);
    assert.deepEqual(view.sections, []);
  }
});

test("journey recovery is scoped to failed selected accounts and distinguishes network failure", () => {
  const raw = fixture({ state: "needs_repair", blockers: [{ accountRef: "bad", code: "AUTH_FAILED" }, { accountRef: "offline", code: "CONNECTION_FAILED" }],
    accountChecks: { good: { ok: true }, bad: { ok: false }, offline: { ok: false } } });
  const view = journeyPresentation(raw, service);
  assert.equal(view.checklist[0].labelKey, "mailkeeper-setup.step-connection");
  const repairs = view.actions.filter((entry) => entry.payload);
  assert.deepEqual(repairs.map((entry) => [entry.actionId, entry.payload.accountRef]), [["credential", "bad"], ["check", "offline"]]);
  assert.equal(repairs[0].labelKey, "mailkeeper-setup.sign-in-account");
  assert.equal(repairs[1].labelKey, "mailkeeper-setup.retry-connection");
  const choose = view.actions.find((entry) => entry.id === "choose-login");
  assert.deepEqual([choose.kind, choose.actionId, choose.variant], ["email-login", "select-login", "outline"]);
  assert.ok(!view.actions.some((entry) => ["preview", "schedule"].includes(entry.id)));
  assert.equal(setupPresentation(raw, service).actions[0].labelKey, "mailkeeper-setup.reconnect-account");
});

test("a Secrets-linked account repairs its sign-in in the private Login picker, preselected", () => {
  const raw = fixture({ state: "needs_repair", blockers: [{ accountRef: "work", code: "AUTH_FAILED" }, { accountRef: "net", code: "CONNECTION_FAILED" }],
    emailLogins: { selected: [], linked: [{ account: "work", login: "login-1" }, { account: "net", login: "login-2" }] } });
  const [repair, retry] = journeyPresentation(raw, service).actions;
  assert.deepEqual([repair.kind, repair.actionId, repair.current, repair.payload, repair.labelKey],
    ["email-login", "select-login", "login-1", { account: "work" }, "mailkeeper-setup.update-sign-in"]);
  assert.equal(retry.actionId, "check", "a network failure retries the connection, not the sign-in");
  const fresh = journeyPresentation(fixture({ state: "needs_setup" }), service).actions.find((entry) => entry.id === "choose-login");
  assert.equal(fresh.variant, "primary");
});

test("repaired saved schedules stay stopped with explicit resume and truthful task/pause facts", () => {
  for (const exists of [false, true]) {
    const raw = fixture({ schedule: { intent: true, cadence: "4h", suspendedForRepair: true, exists, pauseReason: "workspace_paused" } });
    const view = usagePresentation(raw, service);
    const resume = view.actions.find((entry) => entry.id === "resume-schedule").form;
    assert.deepEqual(resume.actions[0].payload, { enabled: true, cadence: "4h", resume: true });
    assert.equal(resume.details.find((entry) => entry.id === "task").value, `mailkeeper-setup.${exists ? "execution-stopped" : "task-unavailable"}`);
    assert.equal(resume.details.find((entry) => entry.id === "next").value, "mailkeeper-setup.execution-stopped");
    assert.equal(resume.details.find((entry) => entry.id === "pause").value, "mailkeeper-setup.heartbeat-paused");
    assert.equal(view.actions.find((entry) => entry.id === "schedule").form.actions[1].disabled, true);
    assert.equal(setupPresentation(raw, service).actions[0].id, "open");
  }
});

test("each surface declares all invoked actions and translates its rendered data", () => {
  const raw = fixture({ schedule: { intent: true, cadence: "4h", suspendedForRepair: true, exists: true },
    preview: { runId: "original", outcome: "blocked", scope: fixture().scope } });
  for (const [surface, projection] of [["workspace-plugin-card", setupPresentation], ["workspace-plugin-editor", journeyPresentation], ["chat-history", usagePresentation]]) {
    const contribution = manifest.capabilities.ui_contributions.find((entry) => entry.surface === surface);
    const view = projection(raw, service);
    const declared = new Set(contribution.actions.map((entry) => entry.id));
    const check = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.labelKey?.startsWith("mailkeeper-setup.")) for (const dictionary of Object.values(contribution.options.messages))
        assert.equal(typeof dictionary[node.labelKey], "string", surface + ": " + node.labelKey);
      if (node.type === "translation" && node.value?.startsWith("mailkeeper-setup.")) for (const dictionary of Object.values(contribution.options.messages))
        assert.equal(typeof dictionary[node.value], "string", surface + ": " + node.value);
      for (const entry of node.actions || []) {
        if (!entry.form && (!entry.kind || entry.kind === "invoke")) assert.ok(declared.has(entry.actionId || entry.id), surface + ": " + entry.id);
      }
      for (const value of Object.values(node)) if (typeof value === "object")
        Array.isArray(value) ? value.forEach(check) : check(value);
    };
    check(view);
  }
});

test("pending optional preview cannot block the connection journey", () => {
  const raw = fixture({ preview: { runId: "pending", outcome: "pending", scope: fixture().scope } });
  const view = journeyPresentation(raw, service);
  assert.equal(view.pending, false);
  assert.equal(view.actions.find((entry) => entry.id === "check").disabled, false);
  raw.state = "needs_repair";
  raw.blockers = [{ accountRef: "fixture", code: "AUTH_FAILED" }];
  assert.equal(journeyPresentation(raw, service).actions[0].disabled, false);
});
