const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'inspector-ui-'));
const left = path.join(temp, 'left'), right = path.join(temp, 'right');
fs.mkdirSync(left); fs.mkdirSync(right);
fs.writeFileSync(path.join(left, 'sample.txt'), 'Alpha\nalpha', 'utf8');
fs.writeFileSync(path.join(right, 'sample.txt'), 'changed', 'utf8');
let pick = left;
ipcMain.on('show-open-dialog', (event, options) => { event.returnValue = [options.title === '选择目录 A' ? left : options.title === '选择目录 B' ? right : pick]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = path.join(temp, 'export.csv'); });

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-file-inspector');
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(dir, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  try {
    await win.loadFile(path.join(dir, 'index.html'));
    const first = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#fsPick').click();
      document.querySelector('#fsQuery').value='alpha';
      document.querySelector('#fsRun').click();
      await new Promise(resolve => setTimeout(resolve, 150));
      document.querySelector('#fsExport').click();
      return { header: document.querySelector('.head'), matches: document.querySelectorAll('#fsResult .match').length, bar: document.querySelector('#fsBar').textContent, exported: !document.querySelector('#fsExport').disabled };
    })()`);
    assert.equal(first.header, null);
    assert.equal(first.matches, 2);
    assert.equal(first.exported, true);
    assert.match(fs.readFileSync(path.join(temp, 'export.csv'), 'utf8'), /sample\.txt/);
    const dropped = await win.webContents.executeJavaScript(`(() => {
      api.inspector.droppedPaths = () => [${JSON.stringify(path.join(left, 'sample.txt'))}];
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [{}] } });
      document.querySelector('#fsDir').dispatchEvent(event);
      return document.querySelector('#fsDir').textContent;
    })()`);
    assert.match(dropped, /sample\.txt/);
    pick = right;
    const second = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-tool="folder-compare"]').click();
      document.querySelector('#fcPickB').click();
      document.querySelector('#fcPickA').click();
      document.querySelector('#fcRun').click();
      await new Promise(resolve => setTimeout(resolve, 150));
      document.querySelector('#fcFilter').value='不同';
      document.querySelector('#fcFilter').dispatchEvent(new Event('change'));
      return { rows: document.querySelectorAll('#fcResult tbody tr').length, bar: document.querySelector('#fcBar').textContent };
    })()`);
    assert.equal(second.rows, 1);
    assert.match(second.bar, /显示 1\/1 项/);
    pick = left;
    const third = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-tool="directory-tree"]').click();
      document.querySelector('#dtPick').click();
      document.querySelector('#dtRun').click();
      await new Promise(resolve => setTimeout(resolve, 150));
      return { tree: document.querySelector('#dtResult').textContent, saveEnabled: !document.querySelector('#dtSave').disabled };
    })()`);
    assert.match(third.tree, /sample\.txt/);
    assert.equal(third.saveEnabled, true);
    console.log('file inspector Electron interaction tests passed');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win.destroy(); fs.rmSync(temp, { recursive: true, force: true }); }
});
