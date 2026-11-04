const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);
ipcMain.handle('plugin-secret-get', () => '');
ipcMain.handle('ai-opencode-list-models', () => []);
ipcMain.handle('show-open-dialog', () => ({ canceled: true, filePaths: [] }));

app.whenReady().then(async () => {
  const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-code-review');
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: {
    preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false
  } });
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    const state = await win.webContents.executeJavaScript(`(async()=>{
      const zone=document.querySelector('#dropZone');
      document.querySelector('[data-mode="security"]').click();
      const securityClickWorked=document.querySelector('.mode.active')?.dataset.mode==='security';
      const transfer=new DataTransfer();
      transfer.items.add(new File(['diff --git a/a.js b/a.js\\n+const x = 1;\\n'],'sample.patch',{type:'text/plain'}));
      zone.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      const highlighted=zone.classList.contains('drag-over');
      zone.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      await new Promise(resolve=>setTimeout(resolve,100));
      return {securityClickWorked,highlighted,mode:document.querySelector('.mode.active')?.dataset.mode,input:document.querySelector('#codeInput').value,count:document.querySelector('#codeCnt').textContent,highlightAfter:zone.classList.contains('drag-over')};
    })()`);
    assert.strictEqual(state.securityClickWorked, true);
    assert.strictEqual(state.highlighted, true);
    assert.strictEqual(state.mode, 'diff');
    assert.match(state.input, /diff --git a\/a\.js b\/a\.js/);
    assert.strictEqual(state.count, '3 行');
    assert.strictEqual(state.highlightAfter, false);
    console.log('AI 代码审查拖拽上传 Electron 验证通过');
  } finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
