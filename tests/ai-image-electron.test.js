const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('assert');
const path=require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
ipcMain.handle('plugin-storage-get-async',()=>({schemaVersion:1,providers:[{id:'mock',name:'Mock',baseUrl:'https://example.invalid/v1',models:[{id:'vision',label:'Vision',capabilities:['text','vision']}]}],selections:{vision:{providerId:'mock',modelId:'vision'}},timeoutMs:60000}));
ipcMain.handle('plugin-secret-get',()=>({value:'mock-key',encryptionAvailable:true}));

app.whenReady().then(async()=>{
  const directory=path.join(__dirname,'..','app','software','sanrenjz-tools-ai-image');
  const win=new BrowserWindow({show:false,width:900,height:650,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  try{
    await win.loadFile(path.join(directory,'index.html'));
    const state=await win.webContents.executeJavaScript(`(async()=>{
      const calls=[];
      api.complete=async request=>{calls.push(request);return{requestId:request.requestId,text:'模拟结果'}};
      const img=document.createElement('canvas');img.width=4;img.height=4;
      setImage(img.toDataURL('image/png'),'测试图片.png');
      await new Promise(resolve=>setTimeout(resolve,50));
      document.querySelector('[data-mode="标题"]').click();
      document.querySelector('#genBtn').click();
      await new Promise(resolve=>setTimeout(resolve,50));
      const title={text:document.querySelector('#result').textContent,prompt:calls.at(-1)?.messages[0].content[0].text};
      document.querySelector('[data-mode="文字提取"]').click();
      document.querySelector('#genBtn').click();
      await new Promise(resolve=>setTimeout(resolve,50));
      const ocr=calls.at(-1)?.messages[0].content[0].text;
      document.querySelector('[data-mode="问答"]').click();
      document.querySelector('#genBtn').click();
      const beforeQuestion=calls.length;
      document.querySelector('#extraPrompt').value='图中有什么？';
      document.querySelector('#genBtn').click();
      await new Promise(resolve=>setTimeout(resolve,50));
      const question=calls.at(-1)?.messages[0].content[0].text;
      let finishOld;
      api.complete=()=>new Promise(resolve=>{finishOld=resolve});
      document.querySelector('[data-mode="标题"]').click();
      document.querySelector('#genBtn').click();
      await new Promise(resolve=>setTimeout(resolve,50));
      document.querySelector('[data-mode="文字提取"]').click();
      finishOld({text:'旧请求结果'});
      await new Promise(resolve=>setTimeout(resolve,30));
      const staleResult=document.querySelector('#result').textContent;
      document.querySelector('#clearBtn').click();
      return{title,ocr,beforeQuestion,question,callCount:calls.length,staleResult,clearText:document.querySelector('#result').textContent,imageEmpty:!imageDataUrl};
    })()`);
    assert.strictEqual(state.title.text,'模拟结果');
    assert.ok(state.title.prompt.includes('5 个适合发布的中文标题'));
    assert.ok(state.ocr.includes('按阅读顺序逐行转写'));
    assert.strictEqual(state.beforeQuestion,2);
    assert.ok(state.question.includes('图中有什么？'));
    assert.strictEqual(state.callCount,3);
    assert.strictEqual(state.staleResult,'选择图片并点击生成');
    assert.strictEqual(state.clearText,'选择图片并点击生成');
    assert.strictEqual(state.imageEmpty,true);
    console.log('AI 图片理解 Electron 交互验证通过');
    app.exit(0);
  }catch(error){console.error(error);app.exit(1);}finally{win.destroy();}
});
