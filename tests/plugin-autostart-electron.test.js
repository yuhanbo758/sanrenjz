const { app, session, globalShortcut } = require('electron');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const RealManager = require('../app/software_manager');
const { PluginCatalog } = require('../app/plugin-catalog');

process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const profile = process.argv[2];
const phase = process.argv[3];
const expectBlocked = process.argv.includes('--expect-blocked');
if (!profile || !phase) throw new Error('需要临时配置路径和测试阶段');
let hostProfile = profile;
if (process.argv.includes('--default-userdata')) {
    app.setName('sanrenjz');
    app.setPath('appData', profile);
    hostProfile = path.join(profile, 'sanrenjz');
    fs.mkdirSync(hostProfile, { recursive: true });
    const target = path.join(hostProfile, 'settings.json');
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(profile, 'settings.json'), target);
} else {
    app.setPath('userData', profile);
}
process.env.SANRENJZ_USER_DATA = hostProfile;
process.env.SANRENJZ_TEST_HIDDEN = '1';
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
globalShortcut.isRegistered = () => true;
let manager;
class FixtureManager extends RealManager {
    constructor(win, options) {
        super(win, options);
        this.pluginDir = path.join(profile, 'plugins');
        this.catalog = new PluginCatalog(this.pluginDir);
        manager = this;
    }
}
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
const sockets = new Set();
let pendingImage = false;
// 模拟主界面的远程图片一直不响应，DOM 可以就绪，但 load 不会完成。
const server = http.createServer(() => { pendingImage = true; });
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const deadline = setTimeout(() => { console.error('自启动回归超时'); app.exit(1); }, 20000);
async function until(check, timeout = 3000) {
    const expires = Date.now() + timeout;
    while (Date.now() < expires) {
        if (await check()) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://gdsx.sanrenjz.com/*'] }, (_details, callback) => {
        callback({ redirectURL: `http://127.0.0.1:${server.address().port}/pending-image` });
    });
    const mainReady = new Promise(resolve => app.once('browser-window-created', (_event, win) => {
        win.webContents.once('dom-ready', () => resolve(win));
    }));
    require('../main');
    const win = await mainReady;
    // executeJavaScript 本身也会等待整页加载；用调试协议读取图片挂起时的 DOM 状态。
    win.webContents.debugger.attach('1.3');
    const evaluate = async expression => {
        const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
    };
    assert(await until(() => pendingImage), '未成功模拟挂起的图片');
    assert.strictEqual(await evaluate('document.readyState'), 'interactive');
    if (phase === 'save') {
        const result = await evaluate(`require('electron').ipcRenderer.invoke('set-plugin-preference', 'AI语音输入法', 'autoStartWithMain', true)`);
        assert(result.success);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(hostProfile, 'settings.json'))).pluginPreferences['AI语音输入法'].autoStartWithMain, true);
        console.log('AUTOSTART_SAVE_PASS: 从真实主程序IPC写入选择');
    } else {
        const started = await until(() => manager.pluginWindows.has('AI语音输入法'), 1800);
        const state = {
            selected: JSON.parse(fs.readFileSync(path.join(hostProfile, 'settings.json'))).pluginPreferences['AI语音输入法'].autoStartWithMain,
            readyState: await evaluate('document.readyState'), pendingImage, started,
            startupInvoked: Boolean(manager.startupPluginsPromise),
            userDataMoved: hostProfile !== app.getPath('userData')
        };
        console.log(`AUTOSTART_RESTART_STATE: ${JSON.stringify(state)}`);
        if (expectBlocked) {
            assert.strictEqual(started, false, '旧代码应复现图片阻断自启动');
            assert.strictEqual(state.startupInvoked, false);
            console.log('AUTOSTART_BUG_REPRODUCED: 设置已保存，远程图片阻塞load事件，启动方法没有被调用');
        } else {
            assert(started, '重新启动主程序后，选中插件仍未自动启动');
            const results = await manager.startupPluginsPromise;
            assert.strictEqual(results[0].success, true);
            assert.strictEqual(await manager.pluginWindows.get('AI语音输入法').webContents.executeJavaScript('window.businessRuns'), 0);
            assert.strictEqual(await evaluate('document.readyState'), 'interactive', '验证时图片必须仍处于挂起状态');
            console.log('AUTOSTART_RESTART_PASS: 新进程读取已保存选择，图片挂起时插件仍自动启动，业务入口未执行');
        }
    }
    clearTimeout(deadline);
    app.isQuiting = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    app.quit();
})().catch(error => { console.error(error); app.exit(1); });
