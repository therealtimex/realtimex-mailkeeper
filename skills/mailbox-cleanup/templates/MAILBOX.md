# {{INBOX}} — MailKeeper contract

This contract belongs to you. MailKeeper created it once and never overwrites it. The agent reads it before every run of this inbox, and it outranks MailKeeper's own instructions. Each inbox has its own contract; changes here affect only {{INBOX}}.
{{MIGRATION_NOTE}}
## What MailKeeper may do on its own

Report only. MailKeeper checks this inbox and lists what it would suggest, but moves nothing.

Scheduled runs apply only rules you have already approved, and only within this contract and your workspace settings. Everything else appears as a suggestion in the report. To act on a suggestion now, ask the agent in chat: it shows you what it would move and asks before moving anything. Approving new automatic rules isn't available from chat or settings in this release.

MailKeeper never deletes, trashes or replies to mail.

## Never touch

MailKeeper never moves mail from:

- the senders listed for this inbox in its settings below: an address, or a domain and all its subdomains
- your workspace's VIP senders, which apply to every inbox
- the domains protected in MailKeeper's global settings (currently {{PROTECTED_DOMAINS}})

Flagged messages are never moved either. Ask the agent to add or remove a sender for this inbox.

## Always ask first

These are never moved by an automatic rule. They are only listed for you:

- Financial: invoices, statements, payment failures, chargebacks
- Legal: contracts, notices, subpoenas, DMCA
- Account security: password resets, new sign-ins, verification codes, security alerts
- Government, regulatory and tax

## Urgency signals

Checked first on every run. Matching messages are listed at the top of the report and left in the inbox.

- Subject: overdue, suspension, suspended, collections, final notice, legal, subpoena, action required, past due
- Sender domain ending in .gov or .gov.<country>

## Notes

Anything the agent should know about this inbox: shared aliases, forwarding, senders that look like spam but aren't, folders that already exist. The agent follows these notes when it suggests. Notes that the settings below can't express keep the affected cleanup as a suggestion on scheduled runs.

## MailKeeper settings

MailKeeper reads this block to enforce your contract. Ask the agent to change it; you don't need to edit it.

{{POLICY_BLOCK}}
