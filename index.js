'use strict';

require('dotenv').config();

const { Client, RemoteAuth, MessageMedia, Location } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const qrcode   = require('qrcode-terminal');
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const http     = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────
const MONGODB_URI    = process.env.MONGODB_URI;
const SESSION_NAME   = process.env.SESSION_NAME   || 'whatsapp-bot';
const PORT           = parseInt(process.env.PORT  || '7860', 10);
const API_KEY        = process.env.API_KEY        || 'changeme';
const WEBHOOK_URL    = process.env.WEBHOOK_URL    || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// IS_PROD: true when PUPPETEER_EXECUTABLE_PATH is set (always set inside Docker via ENV in Dockerfile)
// On local Windows/Mac dev it's not set → Puppeteer uses its own bundled Chromium
const IS_PROD = !!process.env.PUPPETEER_EXECUTABLE_PATH;

// Media size guard — skip base64 in webhook payload if media exceeds this
const MAX_MEDIA_WEBHOOK_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_WEBHOOK_ATTEMPTS    = 3;
const BACKUP_INTERVAL         = IS_PROD ? 5 * 60 * 1000 : 60 * 1000;
const DATA_PATH               = path.resolve('./.wwebjs_auth');
const SESSION_DIR_NAME        = `RemoteAuth-${SESSION_NAME}`;

// ─── Startup validation ───────────────────────────────────────────────────────
if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set! Add it to your .env or HF Secrets.');
    process.exit(1);
}
if (API_KEY === 'changeme') {
    console.warn('⚠️  API_KEY is using the default value — set a strong key!');
}

console.log(`🌍 Environment  : ${IS_PROD ? 'Production (Docker/HF)' : 'Development (Local)'}`);
console.log(`📛 Session name : ${SESSION_NAME}`);
console.log(`⏱️  Backup every : ${BACKUP_INTERVAL / 1000}s`);
console.log(`🔑 API Key      : ${API_KEY === 'changeme' ? '⚠️  DEFAULT' : '✅ Set'}`);
console.log(`🪝 Webhook URL  : ${WEBHOOK_URL || '❌ Not set'}`);
console.log(`🌐 Port         : ${PORT}`);

// ─── Puppeteer config ─────────────────────────────────────────────────────────
// NOTE: --single-process is intentionally REMOVED — it causes hangs in containers
const puppeteerConfig = IS_PROD
    ? {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--safebrowsing-disable-auto-update',
        ],
        timeout: 120000, // 2 min — HF cold starts can be slow
        protocolTimeout: 120000,
    }
    : {
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        timeout: 60000,
    };

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

