const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: path.join(__dirname, 'hosts-center-electron-preload.js'), nodeIntegration: true, contextIsolation: false } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-hosts-center', 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      window.confirm = () => true;
      document.querySelector('#loadBtn').click(); await new Promise(resolve => setTimeout(resolve, 20));
      const editor = document.querySelector('#editor');
      editor.value += '192.0.2.1 example.test\\n'; editor.dispatchEvent(new Event('input'));
      document.querySelector('#search').value = 'example.test'; document.querySelector('#nextBtn').click();
      const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      document.querySelector('#copyBtn').click();
      document.querySelector('#diffBtn').click();
      const diff = document.querySelector('#diffOut').textContent;
      document.querySelector('#writeBtn').click(); await new Promise(resolve => setTimeout(resolve, 20));
      document.querySelector('#clearBtn').click();
      return { selected, copied: window.copiedForTest, diff, cleared: editor.value === '', noHeader: !document.querySelector('.head'), pageScroll: document.documentElement.scrollHeight > innerHeight };
    })()`);
    assert.equal(result.selected, 'example.test');
    assert.match(result.copied, /192\.0\.2\.1/);
    assert.match(result.diff, /example\.test/);
    assert.equal(result.cleared, true);
    assert.equal(result.noHeader, true);
    assert.equal(result.pageScroll, false);
    for (const [width, height] of [[1180, 760], [1480, 900]]) {
      win.setSize(width, height);
      const overflow = await win.webContents.executeJavaScript('document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth');
      assert.equal(overflow, false, `${width}x${height} 出现页面滚动`);
    }
    console.log('hosts center Electron interactions passed'); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win.destroy(); }
});
