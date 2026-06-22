#!/usr/bin/env node
/**
 * chat-listener.js — Google Chat Pub/Sub message listener
 *
 * Pulls messages from the Google Chat Pub/Sub subscription, routes them to
 * reni's cortextos inbox, then ACKs. Designed to run on a short cron interval.
 *
 * Usage: node scripts/chat-listener.js [--dry-run]
 *
 * Reads from: orgs/foothills-pm/secrets/google-drive-key.json
 * Routes to: reni inbox via `cortextos bus send-message`
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT = 'atomic-climate-457920-t5';
const SUBSCRIPTION = 'chat-messages-foothills-sub';
const MAX_MESSAGES = 10;
const DRY_RUN = process.argv.includes('--dry-run');

// Resolve paths relative to this script
const FRAMEWORK_ROOT = path.resolve(__dirname, '..');
const KEY_FILE = path.join(FRAMEWORK_ROOT, 'orgs', 'foothills-pm', 'secrets', 'google-drive-key.json');

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

function routeToReni(sender, text, spaceId) {
  const msg = `[Google Chat from ${sender} in ${spaceId}]: ${text}`;
  if (DRY_RUN) {
    console.log('[DRY RUN] Would send to reni:', msg);
    return;
  }
  // Find the bus send-message command
  const busCmd = path.join(FRAMEWORK_ROOT, 'bus', 'send-message.sh');
  if (fs.existsSync(busCmd)) {
    execSync(`bash "${busCmd}" reni normal ${JSON.stringify(msg)}`, { stdio: 'inherit' });
  } else {
    const cli = path.join(FRAMEWORK_ROOT, 'dist', 'cli.js');
    execSync(`node "${cli}" bus send-message reni normal ${JSON.stringify(msg)}`, { stdio: 'inherit' });
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
        routeToReni(sender, text, spaceId);
      } catch (err) {
        console.error('Failed to route to reni:', err.message);
        // Still ACK to avoid infinite redelivery of unroutable messages
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
