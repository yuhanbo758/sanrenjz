const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

test('设置体验真实 Electron 验收：环境状态、目录、保存语义与响应式布局', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'merged-settings-polish-electron.cjs')], {
        encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024, env
    });
    const log = path.join(__dirname, '..', 'dist', 'merged-settings-polish-console.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''), 'utf8');
    if (result.status !== 0) console.error((result.stdout || '').slice(-10000) + (result.stderr || '').slice(-10000));
    assert.equal(result.status, 0, `隔离设置界面验收成功；日志 ${log}；${result.error || ''}`);
});
