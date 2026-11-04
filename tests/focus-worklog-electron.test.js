const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('path');
const data = new Map();
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.handle('plugin-storage-get-async', (_event, _name, key) => data.get(key) ?? null);
ipcMain.handle('plugin-storage-set-async', (_event, _name, key, value) => { data.set(key, value); return true; });
app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-focus-worklog');
  const win = new BrowserWindow({ show: false, width: 980, height: 700, webPreferences: { preload: path.join(dir, 'preload.js'), nodeIntegration: true, contextIsolation: false } });
  try {
    await win.loadFile(path.join(dir, 'index.html'));
    await win.webContents.executeJavaScript(`(async () => {
      await new Promise(r => setTimeout(r, 120));
      document.querySelector('#showTaskForm').click();
      document.querySelector('#taskTitle').value = '完成报告';
      document.querySelector('#taskProject').value = '客户项目';
      document.querySelector('#taskEstimate').value = '2';
      document.querySelector('#taskForm').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
      document.querySelector('[data-tab="timer"]').click();
      document.querySelector('#taskSelect').selectedIndex = 1;
      document.querySelector('#start').click();
      await new Promise(r => setTimeout(r, 120));
      return true;
    })()`);
    const elapsed = data.get('focus-state-v2');
    assert.equal(elapsed.timer.taskId, elapsed.tasks[0].id);
    elapsed.timer.runningUntil = Date.now() - 1;
    data.set('focus-state-v2', elapsed);
    await win.reload();
    await new Promise(r => setTimeout(r, 200));
    const saved = data.get('focus-state-v2');
    assert.equal(saved.tasks[0].actual, 1);
    assert.equal(saved.logs[0].taskTitle, '完成报告');
    assert.equal(saved.logs[0].project, '客户项目');
    assert.equal(saved.timer.phase, 'shortBreak');
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-tab="tasks"]').click();
      document.querySelector('[data-task-action="complete"]').click();
      document.querySelector('[data-tab="logs"]').click();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(data.get('focus-state-v2').tasks[0].completedAt);
    const ui = await win.webContents.executeJavaScript(`({head:document.querySelector('.head'), logs:document.querySelector('#logList').textContent, today:document.querySelector('#logToday').textContent})`);
    assert.equal(ui.head, null);
    assert.match(ui.logs, /完成报告/);
    assert.equal(ui.today, '25');
    console.log('focus-worklog Electron interaction tests passed');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win.destroy(); }
});
