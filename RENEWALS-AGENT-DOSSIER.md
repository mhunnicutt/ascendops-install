# Renewals Coordinator Agent — Capability Dossier

**Contributed by:** Foothills Property Management (foothills-pm)
**Agent name in source instance:** reni
**Template name:** agent-renewals-coordinator
**Date:** 2026-06-15

---

## 1. What It Does — End to End

### Role

The renewals coordinator is a persistent 24/7 AI agent specializing in residential lease renewal management. It operates as a **research and recommendation engine** — it pulls data, analyzes tenant history, prepares drafts and reports, and surfaces decisions for the property manager. It never sends external communications. All emails, offers, and notices to tenants or owners are sent by the PM after review.

### Trigger

The agent runs on a **4-hour heartbeat cron**. On each cycle it checks its task queue and advances any in-flight renewals. There are no external webhooks; it polls rather than subscribing to events.

### Workflow (Stage by Stage)

Renewals move through stages in LeadSimple. The agent tracks and advances each process:

#### Stage 1: Upcoming
Kicks off when a lease renewal process is opened in LeadSimple (typically 90 days before lease expiry).

Agent actions (autonomous):
- Pulls tenant history from LeadSimple: violations, late payments (last 12 months), partial evictions, NSF occurrences, complaints, Do Not Renew flag
- Confirms Section 8 status from AppFolio tenant tags and LeadSimple field `unit.unit_section8_tenant`
- Reviews pet/fee fields: monthly pet fee, utility fee, No-Pet Addendum requirement
- Runs CMA (comparative market analysis) using Rent Engine (browser automation) or Rentometer to set proposed rent
- Checks PetScreening status for each tenant (via browser automation on PetScreening.com or AppFolio tenant page links)
- Confirms key-on-file status from LeadSimple field `process.do_we_have_a_key_to_the_property`
- Prepares a per-tenant renewal packet: payment summary, violations summary, pet status, proposed rent, CMA rationale

Agent actions (escalated to PM):
- If no key is on file: creates a task for PM to contact tenant and arrange key access
- If Section 8: flags for Housing Authority rent increase approval before proceeding

#### Stage 2: Renewal Inspection Complete — Reviewing
Triggered after ZInspector inspection is completed (inspection is initiated by Zapier from Stage 1).

Agent actions (autonomous):
- Pulls inspection report from ZInspector API
- Cross-references inspection findings with tenant payment history, violations, NSF count, complaints, and Do Not Renew flag
- Formulates FPM renewal recommendation (Renew / Month-to-Month / Non-Renewal) with supporting rationale
- Documents final proposed rent in `process.new_rental_rate`
- Prepares draft "Owner Upcoming Lease Expiration Recommendation" email for PM review

Agent escalates to PM:
- Sends recommendation packet via Telegram for PM decision
- Waits for owner renewal choice, new rent amount, and offered lease length
- Routes to appropriate next stage based on PM decision

#### Stage 3: Preparing Renewal
Once PM has approved renewal direction.

Agent actions (autonomous):
- LBP (Lead-Based Paint) compliance check: queries AppFolio for `property.year_built` and `property.is_this_house_built_before1978`; if missing addendum, triggers Zapier LBP workflow
- HVAC filter review: if `property.hvac_filter_easily_changed_by_tenant` is false, flags for recurring work order setup
- Lease type check: if tenant is not on current FPM lease, flags for full lease replacement (not renewal addendum)
- Confirms pet screening is completed in PetScreening

Agent escalates to PM:
- Prepares lease renewal offer email draft for PM review; PM sends
- If pet screening incomplete, escalates to PM before proceeding

#### Stage 4: Waiting on Tenant Signature
After lease offer is sent via AppFolio.

Agent actions (autonomous):
- Tracks `process.lease_signed` field in LeadSimple
- Checks for tenant portal access issues (each tenant needs a unique email)
- Monitors signature deadlines; flags when within 8 days

Agent escalates to PM:
- If signature not received by deadline: notifies PM to escalate to Month-to-Month or Printed Lease path

#### Stage 5: Lease Signed
Agent prepares PM close-out checklist:
- Verify PM countersign
- Confirm recurring charges: new rent starts correct date, old rent ends day before
- Confirm RBP GL account, filter tags, insurance coverage expiration
- Update lease type and tenant tags in AppFolio
- Prepare CSAT and GetDandy email drafts (PM sends)

