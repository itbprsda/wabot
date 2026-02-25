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
const REQUIRED_ENV = ['MONGODB_URI', 'GEMINI_API_KEY', 'HF_TOKEN', 'GOOGLE_CREDS_JSON', 'SPREADSHEET_ID'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
    console.error('   Set them in your .env file or Railway environment settings.');
    process.exit(1);
}

// ─── LOAD GOOGLE CREDENTIALS ──────────────────────────────────────────────
let creds;
try {
    creds = JSON.parse(process.env.GOOGLE_CREDS_JSON);
    if (!creds.client_email || !creds.private_key) {
        throw new Error('Missing client_email or private_key in GOOGLE_CREDS_JSON');
    }
    console.log(`✅ Google creds loaded for: ${creds.client_email}`);
} catch (e) {
    console.error(`❌ Failed to parse GOOGLE_CREDS_JSON: ${e.message}`);
    console.error('   Make sure the value is the full JSON content of your google-creds.json file.');
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

// Parse allowed chats once at startup (not per-message)
const ALLOWED_CHATS = (process.env.ALLOWED_CHATS || '6287759895339-1608597951@g.us')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

// Rate limiting: cooldown per sender in ms
const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '3000', 10);

const IS_PROD = !!process.env.PUPPETEER_EXECUTABLE_PATH;

const MAX_MEDIA_WEBHOOK_BYTES = 5 * 1024 * 1024;
const MAX_WEBHOOK_ATTEMPTS = 3;
const BACKUP_INTERVAL = IS_PROD ? 5 * 60 * 1000 : 60 * 1000;

const DATA_PATH = IS_PROD ? path.resolve('/app/.wwebjs_auth') : path.resolve(process.cwd(), '.wwebjs_auth');
const CHROME_DATA_DIR = IS_PROD ? path.resolve('/tmp/.chrome-data') : path.resolve(process.cwd(), '.chrome-data');
const SESSION_DIR_NAME = `RemoteAuth-${SESSION_NAME}`;

// ─── STARTUP LOGS ─────────────────────────────────────────────────────────────
if (API_KEY === 'changeme') {
    console.warn('⚠️  API_KEY is using the default value — set a strong key in env!');
}
console.log(`🌍 Environment  : ${IS_PROD ? 'Production (Railway/Docker)' : 'Development (Local)'}`);
console.log(`📛 Session name : ${SESSION_NAME}`);
console.log(`⏱️  Backup every : ${BACKUP_INTERVAL / 1000}s`);
console.log(`🔑 API Key      : ${API_KEY === 'changeme' ? '⚠️  DEFAULT' : '✅ Set'}`);
console.log(`🪝 Webhook URL  : ${WEBHOOK_URL || '❌ Not set'}`);
console.log(`🌐 Port         : ${PORT}`);
console.log(`👥 Allowed Chats: ${ALLOWED_CHATS.length > 0 ? ALLOWED_CHATS.join(', ') : 'All'}`);
console.log(`⏳ Rate Limit   : ${RATE_LIMIT_MS}ms per sender`);

// ─── GOOGLE AUTH / SHEETS ─────────────────────────────────────────────────────
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// ─── AI CLIENTS ───────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
const inference = new HfInference(HF_TOKEN);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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

/**
 * Safe date formatter that doesn't rely on locale availability.
 * Returns DD/MM/YYYY
 */
