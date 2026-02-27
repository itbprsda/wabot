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

async function hitungSaldo(sheet, filterTanggal) {
    filterTanggal = filterTanggal || null;
    const rows = await sheet.getRows();
    let totalPemasukan = 0, totalPengeluaran = 0;
    rows.forEach(row => {
        const tgl = row.get('Tanggal'), nominalStr = row.get('Nominal'), tipe = row.get('Tipe');
        if (!tgl || !nominalStr) return;
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

async function generateRekapBulanan(sheet, bulanStr) {
    const rows = await sheet.getRows();
    let totalPemasukan = 0, totalPengeluaran = 0;
    const listTransaksi = [], txRaw = [];
    rows.forEach(row => {
        const tgl = row.get('Tanggal'), nominalStr = row.get('Nominal');
        const tipe = row.get('Tipe'), deskripsi = row.get('Deskripsi') || '';
        if (!tgl || !nominalStr) return;
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
async function designSheet(userDoc, bulanStr) {
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
            if (!bulanStr) return true;
            const tgl = (row.get('Tanggal') || '').toString();
            const day = tgl.includes(',') ? tgl.split(',')[0].trim() : tgl.trim();
            return day.endsWith(bulanStr);
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
        const label = bulanStr ? 'Bulan: ' + bulanStr : 'Semua Waktu';

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

            // Fix: Initialize textFormat if it doesn't exist to avoid "unsaved" errors
            if (!cl.textFormat) cl.textFormat = {};
            if (opts.bold !== undefined) cl.textFormat.bold = opts.bold;
            if (opts.size !== undefined) cl.textFormat.fontSize = opts.size;
            if (opts.color !== undefined) cl.textFormat.foregroundColor = opts.color;
            if (opts.italic !== undefined) cl.textFormat.italic = opts.italic;
        }

        // Clear all
        for (let r = 0; r < totalRows; r++)
            for (let col = 0; col < 5; col++) {
                const cl = c(r, col);
                cl.value = ''; cl.backgroundColor = BG;
                cl.textFormat = { foregroundColor: WHITE, bold: false, fontSize: 10 };
                cl.horizontalAlignment = 'LEFT'; cl.wrapStrategy = 'CLIP';
            }

        // Row 0 — Title
        for (let col = 0; col < 5; col++) s(0, col, { bg: SURFACE });
        s(0, 0, { value: 'LAPORAN KEUANGAN', bold: true, size: 14, color: WHITE, bg: SURFACE });
        s(0, 2, { value: label, bold: true, size: 11, color: ACCENT, bg: SURFACE, align: 'CENTER' });
        s(0, 4, { value: new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Makassar' }), size: 9, color: MUTED, bg: SURFACE, align: 'RIGHT' });

        // Row 1 — spacer
        for (let col = 0; col < 5; col++) s(1, col, { bg: BG });

        // Rows 2–7 — Summary block
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
        // Divider column
        for (let r = 2; r <= 7; r++) s(r, 2, { value: '', bg: BORDER });

        // Row 8 — spacer
        for (let col = 0; col < 5; col++) s(8, col, { bg: BG });

        // Row 9 — table header
        ['TANGGAL', 'DESKRIPSI', 'TIPE', 'NOMINAL', 'USER'].forEach((h, col) =>
            s(9, col, { value: h, bold: true, size: 9, color: MUTED, bg: SURFACE, align: col >= 3 ? 'RIGHT' : 'LEFT' })
        );

        // Rows 10+ — transactions
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
        console.log('Dashboard sheet designed: ' + (bulanStr || 'all time'));
    } catch (err) {
        console.error('designSheet error (non-fatal): ' + err.message);
    }
}

// ─── AI PARSING ───────────────────────────────────────────────────────────────
const AI_SYSTEM_PROMPT = `Kamu adalah asisten keuangan pribadi yang cerdas, ramah, dan fleksibel.
Tugasmu: baca pesan user dan klasifikasikan ke format JSON murni.

=== ATURAN NOMINAL — WAJIB DIIKUTI ===
HANYA ekstrak nominal jika ada angka/kata bilangan EKSPLISIT dalam pesan.
DILARANG KERAS mengarang, mengasumsikan, atau menebak nominal jika tidak ada angka.
Kata bilangan yang valid: angka (1, 500, 1000), jt/juta, rb/ribu/k, sejuta, setengah juta, dll.
Jika TIDAK ADA angka/kata bilangan sama sekali → WAJIB gunakan missing_nominal.

=== KONVERSI NOMINAL (hanya jika ada angka eksplisit) ===
- jt/juta = x1.000.000  → "2jt"=2000000, "1.5juta"=1500000, "sejuta"=1000000
- rb/ribu/k = x1.000    → "500rb"=500000, "50k"=50000
- angka polos < 10000 dalam konteks uang → ribuan → "500"=500000, "25"=25000
- angka polos >= 10000 → nilai asli → "75000"=75000
- "setengah juta"=500000, "seperempat juta"=250000

=== NORMALISASI TEKS ===
- msuk/msk/masuk/dapet/nerima/trima/masuk = PEMASUKAN
- kluar/klr/bayar/byr/beli/bli/kirim = PENGELUARAN
- bni/bca/bri/mandiri/dana/ovo/gopay = nama bank (masukkan ke deskripsi)
- blm/belum, d/di, yg/yang, catet/catat = kata penghubung (abaikan)

=== KLASIFIKASI ===

1. TRANSAKSI ADA NOMINAL — ada angka/bilangan eksplisit dalam pesan:
   -> {"nominal": angka, "tipe": "PEMASUKAN"/"PENGELUARAN", "deskripsi": "..."}
   Contoh: "transfer masuk bni 1jt"    -> {"nominal":1000000,"tipe":"PEMASUKAN","deskripsi":"Transfer masuk BNI"}
   Contoh: "byr listrik 150rb"         -> {"nominal":150000,"tipe":"PENGELUARAN","deskripsi":"Bayar listrik"}
   Contoh: "jajan 25"                  -> {"nominal":25000,"tipe":"PENGELUARAN","deskripsi":"Jajan"}

2. TRANSAKSI TANPA NOMINAL — ada maksud transaksi tapi TIDAK ADA angka/bilangan sama sekali:
   -> {"missing_nominal": true, "tipe": "PEMASUKAN"/"PENGELUARAN", "deskripsi": "..."}
   Contoh: "blm d catet yg msuk d bni itu"  -> {"missing_nominal":true,"tipe":"PEMASUKAN","deskripsi":"Transfer masuk BNI"}
   Contoh: "catat pengeluaran bensin tadi"   -> {"missing_nominal":true,"tipe":"PENGELUARAN","deskripsi":"Bensin"}
   Contoh: "ada transfer masuk"              -> {"missing_nominal":true,"tipe":"PEMASUKAN","deskripsi":"Transfer masuk"}

3. CEK SALDO SEKARANG:
   -> {"command":"cek_saldo_sekarang"}

4. CEK SALDO TANGGAL:
   -> {"command":"cek_saldo_tanggal","tanggal":"DD/MM/YYYY"}

5. REKAP BULANAN — WAJIB ada sebutan bulan/periode eksplisit (nama bulan, angka bulan, "bulan ini", "bulan lalu"):
   -> {"command":"rekap_bulanan","bulan":"MM/YYYY"}
   (Bulan saat ini: 02/2026)
   Contoh valid  : "rekap februari", "laporan bulan ini", "rekap 01/2026", "summary bulan lalu"
   Contoh TIDAK valid: "nnti rekap ulang", "rekap dong", "bisa rekap?" → {"error":"bukan_perintah_valid"}

6. LAINNYA — sapaan, percakapan biasa, perintah tidak lengkap, tidak ada data keuangan:
   -> {"error":"bukan_perintah_valid"}
   Contoh: "nnti rekap ulang", "oke", "makasih", "nanti aja", "coba lagi" → {"error":"bukan_perintah_valid"}

PENTING: output HANYA JSON murni, tanpa teks lain atau markdown.`;

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
    '--renderer-process-limit=2',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--safebrowsing-disable-auto-update',
    '--disable-breakpad',
    '--crash-dumps-dir=/tmp/chrome-crashes',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
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
        // Pemasukan
        gaji: '💼', salary: '💼', upah: '💼',
        bonus: '🎁', thr: '🎁', hadiah: '🎁',
        transfer: '💸', kirim: '💸',
        freelance: '💻', proyek: '💻', project: '💻',
        investasi: '📈', dividen: '📈', bunga: '📈',
        arisan: '🤝', iuran: '🤝',
        tambahan: '➕', lain: '➕',
        // Pengeluaran — makanan
        makan: '🍜', minum: '🧋', kopi: '☕', cafe: '☕', resto: '🍽️',
        jajan: '🍡', snack: '🍡', bakso: '🍜', nasi: '🍚',
        // Transportasi
        bensin: '⛽', bbm: '⛽', parkir: '🅿️',
        grab: '🚗', gojek: '🚗', ojek: '🚗', taxi: '🚕', bus: '🚌',
        // Tagihan
        listrik: '💡', air: '💧', pdam: '💧', internet: '🌐', wifi: '🌐',
        pulsa: '📱', paket: '📱', telp: '📱',
        // Belanja
        beli: '🛒', belanja: '🛒', shopee: '🛒', tokopedia: '🛒', lazada: '🛒',
        indomaret: '🏪', alfamart: '🏪', minimarket: '🏪',
        // Cicilan / tagihan besar
        angsuran: '🏠', kpr: '🏠', sewa: '🏠', kontrakan: '🏠', kos: '🏠', rent: '🏠',
        kartu: '💳', kredit: '💳',
        // Kesehatan
        dokter: '🏥', obat: '💊', apotek: '💊', rs: '🏥', 'rumah sakit': '🏥',
        // Pendidikan
        sekolah: '🎓', kuliah: '🎓', kursus: '🎓', les: '🎓',
        // Hiburan
        game: '🎮', netflix: '🎬', spotify: '🎵', bioskop: '🎬',
        // Bank/dompet digital
        bni: '🏦', bca: '🏦', bri: '🏦', mandiri: '🏦', bank: '🏦',
        dana: '👛', ovo: '👛', gopay: '👛', shopeepay: '👛', dompet: '👛',
    };
    function getIcon(desc) {
        const d = (desc || '').toLowerCase();
        // Match longer keys first to avoid partial matches
        const sorted = Object.entries(iconMap).sort((a, b) => b[0].length - a[0].length);
        for (const [k, v] of sorted) if (d.includes(k)) return v;
        return '📋';
    }

    const sorted = [...txRows].sort((a, b) => b.tgl.localeCompare(a.tgl) || b.jam.localeCompare(a.jam));

    const txHtml = sorted.map(tx => {
        const isIn = tx.tipe === 'PEMASUKAN';
        return `<div class="tx">
          <div class="tx-ic ${isIn ? 'ic-in' : 'ic-out'}">${getIcon(tx.desc)}</div>
          <div class="tx-body">
            <div class="tx-desc">${tx.desc}</div>
            <div class="tx-time">${tx.tgl} &middot; ${(tx.jam || '').replace(/\./g, ':')}</div>
          </div>
          <div class="tx-amt ${isIn ? 'amt-in' : 'amt-out'}">${isIn ? '+' : '-'}${rupiahFmt(tx.nominal)}</div>
        </div>`;
    }).join('');

    // Use GMT+8 for display time
    const nowStr = formatLocaleGMT8(new Date());

    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laporan ${bulan}</title>
<link href="https://fonts.googleapis.com/css2?family=Clash+Display:wght@400;500;600;700&family=Cabinet+Grotesk:wght@400;500;700;800&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg:       #05070d;
  --s1:       #0b0f1a;
  --s2:       #111827;
  --border:   #1e2535;
  --text:     #f0f4ff;
  --muted:    #4a5578;
  --sub:      #8b96b0;

  --teal:     #00d9b1;
  --teal-dim: rgba(0,217,177,.12);
  --coral:    #ff6b6b;
  --coral-dim:rgba(255,107,107,.12);
  --sky:      #38bdf8;
  --sky-dim:  rgba(56,189,248,.12);
  --amber:    #fbbf24;
  --amber-dim:rgba(251,191,36,.12);
  --violet:   #a78bfa;
  --violet-dim:rgba(167,139,250,.12);
  --lime:     #a3e635;
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:'Plus Jakarta Sans',sans-serif;min-height:100vh;overflow-x:hidden}

body::before{
  content:'';position:fixed;inset:0;
  background:
    radial-gradient(ellipse 60% 40% at 20% 10%,  rgba(0,217,177,.06)  0%, transparent 60%),
    radial-gradient(ellipse 50% 50% at 85% 15%,  rgba(56,189,248,.05) 0%, transparent 55%),
    radial-gradient(ellipse 70% 40% at 50% 90%,  rgba(167,139,250,.06)0%, transparent 60%),
    radial-gradient(ellipse 40% 60% at 0%   60%,  rgba(255,107,107,.04)0%, transparent 50%);
  pointer-events:none;z-index:0
}

.page{position:relative;z-index:1;max-width:1000px;margin:0 auto;padding:48px 24px 96px}

.hdr{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:52px;gap:16px;flex-wrap:wrap}
.hdr-left{}
.hdr-eyebrow{font-family:'JetBrains Mono',monospace;font-size:.65rem;letter-spacing:.18em;text-transform:uppercase;color:var(--teal);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.hdr-eyebrow::before{content:'';width:24px;height:1px;background:var(--teal)}
.hdr-title{font-family:'Plus Jakarta Sans',sans-serif;font-size:clamp(2rem,5vw,3.2rem);font-weight:800;letter-spacing:-.04em;line-height:1;color:var(--text)}
.hdr-title em{font-style:normal;background:linear-gradient(135deg,var(--teal),var(--sky));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hdr-right{text-align:right}
.hdr-bulan{font-family:'JetBrains Mono',monospace;font-size:1.1rem;font-weight:500;color:var(--text)}
.hdr-ts{font-size:.68rem;color:var(--muted);margin-top:4px}

.hero{
  position:relative;overflow:hidden;border-radius:24px;padding:40px 44px;margin-bottom:28px;
  background:linear-gradient(135deg,#0b1628 0%,#0d1e35 50%,#0c172c 100%);
  border:1px solid rgba(56,189,248,.15);
  animation:fadeUp .5s ease both
}
.hero::before{
  content:'';position:absolute;top:-80px;right:-80px;width:320px;height:320px;
  background:radial-gradient(circle,rgba(56,189,248,.1) 0%,transparent 65%);pointer-events:none
}
.hero::after{
  content:'';position:absolute;bottom:-60px;left:-60px;width:240px;height:240px;
  background:radial-gradient(circle,rgba(0,217,177,.07) 0%,transparent 65%);pointer-events:none
}
.hero-label{font-family:'JetBrains Mono',monospace;font-size:.65rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.hero-amount{font-size:clamp(2.4rem,7vw,4.2rem);font-weight:800;letter-spacing:-.05em;line-height:1;margin-bottom:8px}
.hero-amount.pos{background:linear-gradient(120deg,var(--teal),var(--sky));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-amount.neg{color:var(--coral)}
.hero-sub{font-size:.75rem;color:var(--sub);margin-bottom:32px}
.hero-pills{display:flex;gap:10px;flex-wrap:wrap}
.pill{display:flex;align-items:center;gap:7px;padding:8px 16px;border-radius:100px;font-size:.72rem;font-weight:500;border:1px solid}
.pill-in {background:var(--teal-dim);border-color:rgba(0,217,177,.25);color:var(--teal)}
.pill-out{background:var(--coral-dim);border-color:rgba(255,107,107,.25);color:var(--coral)}
.pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor}

.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:28px}
@media(max-width:560px){.grid2{grid-template-columns:1fr}}

.stat{
  border-radius:20px;padding:28px;border:1px solid var(--border);
  position:relative;overflow:hidden;
  transition:transform .25s,box-shadow .25s;animation:fadeUp .5s ease both
}
.stat:hover{transform:translateY(-3px);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.stat-in {background:linear-gradient(135deg,#091a17,#0e2620)}
.stat-out{background:linear-gradient(135deg,#1a0b0f,#200e13)}
.stat-glow{position:absolute;top:-40px;right:-40px;width:160px;height:160px;border-radius:50%;pointer-events:none;opacity:.4}
.stat-glow-in {background:radial-gradient(circle,var(--teal-dim) 0%,transparent 70%)}
.stat-glow-out{background:radial-gradient(circle,var(--coral-dim) 0%,transparent 70%)}
.stat-icon-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.stat-badge{font-family:'JetBrains Mono',monospace;font-size:.6rem;letter-spacing:.12em;text-transform:uppercase;padding:4px 10px;border-radius:6px;font-weight:500}
.stat-badge-in {background:var(--teal-dim);color:var(--teal)}
.stat-badge-out{background:var(--coral-dim);color:var(--coral)}
.stat-arrow{font-size:1.4rem}
.stat-label{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px}
.stat-val{font-size:clamp(1.3rem,3.5vw,1.9rem);font-weight:800;letter-spacing:-.03em;line-height:1;margin-bottom:6px}
.stat-val-in {color:var(--teal)}
.stat-val-out{color:var(--coral)}
.stat-count{font-family:'JetBrains Mono',monospace;font-size:.65rem;color:var(--muted)}
.stat-bar{height:4px;border-radius:4px;background:rgba(255,255,255,.05);margin-top:20px;overflow:hidden}
.stat-fill{height:100%;border-radius:4px;transition:width 1.4s cubic-bezier(.16,1,.3,1)}
.stat-fill-in {background:linear-gradient(90deg,var(--teal),var(--sky))}
.stat-fill-out{background:linear-gradient(90deg,var(--coral),var(--amber))}

.chart-card{
  border-radius:24px;padding:36px;border:1px solid var(--border);
  background:var(--s1);margin-bottom:28px;animation:fadeUp .6s ease both
}
.section-eyebrow{font-family:'JetBrains Mono',monospace;font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:24px;display:flex;align-items:center;gap:8px}
.section-eyebrow::before{content:'';width:16px;height:1px;background:var(--muted)}
.chart-inner{display:flex;align-items:center;justify-content:center;gap:52px;flex-wrap:wrap}

.donut-wrap{position:relative;width:210px;height:210px;flex-shrink:0}
.donut-svg{width:100%;height:100%;transform:rotate(-90deg)}
.donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.donut-pct{font-size:2.2rem;font-weight:800;letter-spacing:-.04em;line-height:1;background:linear-gradient(135deg,var(--teal),var(--sky));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.donut-sub{font-family:'JetBrains Mono',monospace;font-size:.58rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-top:4px}

.legend{display:flex;flex-direction:column;gap:24px;min-width:220px}
.leg-item{}
.leg-top{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.leg-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
.leg-dot-in   {background:var(--teal);  box-shadow:0 0 10px rgba(0,217,177,.4)}
.leg-dot-out  {background:var(--coral); box-shadow:0 0 10px rgba(255,107,107,.4)}
.leg-dot-saldo{background:var(--violet);box-shadow:0 0 10px rgba(167,139,250,.4)}
.leg-name{font-family:'JetBrains Mono',monospace;font-size:.65rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.leg-val{font-size:1.3rem;font-weight:800;letter-spacing:-.03em;padding-left:20px}
.leg-val-in   {color:var(--teal)}
.leg-val-out  {color:var(--coral)}
.leg-val-saldo{color:var(--violet)}
.leg-pct{font-family:'JetBrains Mono',monospace;font-size:.62rem;color:var(--muted);padding-left:20px;margin-top:2px}

.tx-card{
  border-radius:24px;border:1px solid var(--border);
  background:var(--s1);overflow:hidden;animation:fadeUp .7s ease both
}
.tx-hdr{display:flex;justify-content:space-between;align-items:center;padding:28px 32px 22px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:10px}
.tx-hdr-label{font-family:'JetBrains Mono',monospace;font-size:.65rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);display:flex;align-items:center;gap:8px}
.tx-hdr-label::before{content:'';width:12px;height:1px;background:var(--muted)}
.tx-badge{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:100px;padding:4px 12px;font-family:'JetBrains Mono',monospace;font-size:.62rem;color:var(--muted)}
.tx-list{padding:8px 0}
.tx{display:flex;align-items:center;gap:16px;padding:14px 32px;border-bottom:1px solid rgba(255,255,255,.03);transition:background .15s}
.tx:last-child{border-bottom:none}
.tx:hover{background:rgba(255,255,255,.02)}
.tx-ic{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:.95rem;flex-shrink:0}
.ic-in {background:var(--teal-dim)}
.ic-out{background:var(--coral-dim)}
.tx-body{flex:1;min-width:0}
.tx-desc{font-size:.82rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-transform:capitalize;margin-bottom:3px}
.tx-time{font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--muted)}
.tx-amt{font-weight:800;font-size:.9rem;white-space:nowrap;text-align:right;letter-spacing:-.01em}
.amt-in {color:var(--teal)}
.amt-out{color:var(--coral)}
.amt-in::before{content:'+'}
.amt-out::before{content:'-'}

.footer{margin-top:56px;text-align:center;font-family:'JetBrains Mono',monospace;font-size:.6rem;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;line-height:2.2}
.footer a{color:var(--sky);text-decoration:none}

@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.hero{animation-delay:.04s}
.stat:nth-child(1){animation-delay:.1s}
.stat:nth-child(2){animation-delay:.16s}
.chart-card{animation-delay:.22s}
.tx-card{animation-delay:.28s}
.donut-ring{transition:stroke-dasharray 1.6s cubic-bezier(.16,1,.3,1),stroke-dashoffset 1.6s cubic-bezier(.16,1,.3,1)}
</style>
</head>
<body>
<div class="page">

  <div class="hdr">
    <div class="hdr-left">
      <div class="hdr-eyebrow">Laporan Keuangan &middot; ${spreadsheetId?.substring(0, 8)}...</div>
      <h1 class="hdr-title">Ringkasan <em>Bulanan</em></h1>
    </div>
    <div class="hdr-right">
      <div class="hdr-bulan">${bulan}</div>
      <div class="hdr-ts">Diperbarui: ${nowStr} WIB</div>
    </div>
  </div>

  <div class="hero">
    <div class="hero-label">Saldo Bersih</div>
    <div class="hero-amount ${saldo >= 0 ? 'pos' : 'neg'}">${rupiahFmt(saldo)}</div>
    <div class="hero-sub">Total semua transaksi bulan ${bulan}</div>
    <div class="hero-pills">
      <div class="pill pill-in"><span class="pill-dot"></span>Pemasukan: ${rupiahFmt(rekap.totalPemasukan)}</div>
      <div class="pill pill-out"><span class="pill-dot"></span>Pengeluaran: ${rupiahFmt(rekap.totalPengeluaran)}</div>
    </div>
  </div>

  <div class="grid2">
    <div class="stat stat-in">
      <div class="stat-glow stat-glow-in"></div>
      <div class="stat-icon-row">
        <span class="stat-badge stat-badge-in">Masuk</span>
        <span class="stat-arrow" style="color:var(--teal)">↑</span>
      </div>
      <div class="stat-label">Total Pemasukan</div>
      <div class="stat-val stat-val-in">${rupiahFmt(rekap.totalPemasukan)}</div>
      <div class="stat-count">${txRows.filter(t => t.tipe === 'PEMASUKAN').length} transaksi &middot; ${inPct}% dari arus total</div>
      <div class="stat-bar"><div class="stat-fill stat-fill-in" id="bar-in" style="width:0"></div></div>
    </div>
    <div class="stat stat-out">
      <div class="stat-glow stat-glow-out"></div>
      <div class="stat-icon-row">
        <span class="stat-badge stat-badge-out">Keluar</span>
        <span class="stat-arrow" style="color:var(--coral)">↓</span>
      </div>
      <div class="stat-label">Total Pengeluaran</div>
      <div class="stat-val stat-val-out">${rupiahFmt(rekap.totalPengeluaran)}</div>
      <div class="stat-count">${txRows.filter(t => t.tipe === 'PENGELUARAN').length} transaksi &middot; ${outPct}% dari arus total</div>
      <div class="stat-bar"><div class="stat-fill stat-fill-out" id="bar-out" style="width:0"></div></div>
    </div>
  </div>

  <div class="chart-card">
    <div class="section-eyebrow">Distribusi Keuangan</div>
    <div class="chart-inner">
      <div class="donut-wrap">
        <svg class="donut-svg" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="38" fill="none" stroke="#1e2535" stroke-width="13"/>
          <circle id="arc-out" cx="50" cy="50" r="38" fill="none" stroke="url(#gOut)" stroke-width="13"
            stroke-dasharray="0 238.76" stroke-linecap="round" class="donut-ring"
            style="filter:drop-shadow(0 0 5px rgba(255,107,107,.5))"/>
          <circle id="arc-in" cx="50" cy="50" r="38" fill="none" stroke="url(#gIn)" stroke-width="13"
            stroke-dasharray="0 238.76" stroke-linecap="round" class="donut-ring"
            style="filter:drop-shadow(0 0 5px rgba(0,217,177,.5))"/>
          <defs>
            <linearGradient id="gIn"  x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#00d9b1"/>
              <stop offset="100%" stop-color="#38bdf8"/>
            </linearGradient>
            <linearGradient id="gOut" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#ff6b6b"/>
              <stop offset="100%" stop-color="#fbbf24"/>
            </linearGradient>
          </defs>
        </svg>
        <div class="donut-center">
          <div class="donut-pct">${savingsPct}%</div>
          <div class="donut-sub">Tabungan</div>
        </div>
      </div>
      <div class="legend">
        <div class="leg-item">
          <div class="leg-top"><span class="leg-dot leg-dot-in"></span><span class="leg-name">Pemasukan</span></div>
          <div class="leg-val leg-val-in">${rupiahFmt(rekap.totalPemasukan)}</div>
          <div class="leg-pct">${inPct}% dari total arus</div>
        </div>
        <div class="leg-item">
          <div class="leg-top"><span class="leg-dot leg-dot-out"></span><span class="leg-name">Pengeluaran</span></div>
          <div class="leg-val leg-val-out">${rupiahFmt(rekap.totalPengeluaran)}</div>
          <div class="leg-pct">${outPct}% dari total arus</div>
        </div>
        <div class="leg-item">
          <div class="leg-top"><span class="leg-dot leg-dot-saldo"></span><span class="leg-name">Saldo Bersih</span></div>
          <div class="leg-val leg-val-saldo">${rupiahFmt(saldo)}</div>
          <div class="leg-pct">${savingsPct}% dari pemasukan tersisa</div>
        </div>
      </div>
    </div>
  </div>

  <div class="tx-card">
    <div class="tx-hdr">
      <div class="tx-hdr-label">Riwayat Transaksi</div>
      <div class="tx-badge">${txRows.length} transaksi</div>
    </div>
    <div class="tx-list">${txHtml}</div>
  </div>

  <div class="footer">
    wabot finance &middot; ${bulan} &middot; data langsung dari spreadsheet<br>
    <a href="https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}" target="_blank">Buka Google Sheets</a>
  </div>
</div>

<script>
const C=${C}, expArc=${expArc}, incArc=${incArc}, total=${total};
const inPct=${parseFloat(inPct)}, outPct=${parseFloat(outPct)};
const bigger=Math.max(${rekap.totalPemasukan},${rekap.totalPengeluaran});

setTimeout(()=>{
  if(total > 0){
    const ao=document.getElementById('arc-out');
    ao.setAttribute('stroke-dasharray', expArc+' '+(C-expArc));
    ao.setAttribute('stroke-dashoffset','0');
    const ai=document.getElementById('arc-in');
    ai.setAttribute('stroke-dasharray', incArc+' '+(C-incArc));
    ai.setAttribute('stroke-dashoffset', -expArc);
  }
  if(bigger > 0){
    document.getElementById('bar-in').style.width  =(${rekap.totalPemasukan}  /bigger*100)+'%';
    document.getElementById('bar-out').style.width =(${rekap.totalPengeluaran}/bigger*100)+'%';
  }
},350);
</script>
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
            const rekap = await generateRekapBulanan(sheet, bulanCari);
            const saldoRekap = rekap.saldo;
            const saldoRekapIcon = saldoRekap >= 0 ? '✅' : '⚠️';
            let teks = '╔════════════════════╗\n';
            teks += '  📊  *REKAP ' + bulanCari + '*\n';
            teks += '╚════════════════════╝\n\n';
            teks += '📈  Pemasukan\n';
            teks += '    *' + rupiahFmt(rekap.totalPemasukan) + '*\n\n';
            teks += '📉  Pengeluaran\n';
            teks += '    *' + rupiahFmt(rekap.totalPengeluaran) + '*\n\n';
            teks += '─────────────────────\n';
            teks += saldoRekapIcon + '  Saldo Bersih\n';
            teks += '    *' + rupiahFmt(saldoRekap) + '*\n\n';
            if (rekap.listTransaksi.length) {
                teks += '─────────────────────\n';
                teks += '🗒️  *Transaksi (' + rekap.listTransaksi.length + ')*\n';
                teks += '```\n';
                rekap.listTransaksi.forEach(tx => { teks += tx + '\n'; });
                teks += '```\n';
            } else {
                teks += '_Belum ada transaksi bulan ini_\n';
            }
            teks += '\n📋  *Spreadsheet:*\nhttps://docs.google.com/spreadsheets/d/' + spreadsheetId;

            // Generate dashboard key and include in URL
            if (PUBLIC_URL) {
                try {
                    const dashKey = await createDashboardKey(senderId, bulanCari);
                    teks += '\n\n*Dashboard Visual:*\n' + PUBLIC_URL + '/dashboard?key=' + dashKey;
                    teks += '\n_(Link aktif 5 menit)_';
                } catch (keyErr) {
                    console.error('Failed to create dashboard key: ' + keyErr.message);
                    // Fallback: no dashboard link if key creation fails
                }
            }

            await queuedReply(msg, teks).catch(e => console.error('Reply: ' + e.message));
            console.log('Sent monthly report');
            designSheet(userDoc, bulanCari).catch(e => console.error('designSheet: ' + e.message));
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
            const r2 = await hitungSaldo(sheet, tglCari);
            const judulStr = tglCari ? '📅  Saldo ' + tglCari : '💼  Saldo Saat Ini';
            const saldoSign = r2.saldo >= 0 ? '✅' : '⚠️';
            await queuedReply(msg,
                '╔════════════════════╗\n' +
                '  ' + judulStr + '\n' +
                '╚════════════════════╝\n\n' +
                '📈  Pemasukan\n' +
                '    *' + rupiahFmt(r2.totalPemasukan) + '*\n\n' +
                '📉  Pengeluaran\n' +
                '    *' + rupiahFmt(r2.totalPengeluaran) + '*\n\n' +
                '─────────────────────\n' +
                saldoSign + '  Saldo Bersih\n' +
                '    *' + rupiahFmt(r2.saldo) + '*'
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
            const rekapNow = await hitungSaldo(sheet);
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
            const arrow = isIn ? '📈' : '📉';
            const tipeLabel = isIn ? '🟢 Pemasukan' : '🔴 Pengeluaran';
            const saldoIcon = saldoBaru >= 0 ? '✅' : '⚠️';
            await queuedReply(msg,
                '╔════════════════════╗\n' +
                '  ' + arrow + '  *TERCATAT*\n' +
                '╚════════════════════╝\n\n' +
                '📝  ' + (data.deskripsi || '-') + '\n' +
                '💵  *' + rupiahFmt(parsedNominal) + '*\n' +
                '🏷️  ' + tipeLabel + '\n\n' +
                '─────────────────────\n' +
                saldoIcon + '  Saldo sekarang\n' +
                '    *' + rupiahFmt(saldoBaru) + '*'
            ).catch(e => console.error('Reply: ' + e.message));
            console.log('Transaction saved: ' + data.tipe + ' ' + rupiahFmt(parsedNominal));

            const nowMonth = formatDateID(now8).substring(3); // MM/YYYY
            designSheet(userDoc, nowMonth).catch(e => console.error('designSheet: ' + e.message));
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
        const rekap = await generateRekapBulanan(sheet, bulan);

        // Always update headers and formatting on view
        designSheet(userDoc, bulan).catch(e => console.error('Dashboard designSheet error: ' + e.message));

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
            authTimeoutMs: 180000,
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
            }
        });
        currentClient = client;

        client.on('loading_screen', (pct, msg) => console.log('Loading: ' + pct + '% - ' + msg));

        client.on('qr', qr => {
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

        console.log('Initializing WhatsApp client...');
        botStatus = 'starting';
        await client.initialize();

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