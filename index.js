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
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { HfInference } = require('@huggingface/inference');

// ─── VALIDATE REQUIRED ENV VARS ───────────────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'GEMINI_API_KEY', 'HF_TOKEN', 'GOOGLE_CREDS_JSON'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
    console.error('Missing required environment variables: ' + missingEnv.join(', '));
    console.error('   Set them in your .env file or Railway environment settings.');
    process.exit(1);
}

// ─── LOAD GOOGLE CREDENTIALS ──────────────────────────────────────────────────
// dotenv on Windows can mangle JSON values in several ways:
//   1. Wraps in extra quotes  -> we strip them
//   2. Double-escapes \\n in private_key -> we normalize them
let creds;
try {
    let raw = process.env.GOOGLE_CREDS_JSON || '';

    // Strip wrapping single-quotes:  GOOGLE_CREDS_JSON='{"type":...'
    if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
    // Strip wrapping double-quotes
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);

    creds = JSON.parse(raw);

    if (!creds.client_email || !creds.private_key) {
        throw new Error('Missing client_email or private_key fields');
    }

    // Normalize private_key newlines (\\n -> real newline) - Railway / dotenv safe
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');

    console.log('Google creds loaded for: ' + creds.client_email);
} catch (e) {
    console.error('Failed to parse GOOGLE_CREDS_JSON: ' + e.message);
    console.error('');
    console.error('  Common fixes:');
    console.error('  1. In .env, wrap the JSON in single quotes:');
    console.error("     GOOGLE_CREDS_JSON='{\"type\":\"service_account\",...}'");
    console.error('  2. Make sure you pasted the FULL content of google-creds.json');
    console.error('  3. On Railway, paste the raw JSON directly - no extra quotes needed');
    process.exit(1);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '12nM0fYtmEGRw5y170UDmWyaLWLu5T_tgWtjvEp6XedY';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HF_TOKEN = process.env.HF_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_NAME = process.env.SESSION_NAME || 'whatsapp-bot';
const PORT = parseInt(process.env.PORT || '8000', 10);
const API_KEY = process.env.API_KEY || 'changeme';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
// Public URL of this server — used to build the dashboard link sent to WhatsApp
// Set this to your Railway domain, e.g. https://wabot-production.up.railway.app
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// Parse allowed chats ONCE at startup - not per message
const ALLOWED_CHATS = (process.env.ALLOWED_CHATS || '6287759895339-1608597951@g.us')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

// Rate limiting cooldown per sender (ms)
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '3000', 10);

const IS_PROD = !!process.env.PUPPETEER_EXECUTABLE_PATH;

const MAX_MEDIA_WEBHOOK_BYTES = 5 * 1024 * 1024;
const MAX_WEBHOOK_ATTEMPTS = 3;
const BACKUP_INTERVAL = IS_PROD ? 5 * 60 * 1000 : 60 * 1000;

const DATA_PATH = IS_PROD ? path.resolve('/app/.wwebjs_auth') : path.resolve(process.cwd(), '.wwebjs_auth');
const CHROME_DATA_DIR = IS_PROD ? path.resolve('/tmp/.chrome-data') : path.resolve(process.cwd(), '.chrome-data');
const SESSION_DIR_NAME = 'RemoteAuth-' + SESSION_NAME;

// ─── STARTUP LOGS ─────────────────────────────────────────────────────────────
if (API_KEY === 'changeme') {
    console.warn('API_KEY is using the default value - set a strong key in env!');
}
console.log('Environment  : ' + (IS_PROD ? 'Production (Railway/Docker)' : 'Development (Local)'));
console.log('Session name : ' + SESSION_NAME);
console.log('Backup every : ' + (BACKUP_INTERVAL / 1000) + 's');
console.log('API Key      : ' + (API_KEY === 'changeme' ? 'DEFAULT (unsafe!)' : 'Set'));
console.log('Webhook URL  : ' + (WEBHOOK_URL || 'Not set'));
console.log('Port         : ' + PORT);
console.log('Allowed Chats: ' + (ALLOWED_CHATS.length > 0 ? ALLOWED_CHATS.join(', ') : 'All'));
console.log('Rate Limit   : ' + RATE_LIMIT_MS + 'ms per sender');

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// ─── AI CLIENTS ───────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' }); // kept for future use
const inference = new HfInference(HF_TOKEN);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatUptime(s) {
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ' + Math.floor(s % 60) + 's';
}
function formatTime(d) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function normalizePhone(phone) {
    if (typeof phone === 'string' && (phone.endsWith('@c.us') || phone.endsWith('@g.us'))) return phone;
    let cleaned = String(phone).replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '62' + cleaned.slice(1);
    return cleaned + '@c.us';
}
function withTimeout(promise, ms, label) {
    ms = ms || 30000;
    label = label || 'Operation';
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(label + ' timed out after ' + (ms / 1000) + 's')), ms)
        ),
    ]);
}

// DD/MM/YYYY - locale-independent (no toLocaleDateString)
function formatDateID(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
}

// HH.MM.SS - locale-independent
function formatTimeLocal(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getHours()) + '.' + pad(d.getMinutes()) + '.' + pad(d.getSeconds());
}

// Prevent spreadsheet formula injection (=, +, -, @)
function sanitizeCell(value) {
    const str = String(value || '');
    return /^[=+\-@]/.test(str) ? ' ' + str : str;
}

// ─── GOOGLE SHEETS LOGIC ──────────────────────────────────────────────────────
const REQUIRED_HEADERS = ['Tanggal', 'Deskripsi', 'Nominal', 'Tipe', 'User', 'Saldo Akhir'];

async function getSheet() {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    try {
        await sheet.loadHeaderRow();
    } catch (e) {
        // Only set headers if sheet is truly empty — never overwrite on network errors
        const cells = await sheet.getCellsInRange('A1').catch(() => null);
        if (!cells || !cells[0] || !cells[0][0]) {
            await sheet.setHeaderRow(REQUIRED_HEADERS);
            console.log('Created spreadsheet headers');
        } else {
            throw new Error('Failed to load sheet headers: ' + e.message);
        }
    }
    return sheet;
}

async function hitungSaldo(sheet, filterTanggal) {
    filterTanggal = filterTanggal || null;
    const rows = await sheet.getRows();
    let totalPemasukan = 0;
    let totalPengeluaran = 0;

    rows.forEach(row => {
        const tgl = row.get('Tanggal');
        const nominalStr = row.get('Nominal');
        const tipe = row.get('Tipe');
        if (!tgl || !nominalStr) return;

        const tglFull = tgl.toString();
        const tglSheet = tglFull.includes(',') ? tglFull.split(',')[0].trim() : tglFull.trim();
        const nominal = parseInt(nominalStr.toString().replace(/\D/g, ''), 10) || 0;

        if (!filterTanggal || tglSheet === filterTanggal) {
            const tipeUpper = tipe ? tipe.toString().toUpperCase() : '';
            if (tipeUpper === 'PEMASUKAN' || tipeUpper === 'DEBIT') totalPemasukan += nominal;
            if (tipeUpper === 'PENGELUARAN' || tipeUpper === 'CREDIT') totalPengeluaran += nominal;
        }
    });

    return { totalPemasukan, totalPengeluaran, saldo: totalPemasukan - totalPengeluaran };
}