#### Non-Renewal / Month-to-Month Routes
- **Tenant chooses M2M:** Agent adds M2M admin charges in AppFolio (PM confirms); notifies owner via draft email
- **FPM/Owner chooses M2M:** No M2M admin charges; agent updates market rent and prepares tenant notification draft
- **Non-renewal / Move Out:** Agent prepares 30-day notice to vacate draft and move-out process trigger for PM

### Decisions Made Autonomously
- Tenant risk scoring (late payments, NSF, violations, inspection findings)
- CMA-based rent recommendation
- Non-renewal recommendation (when risk indicators cross thresholds)
- Pet screening gap identification
- LBP compliance check
- Signature deadline tracking and escalation timing

### Decisions Always Escalated to PM
- Final renewal rate and term approval
- Owner communication (agent prepares draft; PM sends)
- Tenant communication (agent prepares draft; PM sends)
- Any AppFolio record changes (charges, rent updates, lease dates)
- Month-to-Month vs. Non-Renewal direction when owner hasn't decided

---

## 2. AppFolio Endpoints

**Base URL:** `https://{your-subdomain}.appfolio.com/api/v1/`
**Auth:** HTTP Basic Auth — `client_id` as username, `client_secret` as password
**Env vars:** `APPFOLIO_CLIENT_ID`, `APPFOLIO_CLIENT_SECRET` (stored in org `secrets.env`)

| Endpoint | Method | What it reads | Notes |
|----------|--------|---------------|-------|
| `/api/v1/reports/delinquency.json` | GET | NSF count, late count, outstanding balance, last payment date, tenant status, tenant tags | No params needed; returns all tenants with payment history. Tenants with zero history (new, always current) may not appear. KEY for renewal risk scoring. |
| `/api/v1/reports/rent_roll.json` | GET | Current rent, market rent, lease start/end dates, tenant tags, bed count, bath count, sq ft, last/next rent increase | CRITICAL for renewals. Use this — not delinquency — for rent data. Returns all units. |
| `/api/v1/reports/cash_flow.json` | GET | Cash flow summary | Available but not primary for renewals workflow |
| `/api/v1/reports/balance_sheet.json` | GET | Balance sheet | Available but not primary for renewals workflow |

**Not working / not yet unlocked:**
- `/api/v1/tenant_receipts`, `/api/v1/outstanding_balances`, `/api/v1/leases`, `/api/v1/tenants`, `/api/v1/units`, `/api/v1/properties` — returned 400 or 404 in testing; either wrong path or requires additional AppFolio permissions from the PM.
- Service requests endpoint: returns 404; Maranda needs to grant API access before this is available.

**What is NOT accessed via REST (uses AppFolio UI instead):**
- Sending lease renewal offers — done by PM in AppFolio web UI
- Tracking tenant signature completion — done by PM in AppFolio web UI
- Adding recurring charges (new rent, RBP) — done by PM; agent prepares the checklist
- Updating market rent — done by PM; agent flags when update is needed

---

## 3. Other Integrations

### LeadSimple (Primary CRM)

**Base URL:** `https://api.leadsimple.com/rest`
**Auth:** `Authorization: Bearer {LEADSIMPLE_REST_API_KEY}`
**Env var:** `LEADSIMPLE_REST_API_KEY` (stored in org `secrets.env`)
**Swagger:** `https://api.leadsimple.com/rest/swagger_doc.json`

> **Note:** Do not confuse this with the Zapier-only key (`LEADSIMPLE_API_KEY` without `_REST_`). They use a different base path and the Zapier key will fail here.

| Endpoint | Method | What it reads/writes |
|----------|--------|----------------------|
| `/process_types/{id}/processes` | GET | All lease renewal processes for a given process type. Paginated; active (non-complete) processes appear on the last ~10 pages of ~74 total (records are oldest-first). |
| `/processes/{id}` | GET | Single process detail including all field values |
| `/process_types/{id}/stages` | GET | Stage definitions and UUIDs |
| `/contacts/{id}` | GET | Tenant contact details |
| `/properties/{id}` | GET | Property fields including Section 8 status, year built, LBP addendum status, HVAC |
| `/tasks` | GET | Open tasks associated with processes |
| `/notes` | GET/POST | Process notes (agent writes research summaries here for PM review) |
| `/processes/{id}` | PATCH | Update process field values (stage, recommendation fields, rent fields) |

**Key process type IDs (your instance will have different IDs — query `/process_types` to discover yours):**
- Lease Renewal: discovered by querying `GET /process_types` and matching by name
- Lease Violation: same
- Eviction: same