function formatDateID(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Safe time formatter that doesn't rely on locale availability.
 * Returns HH:MM:SS
 */
function formatTimeLocal(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

/**
 * Prefix cell values to prevent spreadsheet formula injection.
 * Strings starting with =, +, -, @ are prefixed with a space.
 */
function sanitizeCell(value) {
    const str = String(value || '');
    return /^[=+\-@]/.test(str) ? ' ' + str : str;
}

// ─── GOOGLE SHEETS LOGIC ─────────────────────────────────────────────────────

const REQUIRED_HEADERS = ['Tanggal', 'Deskripsi', 'Nominal', 'Tipe', 'User', 'Saldo Akhir'];

/**
 * Loads the first sheet and ensures headers exist.
 * Only sets headers if the sheet is genuinely empty (no values at all).
 */
async function getSheet() {
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    await sheet.loadHeaderRow().catch(async (e) => {
        // loadHeaderRow throws when sheet is empty — check before overwriting
        const rows = await sheet.getCellsInRange('A1').catch(() => null);
        if (!rows || !rows[0] || !rows[0][0]) {
            // Sheet is truly empty — safe to set headers
            await sheet.setHeaderRow(REQUIRED_HEADERS);
            console.log('📋 Created spreadsheet headers');
        } else {
            // Some other error — rethrow so we don't silently corrupt data
            throw new Error(`Failed to load sheet headers: ${e.message}`);
        }
    });
    return sheet;
}

async function hitungSaldo(sheet, filterTanggal = null) {
    const rows = await sheet.getRows();
    let totalPemasukan = 0;
    let totalPengeluaran = 0;

    for (const row of rows) {
        const tgl = row.get('Tanggal');
        const nominalStr = row.get('Nominal');
        const tipe = row.get('Tipe');

        if (!tgl || !nominalStr) continue;

        // Extract DD/MM/YYYY from "DD/MM/YYYY, HH:MM:SS"
        const tglFull = tgl.toString();
        const tglSheet = tglFull.includes(',') ? tglFull.split(',')[0].trim() : tglFull.trim();
        const nominal = parseInt(nominalStr.toString().replace(/\D/g, ''), 10) || 0;

        if (!filterTanggal || tglSheet === filterTanggal) {
            const tipeUpper = tipe ? tipe.toString().toUpperCase() : '';
            if (tipeUpper === 'PEMASUKAN' || tipeUpper === 'DEBIT') totalPemasukan += nominal;
            if (tipeUpper === 'PENGELUARAN' || tipeUpper === 'CREDIT') totalPengeluaran += nominal;
        }
    }

    return { totalPemasukan, totalPengeluaran, saldo: totalPemasukan - totalPengeluaran };
}

async function generateRekapBulanan(sheet, bulanStr) {
    const rows = await sheet.getRows();
    let totalPemasukan = 0;
    let totalPengeluaran = 0;
    const listTransaksi = [];

    for (const row of rows) {
        const tgl = row.get('Tanggal');
        const nominalStr = row.get('Nominal');
        const tipe = row.get('Tipe');
        const deskripsi = row.get('Deskripsi') || '';

        if (!tgl || !nominalStr) continue;

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

            listTransaksi.push(`${tglPendek} | ${tipeStr} | Rp${nominal.toLocaleString('id-ID')} | ${descStr}`);

            if (tipeStr === 'MASUK') totalPemasukan += nominal;
            if (tipeStr === 'KELUAR') totalPengeluaran += nominal;
        }
    }

    return { totalPemasukan, totalPengeluaran, saldo: totalPemasukan - totalPengeluaran, listTransaksi };
}

// ─── AI PARSING ───────────────────────────────────────────────────────────────

const AI_SYSTEM_PROMPT = `Kamu adalah asisten keuangan pribadi yang cerdas, ramah, dan fleksibel. Tugasmu adalah membaca pesan user dan mengklasifikasikannya ke dalam format JSON murni.

Aturan Klasifikasi:
1. TRANSAKSI (Pemasukan/Pengeluaran): 
   Jika pesan menyebutkan aktivitas masuk/keluarnya uang (contoh: "gaji", "bayar listrik", "makan siang", "dikasih uang 50k", "beli kuota 10rb").
   -> Balas JSON: {"nominal": angka_tanpa_titik, "tipe": "PEMASUKAN" atau "PENGELUARAN", "deskripsi": "keterangan singkat"}
   -> Catatan Nominal: Wajib dikonversi ke angka penuh tanpa titik/koma. Contoh: "50k" -> 50000, "1.5jt" -> 1500000, "8 ratus ribu" -> 800000, "10rb" -> 10000.
   -> Catatan Tipe: PEMASUKAN = uang masuk/dapat/terima. PENGELUARAN = uang keluar/beli/bayar/transfer.

2. CEK SALDO SEKARANG:
   Jika user bertanya tentang sisa uang, total uang, atau saldo saat ini (contoh: "cek saldo", "berapa sisa uangku?", "duit tinggal brp", "saldo").
   -> Balas JSON: {"command":"cek_saldo_sekarang"}

3. CEK SALDO TANGGAL TERTENTU:
   Jika user bertanya saldo di waktu tertentu (contoh: "saldo kemarin", "sisa uang tgl 20", "total uang bulan lalu").
   -> Balas JSON: {"command":"cek_saldo_tanggal", "tanggal":"DD/MM/YYYY"} (Gunakan tahun dan bulan saat ini jika tidak disebut: sekarang tahun 2026).

4. REKAP BULANAN:
   Jika user meminta laporan/recap/summary bulan ini atau bulan tertentu (contoh: "report bulan ini", "rekap pengeluaran bulan ini").
   -> Balas JSON: {"command":"rekap_bulanan", "bulan":"MM/YYYY"} (Gunakan bulan saat ini jika tidak disebut. Contoh bulan ini Februari 2026: "02/2026").

5. PESAN LAINNYA / TIDAK DIKENAL:
   Jika pesan hanya sapaan, ucapan terima kasih, atau tidak berkaitan dengan keuangan (contoh: "halo", "oke", "tes", "siapa kamu?").
   -> Balas JSON: {"error":"bukan_perintah_valid"}

PENTING: Output HANYA boleh berisi JSON murni tanpa teks pengantar atau markdown (tidak pakai \`\`\`json).`;

async function parseWithHuggingFace(message, retries = 2) {
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
        console.log('🤖 HF Response:', resultText);

        const jsonMatch = resultText.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error('AI response is not JSON');

        const cleanJson = jsonMatch[0].replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);

    } catch (error) {
        if (retries > 0) {
            console.warn(`⚠️  HF Error (${error.message}). Retrying... (${retries} left)`);
            await new Promise(r => setTimeout(r, 1000)); // brief pause before retry
            return parseWithHuggingFace(message, retries - 1);
        }
        console.error('❌ HF Final Error:', error.message);
        return { error: true, message: error.message };
    }
}

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map(); // senderId → lastProcessedTimestamp

