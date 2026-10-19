import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Approval, ApprovalCategory, ApprovalStatus, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { parseEnvFile } from '../utils/env.js';
import { randomString } from '../utils/random.js';
import { validateApprovalCategory } from '../utils/validate.js';
import { redactSSN } from '../utils/ssn-redaction.js';
import { TelegramAPI } from '../telegram/api.js';
import { sendMessage } from './message.js';
import { postActivity } from './system.js';

/**
 * Build the inline keyboard posted to the activity channel alongside a
 * newly-created approval. Two buttons (Approve / Deny) with callback_data
 * keyed on the approval id so fast-checker's activity-channel callback
 * handler can route them to updateApproval.
 */
function buildApprovalKeyboard(approvalId: string): object {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `appr_allow_${approvalId}` },
      { text: '❌ Deny', callback_data: `appr_deny_${approvalId}` },
    ]],
  };
}

/**
 * Post a newly-created approval to the org's activity channel with
 * Approve/Deny inline buttons. Returns a promise that resolves once the
 * post attempt has settled.
 *
 * Path resolution: activity-channel.env lives under the FRAMEWORK root
 * (frameworkRoot/orgs/<org>/activity-channel.env), NOT the runtime state
 * dir (ctxRoot/orgs/<org>/). The earlier version of this helper used
 * paths.ctxRoot to derive orgDir, which silently resolved to the wrong
 * filesystem root and caused every activity-channel post to fail as
 * "not configured" — a bug that hid for hours because of the silent
 * .catch below. Fallback chain is now: explicit frameworkRoot arg →
 * process.env.CTX_FRAMEWORK_ROOT → SKIP WITH WARN (no further fallback;
 * the paths.ctxRoot fallback that caused the original bug was removed
 * deliberately per post-incident review — silently using a known-wrong
 * path is worse than skipping loudly).
 *
 * Errors from postActivity (thrown rejections) are suppressed so
 * activity-channel unreachability does not block approval creation. The
 * "not configured" signal (postActivity returns false) is now logged as
 * a visible warn — preserves the best-effort behavior but surfaces
 * misconfiguration immediately instead of debugging it silently.
 *
 * The returned promise MUST be awaited by the caller in short-lived
 * contexts (CLI action handlers) or the process may exit before the
 * underlying fetch completes and the post silently never sends.
 */