**Stage progression:** Upcoming → Renewal Inspection Complete Reviewing → Preparing Renewal → Waiting On Tenant Signature → Lease Signed → Complete

**Pagination pattern:** Use `page=` param starting from the last page (e.g., page 74) and scan backwards. No working server-side filter by stage was found in testing.

### ZInspector (Inspection Reports)

**Base URL:** `https://portfolio.zinspector.com/api/`
**Auth:** `x-api-key: {ZINSPECTOR_API_KEY_ENCODED}` header
**Env var:** `ZINSPECTOR_API_KEY_ENCODED` (stored in org `secrets.env`)

| Endpoint | Method | What it reads |
|----------|--------|---------------|
| `propertiesCursor` | GET | Property list with ZInspector IDs |
| `documents` | GET | Inspection reports (inspection records are found via the documents endpoint, not a dedicated inspections endpoint) |
| `contacts` | GET | Inspector/tenant contacts |
| `tasks` | GET | Open inspection tasks |
| `timeline` | GET | Property event timeline |

**Key usage:** Agent pulls the most recent inspection report for each property under renewal and extracts findings (items flagged, severity, photos) for the renewal recommendation.

### Property Meld (Maintenance Work Orders)

**Integration method:** Python CLI (`pm` command), installed locally from `~/projects/cli-anything-propertymeld/`
**Auth:** `PM_CLIENT_ID`, `PM_CLIENT_SECRET` env vars (Nexus API OAuth)
**Browser fallback:** Playwright / agent-browser for comment reads and tech assignment

| Command | Backend | What it does |
|---------|---------|--------------|
| `pm work-orders list --status open --json` | Nexus API | List open work orders with property, status, description |
| `pm work-orders get {id} --json` | Nexus API | Single work order detail |
| `pm work-orders comments {id} --json` | Browser (Playwright) | Read comments/notes on a work order |
| `pm properties list --json` | Nexus API | All properties with Meld IDs |
| `pm vendors list --json` | Nexus API | All vendors |
| `pm assign-tech --work-order-id {id} --tech {name} --json` | Browser (Playwright) | Assign a tech to a work order |
| `pm probe --json` | Nexus API | Verify credentials are working |

**Usage in renewals:** Property Meld is used to check for open maintenance issues at renewal properties that may affect inspection results or renewal decisions.

### Rent Engine (Market Rent Comparables)

**URL:** `https://app.rentengine.io`
**Auth:** JWT token in `RENT_ENGINE_API_KEY` env var (Supabase-style token, stored in org `secrets.env`)
**API status:** REST endpoints at `/rest/v1/` return 404 in testing. Use browser automation.
**Browser automation:** `agent-browser open https://app.rentengine.io` — navigate to the Intelligence section for market rent analysis and weekly owner marketing reports.

**Usage in renewals:** CMA for proposed rent increase. Also used for weekly owner marketing update reports (screenshot from Intelligence section pasted into LeadSimple Owner Email task).

### PetScreening

**URL:** `https://www.petscreening.com` (web) / `https://api.petscreening.com` (API)
**API auth:** API key required for Bearer token auth; stored web login credentials return 401 on API auth endpoint — a separate API key is needed.
**Integration method:** Browser automation (agent-browser) — log in via web, check tenant pet profiles by name/email.
**AppFolio shortcut:** On individual AppFolio tenant pages, PetScreening profile links are embedded.

**Usage in renewals:** Verify pet screening completion and profile status (Active / Expired / No Profile) for all renewing tenants before lease renewal is finalized. Flag expired or missing profiles to PM.

### Google Drive (Knowledge Sync)

**Integration:** `scripts/sync-drive.js` — Node.js script using Google Drive API v3
**Auth:** Google Service Account JSON key file (at `../../../secrets/google-drive-key.json` relative to scripts/; this path is org-specific and must be configured per instance)
**OAuth scope:** `https://www.googleapis.com/auth/drive.readonly`
**Folder:** Org's "Services" shared Drive folder (folder ID is org-specific; configure in the script)

**What it syncs:** Google Docs → exported as `.txt`, Sheets → `.csv`, binary files (PDFs, images) as-is. Output lands in `knowledge/drive/`.

**Post-sync:** Files are ingested into the agent's private KB collection:
```bash
cortextos bus kb-ingest knowledge/drive/ --org {org} --agent {agent} --scope private --collection private-{agent} --force
```

**Synced documents include:** Lease Renewal Process SOP, Lease Violation SOP, Lease Modification SOP, Weekly Owner Marketing Update SOP (examples from Foothills PM instance).

