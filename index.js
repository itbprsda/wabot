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
const crypto = require('crypto');

// ─── VALIDATE REQUIRED ENV VARS ───────────────────────────────────────────────
const REQUIRED_ENV = ['MONGODB_URI', 'GEMINI_API_KEY', 'HF_TOKEN', 'GOOGLE_CREDS_JSON'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
    console.error('Missing required environment variables: ' + missingEnv.join(', '));
    console.error('   Set them in your .env file or Railway environment settings.');
    process.exit(1);
}

// ─── LOAD GOOGLE CREDENTIALS ──────────────────────────────────────────────────
let creds;
try {
    let raw = process.env.GOOGLE_CREDS_JSON || '';
    if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    creds = JSON.parse(raw);
    if (!creds.client_email || !creds.private_key) throw new Error('Missing client_email or private_key');
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    console.log('Google creds loaded for: ' + creds.client_email);
} catch (e) {
    console.error('Failed to parse GOOGLE_CREDS_JSON: ' + e.message);
    console.error('  Fix: wrap value in single quotes in .env:');
    console.error("     GOOGLE_CREDS_JSON='{\"type\":\"service_account\",...}'");
    process.exit(1);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HF_TOKEN = process.env.HF_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_NAME = process.env.SESSION_NAME || 'whatsapp-bot';
const ADMINISTRATOR = (process.env.ADMINISTRATOR || '').split(',').map(id => id.trim()).filter(Boolean);
const PORT = parseInt(process.env.PORT || '8000', 10);
const API_KEY = process.env.API_KEY || 'changeme';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const ALLOWED_CHATS = (process.env.ALLOWED_CHATS || '6287759895339-1608597951@g.us')
    .split(',').map(id => id.trim()).filter(Boolean);

const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '3000', 10);
const IS_PROD = !!process.env.PUPPETEER_EXECUTABLE_PATH;

const MAX_MEDIA_WEBHOOK_BYTES = 5 * 1024 * 1024;
const MAX_WEBHOOK_ATTEMPTS = 3;
const BACKUP_INTERVAL = IS_PROD ? 5 * 60 * 1000 : 60 * 1000;

// Dashboard key expiry: 5 minutes (300,000 ms)
const DASHBOARD_KEY_EXPIRY_MS = 5 * 60 * 1000;

const DATA_PATH = IS_PROD ? path.resolve('/app/.wwebjs_auth') : path.resolve(process.cwd(), '.wwebjs_auth');
const CHROME_DATA_DIR = IS_PROD ? path.resolve('/tmp/.chrome-data') : path.resolve(process.cwd(), '.chrome-data');
const SESSION_DIR_NAME = 'RemoteAuth-' + SESSION_NAME;

// ─── STARTUP LOGS ─────────────────────────────────────────────────────────────
if (API_KEY === 'changeme') console.warn('API_KEY is default — set a strong key!');
console.log('Environment  : ' + (IS_PROD ? 'Production (Railway)' : 'Development (Local)'));
console.log('Session name : ' + SESSION_NAME);
console.log('Backup every : ' + BACKUP_INTERVAL / 1000 + 's');
console.log('API Key      : ' + (API_KEY === 'changeme' ? 'DEFAULT (unsafe!)' : 'Set'));
console.log('Webhook URL  : ' + (WEBHOOK_URL || 'Not set'));
console.log('Public URL   : ' + (PUBLIC_URL || 'Not set'));
console.log('Port         : ' + PORT);
console.log('Allowed Chats: ' + (ALLOWED_CHATS.length > 0 ? ALLOWED_CHATS.join(', ') : 'All'));
console.log('Admins       : ' + (ADMINISTRATOR.length > 0 ? ADMINISTRATOR.join(', ') : 'None'));

// ─── GOOGLE SHEETS AUTH ───────────────────────────────────────────────────────
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
// (Google Sheets are now handled dynamically per-user using getSheet(id))

// ─── AI CLIENTS ───────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });
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
    ms = ms || 30000; label = label || 'Operation';
    return Promise.race([promise, new Promise((_, reject) =>
        setTimeout(() => reject(new Error(label + ' timed out after ' + ms / 1000 + 's')), ms))]);
}

// ─── GMT+8 TIME HELPERS ───────────────────────────────────────────────────────
// Returns a Date object shifted to GMT+8
function nowGMT8() {
    const now = new Date();
    // Shift by UTC offset of +8 hours
    return new Date(now.getTime() + 8 * 60 * 60 * 1000);
}

// Format date as DD/MM/YYYY in GMT+8
function formatDateID(date) {
    const d = date || nowGMT8();
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
}

// Format time as HH.MM.SS in GMT+8
function formatTimeLocal(date) {
    const d = date || nowGMT8();
    const pad = n => String(n).padStart(2, '0');
    return pad(d.getUTCHours()) + '.' + pad(d.getUTCMinutes()) + '.' + pad(d.getUTCSeconds());
}

// Format locale string in GMT+8 for display
function formatLocaleGMT8(date) {
    const d = date || nowGMT8();
    // Use toLocaleString with explicit timezone
    return new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Makassar' });
}

function sanitizeCell(value) {
    const str = String(value || '');
    return /^[=+\-@]/.test(str) ? ' ' + str : str;
}
function rupiahFmt(n) {
    return 'Rp' + Math.abs(n).toLocaleString('id-ID');
}

// ─── DASHBOARD ACCESS KEY HELPERS ─────────────────────────────────────────────
// The collection always holds exactly ONE row.
// On every rekap bulanan: wipe all rows, insert a fresh one.
const DashboardAccessSchema = new mongoose.Schema({
    from: { type: String, required: true },
    bulan: { type: String, required: true },
    key: { type: String, required: true },
    createdAt: { type: Date, required: true },
    lastAccess: { type: Date, default: null },
    isUsed: { type: Boolean, default: false },
});

// User Settings Schema (from -> spreadsheetId)
const UserSettingsSchema = new mongoose.Schema({
    from: { type: String, required: true, unique: true },
    spreadsheetId: { type: String, required: true },
});

function getDashboardAccessModel() {
    return mongoose.models.DashboardAccess ||
        mongoose.model('DashboardAccess', DashboardAccessSchema, 'dashboardaccess');
}

function getUserSettingsModel() {
    return mongoose.models.UserSettings ||
        mongoose.model('UserSettings', UserSettingsSchema, 'usersettings');
}

function generateDashboardKey() {
    return crypto.randomBytes(24).toString('hex');
}

// Delete all existing rows for this user+month, then insert exactly one new row
async function createDashboardKey(from, bulan) {
    const DashboardAccess = getDashboardAccessModel();
    const key = generateDashboardKey();
    // Scope deletion to the specific user/month
    await DashboardAccess.deleteMany({ from, bulan });
    await DashboardAccess.create({ from, bulan, key, createdAt: new Date(), lastAccess: null, isUsed: false });
    console.log(`Dashboard key created for ${from} (${bulan})`);
    return key;
}

// Returns: { valid: true, bulan, from } | { valid: false, reason: 'not_found'|'used'|'expired' }
async function validateDashboardKey(key) {
    const DashboardAccess = getDashboardAccessModel();
    // Find the single row and match by key
    const record = await DashboardAccess.findOne({ key });
    if (!record) return { valid: false, reason: 'not_found' };
    if (record.isUsed) return { valid: false, reason: 'used' };

    const now = new Date();

    // If previously accessed: check 5 min since lastAccess
    if (record.lastAccess) {
        if (now - record.lastAccess > DASHBOARD_KEY_EXPIRY_MS) {
            await DashboardAccess.updateOne({ key }, { $set: { isUsed: true } });
            return { valid: false, reason: 'expired' };
        }
    } else {
        // First access ever: check if created more than 5 min ago
        if (now - record.createdAt > DASHBOARD_KEY_EXPIRY_MS) {
            await DashboardAccess.updateOne({ key }, { $set: { isUsed: true } });
            return { valid: false, reason: 'expired' };
        }
    }

    // Valid — record the access time
    await DashboardAccess.updateOne({ key }, { $set: { lastAccess: now } });
    return { valid: true, bulan: record.bulan, from: record.from };
}

async function getUserSettings(from) {
    const UserSettings = getUserSettingsModel();
    let settings = await UserSettings.findOne({ from });

    // Fallback/Migration: if this is a known primary user and no settings in DB, use ENV
    if (!settings && ALLOWED_CHATS.includes(from)) {
        const spreadsheetId = process.env.SPREADSHEET_ID;
        if (spreadsheetId) {
            settings = await UserSettings.create({ from, spreadsheetId });
            console.log(`Migrated SPREADSHEET_ID to MongoDB for user: ${from}`);
        }
    }
    return settings;
}

