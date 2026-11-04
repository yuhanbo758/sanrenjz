const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

test('快捷搜索真实宿主回归：目录、动作、失败反馈与中文输入法', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'merged-search-actions-electron.cjs')], {
        env, windowsHide: true, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024
    });
    const log = path.join(__dirname, '..', 'dist', 'merged-search-actions-console.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''), 'utf8');
    if (result.status !== 0) console.error((result.stdout || '').slice(-14000) + (result.stderr || '').slice(-14000));
    assert.equal(result.status, 0, `搜索宿主验收失败，日志 ${log}；${result.error || ''}`);
});
