const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const assert = require('assert');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);
ipcMain.handle('plugin-secret-get', () => '');
ipcMain.handle('ai-opencode-list-models', () => []);

app.whenReady().then(async () => {
  let win;
  try {
    const directory = process.env.AI_REGEX_PLUGIN_DIR || path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-regex');
    win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: {
      preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false
    } });
    await win.loadFile(path.join(directory, 'index.html'));
    const state = await win.webContents.executeJavaScript(`(async()=>{
      const $=s=>document.querySelector(s);
      $('[data-mode="解释"]').click();const explain=$('.mode.active').dataset.mode;
      $('[data-mode="修复"]').click();const repair=$('.mode.active').dataset.mode;
      providerManager.getSelection=async()=>({});
      api.complete=async request=>{window.__prompt=request.messages[0].content;return {text:'## 修复后\\n\\n\`\`\`regex\\n/(?<word>foo)\\/bar/gi\\n\`\`\`\\n- 说明一'};};
      $('#input').value='有问题的正则';$('#genBtn').click();
      for(let i=0;i<50&&$('#resStat').textContent!=='已完成';i++)await new Promise(r=>setTimeout(r,20));
      $('#testInput').value='foo/bar FOO/bar';$('#testInput').dispatchEvent(new Event('input'));
      $('#replaceInput').value='[$<word>]';$('#replaceInput').dispatchEvent(new Event('input'));
      $('#positiveInput').value='foo/bar';$('#positiveInput').dispatchEvent(new Event('input'));
      $('#negativeInput').value='other';$('#negativeInput').dispatchEvent(new Event('input'));
      for(let i=0;i<80&&!$('#testRes').textContent.includes('2 处');i++)await new Promise(r=>setTimeout(r,25));
      $('#copyBtn').click();
      return {explain,repair,prompt:window.__prompt,pattern:$('#patternInput').value,flags:$('#flagsInput').value,
        count:$('#testRes').textContent,preview:$('#replacePreview').textContent,checks:$('#checkResults').textContent,
        heading:$('#result h3')?.textContent,list:$('#result li')?.textContent,marks:$('#matchPreview').querySelectorAll('mark').length,
        group:$('#matchList').textContent};
    })()`);
    assert.strictEqual(state.explain, '解释');
    assert.strictEqual(state.repair, '修复');
    assert(state.prompt.includes('请修复'));
    assert.strictEqual(state.pattern, '(?<word>foo)/bar');
    assert.strictEqual(state.flags, 'gi');
    assert(state.count.includes('2 处'), JSON.stringify(state));
    assert.strictEqual(state.preview, '[foo] [FOO]');
    assert(state.checks.includes('2/2 通过'));
    assert.strictEqual(state.heading, '修复后');
    assert.strictEqual(state.list, '说明一');
    assert.strictEqual(state.marks, 2);
    assert(state.group.includes('word="foo"'));
    assert(clipboard.readText().includes('## 修复后'));
    const invalid = await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#patternInput').value='(';
      document.querySelector('#patternInput').dispatchEvent(new Event('input'));
      for(let i=0;i<40&&!document.querySelector('#regexStatus').classList.contains('error');i++)await new Promise(r=>setTimeout(r,20));
      return {error:document.querySelector('#regexStatus').textContent,oldMatches:document.querySelector('#matchList').textContent};
    })()`);
    assert(invalid.error.includes('Invalid regular expression'), JSON.stringify(invalid));
    assert.strictEqual(invalid.oldMatches, '');
    const timeout = await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#patternInput').value='(a+)+$';
      document.querySelector('#testInput').value='a'.repeat(10000)+'b';
      document.querySelector('#patternInput').dispatchEvent(new Event('input'));
      for(let i=0;i<60&&!document.querySelector('#regexStatus').textContent.includes('超时');i++)await new Promise(r=>setTimeout(r,25));
      return document.querySelector('#regexStatus').textContent;
    })()`);
    assert(timeout.includes('超时'), timeout);
    const layout = await win.webContents.executeJavaScript(`({x:document.documentElement.scrollWidth-document.documentElement.clientWidth,y:document.documentElement.scrollHeight-document.documentElement.clientHeight})`);
    assert(layout.x <= 1 && layout.y <= 1, JSON.stringify(layout));
    win.setSize(900, 650);
    const compact = await win.webContents.executeJavaScript(`({x:document.documentElement.scrollWidth-document.documentElement.clientWidth,y:document.documentElement.scrollHeight-document.documentElement.clientHeight})`);
    assert(compact.x <= 1 && compact.y <= 1, JSON.stringify(compact));
    console.log('AI 正则助手模式、AI 排版、匹配、替换、样本校验及复制 Electron 验证通过');
  } finally { win?.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
