'use strict';

/**
 * fix-remoteauth.js
 * Patches whatsapp-web.js RemoteAuth to handle locked GPU/shader files on Windows
 * and make deleteMetadata() safe against ENOENT errors.
 *
 * Run automatically via: "postinstall" in package.json
 */

const fs   = require('fs');
const path = require('path');

const PATCH_MARKER = '// [PATCHED-WINDOWS-FINAL]';

const remoteAuthPath = path.join(
    process.cwd(),
    'node_modules', 'whatsapp-web.js',
    'src', 'authStrategies', 'RemoteAuth.js'
);

// ─── Sanity checks ────────────────────────────────────────────────────────────
if (!fs.existsSync(remoteAuthPath)) {
    console.error('❌ RemoteAuth.js not found. Is whatsapp-web.js installed?');
    process.exit(1);
}

// Check that required peer deps exist
for (const dep of ['archiver', 'fs-extra']) {
    try { require.resolve(dep); }
    catch {
        console.error(`❌ Missing dependency: ${dep}. Run: npm install ${dep}`);
        process.exit(1);
    }
}

let content = fs.readFileSync(remoteAuthPath, 'utf8');

if (content.includes(PATCH_MARKER)) {
    console.log('✅ RemoteAuth.js already patched — skipping.');
    process.exit(0);
}

// ─── Verify expected method signatures exist before patching ──────────────────
const REQUIRED_METHODS = ['async compressSession() {', 'async deleteMetadata() {'];
for (const sig of REQUIRED_METHODS) {
    if (!content.includes(sig)) {
        console.error(`❌ Could not find "${sig}" in RemoteAuth.js.`);
        console.error('   The whatsapp-web.js version may have changed. Please check manually.');
        process.exit(1);
    }
}

// ─── Helper: find the end of a method body starting at `startIdx` ─────────────
// NOTE: This is a simple brace-counter and does NOT handle string literals
// containing braces. It is sufficient for the relatively simple methods we target.
function findMethodEnd(src, startIdx) {
    let depth = 0, started = false;
    for (let i = startIdx; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') {
            depth--;
            if (started && depth === 0) return i + 1;
        }
    }
    return -1;
}

// ─── Replacement: compressSession ────────────────────────────────────────────
const NEW_COMPRESS = `async compressSession() { ${PATCH_MARKER}
        const fse      = require('fs-extra');
        const archiver = require('archiver');
        const nodePath = require('path');

        const zipPath = nodePath.join(this.dataPath, \`\${this.sessionName}.zip\`);

        // Clean tempDir first
        if (await fse.pathExists(this.tempDir)) {
            await fse.remove(this.tempDir).catch(() => {});
        }
        await fse.ensureDir(this.tempDir);

        // Folders Chrome locks permanently while running — skip them entirely.
        // They are GPU/shader caches and are NOT needed for WhatsApp session restore.
        const SKIP_DIRS = new Set([
            'GPUPersistentCache', 'GrShaderCache', 'ShaderCache',
            'DawnGraphiteCache', 'DawnWebGPUCache', 'BlobStorage',
        ]);

        // Recursive copy that silently skips locked files instead of failing.
        async function safeCopy(src, dst) {
            await fse.ensureDir(dst);
            let entries;
            try { entries = await fse.readdir(src); }
            catch { return; }

            for (const entry of entries) {
                if (SKIP_DIRS.has(entry)) continue;
                const srcPath = nodePath.join(src, entry);
                const dstPath = nodePath.join(dst, entry);
                try {
                    const stat = await fse.lstat(srcPath);
                    if (stat.isDirectory()) {
                        await safeCopy(srcPath, dstPath);
                    } else {
                        await fse.copyFile(srcPath, dstPath);
                    }
                } catch (e) {
                    // Silently skip locked/busy files (EBUSY, EPERM) — non-critical cache files
                    if (e.code !== 'EBUSY' && e.code !== 'EPERM') {
                        console.warn(\`[RemoteAuth] Skipped \${entry}: \${e.code}\`);
                    }
                }
            }
        }

        await safeCopy(this.userDataDir, this.tempDir);
        await this.deleteMetadata();

        return new Promise((resolve, reject) => {
            const stream  = fse.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 6 } });

            archive
                .directory(this.tempDir, false)
                .on('error', err => reject(err))
                .pipe(stream);

            stream.on('close', async () => {
                // Brief pause to ensure the file handle is fully released
                await new Promise(r => setTimeout(r, 500));
                const size = fse.existsSync(zipPath) ? fse.statSync(zipPath).size : 0;
                console.log(\`[RemoteAuth] Session zip: \${nodePath.basename(zipPath)} (\${(size / 1024).toFixed(1)} KB)\`);
                resolve();
            });
            stream.on('error', err => reject(err));
            archive.finalize();
        });
    }`;

// ─── Replacement: deleteMetadata ─────────────────────────────────────────────
const NEW_DELETE_METADATA = `async deleteMetadata() { ${PATCH_MARKER}
        const nodePath = require('path');
        const sessionDirs = [this.tempDir, nodePath.join(this.tempDir, 'Default')];
        for (const dir of sessionDirs) {
            let sessionFiles;
            try { sessionFiles = await fs.promises.readdir(dir); }
            catch (err) { if (err.code === 'ENOENT') continue; throw err; }

            for (const element of sessionFiles) {
                if (this.requiredDirs.includes(element)) continue;
                const dirElement = nodePath.join(dir, element);
                try {
                    const stats = await fs.promises.lstat(dirElement);
                    if (stats.isDirectory()) {
                        await fs.promises.rm(dirElement, {
                            recursive: true, force: true, maxRetries: this.rmMaxRetries,
                        }).catch(() => {});
                    } else {
                        await fs.promises.unlink(dirElement).catch(() => {});
                    }
                } catch (err) {
                    if (err.code !== 'ENOENT') throw err;
                }
            }
        }
    }`;

// ─── Apply patches ────────────────────────────────────────────────────────────
function replaceMethod(src, marker, replacement) {
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error(`Method not found: ${marker}`);
    const end = findMethodEnd(src, idx);
    if (end === -1) throw new Error(`Could not find end of method: ${marker}`);
    return src.slice(0, idx) + replacement + src.slice(end);
}

try {
    content = replaceMethod(content, 'async compressSession() {', NEW_COMPRESS);
    content = replaceMethod(content, 'async deleteMetadata() {',  NEW_DELETE_METADATA);
} catch (err) {
    console.error(`❌ Patch failed: ${err.message}`);
    process.exit(1);
}

// ─── Write back ───────────────────────────────────────────────────────────────
fs.writeFileSync(remoteAuthPath, content, 'utf8');

console.log('✅ compressSession() patched — recursive safe copy, skips locked GPU files');
console.log('✅ deleteMetadata()   patched — ENOENT-safe');
console.log('');
console.log('Next step: Delete old MongoDB sessions if any, then run: node index.js');