### Zapier (Workflow Automation)

No direct API calls. Zapier automations are triggered by LeadSimple stage transitions:
- **Inspection trigger:** When key-on-file is confirmed in Stage 1, triggers "Start Inspections Process and Add to Spreadsheet" Zap
- **LBP addendum trigger:** When property is pre-1978 and LBP addendum is missing in Stage 3, triggers Zapier LBP addendum workflow to request from owner

These Zaps are configured in the PM's Zapier account and are not managed by the agent.

### Boom (BoomPay)

Referenced in lease modification workflow for pet screening. No direct API integration. URL: `https://portal.boompay.app`

### ICM MCP Server

`.mcp.json` references `icm serve` — an MCP server installed locally. Used for additional tool integrations. Not documented further in this instance; check with your instance's MCP setup.

---

## 4. What Lives on the PM's Machine (Not in the Repo)

These must be reconstructed for any new instance. **Do not paste real values anywhere in the repo.**

### Credentials (all in secrets.env or agent .env)

| Item | Env var name | Where stored | Shape |
|------|-------------|--------------|-------|
| AppFolio API client ID | `APPFOLIO_CLIENT_ID` | `orgs/{org}/secrets.env` | Short alphanumeric string |
| AppFolio API client secret | `APPFOLIO_CLIENT_SECRET` | `orgs/{org}/secrets.env` | Long alphanumeric string |
| LeadSimple REST API key | `LEADSIMPLE_REST_API_KEY` | `orgs/{org}/secrets.env` | Bearer token string |
| ZInspector API key (encoded) | `ZINSPECTOR_API_KEY_ENCODED` | `orgs/{org}/secrets.env` | Base64-encoded API key |
| Rent Engine JWT | `RENT_ENGINE_API_KEY` | `orgs/{org}/secrets.env` | Supabase-style JWT |
| Property Meld client ID | `PM_CLIENT_ID` | `orgs/{org}/secrets.env` or agent `.env` | OAuth client ID |
| Property Meld client secret | `PM_CLIENT_SECRET` | `orgs/{org}/secrets.env` or agent `.env` | OAuth client secret |
| Telegram bot token | `BOT_TOKEN` | agent `.env` | Format: `{digits}:AA{alphanumeric}` — get from @BotFather |
| Telegram chat ID | `CHAT_ID` | agent `.env` | Numeric string — get via Telegram getUpdates |
| Telegram allowed user ID | `ALLOWED_USER` | agent `.env` | Numeric string — user's Telegram ID |

### Files Not in Repo

| File | Purpose | How to reconstruct |
|------|---------|-------------------|
| `secrets/google-drive-key.json` | Google Service Account key for Drive sync | Create a service account in Google Cloud Console, grant it read access to the shared Drive folder, download the JSON key |
| Property Meld CLI (`~/projects/cli-anything-propertymeld/`) | Local Python package for Meld API | Clone from the propertymeld CLI repo and `pip install -e .` |
| ICM MCP server | Additional tool integrations | Install per your MCP setup |
| PetScreening web session | Used for browser automation login | Use PM's PetScreening web credentials; stored in browser session, not in files |

### Logic Encoded in Memory / Instance State

| Item | Where it lives | Description |
|------|---------------|-------------|
| LeadSimple process type UUIDs | Agent `MEMORY.md` | UUIDs for Lease Renewal, Lease Violation, and Eviction process types. These are org-specific. Discover by querying `GET /process_types` with your API key. |
| LeadSimple stage UUIDs | Agent `MEMORY.md` | UUIDs for each renewal stage (Upcoming, Reviewing, Preparing Renewal, Waiting On Tenant Signature, etc.). Org-specific. Discover by querying `GET /process_types/{id}/stages`. |
| LeadSimple pagination pattern | Agent `MEMORY.md` | Active records appear on the last ~10 pages; complete records fill earlier pages. No working server-side stage filter found. Must scan from last page backwards. |
| Renewal decision thresholds | Agent `SOUL.md` and `GUARDRAILS.md` | Risk thresholds for non-renewal recommendations (e.g., 7+ late payments, 3+ NSF). Configurable per PM preference during onboarding. |
| AppFolio subdomain | Encoded in API calls | Format: `{company-subdomain}.appfolio.com`. Set as env var or configure in agent. |
| Google Drive folder ID | `scripts/sync-drive.js` | The specific shared Drive folder ID containing the PM's SOP documents. Get from the folder URL in Drive. |

### Prompt Logic in Skills / SOUL.md

