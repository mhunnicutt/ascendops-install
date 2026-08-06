#!/usr/bin/env node
/**
 * chat-webhook-maintenance.mjs — Google Chat HTTP-endpoint webhook receiver
 *
 * Reconstruction (2026-08-06) -- the original source file was missing from disk
 * and never committed to git. Rebuilt from: nginx reverse-proxy config
 * (/etc/nginx/sites-enabled/foothillsmgmt.com, path /webhooks/manny-chat ->
 * localhost:8791), PM2 process metadata (port 8791, ES module), and observed
 * log lines from the still-running ghost process ("chat-webhook-maintenance
 * listening on port 8791", "Unhandled event type, payload keys: []",
 * "MESSAGE from <sender> in <space>: <text>"). This is a best-effort rebuild,
 * not a recovery of the literal original code -- test before trusting fully.
 *
 * Google Chat Apps configured for HTTP endpoint delivery POST the same event
 * JSON shape used by Pub/Sub delivery (see scripts/chat-listener.js), just
 * delivered directly as the request body instead of base64-encoded Pub/Sub
 * message data.
 *
 * Usage: node scripts/chat-webhook-maintenance.mjs
 * Public URL: https://foothillsmgmt.com/webhooks/manny-chat (nginx proxies to this port)
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import path from 'node:path';

const PORT = process.env.CHAT_WEBHOOK_PORT || 8791;
const FRAMEWORK_ROOT = '/home/ascend/ascendops';
const CLI = path.join(FRAMEWORK_ROOT, 'dist', 'cli.js');

// Maps a Chat space to the agent whose inbox should receive its messages.
const SPACE_ROUTES = {
  'spaces/AAQAfGbaplo': 'maintenance', // Manny space
};
const DEFAULT_ROUTE = 'maintenance';

function routeMessage(sender, text, spaceId) {
  const targetAgent = SPACE_ROUTES[spaceId] || DEFAULT_ROUTE;
  if (!SPACE_ROUTES[spaceId]) {
    console.warn(`No route configured for ${spaceId}, defaulting to ${DEFAULT_ROUTE}`);
  }
  const msg = `[Google Chat from ${sender} in ${spaceId}]: ${text}`;
  // --skip-lint: verbatim quote of external Chat text, not agent-authored --
  // same lesson as the 2026-08-05 reni-space comms-lint incident.
  execSync(`node "${CLI}" bus send-message ${targetAgent} normal ${JSON.stringify(msg)} --skip-lint`, { stdio: 'inherit' });
}

function escalateFailure(sender, spaceId, errMessage) {
  try {
    const alert = `Chat webhook failed to route a message from ${sender} in ${spaceId}: ${errMessage}`;
    execSync(`node "${CLI}" bus send-message master normal ${JSON.stringify(alert)} --skip-lint`, { stdio: 'inherit' });
  } catch (escalateErr) {
    console.error('Failed to escalate routing failure to master:', escalateErr.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let event;
    try {
      event = JSON.parse(body || '{}');
    } catch (err) {
      console.warn('Failed to parse webhook payload:', err.message);
      // Still 200 -- a malformed/unparseable payload should not trigger Google's retry storm.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }

    const eventType = event.type || 'UNKNOWN';

    if (eventType === 'MESSAGE') {
      const sender = event.message?.sender?.displayName || 'Unknown';
      const text = event.message?.text || '';
      const spaceId = event.space?.name || 'unknown-space';

      console.log(`MESSAGE from ${sender} in ${spaceId}: ${text.substring(0, 80)}`);
      try {
        routeMessage(sender, text, spaceId);
      } catch (err) {
        console.error('Failed to route message:', err.message);
        escalateFailure(sender, spaceId, err.message);
      }
    } else if (eventType === 'ADDED_TO_SPACE') {
      console.log(`Bot added to space: ${event.space?.displayName || 'unknown'}`);
    } else if (eventType === 'REMOVED_FROM_SPACE') {
      console.log(`Bot removed from space: ${event.space?.displayName || 'unknown'}`);
    } else {
      console.log('Unhandled event type, payload keys:', Object.keys(event));
    }

    // Google Chat HTTP endpoint apps expect a synchronous JSON response.
    // Empty object = acknowledge, no reply message posted back automatically.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  });
});

server.listen(PORT, () => {
  console.log(`chat-webhook-maintenance listening on port ${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