async function generateRekapBulanan(sheet, bulanStr) {
    const rows = await sheet.getRows();
    let totalPemasukan = 0;
    let totalPengeluaran = 0;
    const listTransaksi = [];

    rows.forEach(row => {
        const tgl = row.get('Tanggal');
        const nominalStr = row.get('Nominal');
        const tipe = row.get('Tipe');
        const deskripsi = row.get('Deskripsi') || '';
        if (!tgl || !nominalStr) return;

        const tglFull = tgl.toString();
        const tglHari = tglFull.includes(',') ? tglFull.split(',')[0].trim() : tglFull.trim();

        if (tglHari.endsWith(bulanStr)) {
            const nominal = parseInt(nominalStr.toString().replace(/\D/g, ''), 10) || 0;
            const tipeUpper = tipe ? tipe.toString().toUpperCase() : '';
            const tglPendek = tglHari.substring(0, 5);
            const tipeStr = (tipeUpper === 'PEMASUKAN' || tipeUpper === 'DEBIT') ? 'MASUK' : 'KELUAR';
            const descStr = deskripsi.length > 20
                ? deskripsi.substring(0, 20)
                : deskripsi.padEnd(20, ' ');

            listTransaksi.push(tglPendek + ' | ' + tipeStr + ' | Rp' + nominal.toLocaleString('id-ID') + ' | ' + descStr);

            if (tipeStr === 'MASUK') totalPemasukan += nominal;
            if (tipeStr === 'KELUAR') totalPengeluaran += nominal;
        }
    });

    return { totalPemasukan, totalPengeluaran, saldo: totalPemasukan - totalPengeluaran, listTransaksi };
}

// ─── AI PARSING ───────────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `Kamu adalah asisten keuangan pribadi yang cerdas, ramah, dan fleksibel.
Tugasmu: baca pesan user dan klasifikasikan ke format JSON murni.

Aturan:
1. TRANSAKSI: pesan soal uang masuk/keluar
   -> {"nominal": angka, "tipe": "PEMASUKAN"/"PENGELUARAN", "deskripsi": "..."}
   Konversi: 50k->50000, 1.5jt->1500000, 10rb->10000

2. CEK SALDO SEKARANG: tanya saldo/sisa uang sekarang
   -> {"command":"cek_saldo_sekarang"}

3. CEK SALDO TANGGAL: tanya saldo tanggal tertentu
   -> {"command":"cek_saldo_tanggal","tanggal":"DD/MM/YYYY"}
   (Tahun/bulan saat ini: 2026)

4. REKAP BULANAN: minta laporan/rekap bulan
   -> {"command":"rekap_bulanan","bulan":"MM/YYYY"}
   (Bulan ini: 02/2026)

5. LAINNYA: sapaan, tidak relevan
   -> {"error":"bukan_perintah_valid"}

