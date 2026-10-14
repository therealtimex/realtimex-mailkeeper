# MailKeeper support notes

For RealTimeX support, not for the person using MailKeeper. Nothing here is a step the person is asked to take.

## Clearing a stranded run

If RealTimeX closes or restarts while MailKeeper is running, MailKeeper may never learn that the run ended. It then holds the workspace and says it couldn't confirm whether its previous run has ended, quoting the run ID. Until realtimex-ai-app#2456 lets MailKeeper check this itself, support clears the hold by hand, in this order:

1. **Confirm the old run has stopped and can't resume.** The run's terminal sessions are recorded in `.mailkeeper/run.lock` (`owner.terminalSessionId`) and, for scheduled runs, in `.mailkeeper/runs/<run ID>.owner.json` (host runtime and PTY session IDs). Check that those sessions are gone. An app restart, the time that has passed or `mailbox-ops release --reconciled` doesn't establish this on its own.
2. **Reconcile any move in doubt.** Read `.mailkeeper/runs/<run ID>.json`. If `pending` is set or `uncertain` isn't empty, check the inbox with the person and reconcile that move first, using the skill's uncertain-move check. If the journal can't be read or isn't a MailKeeper journal, investigate; don't delete the guard blindly.
3. **Keep the record.** Leave the journal and its confirmed moves in place: they are the run's audit and undo record.
4. **Clear only that run's hold.** Remove `.mailkeeper/run.lock` only if its `runId` is that run. The next run starts with a fresh run ID; never resume work under the old one.
