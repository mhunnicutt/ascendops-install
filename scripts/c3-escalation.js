#!/usr/bin/env node
/**
 * c3-escalation.js — Lease decision escalation cron
 *
 * Fires when a renewal decision has been pending in reni's inbox or task list
 * for more than 4 hours without a Maranda response. Sends a single-item
 * Telegram ping to Maranda.
 *
 * Detection: checks reni's pending tasks tagged as awaiting Maranda decision
 * that have been in_progress or pending for > THRESHOLD_HOURS.
 *
 * Usage: node scripts/c3-escalation.js [--dry-run]
 * Designed to run on a cron (every 2 hours during day mode).
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRAMEWORK_ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const THRESHOLD_HOURS = 4;
const STATE_FILE = path.join(FRAMEWORK_ROOT, 'orgs', 'foothills-pm', 'state', 'c3-last-alert.json');

// Day mode: 09:00 - 17:00 ET (14:00 - 22:00 UTC)
function isDayMode() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  return utcHour >= 14 && utcHour < 22;
}

function runBus(cmd) {
  try {
    const result = execSync(`node "${path.join(FRAMEWORK_ROOT, 'dist', 'cli.js')}" bus ${cmd}`, {
      cwd: FRAMEWORK_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CTX_AGENT_NAME: 'anna', CTX_ORG: 'foothills-pm' },
    });
    return result.trim();
  } catch (err) {
    return null;
  }
}

function loadLastAlertState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveLastAlertState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getPendingDecisionTasks() {
  // Get reni's pending tasks - look for tasks that indicate awaiting Maranda decision
  const raw = runBus('list-tasks --agent reni --status pending --json');
  if (!raw) return [];
  try {
    const tasks = JSON.parse(raw);
    const now = Date.now();
    const thresholdMs = THRESHOLD_HOURS * 60 * 60 * 1000;
    return tasks.filter(t => {
      const age = now - new Date(t.created_at || t.updated_at || 0).getTime();
      return age > thresholdMs;
    });
  } catch {
    return [];
  }
}

function getStaleReniTasks() {
  // Also check in_progress tasks that have been stuck
  const raw = runBus('list-tasks --agent reni --status in_progress --json');
  if (!raw) return [];
  try {
    const tasks = JSON.parse(raw);
    const now = Date.now();
    const thresholdMs = THRESHOLD_HOURS * 60 * 60 * 1000;
    // Filter tasks whose titles suggest they need Maranda input
    const decisionKeywords = ['direction', 'approval', 'pending', 'decision', 'approve', 'jennifer', 'kevin', 'renewal'];
    return tasks.filter(t => {
      const age = now - new Date(t.updated_at || t.created_at || 0).getTime();
      const title = (t.title || '').toLowerCase();
      const isDecisionTask = decisionKeywords.some(k => title.includes(k));
      return age > thresholdMs && isDecisionTask;
    });
  } catch {
    return [];
  }
}

function sendTelegramAlert(message) {
  const chatId = '8799101497';
  if (DRY_RUN) {
    console.log('[DRY RUN] Would send Telegram:', message);
    return;
  }
  const cli = path.join(FRAMEWORK_ROOT, 'dist', 'cli.js');
  execSync(`node "${cli}" bus send-telegram ${chatId} ${JSON.stringify(message)}`, {
    cwd: FRAMEWORK_ROOT,
    env: { ...process.env, CTX_AGENT_NAME: 'anna', CTX_ORG: 'foothills-pm' },
  });
}

async function main() {
  // Only run during day mode (09:00-17:00 ET)
  if (!isDayMode() && !DRY_RUN) {
    console.log('Night mode -- skipping escalation check.');
    return;
  }

  const pending = getPendingDecisionTasks();
  const stale = getStaleReniTasks();
  const allDecisionItems = [...pending, ...stale];

  if (allDecisionItems.length === 0) {
    console.log('No pending decisions over threshold.');
    return;
  }

  // Check cooldown -- don't re-alert within 4 hours
  const state = loadLastAlertState();
  const now = Date.now();
  if (state.last_alert_at && (now - state.last_alert_at) < THRESHOLD_HOURS * 60 * 60 * 1000) {
    console.log(`Alert cooldown active (last sent ${Math.round((now - state.last_alert_at) / 60000)}min ago).`);
    return;
  }

  // Build alert message -- single item, actionable
  const count = allDecisionItems.length;
  const sample = allDecisionItems[0];
  const title = sample ? (sample.title || 'renewal decision').substring(0, 60) : 'renewal decision';
  const ageHours = sample
    ? Math.round((now - new Date(sample.updated_at || sample.created_at || 0).getTime()) / 3600000)
    : THRESHOLD_HOURS;

  const message = count === 1
    ? `Renewal decision pending ${ageHours}h: ${title}. Reni needs your direction to proceed.`
    : `${count} renewal decisions pending over ${THRESHOLD_HOURS}h. Oldest: ${title}. Reni needs your direction.`;

  console.log(`Sending escalation alert: ${message}`);

  try {
    sendTelegramAlert(message);
    saveLastAlertState({ last_alert_at: now, item_count: count, sample_title: title });
    console.log('Alert sent and state saved.');
  } catch (err) {
    console.error('Failed to send alert:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
