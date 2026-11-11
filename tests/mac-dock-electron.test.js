const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

test('Electron 隐藏插件窗口钉住、自动分离、取消和关闭维护真实 Mac Dock 身份', { skip: process.platform !== 'darwin' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-dock-electron-'));
    try {
        const result = spawnSync(require('electron'), [path.join(__dirname, 'mac-dock-electron.cjs'), root],
            { encoding: 'utf8', timeout: 25000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
        assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /MAC_DOCK_ELECTRON_OK/);
    } finally {
        // spawnSync 已等待原生子进程结束，且只清理父进程拥有的根。
        assert.equal(path.dirname(root), os.tmpdir());
        assert.match(path.basename(root), /^sanrenjz-dock-electron-/);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
