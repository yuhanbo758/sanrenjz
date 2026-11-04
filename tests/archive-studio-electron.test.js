const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fflate = require('fflate');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-studio-ui-'));
const zip = path.join(root, 'sample.zip');
const zip2 = path.join(root, 'second.zip');
const output = path.join(root, 'output');
fs.mkdirSync(output);
fs.writeFileSync(zip, fflate.zipSync({ 'a.txt': fflate.strToU8('A'), 'b.txt': fflate.strToU8('B') }));
fs.writeFileSync(zip2, fflate.zipSync({ 'c.txt': fflate.strToU8('C') }));
ipcMain.on('show-open-dialog', (event, options) => { event.returnValue = options.properties.includes('openDirectory') ? [output] : [zip]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = path.join(root, 'created.zip'); });

app.whenReady().then(async () => {
  const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-archive-studio');
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    const state = await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#exAdd').click();
      document.querySelector('#exPickDir').click();
      document.querySelector('#exPreview').click();
      await new Promise(resolve=>setTimeout(resolve,30));
      const entries=document.querySelectorAll('#exList .entry').length;
      document.querySelector('#exSearch').value='a.txt';
      document.querySelector('#exSearch').dispatchEvent(new Event('input'));
      const filtered=document.querySelectorAll('#exList .entry').length;
      document.querySelector('#exExtract').click();
      await new Promise(resolve=>setTimeout(resolve,30));
      const dropPath=${JSON.stringify(zip2)};
      api.archive.droppedPaths=()=>[dropPath];
      const drop=new Event('drop',{bubbles:true,cancelable:true});
      Object.defineProperty(drop,'dataTransfer',{value:{files:[{}]}});
      document.querySelector('#exDrop').dispatchEvent(drop);
      const queued=document.querySelectorAll('#exArchive option').length;
      document.querySelector('#exBatch').click();
      await new Promise(resolve=>setTimeout(resolve,80));
      const batch=document.querySelector('#exBar').textContent;
      document.querySelector('[data-mode="create"]').click();
      document.querySelector('#crAddFiles').click();
      document.querySelector('#crCreate').click();
      await new Promise(resolve=>setTimeout(resolve,30));
      return {entries,filtered,queued,batch,create:document.querySelector('#crBar').textContent};
    })()`);
    assert.equal(state.entries, 2);
    assert.equal(state.filtered, 1);
    assert.equal(state.queued, 2);
    assert.match(state.batch, /成功 2 个 ZIP，失败 0 个/);
    assert.match(state.create, /已创建 1 个文件/);
    assert.equal(fs.readFileSync(path.join(output, '1-sample', 'a.txt'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(output, '2-second', 'c.txt'), 'utf8'), 'C');
    assert.equal(fs.existsSync(path.join(root, 'created.zip')), true);
    console.log('压缩包工作台 Electron 交互验证通过');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});
