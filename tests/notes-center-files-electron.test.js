const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-center-'));
const source = path.join(tempDir, '导入示例.md');
const output = path.join(tempDir, '导出示例.md');
fs.writeFileSync(source, '# 实际文件\n\n中文内容', 'utf8');
app.setPath('userData', path.join(tempDir, 'user-data'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.on('quit', () => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {} });
ipcMain.on('show-open-dialog', event => { event.returnValue = [source]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = output; });
const storage = new Map([['md-notes', []], ['stickies', []]]);
ipcMain.handle('plugin-storage-get-async', (_, name, key) => storage.get(key) ?? null);
ipcMain.handle('plugin-storage-set-async', (_, name, key, value) => { storage.set(key, value); return true; });
ipcMain.on('plugin-storage-set', (event, name, key, value) => { storage.set(key, value); event.returnValue = true; });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-notes-center', 'preload.js'), nodeIntegration: true, contextIsolation: false } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-notes-center', 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#importNote').click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const title = document.querySelector('#noteTitle').value;
      const content = document.querySelector('#noteContent').value;
      document.querySelector('#exportNote').click();
      await new Promise(resolve => setTimeout(resolve, 80));
      return { title, content };
    })()`);
    assert.equal(result.title, '导入示例');
    assert.equal(result.content, '# 实际文件\n\n中文内容');
    assert.equal(fs.readFileSync(output, 'utf8'), result.content);
    assert.equal(storage.get('md-notes').length, 1);
    await win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('#noteContent');
      editor.value = '# 关闭前最后一次输入';
      editor.dispatchEvent(new Event('input'));
    })()`);
    const closed = new Promise(resolve => win.once('closed', resolve));
    win.close();
    await closed;
    assert.equal(storage.get('md-notes')[0].content, '# 关闭前最后一次输入');
    console.log('notes center real file import/export passed'); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win.destroy(); }
});
