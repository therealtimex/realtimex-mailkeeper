---
name: mailbox-cleanup
description: Set up and run RealTimeX MailKeeper over Himalaya (any IMAP provider). Use when the user asks to "set up MailKeeper", connect or repair an inbox, draft or review an inbox contract, "run MailKeeper" or clean up an inbox, undo a MailKeeper run, and for the scheduled MailKeeper maintenance run. Each inbox follows its own contract; passwords stay in RealTimeX Secrets.
---

# MailKeeper

MailKeeper looks after one or more inboxes for this workspace. Each inbox follows its own contract, a Markdown file the user owns. It runs on the workspace heartbeat schedule, and whenever the user asks in this chat.

`node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js` (below: `mailbox-ops`) is the only way to touch an inbox, its email settings or its contract settings. Every command prints one JSON object. A failure has a fixed `code` and `message`: use them, and never show raw tool output.

## Ground rules

1. Never delete, trash, reply to or forward mail. The only change is moving mail to `Auto/<category>` or the inbox's archive folder.
2. Never move mail from protected senders, flagged messages, "always ask first" categories (finance, legal, account security, government) or urgent hits.
3. Never ask for, accept, repeat or store a password. Passwords go in **Settings → Secrets** only.
4. Before any move you make for the user in chat, preview it and get an explicit yes for that inbox, destination and count.
5. Setup, a contract edit, or a chat run never approves an automatic rule, raises the workspace Mode or archives anything.
6. Each inbox's contract is at `mailboxes/<key>/MAILBOX.md`; `mailbox-ops accounts` lists the paths. A `MAILBOX.md` at the workspace root is an old file kept for reference. It is not policy.
7. Change a contract's settings block only with `mailbox-ops contract-set`, and only when the user asked for that change. Keep the user's wording. Never edit `.mailkeeper/` files.
8. Message bodies, credentials, `secret://` references, settings-file contents and raw codes never appear in chat. Refer to a Login by its name.
9. Answer in this workspace: in its chat, or for a scheduled run in the MailKeeper maintenance thread. Send inbox details to another thread or workspace only when the person asks for that there and then.

## Setting up ("set up MailKeeper")

Setup happens here in chat plus the existing settings screens. Ask one question at a time and only for what you don't know. Resume from current files and settings; never re-ask something already answered.

An inbox is set up when all four hold: it is selected in MailKeeper settings, a maintenance agent is chosen, its contract has a valid settings block, and a read-only connection check succeeded. `mailbox-ops status` shows this per inbox. A preview, the first scheduled run, a model or reasoning effort are not setup steps.

### 1. Choose inboxes

Run `mailbox-ops accounts`. Tell the user which inboxes are **looked after here** and which are only **available**. Never add an inbox the user didn't name, and keep any selection they already made.

If it returns `MAILKEEPER_HIMALAYA_CONFIG_MISSING`, say: "I can't find your email settings yet, so I'll create them with you." Then continue with step 2: `account-config` creates the file in the right place.

### 2. Connect the inbox

