'use strict';

require('dotenv').config();

const { Client, RemoteAuth, MessageMedia, Location } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_NAME = process.env.SESSION_NAME || 'whatsapp-bot';
const PORT = parseInt(process.env.PORT || '8000', 10);
const API_KEY = process.env.API_KEY || 'changeme';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const IS_PROD = !!process.env.PUPPETEER_EXECUTABLE_PATH;

const MAX_MEDIA_WEBHOOK_BYTES = 5 * 1024 * 1024;
const MAX_WEBHOOK_ATTEMPTS = 3;
const BACKUP_INTERVAL = IS_PROD ? 5 * 60 * 1000 : 60 * 1000;
const DATA_PATH = path.resolve('/app/.wwebjs_auth');
// Use /tmp for Chrome data — always writable, survives Chrome restarts within
// the same container lifetime, and avoids permission issues on Koyeb.
const CHROME_DATA_DIR = path.resolve('/tmp/.chrome-data');
const SESSION_DIR_NAME = `RemoteAuth-${SESSION_NAME}`;

// ─── Startup validation ───────────────────────────────────────────────────────
if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set!');
    process.exit(1);
}
if (API_KEY === 'changeme') {
    console.warn('⚠️  API_KEY is using the default value — set a strong key!');
}

console.log(`🌍 Environment  : ${IS_PROD ? 'Production (Docker/Koyeb)' : 'Development (Local)'}`);
console.log(`📛 Session name : ${SESSION_NAME}`);
console.log(`⏱️  Backup every : ${BACKUP_INTERVAL / 1000}s`);
console.log(`🔑 API Key      : ${API_KEY === 'changeme' ? '⚠️  DEFAULT' : '✅ Set'}`);
console.log(`🪝 Webhook URL  : ${WEBHOOK_URL || '❌ Not set'}`);
console.log(`🌐 Port         : ${PORT}`);

// ─── Puppeteer config ─────────────────────────────────────────────────────────
//
// KEY FIXES vs previous version:
//
// 1. REMOVED --single-process
//    This flag caused Chrome's network/renderer to crash exactly during the
//    WhatsApp WebSocket key-exchange that happens after QR scan. The crash is
//    silent: the phone shows success but the server never fires 'authenticated'.
//
// 2. REMOVED --disable-background-networking
//    WhatsApp Web uses a persistent WebSocket for the post-scan handshake.
//    Chrome classifies this as "background networking" and the flag was killing
//    it, preventing the 'authenticated' event from ever firing.
//
// 3. CHROME_DATA_DIR moved to /tmp/.chrome-data
//    /app/.chrome-data was inside the image layer and got wiped on every Koyeb
//    reschedule/restart. /tmp is always writable and survives within a container
//    lifetime, which is all we need (MongoDB RemoteAuth handles cross-restart
//    session persistence via GridFS).
//
// 4. protocolTimeout increased to 120000
//    On Koyeb's shared infra the post-scan key exchange + initial data load can
//    exceed 60s. A 60s protocolTimeout caused Puppeteer to tear down the session
//    silently — the phone thought it worked but the server got nothing.
//
const puppeteerArgs = IS_PROD ? [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    // Persistent user-data-dir within container lifetime: helps Chrome persist
    // WebSocket state across the post-scan handshake steps.
    `--user-data-dir=${CHROME_DATA_DIR}`,
    // Limit renderers to avoid OOM on low-memory Koyeb instances.
    // NOTE: --single-process removed — it crashes Chrome's WS during QR auth.
    '--renderer-process-limit=2',
    // Certificate / network fixes
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
    '--ignore-ssl-errors',
    '--disable-features=CertificateTransparencyEnforcement,IsolateOrigins,site-per-process',
    // Disable noisy extras — but NOT background-networking (WA needs it)
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--disable-web-security',
    '--allow-running-insecure-content',
    '--metrics-recording-only',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
    '--disable-breakpad',
    `--crash-dumps-dir=/tmp/chrome-crashes`,
] : [
    '--no-sandbox',
    '--disable-setuid-sandbox',
];

