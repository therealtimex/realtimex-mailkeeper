# Mailbox contract — {{EMAIL_ACCOUNT}}

This file is owned by you, not the plugin. The plugin seeds it once and never overwrites it. The maintenance agent reads it every run and it outranks the generated prompt.

Mode: `{{MODE}}` · Age threshold: {{AGE_THRESHOLD_DAYS}} days · Aggressiveness: `{{AGGRESSIVENESS}}`

## Never touch

VIP senders (address or domain):

{{VIP_SENDERS}}

Protected domains (set globally, cannot be overridden here): {{PROTECTED_DOMAINS}}

## Confirm before acting

Categories that must never be handled by a promoted rule, only surfaced for a human:

- Financial: invoices, statements, payment failures, chargebacks
- Legal: contracts, notices, subpoenas, DMCA
- Account security: suspension, password reset, new sign-in, 2FA
- Government / regulatory / tax
- Anything containing: overdue, suspension, collections, final notice, action required

## Urgency signals

Checked first on every run. Hits are listed in the receipt and never moved by any rule.

- Subject or body: `overdue`, `suspension`, `suspended`, `collections`, `final notice`, `legal`, `subpoena`, `action required`
- Sender domain ends with: `.gov`, `.gov.vn`

## Cleanup passes

The agent may only *execute* rules listed under **Promoted rules** in the plugin status. Everything else it runs as a dry run and reports as a proposal. Promote a proposal from the plugin status page, or demote a rule that misfires.

Passes, in the order the playbook runs them:

1. `age` — older than the threshold, unflagged, not from a VIP
2. `personalized-outreach` — your first name or company in the subject from an unknown domain
3. `generic-outreach` — "quick question", "checking in", "following up", "touching base", "circle back"
4. `no-reply` — `noreply`, `no-reply`, `donotreply`, `notifications@`, `unsubscribe` in body
5. `calendar-response` — subject starts with `Accepted:`, `Declined:`, `Tentative:`, `Invitation:`
6. `receipt` — receipt, order confirmation, shipped, delivered, invoice paid
7. `sketchy-tld` — sender domain ends with `.shop`, `.biz`, `.xyz`, `.info`, `.club`, `.online`, `.top`, `.icu`
8. `repeat-sender` — 20+ messages from one sender, none replied to

## Notes

Add anything the agent should know about this mailbox: shared aliases, forwarding rules, senders that look like spam but are not, folders that already exist.
