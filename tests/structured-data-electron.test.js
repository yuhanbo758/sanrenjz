const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const plugin = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-structured-data');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-data-'));
const source = path.join(temp, 'source.json');
const target = path.join(temp, 'result.json');
fs.writeFileSync(source, '{"items":[{"name":"测试"}]}', 'utf8');
ipcMain.on('show-open-dialog', event => { event.returnValue = [source]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = target; });
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);

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
    win = new BrowserWindow({show:false,width:900,height:650,webPreferences:{preload:path.join(plugin,'preload.js'),nodeIntegration:true,contextIsolation:false}});
    await win.loadFile(path.join(plugin,'index.html'));
    assert.strictEqual(await win.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor"), 'rgb(255, 255, 255)');
    await win.webContents.executeJavaScript("document.querySelector('#importBtn').click()");
    await waitFor(win, "document.querySelector('#jsonInput').value.includes('测试')");
    await win.webContents.executeJavaScript("document.querySelector('#jsonQuery').value='items[0].name';document.querySelector('[data-panel=json-workbench] [data-run]').click()");
    await waitFor(win, "document.querySelector('#jsonOutput').textContent.includes('测试')");
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#jsonSummary').textContent.includes('值 1')"), true);
    await win.webContents.executeJavaScript("document.querySelector('#jsonQuery').value='bad';document.querySelector('[data-panel=json-workbench] [data-run]').click()");
    await waitFor(win, "document.querySelector('#jsonStatus').textContent.includes('路径不存在')");
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#jsonOutput').textContent"), '');
    await win.webContents.executeJavaScript("document.querySelector('#jsonQuery').value='';document.querySelector('[data-panel=json-workbench] [data-run]').click()");
    await waitFor(win, "document.querySelector('#jsonOutput').textContent.includes('items')");
    await win.webContents.executeJavaScript("document.querySelector('#exportBtn').click()");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target,'utf8')), {items:[{name:'测试'}]});
    await win.webContents.executeJavaScript("document.querySelector('#swapBtn').click()");
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#jsonInput').value.includes('items') && !document.querySelector('#jsonOutput').textContent"), true);
    await win.webContents.executeJavaScript("document.querySelector('#jsonAction').value='array-to-jsonl';document.querySelector('#jsonQuery').value='items';document.querySelector('[data-panel=json-workbench] [data-run]').click()");
    await waitFor(win, "document.querySelector('#jsonOutput').textContent.includes('name')");
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#jsonOutput').textContent.trim()"), '{"name":"测试"}');
    await win.webContents.executeJavaScript("document.querySelector('[data-tool=config-converter]').click();document.querySelector('#cfgSrc').value='yaml';document.querySelector('#cfgInput').value='items:\\n  - x';document.querySelector('[data-panel=config-converter] [data-run]').click()");
    await waitFor(win, "document.querySelector('#cfgStatus').textContent.includes('仅支持顶层键值')");
    await win.webContents.executeJavaScript("document.querySelector('[data-tool=xml-workbench]').click();document.querySelector('#xmlInput').value='<root><x>A <b>B</b> C</x></root>';document.querySelector('#xmlAction').value='format';document.querySelector('[data-panel=xml-workbench] [data-run]').click()");
    await waitFor(win, "document.querySelector('#xmlStatus').textContent.includes('已完成')");
    assert.strictEqual(await win.webContents.executeJavaScript("document.querySelector('#xmlOutput').textContent.includes('A <b>B</b> C')"), true);
    await win.webContents.executeJavaScript("document.querySelector('#xmlInput').value='<root><x></root>';document.querySelector('[data-panel=xml-workbench] [data-run]').click()");
    await waitFor(win, "document.querySelector('#xmlStatus').textContent.includes('XML 语法错误')");
    if(process.env.STRUCTURED_DATA_SCREENSHOT){
      await win.webContents.executeJavaScript("document.querySelector('[data-tool=json-workbench]').click()");
      fs.writeFileSync(process.env.STRUCTURED_DATA_SCREENSHOT, await win.webContents.capturePage().then(image=>image.toPNG()));
    }
    console.log('structured data Electron test passed');
    app.exit(0);
  } catch(error) { console.error(error); app.exit(1); }
  finally { if(win&&!win.isDestroyed())win.destroy(); fs.rmSync(temp,{recursive:true,force:true}); }
});
