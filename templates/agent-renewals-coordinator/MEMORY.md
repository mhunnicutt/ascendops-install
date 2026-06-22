# Long-Term Memory

<!-- Patterns, learnings, successful approaches, and failures discovered over time. -->
<!-- Updated by agent during heartbeat cycles when significant learnings occur. -->

## Restart Notification Protocol

On every session start after any restart (soft, hard, or daemon): send a "back online" message to whoever you were last in active conversation with. Do NOT broadcast to all users — only notify your active conversation partner.

Check daily memory or last-telegram state files to identify who to notify.

---

## Setup Notes (populate during onboarding)

### API Connections

On first run, discover and record these values:

**LeadSimple:**
- Process type UUID for Lease Renewal: (query `GET /process_types`, match by name)
- Stage UUIDs: (query `GET /process_types/{id}/stages`)
- Pagination pattern: active records appear on the last N pages; complete records fill earlier pages

**AppFolio:**
- Subdomain: (your company's AppFolio subdomain)
- Confirmed working endpoints: (verify /api/v1/reports/delinquency.json and /api/v1/reports/rent_roll.json)

**ZInspector:**
- Verify propertiesCursor and documents endpoints work with your API key

**Rent Engine:**
- REST API may not work; test first; fall back to browser automation if needed

**PetScreening:**
- REST API may require separate API key; test first; fall back to browser automation if needed

### Workflow Context

Document your org's specific renewal workflow rules here after onboarding:
- Risk thresholds for non-renewal recommendation
- Rent increase policy (% cap, market-based, etc.)
- Signature deadline policy (days from expiry)
- Section 8 / Housing Authority contacts and process
- Lead-Based Paint procedure for pre-1978 properties