function postApprovalToActivityChannel(
  paths: BusPaths,
  org: string,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
  frameworkRoot: string | undefined,
): Promise<void> {
  const root = frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT;
  if (!root) {
    console.warn(
      `[approval] No frameworkRoot available for ${approvalId} — skipping activity-channel post. ` +
      `Set CTX_FRAMEWORK_ROOT env var or pass frameworkRoot explicitly.`,
    );
    return Promise.resolve();
  }

  const orgDir = join(root, 'orgs', org);
  const lines = [
    `🔔 Approval request: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  const message = lines.join('\n');

  return postActivity(orgDir, paths.ctxRoot, org, message, buildApprovalKeyboard(approvalId))
    .then((posted) => {
      if (!posted) {
        // postActivity returns false when activity-channel.env is missing
        // or cannot be parsed. Surface this visibly — the silent-false
        // pattern is what hid tonight's path-resolution bug for hours.
        console.warn(
          `[approval] Activity-channel post failed for ${approvalId} — ` +
          `check ${orgDir}/activity-channel.env (must define ACTIVITY_BOT_TOKEN + ACTIVITY_CHAT_ID).`,
        );
      }
    })
    .catch(() => undefined); // Thrown rejections still suppressed — activity-channel unreachable must not fail approval creation.
}

/**
 * Best-effort: ping the requesting agent's own Telegram chat (the operator's
 * 1:1 conversation with the agent's bot) when a new approval is created.
 * The activity-channel post handles "Approve / Deny" inline routing for the
 * operator-via-orchestrator UX, but operators on a per-agent bot would
 * otherwise miss approvals entirely — that's the source of the observed
 * 50h+ Repo-B-style stalls. This pings them on the bot they're actually
 * watching so they can hop to the orchestrator chat or dashboard to act.
 *
 * Reads BOT_TOKEN + CHAT_ID from `<agentDir>/.env`. Skips silently with a
 * single warn line when either is missing — approvals from a bot-less
 * agent (e.g. a hermes runtime, or pre-onboarding) must still succeed.
 *
 * Errors from the network round-trip are suppressed: a Telegram outage
 * must not block approval creation.
 */
function pingAgentChatId(
  agentDir: string | undefined,
  approvalId: string,
  title: string,
  category: ApprovalCategory,
  agentName: string,
  context: string | undefined,
): Promise<void> {
  if (!agentDir) {
    console.warn(
      `[approval] No agentDir available for ${approvalId} — skipping agent-bot Telegram ping.`,
    );
    return Promise.resolve();
  }
  const envPath = join(agentDir, '.env');
  if (!existsSync(envPath)) {
    return Promise.resolve();
  }
  const env = parseEnvFile(envPath);
  const botToken = env.BOT_TOKEN;
  const chatId = env.CHAT_ID;
  if (!botToken || !chatId) {
    console.warn(
      `[approval] BOT_TOKEN or CHAT_ID missing in ${envPath} — skipping agent-bot Telegram ping for ${approvalId}.`,
    );
    return Promise.resolve();
  }

  const lines = [
    `🔔 Approval needed: ${title}`,
    `Category: ${category}`,
    `Requested by: ${agentName}`,
  ];
  if (context) {
    lines.push('', context);
  }
  lines.push('', `id: ${approvalId}`);
  lines.push('', 'Approve via the orchestrator chat (Approve/Deny buttons) or the dashboard.');
  const message = lines.join('\n');

  const api = new TelegramAPI(botToken);
  return api.sendMessage(chatId, message, undefined, { parseMode: null })
    .then(() => undefined)
    .catch(() => undefined); // Telegram outage must not fail approval creation.
}

interface AppfolioCredentials {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/**
 * Resolve AppFolio REST credentials for the pre-auth-limit lookup below.
 * Checks process.env first (an agent session that already sourced its own
 * .env), then the calling agent's own `<agentDir>/.env`, then the org-level
 * `secrets.env` (shared across every agent in the org). The org-level
 * fallback is load-bearing: the agent that actually creates these
 * maintenance-WO approvals does not carry its own AppFolio REST credentials
 * in its agent .env (only the org secrets.env does), so without this
 * fallback the lookup would silently never resolve for the one caller this
 * feature exists for.
 *
 * Returns null (never throws) when anything is missing — the lookup is
 * best-effort and must not block approval creation.
 */
function resolveAppfolioCredentials(
  agentDir: string | undefined,
  frameworkRoot: string | undefined,
  org: string | undefined,
): AppfolioCredentials | null {
  const sources: Record<string, string>[] = [process.env as Record<string, string>];
  if (agentDir) {
    const envPath = join(agentDir, '.env');
    if (existsSync(envPath)) sources.push(parseEnvFile(envPath));
  }
  if (frameworkRoot && org) {
    const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
    if (existsSync(secretsPath)) sources.push(parseEnvFile(secretsPath));
  }

  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let baseUrl: string | undefined;
  for (const src of sources) {
    clientId = clientId || src.APPFOLIO_CLIENT_ID;
    clientSecret = clientSecret || src.APPFOLIO_CLIENT_SECRET;
    baseUrl = baseUrl || src.APPFOLIO_BASE_URL;
  }

  if (!clientId || !clientSecret || !baseUrl) return null;
  return { clientId, clientSecret, baseUrl: baseUrl.replace(/\/$/, '') };
}

/**
 * Look up one property's AppFolio MaintenanceLimit (the owner pre-auth
 * ceiling for repairs that do not require sign-off).
 *
 * `/api/v1/reports/property_directory.json` returns EVERY property in one
 * call (416 rows for this org, no pagination) — see
 * .claude/skills/appfolio-api/SKILL.md. Fetched fresh per call rather than
 * cached: approval creation is infrequent enough that one extra ~small
 * JSON fetch is cheap, and a cache would need invalidation reasoning this
 * does not need.
 *
 * Returns null on ANY failure (network, non-200, property not found,
 * unparseable value) — callers must treat null as "could not determine"
 * and fall back to the pre-existing sign-off-required default. Null must
 * never be read as "no limit", which would let an uncapped cost through.
 */
async function getPropertyMaintenanceLimit(
  propertyId: number,
  creds: AppfolioCredentials,
): Promise<number | null> {
  try {
    const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const res = await fetch(`${creds.baseUrl}/api/v1/reports/property_directory.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const row = data.results?.find((r) => r.PropertyId === propertyId);
    if (!row || typeof row.MaintenanceLimit !== 'string') return null;
    const limit = parseFloat(row.MaintenanceLimit.replace(/,/g, ''));
    return Number.isFinite(limit) ? limit : null;
  } catch {
    return null;
  }
}

