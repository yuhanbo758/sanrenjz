const {app,BrowserWindow,ipcMain,session}=require('electron');
const assert=require('assert');
const path=require('path');
const fs=require('fs');
const os=require('os');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'sanrenjz-plugin-smoke-'));
process.env.SANRENJZ_USER_DATA=profile;
process.env.SANRENJZ_TEST_HIDDEN='1';
app.setPath('userData',profile);
const reportFile=path.resolve(__dirname,'../dist/legacy-electron-smoke-report.json');
const cases=[];
fs.mkdirSync(path.dirname(reportFile),{recursive:true});
function finish(success,error){
  fs.writeFileSync(reportFile,JSON.stringify({success,isolatedProfile:true,offscreenHitTesting:true,cases,error:error?.stack||String(error||'')},null,2));
  app.exit(success?0:1);
}
app.once('quit',()=>{try{fs.rmSync(profile,{recursive:true,force:true})}catch(_){}});
const {catalog}=require('../scripts/plugin-market/catalog');
const memory=new Map();
memory.set('AI 共享配置中心:runtime-config',{schemaVersion:1,providers:[
  {id:'glm',name:'GLM',baseUrl:'https://open.bigmodel.cn/api/paas/v4',models:[{id:'glm-4-flash',label:'GLM-4 Flash',capabilities:['text']},{id:'glm-4v-plus',label:'GLM-4V Plus',capabilities:['text','vision']}]},
  {id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',models:[{id:'deepseek-chat',label:'DeepSeek Chat',capabilities:['text']}]}
],selections:{text:{providerId:'deepseek',modelId:'deepseek-chat'},vision:{providerId:'glm',modelId:'glm-4v-plus'}},timeoutMs:60000});
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});
ipcMain.on('show-open-dialog',event=>event.returnValue=[]);ipcMain.on('show-save-dialog',event=>event.returnValue='');
ipcMain.on('plugin-storage-get',(event,name,key)=>{event.returnValue=memory.get(`${name}:${key}`)??null});
ipcMain.on('plugin-storage-set',(event,name,key,value)=>{memory.set(`${name}:${key}`,value);event.returnValue=true});
ipcMain.handle('plugin-storage-get-async',(_e,name,key)=>memory.get(`${name}:${key}`)??null);
ipcMain.handle('plugin-storage-set-async',(_e,name,key,value)=>{memory.set(`${name}:${key}`,value);return true});
ipcMain.handle('plugin-storage-remove-async',(_e,name,key)=>{memory.delete(`${name}:${key}`);return true});
ipcMain.handle('plugin-secret-get',()=> 'mock-key');ipcMain.handle('plugin-secret-set',()=>true);ipcMain.handle('plugin-secret-remove',()=>true);
ipcMain.handle('ai-opencode-list-models',()=>[{id:'openai',name:'OpenAI',transport:'opencode',source:'opencode',managed:true,baseUrl:'opencode://openai',models:[{id:'gpt-codex',label:'GPT Codex',capabilities:['text','vision']}]}]);
ipcMain.handle('register-plugin-features',()=>true);
for(const channel of ['toggle-plugin-pin-window','minimize-plugin-window','create-plugin-indicator-window','close-plugin-indicator-window'])ipcMain.handle(channel,()=>false);

// 记录总指挥实际发出的 IPC 参数，用于验证首次执行与再次打开的费用安全边界。
const commanderDispatches=[];
ipcMain.handle('execute-super-panel-action',(_event,payload)=>{commanderDispatches.push(payload);return{success:true}});