PENTING: output HANYA JSON murni, tanpa teks lain atau markdown.`;

async function parseWithHuggingFace(message, retries) {
    retries = (retries === undefined) ? 2 : retries;
    try {
        const response = await inference.chatCompletion({
            model: 'Qwen/Qwen2.5-7B-Instruct',
            messages: [
                { role: 'system', content: AI_SYSTEM_PROMPT },
                { role: 'user', content: message },
            ],
            max_tokens: 150,
            temperature: 0.1,
        });

        const resultText = response.choices[0].message.content;
        console.log('HF Response: ' + resultText);

        const jsonMatch = resultText.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error('AI response is not JSON: ' + resultText.slice(0, 80));

        const cleanJson = jsonMatch[0].replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);

    } catch (error) {
        if (retries > 0) {
            console.warn('HF Error (' + error.message + '). Retrying... (' + retries + ' left)');
            await new Promise(r => setTimeout(r, 1000));
            return parseWithHuggingFace(message, retries - 1);
        }
        console.error('HF Final Error: ' + error.message);
        return { error: true, message: error.message };
    }
}

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();

function isRateLimited(senderId) {
    const now = Date.now();
    const last = rateLimitMap.get(senderId);
    if (last && now - last < RATE_LIMIT_MS) return true;
    rateLimitMap.set(senderId, now);
    return false;
}

// Clean up stale entries every minute
setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_MS * 10;
    rateLimitMap.forEach((ts, id) => { if (ts < cutoff) rateLimitMap.delete(id); });
}, 60 * 1000);

// ─── PUPPETEER CONFIG ─────────────────────────────────────────────────────────
const puppeteerArgs = IS_PROD ? [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--user-data-dir=' + CHROME_DATA_DIR,
    '--renderer-process-limit=2',
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
    '--ignore-ssl-errors',
    '--disable-features=CertificateTransparencyEnforcement,IsolateOrigins,site-per-process',
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
    '--crash-dumps-dir=/tmp/chrome-crashes',
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
        protocolTimeout: 120000,
    }
    : {
        headless: true,
        args: puppeteerArgs,
        timeout: 60000,
    };

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ─── STATE ────────────────────────────────────────────────────────────────────
let botStatus = 'starting';
let waClient = null;
let sessionSavedAt = null;
let isStarting = false;
let isReady = false;
let qrData = null;
let currentClient = null;
let readyWatchdog = null;
const startTime = Date.now();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    // Header only - never query param (prevents key leakage in server logs)
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
        return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    }
    next();
}

function requireReady(req, res, next) {
    if (botStatus !== 'ready' || !waClient) {
        return res.status(503).json({ success: false, error: 'Bot not ready (status: ' + botStatus + ')' });
    }
    next();
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
async function fireWebhook(payload, attempt) {
    attempt = attempt || 1;
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
            const req = (url.protocol === 'https:' ? https : http).request(options, res => {
                console.log('Webhook -> ' + res.statusCode + ' (attempt ' + attempt + '/' + MAX_WEBHOOK_ATTEMPTS + ')');
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
            console.warn('Webhook failed [' + attempt + '/' + MAX_WEBHOOK_ATTEMPTS + ']: ' + e.message + ' - retrying in 5s');
            setTimeout(() => fireWebhook(payload, attempt + 1), 5000);
        } else {
            console.error('Webhook dropped after ' + MAX_WEBHOOK_ATTEMPTS + ' attempts: ' + e.message);
        }
    }
}

// ─── LOCAL CACHE CLEANUP ──────────────────────────────────────────────────────
function clearLocalCache() {
    [
        path.join(DATA_PATH, SESSION_DIR_NAME),
        path.join(DATA_PATH, 'wwebjs_temp_session_' + SESSION_NAME),
    ].forEach(dir => {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            console.log('Cleared: ' + path.basename(dir));
        }
    });
}

// ─── MONGO STORE ──────────────────────────────────────────────────────────────
function createFixedStore(mongooseInstance) {
    const MAX_BACKUPS = 1;

    function getBucket(sessionName) {
        return new mongooseInstance.mongo.GridFSBucket(
            mongooseInstance.connection.db,
            { bucketName: 'whatsapp-' + sessionName }
        );
    }

    return {
        async sessionExists(options) {
            const sessionName = path.basename(options.session);
            const col = mongooseInstance.connection.db.collection('whatsapp-' + sessionName + '.files');
            const count = await col.countDocuments(
                { filename: { $regex: '^' + sessionName + '\\.zip\\.' } },
                { limit: 1 }
            );
            return count > 0;
        },

        async save(options) {
            const sessionName = path.basename(options.session);
            const zipPath = path.join(DATA_PATH, sessionName + '.zip');
            if (!fs.existsSync(zipPath)) {
                console.warn('Zip not found (skip backup): ' + zipPath);
                return;
            }
            const size = fs.statSync(zipPath).size;
            if (size < 1000) throw new Error('Zip too small (' + size + ' bytes)');
            console.log('Uploading: ' + sessionName + '.zip (' + (size / 1024).toFixed(1) + ' KB)');
            const bucket = getBucket(sessionName);
            const slotName = sessionName + '.zip.' + Date.now();
            await new Promise((resolve, reject) => {
                fs.createReadStream(zipPath)
                    .pipe(bucket.openUploadStream(slotName))
                    .on('error', reject)
                    .on('close', resolve);
            });
            const allDocs = await bucket.find({}).toArray();
            const slots = allDocs
                .filter(d => d.filename.startsWith(sessionName + '.zip.'))
                .sort((a, b) => a.uploadDate - b.uploadDate);
            const toDelete = slots.slice(0, Math.max(0, slots.length - MAX_BACKUPS));
            for (const d of toDelete) await bucket.delete(d._id);
            console.log('MongoDB upload done (' + (slots.length - toDelete.length) + '/' + MAX_BACKUPS + ' slots) @ ' + formatTime(new Date()));
            // Zip cleanup — ignore ENOENT (file already gone is fine)
            try { fs.unlinkSync(zipPath); } catch (e) { if (e.code !== 'ENOENT') console.warn('unlink warn: ' + e.message); }
        },

        async extract(options) {
            const sessionName = path.basename(options.session);
            const zipPath = options.path;
            const bucket = getBucket(sessionName);
            const allDocs = await bucket.find({}).toArray();
            const slots = allDocs
                .filter(d => d.filename.startsWith(sessionName + '.zip.'))
                .sort((a, b) => b.uploadDate - a.uploadDate);
            if (slots.length === 0) throw new Error('No backup slots found in MongoDB');
            console.log('Found ' + slots.length + ' backup slot(s)');
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                console.log('Trying slot ' + (i + 1) + '/' + slots.length + ': ' + slot.filename + ' (' + (slot.length / 1024).toFixed(1) + ' KB)');
                if (slot.length < 1000) { console.warn('Slot ' + (i + 1) + ' too small - skipping'); continue; }
                try {
                    await new Promise((resolve, reject) => {
                        bucket.openDownloadStreamByName(slot.filename)
                            .pipe(fs.createWriteStream(zipPath))
                            .on('error', reject)
                            .on('close', resolve);
                    });
                    const downloaded = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
                    if (downloaded < 1000) { console.warn('Slot ' + (i + 1) + ' empty - skipping'); continue; }
                    console.log('Restored from slot ' + (i + 1) + ': ' + (downloaded / 1024).toFixed(1) + ' KB');
                    return;
                } catch (err) {
                    console.warn('Slot ' + (i + 1) + ' failed: ' + err.message);
                }
            }
            throw new Error('All backup slots failed');
        },

        async delete(options) {
            const sessionName = path.basename(options.session);
            const bucket = getBucket(sessionName);
            const docs = await bucket.find({}).toArray();
            for (const d of docs) await bucket.delete(d._id);
            console.log('Deleted ' + docs.length + ' slot(s): ' + sessionName);
        },
    };
}

// ─── FINANCE MESSAGE HANDLER ──────────────────────────────────────────────────
async function handleFinanceMessage(msg) {
    const senderId = msg.from;

    // Rate limit check
    if (isRateLimited(senderId)) {
        console.log('Rate limited: ' + senderId);
        return;
    }

    // Built-in commands - no AI needed
    if (msg.body === '!ping') {
        await msg.reply('pong!').catch(e => console.error('Reply error: ' + e.message));
        return;
    }
    if (msg.body === '!status') {
        await msg.reply(
            '*Bot Status*\n\nStatus: ' + botStatus +
            '\nSession: ' + SESSION_NAME +
            '\nUptime: ' + formatUptime((Date.now() - startTime) / 1000) +
            '\nLast Backup: ' + (sessionSavedAt || 'Not yet')
        ).catch(e => console.error('Reply error: ' + e.message));
        return;
    }

    console.log('[AI] Processing: ' + msg.body.slice(0, 80));

    // Parse with AI
    const data = await parseWithHuggingFace(msg.body);

    // Hard AI failure
    if (data.error === true) {
        console.error('AI parsing failed: ' + data.message);
        await msg.reply('Maaf, AI sedang tidak bisa memproses pesanmu. Coba lagi dalam beberapa detik.')
            .catch(e => console.error('Reply error: ' + e.message));
        return;
    }

    // Not a finance message - silently ignore
    if (data.error === 'bukan_perintah_valid') {
        console.log('Non-finance message - ignored');
        return;
    }

    // Load sheet only when we actually need it
    let sheet;
    try {
        sheet = await getSheet();
    } catch (err) {
        console.error('Google Sheets error: ' + err.message);
        await msg.reply('Tidak bisa mengakses spreadsheet: ' + err.message)
            .catch(e => console.error('Reply error: ' + e.message));
        return;
    }

    // REKAP BULANAN
    if (data.command === 'rekap_bulanan') {
        try {
            const bulanCari = data.bulan;
            const rekap = await generateRekapBulanan(sheet, bulanCari);

            let teks = '*Laporan Bulan: ' + bulanCari + '*\n\n';
            teks += '```\nTGL   | TIPE   | NOMINAL           | KET\n';
            teks += '-------------------------------------------------------\n';
            if (rekap.listTransaksi.length === 0) {
                teks += '(Belum ada data)\n';
            } else {
                rekap.listTransaksi.forEach(tx => { teks += tx + '\n'; });
            }
            teks += '-------------------------------------------------------```\n\n';
            teks += 'Total Pemasukan : Rp' + rekap.totalPemasukan.toLocaleString('id-ID') + '\n';
            teks += 'Total Pengeluaran: Rp' + rekap.totalPengeluaran.toLocaleString('id-ID') + '\n';
            teks += '*Saldo Bersih   : Rp' + rekap.saldo.toLocaleString('id-ID') + '*\n\n';
            teks += '*Spreadsheet:*\nhttps://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID;
            if (PUBLIC_URL) {
                teks += '\n\n*Dashboard Visual:*\n' + PUBLIC_URL + '/dashboard?bulan=' + encodeURIComponent(bulanCari);
            }

            await msg.reply(teks).catch(e => console.error('Reply error: ' + e.message));
            console.log('Sent monthly report');
        } catch (err) {
            console.error('Rekap error: ' + err.message);
            await msg.reply('Gagal mengambil rekap: ' + err.message)
                .catch(e => console.error('Reply error: ' + e.message));
        }
        return;
    }

    // CEK SALDO
    if (data.command === 'cek_saldo_sekarang' || data.command === 'cek_saldo_tanggal') {
        try {
            const tglCari = data.command === 'cek_saldo_tanggal' ? data.tanggal : null;
            const rekapS = await hitungSaldo(sheet, tglCari);
            const judul = tglCari ? '*Saldo Tanggal ' + tglCari + '*' : '*Posisi Saldo Saat Ini*';

            await msg.reply(
                judul + '\n\n' +
                'Pemasukan  : Rp' + rekapS.totalPemasukan.toLocaleString('id-ID') + '\n' +
                'Pengeluaran: Rp' + rekapS.totalPengeluaran.toLocaleString('id-ID') + '\n' +
                '*Saldo     : Rp' + rekapS.saldo.toLocaleString('id-ID') + '*'
            ).catch(e => console.error('Reply error: ' + e.message));
            console.log('Sent balance info');
        } catch (err) {
            console.error('Saldo error: ' + err.message);
            await msg.reply('Gagal mengambil saldo: ' + err.message)
                .catch(e => console.error('Reply error: ' + e.message));
        }
        return;
    }

    // SIMPAN TRANSAKSI
    if (data.nominal !== undefined) {
        const parsedNominal = parseFloat(data.nominal);

        if (isNaN(parsedNominal) || parsedNominal <= 0) {
            console.warn('Invalid nominal: ' + data.nominal);
            await msg.reply('Nominal tidak valid atau nol. Coba lagi dengan nominal yang jelas.')
                .catch(e => console.error('Reply error: ' + e.message));
            return;
        }

        try {
            const rekapNow = await hitungSaldo(sheet);
            const tipeTx = data.tipe ? data.tipe.toUpperCase() : '';
            let saldoBaru = rekapNow.saldo;

            if (tipeTx === 'PEMASUKAN' || tipeTx === 'DEBIT') saldoBaru += parsedNominal;
            else if (tipeTx === 'PENGELUARAN' || tipeTx === 'CREDIT') saldoBaru -= parsedNominal;

            const now = new Date();
            const hariIni = formatDateID(now);
            const jamNow = formatTimeLocal(now);

            await sheet.addRow({
                Tanggal: hariIni + ', ' + jamNow,
                Deskripsi: sanitizeCell(data.deskripsi || ''),
                Nominal: parsedNominal,
                Tipe: sanitizeCell(data.tipe || ''),
                User: sanitizeCell(msg.pushname || msg.from),
                'Saldo Akhir': saldoBaru,
            });

            await msg.reply(
                '*Data Tersimpan!*\n' +
                'Ket    : ' + data.deskripsi + '\n' +
                'Nominal: Rp' + parsedNominal.toLocaleString('id-ID') + '\n' +
                'Tipe   : ' + data.tipe + '\n\n' +
                '*Sisa Saldo: Rp' + saldoBaru.toLocaleString('id-ID') + '*'
            ).catch(e => console.error('Reply error: ' + e.message));
            console.log('Transaction saved: ' + data.tipe + ' Rp' + parsedNominal);
        } catch (err) {
            console.error('Transaction save error: ' + err.message);
            await msg.reply('Gagal menyimpan transaksi: ' + err.message)
                .catch(e => console.error('Reply error: ' + e.message));
        }
        return;
    }

    console.warn('Unrecognised AI response: ' + JSON.stringify(data));
}