function isRateLimited(senderId) {
    const now = Date.now();
    const last = rateLimitMap.get(senderId);
    if (last && now - last < RATE_LIMIT_MS) return true;
    rateLimitMap.set(senderId, now);
    return false;
}

// Periodically clean up old entries to prevent memory leak
setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_MS * 10;
    for (const [id, ts] of rateLimitMap.entries()) {
        if (ts < cutoff) rateLimitMap.delete(id);
    }
}, 60 * 1000);

// ─── PUPPETEER CONFIG ─────────────────────────────────────────────────────────
const puppeteerArgs = IS_PROD ? [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    `--user-data-dir=${CHROME_DATA_DIR}`,
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

// ─── EXPRESS APP ──────────────────────────────────────────────────────────────
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
    // Only accept header — never query param (avoids leaking key in logs)
    const key = req.headers['x-api-key'];
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

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
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

// ─── LOCAL CACHE CLEANUP ─────────────────────────────────────────────────────
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

// ─── MONGO STORE ─────────────────────────────────────────────────────────────
function createFixedStore(mongooseInstance) {
    const MAX_BACKUPS = 1;

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
            if (!fs.existsSync(zipPath)) {
                console.warn(`⚠️  Zip not found (skip backup): ${zipPath}`);
                return;
            }
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
            const slots = allDocs
                .filter(d => d.filename.startsWith(`${sessionName}.zip.`))
                .sort((a, b) => a.uploadDate - b.uploadDate);
            const toDelete = slots.slice(0, Math.max(0, slots.length - MAX_BACKUPS));
            for (const d of toDelete) await bucket.delete(d._id);
            console.log(`✅ MongoDB upload done (${slots.length - toDelete.length}/${MAX_BACKUPS} slots) @ ${formatTime(new Date())}`);
            try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        },

        async extract(options) {
            const sessionName = path.basename(options.session);
            const zipPath = options.path;
            const bucket = getBucket(sessionName);
            const allDocs = await bucket.find({}).toArray();
            const slots = allDocs
                .filter(d => d.filename.startsWith(`${sessionName}.zip.`))
                .sort((a, b) => b.uploadDate - a.uploadDate);
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
            for (const d of docs) await bucket.delete(d._id);
            console.log(`🗑️  Deleted ${docs.length} slot(s): ${sessionName}`);
        },
    };
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
async function handleFinanceMessage(msg) {
    const senderId = msg.from;

    // ── Rate limit check ──
    if (isRateLimited(senderId)) {
        console.log(`⏳ Rate limited: ${senderId}`);
        return;
    }

    // ── Built-in commands (no AI needed) ──
    if (msg.body === '!ping') {
        await msg.reply('🏓 pong!').catch(e => console.error('Reply error:', e.message));
        return;
    }
    if (msg.body === '!status') {
        await msg.reply(
            `📊 *Bot Status*\n\nStatus: ${botStatus}\nSession: ${SESSION_NAME}\nUptime: ${formatUptime((Date.now() - startTime) / 1000)}\nLast Backup: ${sessionSavedAt || 'Not yet'}`
        ).catch(e => console.error('Reply error:', e.message));
        return;
    }

    console.log(`💬 [AI] Processing: ${msg.body.slice(0, 80)}`);

    // ── Parse with AI ──
    const data = await parseWithHuggingFace(msg.body);

    // ── Handle AI errors ──
    if (data.error === true) {
        console.error(`❌ AI parsing failed: ${data.message}`);
        await msg.reply('⚠️ Maaf, AI sedang tidak bisa memproses pesanmu. Coba lagi dalam beberapa detik.')
            .catch(e => console.error('Reply error:', e.message));
        return;
    }

    // ── Unknown / unrelated messages — silently ignore ──
    if (data.error === 'bukan_perintah_valid') {
        console.log('⏭️  Non-finance message — ignored');
        return;
    }

    // ── Load sheet (only when we actually need it) ──
    let sheet;
    try {
        sheet = await getSheet();
    } catch (err) {
        console.error('❌ Google Sheets error:', err.message);
        await msg.reply(`⚠️ Tidak bisa mengakses spreadsheet: ${err.message}`)
            .catch(e => console.error('Reply error:', e.message));
        return;
    }

    // ── REKAP BULANAN ──
    if (data.command === 'rekap_bulanan') {
        try {
            const bulanCari = data.bulan;
            const rekap = await generateRekapBulanan(sheet, bulanCari);

            let teks = `📊 *Laporan Bulan: ${bulanCari}*\n\n`;
            teks += `\`\`\`\nTGL   | TIPE   | NOMINAL           | KET\n`;
            teks += `${'─'.repeat(55)}\n`;
            if (rekap.listTransaksi.length === 0) {
                teks += `(Belum ada data)\n`;
            } else {
                rekap.listTransaksi.forEach(tx => { teks += `${tx}\n`; });
            }
            teks += `${'─'.repeat(55)}\`\`\`\n\n`;
            teks += `📥 Total Pemasukan : Rp${rekap.totalPemasukan.toLocaleString('id-ID')}\n`;
            teks += `📤 Total Pengeluaran: Rp${rekap.totalPengeluaran.toLocaleString('id-ID')}\n`;
            teks += `💰 *Saldo Bersih   : Rp${rekap.saldo.toLocaleString('id-ID')}*\n\n`;
            teks += `🔗 *Spreadsheet:*\nhttps://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;

            await msg.reply(teks).catch(e => console.error('Reply error:', e.message));
            console.log('✅ Sent monthly report');
        } catch (err) {
            console.error('❌ Rekap error:', err.message);
            await msg.reply(`⚠️ Gagal mengambil rekap: ${err.message}`)
                .catch(e => console.error('Reply error:', e.message));
        }
        return;
    }

    // ── CEK SALDO ──
    if (data.command === 'cek_saldo_sekarang' || data.command === 'cek_saldo_tanggal') {
        try {
            const tglCari = data.command === 'cek_saldo_tanggal' ? data.tanggal : null;
            const rekap = await hitungSaldo(sheet, tglCari);
            const judul = tglCari ? `📊 *Saldo Tanggal ${tglCari}*` : `📊 *Posisi Saldo Saat Ini*`;

            await msg.reply(
                `${judul}\n\n📥 Pemasukan  : Rp${rekap.totalPemasukan.toLocaleString('id-ID')}\n` +
                `📤 Pengeluaran: Rp${rekap.totalPengeluaran.toLocaleString('id-ID')}\n` +
                `💰 *Saldo     : Rp${rekap.saldo.toLocaleString('id-ID')}*`
            ).catch(e => console.error('Reply error:', e.message));
            console.log('✅ Sent balance info');
        } catch (err) {
            console.error('❌ Saldo error:', err.message);
            await msg.reply(`⚠️ Gagal mengambil saldo: ${err.message}`)
                .catch(e => console.error('Reply error:', e.message));
        }
        return;
    }

    // ── SIMPAN TRANSAKSI ──
    if (data.nominal !== undefined) {
        const parsedNominal = parseFloat(data.nominal);

        if (isNaN(parsedNominal) || parsedNominal <= 0) {
            console.warn(`⚠️  Invalid nominal: ${data.nominal} — skipping`);
            await msg.reply('⚠️ Nominal tidak valid atau nol. Mohon coba lagi dengan nominal yang jelas.')
                .catch(e => console.error('Reply error:', e.message));
            return;
        }

        try {
            // Calculate running saldo
            const rekapSekarang = await hitungSaldo(sheet);
            const tipeTx = data.tipe ? data.tipe.toUpperCase() : '';
            let saldoBaru = rekapSekarang.saldo;

            if (tipeTx === 'PEMASUKAN' || tipeTx === 'DEBIT') saldoBaru += parsedNominal;
            else if (tipeTx === 'PENGELUARAN' || tipeTx === 'CREDIT') saldoBaru -= parsedNominal;

            const now = new Date();
            const hariIni = formatDateID(now);
            const jamSekarang = formatTimeLocal(now);

            await sheet.addRow({
                Tanggal: `${hariIni}, ${jamSekarang}`,
                Deskripsi: sanitizeCell(data.deskripsi || ''),
                Nominal: parsedNominal,
                Tipe: sanitizeCell(data.tipe || ''),
                User: sanitizeCell(msg.pushname || msg.from),
                'Saldo Akhir': saldoBaru,
            });

            await msg.reply(
                `✅ *Data Tersimpan!*\n` +
                `📝 *Ket    :* ${data.deskripsi}\n` +
                `💰 *Nominal:* Rp${parsedNominal.toLocaleString('id-ID')}\n` +
                `📊 *Tipe   :* ${data.tipe}\n\n` +
                `💳 *Sisa Saldo: Rp${saldoBaru.toLocaleString('id-ID')}*`
            ).catch(e => console.error('Reply error:', e.message));
            console.log(`✅ Transaction saved: ${data.tipe} Rp${parsedNominal}`);
        } catch (err) {
            console.error('❌ Transaction save error:', err.message);
            await msg.reply(`⚠️ Gagal menyimpan transaksi: ${err.message}`)
                .catch(e => console.error('Reply error:', e.message));
        }
        return;
    }

    // ── Fallback: unrecognised AI response ──
    console.warn('⚠️  Unrecognised AI response:', JSON.stringify(data));
}

async function handleWebhookAndCommands(msg) {
    if (!WEBHOOK_URL && msg.body !== '!ping' && msg.body !== '!status') return;

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
            console.warn(`⚠️  Media download failed: ${e.message}`);
        }
    }

    console.log(`📩 [${msg.from}] ${msg.type}: ${msg.body || '(media)'}`);
    fireWebhook(payload);
}

// ─── HTTP ROUTES ──────────────────────────────────────────────────────────────
let QRCode = null;
try { QRCode = require('qrcode'); } catch {
    console.warn('⚠️  "qrcode" package not found. Run: npm install qrcode');
}

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
        lastBackup: sessionSavedAt, webhookConfigured: !!WEBHOOK_URL,
    });
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
        const media = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia(mime || 'image/jpeg', base64, filename || 'image.jpg');
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
        const media = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia(mime || 'application/octet-stream', base64, filename || 'file');
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
        const media = url
            ? await MessageMedia.fromUrl(url, { unsafeMime: true })
            : new MessageMedia('audio/ogg; codecs=opus', base64, 'audio.ogg');
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
    if (!to || latitude == null || longitude == null)
        return res.status(400).json({ success: false, error: 'Missing: to, latitude, longitude' });
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
            groups: groups.map(g => ({ id: g.id._serialized, name: g.name, participantCount: g.participants?.length || 0 })),
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server → http://0.0.0.0:${PORT}`));

// ─── WHATSAPP CLIENT ─────────────────────────────────────────────────────────
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
                dataPath: DATA_PATH,
                store,
                backupSyncIntervalMs: BACKUP_INTERVAL,
            }),
            puppeteer: puppeteerConfig,
            authTimeoutMs: 120000,
        });

        currentClient = client;

        client.on('loading_screen', (percent, message) =>
            console.log(`⏳ Loading: ${percent}% — ${message}`)
        );

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

        // ── MAIN MESSAGE HANDLER ──────────────────────────────────────────────
        client.on('message', async (msg) => {
            if (msg.from === 'status@broadcast') return;

            // Filter by allowed chats
            if (ALLOWED_CHATS.length > 0 && !ALLOWED_CHATS.includes(msg.from)) return;

            // Phase 1: Finance bot logic
            try {
                await handleFinanceMessage(msg);
            } catch (err) {
                console.error('❌ handleFinanceMessage unhandled error:', err.message);
                await msg.reply(`⚠️ Terjadi kesalahan tidak terduga: ${err.message}`)
                    .catch(e => console.error('Reply error:', e.message));
            }

            // Phase 2: Webhook forwarding (runs independently, doesn't block or fail silently)
            handleWebhookAndCommands(msg).catch(err =>
                console.error('❌ handleWebhookAndCommands error:', err.message)
            );
        });

        client.on('message_reaction', (reaction) => {
            fireWebhook({
                event: 'reaction', timestamp: Date.now(),
                reaction: {
                    id: reaction.id._serialized,
                    from: reaction.senderId,
                    emoji: reaction.reaction,
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

// ─── GLOBAL ERROR GUARDS ──────────────────────────────────────────────────────
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