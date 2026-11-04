const assert = require('assert');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const config = { schemaVersion: 1, providers: [{ id: 'test', name: 'Test', baseUrl: 'https://example.invalid/v1', models: [{ id: 'test-model', label: 'Test Model', capabilities: ['text'] }] }], selections: { text: { providerId: 'test', modelId: 'test-model' } }, timeoutMs: 60000 };
ipcMain.on('plugin-storage-get', event => { event.returnValue = config; });
ipcMain.handle('plugin-storage-get-async', () => config);
ipcMain.handle('plugin-secret-get', () => 'test-key');
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const folder = process.env.AI_SQL_PLUGIN_DIR || path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-sql');
  const win = new BrowserWindow({ show: false, x: -32000, y: -32000, width: 1180, height: 760, webPreferences: { preload: path.join(folder, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  try {
    await win.loadFile(path.join(folder, 'index.html'));
    win.showInactive();
    const state = await win.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('#input');
      const run = async () => document.querySelector('#genBtn').click();
      const pick = label => [...document.querySelectorAll('.modes .mode')].find(button => button.dataset.mode === label).click();
      const wait = () => new Promise(resolve => setTimeout(resolve, 30));
      const prompts = [];
      document.querySelector('.gear').click();
      const providerDrawer = document.querySelector('#drawer').classList.contains('open') && Boolean(document.querySelector('[data-ai-form]'));
      document.querySelector('#drawer [data-ai-close]').click();
      window.aiAPI.complete = async options => { prompts.push(options.messages[0].content); const fence = String.fromCharCode(96).repeat(3); return { text: '说明\\n' + fence + 'sql\\nSELECT id FROM users;\\n' + fence }; };
      providerManager.getSelection = async () => ({ providerId: 'test', modelId: 'test-model' });
      input.value = 'SELECT id FROM users';
      pick('解释'); await run(); await wait();
      const explained = document.querySelector('#resStat').textContent;
      pick('优化'); await run(); await wait();
      const optimized = document.querySelector('#resStat').textContent;
      const sections = [...document.querySelectorAll('#result .result-section')].map(node => node.querySelector('h3').textContent);
      const copySql = !document.querySelector('#copySqlBtn').disabled;
      pick('格式化'); input.value = 'select id,name from users where id=1;'; await run(); await wait();
      const formatted = document.querySelector('#result pre')?.textContent;
      pick('检查'); input.value = 'DELETE FROM users'; await run(); await wait();
      const risk = document.querySelector('#result').textContent;
      pick('计划'); input.value = 'SELECT id FROM users'; document.querySelector('#dialect').value = 'SQLite'; await run(); await wait();
      const plan = document.querySelector('#result pre')?.textContent;
      return { explained, optimized, sections, copySql, formatted, risk, plan, prompts, providerDrawer, modes: document.querySelectorAll('.modes .mode.active').length };
    })()`);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(state.explained, '已完成');
    assert.strictEqual(state.optimized, '已完成');
    assert.deepStrictEqual(state.sections, ['说明', 'SQL']);
    assert.ok(state.copySql);
    assert.ok(state.providerDrawer);
    assert.ok(state.formatted.includes('\nFROM users\nWHERE'));
    assert.ok(state.risk.includes('WHERE'));
    assert.ok(/EXPLAIN QUERY PLAN\s+SELECT/.test(state.plan));
    assert.ok(state.prompts[0].includes('解释 SQL'));
    assert.ok(state.prompts[1].includes('优化 SQL'));
    assert.strictEqual(state.modes, 1);
    console.log('AI SQL Electron interactions: OK');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
}).catch(error => { console.error(error); process.exitCode = 1; app.quit(); });
