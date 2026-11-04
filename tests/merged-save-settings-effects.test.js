const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

test('设置保存的系统自启动、快捷键与文件落盘同成同败，损坏配置不被覆盖', () => {
    const reportPath = path.join(__dirname, '..', 'dist', 'merged-save-settings-effects-report.json');
    fs.rmSync(reportPath, { force: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'merged-save-settings-effects-electron.cjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 3 * 1024 * 1024 });
    const log = path.join(__dirname, '..', 'dist', 'merged-save-settings-effects-console.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
    if (result.status !== 0) console.error((result.stdout || '').slice(-9000) + (result.stderr || '').slice(-9000));
    assert.equal(result.status, 0, `真实设置副作用验收失败：${log}；${result.error || ''}`);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).success, true, '子进程报告必须确认验收成功');
});

test('启动时系统自启动设置失败仅警告，不退出或覆盖配置', () => {
    const reportPath = path.join(__dirname, '..', 'dist', 'merged-startup-login-failure-report.json');
    fs.rmSync(reportPath, { force: true });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'merged-save-settings-effects-electron.cjs'), '--startup-failure'], { env, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 3 * 1024 * 1024 });
    if (result.status !== 0) console.error((result.stdout || '') + (result.stderr || ''));
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).success, true);
});
