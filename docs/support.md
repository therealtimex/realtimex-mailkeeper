# MailKeeper support notes

For RealTimeX support, not for the person using MailKeeper. Nothing here is a step the person is asked to take.

## Clearing a stranded run

If RealTimeX closes or restarts while MailKeeper is running, MailKeeper may never learn that the run ended. It then holds the workspace and says it couldn't confirm whether its previous run has ended, quoting the run ID. Until realtimex-ai-app#2456 lets MailKeeper check this itself, support clears the hold by hand, in this order:

MailKeeper holds a workspace in two places:

- **The run guard**, `.mailkeeper/run.lock` in the workspace. It stops a new chat run, scheduled run or undo from touching mail.
- **The admission marker**, kept in MailKeeper's plugin store. It makes RealTimeX skip a Run press or scheduled run for up to 6 hours after the stuck run started. There is no supported way to clear it by hand in this release. After that window it no longer holds, and the next Run or scheduled run starts under a fresh run ID.

Steps:

1. **Confirm the old run has stopped and can't resume.** The run's terminal sessions are recorded in `.mailkeeper/run.lock` (`owner.terminalSessionId`) and, for scheduled runs, in `.mailkeeper/runs/<run ID>.owner.json` (host runtime and PTY session IDs). You need positive evidence that those exact sessions have ended. Not finding them in a session list is not evidence: the list is limited and can fall back to history when the desktop relay fails. Neither is an app restart, the time that has passed or `mailbox-ops release --reconciled`. If the evidence is unknown or incomplete, investigate further and leave the hold in place.
2. **Reconcile any move in doubt.** Read `.mailkeeper/runs/<run ID>.json`. If `pending` is set or `uncertain` isn't empty, check the inbox with the person and reconcile that move first, using the skill's uncertain-move check. If the journal can't be read or isn't a MailKeeper journal, investigate; don't delete the guard blindly.
3. **Keep the record.** Leave the journal and its confirmed moves in place: they are the run's audit and undo record.
4. **Clear only that run's guard.** Remove `.mailkeeper/run.lock` only if its `runId` is that run. A chat run can then start straight away, with a fresh run ID. Run presses and scheduled runs can stay held by the admission marker until its 6-hour window ends; removing the file doesn't release that.
5. **Tell the person what was cleared.** In this release only the run guard can be cleared, and there is no supported way to read or clear the admission marker. So don't promise when the Run button or scheduled checks will work again, and don't say MailKeeper is cleared. Send:

   > You can run MailKeeper now by asking this workspace's chat to ‘run MailKeeper’. The Run button and scheduled checks may still be on hold; we haven't confirmed when that hold will end.

   Don't work out a time from `run.lock`. Its `startedAt` is when that run took the guard. The admission hold lasts 6 hours from MailKeeper's latest admission, which can belong to a newer run than the one in `run.lock`. A run started from chat has no admission at all. Even when the hold ends, a check still runs only on its schedule, and not while Schedule is Manual or the heartbeat is paused.
