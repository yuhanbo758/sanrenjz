const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

test('真实Electron隔离商店的HttpOnly Cookie登录、状态刷新及配置保留', async () => {
    const temporaryParent = fs.realpathSync(os.tmpdir());
    const temporary = fs.mkdtempSync(path.join(temporaryParent, 'sanrenjz-account-'));
    const runId = randomUUID(), appData = path.join(temporary, 'isolated-appdata'); fs.mkdirSync(appData);
    let result;
    try {
        result = await new Promise(resolve => {
            const env = { ...process.env, APPDATA: appData, SANRENJZ_SHOP_ACCOUNT_ROOT: temporary, SANRENJZ_SHOP_ACCOUNT_RUN_ID: runId }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
            const child = spawn(require('electron'), [path.join(__dirname, 'shop-account-electron.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let log = '', spawnError;
            child.stdout.on('data', chunk => { log += chunk.toString('utf8'); }); child.stderr.on('data', chunk => { log += chunk.toString('utf8'); });
            child.once('error', error => { spawnError = error; }); child.once('close', code => resolve({ code, log, spawnError }));
        });
    } finally {
        assert.equal(path.dirname(path.resolve(temporary)), temporaryParent);
        assert(path.basename(temporary).startsWith('sanrenjz-account-'));
        assert(!fs.lstatSync(temporary).isSymbolicLink());
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    const output = path.resolve(__dirname, '../dist/shop-account-validation'); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'electron.log'), result.log);
    assert.ifError(result.spawnError);
    assert.equal(result.code, 0, result.log.slice(-5000));
    const report = JSON.parse(fs.readFileSync(path.join(output, 'electron-report.json'), 'utf8'));
    assert.equal(report.runId, runId, '必须读取本次原生进程生成的报告');
    assert.equal(report.completed, true);
    assert.equal(report.success, true);
    assert.deepEqual(report.errors, []);
});
