---
name: mailbox-cleanup
description: Set up and run RealTimeX MailKeeper over Himalaya (any IMAP provider). Use when the user asks to "set up MailKeeper", connect or repair an inbox, draft or review an inbox contract, "run MailKeeper" or clean up an inbox, undo a MailKeeper run, asks about MailKeeper's status ("what's MailKeeper's status", "is my inbox set up", "what has MailKeeper done"), and for the scheduled MailKeeper maintenance run. Each inbox follows its own contract; passwords stay in RealTimeX Secrets.
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
7. Change a contract's settings block only with `mailbox-ops contract-set`, and only when the user asked for that change. Keep the user's wording. Never edit `.mailkeeper/` files. A requested mode change also updates MailKeeper's own sentence under "What MailKeeper may do on its own" when it is still exactly MailKeeper's text; `contract-set` answers `modeSentence`:
   - `updated`: "I've updated the settings and the sentence under “What MailKeeper may do on its own” to match."
   - `kept-edited`: "I've updated the settings and left the wording under ‘What MailKeeper may do on its own’ unchanged. Want me to update it to match?" Don't ask if the person already said to change that wording. Change it only after a yes, and only that paragraph.
   - `unchanged`: say nothing about it.
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

`contract-check` works before the inbox is selected and saved: it then answers `selected: false` with `effectiveMode: null`. Summarize the contract's own settings and never state an effective mode for it; the workspace limit applies after Save, and the status step reports it.

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

After a chat run's `submit`, run `mailbox-ops status`. If `schedule.admission.lastObserved` is `held` and its `runId` isn't this run's, add once: "The Run button and scheduled checks may still be on hold: MailKeeper couldn't confirm what happened to its last check, today at 19:08. I can keep running it here when you ask." Say "last Run" only when `trigger` is `manual`, take the time from `since` (leave it out when missing), and never give an end time or a cause. When it is `none` or `unknown`, add nothing, and never say the Run button or schedule will work.

Every run uses one run ID and one guard per workspace. Chat, the schedule and undo never run at the same time. `MAILKEEPER_RUN_BUSY` means an earlier run hasn't been confirmed as ended: don't start, don't `submit`, and report it as the failure table says. Always finish with `submit`, which writes the run's single receipt.

```sh
mailbox-ops begin    --run-id <id> [--account <name> ...] [--trigger chat|heartbeat]
mailbox-ops snapshot --account <name> --run-id <id> [--since-last-run]
mailbox-ops triage   --account <name> --run-id <id>            # urgent first; never moved
mailbox-ops preview  --account <name> --run-id <id> --pass <pass>
mailbox-ops preview  --account <name> --run-id <id> --passes <pass>,<pass>   # plans asked about together
mailbox-ops apply    --account <name> --run-id <id> --pass <pass>      # chat, after an explicit yes
mailbox-ops apply    --account <name> --run-id <id> --promoted-only    # scheduled run
mailbox-ops propose  --account <name> --run-id <id>
mailbox-ops submit   --run-id <id> --summary "..."
```

A failure in one inbox is recorded for that inbox. Skip its remaining steps and carry on with the others. Never retry a move reported as uncertain.

**Scheduled runs** follow the generated prompt. They apply only rules the user has already approved, within each contract. Everything else is listed as a suggestion. They never ask questions, open wizards, change Secrets or retry sign-in. A blocked inbox becomes a blocked receipt and a clear report.