// ─── GOOGLE SHEETS DATA ───────────────────────────────────────────────────────
const REQUIRED_HEADERS = ['Tanggal', 'Deskripsi', 'Nominal', 'Tipe', 'User', 'Saldo Akhir'];

async function getSheet(spreadsheetId) {
    const userDoc = new GoogleSpreadsheet(spreadsheetId, serviceAccountAuth);
    await userDoc.loadInfo();
    const sheet = userDoc.sheetsByIndex[0];
    try {
        await sheet.loadHeaderRow();
    } catch (e) {
        const cells = await sheet.getCellsInRange('A1').catch(() => null);
        if (!cells || !cells[0] || !cells[0][0]) {
            await sheet.setHeaderRow(REQUIRED_HEADERS);
            console.log('Created spreadsheet headers for: ' + spreadsheetId);
        } else {
            throw new Error('Failed to load headers: ' + e.message);
        }
    }
    return { sheet, doc: userDoc };
}

async function hitungSaldo(sheet, filterTanggal, userFilter) {
    const rows = await sheet.getRows();
    let totalPemasukan = 0, totalPengeluaran = 0;
    rows.forEach(row => {
        const tgl = row.get('Tanggal'), nominalStr = row.get('Nominal'), tipe = row.get('Tipe'), user = row.get('User');
        if (!tgl || !nominalStr) return;

        // Filter by user if provided
        if (userFilter && user !== userFilter) return;

        const tglFull = tgl.toString();
        const tglSheet = tglFull.includes(',') ? tglFull.split(',')[0].trim() : tglFull.trim();
        const nominal = parseInt(nominalStr.toString().replace(/\D/g, ''), 10) || 0;
        if (!filterTanggal || tglSheet === filterTanggal) {
            const t = tipe ? tipe.toString().toUpperCase() : '';
            if (t === 'PEMASUKAN' || t === 'DEBIT') totalPemasukan += nominal;
            if (t === 'PENGELUARAN' || t === 'CREDIT') totalPengeluaran += nominal;
        }
    });
    return { totalPemasukan, totalPengeluaran, saldo: totalPemasukan - totalPengeluaran };
}

async function generateRekapBulanan(sheet, bulanStr, userFilter) {
    const rows = await sheet.getRows();
    let totalPemasukan = 0, totalPengeluaran = 0;
    const listTransaksi = [], txRaw = [];
    rows.forEach(row => {
        const tgl = row.get('Tanggal'), nominalStr = row.get('Nominal');
        const tipe = row.get('Tipe'), deskripsi = row.get('Deskripsi') || '', user = row.get('User');
        if (!tgl || !nominalStr) return;

        // Filter by user if provided
        if (userFilter && user !== userFilter) return;

        const tglFull = tgl.toString();
        const tglHari = tglFull.includes(',') ? tglFull.split(',')[0].trim() : tglFull.trim();
        const jam = tglFull.includes(',') ? tglFull.split(',')[1].trim() : '';
        if (!tglHari.endsWith(bulanStr)) return;
        const nominal = parseInt(nominalStr.toString().replace(/\D/g, ''), 10) || 0;
        const tipeUpper = tipe ? tipe.toString().toUpperCase() : '';
        const tglPendek = tglHari.substring(0, 5);
        const tipeStr = (tipeUpper === 'PEMASUKAN' || tipeUpper === 'DEBIT') ? 'MASUK' : 'KELUAR';
        const descStr = deskripsi.length > 20 ? deskripsi.substring(0, 20) : deskripsi.padEnd(20, ' ');
        listTransaksi.push(tglPendek + ' | ' + tipeStr + ' | ' + rupiahFmt(nominal) + ' | ' + descStr);
        txRaw.push({ tgl: tglHari, jam, desc: deskripsi, nominal, tipe: tipeStr === 'MASUK' ? 'PEMASUKAN' : 'PENGELUARAN' });
        if (tipeStr === 'MASUK') totalPemasukan += nominal;
        if (tipeStr === 'KELUAR') totalPengeluaran += nominal;
    });
    return { totalPemasukan, totalPengeluaran, saldo: totalPemasukan - totalPengeluaran, listTransaksi, txRaw };
}