The renewals workflow SOP is encoded in two places:
1. `knowledge/drive/` — plain-text exports of the PM's Google Drive SOP documents (synced per instance; see sync-drive.js)
2. `MEMORY.md` — learned workflow rules and API quirks discovered during live operation

These are the most important on-machine artifacts. The Drive sync script lets any new instance pull the PM's current SOPs directly. The MEMORY.md captures API behavior that is not in any documentation.

---

## 5. File Inventory

### Bootstrap Files (every agent)

| File | Purpose |
|------|---------|
| `AGENTS.md` | Session start protocol, task workflow, memory protocol, cron management |
| `CLAUDE.md` | First boot check, session start summary, key operational rules |
| `IDENTITY.md` | Agent name, role, emoji, vibe, work style |
| `SOUL.md` | Core principles: system-first mindset, task discipline, memory protocol, autonomy rules, day/night mode |
| `GUARDRAILS.md` | Red flag table — patterns that lead to skipped procedures, hard rules for no-external-comms |
| `HEARTBEAT.md` | 10-step heartbeat checklist (runs every 4h) |
| `GOALS.md` | Current goals, daily focus, bottleneck (auto-generated from goals.json) |
| `MEMORY.md` | Long-term memory: learned workflow patterns, API quirks, user preferences |
| `SYSTEM.md` | Org context: org name, timezone, orchestrator, dashboard URL, team roster |
| `TOOLS.md` | Quick reference for all cortextos bus commands |
| `USER.md` | About the PM: name, role, communication style, working hours, decision authority |
| `ONBOARDING.md` | First-boot interactive onboarding protocol |
| `config.json` | Agent config: model tier, heartbeat cron interval, day/night mode hours, approval rules |
| `goals.json` | Current goals in JSON (source of truth; GOALS.md is generated from this) |

### Agent-Specific Files

| File | Purpose |
|------|---------|
| `.env.example` | Template for required environment variables |
| `.gitignore` | Ignores .env, memory/, and secrets/ |
| `scripts/sync-drive.js` | Node.js script to sync PM's Google Drive SOP folder to `knowledge/drive/` |
| `knowledge/drive/` | Local copies of PM's SOP documents (synced from Drive; not committed) |
| `memory/` | Daily session journals — working memory between restarts (not committed) |
| `reports/` | Agent-produced renewal reports, pipeline status, pet screening reports |
| `experiments/` | Autoresearch experiment configs and learnings |
| `.claude/skills/propertymeld/SKILL.md` | Property Meld CLI reference (commands, auth, backend notes) |
| `.mcp.json` | MCP server configuration |

### Skills (inherited from agent template)

| Skill | Purpose |
|-------|---------|
| `comms/SKILL.md` | Telegram and agent-to-agent message handling |
| `tasks/SKILL.md` | Task creation, lifecycle, and KPI logging |
| `cron-management/SKILL.md` | Cron setup, persistence, troubleshooting |
| `knowledge-base/SKILL.md` | KB query and ingest |
| `approvals/SKILL.md` | Approval workflow |
| `agent-browser/SKILL.md` | Browser automation CLI reference |
| `human-tasks/SKILL.md` | Human task creation and escalation |
| `guardrails-reference/SKILL.md` | Full guardrail pattern table |

---

## Running This Agent on a New Instance

1. Copy `templates/agent-renewals-coordinator/` to `orgs/{your-org}/agents/{agent-name}/`
2. Create a Telegram bot via @BotFather and get a token
3. Fill in `agents/{agent-name}/.env` (BOT_TOKEN, CHAT_ID, ALLOWED_USER)
4. Add API credentials to `orgs/{your-org}/secrets.env` (see Section 4 table above)
5. Obtain Google Service Account key and place at `secrets/google-drive-key.json` (relative to repo root); update the path in `scripts/sync-drive.js`
6. Update the Drive folder ID in `scripts/sync-drive.js` to point to your SOP folder
7. Run `node scripts/sync-drive.js` to pull SOP documents into `knowledge/drive/`
8. Install Property Meld CLI if you use Property Meld: `pip install -e ~/projects/cli-anything-propertymeld/`
9. Enable the agent: `cortextos enable {agent-name}`
10. On first boot, the agent runs onboarding interactively via Telegram — follow the prompts
11. During onboarding, query LeadSimple `GET /process_types` to discover your process type and stage UUIDs, and save them to MEMORY.md

---

*Dossier produced by cortextOS master agent on behalf of Foothills Property Management.*
