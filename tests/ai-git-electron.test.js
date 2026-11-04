const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);
ipcMain.handle('plugin-secret-get', () => '');
ipcMain.handle('ai-opencode-list-models', () => []);
ipcMain.handle('show-open-dialog', () => ({ canceled: true, filePaths: [] }));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-git-ui-'));
function git(...args) { execFileSync('git', args, { cwd: temp, windowsHide: true }); }

app.whenReady().then(async () => {
  let win;
  try {
    git('init');git('config', 'user.email', 'test@example.invalid');git('config', 'user.name', 'AI Git Test');
    fs.writeFileSync(path.join(temp, 'file.txt'), 'initial\n', 'utf8');
    git('add', 'file.txt');git('commit', '-m', 'feat: initial');
    fs.appendFileSync(path.join(temp, 'file.txt'), 'changed\n');
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-git');
    win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: {
      preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false
    } });
    await win.loadFile(path.join(directory, 'index.html'));
    const state = await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('[data-mode="变更日志"]').click();
      const logMode=document.querySelector('.mode.active')?.dataset.mode;
      const logSource=document.querySelector('#source').value;
      document.querySelector('[data-mode="Release Notes"]').click();
      const releaseMode=document.querySelector('.mode.active')?.dataset.mode;
      document.querySelector('[data-mode="PR 描述"]').click();
      const prMode=document.querySelector('.mode.active')?.dataset.mode;
      const event=new Event('drop',{bubbles:true,cancelable:true});
      Object.defineProperty(event,'dataTransfer',{value:{files:[{path:${JSON.stringify(temp)}}]}});
      window.dispatchEvent(event);
      for(let i=0;i<100&&!document.querySelector('#input').value.includes('## 未暂存 Diff');i++)await new Promise(r=>setTimeout(r,25));
      const input=document.querySelector('#input').value;
      providerManager.getSelection=async()=>({});
      api.complete=async request=>{window.__messages=request.messages;return {text:'PR result'};};
      document.querySelector('#genBtn').click();
      for(let i=0;i<50&&document.querySelector('#resStat').textContent!=='已完成';i++)await new Promise(r=>setTimeout(r,20));
      window.exports['plugin-market-ai-git-risk'].args.enter({});
      const source=document.querySelector('#source');source.value='base';source.dispatchEvent(new Event('change'));
      const baseVisible=!document.querySelector('#baseRef').hidden;
      return {logMode,logSource,releaseMode,prMode,input,repo:document.querySelector('#repoPath').textContent,
        result:document.querySelector('#result').textContent,task:window.__messages?.[1]?.content||'',
        entryMode:document.querySelector('.mode.active')?.dataset.mode,baseVisible};
    })()`);
    assert.strictEqual(state.logMode, '变更日志');
    assert.strictEqual(state.logSource, 'recent');
    assert.strictEqual(state.releaseMode, 'Release Notes');
    assert.strictEqual(state.prMode, 'PR 描述');
    assert(state.input.includes('## 未暂存 Diff'), JSON.stringify(state));
    assert.strictEqual(path.normalize(state.repo), path.normalize(temp));
    assert.strictEqual(state.result, 'PR result');
    assert(state.task.includes('中文 PR 描述'));
    assert.strictEqual(state.entryMode, '变更风险');
    assert.strictEqual(state.baseVisible, true);
    win.setSize(900, 650);
    const layout = await win.webContents.executeJavaScript(`({scrollX:document.documentElement.scrollWidth-document.documentElement.clientWidth,scrollY:document.documentElement.scrollHeight-document.documentElement.clientHeight})`);
    assert(layout.scrollX <= 1 && layout.scrollY <= 1, JSON.stringify(layout));
    console.log('AI Git 助手模式切换、拖入项目和生成入口 Electron 验证通过');
  } finally { win?.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
