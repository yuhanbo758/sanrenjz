const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));

class MacPluginDock {
    constructor({ runtimeRoot, helperPath, platform = process.platform, spawnProcess = spawn, onError = () => {} }) {
        this.runtimeRoot = runtimeRoot;
        this.helperPath = helperPath;
        this.platform = platform;
        this.spawnProcess = spawnProcess;
        this.onError = onError;
        this.entries = new Map();
    }

    pin({ id, stableId = id, name, icon, focus, close }) {
        if (this.platform !== 'darwin' || this.entries.has(id)) return;
        // 可重建辅助包只存 userData runtime；不改插件、签名应用或宿主设置。
        const key = crypto.createHash('sha256').update(stableId).digest('hex').slice(0, 24);
        const bundle = path.join(this.runtimeRoot, key, `${String(name).replace(/[/:\x00-\x1f]/g, '_').slice(0, 80) || '插件'}.app`);
        const contents = path.join(bundle, 'Contents');
        const executable = path.join(contents, 'MacOS', 'mac-dock-helper');
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        // 快速取消/重钉时旧进程可能仍在退出，不能就地覆写其已签名可执行文件。
        const stagedExecutable = `${executable}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        try {
            fs.copyFileSync(this.helperPath, stagedExecutable);
            fs.chmodSync(stagedExecutable, 0o755);
            fs.renameSync(stagedExecutable, executable);
        } finally { fs.rmSync(stagedExecutable, { force: true }); }
        fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>mac-dock-helper</string><key>CFBundleIdentifier</key><string>com.sanrenjz.dock.${key}</string><key>CFBundleName</key><string>${xml(name)}</string><key>CFBundleDisplayName</key><string>${xml(name)}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMultipleInstancesProhibited</key><false/></dict></plist>`, 'utf8');
        const child = this.spawnProcess(executable, [icon || '', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        const entry = { child };
        this.entries.set(id, entry);
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > 4096) buffer = '';
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const action = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
                if (this.entries.get(id) !== entry) continue;
                if (action === 'focus') focus();
                if (action === 'close') close();
            }
        });
        child.stdin.on('error', () => {});
        child.once('error', error => { this._forget(id, entry); this.onError(error); });
        child.once('close', code => {
            const active = this.entries.get(id) === entry;
            this._forget(id, entry);
            if (active) this.onError(new Error(`Mac Dock 辅助进程意外退出（${code}）`));
        });
    }

    _forget(id, entry) { if (this.entries.get(id) === entry) this.entries.delete(id); }
    unpin(id) {
        const entry = this.entries.get(id);
        if (!entry) return;
        this.entries.delete(id);
        entry.child.stdin.end();
        const timer = setTimeout(() => { if (entry.child.exitCode === null) entry.child.kill('SIGKILL'); }, 2000);
        timer.unref(); entry.child.once('close', () => clearTimeout(timer));
    }
    dispose() { for (const id of this.entries.keys()) this.unpin(id); }
}

module.exports = { MacPluginDock };
