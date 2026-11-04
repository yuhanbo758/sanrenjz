const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-security-ui-'));
  const filePath = path.join(temp, 'sample.txt');
  const binaryPath = path.join(temp, 'binary.bin');
  fs.writeFileSync(filePath, '拖拽文件内容', 'utf8');
  fs.writeFileSync(binaryPath, Buffer.from([0, 255, 1, 2]));
  ipcMain.on('show-open-dialog', event => { event.returnValue = [filePath]; });
  ipcMain.handle('plugin-storage-get-async', () => null);
  ipcMain.handle('plugin-storage-set-async', () => true);
  const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-code-security');
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    const state = await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('codecOpen').click();
      await new Promise(resolve=>setTimeout(resolve,80));
      document.querySelector('[data-panel="codec-assistant"] [data-run]').click();
      await new Promise(resolve=>setTimeout(resolve,20));
      const selected={input:document.getElementById('codecInput').value,result:document.getElementById('codecOutput').textContent};
      const binary=new File(['ignored'],'binary.bin');Object.defineProperty(binary,'path',{value:${JSON.stringify(binaryPath)}});
      const binaryTransfer=new DataTransfer();binaryTransfer.items.add(binary);
      document.getElementById('codecDrop').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:binaryTransfer}));
      await new Promise(resolve=>setTimeout(resolve,80));
      const binaryResult=document.getElementById('codecOutput').textContent;
      document.querySelector('[data-tool="hash-hmac"]').click();
      const dropped=new File(['ignored'],'sample.txt');
      Object.defineProperty(dropped,'path',{value:${JSON.stringify(filePath)}});
      const transfer=new DataTransfer();transfer.items.add(dropped);
      document.getElementById('hashDrop').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
      await new Promise(resolve=>setTimeout(resolve,80));
      document.getElementById('hashExpected').value=${JSON.stringify(crypto.createHash('sha256').update('拖拽文件内容').digest('hex'))};
      document.querySelector('[data-panel="hash-hmac"] [data-run]').click();
      await new Promise(resolve=>setTimeout(resolve,100));
      const hash={note:document.getElementById('hashFileNote').textContent,result:document.getElementById('hashOutput').textContent,comparison:document.getElementById('hashFileResult').textContent};
      document.querySelector('[data-tool="id-generator"]').click();
      document.getElementById('idType').value='password';document.getElementById('idType').dispatchEvent(new Event('change'));
      document.querySelector('[data-panel="id-generator"] [data-run]').click();
      await new Promise(resolve=>setTimeout(resolve,20));
      return {selected,binaryResult,hash,ids:document.querySelectorAll('.id-card').length,errors:document.querySelectorAll('.bar.err').length,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
    })()`);
    assert.strictEqual(state.selected.input, '拖拽文件内容');
    assert.strictEqual(state.selected.result, Buffer.from('拖拽文件内容').toString('base64'));
    assert.strictEqual(state.binaryResult, fs.readFileSync(binaryPath).toString('base64'));
    assert.ok(state.hash.note.includes('sample.txt'));
    assert.strictEqual(state.hash.result, crypto.createHash('sha256').update('拖拽文件内容').digest('hex'));
    assert.ok(state.hash.comparison.includes('摘要一致'));
    assert.strictEqual(state.ids, 8);
    assert.strictEqual(state.overflow, 0);
    win.setSize(900, 650);
    const smallOverflow = await win.webContents.executeJavaScript('document.documentElement.scrollWidth-document.documentElement.clientWidth');
    assert.strictEqual(smallOverflow, 0);
    assert.deepStrictEqual(errors, []);
    console.log('code security Electron interaction passed');
  } finally { win.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.quit(); }
}
app.whenReady().then(main).catch(error => { console.error(error); app.quit(); process.exitCode = 1; });
