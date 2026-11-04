const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('node:assert/strict');
const { app, BrowserWindow, globalShortcut, session } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const Manager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-save-effects-'));
const profile = path.join(temporary, 'profile'); fs.mkdirSync(profile);
const tools = path.join(temporary, 'tools'); fs.mkdirSync(tools);
const python = path.join(temporary, 'python'); fs.mkdirSync(python);
const settingsPath = path.join(profile, 'settings.json');
const startupFailure = process.argv.includes('--startup-failure');
fs.writeFileSync(settingsPath, JSON.stringify({ globalHotkey: 'Ctrl+Alt+F6', pinHotkey: 'Ctrl+Alt+F7', superPanelHotkey: '', autoStart: startupFailure, enableRightClickPanel: false, migrationPrompted: true, pythonMode: 'none', customMarker: '必须保留' }));
class FixtureManager extends Manager { constructor(win, options) { super(win, options); this.pluginDir = tools; this.catalog = new PluginCatalog(tools); } }
class FixturePython extends pythonModule.PythonManager { constructor(options) { super({ ...options, pluginDir: python }); } }
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_TEST_HIDDEN = '1';
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const bindings = new Map();
let registrations = 0, loginState = false, failDisable = false;
const loginCalls = [];
globalShortcut.register = (key, callback) => { registrations++; if (bindings.has(key)) return false; bindings.set(key, callback); return true; };
globalShortcut.unregister = key => bindings.delete(key);
globalShortcut.unregisterAll = () => bindings.clear();
globalShortcut.isRegistered = key => bindings.has(key);
app.getLoginItemSettings = () => ({ openAtLogin: loginState });
app.setLoginItemSettings = value => {
    if (startupFailure && value.openAtLogin) throw new Error('模拟启动时系统设置失败');
    loginCalls.push(value.openAtLogin); loginState = value.openAtLogin;
    if (failDisable && !value.openAtLogin) throw new Error('模拟系统自启动失败');
};
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.showInactive = () => {}; win.focus = () => {}; });
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })));
const report = { assertions: [], errors: [], isolatedProfile: true, systemLoginMocked: true };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
const ready = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => resolve(win))));
process.on('unhandledRejection', error => report.errors.push(String(error)));
const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
require('../main');
(async () => {
    const win = await ready;
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const save = patch => evaluate(`require('electron').ipcRenderer.invoke('save-settings',${JSON.stringify(patch)}).then(value=>({ok:true,value}),error=>({ok:false,error:error.message}))`);
    try {
        if (startupFailure) {
            check(!win.isDestroyed() && BrowserWindow.getAllWindows().includes(win), '启动时系统设置失败不会退出主程序');
            check(bindings.has('Ctrl+Alt+F6') && bindings.has('Ctrl+Alt+F7'), '系统设置失败不阻断已配置快捷键');
            check(read().autoStart && read().customMarker === '必须保留', '启动失败提示保留原有配置');
            check(report.errors.length === 0, '启动系统设置失败不形成未处理拒绝');
            report.success = true;
            return;
        }
        const baselineRegistrations = registrations;
        check((await save({ pluginSearchSettings: { fixture: { enabled: true, keywords: ['保留'] } } })).ok, '局部偏好能保存');
        check(loginCalls.length === 0 && registrations === baselineRegistrations, '保存普通偏好不重设系统自启动或快捷键');
        check((await save({ globalHotkey: 'Ctrl+Alt+F6', pinHotkey: 'Ctrl+Alt+F7', superPanelHotkey: '', autoStart: false })).ok, '未改变的通用设置能保存');
        check(loginCalls.length === 0 && registrations === baselineRegistrations, '未改变的字段不重复触发系统副作用');
        bindings.delete('Ctrl+Alt+F6');
        check((await save({ globalHotkey: 'Ctrl+Alt+F6' })).ok && bindings.has('Ctrl+Alt+F6'), '失效快捷键可按已保存原值重试注册');
        check((await save({ autoStart: true })).ok && loginState && read().autoStart, '显式自启动变更与文件一起成功');
        const originalWrite = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => { if (String(file) === `${settingsPath}.tmp`) throw new Error('模拟设置落盘失败'); return originalWrite(file, ...args); };
        try {
            const result = await save({ autoStart: false, globalHotkey: 'Ctrl+Alt+F8' });
            check(!result.ok && /落盘失败/.test(result.error), '实际落盘失败报告失败');
            check(loginState && read().autoStart, '落盘失败恢复系统自启动，旧设置保留');
            check(bindings.has('Ctrl+Alt+F6') && !bindings.has('Ctrl+Alt+F8') && read().globalHotkey === 'Ctrl+Alt+F6', '同次失败还恢复原快捷键');
        } finally { fs.writeFileSync = originalWrite; }
        failDisable = true;
        const systemFailure = await save({ autoStart: false, globalHotkey: 'Ctrl+Alt+F8' });
        check(!systemFailure.ok && /系统自启动失败/.test(systemFailure.error), '系统自启动失败明确反馈');
        check(loginState && read().autoStart && read().globalHotkey === 'Ctrl+Alt+F6' && bindings.has('Ctrl+Alt+F6'), '系统失败恢复系统状态且不写入设置或新快捷键');
        failDisable = false;
        check((await save({ autoStart: false })).ok && !loginState && !read().autoStart, '失败后可以重试关闭自启动');
        check(!(await save({ autoStart: 'true' })).ok && !read().autoStart, '拒绝无效自启动类型');
        check(read().customMarker === '必须保留' && read().pluginSearchSettings.fixture.keywords[0] === '保留', '修改保存保留无关现有配置');
        const valid = fs.readFileSync(settingsPath, 'utf8');
        for (const damaged of ['{ damaged JSON', '[]', 'null']) {
            fs.writeFileSync(settingsPath, damaged);
            const result = await save({ autoStart: true });
            check(!result.ok && /原文件已保留/.test(result.error) && fs.readFileSync(settingsPath, 'utf8') === damaged, '损坏或非对象配置拒绝覆盖，原字节保留');
        }
        fs.writeFileSync(settingsPath, valid);
        check(report.errors.length === 0, '保存失败与重试没有未处理异常');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        const output = path.join(__dirname, '..', 'dist', startupFailure ? 'merged-startup-login-failure-report.json' : 'merged-save-settings-effects-report.json');
        fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
        app.isQuiting = true; app.quit();
    }
    setTimeout(() => app.exit(report.success ? 0 : 1), 500).unref();
})().catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('系统副作用保存验收超时'); app.exit(2); }, 35000).unref();
app.once('quit', () => { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {} });
