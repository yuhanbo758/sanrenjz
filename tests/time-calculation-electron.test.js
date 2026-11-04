const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-time-calculation');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);

app.whenReady().then(async () => {
  let window;
  const previousClipboard = clipboard.readText();
  try {
    window = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false } });
    const errors = [];
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadFile(path.join(directory, 'index.html'));
    const state = await window.webContents.executeJavaScript(`(async()=>{
      const tab=id=>document.querySelector('[data-tool="'+id+'"]').click();
      const click=id=>document.getElementById(id).click();
      document.getElementById('tcInput').value='2026-01-15T12:30:00+08:00';click('tcNow');
      document.getElementById('tcInput').value='2026-01-15T12:30:00+08:00';document.querySelector('[data-panel="time-converter"] [data-run]').click();
      const iso=document.getElementById('tcResult').textContent;
      document.querySelector('[data-copy="iso"]').click();
      tab('date-tools');document.getElementById('dtStart').value='2026-09-25';document.getElementById('dtAmount').value='1';click('dtBusiness');const workday=document.getElementById('dtResult').textContent;
      tab('unit-converter');document.getElementById('ucType').value='data';document.getElementById('ucType').dispatchEvent(new Event('change'));document.getElementById('ucValue').value='1';document.getElementById('ucFrom').value='MiB';document.getElementById('ucTo').value='KiB';document.querySelector('[data-panel="unit-converter"] [data-run]').click();const unit=document.getElementById('ucResult').textContent;
      tab('date-world-clock');document.querySelector('[data-panel="date-world-clock"] [data-run]').click();const clocks=document.querySelectorAll('.clock-card').length;
      return {iso,workday,unit,clocks,hasIntro:!!document.querySelector('.head,.card h2,.card .desc'),active:document.querySelector('.tab.active').dataset.tool,scrollX:document.documentElement.scrollWidth-innerWidth};
    })()`);
    assert.equal(state.hasIntro, false);
    assert.match(state.iso, /2026-01-15T04:30:00.000Z/);
    assert.equal(clipboard.readText(), '2026-01-15T04:30:00.000Z');
    assert.match(state.workday, /2026-09-28/);
    assert.equal(state.unit, '1024 KiB');
    assert.equal(state.clocks, 8);
    assert.equal(state.active, 'date-world-clock');
    assert.ok(state.scrollX <= 1, JSON.stringify(state));
    assert.deepEqual(errors, []);
    console.log('时间与计算中心 Electron 交互通过');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clipboard.writeText(previousClipboard); window?.destroy(); app.quit(); }
}).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
