const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { createXlsxFixture } = require('./ai-document-xlsx-fixture');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-meeting-ui-'));
const picked = path.join(temp, 'picked.txt');
const exported = path.join(temp, 'minutes.md');
fs.writeFileSync(picked, '文件选择会议内容', 'utf8');
const storage = new Map();
ipcMain.on('show-open-dialog', event => { event.returnValue = [picked]; });
ipcMain.on('show-save-dialog', event => { event.returnValue = exported; });
ipcMain.handle('plugin-storage-get-async', (_event, _name, key) => storage.get(key) || null);
ipcMain.handle('plugin-storage-set-async', (_event, _name, key, value) => { storage.set(key, value); return true; });
ipcMain.handle('plugin-secret-get', () => ({ value: '', encryptionAvailable: true }));

app.whenReady().then(async () => {
  let window;
  try {
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-meeting');
    window = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
    const errors = [];
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadFile(path.join(directory, 'index.html'));
    const selected = await window.webContents.executeJavaScript(`(async()=>{await pickFiles();return document.querySelector('#sourceList').textContent})()`);
    assert.match(selected, /picked\.txt/);
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:p><a:t>幻灯片会议目标</a:t></a:p>');
    const pptx = await zip.generateAsync({ type: 'nodebuffer' });
    const xlsx = await createXlsxFixture();
    for (const [name, data, expected] of [['slides.pptx', pptx, '幻灯片会议目标'], ['sales.xlsx', xlsx, '工作表：销售'], ['legacy.doc', fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-document-sample.doc')), '文档正文']]) {
      const value = await window.webContents.executeJavaScript(`(async()=>{
        const bytes=Uint8Array.from(atob(${JSON.stringify(data.toString('base64'))}),character=>character.charCodeAt(0));
        const event=new Event('drop',{bubbles:true,cancelable:true});
        Object.defineProperty(event,'dataTransfer',{value:{files:[new File([bytes],${JSON.stringify(name)})]}});
        window.dispatchEvent(event);
        for(let i=0;i<100&&!sources.some(source=>source.name===${JSON.stringify(name)});i++)await new Promise(resolve=>setTimeout(resolve,20));
        return sources.find(source=>source.name===${JSON.stringify(name)})?.text||'';
      })()`);
      assert.match(value, new RegExp(expected), name);
    }
    const result = await window.webContents.executeJavaScript(`(async()=>{
      api.complete=async request=>{window.__meetingPrompt=request.messages[0].content;return{text:'## 议题\\n年度计划\\n## 结论\\n通过\\n## 决策\\n预算批准\\n## 待办事项\\n张三跟进\\n## 风险与阻塞\\n资源不足\\n## 待确认问题\\n交付日期'};};
      await generateAll();
      return {prompt:window.__meetingPrompt,decision:document.querySelector('#outDecisions').textContent,risk:document.querySelector('#outRisks').textContent,summary:document.querySelector('#outSummary').textContent};
    })()`);
    assert.match(result.prompt, /文件选择会议内容/, JSON.stringify(result));
    assert.match(result.prompt, /幻灯片会议目标/);
    assert.match(result.prompt, /工作表：销售/);
    assert.equal(result.decision, '预算批准');
    assert.equal(result.risk, '资源不足');
    await window.webContents.executeJavaScript('exportMinutes()');
    assert.match(fs.readFileSync(exported, 'utf8'), /## 待确认问题\n交付日期/);
    const audio = await window.webContents.executeJavaScript(`(async()=>{
      await addFiles([{name:'meeting.webm',data:new Uint8Array([1,2,3]),size:3,type:'audio/webm'}]);
      api.transcribeAudio=async()=> '录音会议内容';
      document.querySelector('#asrModel').value='whisper-1';
      document.querySelector('#asrProvider').add(new Option('测试服务','test'));
      document.querySelector('#asrProvider').value='test';
      await transcribeSelected();return document.querySelector('#transcript').value;
    })()`);
    assert.match(audio, /录音会议内容/);
    const recorded = await window.webContents.executeJavaScript(`(async()=>{
      Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{}}]})}});
      window.MediaRecorder=class{constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob([new Uint8Array([4,5,6])])});this.onstop();}};
      await toggleRecording();const started=document.querySelector('#recordBtn').textContent;
      await toggleRecording();for(let i=0;i<50&&recorder;i++)await new Promise(resolve=>setTimeout(resolve,20));
      return {started,stopped:document.querySelector('#recordBtn').textContent,audio:audioSource?.name||''};
    })()`);
    assert.equal(recorded.started, '停止录音');
    assert.equal(recorded.stopped, '开始录音');
    assert.match(recorded.audio, /会议录音/);
    for (const [width, height] of [[900, 650], [1180, 760]]) {
      window.setSize(width, height);
      const layout = await window.webContents.executeJavaScript(`(()=>({page:document.documentElement.scrollHeight<=innerHeight+1,head:document.querySelector('.gear').getBoundingClientRect().right<=innerWidth+1,output:document.querySelector('.output-section').getBoundingClientRect().height>100}))()`);
      assert(layout.page && layout.head && layout.output, `${width}x${height} 布局 ${JSON.stringify(layout)}`);
    }
    assert.deepStrictEqual(errors, []);
    console.log('AI 会议纪要 Electron 选择、拖拽、生成、音频、导出测试通过');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