// ─── GOOGLE SHEETS DESIGN ────────────────────────────────────────────────────
async function designSheet(userDoc, bulanStr, userFilter) {
    try {
        let dash = userDoc.sheetsByTitle['Dashboard'];
        if (!dash) {
            dash = await userDoc.addSheet({ title: 'Dashboard', index: 1 });
            console.log('Created Dashboard sheet');
        }
        const dataSheet = userDoc.sheetsByIndex[0];
        await dataSheet.loadHeaderRow();
        const rows = await dataSheet.getRows();

        const filtered = rows.filter(row => {
            // Filter by month if provided
            if (bulanStr) {
                const tgl = (row.get('Tanggal') || '').toString();
                const day = tgl.includes(',') ? tgl.split(',')[0].trim() : tgl.trim();
                if (!day.endsWith(bulanStr)) return false;
            }
            // Filter by user if provided
            if (userFilter) {
                const user = (row.get('User') || '').toString();
                if (user !== userFilter) return false;
            }
            return true;
        });

        let totalPemasukan = 0, totalPengeluaran = 0;
        const txList = [];
        filtered.forEach(row => {
            const nominal = parseInt((row.get('Nominal') || '0').toString().replace(/\D/g, ''), 10) || 0;
            const tipe = (row.get('Tipe') || '').toString().toUpperCase();
            const tgl = (row.get('Tanggal') || '').toString();
            const desc = (row.get('Deskripsi') || '').toString();
            const isIn = tipe === 'PEMASUKAN' || tipe === 'DEBIT';
            if (isIn) totalPemasukan += nominal; else totalPengeluaran += nominal;
            txList.push({ tgl, desc, nominal, tipe: isIn ? 'PEMASUKAN' : 'PENGELUARAN' });
        });
        txList.sort((a, b) => b.tgl.localeCompare(a.tgl));

        const saldo = totalPemasukan - totalPengeluaran;
        const total = totalPemasukan + totalPengeluaran;
        const savingsPct = totalPemasukan > 0 ? (saldo / totalPemasukan * 100).toFixed(1) : '0.0';
        const inPct = total > 0 ? (totalPemasukan / total * 100).toFixed(1) : '0.0';
        const outPct = total > 0 ? (totalPengeluaran / total * 100).toFixed(1) : '0.0';
        const label = (userFilter ? userFilter.split('@')[0] + ' | ' : '') + (bulanStr ? 'Bulan: ' + bulanStr : 'Semua Waktu');

        const FIRST_TX = 11;
        const totalRows = FIRST_TX + txList.length + 2;
        await dash.resize({ rowCount: Math.max(totalRows, 50), columnCount: 5 });
        await dash.loadCells({ startRowIndex: 0, endRowIndex: totalRows, startColumnIndex: 0, endColumnIndex: 5 });

        const BG = { red: 0.055, green: 0.063, blue: 0.082 };
        const SURFACE = { red: 0.094, green: 0.106, blue: 0.133 };
        const BORDER = { red: 0.141, green: 0.157, blue: 0.200 };
        const INCOME = { red: 0.212, green: 0.906, blue: 0.627 };
        const EXPENSE = { red: 1.000, green: 0.373, blue: 0.494 };
        const ACCENT = { red: 0.486, green: 0.424, blue: 0.988 };
        const WHITE = { red: 0.910, green: 0.918, blue: 0.941 };
        const MUTED = { red: 0.353, green: 0.380, blue: 0.502 };
        const DARK_IN = { red: 0.067, green: 0.102, blue: 0.094 };
        const DARK_EX = { red: 0.102, green: 0.067, blue: 0.086 };
        const STRIPE = { red: 0.082, green: 0.090, blue: 0.110 };

        const c = (r, col) => dash.getCell(r, col);
        function s(r, col, opts) {
            const cl = c(r, col);
            if (opts.value !== undefined) cl.value = opts.value;
            if (opts.bg !== undefined) cl.backgroundColor = opts.bg;
            if (opts.align !== undefined) cl.horizontalAlignment = opts.align;
            if (opts.wrap !== undefined) cl.wrapStrategy = opts.wrap ? 'WRAP' : 'CLIP';

            if (!cl.textFormat) cl.textFormat = {};
            if (opts.bold !== undefined) cl.textFormat.bold = opts.bold;
            if (opts.size !== undefined) cl.textFormat.fontSize = opts.size;
            if (opts.color !== undefined) cl.textFormat.foregroundColor = opts.color;
            if (opts.italic !== undefined) cl.textFormat.italic = opts.italic;
        }

        for (let r = 0; r < totalRows; r++)
            for (let col = 0; col < 5; col++) {
                const cl = c(r, col);
                cl.value = ''; cl.backgroundColor = BG;
                cl.textFormat = { foregroundColor: WHITE, bold: false, fontSize: 10 };
                cl.horizontalAlignment = 'LEFT'; cl.wrapStrategy = 'CLIP';
            }

        for (let col = 0; col < 5; col++) s(0, col, { bg: SURFACE });
        s(0, 0, { value: 'LAPORAN KEUANGAN', bold: true, size: 14, color: WHITE, bg: SURFACE });
        s(0, 2, { value: label, bold: true, size: 11, color: ACCENT, bg: SURFACE, align: 'CENTER' });
        s(0, 4, { value: new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Makassar' }), size: 9, color: MUTED, bg: SURFACE, align: 'RIGHT' });

        for (let col = 0; col < 5; col++) s(1, col, { bg: BG });

        const left = [
            { label: 'TOTAL PEMASUKAN', val: rupiahFmt(totalPemasukan), color: INCOME, bg: DARK_IN },
            { label: 'TOTAL PENGELUARAN', val: rupiahFmt(totalPengeluaran), color: EXPENSE, bg: DARK_EX },
            { label: 'SALDO BERSIH', val: rupiahFmt(saldo) + (saldo < 0 ? ' (-)' : ''), color: saldo >= 0 ? INCOME : EXPENSE, bg: SURFACE },
        ];
        const right = [
            { label: 'RASIO PEMASUKAN', val: inPct + '%', color: INCOME, bg: DARK_IN },
            { label: 'RASIO PENGELUARAN', val: outPct + '%', color: EXPENSE, bg: DARK_EX },
            { label: 'TINGKAT TABUNGAN', val: savingsPct + '%', color: ACCENT, bg: SURFACE },
        ];

        left.forEach((item, i) => {
            const r = 2 + i * 2;
            s(r, 0, { value: item.label, bold: true, size: 8, color: MUTED, bg: item.bg });
            s(r, 1, { value: '', bg: item.bg });
            s(r + 1, 0, { value: item.val, bold: true, size: 13, color: item.color, bg: item.bg });
            s(r + 1, 1, { value: '', bg: item.bg });
        });
        right.forEach((item, i) => {
            const r = 2 + i * 2;
            s(r, 3, { value: item.label, bold: true, size: 8, color: MUTED, bg: item.bg });
            s(r, 4, { value: '', bg: item.bg });
            s(r + 1, 3, { value: item.val, bold: true, size: 13, color: item.color, bg: item.bg });
            s(r + 1, 4, { value: '', bg: item.bg });
        });
        for (let r = 2; r <= 7; r++) s(r, 2, { value: '', bg: BORDER });

        for (let col = 0; col < 5; col++) s(8, col, { bg: BG });

        ['TANGGAL', 'DESKRIPSI', 'TIPE', 'NOMINAL', 'USER'].forEach((h, col) =>
            s(9, col, { value: h, bold: true, size: 9, color: MUTED, bg: SURFACE, align: col >= 3 ? 'RIGHT' : 'LEFT' })
        );

        txList.forEach((tx, i) => {
            const r = 10 + i;
            const isIn = tx.tipe === 'PEMASUKAN';
            const bg = i % 2 === 0 ? BG : STRIPE;
            s(r, 0, { value: tx.tgl, size: 9, color: MUTED, bg, align: 'LEFT' });
            s(r, 1, { value: tx.desc, size: 9, color: WHITE, bg, align: 'LEFT', wrap: false });
            s(r, 2, { value: tx.tipe, size: 8, color: isIn ? INCOME : EXPENSE, bold: true, bg, align: 'LEFT' });
            s(r, 3, { value: (isIn ? '+' : '-') + rupiahFmt(tx.nominal), size: 9, bold: true, color: isIn ? INCOME : EXPENSE, bg, align: 'RIGHT' });
            s(r, 4, { value: '', bg, align: 'RIGHT' });
        });

        await dash.saveUpdatedCells();
        console.log('Dashboard sheet designed for ' + (userFilter || 'all users') + ' in ' + (bulanStr || 'all time'));
    } catch (err) {
        console.error('designSheet error (non-fatal): ' + err.message);
    }
}

// ─── AI PARSING ───────────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `Kamu adalah asisten keuangan pribadi yang cerdas, ramah, dan profesional.
Tugasmu: Menganalisis pesan pengguna dan mengonversinya menjadi format JSON yang sangat akurat.

=== DAFTAR KATA KUNCI INDONESIA ===
- PEMASUKAN: gajian, bonus, hadiah, untung, laba, trima, dapet, masuk, setor, msk, msuk, transfer masuk.
- PENGELUARAN: bayar, beli, jajan, kluar, klr, biayai, tagihan, angsuran, cicilan, sedekah, infaq, zakat, donasi, tarik, transfer keluar, bensin, parkir, belanja.

=== ATURAN EKSTRAKSI NOMINAL ===
1. HANYA ambil angka yang disebutkan eksplisit.
2. Konversi satuan:
   - "jt" / "juta" = x1.000.000 (contoh: "1.5jt" -> 1500000)
   - "rb" / "ribu" / "k" = x1.000 (contoh: "50k" -> 50000)
   - Angka 1-999 tanpa satuan biasanya ribuan (contoh: "jajan 25" -> 25000).
   - Angka >= 1000 tanpa satuan adalah nilai asli.
3. Jika tidak ada angka sama sekali di pesan → gunakan "missing_nominal": true.

=== FORMAT OUTPUT JSON ===

1. TRANSAKSI (Ada Nominal):
   {"nominal": 1000000, "tipe": "PEMASUKAN"/"PENGELUARAN", "deskripsi": "Singkat & Jelas"}

2. TRANSAKSI (Tanpa Nominal):
   {"missing_nominal": true, "tipe": "PEMASUKAN"/"PENGELUARAN", "deskripsi": "..."}

3. CEK SALDO:
   {"command": "cek_saldo_sekarang"}
   Atau {"command": "cek_saldo_tanggal", "tanggal": "DD/MM/YYYY"} (jika menyebutkan tanggal spesifik)

4. LAPORAN/REKAP:
   {"command": "rekap_bulanan", "bulan": "MM/YYYY"}
   - Wajib ada referensi bulan (misal: "rekap januari", "bulan lalu", "laporan ini").
   - Bulan ini: 02/2026.

5. TIDAK VALID:
   {"error": "bukan_perintah_valid"}
   - Untuk sapaan santai ("halo", "test"), atau pesan tanpa maksud keuangan yang jelas.

PENTING: Hanya balas dengan JSON murni. Jangan ada penjelasan tambahan.`;

async function parseWithHuggingFace(message, retries) {
    retries = retries === undefined ? 2 : retries;
    try {
        const response = await inference.chatCompletion({
            model: 'Qwen/Qwen2.5-7B-Instruct',
            messages: [
                { role: 'system', content: AI_SYSTEM_PROMPT },
                { role: 'user', content: message },
            ],
            max_tokens: 150, temperature: 0.1,
        });
        const resultText = response.choices[0].message.content;
        console.log('HF Response: ' + resultText);
        const jsonMatch = resultText.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error('AI response is not JSON: ' + resultText.slice(0, 80));
        return JSON.parse(jsonMatch[0].replace(/```json|```/g, '').trim());
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
    const now = Date.now(), last = rateLimitMap.get(senderId);
    if (last && now - last < RATE_LIMIT_MS) return true;
    rateLimitMap.set(senderId, now);
    return false;
}
setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_MS * 10;
    rateLimitMap.forEach((ts, id) => { if (ts < cutoff) rateLimitMap.delete(id); });
}, 60000);

// ─── GLOBAL MESSAGE QUEUE ─────────────────────────────────────────────────────
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;
    console.log('[Queue] Processing started. Queue length: ' + messageQueue.length);
    try {
        while (messageQueue.length > 0) {
            const { target, content, options, resolve, reject } = messageQueue.shift();
            try {
                // Add a timeout to the reply itself to prevent the queue from hanging
                const result = await withTimeout(target.reply(content, options), 30000, 'Queue Reply');
                resolve(result);
            } catch (e) {
                console.error('[Queue] Reply failed: ' + e.message);
                reject(e);
            }
            // Wait at least 2 seconds between outgoing messages globally
            if (messageQueue.length > 0) {
                console.log('[Queue] Waiting 2s before next message...');
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    } finally {
        isProcessingQueue = false;
        console.log('[Queue] Processing finished.');
    }
}

function queuedReply(msg, content, options) {
    return new Promise((resolve, reject) => {
        messageQueue.push({ target: msg, content, options, resolve, reject });
        processQueue();
    });
}

// ─── PUPPETEER ────────────────────────────────────────────────────────────────
const puppeteerArgs = IS_PROD ? [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--renderer-process-limit=1',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
    '--disable-breakpad',
    '--crash-dumps-dir=/tmp/chrome-crashes',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
] : ['--no-sandbox', '--disable-setuid-sandbox'];

const puppeteerConfig = IS_PROD
    ? {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: 'new',
        args: puppeteerArgs,
        timeout: 120000,
        protocolTimeout: 120000
    }
    : { headless: 'new', args: puppeteerArgs, timeout: 60000 };

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
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    next();
}
function requireReady(req, res, next) {
    if (botStatus !== 'ready' || !waClient)
        return res.status(503).json({ success: false, error: 'Bot not ready (status: ' + botStatus + ')' });
    next();
}

// ─── HTML PAGES ───────────────────────────────────────────────────────────────

function renderStatusPage() {
    const statusMap = {
        starting: { icon: '◌', badge: 'Memulai...', hint: 'Bot sedang diinisialisasi, mohon tunggu.', color: '#60a5fa' },
        qr_ready: { icon: '▣', badge: 'Scan QR', hint: 'Buka WhatsApp → Perangkat Tertaut → Tautkan.', color: '#fbbf24' },
        authenticated: { icon: '◎', badge: 'Autentikasi...', hint: 'Sesi berhasil, memuat WhatsApp...', color: '#a78bfa' },
        disconnected: { icon: '✕', badge: 'Terputus', hint: 'Koneksi terputus, mencoba menghubungkan ulang.', color: '#f87171' },
    };
    const st = statusMap[botStatus] || statusMap['starting'];
    const qrSection = (botStatus === 'qr_ready' && qrData)
        ? `<div class="qr-box">
            <img src="/api/qr" alt="QR Code" onerror="this.style.display='none'"/>
            <p class="qr-hint">Gambar diperbarui otomatis setiap 10 detik</p>
           </div>`
        : '';

    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>WA Bot — ${st.badge}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#080c10;color:#c9d1d9;font-family:'Geist Mono',monospace}
body{display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:400px;text-align:center}
.icon{font-size:3.5rem;color:${st.color};margin-bottom:24px;display:block;
  animation:pulse 2s ease infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.badge{display:inline-block;padding:5px 16px;border-radius:100px;font-size:.7rem;
  font-weight:600;letter-spacing:.12em;text-transform:uppercase;
  background:${st.color}22;color:${st.color};border:1px solid ${st.color}44;margin-bottom:20px}
.title{font-size:1.1rem;font-weight:600;color:#e6edf3;margin-bottom:8px}
.hint{font-size:.75rem;color:#6e7681;line-height:1.7;margin-bottom:28px}
.qr-box{background:#0d1117;border:1px solid #21262d;border-radius:12px;padding:20px;margin-bottom:20px}
.qr-box img{width:220px;height:220px;border-radius:8px;background:white;padding:8px}
.qr-hint{font-size:.65rem;color:#6e7681;margin-top:12px}
.meta{font-size:.65rem;color:#484f58;margin-top:24px;line-height:2}
.dot{display:inline-block;width:6px;height:6px;border-radius:50%;
  background:${st.color};margin-right:6px;vertical-align:middle}
</style>
</head>
<body>
<div class="card">
  <span class="icon">⌀</span>
  <div class="badge"><span class="dot"></span>${st.badge}</div>
  <div class="title">WhatsApp Finance Bot</div>
  <p class="hint">${st.hint}</p>
  ${qrSection}
  <div class="meta">
    Sesi: ${SESSION_NAME}<br>
    Uptime: ${formatUptime((Date.now() - startTime) / 1000)}<br>
    Mode: ${IS_PROD ? 'Production' : 'Development'}
  </div>
</div>
</body>
</html>`;
}

function render404() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 Not Found</title>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#080c10;color:#484f58;font-family:'Geist Mono',monospace}
body{display:flex;align-items:center;justify-content:center}
.wrap{text-align:center}
.code{font-size:6rem;font-weight:300;color:#21262d;line-height:1;letter-spacing:-.04em}
.msg{font-size:.8rem;margin-top:16px;letter-spacing:.08em}
</style>
</head>
<body>
<div class="wrap">
  <div class="code">404</div>
  <div class="msg">NOT FOUND</div>
</div>
</body>
</html>`;
}

function renderDashboardExpired(reason) {
    const messages = {
        not_found: { title: 'Link Tidak Ditemukan', desc: 'Link dashboard ini tidak valid atau tidak pernah dibuat.' },
        used: { title: 'Link Sudah Digunakan', desc: 'Link dashboard ini sudah kedaluwarsa karena tidak aktif lebih dari 5 menit sejak terakhir dibuka.' },
        expired: { title: 'Link Kedaluwarsa', desc: 'Link dashboard ini sudah kedaluwarsa. Link hanya berlaku 5 menit sejak pertama kali dibuat.' },
    };
    const m = messages[reason] || messages['not_found'];
    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${m.title}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#080c10;color:#c9d1d9;font-family:'Geist Mono',monospace}
body{display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:420px;text-align:center}
.icon{font-size:3rem;margin-bottom:24px;display:block;opacity:.5}
.code{font-size:5rem;font-weight:300;color:#21262d;line-height:1;letter-spacing:-.04em;margin-bottom:8px}
.title{font-size:.95rem;font-weight:600;color:#e6edf3;margin-bottom:12px}
.desc{font-size:.72rem;color:#6e7681;line-height:1.8}
</style>
</head>
<body>
<div class="card">
  <span class="icon">🔒</span>
  <div class="code">403</div>
  <div class="title">${m.title}</div>
  <p class="desc">${m.desc}</p>
</div>
</body>
</html>`;
}

function renderDashboard(rekap, bulan, txRows, spreadsheetId) {
    const saldo = rekap.saldo;
    const total = rekap.totalPemasukan + rekap.totalPengeluaran;
    const inPct = total > 0 ? (rekap.totalPemasukan / total * 100).toFixed(1) : '0.0';
    const outPct = total > 0 ? (rekap.totalPengeluaran / total * 100).toFixed(1) : '0.0';
    const savingsPct = rekap.totalPemasukan > 0 ? (saldo / rekap.totalPemasukan * 100).toFixed(0) : '0';
    const C = 238.76;
    const expArc = total > 0 ? +(rekap.totalPengeluaran / total * C).toFixed(2) : 0;
    const incArc = total > 0 ? +(rekap.totalPemasukan / total * C).toFixed(2) : 0;

    const iconMap = {
        gaji: '💼', bonus: '🎁', hadiah: '🎁', transfer: '💸', proyek: '💻', jajan: '🍢', bensin: '⛽', makan: '🍽️', minum: '☕'
    };
    function getIcon(desc) {
        const d = (desc || '').toLowerCase();
        for (const [k, v] of Object.entries(iconMap)) if (d.includes(k)) return v;
        return '📑';
    }

    const txHtml = [...txRows].sort((a, b) => b.tgl.localeCompare(a.tgl)).map(tx => {
        const isIn = tx.tipe === 'PEMASUKAN';
        return `<div class="tx-item">
            <div class="tx-icon ${isIn ? 'in' : 'out'}">${getIcon(tx.desc)}</div>
            <div class="tx-info">
                <div class="tx-desc">${tx.desc || 'Tanpa Deskripsi'}</div>
                <div class="tx-meta">${tx.tgl}</div>
            </div>
            <div class="tx-amount ${isIn ? 'in' : 'out'}">${isIn ? '+' : '-'}${rupiahFmt(tx.nominal)}</div>
        </div>`;
    }).join('');

    const nowStr = formatLocaleGMT8(new Date());

    return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Finance Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Geist+Mono:wght@400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #03050a; --glass: rgba(15, 20, 35, 0.7); --border: rgba(255, 255, 255, 0.08);
            --text: #f0f2f5; --muted: #8a919e; --accent: #6366f1; --in: #10b981; --out: #ef4444;
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        body { background: var(--bg); color: var(--text); font-family: 'Plus Jakarta Sans', sans-serif; min-height: 100vh; overflow-x: hidden; }
        
        /* Background Glows */
        .glow { position: fixed; width: 600px; height: 600px; border-radius: 50%; filter: blur(120px); opacity: 0.15; z-index: -1; pointer-events: none; }
        .glow-1 { top: -200px; left: -200px; background: var(--accent); }
        .glow-2 { bottom: -200px; right: -200px; background: var(--in); }

        .container { max-width: 800px; margin: 0 auto; padding: 40px 20px 100px; }
        
        header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 40px; animation: slideDown 0.6s ease-out; }
        .h-left h1 { font-size: 28px; font-weight: 800; letter-spacing: -1px; }
        .h-left p { color: var(--muted); font-family: 'Geist Mono'; font-size: 12px; margin-top: 4px; }
        .h-right { text-align: right; }
        .tag { background: rgba(99, 102, 241, 0.1); color: var(--accent); padding: 4px 12px; border-radius: 100px; font-size: 11px; font-weight: 700; }

        .hero-card { 
            background: var(--glass); border: 1px solid var(--border); backdrop-filter: blur(20px); 
            border-radius: 32px; padding: 48px; text-align: center; margin-bottom: 24px;
            box-shadow: 0 40px 100px -20px rgba(0,0,0,0.5); animation: zoomIn 0.8s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .hero-card p { font-family: 'Geist Mono'; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 2px; }
        .hero-card .balance { font-size: 56px; font-weight: 800; margin: 12px 0; letter-spacing: -2px; }
        .hero-card .balance.in { color: var(--in); }
        .hero-card .balance.out { color: var(--out); }

        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 40px; }
        .stat-card { 
            background: var(--glass); border: 1px solid var(--border); border-radius: 24px; padding: 24px;
            animation: slideUp 0.6s ease-out both;
        }
        .stat-card:nth-child(1) { animation-delay: 0.1s; }
        .stat-card:nth-child(2) { animation-delay: 0.2s; }
        .stat-label { font-size: 13px; color: var(--muted); margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
        .stat-label i { width: 8px; height: 8px; border-radius: 50%; }
        .stat-label .i-in { background: var(--in); }
        .stat-label .i-out { background: var(--out); }
        .stat-value { font-size: 20px; font-weight: 700; }

        .section-title { font-size: 18px; font-weight: 700; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
        .section-title::after { content: ''; flex: 1; height: 1px; background: var(--border); }

        .tx-list { background: var(--glass); border: 1px solid var(--border); border-radius: 28px; overflow: hidden; animation: slideUp 0.6s ease-out 0.3s both; }
        .tx-item { display: flex; align-items: center; padding: 18px 24px; border-bottom: 1px solid var(--border); transition: 0.2s; }
        .tx-item:last-child { border-bottom: none; }
        .tx-item:hover { background: rgba(255,255,255,0.02); }
        .tx-icon { width: 44px; height: 44px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        .tx-icon.in { background: rgba(16, 185, 129, 0.1); }
        .tx-icon.out { background: rgba(239, 68, 68, 0.1); }
        .tx-info { flex: 1; margin-left: 16px; }
        .tx-desc { font-size: 15px; font-weight: 600; }
        .tx-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
        .tx-amount { font-weight: 700; font-size: 15px; }
        .tx-amount.in { color: var(--in); }
        .tx-amount.out { color: var(--out); }

        footer { text-align: center; margin-top: 60px; font-family: 'Geist Mono'; font-size: 11px; color: var(--muted); }
        footer a { color: var(--accent); text-decoration: none; margin-left: 10px; border-bottom: 1px solid transparent; transition: 0.2s; }
        footer a:hover { border-bottom-color: var(--accent); }

        @keyframes slideDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes zoomIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }

        @media (max-width: 600px) {
            .hero-card { padding: 32px 24px; }
            .hero-card .balance { font-size: 36px; }
            .stats-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="glow glow-1"></div>
    <div class="glow glow-2"></div>

    <div class="container">
        <header>
            <div class="h-left">
                <h1>Finance <em>Vault</em></h1>
                <p>Periode: ${bulan}</p>
            </div>
            <div class="h-right">
                <span class="tag">REAL-TIME DATA</span>
            </div>
        </header>

        <section class="hero-card">
            <p>Saldo Bersih Tersedia</p>
            <div class="balance ${saldo >= 0 ? 'in' : 'out'}">${rupiahFmt(saldo)}</div>
            <div class="tag" style="background:rgba(255,255,255,0.05); color:var(--muted)">Updated ${nowStr}</div>
        </section>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label"><i class="i-in"></i> Pemasukan</div>
                <div class="stat-value" style="color:var(--in)">${rupiahFmt(rekap.totalPemasukan)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label"><i class="i-out"></i> Pengeluaran</div>
                <div class="stat-value" style="color:var(--out)">${rupiahFmt(rekap.totalPengeluaran)}</div>
            </div>
        </div>

        <h2 class="section-title">Riwayat Arus Kas</h2>
        <div class="tx-list">
            ${txHtml || '<div style="padding:40px; text-align:center; color:var(--muted)">Belum ada data untuk periode ini</div>'}
        </div>

        <footer>
            <span>&copy; 2026 Wabot Finance</span>
            <a href="https://docs.google.com/spreadsheets/d/${spreadsheetId}" target="_blank">Google Sheets</a>
        </footer>
    </div>
</body>
</html>`;
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
async function fireWebhook(payload, attempt) {
    attempt = attempt || 1;
    if (!WEBHOOK_URL) return;
    try {
        const body = JSON.stringify(payload);
        const url = new URL(WEBHOOK_URL);
        const opts = {
            hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search, method: 'POST',
            headers: {
                'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                ...(WEBHOOK_SECRET ? { 'X-Webhook-Secret': WEBHOOK_SECRET } : {})
            },
            timeout: 10000,
        };
        await new Promise((resolve, reject) => {
            const req = (url.protocol === 'https:' ? https : http).request(opts, res => {
                console.log('Webhook -> ' + res.statusCode + ' (attempt ' + attempt + '/' + MAX_WEBHOOK_ATTEMPTS + ')');
                res.resume(); resolve();
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(body); req.end();
        });
    } catch (e) {
        if (attempt < MAX_WEBHOOK_ATTEMPTS) {
            console.warn('Webhook failed [' + attempt + ']: ' + e.message + ' — retrying in 5s');
            setTimeout(() => fireWebhook(payload, attempt + 1), 5000);
        } else {
            console.error('Webhook dropped: ' + e.message);
        }
    }
}

// ─── LOCAL CACHE ──────────────────────────────────────────────────────────────
function clearLocalCache() {
    [path.join(DATA_PATH, SESSION_DIR_NAME), path.join(DATA_PATH, 'wwebjs_temp_session_' + SESSION_NAME)]
        .forEach(dir => { if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); console.log('Cleared: ' + path.basename(dir)); } });
}

// ─── MONGO STORE ──────────────────────────────────────────────────────────────
function createFixedStore(mongooseInstance) {
    const MAX_BACKUPS = 1;
    function getBucket(sn) {
        return new mongooseInstance.mongo.GridFSBucket(mongooseInstance.connection.db, { bucketName: 'whatsapp-' + sn });
    }
    return {
        async sessionExists(options) {
            const sn = path.basename(options.session);
            const col = mongooseInstance.connection.db.collection('whatsapp-' + sn + '.files');
            return await col.countDocuments({ filename: { $regex: '^' + sn + '\\.zip\\.' } }, { limit: 1 }) > 0;
        },
        async save(options) {
            const sn = path.basename(options.session);
            const zipPath = path.join(DATA_PATH, sn + '.zip');
            if (!fs.existsSync(zipPath)) { console.warn('Zip not found (skip): ' + zipPath); return; }
            const size = fs.statSync(zipPath).size;
            if (size < 1000) throw new Error('Zip too small (' + size + ' bytes)');
            console.log('Uploading: ' + sn + '.zip (' + (size / 1024).toFixed(1) + ' KB)');
            const bucket = getBucket(sn), slotName = sn + '.zip.' + Date.now();
            await new Promise((resolve, reject) => {
                fs.createReadStream(zipPath).pipe(bucket.openUploadStream(slotName)).on('error', reject).on('close', resolve);
            });
            const all = await bucket.find({}).toArray();
            const slots = all.filter(d => d.filename.startsWith(sn + '.zip.')).sort((a, b) => a.uploadDate - b.uploadDate);
            const toDel = slots.slice(0, Math.max(0, slots.length - MAX_BACKUPS));
            for (const d of toDel) await bucket.delete(d._id);
            console.log('MongoDB upload done @ ' + formatTime(new Date()));
            try { fs.unlinkSync(zipPath); } catch (e) { if (e.code !== 'ENOENT') console.warn('unlink: ' + e.message); }
        },
        async extract(options) {
            const sn = path.basename(options.session);
            const zipPath = options.path;
            const bucket = getBucket(sn);
            const all = await bucket.find({}).toArray();
            const slots = all.filter(d => d.filename.startsWith(sn + '.zip.')).sort((a, b) => b.uploadDate - a.uploadDate);
            if (!slots.length) throw new Error('No backup slots in MongoDB');
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                if (slot.length < 1000) { console.warn('Slot ' + (i + 1) + ' too small'); continue; }
                try {
                    console.log(`Downloading session slot ${i + 1}: ${slot.filename} (${(slot.length / 1024).toFixed(1)} KB)...`);
                    await new Promise((resolve, reject) => {
                        bucket.openDownloadStreamByName(slot.filename).pipe(fs.createWriteStream(zipPath)).on('error', reject).on('close', resolve);
                    });
                    const dl = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
                    if (dl < 1000) { console.warn('Slot ' + (i + 1) + ' empty'); continue; }
                    console.log('Restored from slot ' + (i + 1) + ': ' + (dl / 1024).toFixed(1) + ' KB'); return;
                } catch (err) { console.warn('Slot ' + (i + 1) + ' failed: ' + err.message); }
            }
            throw new Error('All backup slots failed');
        },
        async delete(options) {
            const sn = path.basename(options.session);
            const bucket = getBucket(sn);
            const docs = await bucket.find({}).toArray();
            for (const d of docs) await bucket.delete(d._id);
            console.log('Deleted ' + docs.length + ' slot(s): ' + sn);
        },
    };
}

// ─── FINANCE MESSAGE HANDLER ─────────────────────────────────────────────────
async function handleFinanceMessage(msg) {
    const senderId = msg.from;
    console.log('[Handler] Received message from ' + senderId + ': ' + msg.body.slice(0, 40));
    if (isRateLimited(senderId)) { console.log('Rate limited: ' + senderId); return; }

    if (msg.body === '!ping') { await queuedReply(msg, 'pong!').catch(e => console.error('Reply: ' + e.message)); return; }
    if (msg.body === '!status') {
        await queuedReply(msg,
            '╔════════════════════╗\n' +
            '  🤖  *BOT STATUS*\n' +
            '╚════════════════════╝\n\n' +
            '🟢  Status: ' + botStatus + '\n' +
            '🔖  Sesi  : ' + SESSION_NAME + '\n' +
            '⏱️  Uptime: ' + formatUptime((Date.now() - startTime) / 1000) + '\n' +
            '💾  Backup: ' + (sessionSavedAt || 'Belum ada')
        ).catch(e => console.error('Reply: ' + e.message));
        return;
    }

    if (msg.body === '/CekId') {
        await queuedReply(msg, `ID WhatsApp Anda adalah:\n*${senderId}*`).catch(e => console.error('Reply: ' + e.message));
        return;
    }

    if (msg.body.startsWith('/Register-')) {
        const isAdmin = ADMINISTRATOR.includes(senderId);
        if (!isAdmin) {
            await queuedReply(msg, 'Maaf, hanya administrator yang bisa melakukan registrasi.').catch(e => console.error('Reply: ' + e.message));
            return;
        }

        const parts = msg.body.split('-');
        if (parts.length < 3) {
            await queuedReply(msg, 'Format salah. Gunakan: /Register-ID-SpreadsheetID').catch(e => console.error('Reply: ' + e.message));
            return;
        }

        const targetId = parts[1].trim();
        const sheetId = parts[2].trim();

        try {
            const UserSettings = getUserSettingsModel();
            await UserSettings.updateOne({ from: targetId }, { $set: { spreadsheetId: sheetId } }, { upsert: true });
            await queuedReply(msg, `✅ Berhasil meregistrasi user!\nID: ${targetId}\nSheet: ${sheetId}`).catch(e => console.error('Reply: ' + e.message));
        } catch (err) {
            await queuedReply(msg, `❌ Gagal registrasi: ${err.message}`).catch(e => console.error('Reply: ' + e.message));
        }
        return;
    }

    console.log('[AI] Processing: ' + msg.body.slice(0, 80));

    // Pre-check: does the message contain ANY numeric content?
    // Covers digits, or words like juta/ribu/k/rb/sejuta/setengah
    const hasNumeric = /\d|\bjt\b|\bjuta\b|\brb\b|\bribu\b|\bk\b|\bsejuta\b|\bsetengah juta\b|\bsejt\b|\bsrbu\b/i.test(msg.body);

    let data = await parseWithHuggingFace(msg.body);

    // Safety net 1: if AI returned a nominal but message had no numeric content, override to missing_nominal
    if (!hasNumeric && data.nominal !== undefined) {
        console.warn('[AI] Hallucinated nominal ' + data.nominal + ' — overriding to missing_nominal');
        data = { missing_nominal: true, tipe: data.tipe, deskripsi: data.deskripsi };
    }

    // Safety net 2: rekap_bulanan requires an explicit month/period reference in the message
    if (data.command === 'rekap_bulanan') {
        const hasMonth = /\b(jan|feb|mar|apr|mei|jun|jul|agu|sep|okt|nov|des|januari|februari|maret|april|juni|juli|agustus|september|oktober|november|desember|bulan\s*(ini|lalu|kemarin)|\d{1,2}[\/-]\d{4})\b/i.test(msg.body);
        if (!hasMonth) {
            console.warn('[AI] rekap_bulanan without month reference — ignored: ' + msg.body.slice(0, 60));
            data = { error: 'bukan_perintah_valid' };
        }
    }

    if (data.error === true) {
        await queuedReply(msg, 'Maaf, AI tidak bisa memproses pesanmu. Coba lagi sebentar.')
            .catch(e => console.error('Reply: ' + e.message));
        return;
    }
    if (data.error === 'bukan_perintah_valid') { console.log('Non-finance — ignored'); return; }

    // TRANSAKSI TANPA NOMINAL — abaikan diam-diam
    if (data.missing_nominal === true) { console.log('Missing nominal — ignored'); return; }

    const settings = await getUserSettings(senderId);
    if (!settings) {
        await queuedReply(msg, 'Buku kas belum diatur untuk nomormu. Hubungi admin untuk mendaftarkan Spreadsheet ID.').catch(e => console.error('Reply: ' + e.message));
        return;
    }
    const { spreadsheetId } = settings;

    let sheet, userDoc;
    try {
        const res = await getSheet(spreadsheetId);
        sheet = res.sheet;
        userDoc = res.doc;
    }
    catch (err) {
        await queuedReply(msg, 'Tidak bisa akses spreadsheet: ' + err.message).catch(e => console.error('Reply: ' + e.message));
        return;
    }

    // REKAP BULANAN
    if (data.command === 'rekap_bulanan') {
        try {
            const bulanCari = data.bulan;
            const rekap = await generateRekapBulanan(sheet, bulanCari, senderId);
            const saldoRekap = rekap.saldo;
            const saldoRekapIcon = saldoRekap >= 0 ? '✅' : '⚠️';
            let teks = '╭────────────────────╮\n';
            teks += '   📊  *LAPORAN ' + bulanCari + '*\n';
            teks += '╰────────────────────╯\n\n';
            teks += '� *Pemasukan*\n';
            teks += '    └ ' + rupiahFmt(rekap.totalPemasukan) + '\n\n';
            teks += '� *Pengeluaran*\n';
            teks += '    └ ' + rupiahFmt(rekap.totalPengeluaran) + '\n\n';
            teks += '📑 *Saldo Akhir*\n';
            teks += '    └ ' + (saldoRekap >= 0 ? '✅ *' : '⚠️ *') + rupiahFmt(saldoRekap) + '*\n';
            teks += '─────────────────────\n';

            if (rekap.listTransaksi.length) {
                teks += '� *Detail Transaksi (' + rekap.listTransaksi.length + ')*\n';
                teks += '```\n';
                rekap.listTransaksi.forEach(tx => { teks += tx + '\n'; });
                teks += '```\n';
            } else {
                teks += '_Belum ada transaksi di periode ini._\n';
            }

            teks += '─────────────────────\n';
            teks += '🌐 *Web Dashboard:*\n' + PUBLIC_URL + '/dashboard?key=' + (await createDashboardKey(senderId, bulanCari));
            teks += '\n_(Link aktif 5 menit)_';

            await queuedReply(msg, teks).catch(e => console.error('Reply: ' + e.message));
            console.log('Sent monthly report');
            designSheet(userDoc, bulanCari, senderId).catch(e => console.error('designSheet: ' + e.message));
        } catch (err) {
            console.error('Rekap error: ' + err.message);
            await queuedReply(msg, 'Gagal mengambil rekap: ' + err.message).catch(e => console.error('Reply: ' + e.message));
        }
        return;
    }

    // CEK SALDO
    if (data.command === 'cek_saldo_sekarang' || data.command === 'cek_saldo_tanggal') {
        try {
            const tglCari = data.command === 'cek_saldo_tanggal' ? data.tanggal : null;
            const r2 = await hitungSaldo(sheet, tglCari, senderId);
            const judulStr = tglCari ? '📅  Saldo ' + tglCari : '💼  Saldo Saat Ini';
            const saldoSign = r2.saldo >= 0 ? '✅' : '⚠️';
            await queuedReply(msg,
                '╭────────────────────╮\n' +
                '   💰  *' + judulStr.toUpperCase() + '*\n' +
                '╰────────────────────╯\n\n' +
                '�  *Pemasukan*\n' +
                '    └ ' + rupiahFmt(r2.totalPemasukan) + '\n\n' +
                '�  *Pengeluaran*\n' +
                '    └ ' + rupiahFmt(r2.totalPengeluaran) + '\n\n' +
                '─────────────────────\n' +
                '💰  *SALDO BERSIH*\n' +
                '    └ ' + saldoSign + ' *' + rupiahFmt(r2.saldo) + '*'
            ).catch(e => console.error('Reply: ' + e.message));
        } catch (err) {
            await queuedReply(msg, 'Gagal mengambil saldo: ' + err.message).catch(e => console.error('Reply: ' + e.message));
        }
        return;
    }

    // SIMPAN TRANSAKSI
    if (data.nominal !== undefined) {
        const parsedNominal = parseFloat(data.nominal);
        if (isNaN(parsedNominal) || parsedNominal <= 0) {
            await queuedReply(msg, 'Nominal tidak valid. Coba lagi dengan nominal yang jelas.').catch(e => console.error('Reply: ' + e.message));
            return;
        }
        try {
            const rekapNow = await hitungSaldo(sheet, null, senderId);
            const tipeTx = data.tipe ? data.tipe.toUpperCase() : '';
            let saldoBaru = rekapNow.saldo;
            if (tipeTx === 'PEMASUKAN' || tipeTx === 'DEBIT') saldoBaru += parsedNominal;
            else if (tipeTx === 'PENGELUARAN' || tipeTx === 'CREDIT') saldoBaru -= parsedNominal;

            // Use GMT+8 time for sheet entry
            const now8 = nowGMT8();
            await sheet.addRow({
                Tanggal: formatDateID(now8) + ', ' + formatTimeLocal(now8),
                Deskripsi: sanitizeCell(data.deskripsi || ''),
                Nominal: parsedNominal,
                Tipe: sanitizeCell(data.tipe || ''),
                User: sanitizeCell(msg.pushname || msg.from),
                'Saldo Akhir': saldoBaru,
            });

            const isIn = (tipeTx === 'PEMASUKAN' || tipeTx === 'DEBIT');
            const arrow = isIn ? '➕' : '➖';
            const tipeLabel = isIn ? 'PEMASUKAN' : 'PENGELUARAN';
            const saldoIcon = saldoBaru >= 0 ? '✅' : '⚠️';

            await queuedReply(msg,
                '╭────────────────────╮\n' +
                '   ' + arrow + '  *NOTA TRANSAKSI*\n' +
                '╰────────────────────╯\n\n' +
                '📝  *Item:* ' + (data.deskripsi || '-') + '\n' +
                '💵  *Nominal:* ' + rupiahFmt(parsedNominal) + '\n' +
                '🏷️  *Kategori:* ' + tipeLabel + '\n' +
                '📅  *Waktu:* ' + formatTimeLocal(now8) + '\n\n' +
                '─────────────────────\n' +
                '💰  *Saldo Saat Ini:*\n' +
                '    ' + saldoIcon + ' *' + rupiahFmt(saldoBaru) + '*'
            ).catch(e => console.error('Reply: ' + e.message));
            console.log('Transaction saved: ' + data.tipe + ' ' + rupiahFmt(parsedNominal));

            const nowMonth = formatDateID(now8).substring(3); // MM/YYYY
            designSheet(userDoc, nowMonth, senderId).catch(e => console.error('designSheet: ' + e.message));
        } catch (err) {
            console.error('Transaction save error: ' + err.message);
            await queuedReply(msg, 'Gagal menyimpan transaksi: ' + err.message).catch(e => console.error('Reply: ' + e.message));
        }
        return;
    }

    console.warn('Unrecognised AI response: ' + JSON.stringify(data));
    console.log('[Handler] Finished processing message from ' + senderId);
}

async function handleWebhookForward(msg) {
    if (!WEBHOOK_URL) return;
    if (!msg.body && !msg.hasMedia) return;
    const [contact, chat] = await Promise.all([msg.getContact().catch(() => null), msg.getChat().catch(() => null)]);
    const payload = {
        event: 'message', timestamp: Date.now(),
        message: {
            id: msg.id._serialized, from: msg.from, to: msg.to, body: msg.body || '',
            type: msg.type, hasMedia: msg.hasMedia, isGroup: msg.from.endsWith('@g.us'),
            isForwarded: msg.isForwarded, timestamp: msg.timestamp
        },
        contact: contact ? { name: contact.pushname || contact.name || '', number: contact.number } : null,
        chat: chat ? { id: chat.id._serialized, name: chat.name, isGroup: chat.isGroup } : null,
    };
    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                const bytes = Math.ceil(media.data.length * 0.75);
                if (bytes <= MAX_MEDIA_WEBHOOK_BYTES) payload.message.media = { mimetype: media.mimetype, filename: media.filename || '', data: media.data };
                else { payload.message.mediaTooLarge = true; payload.message.mediaSize = bytes; }
            }
        } catch (e) { console.warn('Media download failed: ' + e.message); }
    }
    console.log('[' + msg.from + '] ' + msg.type + ': ' + (msg.body || '(media)'));
    fireWebhook(payload);
}

