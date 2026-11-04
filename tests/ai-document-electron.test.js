const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createXlsxFixture } = require('./ai-document-xlsx-fixture');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-document-ui-'));
const first = path.join(temp, 'first.txt');
const second = path.join(temp, 'second.md');
fs.writeFileSync(first, '第一份文档的关键词', 'utf8');
fs.writeFileSync(second, '# 第二份\n独立正文', 'utf8');
let selectedPaths = [first, second];
ipcMain.on('show-open-dialog', event => { event.returnValue = selectedPaths; });
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);
ipcMain.handle('plugin-secret-get', () => null);

app.whenReady().then(async () => {
  let window;
  try {
    const pdfPath = path.join(__dirname, 'fixtures', 'ai-document-sample.pdf');
    const legacyPath = path.join(__dirname, 'fixtures', 'ai-document-sample.doc');
    const pdfBytes = fs.readFileSync(pdfPath);
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-document');
    window = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: {
      preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false
    } });
    await window.loadFile(path.join(directory, 'index.html'));
    const loaded = await window.webContents.executeJavaScript(`(async()=>{
      await loadDocument();
      return {count:document.querySelector('#docSelect').options.length,text:document.querySelector('#docText').value};
    })()`);
    assert.deepStrictEqual(loaded, { count: 3, text: '# 第二份\n独立正文' });
    const switched = await window.webContents.executeJavaScript(`(()=>{
      const select=document.querySelector('#docSelect');select.value=select.options[1].value;
      select.dispatchEvent(new Event('change'));
      const search=document.querySelector('#docSearch');search.value='关键词';findNext();
      const box=document.querySelector('#docText');
      return {text:box.value,selected:box.value.slice(box.selectionStart,box.selectionEnd)};
    })()`);
    assert.deepStrictEqual(switched, { text: '第一份文档的关键词', selected: '关键词' });
    const dropped = await window.webContents.executeJavaScript(`(async()=>{
      const file=new File(['拖入的新文档'], 'drop.md', {type:'text/markdown'});
      const event=new Event('drop', {bubbles:true,cancelable:true});
      Object.defineProperty(event,'dataTransfer',{value:{files:[file]}});
      window.dispatchEvent(event);
      for(let i=0;i<50&&document.querySelector('#docSelect').options.length<4;i++)await new Promise(r=>setTimeout(r,20));
      return {count:document.querySelector('#docSelect').options.length,text:document.querySelector('#docText').value};
    })()`);
    assert.deepStrictEqual(dropped, { count: 4, text: '拖入的新文档' });
    const selected = await window.webContents.executeJavaScript(`(()=>{
      const box=document.querySelector('#docText');box.setSelectionRange(0,2);askSelection();
      return {question:document.querySelector('#chatInput').value,context:document.querySelector('#chatInput').dataset.selection};
    })()`);
    assert.deepStrictEqual(selected, { question: '请解释这段内容', context: '拖入' });
    const prompt = await window.webContents.executeJavaScript(`(async()=>{
      providerManager.getSelection=async()=>({});
      api.complete=async request=>{window.__prompt=request.messages[0].content;return{text:'完成'};};
      askAI();
      for(let i=0;i<50&&!window.__prompt;i++)await new Promise(r=>setTimeout(r,20));
      return window.__prompt;
    })()`);
    assert(prompt.includes('拖入') && !prompt.includes('独立正文'), '选段提问只应发送选中文字');
    async function dropBuffer(buffer, name, expectedCount) {
      return window.webContents.executeJavaScript(`(async()=>{
        const bytes=Uint8Array.from(atob(${JSON.stringify(buffer.toString('base64'))}),char=>char.charCodeAt(0));
        const file=new File([bytes],${JSON.stringify(name)});
        const event=new Event('drop',{bubbles:true,cancelable:true});
        Object.defineProperty(event,'dataTransfer',{value:{files:[file]}});
        window.dispatchEvent(event);
        for(let i=0;i<100&&document.querySelector('#docSelect').options.length<${expectedCount};i++)await new Promise(r=>setTimeout(r,20));
        return {count:document.querySelector('#docSelect').options.length,text:document.querySelector('#docText').value,error:document.querySelector('#chatList .msg.sys:last-child')?.textContent||''};
      })()`);
    }
    const legacy = fs.readFileSync(legacyPath);
    const docDrop = await dropBuffer(legacy, 'legacy.doc', 5);
    assert.equal(docDrop.count, 5, docDrop.error);
    assert.match(docDrop.text, /Legacy Word sample 文档正文/);
    const pdfDrop = await dropBuffer(pdfBytes, 'sample.pdf', 6);
    assert.equal(pdfDrop.count, 6, pdfDrop.error);
    assert.match(pdfDrop.text, /PDF sample/);
    const xlsxBytes = await createXlsxFixture();
    const xlsxDrop = await dropBuffer(xlsxBytes, 'table.xlsx', 7);
    assert.equal(xlsxDrop.count, 7, xlsxDrop.error);
    assert.match(xlsxDrop.text, /工作表：销售\n项目\t金额\n苹果\t12\.5/);
    assert.match(xlsxDrop.text, /工作表：备注\n说明\t第二个工作表/);
    const actions = await window.webContents.executeJavaScript(`(async()=>{
      window.__prompt='';quickAction('risks');
      for(let i=0;i<50&&!window.__prompt;i++)await new Promise(r=>setTimeout(r,20));
      const risk=window.__prompt;
      for(let i=0;i<50&&busy;i++)await new Promise(r=>setTimeout(r,20));
      window.__prompt='';
      const compare=document.querySelector('#compareSelect');
      compare.value=[...compare.options].find(option=>option.textContent==='first.txt').value;
      compareDocuments();
      for(let i=0;i<50&&!window.__prompt;i++)await new Promise(r=>setTimeout(r,20));
      return {buttons:document.querySelectorAll('.chat-head .quick-btn').length,risk,comparison:window.__prompt};
    })()`);
    assert.equal(actions.buttons, 11);
    assert.match(actions.risk, /矛盾、表述模糊/);
    assert(actions.comparison.includes('工作表：销售') && actions.comparison.includes('第一份文档的关键词'));
    selectedPaths = [legacyPath, pdfPath];
    const picked = await window.webContents.executeJavaScript(`(async()=>{await loadDocument();return{count:document.querySelector('#docSelect').options.length,text:document.querySelector('#docText').value}})()`);
    assert.deepStrictEqual(picked, { count: 9, text: 'PDF sample' });
    for (const [width, height] of [[900, 650], [1180, 760]]) {
      window.setSize(width, height);
      const visible = await window.webContents.executeJavaScript(`(()=>{const foot=document.querySelector('.doc-foot'),r=foot.getBoundingClientRect(),right=document.querySelector('.doc-side').getBoundingClientRect().right,actions=document.querySelector('.chat-head').getBoundingClientRect(),chat=document.querySelector('.chat-list').getBoundingClientRect();return r.bottom<=innerHeight&&document.documentElement.scrollHeight<=innerHeight+1&&[...foot.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right<=right)&&actions.bottom<=chat.top+1&&chat.height>=150})()`);
      assert(visible, `${width}x${height} 底部操作应可见`);
    }
    console.log('AI 文档阅读器 Electron 交互测试通过');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
