# Long-Term Memory

<!-- Patterns, learnings, successful approaches, and failures discovered over time. -->
<!-- Updated by agent during heartbeat cycles when significant learnings occur. -->

## Restart Notification Protocol

On session start after any restart (soft, hard, or daemon): send a "back online" message to whoever you were last in active conversation with. Do not broadcast to all users — only notify your active conversation partner.

Check daily memory or last-telegram state files to identify who to notify.
