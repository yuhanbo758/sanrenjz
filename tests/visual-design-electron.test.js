const { app, BrowserWindow, ipcMain, nativeImage, clipboard } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-design-'));
const plugin = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-visual-design');
const imagePath = path.join(temp, 'sample.png');
const svgPath = path.join(temp, 'sample.svg');
let openPath = imagePath, savePath = path.join(temp, 'palette.json');
const originalClipboardText = clipboard.readText();
const originalClipboardImage = clipboard.readImage();
ipcMain.on('show-open-dialog', event => { event.returnValue = [openPath]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = savePath; });
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);
async function waitFor(window, expression) { for (let attempt = 0; attempt < 80; attempt++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error('超时: ' + expression); }
app.whenReady().then(async () => {
  let window;
  try {
    const pixels = Buffer.alloc(40 * 40 * 4);
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 0; pixels[i + 1] = i < pixels.length / 2 ? 0 : 255; pixels[i + 2] = i < pixels.length / 2 ? 255 : 0; pixels[i + 3] = 255; }
    fs.writeFileSync(imagePath, nativeImage.createFromBitmap(pixels, { width: 40, height: 40 }).toPNG());
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="red"/><script>alert(1)</script></svg>');
    window = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(plugin, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
    await window.loadFile(path.join(plugin, 'index.html'));
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelectorAll('.head').length"), 0);
    await window.webContents.executeJavaScript("document.querySelector('#pePick').click()");
    await waitFor(window, "document.querySelectorAll('.swatch').length >= 2");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('#peInfo').textContent.includes('40 × 40')"), true);
    await window.webContents.executeJavaScript("document.querySelector('#peExport').click()");
    assert.strictEqual(JSON.parse(fs.readFileSync(savePath, 'utf8')).colors.length >= 2, true);
    await window.webContents.executeJavaScript("document.querySelector('.swatch .btn').click()");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('[data-panel=color-workbench]').classList.contains('active')"), true);
    await window.webContents.executeJavaScript("document.querySelector('#cwBg').value='#000';document.querySelector('#cwFg').value='#fff';document.querySelector('#cwRun').click()");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('#cwResults').textContent.includes('21.00:1')"), true);
    await window.webContents.executeJavaScript("document.querySelector('#cwFg').value='#000';document.querySelector('#cwRun').click()");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('#cwResults').textContent.includes('未通过')"), true);
    openPath = svgPath; await window.webContents.executeJavaScript("document.querySelector('#svgPick').click()");
    await waitFor(window, "document.querySelector('#svgSave').disabled === false");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('#svgPreview img')?.src.startsWith('blob:')"), true);
    assert.strictEqual(await window.webContents.executeJavaScript("fetch(document.querySelector('#svgPreview img').src).then(response=>response.text()).then(text=>!text.includes('<script'))"), true);
    await window.webContents.executeJavaScript("document.querySelector('#svgInput').value='<svg xmlns=\"http://www.w3.org/2000/svg\"><text><tspan>A</tspan> <tspan>B</tspan></text></svg>';document.querySelector('#svgAction').value='minify';document.querySelector('#svgRun').click()");
    await waitFor(window, "document.querySelector('#svgSave').disabled === false");
    assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('#svgOutput').textContent.includes('</tspan> <tspan>')"), true, '压缩不得删除文字之间的空格');
    savePath = path.join(temp, 'result.svg'); await window.webContents.executeJavaScript("document.querySelector('#svgSave').click()");
    assert.strictEqual(fs.readFileSync(savePath, 'utf8').includes('<svg'), true);
    await window.webContents.executeJavaScript(`(()=>{const event=new Event('drop',{cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[{path:${JSON.stringify(imagePath)}}]}});window.dispatchEvent(event)})()`);
    await waitFor(window, "document.querySelector('[data-panel=palette-extractor]').classList.contains('active') && document.querySelectorAll('.swatch').length >= 2");
    await window.webContents.executeJavaScript(`(()=>{const event=new Event('drop',{cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[{path:${JSON.stringify(svgPath)}}]}});window.dispatchEvent(event)})()`);
    await waitFor(window, "document.querySelector('[data-panel=svg-workbench]').classList.contains('active') && document.querySelector('#svgSave').disabled === false");
    clipboard.writeImage(nativeImage.createFromPath(imagePath)); await window.webContents.executeJavaScript("document.querySelector('#pePaste').click()");
    await waitFor(window, "document.querySelector('#peInfo').textContent.includes('40 × 40')");
    for (const [width, height] of [[900, 650], [1180, 760]]) { window.setSize(width, height); assert.strictEqual(await window.webContents.executeJavaScript("document.querySelector('.tabs').getBoundingClientRect().bottom < innerHeight"), true); }
    if (process.env.VISUAL_DESIGN_SCREENSHOT) {
      await window.webContents.executeJavaScript("document.querySelector('[data-tool=palette-extractor]').click()");
      fs.writeFileSync(process.env.VISUAL_DESIGN_SCREENSHOT, await window.webContents.capturePage().then(image => image.toPNG()));
    }
    console.log('visual design Electron test passed'); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally {
    if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    if (!originalClipboardImage.isEmpty()) clipboard.writeImage(originalClipboardImage);
    else clipboard.writeText(originalClipboardText);
  }
});
