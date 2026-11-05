const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('设置数据导入页隔离验收：两种旧应用、预览选择、冲突备份及未保存输入', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-migration-settings-'));
    let result;
    try { result = await new Promise((resolve, reject) => {
        const env = { ...process.env, SANRENJZ_MIGRATION_SETTINGS_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [path.join(__dirname, 'migration-settings-electron.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        child.stdout.on('data', chunk => { log += chunk.toString('utf8'); }); child.stderr.on('data', chunk => { log += chunk.toString('utf8'); });
        child.once('error', reject); child.once('close', code => resolve({ code, log }));
    }); } finally {
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
        assert(path.basename(temporary).startsWith('sanrenjz-migration-settings-'));
        assert(!fs.lstatSync(temporary).isSymbolicLink());
        fs.rmSync(temporary, { recursive: true, force: true });
    }
    const output = path.resolve(__dirname, '../dist/migration-settings-validation');
    fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'electron.log'), result.log);
    assert.equal(result.code, 0, result.log.slice(-6000));
});