async function inspect(plugin,width,height){
  const directory=path.join(__dirname,'..','app','software',plugin.folder);const errors=[];
  // Windows 下完全隐藏的 BrowserWindow 不参与命中测试，elementFromPoint() 会错误返回 null。
  // 将测试窗口放到屏幕外并短暂显示，既能真实验证主程序标题栏控件未被插件遮挡，也不会干扰用户桌面。
  const win=new BrowserWindow({show:false,x:-32000,y:-32000,width,height,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});win.webContents.on('render-process-gone',(_e,d)=>errors.push(`renderer:${d.reason}`));
  await win.loadFile(path.join(directory,'index.html'));win.showInactive();await new Promise(resolve=>setTimeout(resolve,80));
  const state=await win.webContents.executeJavaScript(`(()=>{const bar=document.createElement('div');bar.id='host-test-controls';bar.style='position:fixed;z-index:2147483647;top:0;right:0;width:160px;height:32px;background:#123';document.body.appendChild(bar);const body=getComputedStyle(document.body);const top=document.elementFromPoint(innerWidth-10,10);const modelSelect=document.querySelector('.ai-model-picker select');return{title:document.title,api:Boolean(window.pluginAPI||window.aiAPI),scrollX:document.documentElement.scrollWidth-document.documentElement.clientWidth,scrollY:document.documentElement.scrollHeight-document.documentElement.clientHeight,paddingTop:body.paddingTop,hostTop:top?.id||'',layout:document.documentElement.dataset.layout,modelOptions:modelSelect?.options.length||0,providerGroups:modelSelect?.querySelectorAll('optgroup').length||0,modelValue:modelSelect?.value||'',openCodeImport:Boolean(document.querySelector('[data-ai-opencode]'))}})()`);
  const expectedGroups=plugin.type==='ai'?(plugin.id==='ai-image'?1:2):0;
  const expectedModel=plugin.id==='ai-image'?'glm-4v-plus':'deepseek-chat';
  win.destroy();if(errors.length||!state.api||state.scrollX>1||state.scrollY>1||state.paddingTop!=='32px'||state.hostTop!=='host-test-controls'||state.title!==plugin.name||(plugin.type==='ai'&&(state.modelOptions<1||state.providerGroups!==expectedGroups||!state.modelValue.includes(expectedModel)||!state.openCodeImport)))throw new Error(`${plugin.id}@${width}x${height}: ${JSON.stringify({state,errors})}`);
  cases.push({plugin:plugin.id,width,height,success:true});
}

