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

The plugin follows the built-in Dogfood pattern: workspace-scoped activation, a managed task in the workspace `HEARTBEAT.md`, a plugin-owned thread, and clean teardown. The public `PluginAPI` does not yet expose workspace/thread/heartbeat operations, so `runtime/host.js` bridges to server internals through the `@/` shim the loader already provides for plugin entrypoints.

That is a bridge, not the design. [realtimex-ai-app#1996](https://rtgit.rta.vn/rtlab/rtwebteam/realtimex-ai-app/-/issues/1996) proposes `api.workspaces` and `api.heartbeat` namespaces; `host.js` switches to them automatically when present and nothing else in the plugin changes. Nothing outside `host.js` may require `@/`.

The account picker depends on `optionsRoutePath` support in the host config modal — [realtimex-ai-app#2001](https://rtgit.rta.vn/rtlab/rtwebteam/realtimex-ai-app/-/issues/2001), which also brings schema-driven grouping, compact rows, and correct required state. On an older host the field renders as a plain multi-select with no options; `GET /accounts` still answers.

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
