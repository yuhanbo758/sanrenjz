const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

test('统一插件管理真实 Electron 验收：Python 设置、跨类型同名、刷新和数据保护', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-插件设置 空格-'));
    env.SANRENJZ_PLUGIN_MANAGEMENT_TEST_ROOT = root;
    let result;
    try {
        result = spawnSync(require('electron'), [path.join(__dirname, 'merged-plugin-management-electron.cjs')], {
            encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, env
        });
    } finally {
        // 仅在子进程正常结束后清理父进程分配的临时目录；超时保留现场。
        if (result?.status !== null && result?.status !== undefined && path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('sanrenjz-插件设置 空格-')) {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }
    const log = path.join(__dirname, '..', 'dist', 'merged-plugin-management-console.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''), 'utf8');
    if (result.status !== 0) console.error((result.stdout || '').slice(-7000) + (result.stderr || '').slice(-7000));
    assert.equal(result.status, 0, `隔离 Electron 验收成功；日志 ${log}；${result.error || ''}`);
});
