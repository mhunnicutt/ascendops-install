#!/usr/bin/env node
/**
 * ask-queue.js — One-ask-at-a-time queue for Maranda activation/approval asks.
 *
 * Rules:
 * - Only one outbound ask to Maranda active at a time.
 * - If an ask is unanswered and < STALE_HOURS old, new asks are skipped (logged, not sent).
 * - If an ask is unanswered and >= STALE_HOURS old, flag to master (once) and hold.
 * - Maranda's replies mark the current ask resolved via mark-replied.
 *
 * This queue applies to ACTIVATION and APPROVAL asks only.
 * Operational alerts (RAM, stale renewals) bypass this queue and use their own cooldowns.
 *
 * Usage:
 *   node scripts/ask-queue.js can-send               -- exits 0 if queue is clear, 1 if blocked
 *   node scripts/ask-queue.js enqueue <id> <content> -- add ask to queue (call before send-telegram)
 *   node scripts/ask-queue.js mark-replied <id>      -- mark ask answered (call when Maranda replies)
 *   node scripts/ask-queue.js check-stale            -- flag stale asks to master (call from heartbeat)
 *   node scripts/ask-queue.js status                 -- print current queue state
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FRAMEWORK_ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE = path.join(FRAMEWORK_ROOT, 'orgs', 'foothills-pm', 'state', 'maranda-ask-queue.json');
const STALE_HOURS = 4;
const STALE_MS = STALE_HOURS * 60 * 60 * 1000;

function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return { current_ask: null, history: [] };
  }
}

function saveQueue(q) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
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
  } catch {
    return null;
  }
}

const [,, command, ...args] = process.argv;

switch (command) {
  case 'can-send': {
    const q = loadQueue();
    if (!q.current_ask) {
      console.log('CLEAR');
      process.exit(0);
    }
    const age = Date.now() - new Date(q.current_ask.sent_at).getTime();
    if (age < STALE_MS) {
      const ageMin = Math.round(age / 60000);
      console.log(`BLOCKED — "${q.current_ask.id}" sent ${ageMin}min ago, unanswered. Wait for reply or ${STALE_HOURS}h timeout.`);
      process.exit(1);
    }
    // Past stale threshold — queue is stuck but not cleared. Still blocked until master intervenes.
    const ageH = Math.round(age / 3600000);
    console.log(`STALE — "${q.current_ask.id}" sent ${ageH}h ago, no reply. Master has been notified. Queue blocked until resolved.`);
    process.exit(1);
  }

  case 'enqueue': {
    const [id, ...contentParts] = args;
    const content = contentParts.join(' ');
    if (!id || !content) {
      console.error('Usage: ask-queue.js enqueue <id> <content>');
      process.exit(1);
    }
    const q = loadQueue();
    if (q.current_ask) {
      const age = Date.now() - new Date(q.current_ask.sent_at).getTime();
      const ageMin = Math.round(age / 60000);
      console.log(`SKIP — queue occupied by "${q.current_ask.id}" (sent ${ageMin}min ago, unanswered). Enqueue aborted.`);
      process.exit(1);
    }
    q.current_ask = {
      id,
      content,
      sent_at: new Date().toISOString(),
      flagged_to_master: false,
    };
    saveQueue(q);
    console.log(`ENQUEUED — "${id}"`);
    process.exit(0);
  }

  case 'mark-replied': {
    const [id] = args;
    const q = loadQueue();
    if (!q.current_ask) {
      console.log('No active ask to mark replied.');
      process.exit(0);
    }
    if (id && q.current_ask.id !== id) {
      console.log(`Active ask is "${q.current_ask.id}", not "${id}". No change.`);
      process.exit(1);
    }
    const resolved = { ...q.current_ask, replied_at: new Date().toISOString() };
    q.history = [resolved, ...(q.history || [])].slice(0, 20);
    q.current_ask = null;
    saveQueue(q);
    console.log(`RESOLVED — "${resolved.id}" marked replied.`);
    process.exit(0);
  }

  case 'check-stale': {
    const q = loadQueue();
    if (!q.current_ask) {
      console.log('No active ask. Queue clear.');
      process.exit(0);
    }
    const age = Date.now() - new Date(q.current_ask.sent_at).getTime();
    if (age < STALE_MS) {
      const ageMin = Math.round(age / 60000);
      console.log(`Active ask "${q.current_ask.id}" is ${ageMin}min old. Not yet stale.`);
      process.exit(0);
    }
    if (q.current_ask.flagged_to_master) {
      const ageH = Math.round(age / 3600000);
      console.log(`Ask "${q.current_ask.id}" stale (${ageH}h) — already flagged to master. No repeat.`);
      process.exit(0);
    }
    // Flag to master once
    const ageH = Math.round(age / 3600000);
    const msg = `Ask queue stale: "${q.current_ask.id}" sent ${ageH}h ago with no reply from Maranda. Queue is blocked. Your call on whether to nudge or hold.`;
    runBus(`send-message master normal ${JSON.stringify(msg)}`);
    q.current_ask.flagged_to_master = true;
    saveQueue(q);
    console.log(`FLAGGED — master notified about stale ask "${q.current_ask.id}".`);
    process.exit(0);
  }

  case 'status': {
    const q = loadQueue();
    if (!q.current_ask) {
      console.log('Queue: CLEAR');
    } else {
      const age = Date.now() - new Date(q.current_ask.sent_at).getTime();
      const ageMin = Math.round(age / 60000);
      const stale = age >= STALE_MS ? ' [STALE]' : '';
      const flagged = q.current_ask.flagged_to_master ? ' [flagged to master]' : '';
      console.log(`Queue: OCCUPIED${stale}${flagged}`);
      console.log(`  Ask ID : ${q.current_ask.id}`);
      console.log(`  Sent   : ${q.current_ask.sent_at} (${ageMin}min ago)`);
      console.log(`  Content: ${q.current_ask.content}`);
    }
    if (q.history && q.history.length > 0) {
      console.log(`History: ${q.history.length} resolved asks`);
      q.history.slice(0, 3).forEach(h => {
        console.log(`  [${h.id}] sent ${h.sent_at}, replied ${h.replied_at}`);
      });
    }
    process.exit(0);
  }

  default:
    console.error('Usage: ask-queue.js <can-send|enqueue|mark-replied|check-stale|status>');
    process.exit(1);
}
