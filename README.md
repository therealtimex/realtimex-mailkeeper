# RealTimeX MailKeeper

**Keeps each of your inboxes tidy under its own written contract**, on a schedule or whenever you ask. Works with any IMAP provider through [Himalaya](https://github.com/pimalaya/himalaya).

It is **not** a mail client. It never puts message bodies in chat, never replies, never deletes. It moves messages into `Auto/*` folders, or an inbox's archive folder, by rules you have approved, and lists everything else as a suggestion.

## How it works

1. You have one or more inboxes, and one RealTimeX agent looks after them.
2. Each inbox has a contract: a Markdown file you own, at `mailboxes/<inbox>/MAILBOX.md` in the workspace. The agent helps you write it and set up the inbox's email settings.
3. MailKeeper runs on the workspace heartbeat schedule, and whenever you ask the agent in chat.

**To start:** enable MailKeeper for a workspace, then ask the agent in that workspace's chat to "set up MailKeeper." The agent:

- finds your inboxes
- connects each one, sending you to **Settings → Secrets** for the password
- confirms a read-only connection
- drafts the inbox's contract with you
- asks you to select the inbox and a maintenance agent in **Workspace Settings → Plugins → MailKeeper → Configure**

Setup needs no other screen.

## What runs

- **Scheduled maintenance**: a plugin-owned heartbeat task, one per workspace, checks every selected inbox at the workspace cadence. Inboxes are checked one after another. Each applies only its own approved rules within its contract, and an inbox that can't be reached doesn't stop the others. Each run posts one report, with a section per inbox, in the **MailKeeper maintenance** thread.
- **On request in chat**: "run MailKeeper" (all inboxes) or "clean up my work inbox" (one). The agent previews before any move and asks you for each one.
- **Receipts and undo**: every run records each move with its inbox, source and destination. Ask in chat: "undo MailKeeper run <id>". Moved messages get new IDs in their destination, so undo finds them again by sender, subject and date, and tells you about any it can't match.

**Approved rules and suggestions:**

- Scheduled runs apply only rules you have already approved, within each contract.
- Everything else is listed as a suggestion. To act on a suggestion now, ask in chat.
- Approving new automatic rules isn't available from chat or settings in this release.

## Safety model

| Layer | Guarantee |
|---|---|
| Mode ladder | `report-only` (default) → `label-only` → `archive-promoted`. A global ceiling caps the workspace Mode, and each contract can be stricter. A contract can never raise its own limits. |
| Per inbox | Every operation reads that inbox's own contract, rules, folders and credential. One inbox's rules or senders never affect another. |
| Approval | Scheduled runs apply only rules a person approved, for that inbox. Suggestions never approve themselves, and a chat run approves nothing for later. |
| Protected | Contract and workspace VIP senders, global protected domains, flagged messages, "always ask first" categories (finance, legal, account security, government) and urgent mail are never moved. |
| Urgency first | `overdue`, `suspension`, `collections`, `final notice`, `.gov` … are listed at the top of every report and left in place. |
| No destruction | The only change is a move. No delete, trash, reply or server-side filters. |
| Uncertain moves | If a move's result is unknown, MailKeeper records it, stops moving mail in that inbox, and never repeats it automatically. |
| One run at a time | Chat, scheduled runs and undo share one run guard per workspace. |

## Credentials

MailKeeper never stores, receives or logs a password. An inbox signs in one of two ways:

- **RealTimeX Secrets** (recommended). Save a Login with the password in **Settings → Secrets**, available to the workspace. The inbox's Himalaya entry runs a MailKeeper helper as its password command. The workspace helper starts each mailbox operation through `rtxexec`, which injects that Login's password into that one process, and the helper passes it straight to Himalaya over its private pipe. The email settings file, the contract, command arguments, output, logs and receipts hold only the Login's name, never the value. As with SSH keys and API tokens in RealTimeX, the running mail process holds the password while it works. This keeps it away from files and transcripts; it does not protect it from other software running as you.
- **Existing sign-in.** An inbox whose Himalaya entry already uses its own password command or keyring (for example a Keychain command set up via BizOps) keeps it.

Some providers need an **app password** for IMAP (Gmail, iCloud, Yahoo, Outlook.com with 2-step verification). Providers that don't allow IMAP password sign-in can't be connected yet.

## Configuration

**Global** (plugin settings, admin): `DEFAULT_MODE_CEILING`, `AUTO_FOLDER_PREFIX`, `PROTECTED_DOMAINS` (not overridable), `RETENTION_DAYS`.

**Per workspace** (Workspace Settings → Plugins → MailKeeper → Configure):

- **Inboxes** (`EMAIL_ACCOUNTS`): the inboxes this workspace looks after, chosen from your Himalaya email settings. An inbox is never added automatically.
- **Mode**, **Aggressiveness**: the most any inbox may do on its own; each contract can be stricter.
- **Age threshold**: the starting value for new contracts.
- **VIP senders**: never touched in any inbox.
- **Heartbeat cadence**: follows the workspace heartbeat schedule and pause; setup never turns heartbeat on.
- **Maintenance agent**, **Model**, **Reasoning effort** (`AGENT`, `MODEL`, `EFFORT`): the terminal agent that runs scheduled checks. Effort is forwarded to the scheduled task for Codex (`reasoning_effort`) and Claude (`effort`) when a model is selected. Otherwise the agent's default effort is used, and the next report says why. Effort never stops or skips the schedule.

Chat runs use whichever agent the chat is using, under the same contracts.

**Email settings file:** MailKeeper uses `HIMALAYA_CONFIG` when it is set. Otherwise it uses the first of Himalaya's default locations that exists: the platform config directory (`~/Library/Application Support/himalaya/config.toml` on macOS), then `~/.config/himalaya/config.toml`, then `~/.himalayarc`. The plugin pins the file it found, so the scheduled run, chat and undo always use the same one. MailKeeper always names that file explicitly and never starts Himalaya's interactive wizard.

## Requirements for the maintenance agent

The scheduled agent runs Himalaya in its own terminal. That session needs outbound network access to your IMAP servers, and access to the credential source: RealTimeX Secrets through `rtxexec`, or the inbox's existing password command or keyring.

- **Codex CLI**: RealTimeX launches Codex with `sandbox_mode = "workspace-write"`, which denies outbound network by default. Add this to `~/.codex/config.toml`:

  ```toml
  [sandbox_workspace_write]
  network_access = true
  ```

  Without it, each inbox's report says it couldn't connect, and nothing is moved.
- **Other agents**: check the equivalent sandbox or network setting for the agent you pick.

Himalaya 1.2 must be installed and on `PATH`, along with `rtxexec` 0.3 or later for Secrets sign-in.

## Architecture

```
index.js                         definePlugin: routes, lifecycle, heartbeat hooks
runtime/host.js                  the only file that touches host capabilities (public plugin SDK)
runtime/config.js                workspace settings, mode ceiling, effort forwarding
runtime/service.js               provisioning, inbox contracts, rules, receipts, maintenance prompt
runtime/mailbox.js               Himalaya account discovery for the settings picker (no sign-in)
skills/mailbox-cleanup/
  SKILL.md                       setup journey, runs, reports, failures (what the agent follows)
  templates/MAILBOX.md           new inbox contract
  scripts/mailbox-ops.js         workspace helper the agent runs (setup, runs, receipts, undo)
  scripts/mailkeeper-core.js     shared rules: inbox keys, contract block, effective policy
  scripts/himalaya-runner.js     one bounded Himalaya operation per call, fixed error codes
  scripts/himalaya-auth.js       Himalaya password command for Secrets sign-in
```

Workspace state:

- `mailboxes/<key>/MAILBOX.md`: one contract per inbox (`<key>` is a readable slug plus a short hash of the exact inbox name). Created once and never overwritten. It stays when the inbox is deselected.
- `.mailkeeper/rules.json`: written by the plugin. It holds workspace limits, the pinned email settings file, inbox keys, approved rules and the schedule. It is not policy.
- `.mailkeeper/accounts/<key>/`: per-inbox snapshot cache and last connection check.
- `.mailkeeper/runs/`, `.mailkeeper/outbox/`: run records, and receipts waiting for the plugin to record them.
- `.mailkeeper/run.lock`: the workspace run guard.

Each contract ends with a small typed `mailkeeper-policy` settings block, which the helper enforces before every operation. Prose in the contract guides the agent. A restriction the block can't express keeps the affected cleanup as a suggestion on scheduled runs.

### Host requirements

MailKeeper uses only the public plugin API: `registerRoute`, `getConfig`, `getStore`, `registerWorkspaceSkillProvider`, `workspaces.get/listEnabledForPlugin/ensureThread` and `heartbeat.upsertManagedTask/removeManagedTask/readSettings`. A host without them reports `MAILKEEPER_HOST_CAPABILITY_MISSING`. The Inboxes picker uses the host's `optionsRoutePath` support. The Reasoning effort picker uses the `terminal-agent-effort` field type.

### Upgrading from 0.1

The first provision after the upgrade gives each selected inbox its own contract. Your old root `MAILBOX.md` is kept, untouched, for reference.

- **One inbox:** its text is copied into that inbox's contract.
- **Several inboxes:** each gets a conservative draft.

Either way, each inbox stays report-only until you review its contract with the agent. Approved rules are kept for an inbox when the old setup had only one; otherwise they come back as suggestions.

To roll back to 0.1:

1. Disable MailKeeper for the workspace, so its scheduled task is removed.
2. Install 0.1.
3. Before you enable it again, reconcile the old shared `MAILBOX.md` with the inboxes you want: 0.1 doesn't read per-inbox contracts.

Receipts and contracts are kept either way.

## Development

```sh
npm test                 # unit and integration tests (no server needed; Himalaya-based tests skip without it)
npm run lint:manifest
npm run build:plugin     # dist/realtimex-mailkeeper-plugin-<version>.zip + .sha256
```

The tests use a fake Himalaya, a fake `rtxexec` and a local IMAP stub, with synthetic credentials only. They never touch a real mailbox or your Himalaya config.
