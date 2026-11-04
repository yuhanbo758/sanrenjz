const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-transfer-ui-'));
const sample = path.join(temporary, '分享.txt');
fs.writeFileSync(sample, '分享文件内容', 'utf8');
const storage = new Map();
ipcMain.on('show-open-dialog', (event, options) => { event.returnValue = options.properties.includes('openDirectory') ? [temporary] : [sample]; });
ipcMain.handle('plugin-storage-get-async', (_event, _plugin, key) => storage.get(key) ?? null);
ipcMain.handle('plugin-storage-set-async', (_event, _plugin, key, value) => { storage.set(key, value); return true; });

app.whenReady().then(async () => {
  const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-lan-transfer');
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const pause=()=>new Promise(resolve=>setTimeout(resolve,250));
      document.querySelector('#pickDir').click();
      document.querySelector('#startBtn').click();await pause();
      for(let attempt=0;attempt<10&&!document.querySelector('#qrBox img');attempt++)await pause();
      const started={status:document.querySelector('#statusText').textContent,urls:document.querySelector('#urlSelect').options.length,qr:!!document.querySelector('#qrBox img'),qrText:document.querySelector('#qrBox').textContent};
      document.querySelector('#shareText').value='电脑发来的文字';document.querySelector('#shareTextBtn').click();await pause();
      const shared={count:document.querySelector('#shareCount').textContent,record:document.querySelector('#recvList').textContent};
      document.querySelector('#shareFilesBtn').click();await pause();
      const files=document.querySelector('#shareCount').textContent;
      document.querySelector('#stopBtn').click();await pause();
      return {header:!!document.querySelector('.head h1'),started,shared,files,stopped:document.querySelector('#statusText').textContent,saved:document.querySelector('#saveDir').value};
    })()`);
    assert.equal(result.header, false);
    assert.equal(result.started.status, '接收中');
    assert.ok(result.started.urls >= 1);
    assert.equal(result.started.qr, true, JSON.stringify(result.started));
    assert.match(result.shared.count, /1 项/);
    assert.match(result.shared.record, /电脑发来的文字/);
    assert.match(result.files, /2 项/);
    assert.equal(result.stopped, '未启动');
    assert.equal(result.saved, temporary);
    assert.equal(storage.get('lan-save-directory'), temporary);

    await win.webContents.executeJavaScript(`document.querySelector('#startBtn').click()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const connectUrl = await win.webContents.executeJavaScript(`document.querySelector('#urlSelect').value`);
    const phone = new BrowserWindow({ show: false, width: 390, height: 720, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    try {
      await phone.loadURL(connectUrl.replace(/^http:\/\/[^/]+/, match => `http://127.0.0.1:${new URL(connectUrl).port}`));
      const phoneResult = await phone.webContents.executeJavaScript(`(async()=>{
        document.querySelector('#text').value='手机端页面测试';document.querySelector('#sendText').click();
        for(let i=0;i<15&&!document.querySelector('#textMessage').textContent.includes('已送达');i++)await new Promise(resolve=>setTimeout(resolve,100));
        return {message:document.querySelector('#textMessage').textContent,width:document.documentElement.scrollWidth,viewport:innerWidth};
      })()`);
      assert.match(phoneResult.message, /已送达电脑/);
      assert.ok(phoneResult.width <= phoneResult.viewport);
      const received = await win.webContents.executeJavaScript(`window.pluginAPI.transfer.status()`);
      assert.equal(received.received[0].text, '手机端页面测试');
    } finally { phone.destroy(); await win.webContents.executeJavaScript(`document.querySelector('#stopBtn').click()`); }

    for (const [width, height] of [[900, 650], [1180, 760]]) {
      win.setSize(width, height);
      const layout = await win.webContents.executeJavaScript(`({pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,pageHeight:document.documentElement.scrollHeight,screen:innerHeight,startVisible:document.querySelector('#startBtn').getBoundingClientRect().bottom>32})`);
      assert.ok(layout.pageWidth <= layout.viewport && layout.pageHeight <= layout.screen, `${width}x${height}: ${JSON.stringify(layout)}`);
      assert.equal(layout.startVisible, true);
    }
    console.log('局域网快传 Electron 按钮、状态、保存目录和双尺寸布局通过');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win.destroy(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
