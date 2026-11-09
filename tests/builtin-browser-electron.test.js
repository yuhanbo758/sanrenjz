'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

test('真实Electron内置商店导航、隔离会话及窗口关闭', async () => {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'sanrenjz-browser-navigation-'));
    const runId = randomUUID();
    const appData = path.join(root, 'isolated-appdata'); fs.mkdirSync(appData);
    let result;
    try {
        result = await new Promise(resolve => {
            const env = { ...process.env, APPDATA: appData, SANRENJZ_BROWSER_TEST_ROOT: root, SANRENJZ_BROWSER_TEST_RUN_ID: runId };
            delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
            const child = spawn(require('electron'), [path.join(__dirname, 'builtin-browser-electron.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let log = '', spawnError;
            child.stdout.on('data', bytes => { log += bytes.toString('utf8'); });
            child.stderr.on('data', bytes => { log += bytes.toString('utf8'); });
            child.once('error', error => { spawnError = error; }); child.once('close', code => resolve({ code, log, spawnError }));
        });
    } finally {
        // 父进程确认原生子进程close后，只清理本次分配的隔离目录。
        assert.equal(path.dirname(path.resolve(root)), parent);
        assert(path.basename(root).startsWith('sanrenjz-browser-navigation-'));
        assert(!fs.lstatSync(root).isSymbolicLink());
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    const output = path.resolve(__dirname, '../dist/builtin-browser-validation'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'electron.log'), result.log);
    assert.ifError(result.spawnError);
    assert.equal(result.code, 0, result.log.slice(-8500));
    const report = JSON.parse(fs.readFileSync(path.join(output, 'electron-report.json'), 'utf8'));
    assert.equal(report.runId, runId, '必须读取本次原生进程生成的报告');
    assert.equal(report.completed, true, '原生进程必须执行完整清理和报告');
    assert.equal(report.success, true);
    assert.deepEqual(report.errors, []);
    assert.equal(report.remainingGuestContents, 0);
});