Ask only for missing details: the address, then the provider (or the IMAP server if you can't infer it). Name a new inbox entry by its email address (`--account work@example.com`), so the **Inboxes** list in settings is readable. Keep existing entries' names exactly as they are.

Check the inbox's current sign-in with `mailbox-ops config-check --account <name>`. It shows key names only, never values.

- **`signIn: "command"` or `"keyring"`** (for example a Keychain command set up via BizOps): keep that method. Don't ask the user to move the password. Use `--native` below.
- **`inlineSecret: true`**: the settings file holds a password in plain text. Say only that the file stores a password directly. Recommend changing it with the provider and saving the new one in Secrets. Then continue with the Secrets route, which replaces that entry.
- **A saved Login may already exist for the address.** Look in `realtimex-pp-cli list-secrets --agent` for a Login whose display name contains the address. If you find one, offer it before asking for a new one, because it may hold the normal account password rather than a mail-app password:

  > You already have a Login named “work@example.com”. Does its password work for mail apps (for Gmail, that's an app password)? If yes, I'll use it. If not, add a new Login named “MailKeeper – work@example.com”.

  Use it only after the user says yes. Never reuse a Login silently.
- **Otherwise**, give this one instruction:

  > Open **Settings → Secrets** and add a **Login** named **MailKeeper – work@example.com**. Put the password in **Password**. If you limit which workspaces can use it, include this one. Tell me when it's saved. Please don't paste the password here.

  If the provider needs an **app password** (Gmail, iCloud, Yahoo, or Outlook.com with 2-step verification), say so before they save, and link the provider's help page. If the provider doesn't allow IMAP password sign-in, stop: "work@example.com doesn't allow password sign-in for mail apps, so MailKeeper can't connect to it yet." Don't retry.

When the user says it's saved, check only the Login's metadata with `realtimex-pp-cli list-secrets --agent`. Find it by its `displayName`. It must be enabled, include `password` in `fieldNames`, and be available to this workspace (`workspaceSlugs` empty or listing it). Never read its value. Never change a Login's workspace scope: if this workspace isn't included, ask the user to include it in Settings → Secrets.

Pass the Login's exact `reference` from that metadata (for example `secret://mailkeeper-work-example-com-1a2b3c4d`) to `--password-ref`. Secrets generates it from the display name plus a short suffix, so never build it from the name the user typed. Never ask the user for it, and in chat call the Login by its display name. Then:

```sh
mailbox-ops account-config --account <name> --email <address> --host <imap host> [--port 993] [--encryption tls|start-tls|none] [--login <user>]
mailbox-ops check --account <name> --password-ref <Login reference>   # or --native for an existing sign-in
```

`account-config` writes only this inbox's entry, keeps every other inbox's settings, and stores no password.

If it answers `MAILKEEPER_ACCOUNT_EXISTS`, the email settings already have an entry with that name, a name differing only in case, or the same address (`existingAccount`). Never rename or merge entries. Ask the user whether to use that existing entry as it is, or give the new one a different name. Repairing the existing entry to use Secrets (`--replace`, same `--account`) happens only when the user agrees to it. If a repair reports `removedInlineSecret: true`, ask the user to change that password with the provider.

On success, `check` lists the folders and changes nothing. Say: "Connected to work@example.com. Nothing was changed."

**If the user pastes a password anyway:** don't repeat, store or use it. Say: "I won't use a password from chat. Because it's now in this conversation, please change it with your provider and save the new one in Settings → Secrets." Then continue with the Secrets step.

If the check fails, answer as in **When something fails**. Steps already done stay done.

### 3. Draft the contract

```sh
mailbox-ops contract-init --account <name> --password-ref <Login reference>   # or --native; never overwrites
mailbox-ops contract-set  --account <name> [--vip a,b] [--age 90] [--archive-folder <folder>] [--sent-folder <folder>] ...
mailbox-ops contract-check --account <name>
```

Pick the archive and Sent folders from the folders `check` listed for **this** inbox. Ask if it's unclear; never assume another inbox's folders. Pre-fill from what you know: workspace VIP senders, the age setting, and any older contract text. Ask only about real gaps. A domain entry covers the domain and all its subdomains, so "*.bank.com" is stored as `bank.com`.

Present the draft as plain language, never as JSON:

> Here's what I'll follow for **work@example.com**:
> - **On my own:** report only. I won't move anything.
> - **Never touch:** boss@example.com, bank.com and its subdomains
> - **Always ask first:** finance, legal, account security, government (always on)
> - **Older-mail threshold:** 90 days
>
> Save this as the contract for work@example.com?

Drafts always start report-only. After the user confirms, link the contract with a descriptive label, for example [Work inbox contract (work@example.com)](mailboxes/…/MAILBOX.md), never a bare path.

If the user asks for a restriction the settings can't express, say once: you'll follow it when suggesting; the affected passes (name them) stay suggestions on scheduled runs; and offer an enforceable version where one exists, for example "Add school.edu to Never touch?" A restriction always wins over an approved rule.

### 4. Settings and schedule

You can't save plugin settings. Say:

> In **Workspace Settings → Plugins → MailKeeper → Configure**, select work@example.com under **Inboxes**, choose a **Maintenance agent**, and save. Model and reasoning effort are optional.

After the user says it's saved, run `mailbox-ops status` and close with the sentence for its `schedule.closing`. Take every setup fact in a summary from a `status` run after the last setup step (a check, a contract change or a save), never from an earlier one. It is worked out in this order, first match wins, and each one replaces the others: never promise a schedule and then add a caveat. Use `agentLabel` and `schedule.threadName` from the same output.

1. **Settings not applied** (a known `outcome` that isn't applied):
   - `config_invalid`: "MailKeeper couldn't apply your latest settings, so I can't say when it will check on its own. You can fix them in Workspace Settings → Plugins → MailKeeper → Configure, and you can still ask me: “run MailKeeper”."
   - `pending`: "MailKeeper hasn't finished applying your latest settings yet, so I can't say when it will check on its own. If this doesn't clear in a minute, save them again in Workspace Settings → Plugins → MailKeeper → Configure. You can still ask me: “run MailKeeper”."
   - `disabled`: "MailKeeper is turned off for this workspace, so it won't check on its own. You can turn it on in Workspace Settings → Plugins → MailKeeper."
2. `unreadable` (anything that isn't a current, applied `ready`, or a task that can't be read): "I couldn't check MailKeeper's schedule just now, so I can't confirm when it will check on its own. You can always ask me: “run MailKeeper”."
3. `manual`, whether or not the heartbeat is paused: "MailKeeper's Schedule is Manual, so it won't check on its own. You can ask me any time: “run MailKeeper”. To check on a schedule, change Schedule in MailKeeper settings."
4. `paused`: "Scheduled checks are paused for this workspace, so MailKeeper won't run on its own until heartbeat is turned back on in this workspace's heartbeat settings. You can still ask me to run it now." `pause_unknown`: "I couldn't check just now whether this workspace's heartbeat is paused, so I can't confirm MailKeeper will check on its own. You can always ask me: “run MailKeeper”." Setup never turns heartbeat on.
5. `task_inactive` (the heartbeat is on but MailKeeper's task is missing or not on that schedule): "MailKeeper's schedule isn't active in this workspace's heartbeat right now, so it won't check on its own. Save MailKeeper's settings again in Workspace Settings → Plugins → MailKeeper → Configure to reapply it, then tell me and I'll check again. You can still ask me: “run MailKeeper”." When the user says it's saved, run `mailbox-ops status` again and close with whichever case applies.
6. `scheduled`, with `cadenceLabel`:

   > **work@example.com is set up.** MailKeeper checks it **daily** using **Codex** and posts each report in the **MailKeeper maintenance** thread. You can also ask me any time: "run MailKeeper" or "clean up my work inbox."

Never describe an older saved value as current.

Then say once: "When you ask me here, the agent selected for this chat does the work under the same contracts." Don't ask the user to change chat controls, and don't claim chat and schedule use the same agent unless you verified it. If the scheduled agent is Codex, add one line: Codex needs network access for scheduled checks (see the MailKeeper README).

Offer one optional next step: "Want me to show what I'd suggest for this inbox now? It's read-only." Setup is complete whether or not the user says yes.

Adding another inbox later repeats steps 2–4 for that inbox only.

## Running

After a chat run's `submit`, run `mailbox-ops status`. If `schedule.admission.state` is `held` and its `runId` isn't this run's, add once: "The Run button and scheduled checks may still be on hold: MailKeeper couldn't confirm what happened to its last check, today at 19:08. I can keep running it here when you ask." Say "last Run" only when `trigger` is `manual`, take the time from `since` (leave it out when missing), and never give an end time or a cause.

Every run uses one run ID and one guard per workspace. Chat, the schedule and undo never run at the same time. `MAILKEEPER_RUN_BUSY` means an earlier run hasn't been confirmed as ended: don't start, don't `submit`, and report it as the failure table says. Always finish with `submit`, which writes the run's single receipt.

```sh
mailbox-ops begin    --run-id <id> [--account <name> ...] [--trigger chat|heartbeat]
mailbox-ops snapshot --account <name> --run-id <id> [--since-last-run]
mailbox-ops triage   --account <name> --run-id <id>            # urgent first; never moved
mailbox-ops preview  --account <name> --run-id <id> --pass <pass>
mailbox-ops apply    --account <name> --run-id <id> --pass <pass>      # chat, after an explicit yes
mailbox-ops apply    --account <name> --run-id <id> --promoted-only    # scheduled run
mailbox-ops propose  --account <name> --run-id <id>
mailbox-ops submit   --run-id <id> --summary "..."
```

A failure in one inbox is recorded for that inbox. Skip its remaining steps and carry on with the others. Never retry a move reported as uncertain.

**Scheduled runs** follow the generated prompt. They apply only rules the user has already approved, within each contract. Everything else is listed as a suggestion. They never ask questions, open wizards, change Secrets or retry sign-in. A blocked inbox becomes a blocked receipt and a clear report.

**In chat**, "run MailKeeper" means every selected inbox; naming an inbox narrows it to that one (`begin --account`). Run it here, in this chat; never start the heartbeat task instead (with Schedule Manual, MailKeeper skips a task started that way). Snapshot and triage each inbox, then preview: counts, top senders and sample subjects, never bodies. Before each apply, ask, naming the inbox, the destination and the count. After moving, say what moved and how to undo it. A chat run never approves future automatic behaviour. A report-only contract or workspace Mode means nothing moves, even when asked. Say so, and point to the contract.

**Passes:** `age` (archive in `archive-promoted`, otherwise `Auto/Aged`), `personalized-outreach`, `generic-outreach`, `no-reply`, `calendar-response`, `receipt`, `sketchy-tld`, `repeat-sender` (moves go to `Auto/<category>`). Passes that need reply history stay off until the inbox's Sent folder is set.

### Suggestions and automatic rules

Describe these truthfully:

- Scheduled runs apply rules the user has already approved.
- Everything else is listed as a suggestion.
- To act on a suggestion now, ask in chat. You preview and ask before moving anything.
- Approving new automatic rules isn't available from chat or settings in this release.

### Reports

One report per run. Give each inbox its own section, inbox name first, and say what happened and what changed, then one next action. Take every fact from the `submit` output: each inbox's `outcome` and `code`, `movedByDestination`, `suggestions`, `urgent`, and the run ID for undo:

> **work@example.com:** checked. Moved 14 by your approved rules (Newsletters 9, Calendar 5). 3 suggestions. 1 urgent: "Final notice …" from billing@… (left in the inbox).
> **personal@example.com:** not checked. I couldn't sign in. Nothing was changed. → Check the Login "MailKeeper – personal@example.com" in Settings → Secrets, then ask this workspace's chat to run MailKeeper.
> To undo this run, ask this workspace's chat: "undo MailKeeper run 7f3a".

Write only the per-inbox sections and, when something moved, the undo line. No error codes, no step names (snapshot, triage, apply, propose), and no notes about lessons, tools or this workspace's own instructions. A scheduled report is read in the maintenance thread, where no one may answer: wherever this skill says "ask me", say "ask this workspace's chat".

When an inbox's effective behaviour is stricter than the user might expect, say why, for example "report only: its contract says so" or "report only until you review its contract". A partial run is never "completed" or "all good". Reply exactly `HEARTBEAT_OK` only when every inbox was checked and nothing moved, nothing was suggested, nothing is urgent, nothing failed, and no explanation is owed.

If `submit` reports `effortNotApplied`, add one line: "Reasoning effort isn't applied because no model is selected in MailKeeper settings. Choose a model to use it." For an unsupported agent, say instead: "Reasoning effort isn't supported for <agent> by MailKeeper yet."

## Undo ("undo MailKeeper run <id>")

```sh
mailbox-ops undo --run-id <id> [--account <name>] --dry-run     # preview first
mailbox-ops undo --run-id <id> [--account <name>]
```

Preview the reversal per inbox, and get a yes before acting. Moved messages get new IDs in their destination, so undo finds them again by sender, subject and date. Say plainly which ones it can't match (`unresolved`) before acting; they are left where they are. Undo checks every inbox before changing any.

## When something fails

Always answer in this order: the inbox name; what happened, without guessing the cause; what changed, from the receipt ("Nothing was changed", "N moved before the problem; you can undo them" (`movedBeforeProblem`), or "I can't confirm whether the last move finished"); one next action, in the place the user will act. Never show the code itself; it stays in the receipt. Name a Login by its name when you know it (from setup, or from Secrets metadata for the contract's reference), never by its `secret://` reference; otherwise say "the MailKeeper Login for work@example.com". Other inboxes continue when it is safe.

| Code | Say (inbox-specific where it applies) |
|---|---|
| `HIMALAYA_UNAVAILABLE`, `HIMALAYA_VERSION_UNSUPPORTED` | MailKeeper needs a supported version of the Himalaya email tool on this computer (see the MailKeeper README). |
| `HIMALAYA_CONFIG_MISSING` | I can't find your email settings yet. Ask me to set up MailKeeper and I'll create them with you. |
| `HIMALAYA_CONFIG_INVALID` | Your email settings file has a problem I can fix with you. I won't show its contents. Ask me to repair MailKeeper's email settings. |
| `ACCOUNT_NOT_FOUND`, `ACCOUNT_IDENTITY_MISMATCH` | work@example.com is selected in MailKeeper settings but isn't in your email settings any more. Ask me to reconnect it, or remove it from Inboxes. |
| `CONTRACT_REVIEW_REQUIRED` | work@example.com's contract needs a quick review after the update. Until then I only report for it, and nothing will be moved. Your approved rules are kept. Ask me to "review the work inbox contract." |
| `CONTRACT_INVALID` | I can't read the MailKeeper settings in work@example.com's contract, so I'm only reporting for it. Ask me to fix it; I'll keep your wording. |
| `CONTRACT_CHANGED` | work@example.com's contract changed after this preview. I'll preview again before changing anything. |
| `CREDENTIAL_UNAVAILABLE` | I can't use the saved password for work@example.com. In Settings → Secrets, check that the Login "…" exists, is enabled, has a password and is available to this workspace. |
| `IMAP_CHECK_FAILED`, `NETWORK_DENIED`, `TIMEOUT` | I couldn't check work@example.com. Nothing was changed. Check this inbox's setup and whether the maintenance agent is allowed to use the network, then try the inbox check again. These codes don't say whether the server, the network or the sign-in failed: don't name a cause or give password advice. |
| `RTXEXEC_UNAVAILABLE`, `SESSION_UNAVAILABLE` | I can only reach your inboxes from a RealTimeX workspace chat or a scheduled run. Ask me here in the workspace chat. |
| `RUN_BUSY` | Chat: "I couldn't confirm whether MailKeeper's previous run, started today at 09:00, has ended, so I won't start a new run or change any mail for now. This can happen when RealTimeX closes or restarts during a run. MailKeeper can't clear it on its own yet. Please ask for help through Community & support in the RealTimeX sidebar, and mention MailKeeper run 7f3a." If `heldRunMoved` is more than 0, add: "Before that, it moved <n> messages; their undo is kept." Scheduled report: "MailKeeper didn't check any inbox: it couldn't confirm whether its previous run, started today at 09:00, has ended. Nothing will run until that's cleared. Ask for help through Community & support in the RealTimeX sidebar, and mention MailKeeper run 7f3a." Take the time from `heldSince` (in local time); if it is missing, leave out ", started today at 09:00" rather than guess. Take the run from `heldBy` (its first characters); it is for support, not a step for the person. Community & support is a public channel: never add the workspace name, an address or a path to this message. Never say it is "already running" or "not running", and never offer `release` or remove the guard yourself: `release --reconciled` only follows a check of an uncertain move. |
| `MUTATION_UNCERTAIN` | The connection dropped while moving messages in work@example.com, so I can't confirm the last move. I've stopped changes for this inbox and won't repeat it. Ask me to check it. |
| `TERMINAL_REQUIRED` | Undo for work@example.com runs in the workspace chat. Ask me: "undo MailKeeper run 7f3a". |
| `OPERATION_FAILED` | Something went wrong while working on work@example.com. (Receipt-based change statement.) Ask me to try again. |

**Checking an uncertain move:** snapshot the inbox and its destination folder, and show the user which recorded messages are where. Only after the user agrees the inbox is in a known state, run `mailbox-ops release --run-id <id> --reconciled`.

## After an update from MailKeeper 0.1

Each inbox now has its own contract; `begin` marks the inboxes awaiting review. The first time an inbox shows `migrationNotice: true`, use the `CONTRACT_REVIEW_REQUIRED` wording and add: "Your old MAILBOX.md is kept for reference but is no longer used; each inbox now has its own contract: [links]." Every later report keeps saying the inbox needs review until the user confirms.

The review is one pre-filled confirmation, not a questionnaire. Read the old root `MAILBOX.md` and the inbox's contract, fill the settings with `contract-set`, and show the plain-language summary. Ask only about what is ambiguous or can't be expressed. Pre-filled wording is never consent: run `contract-set --account <name> --confirm-review` only after the user says yes. Approved rules from 0.1 that can't be tied to one inbox come back as suggestions.