const puppeteerConfig = IS_PROD
    ? {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: true,
        args: puppeteerArgs,
        timeout: 120000,
        // Increased from 60000 — post-scan key exchange can take >60s on Koyeb
        protocolTimeout: 120000,
    }
    : {
        headless: false,
        args: puppeteerArgs,
        timeout: 60000,
    };

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── Module-scope state ───────────────────────────────────────────────────────
let botStatus = 'starting';
let waClient = null;
let sessionSavedAt = null;
let isStarting = false;
let isReady = false;
let qrData = null;
let currentClient = null;
let readyWatchdog = null;
const startTime = Date.now();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatUptime(s) {
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${Math.floor(s % 60)}s`;
}
function formatTime(d) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function normalizePhone(phone) {
    if (typeof phone === 'string' && (phone.endsWith('@c.us') || phone.endsWith('@g.us'))) return phone;
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
    return `${cleaned}@c.us`;
}
function withTimeout(promise, ms = 30000, label = 'Operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
    ]);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== API_KEY) return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    next();
}
function requireReady(req, res, next) {
    if (botStatus !== 'ready' || !waClient) return res.status(503).json({ success: false, error: `Bot not ready (status: ${botStatus})` });
    next();
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
async function fireWebhook(payload, attempt = 1) {
    if (!WEBHOOK_URL) return;
    try {
        const body = JSON.stringify(payload);
        const url = new URL(WEBHOOK_URL);
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(WEBHOOK_SECRET ? { 'X-Webhook-Secret': WEBHOOK_SECRET } : {}),
            },
            timeout: 10000,
        };
        await new Promise((resolve, reject) => {
            const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
                console.log(`🪝 Webhook → ${res.statusCode} (attempt ${attempt}/${MAX_WEBHOOK_ATTEMPTS})`);
                res.resume();
                resolve();
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(body);
            req.end();
        });
    } catch (e) {
        if (attempt < MAX_WEBHOOK_ATTEMPTS) {
            console.warn(`🪝 Webhook failed [${attempt}/${MAX_WEBHOOK_ATTEMPTS}]: ${e.message} — retrying in 5s`);
            setTimeout(() => fireWebhook(payload, attempt + 1), 5000);
        } else {
            console.error(`🪝 Webhook dropped after ${MAX_WEBHOOK_ATTEMPTS} attempts: ${e.message}`);
        }
    }
}

// ─── Local cache cleanup ──────────────────────────────────────────────────────
function clearLocalCache() {
    [
        path.join(DATA_PATH, SESSION_DIR_NAME),
        path.join(DATA_PATH, `wwebjs_temp_session_${SESSION_NAME}`),
    ].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log(`🧹 Cleared: ${path.basename(dir)}`);
        }
    });
}

// ─── Fixed MongoStore ─────────────────────────────────────────────────────────
function createFixedStore(mongooseInstance) {
    const MAX_BACKUPS = 3;

    function getBucket(sessionName) {
        return new mongooseInstance.mongo.GridFSBucket(
            mongooseInstance.connection.db,
            { bucketName: `whatsapp-${sessionName}` }
        );
    }

    return {
        async sessionExists(options) {
            const sessionName = path.basename(options.session);
            const col = mongooseInstance.connection.db.collection(`whatsapp-${sessionName}.files`);
            const count = await col.countDocuments(
                { filename: { $regex: `^${sessionName}\\.zip\\.` } },
                { limit: 1 }
            );
            return count > 0;
        },

        async save(options) {
            const sessionName = path.basename(options.session);
            const zipPath = path.join(DATA_PATH, `${sessionName}.zip`);
            if (!fs.existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`);
            const size = fs.statSync(zipPath).size;
            if (size < 1000) throw new Error(`Zip too small (${size} bytes)`);
            console.log(`💾 Uploading: ${sessionName}.zip (${(size / 1024).toFixed(1)} KB)`);
            const bucket = getBucket(sessionName);
            const slotName = `${sessionName}.zip.${Date.now()}`;
            await new Promise((resolve, reject) => {
                fs.createReadStream(zipPath)
                    .pipe(bucket.openUploadStream(slotName))
                    .on('error', reject)
                    .on('close', resolve);
            });
            const allDocs = await bucket.find({}).toArray();
            const slots = allDocs.filter(d => d.filename.startsWith(`${sessionName}.zip.`)).sort((a, b) => a.uploadDate - b.uploadDate);
            const toDelete = slots.slice(0, Math.max(0, slots.length - MAX_BACKUPS));
            for (const doc of toDelete) await bucket.delete(doc._id);
            console.log(`✅ MongoDB upload done (${slots.length - toDelete.length}/${MAX_BACKUPS} slots) @ ${formatTime(new Date())}`);
            try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        },

        async extract(options) {
            const sessionName = path.basename(options.session);
            const zipPath = options.path;
            const bucket = getBucket(sessionName);
            const allDocs = await bucket.find({}).toArray();
            const slots = allDocs.filter(d => d.filename.startsWith(`${sessionName}.zip.`)).sort((a, b) => b.uploadDate - a.uploadDate);
            if (slots.length === 0) throw new Error('No backup slots found in MongoDB');
            console.log(`📦 Found ${slots.length} backup slot(s)`);
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                console.log(`📦 Trying slot ${i + 1}/${slots.length}: ${slot.filename} (${(slot.length / 1024).toFixed(1)} KB)`);
                if (slot.length < 1000) { console.warn(`⚠️  Slot ${i + 1} too small — skipping`); continue; }
                try {
                    await new Promise((resolve, reject) => {
                        bucket.openDownloadStreamByName(slot.filename)
                            .pipe(fs.createWriteStream(zipPath))
                            .on('error', reject)
                            .on('close', resolve);
                    });
                    const downloaded = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
                    if (downloaded < 1000) { console.warn(`⚠️  Slot ${i + 1} empty — skipping`); continue; }
                    console.log(`✅ Restored from slot ${i + 1}: ${(downloaded / 1024).toFixed(1)} KB`);
                    return;
                } catch (err) {
                    console.warn(`⚠️  Slot ${i + 1} failed: ${err.message}`);
                }
            }
            throw new Error('All backup slots failed');
        },

        async delete(options) {
            const sessionName = path.basename(options.session);
            const bucket = getBucket(sessionName);
            const docs = await bucket.find({}).toArray();
            for (const doc of docs) await bucket.delete(doc._id);
            console.log(`🗑️  Deleted ${docs.length} slot(s): ${sessionName}`);
        },
    };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const emoji = { starting: '⏳', qr_ready: '📱', authenticated: '🔐', ready: '✅', disconnected: '❌' }[botStatus] || '❓';
    const hints = {
        qr_ready: '📋 Scan QR code di bawah ini menggunakan WhatsApp Anda.',
        ready: '🟢 Bot is online and ready to send/receive messages.',
        disconnected: '🔴 Lost connection — reconnecting automatically...',
        starting: '🔵 Starting up, please wait...',
        authenticated: '🔐 Authenticated — loading WhatsApp session...',
    };
    let qrHtml = '';
    if (botStatus === 'qr_ready' && qrData) {
        qrHtml = `
            <div style="margin:25px 0;padding:20px;border:2px dashed #cbd5e1;border-radius:12px;background:#f8fafc;">
                <p style="margin-bottom:15px;font-weight:bold;color:#334155;">Scan QR Code:</p>
                <img src="/api/qr" alt="QR Code"
                     style="width:250px;height:250px;border:10px solid white;box-shadow:0 4px 12px rgba(0,0,0,0.1);border-radius:8px;"
                     onerror="this.style.display='none';document.getElementById('qrerr').style.display='block'" />
                <p id="qrerr" style="display:none;color:#dc2626;margin-top:10px;">
                    QR image failed — run: <code>npm install qrcode</code>
                </p>
                <p style="margin-top:15px;font-size:0.8rem;color:#64748b;">
                    Auto-refreshes every 10s. Or open <a href="/api/qr">/api/qr</a> directly.
                </p>
            </div>`;
    }
    res.send(`<!DOCTYPE html><html lang="en"><head><title>WhatsApp Bot</title><meta http-equiv="refresh" content="10"><meta charset="UTF-8">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:white;border-radius:16px;padding:40px;max-width:600px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{color:#111;font-size:1.4rem;margin-bottom:24px}.si{font-size:3.5rem;margin:16px 0}.badge{padding:8px 20px;border-radius:100px;display:inline-block;font-weight:600;font-size:.85rem;text-transform:uppercase}.ready{background:#dcfce7;color:#166534}.qr_ready{background:#fef9c3;color:#854d0e}.starting,.authenticated{background:#dbeafe;color:#1e40af}.disconnected{background:#fee2e2;color:#991b1b}.hint{margin-top:16px;color:#6b7280;font-size:.9rem;line-height:1.6}.meta{margin-top:24px;padding-top:24px;border-top:1px solid #f0f0f0;display:flex;justify-content:space-around;flex-wrap:wrap;gap:12px}.mi{font-size:.8rem;color:#9ca3af}.mi strong{display:block;color:#374151;font-size:.9rem;margin-bottom:2px}.api{margin-top:24px;padding-top:24px;border-top:1px solid #f0f0f0;text-align:left;font-size:.8rem;color:#6b7280;line-height:2}.api code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:.75rem}</style></head>
    <body><div class="card">
    <h1>🤖 WhatsApp Bot APIv2</h1>
    <div class="si">${emoji}</div>
    <div class="badge ${botStatus}">${botStatus.replace('_', ' ')}</div>
    <p class="hint">${hints[botStatus] || ''}</p>
    ${qrHtml}
    <div class="meta">
      <div class="mi"><strong>${SESSION_NAME}</strong>Session</div>
      <div class="mi"><strong>${formatUptime((Date.now() - startTime) / 1000)}</strong>Uptime</div>
      <div class="mi"><strong>${IS_PROD ? 'Production' : 'Development'}</strong>Env</div>
      <div class="mi"><strong>${sessionSavedAt || 'Pending...'}</strong>Last Backup</div>
      <div class="mi"><strong>${WEBHOOK_URL ? '✅ Set' : '❌ Not set'}</strong>Webhook</div>
    </div>
    <div class="api">
      <strong>API Endpoints</strong> — Header: <code>x-api-key: YOUR_KEY</code><br><br>
      <code>GET  /api/health</code>         — Health check (no auth)<br>
      <code>GET  /api/qr</code>             — QR code PNG (no auth)<br>
      <code>GET  /api/status</code>         — Bot status<br>
      <code>POST /api/send/text</code>      — Send text message<br>
      <code>POST /api/send/image</code>     — Send image<br>
      <code>POST /api/send/file</code>      — Send file/document<br>
      <code>POST /api/send/audio</code>     — Send audio / voice note<br>
      <code>POST /api/send/location</code>  — Send location pin<br>
    </div>
    </div></body></html>`);
});

