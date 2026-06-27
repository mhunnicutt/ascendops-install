#!/usr/bin/env node
/**
 * chat-sender.js — Send a message to a Google Chat space
 *
 * Used by agents to reply IN Google Chat via the Chat REST API.
 * The service account must have the https://www.googleapis.com/auth/chat.bot scope
 * and must already be a member of the target space.
 *
 * Usage: node scripts/chat-sender.js <spaceId> "<message text>"
 *   spaceId: e.g. "spaces/AAQAPnv0b9A"
 *   message: the reply text (plain text or basic Markdown)
 *
 * Key file: orgs/foothills-pm/secrets/google-chat-bot-key.json
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FRAMEWORK_ROOT = path.resolve(__dirname, '..');
const KEY_FILE = path.join(FRAMEWORK_ROOT, 'orgs', 'foothills-pm', 'secrets', 'google-chat-bot-key.json');

const [,, spaceId, messageText] = process.argv;

if (!spaceId || !messageText) {
  console.error('Usage: node scripts/chat-sender.js <spaceId> "<message>"');
  console.error('  spaceId example: spaces/AAQAPnv0b9A');
  process.exit(1);
}

function getAccessToken(keyData) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({
      iss: keyData.client_email,
      // Chat API bot scope — service account acts as the bot, no user impersonation
      scope: 'https://www.googleapis.com/auth/chat.bot',
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

function sendChatMessage(spaceId, text, token) {
  return new Promise((resolve, reject) => {
    // Normalize: strip leading slash if present, ensure "spaces/..." format
    const normalizedSpace = spaceId.startsWith('/') ? spaceId.slice(1) : spaceId;
    const apiPath = `/v1/${normalizedSpace}/messages`;
    const body = JSON.stringify({ text });

    const options = {
      hostname: 'chat.googleapis.com',
      path: apiPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Chat API POST failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

  let result;
  try {
    result = await sendChatMessage(spaceId, messageText, token);
  } catch (err) {
    console.error('Failed to send Chat message:', err.message);
    process.exit(1);
  }

  console.log(`Message sent. ID: ${result.name}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
