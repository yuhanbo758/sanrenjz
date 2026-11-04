const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-prompt-ui-'));
fs.writeFileSync(path.join(temp, 'sample.md'), '# 代码范例\n请解释{{code}}', 'utf8');
const storage = new Map();
storage.set('AI 提示词工坊:prompt-library', [{ id: 1786795972285, title: '代码翻译',
  body: '请将以下{{language}}代码翻译为{{target}}语言，保持功能不变：\n\n```\n{{code}}\n```' }]);
const testRuntimeConfig = {
  schemaVersion: 1,
  providers: [{ id: 'opencode:test', name: '测试模型', baseUrl: 'opencode://test',
    transport: 'opencode', sourceProviderId: 'test', models: [{ id: 'model', sourceModelId: 'model', capabilities: ['text'] }] }],
  selections: { text: { providerId: 'opencode:test', modelId: 'model' } }, timeoutMs: 60000
};
storage.set('AI 共享配置中心:runtime-config', testRuntimeConfig);
ipcMain.handle('plugin-storage-get-async', (_event, name, key) => storage.get(`${name}:${key}`) ?? null);
ipcMain.handle('plugin-storage-set-async', (_event, name, key, value) => { storage.set(`${name}:${key}`, value); return true; });
ipcMain.handle('plugin-secret-get', () => '');
ipcMain.handle('ai-opencode-list-models', () => []);
ipcMain.handle('ai-opencode-complete', (_event, request) => ({ requestId: request.requestId,
  text: '请将以下{{language}}代码翻译为{{target}}语言：{{code}}', model: request.modelId }));
ipcMain.handle('ai-opencode-cancel', () => true);
ipcMain.on('show-open-dialog', event => { event.returnValue = [temp]; });

