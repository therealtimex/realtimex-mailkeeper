# RealTimeX MailKeeper

**Keeps your inbox clean on a schedule.** Rules you promote, everything else proposed, every run reversible. Works with any IMAP provider through the Himalaya account that BizOps already manages.

MailKeeper is *hygiene*; [BizOps](https://github.com/therealtimex) is *correspondence* (reply, cases, CRM). They share the same account config and never overlap.

It is **not** a mail client. It never reads message bodies into chat, never replies, never deletes. It moves messages into `Auto/*` folders (or the archive folder) according to rules a human has promoted, and it reports everything else as a proposal.

## What it does

- **Interactive cleanup** — the `mailbox-cleanup` workspace skill runs the multi-pass playbook (adapted from Vellum's `inbox-cleanup`): urgency triage first, then age, cold outreach, no-reply, calendar responses, receipts, sketchy TLDs, repeat senders. Every pass previews before it applies; you confirm each one.
- **Unattended maintenance** — a plugin-owned heartbeat task runs on the workspace cadence and executes *promoted rules only*. Anything new it finds becomes a proposal in the plugin status.
- **Receipts and undo** — every run records each moved UID. `POST /undo` (or `mailbox-ops.js undo`) reverses a run exactly.
- **Human-owned policy** — `MAILBOX.md` in the workspace root holds VIP senders, confirm-first categories, and notes. The plugin seeds it once and never overwrites it.

## Safety model

| Layer | Guarantee |
|---|---|
| Mode ladder | `report-only` (default) → `label-only` → `archive-promoted`. A global ceiling caps every workspace. |
| Promotion | The heartbeat can only execute rules a human promoted. Proposals never self-activate. |
| Protected | VIP senders, protected domains (global, non-overridable), flagged messages, and urgency-triage hits are never touched by any rule. |
| Urgency first | `overdue`, `suspension`, `collections`, `final notice`, `.gov` … are surfaced on every run and excluded from every pass. |
| No destruction | The only mutation is `move`. No delete, no trash, no server-side filters. |
| Reversible | Receipts store `{uid, from, to}` per action; undo moves them back. |

## Configuration

**Global** (plugin settings): `DEFAULT_MODE_CEILING`, `AUTO_FOLDER_PREFIX`, `PROTECTED_DOMAINS` (not overridable), `RETENTION_DAYS`.

**Per workspace** (workspace settings → plugins): `EMAIL_ACCOUNTS` (one or more Himalaya accounts, picked from a dropdown the plugin serves via `GET /accounts`), `MODE`, `CADENCE`, `AGE_THRESHOLD_DAYS`, `AGGRESSIVENESS`, `VIP_SENDERS`, `AGENT`, `MODEL` (host catalog pickers).

Aggressiveness controls which passes are *promotable*: conservative = no-reply, calendar, sketchy TLDs; standard adds receipts, generic outreach, age; aggressive adds personalized outreach and repeat senders.

## First use and repair

Enable MailKeeper for your workspace, then choose **Set up email with AI** on its plugin card. **Continue setup** reopens saved incomplete work in the same workspace-bound editor. The journey asks which accounts to connect, checks Himalaya and guides installation with ordinary command approval only when needed. Required account and agent choices appear inside setup. Secondary **Settings** holds advanced configuration. Saving the guide does not verify an account or enable maintenance.

The account picker, checks, preview and maintenance share one Himalaya target: `HIMALAYA_CONFIG`, then BizOps `EMAIL_CONFIG_FILE`, then `~/.config/himalaya/config.toml`. Confirm before editing an environment-selected target. Existing accounts, defaults, SMTP and BizOps metadata are preserved; new scaffolds contain IMAP settings only. MailKeeper does not enable the BizOps email channel.

New accounts use RealTimeX Secrets. **Choose email account** opens the host's private picker of eligible email Logins (Login items with a password that this workspace may use); **Add email account** and **Update sign-in details** open the Secrets editor and return to the picker. MailKeeper receives only the chosen Login's identity, email address and provider, never the password; the AI setup task then connects it, and the host writes the account to the shared target with a binding that resolves the password from Secrets for each operation. Gmail, Outlook, iCloud and Yahoo use built-in IMAP settings; other providers need host, port and encryption. A Secrets-linked account with rejected sign-in offers **Update sign-in** with its Login preselected; network failure offers a connection retry. Working existing accounts, including older Keychain accounts with their contextual **Sign in** step, are reused unchanged. Never paste credentials into AI chat or command arguments.

**Email connected** requires every selected account plus readback of the owned maintenance conversation, `MAILBOX.md`, rules and task. A verified disabled task satisfies new manual setup or repaired readiness. Preview execution and scheduling never gate completion. **Open MailKeeper** then enters its existing usage conversation. Failed selected accounts stay visible until deliberately repaired or removed. Configuration changes invalidate readiness; cached status reads do not contact IMAP. Existing policy, rules, receipts and the bound setup session are preserved, including through Restore or Create replacement for an archived setup conversation.

Optional **Preview inbox** appears in the usage conversation before any receipt exists. Its confirmation shows accounts, folders, agent and scan bound; cancel starts nothing. The preview always reports only, even when the configured mode permits archiving. It scans INBOX only, at most five pages of 200 envelopes per account, triages urgency before proposals, and records zero actual changes. Empty inboxes complete successfully; any failed account makes the receipt failed. Repeating a pending preview attaches to the same run. Restarting an interrupted helper settles the original run as failed, retains completed account progress, and queues one receipt without rescanning. A stored receipt establishes preview completion, independently of setup readiness.

**View last preview** opens the matching receipt in the maintenance conversation, including the original scope, time, scan limit, outcome and confirmed counts. **Open MailKeeper** opens the conversation separately. Blocked launches retain verified connection evidence and identify known agent recovery steps or an unknown cause. Partial results and failed runs stay distinct from a successful empty inbox. A missing receipt is explicitly unavailable; retrying navigation never runs another preview.

Disabling MailKeeper keeps its read-only status and retained results accessible. Setup, connection checks, previews, private credential actions and scheduling are blocked until re-enabled. Runtime undo uses the shared Himalaya target and the receipt's accounts, even if workspace account selection has changed; a changed target path requires restoring the original configuration before undo.

**Scheduled maintenance** is a separate human choice. `MAINTENANCE_ENABLED` is effectively false for a new workspace. Confirmation shows the selected accounts, agent/model, effective mode, timezone and active hours with a readable cadence. The card shows the saved intent separately from scheduler registration or workspace pause and reports the next run only when confirmed; it never unpauses a workspace heartbeat. Existing maintenance intent and actual cadence migrate once. Conflicting historical task/profile state asks for a human decision.

The editor uses a self-contained, workspace-scoped helper:

```sh
node .agents/skills/mailbox-cleanup/scripts/mailkeeper-setup.js status
node .agents/skills/mailbox-cleanup/scripts/mailkeeper-setup.js check
node .agents/skills/mailbox-cleanup/scripts/mailkeeper-setup.js configure '{"EMAIL_ACCOUNTS":["personal"],"AGENT":"cursor","MODE":"report-only"}'
node .agents/skills/mailbox-cleanup/scripts/mailkeeper-setup.js connect '{"login":"<login id from status emailLogins.selected>","account":{"name":"personal"}}'
```

The host injects the loopback URL, terminal-session authorization and workspace context. The helper accepts non-secret account/settings fields only and cannot enable maintenance. It does not read credential files or assume a server port.

### Rollout and downgrade

MailKeeper supplies its setup and receipt labels, translations, checkpoints, counters, confirmation bounds and schedule choices through the host's version 2 `setup-status` contribution contract. The host renders these declarations with shared cards, choice dialogs, editor checklists and receipt navigation. Other plugins can use the same pattern with their own prerequisites and results; email-specific presentation lives in `runtime/setupPresentation.js` and the plugin manifest. Status reads remain cached, while actions retain workspace authorization and the declared route checks.

`0.2.0-dev.1` requires host support from [RealTimeX #2199](https://rtgit.rta.vn/rtlab/rtwebteam/realtimex-ai-app/-/issues/2199): setup cards, workspace-bound editors, shared email configuration and explicit terminal preview dispatch. Deploy the host support before the new plugin manifest. No database migration or additional dependency is required. This development package has not been published to Marketplace.

Repair preserves saved schedule intent/cadence/mode while execution stops. After repair the owned task stays disabled; Check, Apply, native return, activation and reopening cannot resume it. Secondary **Resume saved schedule** requires authenticated explicit confirmation and current resource readback; workspace pauses still apply. Stale queued occurrences are rejected independently of the displayed task state.

Before downgrading, disable MailKeeper and verify removal of its owned task while retaining files and receipts. Older runtimes ignore repair suspension and may rearm maintenance during activation. Re-enable only after reviewing the owned heartbeat task and cadence.

## Architecture

```
index.js                        definePlugin: routes, lifecycle, heartbeat hooks (Dogfood shape)
runtime/host.js                 the ONLY file that touches host capabilities (see below)
runtime/config.js               resolve + validate global/workspace config, mode ceiling
runtime/service.js              provision / disable / status / rules / runs / undo / prompt
runtime/mailbox.js              Himalaya wrapper used by the plugin runtime (readiness, undo)
templates/MAILBOX.md            seeded contract file
skills/mailbox-cleanup/
  SKILL.md                      the playbook (interactive + maintenance)
  scripts/mailbox-ops.js        self-contained CLI the agent runs in the workspace
```

Workspace-side state lives in `<workspace>/.mailkeeper/`: `rules.json` (written by the plugin: effective config, per-account archive/sent folders, promoted rules), `snapshot-<account>.json` (envelope cache per account), `runs/`, `outbox/` (receipts the plugin ingests on the next lifecycle event or status read).

### Host dependencies

The plugin follows the built-in Dogfood pattern: workspace-scoped activation, a managed task in the workspace `HEARTBEAT.md`, a plugin-owned thread, and clean teardown. `runtime/host.js` prefers the public workspace/thread/heartbeat SDK and retains a legacy server shim. Guided setup additionally requires the new host capabilities described above.

That is a bridge, not the design. [realtimex-ai-app#1996](https://rtgit.rta.vn/rtlab/rtwebteam/realtimex-ai-app/-/issues/1996) proposes `api.workspaces` and `api.heartbeat` namespaces; `host.js` switches to them automatically when present and nothing else in the plugin changes. Nothing outside `host.js` may require `@/`.

The account picker depends on `optionsRoutePath` support in the host config modal — [realtimex-ai-app#2001](https://rtgit.rta.vn/rtlab/rtwebteam/realtimex-ai-app/-/issues/2001), which also brings schema-driven grouping, compact rows, and correct required state. On an older host the field renders as a plain multi-select with no options; `GET /accounts` still answers.

## Requirements for the maintenance agent

The heartbeat agent reaches the mailbox through `rtxexec himalaya` (rtxexec 0.4.0 or later) from inside its own RealTimeX terminal session. The host verifies that session, selects the shared Himalaya config and resolves any Secrets-managed credential for each operation, so the agent never handles a password or config path. The session still needs outbound network access to your IMAP hosts, because Himalaya connects from that terminal.

- **Codex CLI** — RealTimeX launches Codex with `sandbox_mode = "workspace-write"`, and that sandbox denies outbound network by default. Add to `~/.codex/config.toml`:

  ```toml
  [sandbox_workspace_write]
  network_access = true
  ```

  Without it the run ends as `blocked` with "IMAP connection setup failed" and no receipt of moved messages (nothing is touched).
- **Other agents** — check the equivalent sandbox/network setting for the agent you pick in *Maintenance agent*.

A blocked run is the plugin behaving correctly: it posts a summary to the maintenance thread and records a `blocked` receipt; it never moves anything it could not inspect.

## Development

```sh
npm test                 # config + host adapter tests (no server needed)
npm run lint:manifest
npm run build:plugin     # dist/realtimex-mailkeeper-plugin-<version>.zip + .sha256
```

Install for local testing with the `realtimex-plugin-developer` skill or the marketplace install flow, then enable it on a workspace whose BizOps email config has the account you name.

## Roadmap

- v0.1 — this: passes, promotion, receipts, undo, heartbeat maintenance, `@/` shim.
- v0.2 — switch `host.js` to the public SDK once #1996 ships; synchronous receipt bridge like Dogfood's; promote/demote from the plugin status UI.
- Later — unsubscribe assistance, per-sender retention, weekly digest.
