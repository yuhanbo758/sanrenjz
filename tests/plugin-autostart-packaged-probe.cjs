const { app, BrowserWindow, session, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const directory = process.env.SANRENJZ_AUTOSTART_PROBE_DIR;
if (!directory) throw new Error('打包验收必须指定独立测试目录');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
fs.mkdirSync(path.join(directory, 'app-data'), { recursive: true });
app.setPath('appData', path.join(directory, 'app-data'));
const profile = app.getPath('userData');
fs.mkdirSync(path.join(profile, 'plugin-data'), { recursive: true });
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
globalShortcut.isRegistered = () => true;
app.on('browser-window-created', (_event, win) => {
    win.webContents.on('preload-error', (_event, preload, error) => console.error('PROBE_PRELOAD_ERROR', preload, error.message));
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('PROBE_RENDERER', message); });
    win.webContents.on('render-process-gone', (_event, details) => console.error('PROBE_RENDERER_EXIT', JSON.stringify(details)));
});
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ enableRightClickPanel: false, autoStart: false,
    customPluginDataPath: path.join(profile, 'plugin-data'),
    pluginPreferences: { 'AI语音输入法': { autoStartWithMain: true } } }));
fs.writeFileSync(path.join(profile, 'plugin-data', 'AI语音输入法-storage.json'), JSON.stringify({ settings: { lanAutoStart: false } }));
let pendingImage = false;
const sockets = new Set();
const server = http.createServer(() => { pendingImage = true; });
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const deadline = setTimeout(() => { console.error('打包版自启动验收超时'); app.exit(1); }, 20000);
async function evaluate(win, expression) {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://gdsx.sanrenjz.com/*'] }, (_details, callback) => callback({ redirectURL: `http://127.0.0.1:${server.address().port}/pending-image` }));
    const mainReady = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('dom-ready', () => resolve(win))));
    require('./main.js');
    const main = await mainReady;
    let speech, state;
    const expires = Date.now() + 10000;
    while (Date.now() < expires) {
        speech = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('sanrenjz-tools-speech_input/index.html') && !win.webContents.getURL().includes('view=indicator'));
        if (speech) {
            state = await evaluate(speech, `({ api: !!window.electronAPI, recording: typeof isRecording !== 'undefined' && isRecording,
                hookRunning: typeof keyboardHookProcess !== 'undefined' && !!(keyboardHookProcess && keyboardHookProcess.pid) })`);
            if (state.api && state.hookRunning) break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(app.isPackaged, '必须使用真实打包模式');
    assert(speech && state?.api && state.hookRunning, '真实语音插件未自动初始化键盘监听');
    assert.strictEqual(state.recording, false, '验收不得启动录音');
    assert(pendingImage, '远程图片没有保持挂起');
    const readyState = await evaluate(main, 'document.readyState');
    assert.strictEqual(readyState, 'interactive');
    const report = { packaged: app.isPackaged, executable: process.execPath, mainReadyState: readyState, pendingImage,
        pluginUrl: speech.webContents.getURL(), userDataMoved: app.getPath('userData') !== profile, ...state };
    fs.writeFileSync(path.join(directory, 'packaged-report.json'), JSON.stringify(report, null, 2));
    console.log('PACKAGED_AUTOSTART_PASS: ' + JSON.stringify(report));
    clearTimeout(deadline);
    app.isQuiting = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    app.quit();
})().catch(error => { console.error(error); app.exit(1); });