**In chat**, "run MailKeeper" means every selected inbox; naming an inbox narrows it to that one (`begin --account`). Run it here, in this chat; never start the heartbeat task instead (with Schedule Manual, MailKeeper skips a task started that way). Snapshot and triage each inbox, then preview: counts, top senders and sample subjects, never bodies. Preview together, with `--passes`, every plan for an inbox that one question will ask about. It returns `destinations` (each folder that receives messages, with the messages it really receives, in the order the moves run), the distinct total in `moveCount` (a message two plans match moves once, with the first), the undo lines in `undoWarnings`, and one entry per pass in `plans`. Before you ask, run `mailbox-ops release --run-id <id>` and go on only when it answers `holdsGuard: false`: an unanswered question never holds MailKeeper, and the run stays open for the answer. If it refuses because a move is uncertain, follow the check flow instead of asking. Never say other runs or undo are blocked while the person decides. Ask once for the plan as shown: Move all <moveCount> / Choose which / Not now. After the yes, apply the chosen passes in the plan's order without asking again; `apply` takes the guard again and checks the plan is still the one shown. "Not now", or a report-only plan with nothing to ask, ends with `submit` as usual. If the person changes the selection or asks later, preview again and ask again as one question. On an uncertain move, stop and follow the check flow. If an apply answers `MAILKEEPER_PLAN_CHANGED`, don't apply the rest: say its line from **When something fails**, preview the remaining chosen passes again, release as above, and ask once. If `apply` answers `MAILKEEPER_RUN_BUSY` after the person's yes, use its after-a-yes line from **When something fails**; nothing more moves in this run until a new preview and yes. After moving, say what moved, then the undo line from Reports. A chat run never approves future automatic behaviour. A report-only contract or workspace Mode means nothing moves, even when asked. Say so, and point to the contract.

In a chat plan, from `preview`. With `--passes`, every plan shares the inbox's one read, so take the inbox's fields (`urgentLeftInPlace`, `coverage`, `reportOnly`) from `plans[0]`; with `--pass` they are at the top level. `plans[].matchedCount` is for diagnostics, never shown as the plan.

