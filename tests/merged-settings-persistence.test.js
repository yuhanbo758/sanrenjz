const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

test('设置真实IPC延迟、写入失败、关键词保留和独立进程重启', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-settings-persist-'));
    const output = path.resolve(__dirname, '../dist/merged-settings-persistence-validation');
    fs.mkdirSync(output, { recursive: true });
    const run = phase => new Promise((resolve, reject) => {
        const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [path.join(__dirname, 'merged-settings-persistence-electron.cjs'), root, phase], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '', timedOut = false;
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString('utf8'); });
        const timer = setTimeout(() => {
            timedOut = true;
            if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else child.kill('SIGKILL');
        }, 65000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
            clearTimeout(timer);
            fs.writeFileSync(path.join(output, `${phase}.log`), log, 'utf8');
            if (code !== 0 || timedOut) { console.error(log.slice(-10000)); reject(new Error(`${phase}: code=${code}, timedOut=${timedOut}`)); }
            else resolve();
        });
    });
    try {
        await run('write'); await run('restart');
        const written = JSON.parse(fs.readFileSync(path.join(output, 'write.json'), 'utf8'));
        const restarted = JSON.parse(fs.readFileSync(path.join(output, 'restart.json'), 'utf8'));
        assert(written.success && restarted.success);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
