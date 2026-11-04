const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-data-test-'));
app.setPath('userData', path.join(tempDir, 'userdata'));
let savedPath = '';
ipcMain.on('show-save-dialog', (event, options) => {
  savedPath = path.join(tempDir, path.basename(options.defaultPath));
  event.returnValue = savedPath;
});
ipcMain.on('plugin-storage-get', event => { event.returnValue = null; });
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);

async function inspect(width, height) {
  const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-csv-data');
  const errors = [];
  const win = new BrowserWindow({
    show: false, x: -32000, y: -32000, width, height,
    webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false }
  });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    win.showInactive();
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const csv=new File(['姓名,年龄\\n张三,28\\n李四,34'], 'sample.csv', {type:'text/csv'});
      const input=document.getElementById('fileInput');
      const transfer=new DataTransfer();transfer.items.add(csv);input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,100));
      const uploaded={rows:state.rows.length,first:document.querySelector('tbody tr td')?.textContent};
      const dropped=new DataTransfer();
      dropped.items.add(new File(['姓名\\t年龄\\n王五\\t40'], 'drop.tsv'));
      document.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dropped}));
      await new Promise(resolve=>setTimeout(resolve,100));
      const drag={rows:state.rows.length,delimiter:state.delimiter,value:state.rows[1][0]};
      document.getElementById('searchInput').value='王五';
      document.getElementById('searchInput').dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('csvBtn').click();
      const filtered=document.getElementById('stats').textContent;
      const layout={scrollX:document.documentElement.scrollWidth-innerWidth,scrollY:document.documentElement.scrollHeight-innerHeight};
      return {uploaded,drag,filtered,layout};
    })()`);
    assert.deepStrictEqual(result.uploaded, { rows: 3, first: '张三' });
    assert.deepStrictEqual(result.drag, { rows: 2, delimiter: '\t', value: '王五' });
    assert.ok(result.filtered.startsWith('1 / 1 行'));
    assert.ok(result.layout.scrollX <= 1 && result.layout.scrollY <= 1, JSON.stringify(result.layout));
    assert.deepStrictEqual(errors, []);
    assert.ok(savedPath.endsWith('.tsv'));
    assert.ok(fs.readFileSync(savedPath, 'utf8').includes('王五\t40'));
    const json = await win.webContents.executeJavaScript(`(async()=>{
      await importFile(new File(['[{"姓名":"赵六","年龄":21}]'], 'data.json'));
      document.getElementById('jsonBtn').click();
      return {rows:state.rows.length,first:state.rows[1][0]};
    })()`);
    assert.deepStrictEqual(json, { rows: 2, first: '赵六' });
    assert.strictEqual(JSON.parse(fs.readFileSync(savedPath, 'utf8'))[0].姓名, '赵六');
    const gbBytes = [...Buffer.from('d0d5c3fb2ccafdc1bf0ab3c2c6df2c35', 'hex')];
    const legacy = await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('encoding').value='gb18030';
      await importFile(new File([new Uint8Array(${JSON.stringify(gbBytes)})], 'legacy.csv'));
      return {header:state.rows[0][0],value:state.rows[1][0]};
    })()`);
    assert.deepStrictEqual(legacy, { header: '姓名', value: '陈七' });
  } finally { win.destroy(); }
}

app.whenReady().then(async () => {
  try {
    await inspect(900, 650);
    await inspect(1180, 760);
    console.log('CSV 数据表 Electron 文件选择、拖拽、筛选、导出及布局测试通过');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