**Once per inbox**, even when nothing moves (`destinations` is empty); the check-off notices come from the plans that use that check:
- **Urgent mail left in place**, from `urgentLeftInPlace`: "Left in work@example.com for you: <total> urgent messages." Then sender and subject for each of `urgentLeftInPlace.items`, and "…and <k> more." when `more` is above 0. When the check ran and found none (`checked` true, `total` 0): "Nothing urgent in work@example.com: I checked and found none." When `urgentLeftInPlace.checked` is `false`, this read wasn't checked for urgent mail: say "I couldn't check work@example.com for urgent messages this time." Never say "nothing urgent" without a check.
- **Always ask first, left in place**, from `alwaysAskFirstLeftInPlace` (at the top level of `preview`; in a report-only chat run, in `propose`'s output): when `total` is above 0, "Left in work@example.com for you (always ask first): <total> messages. MailKeeper never moves these." Then one line per entry of its `groups`, most frequent first, as <from>: “<subject>”, adding " (<count>)" when `count` is above 1, and "…and <k> more." with `more` for <k> when it is above 0. Say it once per inbox, in chat plans and in report-only chat runs; scheduled reports don't list it. These are never part of "Move all" or any count to move, and urgent messages are never in this list.
- **Inbox read only in part** (`reportOnly: "partial-coverage"`, with <n> from `coverage.inboxRead`): "I've only checked part of work@example.com (<n> messages), so this plan covers those, and I won't move anything in it." Don't offer Move all for that inbox. If the person asks about changing its contract, add "That stays true even if you change its contract." Say nothing about later or fuller reads.
- **Unsubscribe check off:** whenever this inbox's plan or suggestions use No-reply, report-only included: "This version doesn't check for unsubscribe links. This plan uses the other available checks."
- **Reply-history cleanups off:** when the contract uses them: "“Repeat senders” and “Personalized outreach” are off in this version, because MailKeeper can't yet read who you've written to. This plan uses the other available checks."
- When both apply, say "This plan uses the other available checks." once, after the second.

**For each entry of `destinations`** (a folder that receives no messages isn't shown and gets no creation line):
- **Destination:** when `targetExists` is `false`, say "Auto/Notifications doesn't exist yet; I'll create it when moving." When it is `null`, say "I'll create Auto/Notifications if it doesn't exist." When it is `true`, say nothing.
- **Move scope:** "I'll move only these <n> messages, from <source folder> to <folder>." Use `from`, `target` and `count`, and take the examples from its `topSenders` and `sampleSubjects`. State these facts; never add guesses about how the move works.

**Once per question, before its one yes:**
- **Undo advice:** put each `undoWarnings[].text` in the question you ask before applying, as given. There is one line per folder and reason. Single-folder lines apply only when the union of this question's folders and this inbox's folders that already received moves in this run is one folder; otherwise the combined lines apply, and a combined line that names a folder replaces that folder's own "couldn't fully check" line. Size and look-alike lines always stay. The lines are:
  - size: "MailKeeper may not be able to undo moves into <folder>: after these moves it would hold more messages than MailKeeper can check."
  - look-alike: "MailKeeper may not be able to undo <lookAlikeCount> of these moves: some messages in <folder> or in this plan look the same."
  - unknown, one folder: "MailKeeper may not be able to undo moves into <folder>: it couldn't fully check that folder just now."
  - combined size: "MailKeeper may not be able to undo all of these moves: together, <folder A> and <folder B> would hold more messages than MailKeeper can check in one undo."
  - combined unknown, a folder that already received moves: "MailKeeper may not be able to undo all of these moves: it couldn't fully check <folder>, which already received moves in this run."
  - combined unknown, a folder only in this question: "MailKeeper may not be able to undo all of these moves: it couldn't fully check <folder> just now."

  Never say a move "can" or "can't" be undone as a certainty.

When the person reviews or promotes an approved rule that this version skips or reduces, use the matching rule notice line from Reports.

**Passes:** `age` (archive in `archive-promoted`, otherwise `Auto/Aged`), `personalized-outreach`, `generic-outreach`, `no-reply`, `calendar-response`, `receipt`, `sketchy-tld`, `repeat-sender` (moves go to `Auto/<category>`). `personalized-outreach` and `repeat-sender` need reply history, which this version can't read: they are off, and `apply`, `preview` and `propose` report them as `reply-history-unavailable`.

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
> To undo, ask this workspace's chat: “undo MailKeeper run 7f3a”. It will check first what can be undone.

When `coverage.folder` is present, not empty and isn't `INBOX`, the run read only that folder: name it in every coverage line, chat plan included, as "work@example.com, folder “Receipts”: checked in full (<n> messages)", and never present it as the whole inbox. A missing or empty `folder` is unknown: don't name a folder, and don't claim the whole inbox was checked either.

An inbox whose `outcome` is `partial` was read only in part, so nothing was moved in it. Use `coverage.inboxRead` for <n>:
- `coverage.stopReason` is `budget` or `deadline`: "work@example.com: checked <n> messages. MailKeeper couldn't finish checking this inbox within this check's limit, so it only reports for it. Nothing was changed."
- `no_progress`, `overlap`, `invalid_response` or `transport`: "work@example.com: checked part of the inbox, then couldn't continue. Nothing was changed."

Never give a size, a cause or a promise to continue.

For each entry in an inbox's `ruleNotices`, add its line once:
- `skipped`: "Your approved rule “<rule>” won't run in this version because it needs a check that isn't available yet. The rule is kept."
- `reduced`: "Your approved rule “<rule>” can still check no-reply sender addresses. This version doesn't check for unsubscribe links."

Never say every rule ran when an approved rule was skipped.

When something moved, take the undo line from each inbox's `undoAdvisories`, one line per inbox and destination that received confirmed moves:
- `no-obstacle` or `unassessed`: "To undo, ask this workspace's chat: “undo MailKeeper run <id>”. It will check first what can be undone."
- `limit` or `unknown`: "MailKeeper may not be able to undo the moves into <folder>: <the reason from Chat>." For `combined-size`, name the folders together, once for each set of folders: "MailKeeper may not be able to undo all the moves into <folder> and <each of combinedWith>: together they would hold more messages than MailKeeper can check in one undo." Add the undo line too when other destinations had no obstacle.
- **Stopped partway** (the inbox's `code` is `MAILKEEPER_MUTATION_UNCERTAIN`): each destination still gets its line, but undo comes after the check, never before. Use `confirmed` for <n>: "<n> moves into <folder> are confirmed. The server didn't confirm the rest, so I stopped. Ask me to check them; after that, you can ask this workspace's chat: “undo MailKeeper run <id>”." Keep any `limit` or `unknown` line for that folder, and never give the plain undo line for this inbox.

Never promise that moves can be undone.

Write only the per-inbox sections and, when something moved, the undo lines. No error codes, no step names (snapshot, triage, apply, propose), and no notes about lessons, tools or this workspace's own instructions. A scheduled report is read in the maintenance thread, where no one may answer: wherever this skill says "ask me", say "ask this workspace's chat".

When an inbox's effective behaviour is stricter than the user might expect, say why, for example "report only: its contract says so" or "report only until you review its contract". A partial run is never "completed" or "all good".

For an inbox that only reports (`mode` is `report-only`, or its `outcome` is `partial`), the next action is about its urgent items ("Read the urgent items first"), or "No action needed" when there are none. Never invite acting on its suggestions, since a run there won't move them. You may add once: "MailKeeper only reports for this inbox, so it won't move these." Reply exactly `HEARTBEAT_OK` only when every inbox was checked in full (no `partial` outcome), nothing moved, nothing was suggested, nothing is urgent, nothing failed, no rule notice is owed, and no explanation is owed.

If `submit` reports `effortNotApplied`, add one line: "Reasoning effort isn't applied because no model is selected in MailKeeper settings. Choose a model to use it." For an unsupported agent, say instead: "Reasoning effort isn't supported for <agent> by MailKeeper yet."

## Status ("what's MailKeeper's status")

Run `mailbox-ops status` and answer from it only, one section per inbox by its full address. Never work out run, undo or setup state from MailKeeper's files.

- **Set up:** `setupComplete`. When `lastCheck.current` is false: "Set up: needs a fresh connection check. The last connection check for work@example.com was before this update. Say “check work@example.com” to confirm it." Never say "not complete" or "the rest of its setup" for that reason.
- **Mode:** the contract's `mode`, and `effectiveMode` when the workspace limit makes it stricter.
- **Last run** (`lastRun`): when it finished, its `outcome`, and its coverage in the Reports wording. A `partial` read uses the Reports line for it, with no promise that another run or a smaller scope gets further. Name the folder when `coverage.folder` isn't INBOX.
- **Moves and undo:** `moved` describes the last run only: say "nothing was moved in their last runs" ("in its last run" for one inbox), never that an inbox has never had mail moved. Then this inbox's `undo.state`: `done` ("Those moves were undone."), `partial` (the Undo line "I haven't undone <n> moves from this run.", with `remaining` for <n>), `uncertain` (an undo move wasn't confirmed: the `MUTATION_UNCERTAIN` line and its check), or `none` (the undo line from Reports).
- **Urgent mail:** when `urgentChecked` is true, `urgentCount` with up to five `urgent` items, or "Nothing urgent in work@example.com: I checked and found none." when there were none. When it is false, that run didn't check. When it is null (a run from before this version): "No urgent-mail result is recorded for that run." Never say "this run didn't check for urgent messages" for null.
- **Schedule:** the one sentence for `schedule.closing`, as in setup.

## Undo ("undo MailKeeper run <id>")

```sh
mailbox-ops undo --run-id <id> [--account <name>] --dry-run     # preview first
mailbox-ops undo --run-id <id> [--account <name>]
```

Preview the reversal per inbox, and get a yes before acting. Moved messages get new IDs in their destination, so undo finds them again by sender, subject and date, and only in a folder it could list to the end. Undo checks every inbox before changing any. Before acting, say which ones it can't undo (`unresolved`), one line per reason, with <n> their count and <folder> from `from`:
- `not-found`: "I couldn't find <n> of them in <folder>. I didn't move those messages."
- `ambiguous`: "I can't safely undo <n> of them, because I can't tell which messages in <folder> belong to those moves. I didn't move those messages."
- `folder-not-fully-checked`: "I can't safely undo <n> of them, because I could only check part of <folder> in this version. I didn't move those messages."
- `no-fingerprint`: "I can't undo <n> of them, because MailKeeper didn't record what I need to find them again. I didn't move those messages."

"I didn't move those messages" covers only these unresolved ones. Never say it, or anything about where a message is, for a move whose result is unknown.

When `remaining` is more than 0 after an undo: "I haven't undone <n> moves from this run." Add "You can ask me to undo it again later." only when `retryMayHelp` is true. Asking again tries only moves without a confirmed reversal.

If undo returns `MUTATION_UNCERTAIN`, an earlier undo move was never confirmed: use the failure table's line and its check, and never start another undo before that check.

## When something fails

Always answer in this order: the inbox name; what happened, without guessing the cause; what changed, from the receipt ("Nothing was changed", "N moved before the problem; you can undo them" (`movedBeforeProblem`), or "I can't confirm whether the last move finished"); one next action, in the place the user will act. Never show the code itself; it stays in the receipt. Name a Login by its name when you know it (from setup, or from Secrets metadata for the contract's reference), never by its `secret://` reference; otherwise say "the MailKeeper Login for work@example.com". Other inboxes continue when it is safe.

| Code | Say (inbox-specific where it applies) |
|---|---|
| `HIMALAYA_UNAVAILABLE`, `HIMALAYA_VERSION_UNSUPPORTED` | MailKeeper needs a supported version of the Himalaya email tool on this computer (see the MailKeeper README). |
| `HIMALAYA_CONFIG_MISSING` | I can't find your email settings yet. Ask me to set up MailKeeper and I'll create them with you. |
| `HIMALAYA_CONFIG_INVALID` | Your email settings file has a problem I can fix with you. I won't show its contents. Ask me to repair MailKeeper's email settings. |
| `ACCOUNT_NOT_FOUND`, `ACCOUNT_IDENTITY_MISMATCH` | work@example.com is selected in MailKeeper settings but isn't in your email settings any more. Ask me to reconnect it, or remove it from Inboxes. |
| `CONTRACT_REVIEW_REQUIRED` | work@example.com's contract needs a quick review after the update. Until then I only report for it, and nothing will be moved. Ask me to “review the work@example.com contract.” |
| `CONTRACT_INVALID` | I can't read the MailKeeper settings in work@example.com's contract, so I'm only reporting for it. Ask me to fix it; I'll keep your wording. |
| `CONTRACT_CHANGED` | work@example.com's contract changed after this preview. I'll preview again before changing anything. |
| `PLAN_CHANGED` | Choose by `established` and `movedInQuestion`. `established` true, `movedInQuestion` 0: "The messages in work@example.com changed after I showed you this plan, so I haven't moved anything. I'll show you the updated plan and ask again." `established` true, `movedInQuestion` above 0: "The messages in work@example.com changed after I showed you this plan. I moved <n> as planned and stopped there. I'll show you the updated plan for the rest and ask again." `established` false, `movedInQuestion` 0: "I need to show you the current plan for work@example.com before I can make these moves, so I haven't moved anything yet." `established` false, `movedInQuestion` above 0: "I moved <n> as planned. I need to show you the current plan for the rest before I can move anything else." `movedInQuestion` null: "I need to show you the current plan for work@example.com. No messages were moved by this attempt." Then show the updated plan as one new question with its own lines. Moves already made keep their receipt and undo lines. It is never an uncertain move: when the inbox has one, use `MUTATION_UNCERTAIN` instead. |
| `CREDENTIAL_UNAVAILABLE` | work@example.com: its saved Login isn't available. In Settings → Secrets, check that the Login "…" exists, is enabled, has a password and is available to this workspace. |
| `IMAP_CHECK_FAILED`, `NETWORK_DENIED`, `TIMEOUT` | Report: "work@example.com: couldn't check. Nothing was changed. Ask this workspace's chat to “check work@example.com” to go through its setup." Chat: "I couldn't check work@example.com. Nothing was changed. Shall I go through its setup with you?" These codes don't say whether the server, the network or the sign-in failed: never name a cause or give password advice for them. |
| `RTXEXEC_UNAVAILABLE`, `SESSION_UNAVAILABLE` | I can only reach your inboxes from a RealTimeX workspace chat or a scheduled run. Ask me here in the workspace chat. |
| `RUN_BUSY` | **After the person's yes** (`apply` couldn't take the guard back, or lost it): with `movedBeforeStop` above 0, "I moved <n> as planned, then stopped before moving the rest. Ask me again and I'll show you the current plan for the rest."; otherwise "I couldn't confirm whether another MailKeeper run has ended, so I haven't started these moves. Ask me again and I'll show you the current plan." Moves already made keep their receipt and undo lines; an uncertain move uses `MUTATION_UNCERTAIN` instead. **Starting a run** (any other time): Chat: "I couldn't confirm whether MailKeeper's previous run, started today at 09:00, has ended, so I won't start a new run or change any mail for now. This can happen when RealTimeX closes or restarts during a run. MailKeeper can't clear it on its own yet. Please ask for help through Community & support in the RealTimeX sidebar, and mention MailKeeper run 7f3a." If `heldRunMoved` is more than 0, add: "Before that, it moved <n> messages; their undo is kept." Scheduled report: "MailKeeper didn't check any inbox: it couldn't confirm whether its previous run, started today at 09:00, has ended. Nothing will run until that's cleared. Ask for help through Community & support in the RealTimeX sidebar, and mention MailKeeper run 7f3a." Take the time from `heldSince` (in local time); if it is missing, leave out ", started today at 09:00" rather than guess. Take the run from `heldBy` (its first characters); it is for support, not a step for the person. Community & support is a public channel: never add the workspace name, an address or a path to this message. Never say it is "already running" or "not running", and never offer `release` for another run or remove its guard: you release only your own run before its question, and `release --reconciled` only follows a check of an uncertain move. |
| `MUTATION_UNCERTAIN` | The connection dropped while moving messages in work@example.com, so I can't confirm the last move. I've stopped changes for this inbox and won't repeat it. Ask me to check it. |
| `TERMINAL_REQUIRED` | Undo for work@example.com runs in the workspace chat. Ask me: "undo MailKeeper run 7f3a". |
| `OPERATION_FAILED` | Something went wrong while working on work@example.com. (Receipt-based change statement.) Ask me to try again. |

**Going through an inbox's setup** is for a failed check. When the person asks "check <address>", run `check` first: if it passes, give only its short result ("Connected to work@example.com. Nothing was changed."). If it fails, go straight to the review; after a failure they didn't ask about, offer it first. Review only what you can verify, one item at a time, and say what you found, or that it's unknown, without naming a cause:

1. The Login linked in this inbox's contract: saved, enabled and available to this workspace, from Secrets metadata only. Never read the password, and never claim metadata shows whether it is a normal or an app password. Switching the inbox to a different Login still needs the person's explicit choice.
2. The inbox's server details (`config-check`).
3. What this setup method needs from the provider, as a requirement of the method, never as evidence about today's failure. For a saved-password Gmail inbox: "This setup uses a saved password. For Gmail, use an app password if your account allows one; creating one requires 2-Step Verification. See https://support.google.com/mail/answer/185833." If the account can't use app passwords, don't suggest weakening its protections or replacing the saved password again. Leave a working native sign-in as it is.
4. Network access: only when checks work here in chat but scheduled checks keep failing, say "make sure the maintenance agent is allowed to use the network", without calling it the cause. Never say scheduled checks would fail only for that reason.

Then run the read-only `check` once. It is the bounded sign-in and folder check, never a full scan, a move or a retry loop. If a sign-in already succeeded in the run you're explaining, keep that result and look at the later failure instead of the setup.

Say "Nothing was changed" only when the inbox's receipt shows no confirmed moves and nothing pending or uncertain; otherwise use the partial and undo wording above.

**Checking an uncertain move:** snapshot the inbox and its destination folder, and show the user which recorded messages are where. Only after the user agrees the inbox is in a known state, run `mailbox-ops release --run-id <id> --reconciled`.

## After an update from MailKeeper 0.1

Each inbox now has its own contract; `begin` marks the inboxes awaiting review. The first time an inbox shows `migrationNotice: true`, use the `CONTRACT_REVIEW_REQUIRED` wording and add: "Your old MAILBOX.md is kept for reference but is no longer used; each inbox now has its own contract: [links]." Every later report keeps saying the inbox needs review until the user confirms.

In that first report, say what happened to approved rules only from what `begin` recorded, never from how many inboxes are selected today:
- an inbox whose `rulesKept` is above 0: "Your approved rules for work@example.com are kept."
- once per report, when `legacyUnscopedRules` is above 0: "MailKeeper couldn't establish which inbox <n> older approved rules belonged to. They're suggestions now, and MailKeeper won't apply them on its own."

Both can apply. Never say all rules were kept or all were demoted, and don't offer to approve them: approving rules isn't available in this release.

The review is one pre-filled confirmation, not a questionnaire. Read the old root `MAILBOX.md` and the inbox's contract, fill the settings with `contract-set`, and show the plain-language summary. Ask only about what is ambiguous or can't be expressed. Pre-filled wording is never consent: run `contract-set --account <name> --confirm-review` only after the user says yes. Approved rules from 0.1 that can't be tied to one inbox come back as suggestions.
