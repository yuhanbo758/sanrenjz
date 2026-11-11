const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { getLoginItemOptions } = require('../app/login-startup');

function runSettingsEffects(startupFailure = false, developmentLogin = false) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-save-effects-'));
    const env = { ...process.env, SANRENJZ_SETTINGS_EFFECTS_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
        return spawnSync(require('electron'), [path.join(__dirname, 'merged-save-settings-effects-electron.cjs'),
            ...(startupFailure ? ['--startup-failure'] : []),
            ...(developmentLogin ? ['--development-login'] : [])], { env, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 3 * 1024 * 1024 });
    } finally {
        // quit 事件仍处于 Chromium 原生退出流程；等待子进程彻底结束后才能删除用户数据目录。
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
        assert(path.basename(temporary).startsWith('sanrenjz-save-effects-'));
        assert(!fs.lstatSync(temporary).isSymbolicLink());
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

test('设置保存的系统自启动、快捷键与文件落盘同成同败，损坏配置不被覆盖', () => {
    const reportPath = path.join(__dirname, '..', 'dist', 'merged-save-settings-effects-report.json');
    fs.rmSync(reportPath, { force: true });
    const result = runSettingsEffects();
    const log = path.join(__dirname, '..', 'dist', 'merged-save-settings-effects-console.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
    if (result.status !== 0) console.error((result.stdout || '').slice(-9000) + (result.stderr || '').slice(-9000));
    assert.equal(result.status, 0, `真实设置副作用验收失败：${log}；${result.error || ''}`);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).success, true, '子进程报告必须确认验收成功');
});

test('只有安装版生成系统自启动命令，路径含空格或中文时仍保持完整', () => {
    assert.equal(getLoginItemOptions({ isPackaged: false }, 'D:\\source\\electron.exe'), null);
    assert.deepEqual(getLoginItemOptions({ isPackaged: true }, 'D:\\Program Files\\三人聚智\\三人聚智.exe'), {
        path: 'D:\\Program Files\\三人聚智\\三人聚智.exe', args: []
    });
});

test('开发版继承安装版自启偏好时不改写系统启动项，拒绝变更且保留原配置', () => {
    const reportPath = path.join(__dirname, '..', 'dist', 'merged-development-login-report.json');
    fs.rmSync(reportPath, { force: true });
    const result = runSettingsEffects(false, true);
    if (result.status !== 0) console.error((result.stdout || '') + (result.stderr || ''));
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).success, true);
});

test('启动时系统自启动设置失败仅警告，不退出或覆盖配置', () => {
    const reportPath = path.join(__dirname, '..', 'dist', 'merged-startup-login-failure-report.json');
    fs.rmSync(reportPath, { force: true });
    const result = runSettingsEffects(true);
    if (result.status !== 0) console.error((result.stdout || '') + (result.stderr || ''));
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).success, true);
});
