const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');

app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const plugin = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-text-engineering');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'text-engineering-'));
const utf8Path = path.join(temp, 'sample.txt');
const gbkPath = path.join(temp, 'chinese.txt');
const emojiPath = path.join(temp, 'emoji.txt');
fs.writeFileSync(utf8Path, 'A\nB\nC', 'utf8');
fs.writeFileSync(gbkPath, iconv.encode('中文\r\n第二行', 'gbk'));
fs.writeFileSync(emojiPath, '🧪 test', 'utf8');
let openPath = utf8Path;
ipcMain.on('show-open-dialog', event => { event.returnValue = [openPath]; });

async function waitFor(win, expression) {
  for (let i = 0; i < 80; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('超时：' + expression);
}

app.whenReady().then(async () => {
  let win;
  try {
    win = new BrowserWindow({ show:false, width:1180, height:760, webPreferences:{ preload:path.join(plugin,'preload.js'), nodeIntegration:true, contextIsolation:false, webSecurity:false } });
    win.webContents.on('preload-error', (_event, file, error) => console.error('preload error', file, error));
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2 && !message.includes('Electron Security Warning')) console.error('renderer', message); });
    await win.loadFile(path.join(plugin, 'index.html'));
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelectorAll('.head').length"), 0);
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('.tabs').getBoundingClientRect().top < 40"), true);
    await win.webContents.executeJavaScript("document.querySelector('[data-import=reInput]').click()");
    await waitFor(win, "document.querySelector('#reInput').value.includes('A')");
    await win.webContents.executeJavaScript("document.querySelector('#rePattern').value='B';document.querySelector('#reDoReplace').checked=true;document.querySelector('#reReplace').value='';document.querySelector('[data-panel=regex-lab] [data-run]').click()");
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#reOutput').textContent"), 'A\n\nC');
    await win.webContents.executeJavaScript(String.raw`document.querySelector('[data-tool=text-diff]').click();document.querySelector('#diffLeft').value='A\nB\nC';document.querySelector('#diffRight').value='A\nX\nB\nC';document.querySelector('[data-panel=text-diff] [data-run]').click()`);
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelectorAll('#diffOutput .diff-add').length"), 1);
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelectorAll('#diffOutput .diff-del').length"), 0);
    await win.webContents.executeJavaScript(String.raw`document.querySelector('[data-tool=line-processor]').click();document.querySelector('#lpInput').value=' A \na\n\nB';document.querySelector('#lpTrim').checked=true;document.querySelector('#lpRemoveEmpty').checked=true;document.querySelector('#lpUnique').checked=true;document.querySelector('[data-panel=line-processor] [data-run]').click()`);
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#lpOutput').textContent"), 'A\nB');
    openPath = gbkPath;
    await win.webContents.executeJavaScript("document.querySelector('[data-import=lpInput]').click()");
    await waitFor(win, "document.querySelector('#toast').textContent.includes('编码') || document.querySelector('#toast').textContent.includes('utf')");
    await win.webContents.executeJavaScript("document.querySelector('[data-panel=line-processor] .import-encoding').value='gbk';document.querySelector('[data-import=lpInput]').click()");
    await waitFor(win, "document.querySelector('#lpInput').value.includes('中文')");
    await win.webContents.executeJavaScript(`(()=>{const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[{path:${JSON.stringify(utf8Path)}}]}});document.querySelector('#lpInput').dispatchEvent(event)})()`);
    await waitFor(win, "document.querySelector('#lpInput').value.includes('A')");
    await win.webContents.executeJavaScript("document.querySelector('[data-tool=text-encoding]').click()");
    await win.webContents.executeJavaScript(`(()=>{const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[{path:${JSON.stringify(gbkPath)}}]}});document.dispatchEvent(event)})()`);
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#encCount').textContent"), '1 个文件');
    await win.webContents.executeJavaScript("document.querySelector('#encSrc').value='gbk';document.querySelector('#encDst').value='utf8';document.querySelector('#encNl').value='lf';document.querySelector('#encExec').click()");
    const output = gbkPath + '.converted.txt';
    await waitFor(win, "document.querySelector('#encBar').textContent.includes('成功')");
    assert.strictEqual(fs.readFileSync(output, 'utf8'), '中文\n第二行');
    fs.writeFileSync(output, 'protected', 'utf8');
    await win.webContents.executeJavaScript("document.querySelector('#encExec').click()");
    await waitFor(win, "document.querySelector('#encList').textContent.includes('目标文件已存在')");
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'protected');
    const lossy = await win.webContents.executeJavaScript(`pluginAPI.convertFiles([${JSON.stringify(emojiPath)}],{sourceEncoding:'utf8',targetEncoding:'gbk',suffix:'.converted.txt'},true)`);
    assert.strictEqual(lossy[0].status, 'error');
    assert.strictEqual(fs.existsSync(emojiPath + '.converted.txt'), false);
    win.setSize(900, 650);
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('.content').getBoundingClientRect().height > 250"), true);
    if (process.env.TEXT_ENGINEERING_SCREENSHOT) fs.writeFileSync(process.env.TEXT_ENGINEERING_SCREENSHOT, await win.webContents.capturePage().then(image=>image.toPNG()));
    console.log('text engineering Electron test passed'); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { if (win && !win.isDestroyed()) win.destroy(); fs.rmSync(temp, { recursive:true, force:true }); }
});
