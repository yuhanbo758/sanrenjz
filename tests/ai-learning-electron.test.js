const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
let history = [];
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.handle('plugin-storage-get-async', (_event, _plugin, key) => key === 'learning-history-v1' ? history : ({ schemaVersion: 1, providers: [{ id: 'mock', name: 'Mock', baseUrl: 'https://example.invalid/v1', models: [{ id: 'text', label: 'Text', capabilities: ['text'] }] }], selections: { text: { providerId: 'mock', modelId: 'text' } } }));
ipcMain.handle('plugin-storage-set-async', (_event, _plugin, key, value) => { if (key === 'learning-history-v1') history = value; return true; });
ipcMain.handle('plugin-secret-get', () => ({ value: 'mock-key', encryptionAvailable: true }));
app.whenReady().then(async () => {
  const directory = process.env.AI_LEARNING_PLUGIN_DIR || path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai-learning');
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: { preload: path.join(directory, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false } });
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    const pdfPath = path.join(__dirname, 'fixtures', 'ai-document-sample.pdf');
    if (!process.env.AI_LEARNING_PLUGIN_DIR) {
      const pdfText = await win.webContents.executeJavaScript(`api.readDocument(${JSON.stringify(pdfPath)})`);
      assert.ok(pdfText.trim().length > 0);
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
      const pause = () => new Promise(resolve => setTimeout(resolve, 60));
      const outputs = {
        '卡片': JSON.stringify({items:[{question:'概念？',answer:'第一段\\n第二段'}]}),
        '测试题': JSON.stringify({items:[{question:'选什么？',options:['甲','乙','丙','丁'],answer:'B',explanation:'因为乙'}]}),
        '术语表': JSON.stringify({items:[{term:'术语',definition:'解释'}]}),
        'Anki': JSON.stringify({items:[{question:'正面;测试',answer:'背面"测试'}]}),
        '填空': JSON.stringify({items:[{text:'此处是 {{c1::答案}}。',extra:'解释'}]}),
        '总结': '# 重点\\n\\n第一段\\n\\n第二段',
        '复习': '# 复习\\n\\n问题一'
      };
      const calls=[];
      api.complete=async request=>{calls.push(request);const selected=mode;return{text:outputs[selected]}};
      setInput('学习材料');
      const states={};
      for(const next of Object.keys(outputs)){
        document.querySelector('[data-mode="'+next+'"]').click();
        document.querySelector('#genBtn').click();await pause();
        states[next]={active:mode===next,text:document.querySelector('#result').textContent,children:document.querySelector('#result').children.length};
      }
      const summaryHeadings=document.querySelectorAll('#result h3').length;
      const qualityCount=normalizedItems(JSON.stringify({items:[{question:'重复？',answer:'答案'},{question:'重复？',answer:'重复答案'},{question:'缺答案？',answer:''}]}),'卡片').length;
      const invalidQuizCount=normalizedItems(JSON.stringify({items:[{question:'坏题',options:['甲','乙'],answer:'A'}]}),'测试题').length;
      lastMode='Anki';lastResult=outputs.Anki;const csv=resultForExport();
      lastMode='填空';lastResult=outputs.填空;const clozeCsv=resultForExport();
      document.querySelector('#reviewBtn').click();
      const dueBefore=document.querySelector('#reviewCount').textContent;
      document.querySelector('#reviewContent button').click();
      const answerVisible=document.querySelector('.review-answer').textContent;
      document.querySelector('.review-actions button:nth-child(2)').click();await pause();
      const dueAfter=document.querySelector('#reviewCount').textContent;
      document.querySelector('#closeReview').click();
      document.querySelector('[data-mode="测试题"]').click();document.querySelector('#genBtn').click();await pause();
      document.querySelectorAll('.quiz-opt')[1].click();
      const quiz=document.querySelector('.quiz-feedback').textContent;
      const transfer=new DataTransfer();transfer.items.add(new File(['新增文本'],'note.txt',{type:'text/plain'}));
      document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));await pause();
      const inputAfterImport=document.querySelector('#input').value;
      document.querySelector('#historyBtn').click();
      const before=document.querySelectorAll('.history-item').length;
      window.confirm=()=>true;
      document.querySelector('.history-item .history-actions button:nth-child(2)').click();await pause();
      const afterDelete=document.querySelectorAll('.history-item').length;
      document.querySelector('.history-item .history-actions button').click();
      const restored=document.querySelector('#input').value;
      return {states,summaryHeadings,qualityCount,invalidQuizCount,csv,clozeCsv,dueBefore,dueAfter,answerVisible,quiz,before,afterDelete,restored,restoredMode:mode,activeModes:[...document.querySelectorAll('.modes .mode.active')].map(b=>b.dataset.mode),inputAfterImport,calls:calls.length};
    })()`);
    for (const [name, state] of Object.entries(result.states)) { assert.ok(state.active, name); assert.ok(state.children > 0, name); }
    assert.ok(result.states['卡片'].text.includes('概念？'));
    assert.ok(result.states['术语表'].text.includes('解释'));
    assert.ok(result.summaryHeadings > 0);
    assert.strictEqual(result.qualityCount, 1);
    assert.strictEqual(result.invalidQuizCount, 0);
    assert.ok(result.csv.includes('"正面;测试";"背面""测试"'));
    assert.ok(result.clozeCsv.includes('#notetype:Cloze'));
    assert.ok(result.states['填空'].text.includes('答案'));
    assert.ok(result.dueBefore.includes('3'));
    assert.ok(result.dueAfter.includes('2'));
    assert.ok(result.answerVisible.length > 0);
    assert.ok(result.quiz.includes('回答正确'));
    assert.ok(result.before >= 7);
    assert.strictEqual(result.afterDelete, result.before - 1);
    assert.ok(result.restored.includes('学习材料'));
    assert.deepStrictEqual(result.activeModes, [result.restoredMode]);
    assert.ok(result.inputAfterImport.includes('新增文本'));
    assert.strictEqual(result.calls, 8);
    win.setSize(900, 650);
    const compact = await win.webContents.executeJavaScript(`(() => { const bar=document.querySelector('.modes'); const rect=bar.getBoundingClientRect(); return {pageFits:document.documentElement.scrollHeight<=innerHeight,buttonsVisible:[...bar.querySelectorAll('button')].every(button=>button.getBoundingClientRect().bottom<=rect.bottom)}; })()`);
    assert.ok(compact.pageFits && compact.buttonsVisible);
    if (process.env.AI_LEARNING_SCREENSHOT) {
      win.showInactive();
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(process.env.AI_LEARNING_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }
    console.log('AI 学习卡片 Electron 交互验证通过');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); } finally { win.destroy(); }
});