let botStatus      = 'starting';
let waClient       = null;
let sessionSavedAt = null;
let isStarting     = false;   // guard against overlapping start() calls
let isReady        = false;   // tracks if WA client has fired 'ready'
const startTime    = Date.now();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatUptime(s) {
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${Math.floor(s % 60)}s`;
}
function formatTime(d) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Normalize a phone number to WhatsApp chat ID format.
 * Handles: "08123456789", "+628123456789", "628123456789", "628123456789@c.us"
 * Returns: "628123456789@c.us"
 */
function normalizePhone(phone) {
    if (typeof phone === 'string' && (phone.endsWith('@c.us') || phone.endsWith('@g.us'))) {
        return phone;
    }
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
    return `${cleaned}@c.us`;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key || key !== API_KEY) {
        return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    }
    next();
}

function requireReady(req, res, next) {
    if (botStatus !== 'ready' || !waClient) {
        return res.status(503).json({ success: false, error: `Bot not ready (status: ${botStatus})` });
    }
    next();
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
async function fireWebhook(payload, attempt = 1) {
    if (!WEBHOOK_URL) return;
    try {
        const body = JSON.stringify(payload);
        const url  = new URL(WEBHOOK_URL);
        const options = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname + url.search,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
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
            const zipPath     = path.join(DATA_PATH, `${sessionName}.zip`);

            if (!fs.existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`);
            const size = fs.statSync(zipPath).size;
            if (size < 1000) throw new Error(`Zip too small (${size} bytes) — aborting backup`);

            console.log(`💾 Uploading to MongoDB: ${sessionName}.zip (${(size / 1024).toFixed(1)} KB)`);

            const bucket   = getBucket(sessionName);
            const slotName = `${sessionName}.zip.${Date.now()}`;

            await new Promise((resolve, reject) => {
                fs.createReadStream(zipPath)
                    .pipe(bucket.openUploadStream(slotName))
                    .on('error', reject)
                    .on('close', resolve);
            });

            const allDocs  = await bucket.find({}).toArray();
            const slots    = allDocs
                .filter(d => d.filename.startsWith(`${sessionName}.zip.`))
                .sort((a, b) => a.uploadDate - b.uploadDate);
            const toDelete = slots.slice(0, Math.max(0, slots.length - MAX_BACKUPS));
            for (const doc of toDelete) await bucket.delete(doc._id);

            const remaining = slots.length - toDelete.length;
            console.log(`✅ MongoDB upload done (${remaining}/${MAX_BACKUPS} slots) @ ${formatTime(new Date())}`);

            // Clean up local zip after successful upload
            try { fs.unlinkSync(zipPath); } catch { /* already removed by wwebjs internals */ };
        },

        async extract(options) {
            const sessionName = path.basename(options.session);
            const zipPath     = options.path;
            const bucket      = getBucket(sessionName);

            const allDocs = await bucket.find({}).toArray();
            const slots   = allDocs
                .filter(d => d.filename.startsWith(`${sessionName}.zip.`))
                .sort((a, b) => b.uploadDate - a.uploadDate);

            if (slots.length === 0) throw new Error('No backup slots found in MongoDB');
            console.log(`📦 Found ${slots.length} backup slot(s) in MongoDB`);

            for (let i = 0; i < slots.length; i++) {
                const slot     = slots[i];
                const slotDate = new Date(slot.uploadDate).toLocaleString('id-ID');
                console.log(`📦 Trying slot ${i + 1}/${slots.length}: ${slot.filename} (${(slot.length / 1024).toFixed(1)} KB, ${slotDate})`);
                if (slot.length < 1000) { console.warn(`⚠️  Slot ${i + 1} too small — skipping`); continue; }

                try {
                    await new Promise((resolve, reject) => {
                        bucket.openDownloadStreamByName(slot.filename)
                            .pipe(fs.createWriteStream(zipPath))
                            .on('error', reject)
                            .on('close', resolve);
                    });
                    const downloaded = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
                    if (downloaded < 1000) { console.warn(`⚠️  Slot ${i + 1} downloaded empty — skipping`); continue; }
                    console.log(`✅ Restored from slot ${i + 1}: ${(downloaded / 1024).toFixed(1)} KB`);
                    return;
                } catch (err) {
                    console.warn(`⚠️  Slot ${i + 1} failed: ${err.message}`);
                }
            }
            throw new Error('All backup slots failed — delete MongoDB data and rescan QR');
        },

        async delete(options) {
            const sessionName = path.basename(options.session);
            const bucket      = getBucket(sessionName);
            const docs        = await bucket.find({}).toArray();
            for (const doc of docs) await bucket.delete(doc._id);
            console.log(`🗑️  Deleted all ${docs.length} backup slot(s): ${sessionName}`);
        },
    };
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    const emoji = {
        starting: '⏳', qr_ready: '📱', authenticated: '🔐', ready: '✅', disconnected: '❌',
    }[botStatus] || '❓';
    const hints = {
        qr_ready:      '📋 Check the Logs tab and scan the QR code with WhatsApp.',
        ready:         '🟢 Bot is online and ready to send/receive messages.',
        disconnected:  '🔴 Lost connection — reconnecting automatically...',
        starting:      '🔵 Starting up, please wait... (may take 1-2 min on first start)',
        authenticated: '🔐 Authenticated — loading WhatsApp session...',
    };
    res.send(`<!DOCTYPE html><html lang="en"><head><title>WhatsApp Bot</title><meta http-equiv="refresh" content="10"><meta charset="UTF-8">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:white;border-radius:16px;padding:40px;max-width:600px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{color:#111;font-size:1.4rem;margin-bottom:24px}.si{font-size:3.5rem;margin:16px 0}.badge{padding:8px 20px;border-radius:100px;display:inline-block;font-weight:600;font-size:.85rem;text-transform:uppercase}.ready{background:#dcfce7;color:#166534}.qr_ready{background:#fef9c3;color:#854d0e}.starting,.authenticated{background:#dbeafe;color:#1e40af}.disconnected{background:#fee2e2;color:#991b1b}.hint{margin-top:16px;color:#6b7280;font-size:.9rem;line-height:1.6}.meta{margin-top:24px;padding-top:24px;border-top:1px solid #f0f0f0;display:flex;justify-content:space-around;flex-wrap:wrap;gap:12px}.mi{font-size:.8rem;color:#9ca3af}.mi strong{display:block;color:#374151;font-size:.9rem;margin-bottom:2px}.api{margin-top:24px;padding-top:24px;border-top:1px solid #f0f0f0;text-align:left;font-size:.8rem;color:#6b7280;line-height:2}.api code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:.75rem}</style></head>
    <body><div class="card">
    <h1>🤖 WhatsApp Bot API</h1>
    <div class="si">${emoji}</div>
    <div class="badge ${botStatus}">${botStatus.replace('_', ' ')}</div>
    <p class="hint">${hints[botStatus] || ''}</p>
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
      <code>GET  /api/status</code>         — Bot status<br>
      <code>POST /api/send/text</code>      — Send text message<br>
      <code>POST /api/send/image</code>     — Send image<br>
      <code>POST /api/send/file</code>      — Send file/document<br>
      <code>POST /api/send/audio</code>     — Send audio / voice note<br>
      <code>POST /api/send/location</code>  — Send location pin<br>
      <code>GET  /api/chats</code>          — List chats (paginated)<br>
      <code>GET  /api/contacts</code>       — List contacts (paginated)<br>
      <code>GET  /api/groups</code>         — List groups<br>
    </div>
    </div></body></html>`);
});

