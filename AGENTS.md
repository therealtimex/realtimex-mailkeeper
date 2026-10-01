# AGENTS.md

This file is for coding agents (Codex/Claude/Cursor/etc.). Keep it strict and actionable.

## Overview

<!-- AGENTSGEN:START section=overview -->
- **Project:** realtimex-mailkeeper
- **Stack:** Node.js >=20 (npm), CommonJS runtime, built-in Node test runner
- Keep changes small and verifiable.
<!-- AGENTSGEN:END section=overview -->

<!-- AGENTSGEN:START section=repo_context -->
### Repo context (read this first)

**Project:** realtimex-mailkeeper
**Stack:** Node.js >=20; RealTimeX plugin using Himalaya for mailbox access
**Repo root:** `.`

#### Quick orientation
- Start here:
  - `README.md`
  - `skills/mailbox-cleanup/SKILL.md` for interactive and maintenance contracts
  - `templates/MAILBOX.md` for the human-owned mailbox policy
- Plugin entrypoint: `index.js`; host capability adapter: `runtime/host.js`.
- Release packaging: `scripts/build-plugin-release.mjs`.
- Tests: `tests/config.test.js` and `tests/host.test.js`.

#### Commands (copy/paste)
**Local checks**
```bash
npm test
npm run lint:manifest
npm run build:plugin
```

#### Local environment notes

- Prefer the repo's existing toolchain (don't upgrade it).
- Use Node.js >=20. The current package declares no npm dependencies and has no lockfile; local checks do not need an install step. Do not run `npm ci` or introduce another package manager for setup.
- Tests run without a RealTimeX server. Plugin execution needs the host-provided `@realtimex/plugin-sdk`; release packaging also needs `zip` on PATH.
- If you need new env vars: document names, don't invent secrets.
- If a command fails due to missing deps, explain the minimal install step.

#### Where to put new things

- Plugin runtime logic — `runtime/`; host capability access — `runtime/host.js` only.
- Workspace cleanup CLI — `skills/mailbox-cleanup/scripts/mailbox-ops.js`.
- Seeded mailbox policy — `templates/MAILBOX.md`.
- Release utilities — `scripts/`; automated coverage — `tests/`.
- Create planning/spec directories only when requested; they are not part of the current layout.
<!-- AGENTSGEN:END section=repo_context -->

<!-- AGENTSGEN:START section=guardrails -->
### Guardrails (how to not break realtimex-mailkeeper)

**Your job:** be useful, be safe, be boring. Small diffs. Deterministic output. No surprises.

#### MailKeeper contracts
- Keep mailbox mutations limited to moves into configured archive or `Auto/*` folders; never add delete, trash, reply, or server-side filter behavior.
- Default to `report-only` and preserve the global mode ceiling. Maintenance executes only human-promoted rules; proposals never activate themselves.
- Preserve VIP sender, protected domain, flagged-message, and urgency-triage exclusions in every pass. Workspace settings cannot override globally protected domains.
- Run urgency triage before cleanup passes. Interactive applies require a dry-run preview and explicit human confirmation for each apply.
- Preserve one receipt per run, each moved UID and its account/source/destination, and the ability to undo across all affected accounts.
- Treat workspace `MAILBOX.md` as human-owned policy: seed it only when absent and never overwrite existing preferences. Keep message bodies and credentials out of chat and logs.
- Confine host capability access and server-internal `@/` imports to `runtime/host.js`; preserve its preference for public SDK namespaces when available. Keep the workspace cleanup CLI self-contained.

#### 0) Scope & intent
- Implement exactly what's requested. If requirements are ambiguous: ask one precise question (or make the smallest reasonable assumption and state it).
- Prefer changing existing code over adding new systems.
- Avoid framework upgrades unless explicitly asked.

#### 1) Safe edits only
- Keep diffs small (target: <300 lines unless unavoidable).
- Never rewrite whole files when a patch will do.
- Preserve formatting, naming patterns, and local conventions.