async function handleWebhookForward(msg) {
    if (!WEBHOOK_URL) return;
    if (!msg.body && !msg.hasMedia) return;

    const [contact, chat] = await Promise.all([
        msg.getContact().catch(() => null),
        msg.getChat().catch(() => null),
    ]);

    const payload = {
        event: 'message',
        timestamp: Date.now(),
        message: {
            id: msg.id._serialized,
            from: msg.from,
            to: msg.to,
            body: msg.body || '',
            type: msg.type,
            hasMedia: msg.hasMedia,
            isGroup: msg.from.endsWith('@g.us'),
            isForwarded: msg.isForwarded,
            timestamp: msg.timestamp,
        },
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
        } catch (e) {
            console.warn('Media download failed: ' + e.message);
        }
    }

    console.log('[' + msg.from + '] ' + msg.type + ': ' + (msg.body || '(media)'));
    fireWebhook(payload);
}

// ─── HTTP ROUTES ──────────────────────────────────────────────────────────────
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) {
    console.warn('"qrcode" package not found. Run: npm install qrcode');
}

app.get('/', (req, res) => {
    const emoji = { starting: '...', qr_ready: '[QR]', authenticated: '[AUTH]', ready: '[OK]', disconnected: '[X]' }[botStatus] || '?';
    const hints = {
        qr_ready: 'Scan QR code di bawah ini menggunakan WhatsApp Anda.',
        ready: 'Bot is online and ready to send/receive messages.',
        disconnected: 'Lost connection - reconnecting automatically...',
        starting: 'Starting up, please wait...',
        authenticated: 'Authenticated - loading WhatsApp session...',
    };
    let qrHtml = '';
    if (botStatus === 'qr_ready' && qrData) {
        qrHtml = `<div style="margin:25px 0;padding:20px;border:2px dashed #cbd5e1;border-radius:12px;background:#f8fafc;">
            <p style="margin-bottom:15px;font-weight:bold;color:#334155;">Scan QR Code:</p>
            <img src="/api/qr" alt="QR Code" style="width:250px;height:250px;border:10px solid white;box-shadow:0 4px 12px rgba(0,0,0,0.1);border-radius:8px;"
                 onerror="this.style.display='none';document.getElementById('qrerr').style.display='block'" />
            <p id="qrerr" style="display:none;color:#dc2626;margin-top:10px;">QR image failed - run: <code>npm install qrcode</code></p>
            <p style="margin-top:15px;font-size:0.8rem;color:#64748b;">Auto-refreshes every 10s. Or open <a href="/api/qr">/api/qr</a> directly.</p>
        </div>`;
    }
    res.send(`<!DOCTYPE html><html lang="en"><head><title>WhatsApp Bot</title><meta http-equiv="refresh" content="10"><meta charset="UTF-8">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:white;border-radius:16px;padding:40px;max-width:600px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{color:#111;font-size:1.4rem;margin-bottom:24px}.si{font-size:3.5rem;margin:16px 0}.badge{padding:8px 20px;border-radius:100px;display:inline-block;font-weight:600;font-size:.85rem;text-transform:uppercase}.ready{background:#dcfce7;color:#166534}.qr_ready{background:#fef9c3;color:#854d0e}.starting,.authenticated{background:#dbeafe;color:#1e40af}.disconnected{background:#fee2e2;color:#991b1b}.hint{margin-top:16px;color:#6b7280;font-size:.9rem;line-height:1.6}.meta{margin-top:24px;padding-top:24px;border-top:1px solid #f0f0f0;display:flex;justify-content:space-around;flex-wrap:wrap;gap:12px}.mi{font-size:.8rem;color:#9ca3af}.mi strong{display:block;color:#374151;font-size:.9rem;margin-bottom:2px}.api{margin-top:24px;padding-top:24px;border-top:1px solid #f0f0f0;text-align:left;font-size:.8rem;color:#6b7280;line-height:2}.api code{background:#f4f4f5;padding:2px 6px;border-radius:4px;font-size:.75rem}</style></head>
    <body><div class="card">
    <h1>WhatsApp Bot API</h1>
    <div class="si">${emoji}</div>
    <div class="badge ${botStatus}">${botStatus.replace('_', ' ')}</div>
    <p class="hint">${hints[botStatus] || ''}</p>
    ${qrHtml}
    <div class="meta">
      <div class="mi"><strong>${SESSION_NAME}</strong>Session</div>
      <div class="mi"><strong>${formatUptime((Date.now() - startTime) / 1000)}</strong>Uptime</div>
      <div class="mi"><strong>${IS_PROD ? 'Production' : 'Development'}</strong>Env</div>
      <div class="mi"><strong>${sessionSavedAt || 'Pending...'}</strong>Last Backup</div>
      <div class="mi"><strong>${WEBHOOK_URL ? 'Set' : 'Not set'}</strong>Webhook</div>
    </div>
    <div class="api">
      <strong>API Endpoints</strong> - Header: <code>x-api-key: YOUR_KEY</code><br><br>
      <code>GET  /api/health</code>         - Health check (no auth)<br>
      <code>GET  /api/qr</code>             - QR code PNG (no auth)<br>
      <code>GET  /api/status</code>         - Bot status<br>
      <code>POST /api/send/text</code>      - Send text message<br>
      <code>POST /api/send/image</code>     - Send image<br>
      <code>POST /api/send/file</code>      - Send file/document<br>
      <code>POST /api/send/audio</code>     - Send audio / voice note<br>
      <code>POST /api/send/location</code>  - Send location pin<br>
    </div>
    </div></body></html>`);
});

