#!/usr/bin/env node
// Syncs a Google Shared Drive folder to local disk for the renewals agent's context.
// Usage: node sync-drive.js [--dry-run]
//
// Downloads all files from the configured folder, exports Google Docs/Sheets/Slides
// as plain text/CSV/text, and saves binary files (PDF, etc.) as-is.
// After syncing, prints the output path for kb-ingest.
//
// Setup:
//   1. Create a Google Service Account in Google Cloud Console
//   2. Grant it read access to your shared Drive folder (share the folder with the service account email)
//   3. Download the JSON key file and place it at the KEY_FILE path below
//   4. Set FOLDER_ID to your Drive folder ID (from the URL: drive.google.com/drive/folders/{FOLDER_ID})

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_FILE = path.resolve(__dirname, '../../../secrets/google-drive-key.json');
const OUTPUT_DIR = path.resolve(__dirname, '../knowledge/drive');
const FOLDER_ID = 'YOUR_GOOGLE_DRIVE_FOLDER_ID'; // Replace with your folder ID
const DRY_RUN = process.argv.includes('--dry-run');

const GDOC_EXPORT_MIME = {
  'application/vnd.google-apps.document':      'text/plain',
  'application/vnd.google-apps.spreadsheet':   'text/csv',
  'application/vnd.google-apps.presentation':  'text/plain',
  'application/vnd.google-apps.drawing':       'image/svg+xml',
};

const GDOC_EXTENSIONS = {
  'text/plain':    '.txt',
  'text/csv':      '.csv',
  'image/svg+xml': '.svg',
};

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function createJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  })));
  const input = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(input);
  return `${input}.${base64url(sign.sign(sa.private_key))}`;
}

async function getAccessToken(sa) {
  const jwt = createJWT(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function listFiles(token, folderId) {
  const params = new URLSearchParams({
    q:                       `'${folderId}' in parents and trashed = false`,
    supportsAllDrives:       'true',
    includeItemsFromAllDrives: 'true',
    fields:                  'nextPageToken,files(id,name,mimeType,modifiedTime,size)',
    pageSize:                '1000',
  });
  let files = [];
  let pageToken = null;
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.error) throw new Error(`List failed: ${JSON.stringify(data.error)}`);
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return files;
}

async function downloadFile(token, file, destDir) {
  const isGDoc = Object.hasOwn(GDOC_EXPORT_MIME, file.mimeType);
  const isGFolder = file.mimeType === 'application/vnd.google-apps.folder';

  if (isGFolder) {
    const subDir = path.join(destDir, sanitize(file.name));
    if (!DRY_RUN) fs.mkdirSync(subDir, { recursive: true });
    return { type: 'folder', path: subDir, file };
  }

  const exportMime = GDOC_EXPORT_MIME[file.mimeType];
  let url, ext;

  if (isGDoc && exportMime) {
    const params = new URLSearchParams({
      mimeType:         exportMime,
      supportsAllDrives: 'true',
    });
    url = `https://www.googleapis.com/drive/v3/files/${file.id}/export?${params}`;
    ext = GDOC_EXTENSIONS[exportMime] || '.txt';
  } else {
    if (file.mimeType.startsWith('application/vnd.google-apps.')) {
      return { type: 'skipped', reason: 'non-exportable Google type', file };
    }
    url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
    ext = path.extname(file.name) || '';
  }

  const baseName = sanitize(isGDoc ? file.name + ext : file.name);
  const destPath = path.join(destDir, baseName);

  if (DRY_RUN) {
    return { type: 'would-download', path: destPath, file };
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    return { type: 'error', reason: `HTTP ${res.status}: ${body.slice(0, 200)}`, file };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return { type: 'saved', path: destPath, bytes: buf.length, file };
}

async function syncFolder(token, folderId, destDir) {
  if (!DRY_RUN) fs.mkdirSync(destDir, { recursive: true });
  const files = await listFiles(token, folderId);
  const results = [];
  for (const file of files) {
    const result = await downloadFile(token, file, destDir);
    results.push(result);
    if (result.type === 'folder') {
      const sub = await syncFolder(token, file.id, result.path);
      results.push(...sub);
    }
  }
  return results;
}

function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 200);
}

async function main() {
  if (FOLDER_ID === 'YOUR_GOOGLE_DRIVE_FOLDER_ID') {
    console.error('ERROR: Set FOLDER_ID in this script to your Google Drive folder ID before running.');
    process.exit(1);
  }
  const sa = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  console.log(`Service account: ${sa.client_email}`);
  console.log(`Folder: ${FOLDER_ID}`);
  console.log(`Output: ${OUTPUT_DIR}`);
  if (DRY_RUN) console.log('[DRY RUN — no files will be written]');
  console.log('');

  const token = await getAccessToken(sa);
  console.log('Auth OK. Fetching file list...');

  const results = await syncFolder(token, FOLDER_ID, OUTPUT_DIR);

  let saved = 0, skipped = 0, errors = 0;
  for (const r of results) {
    if (r.type === 'saved')              { console.log(`  saved  ${r.path} (${r.bytes} bytes)`); saved++; }
    else if (r.type === 'would-download') { console.log(`  would  ${r.path}`); saved++; }
    else if (r.type === 'folder')        { /* already recursed */ }
    else if (r.type === 'skipped')       { console.log(`  skip   ${r.file.name} (${r.reason})`); skipped++; }
    else if (r.type === 'error')         { console.error(`  ERROR  ${r.file.name}: ${r.reason}`); errors++; }
  }

  console.log(`\nDone. ${saved} saved, ${skipped} skipped, ${errors} errors.`);
  if (!DRY_RUN && saved > 0) {
    console.log(`\nNext step — ingest to agent KB:`);
    console.log(`  cortextos bus kb-ingest ${OUTPUT_DIR} --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection private-$CTX_AGENT_NAME --force`);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
