---
name: gmail
effort: low
description: "Read and draft emails via your configured Gmail account. Use for checking notifications, drafting vendor emails, and monitoring inbox for relevant messages. All outbound emails require your approver's sign-off before sending."
triggers: ["email", "gmail", "inbox", "send email", "draft email", "check email", "vendor email", "tenant email", "PM email", "property meld email"]
---

# Gmail Skill

Access your configured Gmail account via the `gws` CLI. Set up your own Google OAuth2 credentials first (see the `gws` setup docs); once authenticated, the CLI uses your stored refresh token.

## Read inbox

```bash
# Unread summary (sender, subject, date)
gws gmail +triage

# Search for specific emails
gws gmail users messages list --user-id me --q "from:propertymeld.com" --format json
gws gmail users messages list --user-id me --q "subject:emergency" --format json

# Read a specific message
gws gmail users messages get --user-id me --id <message_id> --format json
```

## Send email

**APPROVAL REQUIRED** — never send without your approver's explicit sign-off.

```bash
# Draft and send (only after approval)
gws gmail +send --to "vendor@example.com" --subject "Subject" --body "Body text"

# With CC
gws gmail +send --to "vendor@example.com" --cc "you@example.com" --subject "Subject" --body "Body"
```

## Workflow

1. **Reading:** Free to read inbox at any time for notifications, vendor responses, tenant messages
2. **Drafting:** Write the draft, then route it to your configured approver (e.g. via your orchestrator or Telegram) for sign-off
3. **Sending:** Only after your approver signs off. CC your own account on outbound vendor comms if you want a copy.
4. **Night mode:** Read only. Queue drafts for morning review. No sending.

## Mark message as processed

After acting on a Gmail watch message, apply your own "processed" label (e.g. `your-processed-label`, label ID `Label_XXX`) instead of marking read. IMAP clients re-mark read messages unread within seconds; a label persists correctly.

```bash
# Mark a message as processed (required after every Gmail watch action)
gws gmail users messages modify --params '{"userId":"me","id":"<MESSAGE_ID>"}' --json '{"addLabelIds":["<YOUR_PROCESSED_LABEL_ID>"]}' --format json
```

Point your Gmail watch query at `-label:your-processed-label` so labeled messages won't re-appear.

## Useful searches

- Property Meld notifications: `from:propertymeld.com`
- Emergency melds: `from:propertymeld.com subject:emergency`
- Vendor responses: `from:<vendor_email>`
- Unread only: `is:unread`
- Last 24h: `newer_than:1d`