// QR image — served locally (no external calls needed)
let QRCode = null;
try { QRCode = require('qrcode'); } catch {
    console.warn('⚠️  "qrcode" package not found. Run: npm install qrcode');
}
app.get('/api/qr', async (req, res) => {
    if (!qrData) return res.status(404).json({ success: false, error: 'No QR available' });
    if (!QRCode) return res.redirect(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrData)}`);
    try {
        const png = await QRCode.toBuffer(qrData, { type: 'png', width: 300, margin: 2 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(png);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/health', (req, res) => res.status(200).json({ success: true, status: botStatus, uptime: formatUptime((Date.now() - startTime) / 1000) }));
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/_health', (req, res) => res.status(200).send('ok'));

app.get('/api/status', requireApiKey, (req, res) => {
    res.json({ success: true, status: botStatus, session: SESSION_NAME, environment: IS_PROD ? 'production' : 'development', uptime: formatUptime((Date.now() - startTime) / 1000), lastBackup: sessionSavedAt, webhookConfigured: !!WEBHOOK_URL });
});

app.post('/api/send/text', requireApiKey, requireReady, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: 'Missing: to, message' });
    try {
        const chatId = normalizePhone(to);
        const sent = await withTimeout(waClient.sendMessage(chatId, message), 30000, 'sendMessage');
        console.log(`📤 Text → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send text error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/image', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url ? await MessageMedia.fromUrl(url, { unsafeMime: true }) : new MessageMedia(mime || 'image/jpeg', base64, filename || 'image.jpg');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { caption: caption || '' }), 30000, 'sendImage');
        console.log(`📤 Image → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send image error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/file', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url ? await MessageMedia.fromUrl(url, { unsafeMime: true }) : new MessageMedia(mime || 'application/octet-stream', base64, filename || 'file');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { sendMediaAsDocument: true, caption: caption || '' }), 30000, 'sendFile');
        console.log(`📤 File → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send file error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/audio', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, ptt } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url ? await MessageMedia.fromUrl(url, { unsafeMime: true }) : new MessageMedia('audio/ogg; codecs=opus', base64, 'audio.ogg');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { sendAudioAsVoice: ptt !== false }), 30000, 'sendAudio');
        console.log(`📤 Audio → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send audio error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/location', requireApiKey, requireReady, async (req, res) => {
    const { to, latitude, longitude, description } = req.body;
    if (!to || latitude == null || longitude == null) return res.status(400).json({ success: false, error: 'Missing: to, latitude, longitude' });
    try {
        const chatId = normalizePhone(to);
        const loc = new Location(parseFloat(latitude), parseFloat(longitude), description || '');
        const sent = await withTimeout(waClient.sendMessage(chatId, loc), 30000, 'sendLocation');
        console.log(`📤 Location → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send location error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/chats', requireApiKey, requireReady, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const chats = await waClient.getChats();
        const page = chats.slice(offset, offset + limit);
        res.json({ success: true, total: chats.length, limit, offset, chats: page.map(c => ({ id: c.id._serialized, name: c.name, isGroup: c.isGroup, unreadCount: c.unreadCount, timestamp: c.timestamp })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/contacts', requireApiKey, requireReady, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const contacts = await waClient.getContacts();
        const page = contacts.slice(offset, offset + limit);
        res.json({ success: true, total: contacts.length, limit, offset, contacts: page.map(c => ({ id: c.id._serialized, name: c.name || c.pushname || '', number: c.number, isMyContact: c.isMyContact })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/groups', requireApiKey, requireReady, async (req, res) => {
    try {
        const chats = await waClient.getChats();
        const groups = chats.filter(c => c.isGroup);
        res.json({ success: true, count: groups.length, groups: groups.map(g => ({ id: g.id._serialized, name: g.name, participantCount: g.participants?.length || 0 })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server → http://0.0.0.0:${PORT}`));

// ─── WhatsApp bootstrap ───────────────────────────────────────────────────────
async function start() {
    if (isStarting) { console.warn('⚠️  start() already running — skipping'); return; }
    isStarting = true;
    isReady = false;
    qrData = null;
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }

    try {
        fs.mkdirSync(DATA_PATH, { recursive: true });
        fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });
        clearLocalCache();

        console.log('📦 Connecting to MongoDB...');
        if (mongoose.connection.readyState !== 0) await mongoose.connection.close().catch(() => { });
        await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
        console.log('✅ MongoDB connected');

        const store = createFixedStore(mongoose);
        const sessionExists = await store.sessionExists({ session: SESSION_DIR_NAME });
        let validSession = false;

        if (sessionExists) {
            const col = mongoose.connection.db.collection(`whatsapp-${SESSION_DIR_NAME}.files`);
            const files = await col.find({ filename: { $regex: `^${SESSION_DIR_NAME}\\.zip\\.` } }).toArray();
            const slots = files.sort((a, b) => b.uploadDate - a.uploadDate);
            const bestSlot = slots.find(f => f.length >= 1000);
            if (!bestSlot) {
                console.warn(`⚠️  All ${slots.length} slot(s) corrupted — rescanning QR`);
                await store.delete({ session: SESSION_DIR_NAME });
            } else {
                console.log(`✅ Session found: ${slots.length} slot(s), best: ${(bestSlot.length / 1024).toFixed(1)} KB`);
                validSession = true;
            }
        } else {
            console.log('❌ No session in MongoDB — QR scan required');
        }

        const client = new Client({
            authStrategy: new RemoteAuth({
                clientId: SESSION_NAME,
                store,
                backupSyncIntervalMs: BACKUP_INTERVAL,
            }),
            puppeteer: puppeteerConfig,
            authTimeoutMs: 120000,
        });

        currentClient = client;

        client.on('loading_screen', (percent, message) => console.log(`⏳ Loading: ${percent}% — ${message}`));

        client.on('qr', (qr) => {
            botStatus = 'qr_ready';
            qrData = qr;
            if (validSession) console.warn('⚠️  Session restore failed — scan fresh QR');
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📱 Scan QR: open the web UI or hit /api/qr');
            console.log('   Settings → Linked Devices → Link a Device');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            qrcode.generate(qr, { small: true });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        });

        client.on('authenticated', () => {
            // Don't downgrade status if we're already ready (WA fires 'authenticated'
            // again during internal session refreshes — overwriting 'ready' caused
            // the API to return 503 until the next 'ready' event, which never came).
            if (!isReady) {
                botStatus = 'authenticated';
                readyWatchdog = setTimeout(() => {
                    if (!isReady) {
                        console.error('🐕 Watchdog: authenticated but never ready after 3min — restarting');
                        scheduleRestart(5000);
                    }
                }, 3 * 60 * 1000);
            }
            qrData = null;
            console.log('🔐 Authenticated!');
        });

        client.on('auth_failure', (msg) => {
            botStatus = 'disconnected';
            qrData = null;
            console.error('❌ Auth failed:', msg);
            scheduleRestart(10000);
        });

        client.on('ready', () => {
            if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
            // Always ensure botStatus is 'ready' — even on re-fires from WA internal
            // refresh. The 'authenticated' guard above may have set it to 'authenticated'
            // on a very rare race; this corrects it.
            botStatus = 'ready';
            waClient = client;
            if (isReady) { console.log('🔄 WA internal refresh — still ready ✅'); return; }
            isReady = true;
            console.log('✅ Bot is ready!');
            if (!validSession) console.log('⏳ New session — first backup in ~60s. Do NOT restart!');
            else console.log(`💾 Re-backup every ${BACKUP_INTERVAL / 1000}s`);
        });

        client.on('remote_session_saved', () => {
            sessionSavedAt = formatTime(new Date());
            console.log(`💾 Session backed up to MongoDB ✅ at ${sessionSavedAt}`);
        });

        client.on('disconnected', (reason) => {
            botStatus = 'disconnected';
            waClient = null;
            isReady = false;
            isStarting = false;
            if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
            console.warn('⚠️  Disconnected:', reason);
            scheduleRestart(10000);
        });

        client.on('message', async (msg) => {
            if (msg.from === 'status@broadcast') return;
            if (!msg.body && !msg.hasMedia) return;
            const [contact, chat] = await Promise.all([msg.getContact().catch(() => null), msg.getChat().catch(() => null)]);
            const payload = {
                event: 'message', timestamp: Date.now(),
                message: { id: msg.id._serialized, from: msg.from, to: msg.to, body: msg.body || '', type: msg.type, hasMedia: msg.hasMedia, isGroup: msg.from.endsWith('@g.us'), isForwarded: msg.isForwarded, timestamp: msg.timestamp },
                contact: contact ? { name: contact.pushname || contact.name || '', number: contact.number } : null,
                chat: chat ? { id: chat.id._serialized, name: chat.name, isGroup: chat.isGroup } : null,
            };
            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (media) {
                        const approxBytes = Math.ceil(media.data.length * 0.75);
                        if (approxBytes <= MAX_MEDIA_WEBHOOK_BYTES) {
                            payload.message.media = { mimetype: media.mimetype, filename: media.filename || '', data: media.data };
                        } else {
                            payload.message.mediaTooLarge = true;
                            payload.message.mediaSize = approxBytes;
                        }
                    }
                } catch (e) { console.warn(`⚠️  Media download failed: ${e.message}`); }
            }
            console.log(`📩 [${msg.from}] ${msg.type}: ${msg.body || '(media)'}`);
            fireWebhook(payload);
            if (msg.body === '!ping') await msg.reply('🏓 pong!');
            if (msg.body === '!status') await msg.reply(`📊 *Bot Status*\n\nStatus: ${botStatus}\nSession: ${SESSION_NAME}\nUptime: ${formatUptime((Date.now() - startTime) / 1000)}\nLast Backup: ${sessionSavedAt || 'Not yet'}`);
        });

        client.on('message_reaction', (reaction) => {
            fireWebhook({ event: 'reaction', timestamp: Date.now(), reaction: { id: reaction.id._serialized, from: reaction.senderId, emoji: reaction.reaction, messageId: reaction.msgId._serialized } });
        });

        console.log('🚀 Initializing WhatsApp client...');
        botStatus = 'starting';
        await client.initialize();

    } catch (err) {
        console.error('❌ Startup error:', err.message);
        isStarting = false;
        scheduleRestart(15000);
    }
}

async function scheduleRestart(ms) {
    console.log(`🔄 Restarting in ${ms / 1000}s...`);
    waClient = null;
    isStarting = false;
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    if (currentClient) {
        try { await currentClient.destroy(); } catch { /* ignore */ }
        currentClient = null;
    }
    try { await mongoose.connection.close(); } catch { /* ignore */ }
    setTimeout(() => start(), ms);
}

// ─── Global error guards ──────────────────────────────────────────────────────
const IGNORABLE = [
    e => e?.code === 'ENOENT' && ['scandir', 'readdir', 'unlink'].includes(e?.syscall),
    e => e?.message?.includes('Execution context was destroyed'),
    e => e?.message?.includes('Target closed'),
    e => e?.message?.includes('Session closed'),
    e => e?.message?.includes('Protocol error'),
    e => e?.message?.includes('Operation interrupted because client was closed'),
    e => e?.message?.includes('Cannot use a session that has ended'),
    e => e?.message?.includes('connection from closed connection pool'),
    e => e?.message?.includes('Topology is closed'),
];

process.on('uncaughtException', (err) => {
    if (IGNORABLE.some(fn => fn(err))) { console.warn(`⚠️  Ignored uncaughtException: ${err.message}`); return; }
    console.error('💥 uncaughtException:', err.message);
    if (!isReady) scheduleRestart(10000);
});

process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (IGNORABLE.some(fn => fn(err))) { console.warn(`⚠️  Ignored unhandledRejection: ${err.message}`); return; }
    console.error('💥 unhandledRejection:', err.message);
    if (!isReady) scheduleRestart(10000);
});

start();