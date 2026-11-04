const { app, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PluginManager = require('../app/software_manager');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-window-injection-'));
app.setPath('userData', temp);
app.once('quit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }); }
  catch (_) { /* Windows 可能仍占用 Chromium 缓存；本测试不因临时缓存清理失败而误报。 */ }
});
const storage = new Map();
ipcMain.handle('plugin-storage-get-async', (_event, name, key) => storage.get(`${name}:${key}`) ?? null);
ipcMain.handle('plugin-storage-set-async', (_event, name, key, value) => { storage.set(`${name}:${key}`, value); return true; });
ipcMain.handle('plugin-secret-get', () => ({ value: '', encryptionAvailable: false }));
ipcMain.handle('get-plugin-pin-status-window', () => false);

const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));
app.whenReady().then(async () => {
  let win;
  try {
    const manager = new PluginManager(null);
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-prompt');
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'), 'utf8'));
    win = await manager.createPluginWindow(directory, config);
    if (win.webContents.isLoadingMainFrame()) {
      await new Promise((resolve, reject) => {
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', (_event, _code, message) => reject(new Error(message)));
      });
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepStrictEqual(unhandled.map(error => error?.message || String(error)), []);
    const result = await manager.runPluginAction(directory, config.features[0], '');
    assert(result.success, JSON.stringify(result));
    assert.deepStrictEqual(unhandled.map(error => error?.message || String(error)), []);
    console.log('插件管理器全局变量注入与提示词工坊功能执行无 IPC 克隆异常');
  } finally {
    win?.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