#### 2) No destructive operations
- Do not delete data, migrations, buckets, or user files.
- Avoid broad refactors touching many modules at once.
- Never remove features because unused without explicit instruction.

#### 3) Secrets & credentials
- Never hardcode tokens/keys.
- Never print secrets into logs.
- If a secret is needed: use env vars + document the name.

#### 4) Side effects / dangerous actions
- Routine local edits, tests, manifest checks, and plugin packaging are included in an authorized development task.
- A development task does not authorize live IMAP commands, mailbox mutations, rule promotion, plugin activation on a live workspace, release publication, or system configuration changes; obtain explicit authorization for those actions.
- Use isolated fixtures or mocks for verification. Follow the mailbox cleanup skill's preview/confirmation and promoted-rule requirements when live operation is explicitly authorized.
- Don't use dangerous flags unless explicitly approved.
- If a task involves running arbitrary tools/scripts: isolate and explain.

#### 5) Confirm scope when needed
Explicit user instructions and approvals carry forward. Do not ask again for work already authorized by the request or earlier in the session.
Before expanding an authorized task to include any of these, confirm the added scope:
- schema changes
- auth/payments/crypto
- deletions or large refactors
- new build tooling/CI changes
- new major dependencies

#### 6) Definition of Done (DoD)
A change is done only if:
- the behavior is correct,
- tests/checks are run (or you explain why they can't be run),
- the diff is minimal and readable,
- docs/comments are updated if behavior changed.

#### 7) Output protocol
When responding, include:
- what changed (1-3 bullets),
- how to verify (commands / steps),
- risks/assumptions (if any).
<!-- AGENTSGEN:END section=guardrails -->

<!-- AGENTSGEN:START section=workflow -->
### Workflow (how we ship changes in realtimex-mailkeeper)

#### 1) Start with reality
- Read the nearest README / docs / existing patterns.
- If there's a failing case: reproduce it (or create a minimal reproduction).

#### 2) Work in thin slices
- Prefer one small working increment over a big redesign.
- Change one thing, verify, then move to the next.

#### 3) Make changes reviewable
- Keep diffs minimal.
- Avoid unrelated formatting churn.
- Prefer refactoring after the fix works, not before.

#### 4) Verification loop
- Run fast checks after each meaningful change.
- Run the relevant checks below before finalizing; scale verification to the changed behavior.
- If you cannot run checks, explain why and what to run.

#### 5) Commit / PR discipline (even if you don't actually commit)
Think like you're preparing a PR:
- Clear intent
- Small diff
- Tests included
- No breaking changes without warning

**Commit message style (suggested):**
- Allowed types: feat, fix, test, docs, refactor
- Example: `fix: handle empty input in parser`

#### 6) Communication rules
- If the task is blocked by missing info: ask one concrete question.
- If you make an assumption: state it explicitly and keep it reversible.
<!-- AGENTSGEN:END section=workflow -->

<!-- AGENTSGEN:START section=verification -->
### Verification (don't trust yourself, verify)

#### Fast checks (run often)
- Config changes: `node --test tests/config.test.js`.
- Host adapter changes: `node --test tests/host.test.js`.
- Manifest changes: `npm run lint:manifest` (JSON syntax only).

#### Full checks (run before finalizing)
- Code changes: `npm test` and `npm run lint:manifest`.
- Packaging or shipped asset changes: also run `npm run build:plugin`; artifacts are written to ignored `dist/`.
- Documentation-only changes: verify referenced commands and paths against the repository; run commands whose behavior the documentation changes.
- Existing tests cover config and the host adapter. They do not verify live IMAP behavior, rule application, or undo; add focused coverage when changing those contracts.

#### If checks cannot be run
State:
- why (missing deps / CI-only / platform),
- what to run,
- expected outcome.
<!-- AGENTSGEN:END section=verification -->

<!-- AGENTSGEN:START section=style -->
### Style & conventions (node)

#### 1) Follow the repo
- Match existing naming, structure, and patterns.
- Don't introduce new abstractions unless they reduce complexity.

#### 2) Readability wins
- Prefer clear code over clever code.
- Keep functions small and single-purpose.
- Choose explicit names over short names.

#### 3) Errors & edge cases
- Validate inputs at boundaries.
- Fail loudly for programmer errors, gracefully for user errors.
- Add helpful error messages (actionable, not vague).

#### 4) Logging (if applicable)
- Log meaningful events, not noise.
- Never log secrets or personal data.

#### 5) Types / docs (if applicable)
- Add type hints where it improves clarity.
- Add docstrings for public functions and tricky logic.
- Write comments only when the why is non-obvious.

#### 6) Dependencies
- Prefer standard library / existing deps.
- Avoid adding heavy dependencies for small tasks.
<!-- AGENTSGEN:END section=style -->

## Rules Of Engagement

<!-- AGENTSGEN:START section=rules -->
**DO**
- Prefer small diffs.
- Add or update tests when behavior changes.
- Run repo checks before finishing.

**DON'T**
- Do not rewrite unrelated code.
- Keep refactors within the authorized scope; confirm intent before expanding it.
- Do not commit secrets or local env files.

**If uncertain**
- Ask a short clarifying question before making big changes.

<!-- AGENTSGEN:END section=rules -->

## Commands

<!-- AGENTSGEN:START section=commands -->
- **Test:** `npm test`
- **Run one test file:** `node --test tests/config.test.js` or `node --test tests/host.test.js`
- **Manifest syntax:** `npm run lint:manifest`
- **Package plugin:** `npm run build:plugin`
- **Where configs live:** `package.json` and `realtimex.plugin.json`
<!-- AGENTSGEN:END section=commands -->

<!-- AGENTSGEN:START section=node -->
## Node project notes

### Common commands
- Setup: Node.js >=20; no npm dependency installation is currently required.
- Tests: `npm test`
- Manifest syntax: `npm run lint:manifest` (no general code lint script exists).
- Build: `npm run build:plugin` (requires `zip`).

### Guardrails
- Don't update lockfiles unless necessary
- Prefer minimal dependency changes
<!-- AGENTSGEN:END section=node -->

## Repo Structure

<!-- AGENTSGEN:START section=structure -->
- **Entrypoint:** `index.js` — plugin routes, lifecycle, heartbeat hooks.
- **Runtime:** `runtime/host.js` (host adapter), `runtime/config.js` (configuration and mode ceiling), `runtime/service.js` (provisioning, rules, receipts, undo), `runtime/mailbox.js` (Himalaya wrapper).
- **Workspace skill:** `skills/mailbox-cleanup/SKILL.md` and `skills/mailbox-cleanup/scripts/mailbox-ops.js`.
- **Policy template:** `templates/MAILBOX.md`.
- **Tests:** `tests/config.test.js` and `tests/host.test.js`.
- **Release packaging:** `scripts/build-plugin-release.mjs`; generated output in `dist/`.
- **Config:** `package.json` and `realtimex.plugin.json`.
- **Agent guidance:** `CLAUDE.md` is a symlink to `AGENTS.md`; preserve the shared source.
<!-- AGENTSGEN:END section=structure -->

## Output Protocol

<!-- AGENTSGEN:START section=output_protocol -->
When you finish work, include:
- Summary (1-3 bullets)
- Files changed (list paths)
- Verification (exact commands run and results, or why a check was not run)
- Remaining risks or assumptions, if any
<!-- AGENTSGEN:END section=output_protocol -->

## Git command availability

- Before running Git commands, check whether `git --version` succeeds.
- If Git is unavailable, report that the CLI is missing or not on PATH and ask the user to install Git before continuing with Git operations. Do not infer how the repository was initialized.
- Guide the user to the official downloads at https://git-scm.com/downloads, selecting the installer or package instructions for their operating system.
- Do not install Git, run a privileged package manager, or change the user's system configuration unless the user explicitly asks.