/**
 * Create an approval request.
 * Identical to bash create-approval.sh format.
 *
 * Returns a Promise that resolves to the approval id AFTER the
 * activity-channel fan-out has settled. Callers in short-lived contexts
 * (CLI action handlers) MUST await — otherwise the process may exit before
 * the Telegram post completes and the post silently never sends.
 *
 * `frameworkRoot` (optional) is the filesystem root where
 * orgs/<org>/activity-channel.env lives. Without it the activity-channel
 * post is skipped with a warn — see postApprovalToActivityChannel for the
 * fallback chain (explicit arg → CTX_FRAMEWORK_ROOT env → skip). CLI call
 * sites should pass env.frameworkRoot explicitly; daemon-side callers
 * may rely on the env var.
 *
 * `cost` + `propertyId` (optional, added 2026-10-19): when BOTH are
 * provided, this looks up the property's AppFolio MaintenanceLimit and
 * records `cost`/`property_id`/`maintenance_limit`/`signoff_required` on
 * the approval (business rule confirmed by Maranda: signoff_required =
 * cost > property_pre_auth_limit). When `signoff_required` resolves to
 * false, the approval is written straight to resolved/ as auto-approved —
 * visible in approval history, but never enters the pending queue or
 * triggers the Telegram/activity-channel sign-off nudge, since no human
 * action is needed. ANY failure to resolve the limit (missing creds,
 * network error, unknown property) falls back to today's behavior
 * unchanged — full pending approval, sign-off required.
 */