// ─── Health check — no auth, for HF uptime monitor & load balancer ────────────
app.get('/api/health', (req, res) => res.status(200).json({ success: true, status: botStatus, uptime: formatUptime((Date.now() - startTime) / 1000) }));
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/_health', (req, res) => res.status(200).send('ok'));

// ─── Status ───────────────────────────────────────────────────────────────────
app.get('/api/status', requireApiKey, (req, res) => {
    res.json({
        success:           true,
        status:            botStatus,
        session:           SESSION_NAME,
        environment:       IS_PROD ? 'production' : 'development',
        uptime:            formatUptime((Date.now() - startTime) / 1000),
        lastBackup:        sessionSavedAt,
        webhookConfigured: !!WEBHOOK_URL,
    });
});

// ─── Send text ────────────────────────────────────────────────────────────────
app.post('/api/send/text', requireApiKey, requireReady, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing: to, message' });
    }
    try {
        const chatId = normalizePhone(to);
        const sent   = await waClient.sendMessage(chatId, message);
        console.log(`📤 Text → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send text error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Send image ───────────────────────────────────────────────────────────────
app.post('/api/send/image', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) {
        return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    }
    try {
        const chatId = normalizePhone(to);
        const media  = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia(mime || 'image/jpeg', base64, filename || 'image.jpg');
        const sent = await waClient.sendMessage(chatId, media, { caption: caption || '' });
        console.log(`📤 Image → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send image error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Send file ────────────────────────────────────────────────────────────────
app.post('/api/send/file', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) {
        return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    }
    try {
        const chatId = normalizePhone(to);
        const media  = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia(mime || 'application/octet-stream', base64, filename || 'file');
        const sent = await waClient.sendMessage(chatId, media, {
            sendMediaAsDocument: true,
            caption: caption || '',
        });
        console.log(`📤 File → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send file error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Send audio ───────────────────────────────────────────────────────────────
app.post('/api/send/audio', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, ptt } = req.body;
    if (!to || (!url && !base64)) {
        return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    }
    try {
        const chatId = normalizePhone(to);
        const media  = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia('audio/ogg; codecs=opus', base64, 'audio.ogg');
        const sent = await waClient.sendMessage(chatId, media, { sendAudioAsVoice: ptt !== false });
        console.log(`📤 Audio → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send audio error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Send location ────────────────────────────────────────────────────────────
app.post('/api/send/location', requireApiKey, requireReady, async (req, res) => {
    const { to, latitude, longitude, description } = req.body;
    if (!to || latitude == null || longitude == null) {
        return res.status(400).json({ success: false, error: 'Missing: to, latitude, longitude' });
    }
    try {
        const chatId = normalizePhone(to);
        const loc    = new Location(parseFloat(latitude), parseFloat(longitude), description || '');
        const sent   = await waClient.sendMessage(chatId, loc);
        console.log(`📤 Location → ${chatId}`);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error(`❌ Send location error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── List chats ───────────────────────────────────────────────────────────────
app.get('/api/chats', requireApiKey, requireReady, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  || '50',  10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const chats = await waClient.getChats();
        const page  = chats.slice(offset, offset + limit);
        res.json({
            success: true, total: chats.length, limit, offset,
            chats: page.map(c => ({
                id:          c.id._serialized,
                name:        c.name,
                isGroup:     c.isGroup,
                unreadCount: c.unreadCount,
                timestamp:   c.timestamp,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── List contacts ────────────────────────────────────────────────────────────
app.get('/api/contacts', requireApiKey, requireReady, async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const contacts = await waClient.getContacts();
        const page     = contacts.slice(offset, offset + limit);
        res.json({
            success: true, total: contacts.length, limit, offset,
            contacts: page.map(c => ({
                id:          c.id._serialized,
                name:        c.name || c.pushname || '',
                number:      c.number,
                isMyContact: c.isMyContact,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── List groups ──────────────────────────────────────────────────────────────
app.get('/api/groups', requireApiKey, requireReady, async (req, res) => {
    try {
        const chats  = await waClient.getChats();
        const groups = chats.filter(c => c.isGroup);
        res.json({
            success: true,
            count: groups.length,
            groups: groups.map(g => ({
                id:               g.id._serialized,
                name:             g.name,
                participantCount: g.participants?.length || 0,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start Express immediately so HF health checks pass while WA is still loading
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server → http://0.0.0.0:${PORT}`));

// ─── WhatsApp bootstrap ───────────────────────────────────────────────────────
async function start() {
    if (isStarting) {
        console.warn('⚠️  start() called while already starting — ignoring duplicate');
        return;
    }
    isStarting = true;
    try {
        // Ensure auth directory exists (may not exist on fresh container)
        fs.mkdirSync(DATA_PATH, { recursive: true });

        clearLocalCache();

        console.log('📦 Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
        console.log('✅ MongoDB connected');

        const store         = createFixedStore(mongoose);
        const sessionExists = await store.sessionExists({ session: SESSION_DIR_NAME });
        let   validSession  = false;

        if (sessionExists) {
            const col   = mongoose.connection.db.collection(`whatsapp-${SESSION_DIR_NAME}.files`);
            const files = await col
                .find({ filename: { $regex: `^${SESSION_DIR_NAME}\\.zip\\.` } })
                .toArray();
            const slots    = files.sort((a, b) => b.uploadDate - a.uploadDate);
            const bestSlot = slots.find(f => f.length >= 1000);

            if (!bestSlot) {
                console.warn(`⚠️  All ${slots.length} slot(s) corrupted — deleting and rescanning QR`);
                await store.delete({ session: SESSION_DIR_NAME });
            } else {
                console.log(`✅ Session found: ${slots.length} slot(s), best: ${(bestSlot.length / 1024).toFixed(1)} KB — restoring...`);
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
            // Increase internal timeouts for slow HF cold starts
            authTimeoutMs: 120000,
        });

        client.on('loading_screen', (percent, message) => {
            console.log(`⏳ Loading: ${percent}% — ${message}`);
        });

        client.on('qr', (qr) => {
            botStatus = 'qr_ready';
            if (validSession) console.warn('⚠️  Session restore may have failed — scan fresh QR');
            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📱 Scan this QR code with WhatsApp');
            console.log('   Settings → Linked Devices → Link a Device');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
            qrcode.generate(qr, { small: true });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        });

        client.on('authenticated', () => {
            botStatus = 'authenticated';
            console.log('🔐 Authenticated!');
        });

        client.on('auth_failure', (msg) => {
            botStatus = 'disconnected';
            console.error('❌ Auth failed:', msg);
            scheduleRestart(10000);
        });

        client.on('ready', () => {
            if (isReady) {
                console.log('🔄 WhatsApp internal refresh — still ready ✅');
                return;
            }
            isReady   = true;
            waClient  = client;
            botStatus = 'ready';
            console.log('✅ Bot is ready!');
            if (!validSession) {
                console.log('⏳ New session — first backup in ~60s. Do NOT restart the Space!');
            } else {
                console.log(`💾 Re-backup every ${BACKUP_INTERVAL / 1000}s`);
            }
        });

        client.on('remote_session_saved', () => {
            sessionSavedAt = formatTime(new Date());
            console.log(`💾 Session backed up to MongoDB ✅ at ${sessionSavedAt}`);
        });

        client.on('disconnected', (reason) => {
            botStatus  = 'disconnected';
            waClient   = null;
            isReady    = false;
            isStarting = false;
            console.warn('⚠️  Disconnected:', reason);
            scheduleRestart(10000);
        });

        // ─── Incoming messages → webhook ──────────────────────────────────────
        client.on('message', async (msg) => {
            if (msg.from === 'status@broadcast') return;
            if (!msg.body && !msg.hasMedia) return;

            const [contact, chat] = await Promise.all([
                msg.getContact().catch(() => null),
                msg.getChat().catch(() => null),
            ]);

            const payload = {
                event:     'message',
                timestamp: Date.now(),
                message: {
                    id:          msg.id._serialized,
                    from:        msg.from,
                    to:          msg.to,
                    body:        msg.body || '',
                    type:        msg.type,
                    hasMedia:    msg.hasMedia,
                    isGroup:     msg.from.endsWith('@g.us'),
                    isForwarded: msg.isForwarded,
                    timestamp:   msg.timestamp,
                },
                contact: contact ? {
                    name:   contact.pushname || contact.name || '',
                    number: contact.number,
                } : null,
                chat: chat ? {
                    id:      chat.id._serialized,
                    name:    chat.name,
                    isGroup: chat.isGroup,
                } : null,
            };

            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (media) {
                        const approxBytes = Math.ceil(media.data.length * 0.75);
                        if (approxBytes <= MAX_MEDIA_WEBHOOK_BYTES) {
                            payload.message.media = {
                                mimetype: media.mimetype,
                                filename: media.filename || '',
                                data:     media.data,
                            };
                        } else {
                            payload.message.mediaTooLarge = true;
                            payload.message.mediaSize     = approxBytes;
                            console.warn(`⚠️  Media too large for webhook (${(approxBytes / 1024 / 1024).toFixed(1)} MB) — skipped`);
                        }
                    }
                } catch (e) {
                    console.warn(`⚠️  Could not download media: ${e.message}`);
                }
            }

            console.log(`📩 [${msg.from}] ${msg.type}: ${msg.body || '(media)'}`);
            fireWebhook(payload);

            if (msg.body === '!ping') await msg.reply('🏓 pong!');
            if (msg.body === '!status') {
                await msg.reply(
                    `📊 *Bot Status*\n\nStatus: ${botStatus}\nSession: ${SESSION_NAME}\n` +
                    `Uptime: ${formatUptime((Date.now() - startTime) / 1000)}\n` +
                    `Last Backup: ${sessionSavedAt || 'Not yet'}`
                );
            }
        });

        client.on('message_reaction', (reaction) => {
            fireWebhook({
                event:     'reaction',
                timestamp: Date.now(),
                reaction: {
                    id:        reaction.id._serialized,
                    from:      reaction.senderId,
                    emoji:     reaction.reaction,
                    messageId: reaction.msgId._serialized,
                },
            });
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
    waClient    = null;
    isStarting  = false;   // allow start() to run again after restart
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

process.on('unhandledRejection', (reason) => {
    if (IGNORABLE.some(fn => fn(reason))) return;
    console.error('⚠️  Unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    if (IGNORABLE.some(fn => fn(err))) return;
    console.error('⚠️  Uncaught exception:', err.message);
});

start();