const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-batch-ui-'));
const first = path.join(root, '第一.txt');
const second = path.join(root, '第二.txt');
const exportPath = path.join(root, 'hash.csv');
fs.writeFileSync(first, 'first'); fs.writeFileSync(second, 'second');
ipcMain.on('show-open-dialog', (event, options) => { event.returnValue = options.properties.includes('openDirectory') ? [root] : [first]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = exportPath; });

app.whenReady().then(async () => {
  const directory = process.env.FILE_BATCH_PLUGIN_DIR || path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-file-batch');
  try {
    for (const [width, height] of [[900, 650], [1180, 760], [1440, 900]]) {
      const win = new BrowserWindow({ show: false, x: -32000, y: -32000, width, height, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
      try {
        await win.loadFile(path.join(directory, 'index.html'));
        const state = await win.webContents.executeJavaScript(`(async()=>{
          window.confirm=()=>true;
          const first=${JSON.stringify(first)}, second=${JSON.stringify(second)};
          document.querySelector('#pickFiles').click();
          const chooser=document.querySelector('#sourceSummary').textContent;
          api.batch.droppedPaths=()=>[second];
          const event=new Event('drop',{bubbles:true,cancelable:true});
          Object.defineProperty(event,'dataTransfer',{value:{files:[{}]}});
          document.dispatchEvent(event);
          const dropped=document.querySelector('#sourceSummary').textContent;
          document.querySelector('#rnPrefix').value='已处理-';
          document.querySelector('#rnPreview').click();
          const previewRows=document.querySelectorAll('#rnTable tbody tr').length;
          document.querySelector('#rnPrefix').value='变更-';
          document.querySelector('#rnPrefix').dispatchEvent(new Event('input'));
          const invalidated=document.querySelector('#rnExec').disabled;
          document.querySelector('#rnPreview').click();
          document.querySelector('#rnExec').click();
          document.querySelector('[data-tool="file-checksum"]').click();
          document.querySelector('#pickDir').click();
          document.querySelector('#csCalc').click();
          await new Promise(resolve=>setTimeout(resolve,150));
          const hashRows=document.querySelectorAll('#csTable tbody tr').length;
          document.querySelector('#csExport').click();
          return {chooser,dropped,previewRows,invalidated,hashRows,scrollX:document.documentElement.scrollWidth-document.documentElement.clientWidth,scrollY:document.documentElement.scrollHeight-document.documentElement.clientHeight,hasHead:Boolean(document.querySelector('.head'))};
        })()`);
        assert.match(state.chooser, /1 个文件/);
        assert.match(state.dropped, /2 个文件/);
        assert.equal(state.previewRows, 2);
        assert.equal(state.invalidated, true);
        assert.equal(state.hashRows, 2);
        assert.equal(state.hasHead, false);
        assert.ok(state.scrollX <= 1 && state.scrollY <= 1, `${width}x${height} 出现页面滚动`);
      } finally { win.destroy(); }
      fs.renameSync(path.join(root, '变更-第一.txt'), first);
      fs.renameSync(path.join(root, '变更-第二.txt'), second);
      assert.match(fs.readFileSync(exportPath, 'utf8'), /SHA-256/);
      if (width !== 1440) fs.unlinkSync(exportPath);
    }
    console.log('文件批处理中心 Electron 拖拽、执行、校验与三尺寸布局通过');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