app.whenReady().then(async () => {
  let win;
  try {
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-prompt');
    win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: {
      preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false
    } });
    await win.loadFile(path.join(directory, 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && !document.querySelector('.lib-item'); i++) await new Promise(r => setTimeout(r, 20));
      const originalTemplate = document.querySelector('#pBody').value;
      const initialCode = document.querySelector('[data-var="code"]');
      initialCode.value = 'def greet():\\n    print("hello")';
      initialCode.dispatchEvent(new Event('input'));
      const autoPython = document.querySelector('[data-var="language"]').value;
      const target = document.querySelector('[data-var="target"]');
      target.value = 'JavaScript'; target.dispatchEvent(new Event('change'));
      document.querySelector('#copyRenderedBtn').click();
      const filledWithTarget = require('electron').clipboard.readText();
      initialCode.value = 'int main() { return 0; }';
      initialCode.dispatchEvent(new Event('input'));
      const unknownSource = document.querySelector('[data-var="language"]').value;
      const unknownHint = document.querySelector('#languageHint').textContent;
      const source = document.querySelector('[data-var="language"]');
      source.value = 'C++'; source.dispatchEvent(new Event('change'));
      const manualSource = source.value;
      initialCode.value = 'def main():\\n    print("changed")';
      initialCode.dispatchEvent(new Event('input'));
      const manualPreserved = source.value;
      source.value = ''; source.dispatchEvent(new Event('change'));
      window.dispatchEvent(new CustomEvent('plugin-enter', { detail: { payload: 'const value = items.map(x => x + 1);' } }));
      const selectedTextSource = document.querySelector('[data-var="language"]').value;
      const selectedTextCode = document.querySelector('[data-var="code"]').value;
      const templatePreserved = document.querySelector('#pBody').value === originalTemplate;
      document.querySelector('#optBtn').click();
      for (let i = 0; i < 100 && document.querySelector('#pvStat').textContent === '优化中…'; i++) await new Promise(r => setTimeout(r, 20));
      const actualIpcOptimize = document.querySelector('#pvStat').textContent;
      document.querySelector('#promptSettingsBtn').click();
      const settingsOpened = document.querySelector('#promptDrawer').classList.contains('open');
      document.querySelector('#choosePath').click();
      for (let i = 0; i < 100 && !document.querySelector('[data-id="file:sample.md"]'); i++) await new Promise(r => setTimeout(r, 20));
      const pathSaved = document.querySelector('#promptPath').value;
      document.querySelector('#closePromptDrawer').click();
      document.querySelector('[data-id="file:sample.md"]').click();
      const readOnly = document.querySelector('#pTitle').readOnly;
      const body = document.querySelector('#pBody');
      body.value = '修改{{code}}';
      body.dispatchEvent(new Event('input', { bubbles: true }));
      const copiedOnEdit = activeId.startsWith('local:') && document.querySelector('#pTitle').value.includes('副本');
      const variable = document.querySelector('#varInputs [data-var="code"]');
      variable.value = 'ABC'; variable.dispatchEvent(new Event('input'));
      document.querySelector('#copyRenderedBtn').click();
      await new Promise(r => setTimeout(r, 30));
      const rendered = require('electron').clipboard.readText();
      body.value = '前缀 @代码'; body.setSelectionRange(body.value.length, body.value.length);
      body.dispatchEvent(new Event('input', { bubbles: true }));
      const mentionShown = !document.querySelector('#mention').hidden;
      [...document.querySelectorAll('#mention button')].find(button => button.querySelector('small')?.textContent === 'sample.md').click();
      const inserted = body.value;
      document.querySelector('#duplicateBtn').click();
      const duplicated = { local: prompts.length, external: external.length, visible: document.querySelectorAll('.lib-item').length };
      providerManager.getSelection = async () => ({});
      api.complete = async () => ({ text: '优化后的{{code}}内容' });
      document.querySelector('#optBtn').click();
      for (let i = 0; i < 100 && document.querySelector('#saveAsBtn').disabled; i++) await new Promise(r => setTimeout(r, 20));
      document.querySelector('#saveAsBtn').click();
      return { autoPython, filledWithTarget, unknownSource, unknownHint, manualSource, manualPreserved, actualIpcOptimize,
        selectedTextSource, selectedTextCode, templatePreserved,
        settingsOpened, pathSaved, readOnly, copiedOnEdit, rendered, mentionShown, inserted, duplicated,
        optimizedTitle: document.querySelector('#pTitle').value, optimizedBody: document.querySelector('#pBody').value };
    })()`);
    assert.strictEqual(result.autoPython, 'Python');
    assert(result.filledWithTarget.includes('JavaScript') && result.filledWithTarget.includes('Python'), JSON.stringify(result));
    assert.strictEqual(result.unknownSource, '');
    assert(result.unknownHint.includes('未能可靠识别'), JSON.stringify(result));
    assert.strictEqual(result.manualSource, 'C++');
    assert.strictEqual(result.manualPreserved, 'C++');
    assert.strictEqual(result.selectedTextSource, 'JavaScript');
    assert(result.selectedTextCode.includes('items.map') && result.templatePreserved, JSON.stringify(result));
    assert.strictEqual(result.actualIpcOptimize, '已完成', JSON.stringify(result));
    assert(result.settingsOpened, JSON.stringify(result));
    assert.strictEqual(result.pathSaved, temp);
    assert(result.readOnly && result.copiedOnEdit, JSON.stringify(result));
    assert.strictEqual(result.rendered, '修改ABC');
    assert(result.mentionShown && result.inserted.includes('请解释{{code}}'), JSON.stringify(result));
    assert(result.duplicated.local >= 2, JSON.stringify(result));
    assert(result.optimizedTitle.includes('优化版') && result.optimizedBody === '优化后的{{code}}内容', JSON.stringify(result));
    assert.strictEqual(fs.readFileSync(path.join(temp, 'sample.md'), 'utf8'), '# 代码范例\n请解释{{code}}');
    assert.strictEqual(storage.get('AI 提示词工坊:prompt-settings').folder, temp);
    await new Promise(resolve => setTimeout(resolve, 500));
    await win.reload();
    const persisted = await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && !document.querySelector('[data-id="file:sample.md"]'); i++) await new Promise(r => setTimeout(r, 20));
      return { path: document.querySelector('#promptPath').value,
        optimized: [...document.querySelectorAll('.lib-item .lt')].some(item => item.textContent.includes('优化版')) };
    })()`);
    assert.strictEqual(persisted.path, temp);
    assert(persisted.optimized, JSON.stringify(persisted));
    win.setSize(900, 650);
    const layout = await win.webContents.executeJavaScript(`({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight })`);
    assert(layout.x <= 1 && layout.y <= 1, JSON.stringify(layout));
    console.log('AI 提示词工坊文件夹、只读副本、@ 插入、变量填充及优化另存 Electron 验证通过');
  } finally { win?.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
