---
name: mailbox-cleanup
description: Multi-pass mailbox cleanup playbook over Himalaya (any IMAP provider). Use for large-backlog inbox cleanup, proposing and promoting cleanup rules, unattended maintenance runs driven by the RealTimeX MailKeeper plugin heartbeat, and reversing a previous run. Pattern-based subject/sender/body passes catch far more archivable mail than sender-only scans.
---

# Mailbox Cleanup

A playbook for large-scale mailbox cleanup, adapted from the Vellum `inbox-cleanup` skill for any IMAP provider through Himalaya. Two ways to run it:

- **Interactive** (a human is in the thread): all phases, you confirm every archive decision.
- **Maintenance** (launched by the MailKeeper plugin heartbeat): only *promoted* rules execute; everything else is a dry run reported as a proposal. The generated prompt tells you which.

Read `MAILBOX.md` in the workspace root before anything else. It is the human-owned policy and outranks both this file and the generated prompt.

## Sources of truth

- Account names and mode come from the plugin (workspace settings) — never guess a host, address, or folder. A workspace may keep several accounts: run every per-account step once per account, then submit one receipt.
- Himalaya config: `HIMALAYA_CONFIG` if set, otherwise the BizOps-configured TOML (`realtimex-bizops` skill explains how to resolve it). All commands take `-a <account>`.
- Local state lives in `.mailkeeper/` in the workspace root: `rules.json` (written by the plugin: effective config, per-account folders, promoted rules), `snapshot-<account>.json` (envelope cache), `runs/<runId>.json` (receipts), `outbox/` (receipts waiting for the plugin to ingest).
- `scripts/mailbox-ops.js` is the only way to touch the mailbox from this skill. Do not hand-assemble `himalaya message move` commands.

## Safety rules (non-negotiable)

1. Never delete or trash. The only mutation is `move` (archive folder or `Auto/<category>`).
2. Never touch VIP senders, protected domains, flagged messages, or urgency-triage hits.
3. Every mutation is preceded by a dry-run preview: count, top-10 senders, 10 sample subjects, flagged categories.
4. Interactive: explicit human confirmation at every apply. Maintenance: promoted rules only.
5. Every run produces exactly one receipt with every moved UID, so `undo` can reverse it.
6. Never invent rules. Propose them; a human promotes them from the plugin status page.

## Phases

### 1. Preferences (interactive only)

Ask once, then write the answers into `MAILBOX.md`:
- Aggressiveness: conservative / standard / aggressive
- Age threshold (days) for the bulk pass
- VIP senders to protect
- Confirm-first categories (financial, legal, account security, government are always on)

### 2. Snapshot

```sh
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js snapshot --account <name>            # full
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js snapshot --account <name> --since-last-run   # delta (maintenance)
```

Pulls envelopes (uid, date, from, subject, flags) into `.mailkeeper/snapshot.json`. All passes run against this cache, so previews are instant and the server is only hit again to move UIDs.

### 3. Urgency triage — always first

```sh
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js triage --account <name> --run-id <id>
```

Surfaces overdue / suspension / collections / legal / `.gov` hits. These go in the receipt under `urgent` and are excluded from every later pass.

### 4. Passes

Run in this order. `preview` is always a dry run; `apply` mutates unless `--dry-run` is given or the mode is `report-only`.

| Pass | What it matches | Default action |
|---|---|---|
| `age` | older than threshold, unflagged, not VIP | archive |
| `personalized-outreach` | first name / company in subject from unknown domain | `Auto/Outreach` |
| `generic-outreach` | "quick question", "checking in", "following up", "touching base", "circle back" | `Auto/Outreach` |
| `no-reply` | `noreply`, `no-reply`, `donotreply`, `notifications@`, body `unsubscribe` | `Auto/Notifications` |
| `calendar-response` | subject starts `Accepted:` / `Declined:` / `Tentative:` / `Invitation:` | `Auto/Calendar` |
| `receipt` | receipt, order confirmation, shipped, delivered, invoice paid | `Auto/Receipts` |
| `sketchy-tld` | sender domain `.shop .biz .xyz .info .club .online .top .icu` (exact TLD, not substring) | `Auto/Suspicious` |
| `repeat-sender` | 20+ messages from one sender, none replied to | `Auto/Bulk` |

```sh
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js preview --account <name> --pass no-reply
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js apply   --account <name> --pass no-reply --run-id <id>      # interactive, after confirmation
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js apply   --account <name> --promoted-only --mode <mode> --run-id <id>   # maintenance
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js propose --account <name> --run-id <id>                      # dry-run the rest, emit proposals
```

In `report-only` mode, `apply` is always a dry run. In `label-only`, archive actions are downgraded to `Auto/<category>` moves. In `archive-promoted`, promoted `age` rules may archive.

### 5. Cold-outreach classification

Only when a pass is ambiguous: flag as cold outreach when **3+** of these hold — unknown sender domain, personalized subject, outreach phrase in body, known outreach-tool domain (`lemlist`, `apollo`, `outreach.io`, `salesloft`, `hubspot` tracking links). Use judgement, not the LLM slot; the snapshot has enough signal.

### 6. Receipt

```sh
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js submit --run-id <id> --outcome completed --summary "..."
```

Writes `.mailkeeper/outbox/<runId>.json` with `actions`, `proposals`, `urgent`, and the summary. The plugin ingests it on the next lifecycle event or status read. Exit only after it prints `ok:true`.

### 7. Reversal

```sh
node .agents/skills/mailbox-cleanup/scripts/mailbox-ops.js undo --run-id <id> [--account <name>] [--dry-run]
```

Moves every UID in the receipt back to where it came from, across every account the run touched (or just one with `--account`). Or use the plugin's `POST /undo` from the status page.

## Reporting

Interactive: after each apply, report count moved, top senders, and how to undo. At the end, list proposals worth promoting.

Maintenance: post a short summary in the maintenance thread — moved N (by category), proposed M rules, K urgent items — or exactly `HEARTBEAT_OK` if nothing moved and nothing was proposed.
