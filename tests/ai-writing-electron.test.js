const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-writing-ui-'));
const sourceFile = path.join(temp, 'source.txt');
fs.writeFileSync(sourceFile, '本地参考文件正文', 'utf8');
let selectedPaths = [sourceFile];
ipcMain.on('show-open-dialog', event => { event.returnValue = selectedPaths; });
ipcMain.on('show-save-dialog', event => { event.returnValue = path.join(temp, 'result.md'); });
ipcMain.handle('plugin-storage-get-async', () => null);
ipcMain.handle('plugin-storage-set-async', () => true);
ipcMain.handle('plugin-secret-get', () => null);

app.whenReady().then(async () => {
  let window;
  try {
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-writing');
    window = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: {
      preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false
    } });
    await window.loadFile(path.join(directory, 'index.html'));
    const picked = await window.webContents.executeJavaScript(`(async()=>{document.querySelector('#addFileBtn').click();for(let i=0;i<40&&files.length<1;i++)await new Promise(r=>setTimeout(r,20));return files.map(f=>f.text)})()`);
    assert.deepStrictEqual(picked, ['本地参考文件正文']);
    const dropped = await window.webContents.executeJavaScript(`(async()=>{const file=new File(['拖入参考文字'],'dropped.md');const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[file]}});window.dispatchEvent(event);for(let i=0;i<40&&files.length<2;i++)await new Promise(r=>setTimeout(r,20));return files.map(f=>f.text)})()`);
    assert.deepStrictEqual(dropped, ['本地参考文件正文', '拖入参考文字']);
    await window.webContents.executeJavaScript(`(async()=>{for(let i=0;i<40&&importBusy;i++)await new Promise(r=>setTimeout(r,20))})()`);
    const outcome = await window.webContents.executeJavaScript(`(async()=>{document.querySelector('[data-mode="大纲"]').click();document.querySelector('#source').value='主体原文';document.querySelector('#audience').value='客户';providerManager.getSelection=async()=>({});api.complete=async request=>{window.__prompt=request.messages[0].content;return{text:'# 输出标题\\n\\n第一段\\n\\n- 安全条目 <script>window.__unsafe=1</script>'}};const disabled=document.querySelector('#genBtn').disabled;document.querySelector('#genBtn').click();for(let i=0;i<40&&!resultText;i++)await new Promise(r=>setTimeout(r,20));return{prompt:window.__prompt,heading:document.querySelector('#result h1')?.textContent,list:document.querySelector('#result li')?.textContent,unsafe:window.__unsafe||0,disabled,mode,importBusy,streaming,toast:document.querySelector('#toast').textContent,stat:document.querySelector('#resStat').textContent}})()`);
    assert(outcome.prompt, JSON.stringify(outcome));
    assert.match(outcome.prompt, /大纲/);
    assert.match(outcome.prompt, /本地参考文件正文/);
    assert.match(outcome.prompt, /拖入参考文字/);
    assert.equal(outcome.heading, '输出标题');
    assert.match(outcome.list, /安全条目/);
    assert.equal(outcome.unsafe, 0);
    const saved = await window.webContents.executeJavaScript(`(async()=>{document.querySelector('#saveBtn').click();const path=${JSON.stringify(path.join(temp, 'result.md'))};for(let i=0;i<40&&(!require('fs').existsSync(path)||!require('fs').readFileSync(path,'utf8'));i++)await new Promise(r=>setTimeout(r,20));document.querySelector('#reuseBtn').click();return document.querySelector('#source').value})()`);
    assert.match(saved, /输出标题/);
    assert.match(fs.readFileSync(path.join(temp, 'result.md'), 'utf8'), /^# 输出标题/);
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 写作素材</w:t></w:r></w:p></w:body></w:document>');
    const samples = [
      ['sample.txt', Buffer.from('TXT 写作素材'), 'TXT 写作素材'],
      ['sample.md', Buffer.from('# MD 写作素材'), 'MD 写作素材'],
      ['sample.markdown', Buffer.from('# Markdown 写作素材'), 'Markdown 写作素材'],
      ['sample.csv', Buffer.from('名称,说明\nCSV,写作素材'), 'CSV,写作素材'],
      ['sample.json', Buffer.from('{"topic":"JSON 写作素材"}'), 'JSON 写作素材'],
      ['sample.docx', await zip.generateAsync({ type: 'nodebuffer' }), 'Word 写作素材'],
      ['sample.pdf', fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-document-sample.pdf')), 'PDF sample']
    ];
    for (const [name, buffer, expected] of samples) {
      const filePath = path.join(temp, name);
      fs.writeFileSync(filePath, buffer);
      selectedPaths = [filePath];
      const pickedText = await window.webContents.executeJavaScript(`(async()=>{files=[];renderFiles();document.querySelector('#addFileBtn').click();for(let i=0;i<150&&importBusy;i++)await new Promise(r=>setTimeout(r,20));return files[0]?.text||document.querySelector('#toast').textContent})()`);
      assert(pickedText.includes(expected), `${name} 文件选择：${pickedText}`);
      const droppedText = await window.webContents.executeJavaScript(`(async()=>{files=[];renderFiles();const bytes=Uint8Array.from(atob(${JSON.stringify(buffer.toString('base64'))}),c=>c.charCodeAt(0));const file=new File([bytes],${JSON.stringify(name)});const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[file]}});window.dispatchEvent(event);for(let i=0;i<150&&importBusy;i++)await new Promise(r=>setTimeout(r,20));return files[0]?.text||document.querySelector('#toast').textContent})()`);
      assert(droppedText.includes(expected), `${name} 文件拖拽：${droppedText}`);
    }
    for (const [width, height] of [[900, 650], [1180, 760]]) {
      window.setSize(width, height);
      const layout = await window.webContents.executeJavaScript(`(()=>({page:document.documentElement.scrollHeight<=innerHeight+1,footer:document.querySelector('.act-bar').getBoundingClientRect().bottom<=innerHeight,buttons:[...document.querySelectorAll('.act-bar button')].every(b=>b.getBoundingClientRect().right<=innerWidth)}))()`);
      assert(layout.page && layout.footer && layout.buttons, `${width}x${height} 布局应完整：${JSON.stringify(layout)}`);
    }
    console.log('AI 写作工作室 Electron 文件、生成、保存与布局测试通过');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
