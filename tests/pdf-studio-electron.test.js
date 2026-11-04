const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-studio-ui-'));
const sourcePath = path.join(root, 'input.pdf');
const outputPath = path.join(root, 'output.pdf');
ipcMain.on('show-open-dialog', (event, options) => { event.returnValue = options.properties.includes('openDirectory') ? [root] : [sourcePath]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = outputPath; });

async function waitFor(win, condition) {
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript(condition)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`等待界面状态超时：${condition}`);
}

app.whenReady().then(async () => {
  let win;
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 400]); pdf.addPage([300, 400]);
    fs.writeFileSync(sourcePath, await pdf.save());
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-pdf-studio');
    win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
    win.webContents.on('console-message', (_event, _level, message) => { if (!message.includes('Electron Security Warning')) console.error('renderer:', message); });
    await win.loadFile(path.join(directory, 'index.html'));
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".head")'), null);
    await win.webContents.executeJavaScript(`(() => { const event = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: { files: [{ path: ${JSON.stringify(sourcePath)} }] } }); document.querySelector('.main').dispatchEvent(event); })()`);
    await waitFor(win, `document.querySelector('#fileCount').textContent === '1'`);
    await win.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-range]'); el.value = '2'; el.dispatchEvent(new Event('input')); document.querySelector('#previewBtn').click(); })()`);
    await waitFor(win, `document.querySelector('#pageCount').textContent === '1'`);
    await win.webContents.executeJavaScript(`document.querySelector('#saveBtn').click()`);
    await waitFor(win, `document.querySelector('#bar').textContent.includes('已保存')`);
    const output = await PDFDocument.load(fs.readFileSync(outputPath));
    assert.equal(output.getPageCount(), 1);
    assert.equal(output.getPage(0).getWidth(), 300);
    await win.webContents.executeJavaScript(`(() => { document.querySelector('[data-mode="split"]').click(); document.querySelector('#saveBtn').click(); })()`);
    await waitFor(win, `document.querySelector('#bar').textContent.includes('生成 1 个文件')`);
    assert.equal(fs.existsSync(path.join(root, 'input-第2页.pdf')), true);
    for (const [width, height] of [[900, 650], [1000, 700], [1180, 760]]) {
      win.setSize(width, height);
      const layout = await win.webContents.executeJavaScript(`({ top: document.querySelector('.body').getBoundingClientRect().top, save: document.querySelector('#saveBtn').getBoundingClientRect().bottom, height: innerHeight, horizontalOverflow: document.documentElement.scrollWidth > innerWidth })`);
      assert.ok(layout.top < 45 && layout.save <= layout.height && !layout.horizontalOverflow, `${width}×${height} 布局异常：${JSON.stringify(layout)}`);
    }
    console.log('PDF 页面工作台 Electron 拖入、预览与保存验证通过');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win?.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});