// ─── HTTP ROUTES ──────────────────────────────────────────────────────────────
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { console.warn('"qrcode" not found. Run: npm install qrcode'); }

app.get('/', (req, res) => {
    if (isReady && botStatus === 'ready') {
        return res.status(404).send(render404());
    }
    res.send(renderStatusPage());
});

app.get('/api/qr', async (req, res) => {
    if (!qrData) return res.status(404).json({ success: false, error: 'No QR available' });
    if (!QRCode) return res.redirect('https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qrData));
    try {
        const png = await QRCode.toBuffer(qrData, { type: 'png', width: 300, margin: 2 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(png);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/_health', (req, res) => res.status(200).send('ok'));

app.get('/api/status', requireApiKey, (req, res) => {
    res.json({
        success: true, status: botStatus, session: SESSION_NAME,
        environment: IS_PROD ? 'production' : 'development',
        uptime: formatUptime((Date.now() - startTime) / 1000),
        lastBackup: sessionSavedAt, webhookConfigured: !!WEBHOOK_URL
    });
});

app.post('/api/send/text', requireApiKey, requireReady, async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: 'Missing: to, message' });
    try {
        const chatId = normalizePhone(to);
        const sent = await withTimeout(waClient.sendMessage(chatId, message), 30000, 'sendMessage');
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/send/image', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url ? await MessageMedia.fromUrl(url, { unsafeMime: true }) : new MessageMedia(mime || 'image/jpeg', base64, filename || 'image.jpg');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { caption: caption || '' }), 30000, 'sendImage');
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/send/file', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, mime, filename, caption } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url ? await MessageMedia.fromUrl(url, { unsafeMime: true }) : new MessageMedia(mime || 'application/octet-stream', base64, filename || 'file');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { sendMediaAsDocument: true, caption: caption || '' }), 30000, 'sendFile');
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/send/audio', requireApiKey, requireReady, async (req, res) => {
    const { to, url, base64, ptt } = req.body;
    if (!to || (!url && !base64)) return res.status(400).json({ success: false, error: 'Missing: to, url or base64' });
    try {
        const chatId = normalizePhone(to);
        const media = url ? await MessageMedia.fromUrl(url, { unsafeMime: true }) : new MessageMedia('audio/ogg; codecs=opus', base64, 'audio.ogg');
        const sent = await withTimeout(waClient.sendMessage(chatId, media, { sendAudioAsVoice: ptt !== false }), 30000, 'sendAudio');
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/send/location', requireApiKey, requireReady, async (req, res) => {
    const { to, latitude, longitude, description } = req.body;
    if (!to || latitude == null || longitude == null) return res.status(400).json({ success: false, error: 'Missing: to, latitude, longitude' });
    try {
        const chatId = normalizePhone(to);
        const loc = new Location(parseFloat(latitude), parseFloat(longitude), description || '');
        const sent = await withTimeout(waClient.sendMessage(chatId, loc), 30000, 'sendLocation');
        res.json({ success: true, messageId: sent.id._serialized, to: chatId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/chats', requireApiKey, requireReady, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200), offset = parseInt(req.query.offset || '0', 10);
    try {
        const chats = await waClient.getChats(), page = chats.slice(offset, offset + limit);
        res.json({
            success: true, total: chats.length, limit, offset,
            chats: page.map(c => ({ id: c.id._serialized, name: c.name, isGroup: c.isGroup, unreadCount: c.unreadCount, timestamp: c.timestamp }))
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/contacts', requireApiKey, requireReady, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500), offset = parseInt(req.query.offset || '0', 10);
    try {
        const contacts = await waClient.getContacts(), page = contacts.slice(offset, offset + limit);
        res.json({
            success: true, total: contacts.length, limit, offset,
            contacts: page.map(c => ({ id: c.id._serialized, name: c.name || c.pushname || '', number: c.number, isMyContact: c.isMyContact }))
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/groups', requireApiKey, requireReady, async (req, res) => {
    try {
        const chats = await waClient.getChats(), groups = chats.filter(c => c.isGroup);
        res.json({
            success: true, count: groups.length,
            groups: groups.map(g => ({ id: g.id._serialized, name: g.name, participantCount: g.participants ? g.participants.length : 0 }))
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── /dashboard — protected by one-time key ──────────────────────────────────
app.get('/dashboard', async (req, res) => {
    const key = (req.query.key || '').trim();

    // No key provided — return 404 (don't hint that a key is needed)
    if (!key) return res.status(404).send(render404());

    // Validate the key against MongoDB
    let validation;
    try {
        validation = await validateDashboardKey(key);
    } catch (err) {
        console.error('Dashboard key validation error: ' + err.message);
        return res.status(500).send('<p style="font-family:monospace;padding:20px;color:#ff6b6b">Error: ' + err.message + '</p>');
    }

    if (!validation.valid) {
        return res.status(403).send(renderDashboardExpired(validation.reason));
    }

    // Key is valid — render the dashboard
    try {
        const { from, bulan } = validation;
        const settings = await getUserSettings(from);

        if (!settings) {
            return res.status(500).send('<p style="font-family:monospace;padding:20px;color:#ff6b6b">Settings not configured for this user.</p>');
        }

        const { sheet, doc: userDoc } = await getSheet(settings.spreadsheetId);
        const rekap = await generateRekapBulanan(sheet, bulan, from);

        // Always update headers and formatting on view
        designSheet(userDoc, bulan, from).catch(e => console.error('Dashboard designSheet error: ' + e.message));

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(renderDashboard(rekap, bulan, rekap.txRaw, settings.spreadsheetId));
    } catch (err) {
        console.error('Dashboard render error: ' + err.message);
        res.status(500).send('<p style="font-family:monospace;padding:20px;color:#ff6b6b">Error: ' + err.message + '</p>');
    }
});

// ── Catch-all — everything else returns 404 ──
app.use((req, res) => res.status(404).send(render404()));

app.listen(PORT, '0.0.0.0', () => console.log('Web server -> http://0.0.0.0:' + PORT));

// ─── WHATSAPP CLIENT ──────────────────────────────────────────────────────────
async function start() {
    if (isStarting) { console.warn('start() already running'); return; }
    isStarting = true; isReady = false; qrData = null;
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
            const best = slots.find(f => f.length >= 1000);
            if (!best) { console.warn('All slots corrupted — rescanning QR'); await store.delete({ session: SESSION_DIR_NAME }); }
            else { console.log('Session found: ' + slots.length + ' slot(s), best: ' + (best.length / 1024).toFixed(1) + ' KB'); validSession = true; }
        } else {
            console.log('No session in MongoDB — QR scan required');
        }

        const client = new Client({
            authStrategy: new RemoteAuth({
                clientId: SESSION_NAME,
                dataPath: DATA_PATH,
                store,
                backupSyncIntervalMs: BACKUP_INTERVAL
            }),
            puppeteer: puppeteerConfig,
            authTimeoutMs: 300000,
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1014711009-alpha.html',
            }
        });
        currentClient = client;

        client.on('loading_screen', (pct, msg) => console.log('Loading: ' + pct + '% - ' + msg));

        client.on('qr', qr => {
            if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; } // QR means it's not "stuck"
            botStatus = 'qr_ready'; qrData = qr;
            if (validSession) console.warn('Session restore failed — scan fresh QR');
            console.log('\n--- Scan QR: open the web UI or hit /api/qr ---\n');
            qrcode.generate(qr, { small: true });
        });

        client.on('authenticated', () => {
            if (!isReady) {
                botStatus = 'authenticated';
                readyWatchdog = setTimeout(() => {
                    if (!isReady) { console.error('Watchdog: never ready after 3min — restarting'); scheduleRestart(5000); }
                }, 3 * 60 * 1000);
            }
            qrData = null; console.log('Authenticated!');
        });

        client.on('auth_failure', msg => { botStatus = 'disconnected'; qrData = null; console.error('Auth failed: ' + msg); scheduleRestart(10000); });

        client.on('ready', () => {
            if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
            botStatus = 'ready'; waClient = client;
            if (isReady) { console.log('WA internal refresh — still ready'); return; }
            isReady = true; console.log('Bot is ready!');
            if (!validSession) console.log('New session — first backup in ~60s. Do NOT restart!');
            else console.log('Re-backup every ' + BACKUP_INTERVAL / 1000 + 's');
        });

        client.on('remote_session_saved', () => { sessionSavedAt = formatTime(new Date()); console.log('Session backed up @ ' + sessionSavedAt); });

        client.on('disconnected', reason => {
            botStatus = 'disconnected'; waClient = null; isReady = false; isStarting = false;
            if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
            console.warn('Disconnected: ' + reason); scheduleRestart(10000);
        });

        client.on('message', async msg => {
            if (msg.from === 'status@broadcast') return;
            if (ALLOWED_CHATS.length > 0 && !ALLOWED_CHATS.includes(msg.from)) return;
            try { await handleFinanceMessage(msg); }
            catch (err) {
                console.error('handleFinanceMessage error: ' + err.message);
                await queuedReply(msg, 'Terjadi kesalahan: ' + err.message).catch(e => console.error('Reply: ' + e.message));
            }
            handleWebhookForward(msg).catch(e => console.error('webhook fwd: ' + e.message));
        });

        client.on('message_reaction', reaction => {
            fireWebhook({
                event: 'reaction', timestamp: Date.now(),
                reaction: { id: reaction.id._serialized, from: reaction.senderId, emoji: reaction.reaction, messageId: reaction.msgId._serialized }
            });
        });

        console.log('Initializing WhatsApp client (Puppeteer)...');
        botStatus = 'starting';

        // START GLOBAL STARTUP WATCHDOG
        // If neither 'ready' nor 'qr' is emitted within 5 minutes, something is wrong.
        if (readyWatchdog) clearTimeout(readyWatchdog);
        readyWatchdog = setTimeout(() => {
            if (!isReady && botStatus !== 'qr_ready') {
                console.error('CRITICAL: Bot stuck in starting/initialization for 5min! Restarting...');
                scheduleRestart(5000);
            }
        }, 5 * 60 * 1000);

        await client.initialize();
        console.log('client.initialize() promise resolved.');

    } catch (err) {
        console.error('Startup error: ' + err.message);
        isStarting = false; scheduleRestart(15000);
    }
}

async function scheduleRestart(ms) {
    console.log('Restarting in ' + ms / 1000 + 's...');
    waClient = null; isStarting = false;
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
    if (currentClient) { try { await currentClient.destroy(); } catch (e) { } currentClient = null; }
    try { await mongoose.connection.close(); } catch (e) { }
    setTimeout(start, ms);
}

// ─── GLOBAL ERROR GUARDS ──────────────────────────────────────────────────────
const SILENT_IGNORABLE = [
    e => e && e.code === 'ENOENT',
    e => e && e.code === 'EACCES' && e.syscall === 'unlink',
];
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
    const lv = classifyError(err);
    if (lv === 'silent') return;
    if (lv === 'warn') { console.warn('Ignored uncaughtException: ' + err.message); return; }
    console.error('uncaughtException: ' + err.message);
    if (!isReady) scheduleRestart(10000);
});
process.on('unhandledRejection', reason => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const lv = classifyError(err);
    if (lv === 'silent') return;
    if (lv === 'warn') { console.warn('Ignored unhandledRejection: ' + err.message); return; }
    console.error('unhandledRejection: ' + err.message);
    if (!isReady) scheduleRestart(10000);
});

start();