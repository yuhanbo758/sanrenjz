const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');

const plugin = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-launch-center');
const data = new Map();
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.on('show-open-dialog', event => { event.returnValue = [plugin]; });
ipcMain.handle('plugin-storage-get-async', (_event, _name, key) => data.get(key) ?? null);
ipcMain.handle('plugin-storage-set-async', (_event, _name, key, value) => { data.set(key, value); return true; });

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: path.join(plugin, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  try {
    await win.loadFile(path.join(plugin, 'index.html'));
    await pause(120);
    const first = await win.webContents.executeJavaScript(`(() => {
      document.getElementById('bmTitle').value = '文档';
      document.getElementById('bmUrl').value = 'example.com';
      document.getElementById('bmGroup').value = '工作';
      document.getElementById('bmAdd').click();
      return { head: !!document.querySelector('.head'), width: document.documentElement.scrollWidth - innerWidth, height: document.documentElement.scrollHeight - innerHeight };
    })()`);
    await pause(80);
    assert.strictEqual(first.head, false, '不应显示重复介绍栏');
    assert.ok(first.width <= 1 && first.height <= 1, '小窗口不应出现页面滚动');
    assert.strictEqual(data.get('bookmarks')[0].url, 'https://example.com/');
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('bmSearch').value = '工作';
      document.getElementById('bmSearch').dispatchEvent(new Event('input'));
      document.querySelector('.bm-card [data-action="edit"]').click();
    })()`);
    await pause(40);
    await win.webContents.executeJavaScript(`(() => {
      document.getElementById('bmTitle').value = '新文档';
      document.getElementById('bmAdd').click();
    })()`);
    await pause(70);
    assert.strictEqual(data.get('bookmarks')[0].title, '新文档');

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-tool="project-launcher"]').click();
      document.getElementById('pjName').value = '版本检查';
      document.getElementById('pjCmd').value = 'node -v';
      document.getElementById('pjPickDir').click();
      document.getElementById('pjAdd').click();
    })()`);
    await pause(90);
    assert.strictEqual(data.get('projects')[0].directory, plugin);
    await win.webContents.executeJavaScript(`document.getElementById('pjRun').click()`);
    await pause(700);
    const result = await win.webContents.executeJavaScript(`({ text: document.getElementById('pjTerminal').textContent, status: document.getElementById('pjStatus').textContent })`);
    assert.ok(result.text.includes('v') && result.text.includes('进程已退出'), JSON.stringify(result));
    assert.ok(result.status.includes('已退出'), JSON.stringify(result));
    assert.deepStrictEqual(errors, []);
    console.log('启动中心 Electron 交互通过：书签持久化/检索/编辑、项目保存/启动/日志、900×650 布局');
  } finally { win.destroy(); }
}

app.whenReady().then(() => run().then(() => app.exit(0), error => { console.error(error); app.exit(1); }));