export async function createApproval(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  category: ApprovalCategory,
  context?: string,
  frameworkRoot?: string,
  agentDir?: string,
  cost?: number,
  propertyId?: number,
): Promise<string> {
  validateApprovalCategory(category);

  // Scrub before persisting: the approval JSON is written to disk (a
  // never-STORE surface) and a title/context can carry connector data (e.g. a
  // draft with a tenant SSN). The Telegram fan-out is scrubbed at the
  // TelegramAPI primitive; the at-rest JSON must be scrubbed here.
  title = redactSSN(title);
  if (context !== undefined) context = redactSSN(context);

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const approvalId = `approval_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  let maintenanceLimit: number | undefined;
  let signoffRequired: boolean | undefined;
  if (cost !== undefined && propertyId !== undefined) {
    const creds = resolveAppfolioCredentials(agentDir, frameworkRoot, org);
    if (creds) {
      const limit = await getPropertyMaintenanceLimit(propertyId, creds);
      if (limit !== null) {
        maintenanceLimit = limit;
        signoffRequired = cost > limit;
      } else {
        console.warn(
          `[approval] Could not resolve MaintenanceLimit for property ${propertyId} (${approvalId}) — defaulting to sign-off required.`,
        );
      }
    } else {
      console.warn(
        `[approval] No AppFolio credentials available for pre-auth-limit lookup (${approvalId}) — defaulting to sign-off required.`,
      );
    }
  }

  const approval: Approval = {
    id: approvalId,
    title,
    requesting_agent: agentName,
    org,
    category,
    status: 'pending',
    description: context || '',
    created_at: now,
    updated_at: now,
    resolved_at: null,
    resolved_by: null,
    ...(cost !== undefined ? { cost } : {}),
    ...(propertyId !== undefined ? { property_id: propertyId } : {}),
    ...(maintenanceLimit !== undefined ? { maintenance_limit: maintenanceLimit } : {}),
    ...(signoffRequired !== undefined ? { signoff_required: signoffRequired } : {}),
  };

  if (signoffRequired === false) {
    // At or below the owner pre-auth limit: auto-resolve straight into
    // resolved/ rather than pending/. Still visible in approval history,
    // never shows up as a pending sign-off, never triggers the Telegram/
    // activity-channel nudge (no human action needed).
    approval.status = 'approved';
    approval.resolved_at = now;
    approval.resolved_by = `system:pre-auth-limit ($${cost} <= $${maintenanceLimit})`;

    const resolvedDir = join(paths.approvalDir, 'resolved');
    ensureDir(resolvedDir);
    atomicWriteSync(join(resolvedDir, `${approvalId}.json`), JSON.stringify(approval));

    // Notify the requesting agent the same way updateApproval does, so a
    // caller waiting on the approval-decision inbox message proceeds
    // immediately instead of waiting on a sign-off that will never come.
    const msg = `Approval decision: APPROVED\napproval_id: ${approvalId}\ndecision: approved\n Note: within property pre-auth limit ($${cost} <= $${maintenanceLimit}) — no sign-off required.`;
    sendMessage(paths, 'system', agentName, 'normal', msg);

    return approvalId;
  }

  const pendingDir = join(paths.approvalDir, 'pending');
  ensureDir(pendingDir);
  atomicWriteSync(join(pendingDir, `${approvalId}.json`), JSON.stringify(approval));

  // Fan-out to the activity channel so the operator can approve/deny from
  // Telegram without opening the dashboard. AWAITED so short-lived CLI callers do
  // not exit before the Telegram post fetch completes. Errors are
  // suppressed inside postApprovalToActivityChannel — activity-channel
  // unreachable must not block approval creation. Callbacks route back
  // via the orchestrator's activity-channel poller (see
  // daemon/agent-manager.ts).
  await postApprovalToActivityChannel(paths, org, approvalId, title, category, agentName, context, frameworkRoot);

  // Best-effort ping to the requesting agent's own Telegram bot (the
  // operator's 1:1 conversation with the agent). Closes the gap where
  // operators not in the activity channel would miss approvals entirely
  // (the 50h+ Repo-B-style stall). Errors suppressed — see helper.
  await pingAgentChatId(agentDir, approvalId, title, category, agentName, context);

  return approvalId;
}

/**
 * Update an approval's status (approve or deny).
 * Notifies the requesting agent via inbox message.
 */
export function updateApproval(
  paths: BusPaths,
  approvalId: string,
  status: ApprovalStatus,
  note?: string,
): void {
  // Scrub the resolution note before it is persisted into resolved_by (at-rest
  // JSON) and before it goes into the decision notification below. Sibling of
  // the createApproval title/context scrub.
  if (note !== undefined) note = redactSSN(note);
  const pendingDir = join(paths.approvalDir, 'pending');
  const filePath = join(pendingDir, `${approvalId}.json`);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const approval: Approval = JSON.parse(content);
    approval.status = status;
    approval.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    approval.resolved_at = approval.updated_at;
    approval.resolved_by = note || null;

    // Move to resolved/ directory (matches bash version)
    const destDir = join(paths.approvalDir, 'resolved');
    ensureDir(destDir);
    atomicWriteSync(join(destDir, `${approvalId}.json`), JSON.stringify(approval));

    // Remove from pending
    const { unlinkSync } = require('fs');
    unlinkSync(filePath);

    // Notify requesting agent via inbox
    if (approval.requesting_agent) {
      const noteText = note ? ` Note: ${note}` : '';
      const msg = `Approval decision: ${status.toUpperCase()}\napproval_id: ${approvalId}\ndecision: ${status}${noteText}`;
      sendMessage(paths, 'system', approval.requesting_agent, 'urgent', msg);
    }
  } catch (err) {
    throw new Error(`Approval ${approvalId} not found: ${err}`);
  }
}

/**
 * List pending approvals.
 */
export function listPendingApprovals(paths: BusPaths): Approval[] {
  const pendingDir = join(paths.approvalDir, 'pending');
  let files: string[];
  try {
    files = readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const approvals: Approval[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(pendingDir, file), 'utf-8');
      approvals.push(JSON.parse(content));
    } catch {
      // Skip corrupt
    }
  }

  return approvals.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}
