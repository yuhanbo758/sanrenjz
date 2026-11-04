const { app, BrowserWindow, ipcMain, nativeImage, clipboard } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-creator-'));
const plugin = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-image-creator');
const source = path.join(temp, 'source.png');
let target = path.join(temp, 'result.png');

ipcMain.on('show-open-dialog', event => { event.returnValue = [source]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = target; });
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);

async function waitFor(window, expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`超时：${expression}`);
}

app.whenReady().then(async () => {
  let window;
  try {
    fs.writeFileSync(source, nativeImage.createFromBitmap(Buffer.alloc(80 * 60 * 4, 255), { width: 80, height: 60 }).toPNG());
    window = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(plugin, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
    await window.loadFile(path.join(plugin, 'index.html'));
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelectorAll('.head').length"), 0);
    clipboard.writeImage(nativeImage.createFromPath(source));
    await window.webContents.executeJavaScript("document.querySelector('#pasteBtn').click()");
    await waitFor(window, "document.querySelector('#stage canvas')?.width === 80");
    await window.webContents.executeJavaScript("document.querySelector('#clearBtn').click()");
    await window.webContents.executeJavaScript("document.querySelector('#pickBtn').click()");
    await waitFor(window, "document.querySelector('#stage canvas')?.width === 80");
    await window.webContents.executeJavaScript("document.querySelector('[data-tool=\"screenshot-beautifier\"]').click()");
    assert.deepStrictEqual(await window.webContents.executeJavaScript("({active:document.querySelector('[data-panel].active').dataset.panel,width:document.querySelector('#stage canvas').width})"), { active: 'screenshot-beautifier', width: 160 });
    await window.webContents.executeJavaScript("document.querySelector('[data-tool=\"image-collage\"]').click()");
    assert.strictEqual(await window.webContents.executeJavaScript("!!document.querySelector('#stage canvas')"), false, '空拼接模式不得保留上个画布');
    await window.webContents.executeJavaScript("document.querySelector('#pickBtn').click()");
    await waitFor(window, "document.querySelector('#stage canvas')?.width === 1224");
    await window.webContents.executeJavaScript("document.querySelector('#pickBtn').click()");
    await waitFor(window, "document.querySelectorAll('.queue-item').length === 2");
    const dropResult = await window.webContents.executeJavaScript(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(source).toString('base64'))}),char=>char.charCodeAt(0));const file=new File([bytes],'dropped.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);window.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return true;})()`);
    assert(dropResult);
    await waitFor(window, "document.querySelectorAll('.queue-item').length === 3");
    await window.webContents.executeJavaScript("document.querySelector('.queue-item button[title=\"移除图片\"]').click()");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelectorAll('.queue-item').length"), 2);
    for (const [format, extension, signature] of [['png', 'png', 'PNG'], ['jpeg', 'jpg', 'JPEG'], ['webp', 'webp', 'WEBP']]) {
      target = path.join(temp, `result.${extension}`);
      await window.webContents.executeJavaScript(`document.querySelector('#exportFormat').value=${JSON.stringify(format)};document.querySelector('#exportBtn').click()`);
      await waitFor(window, `document.querySelector('#toast').textContent === '已保存图片' && document.querySelector('#toast').classList.contains('show')`);
      const bytes = fs.readFileSync(target);
      const actual = bytes.subarray(1, 4).toString('ascii') === 'PNG' ? 'PNG' : bytes[0] === 255 && bytes[1] === 216 ? 'JPEG' : bytes.toString('ascii', 8, 12);
      assert.strictEqual(actual, signature);
    }
    target = path.join(temp, 'wrong.png');
    await window.webContents.executeJavaScript("document.querySelector('#exportFormat').value='webp';document.querySelector('#exportBtn').click()");
    assert.strictEqual(fs.existsSync(target), false, '扩展名与编码不符时不得写文件');
    for (const [width, height] of [[900, 650], [1180, 760], [1440, 900]]) {
      window.setSize(width, height);
      const visible = await window.webContents.executeJavaScript("(()=>{const r=document.querySelector('#exportBtn').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollHeight<=innerHeight+1})()");
      assert(visible, `${width}x${height} 导出按钮应可见`);
    }
    console.log('image creator Electron test passed');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { if (window && !window.isDestroyed()) window.destroy(); fs.rmSync(temp, { recursive: true, force: true }); }
});