async function inspectCommanderDelegation(){
  const directory=path.join(__dirname,'..','app','software','sanrenjz.tools-ai');
  const win=new BrowserWindow({show:false,x:-32000,y:-32000,width:1180,height:760,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  await win.loadFile(path.join(directory,'index.html'));
  await new Promise(resolve=>setTimeout(resolve,150));
  commanderDispatches.length=0;
  const uiState=await win.webContents.executeJavaScript(`(async()=>{
    const input=document.getElementById('promptInput');
    input.value='我需要将图片改成ico，调用插件';
    await sendMessage();
    const localCard=document.querySelector('.delegate-card');
    const localStatus=localCard?.querySelector(':scope>div:nth-child(2)')?.textContent||'';
    document.getElementById('chatContainer').innerHTML='';
    input.value='会议总结：项目已完成验收，下周开始上线准备。';
    await sendMessage();
    const openButton=document.querySelector('.delegate-card .delegate-actions button:nth-child(2)');
    if(!openButton)throw new Error('未生成总指挥派发卡片');
    openButton.click();
    await new Promise(resolve=>setTimeout(resolve,50));
    return{localStatus,buttonText:openButton.textContent,status:document.querySelector('.delegate-card>div:nth-child(2)')?.textContent||''};
  })()`);
  win.destroy();

  assert.strictEqual(commanderDispatches.length,3,'本地工具、AI 首次派发和再次打开应各产生一次 IPC');
  assert.strictEqual(commanderDispatches[0].action.feature.code,'plugin-market-image-converter');
  assert.strictEqual(commanderDispatches[0].action.feature.args.autoRun,false,'普通本地工具只打开功能，不自动执行');
  assert.ok(commanderDispatches[0].action.pluginPath.endsWith(path.join('app','software','sanrenjz-tools-image-optimizer')));
  assert.strictEqual(commanderDispatches[1].action.feature.code,'plugin-market-ai-meeting');
  assert.strictEqual(commanderDispatches[1].action.feature.args.autoRun,true,'首次派发必须自动执行会议总结');
  assert.strictEqual(commanderDispatches[2].action.feature.args.autoRun,false,'再次打开不得重复调用模型');
  assert.ok(commanderDispatches[1].action.pluginPath.endsWith(path.join('app','software','sanrenjz-tools-ai-meeting')));
  assert.ok(commanderDispatches[1].clipboardText.includes('会议总结'));
  assert.ok(uiState.localStatus.includes('格式转换'));
  assert.strictEqual(uiState.buttonText,'打开插件');
  assert.ok(uiState.status.includes('未重复调用模型'));
}

async function inspectAssistantHistory(){
  const directory=path.join(__dirname,'..','app','software','sanrenjz.tools-ai');
  const win=new BrowserWindow({show:false,x:-32000,y:-32000,width:1180,height:760,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  const errors=[];
  win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)});
  await win.loadFile(path.join(directory,'index.html'));
  await new Promise(resolve=>setTimeout(resolve,150));
  const state=await win.webContents.executeJavaScript(`(async()=>{
    window.services.callAPI=async()=>new ReadableStream({start(controller){controller.enqueue('测试回复');controller.close()}});
    document.getElementById('promptInput').value='测试一个不会触发插件的普通问题';
    await sendMessage(true);
    const actions=[...document.querySelectorAll('.message')].map(node=>[...node.querySelectorAll('.message-actions button')].map(button=>({label:button.getAttribute('aria-label'),text:button.textContent,icon:Boolean(button.querySelector('svg'))})));
    const saved=window.services.getConversations();
    newChat();
    await showChatHistory();
    const historyRows=document.querySelectorAll('#historyList .history-item').length;
    document.querySelector('#historyList .history-open').click();
    const restored=document.querySelectorAll('.message').length;
    document.querySelector('.ai-message .withdraw-button').click();
    const afterWithdraw=window.services.getConversations().find(item=>item.id===saved.at(-1).id)?.messages.length;
    return{actions,savedCount:saved.at(-1)?.messages.length,historyRows,restored,afterWithdraw};
  })()`);
  win.destroy();
  assert.deepStrictEqual(errors,[],'助手聊天和历史页面不应有渲染错误');
  assert.deepStrictEqual(state.actions,Array(2).fill([{label:'复制消息',text:'',icon:true},{label:'撤回消息',text:'',icon:true}]));
  assert.strictEqual(state.savedCount,2,'发送后应自动保存用户消息和回复');
  assert.ok(state.historyRows>=1,'历史记录应显示自动保存的会话');
  assert.strictEqual(state.restored,2,'点击历史记录应恢复聊天气泡');
  assert.strictEqual(state.afterWithdraw,1,'撤回应同步更新保存的上下文');
  const reopened=new BrowserWindow({show:false,x:-32000,y:-32000,width:1180,height:760,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  await reopened.loadFile(path.join(directory,'index.html'));
  await new Promise(resolve=>setTimeout(resolve,150));
  const reopenedState=await reopened.webContents.executeJavaScript(`(async()=>{await showChatHistory();const row=document.querySelector('#historyList .history-open');row?.click();return{rows:document.querySelectorAll('#historyList .history-item').length,messages:document.querySelectorAll('.message').length}})()`);
  reopened.destroy();
  assert.ok(reopenedState.rows>=1,'重开窗口后仍应看到已保存记录');
  assert.strictEqual(reopenedState.messages,1,'重开后应读取撤回后的记录');
}

async function inspectAssistantHistoryManagement(){
  const directory=path.join(__dirname,'..','app','software','sanrenjz.tools-ai');
  const exportDir=fs.mkdtempSync(path.join(os.tmpdir(),'sanrenjz-ai-history-'));
  memory.set('余汉波AI助手:conversations-v1',[]);
  let win;
  try{
    win=new BrowserWindow({show:false,x:-32000,y:-32000,width:900,height:650,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
    await win.loadFile(path.join(directory,'index.html'));
    const state=await win.webContents.executeJavaScript(`(async()=>{
      // 冒烟测试仍验证真实导出文件，但不向用户桌面发送系统通知。
      const notifications=[];
      window.services.showNotification=message=>notifications.push(message);
      const settings=window.services.getSettings();settings.savePath=${JSON.stringify(exportDir)};window.services.saveSettings(settings);
      addMessage('第一条项目会议',true);addMessage('总结完成',false);
      newChat();addMessage('第二条预算讨论',true);addMessage('预算回复',false);
      const currentId=currentConversationId;
      const unsavedExports=await window.services.getChatHistory();
      await saveChatToFile();
      await showChatHistory();
      const initialRows=document.querySelectorAll('#historyList .history-item').length;
      const modalRect=document.querySelector('#historyModal .modal-content').getBoundingClientRect();
      const modalFits=modalRect.top>=0&&modalRect.bottom<=innerHeight&&modalRect.left>=0&&modalRect.right<=innerWidth;
      document.getElementById('historySearch').value='总结完成';renderHistoryList();
      const bodySearchRows=document.querySelectorAll('#historyList .history-item').length;
      document.getElementById('historySearch').value='预算';renderHistoryList();
      const selectedId=document.querySelector('#historyList .history-item')?.dataset.conversationId;
      window.confirm=()=>false;
      await document.querySelector('#historyList .history-delete').onclick();
      const afterCancel=window.services.getConversations().length;
      window.confirm=()=>true;
      await document.querySelector('#historyList .history-delete').onclick();
      const afterDelete=window.services.getConversations().length;
      const currentMessages=document.querySelectorAll('.message').length;
      document.getElementById('historySearch').value='第一条';renderHistoryList();
      const remainingRows=document.querySelectorAll('#historyList .history-item').length;
      await clearAllHistory();
      await showChatHistory();
      const emptyRows=document.querySelectorAll('#historyList .history-item').length;
      const exported=await window.services.getChatHistory();
      window.services.chooseChatExport=()=>exported[0].path;
      await importExportedChat();
      return{initialRows,modalFits,bodySearchRows,selectedId,currentId,unsavedExportCount:unsavedExports.length,afterCancel,afterDelete,currentMessages,
        remainingRows,afterClear:window.services.getConversations().length,
        emptyRows,exportedCount:exported.length,importedMessages:document.querySelectorAll('.message').length,notifications};
    })()`);
    assert.strictEqual(state.initialRows,2,'历史记录只显示插件缓存，不混入 Markdown 导出');
    assert.strictEqual(state.unsavedExportCount,0,'未点击保存对话时即使配置了导出目录也不应生成 Markdown');
    assert.ok(state.modalFits,'900×650 窗口内历史管理弹窗应完整可见');
    assert.strictEqual(state.bodySearchRows,1,'搜索应匹配回复正文');
    assert.strictEqual(state.selectedId,state.currentId,'搜索应命中当前对话');
    assert.strictEqual(state.afterCancel,2,'取消删除不应修改缓存');
    assert.strictEqual(state.afterDelete,1,'单条删除应从插件缓存移除对话');
    assert.strictEqual(state.currentMessages,0,'删除当前对话后不应保留可被再次自动保存的气泡');
    assert.strictEqual(state.remainingRows,1,'删除后搜索结果应立即更新');
    assert.strictEqual(state.afterClear,0,'清空应移除全部缓存记录');
    assert.strictEqual(state.emptyRows,0,'清空后重开历史列表也不应显示导出文件');
    assert.strictEqual(state.exportedCount,1,'删除和清空缓存不应删除 Markdown 导出文件');
    assert.strictEqual(state.importedMessages,2,'导出文件应仍可通过独立入口打开');
    assert.strictEqual(state.notifications.length,1,'手动导出测试应仅产生一次被拦截的通知');
    assert.ok(state.notifications[0].startsWith('对话已手动导出为 Markdown:'),'导出通知文案应正确');
    assert.strictEqual(fs.readdirSync(exportDir).filter(name=>name.endsWith('.md')).length,1);
  }finally{
    win?.destroy();
    const resolved=path.resolve(exportDir),tempRoot=path.resolve(os.tmpdir())+path.sep;
    if(resolved.startsWith(tempRoot)&&path.basename(resolved).startsWith('sanrenjz-ai-history-'))fs.rmSync(resolved,{recursive:true,force:true});
  }
}

async function inspectJevEveryQuestion(){
  const directory=path.join(__dirname,'..','app','software','sanrenjz.tools-ai');
  const win=new BrowserWindow({show:false,x:-32000,y:-32000,width:1180,height:760,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  await win.loadFile(path.join(directory,'index.html'));
  await new Promise(resolve=>setTimeout(resolve,150));
  commanderDispatches.length=0;
  const state=await win.webContents.executeJavaScript(`(async()=>{
    const settings=window.services.getSettings();settings.commanderEnabled=false;settings.jevProvider='typesafe';window.services.saveSettings(settings);
    const calls=[];let llmCalls=0;
    window.services.decideCommanderRoute=async(message,plugins)=>{
      calls.push({message,plugins:plugins.length});
      if(message.includes('ico'))return{kind:'local',name:'图片优化器',folder:'sanrenjz-tools-image-optimizer',feature:'plugin-market-image-converter',autoRun:false};
      return null;
    };
    window.services.callAPI=async()=>{llmCalls++;return new ReadableStream({start(controller){controller.enqueue('测试回复');controller.close()}})};
    const input=document.getElementById('promptInput');
    input.value='我需要将图片改成ico，调用插件';await sendMessage();
    input.value='写首诗';await sendMessage();
    input.value='打开图片生成插件';await sendMessage();
    return{calls,llmCalls,notices:[...document.querySelectorAll('.delegate-card')].map(x=>x.textContent)};
  })()`);
  win.destroy();
  assert.strictEqual(state.calls.length,3,'启用 Jev 后每条文本问题都必须先经过 Jev，即使旧的本地查找开关为关闭状态');
  assert.ok(state.calls.every(item=>item.plugins>=30),'Jev 应读取当前已安装插件目录');
  assert.strictEqual(commanderDispatches.length,1,'只有 Jev 选中的真实插件才应打开');
  assert.strictEqual(commanderDispatches[0].action.feature.args.autoRun,false);
  assert.strictEqual(state.llmCalls,2,'写诗和无匹配图片生成插件应交给当前 LLM');
  assert.ok(state.notices.some(text=>text.includes('未选出可打开的已安装插件')),'无匹配插件时应明确提示而非假称打开');
}

async function inspectOpenCodeImport(){
  const plugin=catalog.find(item=>item.type==='ai');
  const directory=path.join(__dirname,'..','app','software',plugin.folder);
  const win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
  await win.loadFile(path.join(directory,'index.html'));
  await new Promise(resolve=>setTimeout(resolve,100));
  await win.webContents.executeJavaScript(`document.querySelector('[data-ai-opencode]').click()`);
  await new Promise(resolve=>setTimeout(resolve,150));
  win.destroy();
  const config=memory.get('AI 共享配置中心:runtime-config');
  const imported=config.providers.find(provider=>provider.id==='opencode:openai');
  assert.ok(imported,'供应商设置应保存 OpenCode 导入结果');
  assert.strictEqual(imported.sourceProviderId,'openai');
  assert.strictEqual(imported.models[0].sourceModelId,'gpt-codex');
}

async function inspectPersistentPluginLayout(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tools-persistent-plugin-'));
  try{
    const plugin=catalog.find(item=>item.type==='ai');
    const source=path.join(__dirname,'..','app','software',plugin.folder);
    const directory=path.join(root,'plugins',plugin.folder);
    fs.cpSync(source,directory,{recursive:true});
    fs.cpSync(path.join(__dirname,'..','app','plugin_runtime'),path.join(root,'plugin_runtime'),{recursive:true});
    const errors=[];
    const win=new BrowserWindow({show:false,width:1180,height:760,webPreferences:{preload:path.join(directory,'preload.js'),nodeIntegration:true,contextIsolation:false,webSecurity:false}});
    win.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message)});
    await win.loadFile(path.join(directory,'index.html'));
    await new Promise(resolve=>setTimeout(resolve,120));
    const state=await win.webContents.executeJavaScript(`({api:Boolean(window.aiAPI),openCodeImport:Boolean(document.querySelector('[data-ai-opencode]')),modelOptions:document.querySelector('.ai-model-picker select')?.options.length||0})`);
    win.destroy();
    assert.deepStrictEqual(errors,[],'持久化插件目录不应出现共享运行时加载错误');
    assert.strictEqual(state.api,true);
    assert.strictEqual(state.openCodeImport,true);
    assert.ok(state.modelOptions>0);
  }finally{
    fs.rmSync(root,{recursive:true,force:true});
  }
}

app.whenReady().then(async()=>{try{
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  for(const plugin of catalog){for(const [w,h] of [[900,650],[1180,760],[1440,900]])await inspect(plugin,w,h)}
  for(const [name,check] of [['commander-delegation',inspectCommanderDelegation],['assistant-history',inspectAssistantHistory],['assistant-history-management',inspectAssistantHistoryManagement],['jev-every-question',inspectJevEveryQuestion],['opencode-import',inspectOpenCodeImport],['persistent-plugin-layout',inspectPersistentPluginLayout]]){await check();cases.push({name,success:true})}
  console.log(`Electron smoke passed: ${catalog.length} plugins x 3 window sizes + commander delegation + assistant history management + Jev every question + OpenCode import + persistent plugin layout`);finish(true)
}catch(error){console.error(error);finish(false,error)}});
