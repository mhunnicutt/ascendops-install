#!/usr/bin/env node
/**
 * chat-listener.js — Google Chat Pub/Sub message listener
 *
 * Pulls messages from the Google Chat Pub/Sub subscription, routes them by
 * space to the owning agent's cortextos inbox, then ACKs. Designed to run on
 * a short cron interval.
 *
 * Usage: node scripts/chat-listener.js [--dry-run]
 *
 * Reads from: orgs/foothills-pm/secrets/google-drive-key.json
 * Routes to: SPACE_ROUTES[spaceId] inbox via `cortextos bus send-message`
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT = 'foothills-chat-bot';
const SUBSCRIPTION = 'chat-messages-sub';
const MAX_MESSAGES = 10;
const DRY_RUN = process.argv.includes('--dry-run');

// Resolve paths relative to this script
const FRAMEWORK_ROOT = path.resolve(__dirname, '..');
const KEY_FILE = path.join(FRAMEWORK_ROOT, 'orgs', 'foothills-pm', 'secrets', 'google-chat-bot-key.json');

function getAccessToken(keyData) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
      iss: keyData.client_email,
      scope: 'https://www.googleapis.com/auth/pubsub',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    })).toString('base64url');

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${claims}`);
    const sig = sign.sign(keyData.private_key, 'base64url');
    const jwt = `${header}.${claims}.${sig}`;

    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`;
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.access_token) {
          resolve(parsed.access_token);
        } else {
          reject(new Error(`Token exchange failed: ${JSON.stringify(parsed)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function pubsubRequest(method, subPath, token, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'pubsub.googleapis.com',
      path: `/v1/projects/${PROJECT}/subscriptions/${SUBSCRIPTION}${subPath}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data ? JSON.parse(data) : {});
        } else {
          reject(new Error(`Pub/Sub ${method} ${subPath} failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const MARANDA_CHAT_ID = '8799101497';

// Maps a Chat space to the agent whose inbox should receive its messages.
// The bot must be an installed member of a space before any event for it
// will ever reach Pub/Sub -- being missing from this map is not the only way
// routing can fail (see the 2026-08-05 Manny-space gap: the bot wasn't a
// space member at all, so no event was ever generated to route).
const SPACE_ROUTES = {
  'spaces/AAQAPnv0b9A': 'reni',        // Foothills space (Ashley renewals, etc.)
  'spaces/AAQAfGbaplo': 'maintenance', // Manny space
};
const DEFAULT_ROUTE = 'reni';

function routeMessage(sender, text, spaceId) {
  const targetAgent = SPACE_ROUTES[spaceId] || DEFAULT_ROUTE;
  if (!SPACE_ROUTES[spaceId]) {
    console.warn(`No route configured for ${spaceId}, defaulting to ${DEFAULT_ROUTE}`);
  }
  const msg = `[Google Chat from ${sender} in ${spaceId}]: ${text}`;
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would send to ${targetAgent}:`, msg);
    return;
  }
  // On Windows, bash scripts are unreliable — always use the Node.js CLI.
  const cli = path.join(FRAMEWORK_ROOT, 'dist', 'cli.js');
  // --skip-lint: this is a verbatim quote of an external Google Chat message, not
  // agent-authored text. Comms-lint's banned-jargon check was matching phrases inside
  // the quoted sender text and silently dropping the route (found 2026-08-05).
  execSync(`node "${cli}" bus send-message ${targetAgent} normal ${JSON.stringify(msg)} --skip-lint`, { stdio: 'inherit' });
  // Telegram ACK so Maranda knows the message landed. No agent name (comms-lint rule).
  const ack = `Got your Google Chat message -- routing it for follow-up.`;
  try {
    execSync(`node "${cli}" bus send-telegram ${MARANDA_CHAT_ID} ${JSON.stringify(ack)}`, { stdio: 'inherit' });
  } catch (err) {
    console.warn('Telegram ACK failed:', err.message);
  }
}

async function main() {
  if (!fs.existsSync(KEY_FILE)) {
    console.error(`Key file not found: ${KEY_FILE}`);
    process.exit(1);
  }

  const keyData = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));

  let token;
  try {
    token = await getAccessToken(keyData);
  } catch (err) {
    console.error('Failed to get access token:', err.message);
    process.exit(1);
  }

  // Pull messages
  let pullResult;
  try {
    pullResult = await pubsubRequest('POST', ':pull', token, { maxMessages: MAX_MESSAGES });
  } catch (err) {
    console.error('Pull failed:', err.message);
    process.exit(1);
  }

  const messages = pullResult.receivedMessages || [];
  if (messages.length === 0) {
    console.log('No messages.');
    return;
  }

  console.log(`Received ${messages.length} message(s).`);

  const ackIds = [];
  for (const received of messages) {
    const ackId = received.ackId;
    const rawData = received.message && received.message.data;

    if (!rawData) {
      console.warn('Message has no data, ACKing anyway.');
      ackIds.push(ackId);
      continue;
    }

    let event;
    try {
      event = JSON.parse(Buffer.from(rawData, 'base64').toString('utf8'));
    } catch (err) {
      console.warn('Failed to parse message data, ACKing:', err.message);
      ackIds.push(ackId);
      continue;
    }

    const eventType = event.type || 'UNKNOWN';

    if (eventType === 'MESSAGE') {
      const sender = (event.message && event.message.sender && event.message.sender.displayName) || 'Unknown';
      const text = (event.message && event.message.text) || '';
      const spaceId = (event.space && event.space.name) || 'unknown-space';

      console.log(`MESSAGE from ${sender}: ${text.substring(0, 80)}`);
      try {
        routeMessage(sender, text, spaceId);
      } catch (err) {
        console.error('Failed to route message:', err.message);
        // A routing failure otherwise vanishes silently (message is still ACK'd below
        // to avoid infinite redelivery) -- surface it so it doesn't require manual
        // discovery like the 2026-08-05 Ashley message did.
        try {
          const cli = path.join(FRAMEWORK_ROOT, 'dist', 'cli.js');
          const alert = `Chat listener failed to route a Google Chat message from ${sender} in ${spaceId}: ${err.message}`;
          execSync(`node "${cli}" bus send-message master normal ${JSON.stringify(alert)} --skip-lint`, { stdio: 'inherit' });
        } catch (escalateErr) {
          console.error('Failed to escalate routing failure to master:', escalateErr.message);
        }
      }
    } else if (eventType === 'ADDED_TO_SPACE') {
      const spaceName = (event.space && event.space.displayName) || 'unknown';
      console.log(`Bot added to space: ${spaceName}`);
    } else if (eventType === 'REMOVED_FROM_SPACE') {
      const spaceName = (event.space && event.space.displayName) || 'unknown';
      console.log(`Bot removed from space: ${spaceName}`);
    } else {
      console.log(`Event type ${eventType} — ACKing without routing.`);
    }

    ackIds.push(ackId);
  }

  // ACK all processed messages
  if (ackIds.length > 0) {
    try {
      await pubsubRequest('POST', ':acknowledge', token, { ackIds });
      console.log(`ACK'd ${ackIds.length} message(s).`);
    } catch (err) {
      console.error('ACK failed:', err.message);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