app.get('/api/qr', async (req, res) => {
    if (!qrData) return res.status(404).json({ success: false, error: 'No QR available' });
    if (!QRCode) return res.redirect('https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qrData));
    try {
        const png = await QRCode.toBuffer(qrData, { type: 'png', width: 300, margin: 2 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(png);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/health', (req, res) =>
    res.status(200).json({ success: true, status: botStatus, uptime: formatUptime((Date.now() - startTime) / 1000) })
);
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/_health', (req, res) => res.status(200).send('ok'));

app.get('/api/status', requireApiKey, (req, res) => {
    res.json({
        success: true, status: botStatus, session: SESSION_NAME,
        environment: IS_PROD ? 'production' : 'development',
        uptime: formatUptime((Date.now() - startTime) / 1000),
        lastBackup: sessionSavedAt,
        webhookConfigured: !!WEBHOOK_URL,
    });
});

app.post('/api/send/text', requireApiKey, requireReady, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: 'Missing: to, message' });
    try {
        const chatId = normalizePhone(to);
        const sent = await withTimeout(waClient.sendMessage(chatId, message), 30000, 'sendMessage');
        console.log('Text -> ' + chatId);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error('Send text error: ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/image', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia(mime || 'image/jpeg', base64, filename || 'image.jpg');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { caption: caption || '' }), 30000, 'sendImage');
        console.log('Image -> ' + chatId);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error('Send image error: ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/file', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia(mime || 'application/octet-stream', base64, filename || 'file');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { sendMediaAsDocument: true, caption: caption || '' }), 30000, 'sendFile');
        console.log('File -> ' + chatId);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error('Send file error: ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/audio', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, ptt } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, and either url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia('audio/ogg; codecs=opus', base64, 'audio.ogg');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { sendAudioAsVoice: ptt !== false }), 30000, 'sendAudio');
        console.log('Audio -> ' + chatId);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error('Send audio error: ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send/location', requireApiKey, requireReady, async (req, res) => {
    const { to, latitude, longitude, description } = req.body;
    if (!to || latitude == null || longitude == null)
        return res.status(400).json({ success: false, error: 'Missing: to, latitude, longitude' });
    try {
        const chatId = normalizePhone(to);
        const loc = new Location(parseFloat(latitude), parseFloat(longitude), description || '');
        const sent = await withTimeout(waClient.sendMessage(chatId, loc), 30000, 'sendLocation');
        console.log('Location -> ' + chatId);
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) {
        console.error('Send location error: ' + err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/chats', requireApiKey, requireReady, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const chats = await waClient.getChats();
        const page = chats.slice(offset, offset + limit);
        res.json({
            success: true, total: chats.length, limit, offset,
            chats: page.map(c => ({ id: c.id._serialized, name: c.name, isGroup: c.isGroup, unreadCount: c.unreadCount, timestamp: c.timestamp })),
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/contacts', requireApiKey, requireReady, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const contacts = await waClient.getContacts();
        const page = contacts.slice(offset, offset + limit);
        res.json({
            success: true, total: contacts.length, limit, offset,
            contacts: page.map(c => ({ id: c.id._serialized, name: c.name || c.pushname || '', number: c.number, isMyContact: c.isMyContact })),
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/groups', requireApiKey, requireReady, async (req, res) => {
    try {
        const chats = await waClient.getChats();
        const groups = chats.filter(c => c.isGroup);
        res.json({
            success: true, count: groups.length,
            groups: groups.map(g => ({ id: g.id._serialized, name: g.name, participantCount: g.participants ? g.participants.length : 0 })),
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── DASHBOARD ROUTE ─────────────────────────────────────────────────────────
// Public (no auth) — the link is sent via WhatsApp which is already access-controlled.
// GET /dashboard?bulan=MM/YYYY   renders a live HTML financial report
app.get('/dashboard', async (req, res) => {
    const bulan = (req.query.bulan || '').trim();
    // Validate format MM/YYYY
    if (!/^\d{2}\/\d{4}$/.test(bulan)) {
        return res.status(400).send('<p style="font-family:monospace;padding:20px">Format bulan salah. Gunakan: /dashboard?bulan=02/2026</p>');
    }
    try {
        const sheet = await getSheet();
        const rekap = await generateRekapBulanan(sheet, bulan);
        const saldo = rekap.saldo;
        const total = rekap.totalPemasukan + rekap.totalPengeluaran;
        const inPct = total > 0 ? (rekap.totalPemasukan / total * 100).toFixed(1) : '0.0';
        const outPct = total > 0 ? (rekap.totalPengeluaran / total * 100).toFixed(1) : '0.0';
        const savPct = rekap.totalPemasukan > 0 ? (saldo / rekap.totalPemasukan * 100).toFixed(0) : '0';

        // Build transaction rows from raw sheet for this month
        const allRows = await sheet.getRows();
        const txRows = [];
        allRows.forEach(row => {
            const tgl = row.get('Tanggal');
            if (!tgl) return;
            const tglFull = tgl.toString();
            const tglHari = tglFull.includes(',') ? tglFull.split(',')[0].trim() : tglFull.trim();
            const jam = tglFull.includes(',') ? tglFull.split(',')[1].trim() : '';
            if (!tglHari.endsWith(bulan)) return;
            const nominal = parseInt((row.get('Nominal') || '0').toString().replace(/\D/g, ''), 10) || 0;
            const tipe = (row.get('Tipe') || '').toString().toUpperCase();
            const desc = (row.get('Deskripsi') || '').toString();
            txRows.push({ tgl: tglHari, jam, desc, nominal, tipe });
        });
        // Sort by jam desc
        txRows.sort((a, b) => b.jam.localeCompare(a.jam));

        const C = 238.76;
        const expenseArc = total > 0 ? (rekap.totalPengeluaran / total * C).toFixed(2) : 0;
        const incomeArc = total > 0 ? (rekap.totalPemasukan / total * C).toFixed(2) : 0;

        function rupiah(n) {
            return 'Rp' + Math.abs(n).toLocaleString('id-ID');
        }

        const txHtml = txRows.map(tx => {
            const isIn = tx.tipe === 'PEMASUKAN';
            const iconMap = { gaji: '💰', angsuran: '🏠', bayar: '💸', iuran: '👥', tambahan: '➕', arisan: '🤝', makan: '🍜', listrik: '💡', bensin: '⛽', pulsa: '📱' };
            let icon = '📋';
            const dl = tx.desc.toLowerCase();
            for (const [k, v] of Object.entries(iconMap)) { if (dl.includes(k)) { icon = v; break; } }
            return `<div class="tx-item">
              <div class="tx-icon ${isIn ? 'in' : 'out'}">${icon}</div>
              <div class="tx-info">
                <div class="tx-desc">${tx.desc}</div>
                <div class="tx-time">${tx.tgl} &bull; ${tx.jam.replace(/\./g, ':')}</div>
              </div>
              <div class="tx-amount ${isIn ? 'in' : 'out'}">${rupiah(tx.nominal)}</div>
            </div>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laporan ${bulan}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0d0f14;--surface:#161922;--border:#242834;--text:#e8eaf0;--muted:#5a6180;--income:#36e8a0;--expense:#ff5f7e;--accent:#7c6cfc;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;min-height:100vh;}
body::before{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");pointer-events:none;z-index:0;opacity:.6;}
.wrap{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:40px 24px 80px;}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;gap:16px;flex-wrap:wrap;}
.header-title{font-family:'Syne',sans-serif;font-size:clamp(1.6rem,4vw,2.4rem);font-weight:800;letter-spacing:-.03em;line-height:1.1;}
.header-title span{display:block;font-size:.45em;font-weight:400;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px;font-family:'DM Mono',monospace;}
.header-date{font-size:.72rem;color:var(--muted);text-align:right;line-height:1.8;}
.header-date strong{display:block;font-size:.85rem;color:var(--text);font-family:'Syne',sans-serif;font-weight:700;}
.saldo-card{background:linear-gradient(135deg,#1a1d2e,#1e2235,#191d2c);border:1px solid var(--border);border-radius:20px;padding:32px 36px;margin-bottom:24px;position:relative;overflow:hidden;animation:fadeUp .5s ease both;}
.saldo-card::after{content:'';position:absolute;top:-60px;right:-60px;width:220px;height:220px;background:radial-gradient(circle,rgba(124,108,252,.18),transparent 70%);pointer-events:none;}
.saldo-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-bottom:10px;}
.saldo-amount{font-family:'Syne',sans-serif;font-size:clamp(2rem,6vw,3.6rem);font-weight:800;letter-spacing:-.04em;line-height:1;margin-bottom:6px;}
.positive{color:var(--income);} .negative{color:var(--expense);}
.saldo-sub{font-size:.72rem;color:var(--muted);}
.saldo-pills{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;}
.pill{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:100px;padding:7px 14px;font-size:.72rem;}
.pill-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.pill-dot.in{background:var(--income);box-shadow:0 0 6px var(--income);}
.pill-dot.out{background:var(--expense);box-shadow:0 0 6px var(--expense);}
.pill strong{color:var(--text);}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;}
@media(max-width:580px){.grid{grid-template-columns:1fr;}}
.stat-card{border:1px solid var(--border);border-radius:16px;padding:24px 26px;position:relative;overflow:hidden;animation:fadeUp .5s ease both;transition:transform .2s,box-shadow .2s;}
.stat-card:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(0,0,0,.4);}
.stat-card.income{background:linear-gradient(135deg,#111a18,#161e1c);}
.stat-card.expense{background:linear-gradient(135deg,#1a1116,#1e1518);}
.stat-icon{font-size:1.4rem;margin-bottom:14px;display:block;}
.stat-label{font-size:.65rem;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:6px;}
.stat-value{font-family:'Syne',sans-serif;font-size:clamp(1.2rem,3vw,1.7rem);font-weight:700;letter-spacing:-.02em;line-height:1.1;}
.stat-value.income{color:var(--income);} .stat-value.expense{color:var(--expense);}
.stat-count{font-size:.68rem;color:var(--muted);margin-top:6px;}
.stat-bar{height:3px;border-radius:2px;margin-top:16px;background:rgba(255,255,255,.06);overflow:hidden;}
.stat-bar-fill{height:100%;border-radius:2px;transition:width 1.2s cubic-bezier(.16,1,.3,1);}
.stat-bar-fill.income{background:var(--income);} .stat-bar-fill.expense{background:var(--expense);}
.donut-card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:32px;margin-bottom:24px;animation:fadeUp .6s ease both;}
.donut-card-title{font-family:'Syne',sans-serif;font-size:.85rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:28px;}
.donut-layout{display:flex;align-items:center;gap:40px;flex-wrap:wrap;justify-content:center;}
.donut-wrap{position:relative;width:200px;height:200px;flex-shrink:0;}
.donut-svg{width:100%;height:100%;transform:rotate(-90deg);}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;}
.donut-center-pct{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;color:var(--text);line-height:1;}
.donut-center-label{font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-top:4px;}
.donut-legend{display:flex;flex-direction:column;gap:20px;min-width:200px;}
.legend-item{display:flex;flex-direction:column;gap:6px;}
.legend-header{display:flex;align-items:center;gap:10px;}
.legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
.legend-dot.in{background:var(--income);box-shadow:0 0 8px var(--income);}
.legend-dot.out{background:var(--expense);box-shadow:0 0 8px var(--expense);}
.legend-name{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;}
.legend-amount{font-family:'Syne',sans-serif;font-size:1.15rem;font-weight:700;letter-spacing:-.02em;padding-left:20px;}
.legend-amount.in{color:var(--income);} .legend-amount.out{color:var(--expense);}
.legend-pct{font-size:.65rem;color:var(--muted);padding-left:20px;}
.tx-card{background:var(--surface);border:1px solid var(--border);border-radius:20px;overflow:hidden;animation:fadeUp .7s ease both;}
.tx-header{display:flex;justify-content:space-between;align-items:center;padding:24px 28px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px;}
.tx-header-title{font-family:'Syne',sans-serif;font-size:.85rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);}
.tx-count{background:rgba(255,255,255,.05);border:1px solid var(--border);border-radius:100px;padding:3px 10px;font-size:.65rem;color:var(--muted);}
.tx-list{padding:8px 0;}
.tx-item{display:flex;align-items:center;gap:16px;padding:14px 28px;border-bottom:1px solid rgba(255,255,255,.03);transition:background .15s;}
.tx-item:last-child{border-bottom:none;}
.tx-item:hover{background:rgba(255,255,255,.025);}
.tx-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;}
.tx-icon.in{background:rgba(54,232,160,.1);color:var(--income);}
.tx-icon.out{background:rgba(255,95,126,.1);color:var(--expense);}
.tx-info{flex:1;min-width:0;}
.tx-desc{font-size:.8rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize;margin-bottom:3px;}
.tx-time{font-size:.62rem;color:var(--muted);}
.tx-amount{font-family:'Syne',sans-serif;font-size:.9rem;font-weight:700;white-space:nowrap;text-align:right;}
.tx-amount.in{color:var(--income);} .tx-amount.out{color:var(--expense);}
.tx-amount.in::before{content:'+';}  .tx-amount.out::before{content:'-';}
.footer{text-align:center;margin-top:48px;font-size:.62rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
.saldo-card{animation-delay:.05s;} .stat-card:nth-child(1){animation-delay:.1s;} .stat-card:nth-child(2){animation-delay:.15s;} .donut-card{animation-delay:.2s;} .tx-card{animation-delay:.25s;}
.donut-ring{transition:stroke-dashoffset 1.4s cubic-bezier(.16,1,.3,1);}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="header-title">
      <span>Laporan Keuangan</span>
      Ringkasan<br>Bulanan
    </div>
    <div class="header-date">
      <strong>${bulan}</strong>
      Diperbarui: ${new Date().toLocaleString('id-ID')}
    </div>
  </div>

  <div class="saldo-card">
    <div class="saldo-label">Saldo Bersih</div>
    <div class="saldo-amount ${saldo >= 0 ? 'positive' : 'negative'}">${rupiah(saldo)}</div>
    <div class="saldo-sub">Total semua transaksi bulan ${bulan}</div>
    <div class="saldo-pills">
      <div class="pill"><span class="pill-dot in"></span><span>Pemasukan: <strong>${rupiah(rekap.totalPemasukan)}</strong></span></div>
      <div class="pill"><span class="pill-dot out"></span><span>Pengeluaran: <strong>${rupiah(rekap.totalPengeluaran)}</strong></span></div>
    </div>
  </div>

  <div class="grid">
    <div class="stat-card income">
      <span class="stat-icon">↑</span>
      <div class="stat-label">Total Pemasukan</div>
      <div class="stat-value income">${rupiah(rekap.totalPemasukan)}</div>
      <div class="stat-count">${txRows.filter(t => t.tipe === 'PEMASUKAN').length} transaksi</div>
      <div class="stat-bar"><div class="stat-bar-fill income" id="bar-in" style="width:0%"></div></div>
    </div>
    <div class="stat-card expense">
      <span class="stat-icon">↓</span>
      <div class="stat-label">Total Pengeluaran</div>
      <div class="stat-value expense">${rupiah(rekap.totalPengeluaran)}</div>
      <div class="stat-count">${txRows.filter(t => t.tipe === 'PENGELUARAN').length} transaksi</div>
      <div class="stat-bar"><div class="stat-bar-fill expense" id="bar-out" style="width:0%"></div></div>
    </div>
  </div>

  <div class="donut-card">
    <div class="donut-card-title">Distribusi Keuangan</div>
    <div class="donut-layout">
      <div class="donut-wrap">
        <svg class="donut-svg" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="38" fill="none" stroke="#242834" stroke-width="14"/>
          <circle id="donut-exp" cx="50" cy="50" r="38" fill="none" stroke="#ff5f7e" stroke-width="14"
            stroke-dasharray="0 238.76" stroke-linecap="round" class="donut-ring"
            style="filter:drop-shadow(0 0 4px rgba(255,95,126,.5))"/>
          <circle id="donut-inc" cx="50" cy="50" r="38" fill="none" stroke="#36e8a0" stroke-width="14"
            stroke-dasharray="0 238.76" stroke-linecap="round" class="donut-ring"
            style="filter:drop-shadow(0 0 4px rgba(54,232,160,.5))"/>
        </svg>
        <div class="donut-center">
          <div class="donut-center-pct">${savPct}%</div>
          <div class="donut-center-label">Tabungan</div>
        </div>
      </div>
      <div class="donut-legend">
        <div class="legend-item">
          <div class="legend-header"><span class="legend-dot in"></span><span class="legend-name">Pemasukan</span></div>
          <div class="legend-amount in">${rupiah(rekap.totalPemasukan)}</div>
          <div class="legend-pct">${inPct}% dari total arus</div>
        </div>
        <div class="legend-item">
          <div class="legend-header"><span class="legend-dot out"></span><span class="legend-name">Pengeluaran</span></div>
          <div class="legend-amount out">${rupiah(rekap.totalPengeluaran)}</div>
          <div class="legend-pct">${outPct}% dari total arus</div>
        </div>
        <div class="legend-item">
          <div class="legend-header"><span class="legend-dot" style="background:var(--accent);box-shadow:0 0 8px var(--accent)"></span><span class="legend-name">Saldo Bersih</span></div>
          <div class="legend-amount" style="color:var(--accent)">${rupiah(saldo)}</div>
          <div class="legend-pct">${savPct}% dari pemasukan tersisa</div>
        </div>
      </div>
    </div>
  </div>

  <div class="tx-card">
    <div class="tx-header">
      <div class="tx-header-title">Riwayat Transaksi</div>
      <div class="tx-count">${txRows.length} transaksi</div>
    </div>
    <div class="tx-list">${txHtml}</div>
  </div>

  <div class="footer">wabot &bull; laporan otomatis &bull; ${new Date().toLocaleString('id-ID')}</div>
</div>
<script>
const C=${C}, exp=${expenseArc}, inc=${incomeArc};
const total=${total};
setTimeout(()=>{
  if(total>0){
    document.getElementById('donut-exp').setAttribute('stroke-dasharray', exp+' '+(C-exp));
    document.getElementById('donut-exp').setAttribute('stroke-dashoffset','0');
    document.getElementById('donut-inc').setAttribute('stroke-dasharray', inc+' '+(C-inc));
    document.getElementById('donut-inc').setAttribute('stroke-dashoffset', -exp);
  }
  const bigger=Math.max(${rekap.totalPemasukan},${rekap.totalPengeluaran});
  if(bigger>0){
    document.getElementById('bar-in').style.width=(${rekap.totalPemasukan}/bigger*100)+'%';
    document.getElementById('bar-out').style.width=(${rekap.totalPengeluaran}/bigger*100)+'%';
  }
},300);
</script>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(html);
    } catch (err) {
        console.error('Dashboard error: ' + err.message);
        res.status(500).send('<p style="font-family:monospace;padding:20px;color:#ff5f7e">Error: ' + err.message + '</p>');
    }
});

app.listen(PORT, '0.0.0.0', () => console.log('Web server -> http://0.0.0.0:' + PORT));

// ─── WHATSAPP CLIENT ──────────────────────────────────────────────────────────
async function start() {
    if (isStarting) { console.warn('start() already running - skipping'); return; }
    isStarting = true;
    isReady = false;
    qrData = null;
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }

    try {
        fs.mkdirSync(DATA_PATH, { recursive: true });
        fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });
        clearLocalCache();

        console.log('Connecting to MongoDB...');
        if (mongoose.connection.readyState !== 0) await mongoose.connection.close().catch(() => { });
        await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
        console.log('MongoDB connected');

        const store = createFixedStore(mongoose);
        const sessionExists = await store.sessionExists({ session: SESSION_DIR_NAME });
        let validSession = false;

        if (sessionExists) {
            const col = mongoose.connection.db.collection('whatsapp-' + SESSION_DIR_NAME + '.files');
            const files = await col.find({ filename: { $regex: '^' + SESSION_DIR_NAME + '\\.zip\\.' } }).toArray();
            const slots = files.sort((a, b) => b.uploadDate - a.uploadDate);
            const bestSlot = slots.find(f => f.length >= 1000);
            if (!bestSlot) {
                console.warn('All ' + slots.length + ' slot(s) corrupted - rescanning QR');
                await store.delete({ session: SESSION_DIR_NAME });
            } else {
                console.log('Session found: ' + slots.length + ' slot(s), best: ' + (bestSlot.length / 1024).toFixed(1) + ' KB');
                validSession = true;
            }
        } else {
            console.log('No session in MongoDB - QR scan required');
        }

        const client = new Client({
            authStrategy: new RemoteAuth({
                clientId: SESSION_NAME,
                dataPath: DATA_PATH,
                store: store,
                backupSyncIntervalMs: BACKUP_INTERVAL,
            }),
            puppeteer: puppeteerConfig,
            authTimeoutMs: 120000,
        });

        currentClient = client;

        client.on('loading_screen', (percent, message) =>
            console.log('Loading: ' + percent + '% - ' + message)
        );

        client.on('qr', qr => {
            botStatus = 'qr_ready';
            qrData = qr;
            if (validSession) console.warn('Session restore failed - scan fresh QR');
            console.log('\n-------------------------------------------');
            console.log('Scan QR: open the web UI or hit /api/qr');
            console.log('Settings -> Linked Devices -> Link a Device');
            console.log('-------------------------------------------\n');
            qrcode.generate(qr, { small: true });
            console.log('-------------------------------------------\n');
        });

        client.on('authenticated', () => {
            if (!isReady) {
                botStatus = 'authenticated';
                readyWatchdog = setTimeout(() => {
                    if (!isReady) {
                        console.error('Watchdog: authenticated but never ready after 3min - restarting');
                        scheduleRestart(5000);
                    }
                }, 3 * 60 * 1000);
            }
            qrData = null;
            console.log('Authenticated!');
        });

        client.on('auth_failure', msg => {
            botStatus = 'disconnected';
            qrData = null;
            console.error('Auth failed: ' + msg);
            scheduleRestart(10000);
        });

        client.on('ready', () => {
            if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
            botStatus = 'ready';
            waClient = client;
            if (isReady) { console.log('WA internal refresh - still ready'); return; }
            isReady = true;
            console.log('Bot is ready!');
            if (!validSession) console.log('New session - first backup in ~60s. Do NOT restart!');
            else console.log('Re-backup every ' + (BACKUP_INTERVAL / 1000) + 's');
        });

        client.on('remote_session_saved', () => {
            sessionSavedAt = formatTime(new Date());
            console.log('Session backed up to MongoDB at ' + sessionSavedAt);
        });

        client.on('disconnected', reason => {
            botStatus = 'disconnected';
            waClient = null;
            isReady = false;
            isStarting = false;
            if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
            console.warn('Disconnected: ' + reason);
            scheduleRestart(10000);
        });

        // ── MAIN MESSAGE HANDLER ──────────────────────────────────────────────
        client.on('message', async msg => {
            if (msg.from === 'status@broadcast') return;
            if (ALLOWED_CHATS.length > 0 && !ALLOWED_CHATS.includes(msg.from)) return;

            // Phase 1: Finance logic
            try {
                await handleFinanceMessage(msg);
            } catch (err) {
                console.error('handleFinanceMessage unhandled error: ' + err.message);
                await msg.reply('Terjadi kesalahan tidak terduga: ' + err.message)
                    .catch(e => console.error('Reply error: ' + e.message));
            }

            // Phase 2: Webhook forwarding (independent, never blocks finance logic)
            handleWebhookForward(msg).catch(err =>
                console.error('handleWebhookForward error: ' + err.message)
            );
        });

        client.on('message_reaction', reaction => {
            fireWebhook({
                event: 'reaction',
                timestamp: Date.now(),
                reaction: {
                    id: reaction.id._serialized,
                    from: reaction.senderId,
                    emoji: reaction.reaction,
                    messageId: reaction.msgId._serialized,
                },
            });
        });

        console.log('Initializing WhatsApp client...');
        botStatus = 'starting';
        await client.initialize();

    } catch (err) {
        console.error('Startup error: ' + err.message);
        isStarting = false;
        scheduleRestart(15000);
    }
}

async function scheduleRestart(ms) {
    console.log('Restarting in ' + (ms / 1000) + 's...');
    waClient = null;
    isStarting = false;
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    if (currentClient) {
        try { await currentClient.destroy(); } catch (e) { /* ignore */ }
        currentClient = null;
    }
    try { await mongoose.connection.close(); } catch (e) { /* ignore */ }
    setTimeout(start, ms);
}

// ─── GLOBAL ERROR GUARDS ──────────────────────────────────────────────────────

// Silently swallow - these are normal filesystem races:
//   ENOENT: zip already deleted, dir already gone - happens every backup cycle on Railway
//   EACCES/unlink: permission race on cleanup
const SILENT_IGNORABLE = [
    e => e && e.code === 'ENOENT',
    e => e && e.code === 'EACCES' && e.syscall === 'unlink',
];

// Log a warning but don't restart - browser/mongo lifecycle noise
const WARN_IGNORABLE = [
    e => e && e.message && e.message.includes('Execution context was destroyed'),
    e => e && e.message && e.message.includes('Target closed'),
    e => e && e.message && e.message.includes('Session closed'),
    e => e && e.message && e.message.includes('Protocol error'),
    e => e && e.message && e.message.includes('Operation interrupted because client was closed'),
    e => e && e.message && e.message.includes('Cannot use a session that has ended'),
    e => e && e.message && e.message.includes('connection from closed connection pool'),
    e => e && e.message && e.message.includes('Topology is closed'),
];

function classifyError(err) {
    if (SILENT_IGNORABLE.some(fn => fn(err))) return 'silent';
    if (WARN_IGNORABLE.some(fn => fn(err))) return 'warn';
    return 'fatal';
}

process.on('uncaughtException', err => {
    const level = classifyError(err);
    if (level === 'silent') return;                                              // no log at all
    if (level === 'warn') { console.warn('Ignored uncaughtException: ' + err.message); return; }
    console.error('uncaughtException: ' + err.message);
    if (!isReady) scheduleRestart(10000);
});

process.on('unhandledRejection', reason => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const level = classifyError(err);
    if (level === 'silent') return;                                              // no log at all
    if (level === 'warn') { console.warn('Ignored unhandledRejection: ' + err.message); return; }
    console.error('unhandledRejection: ' + err.message);
    if (!isReady) scheduleRestart(10000);
});

start();