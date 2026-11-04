'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net');
const {app,BrowserWindow,ipcMain,session,safeStorage}=require('electron'),{WebSocket}=require('ws');
const {RemoteService}=require('../app/remote/service'),{CastPluginLoader}=require('../app/remote/cast-plugin-loader');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  await app.whenReady();const root=fs.mkdtempSync(path.join(os.tmpdir(),'sanren-no-cast-')),source=path.resolve(__dirname,'..'),storage=new Map();
  const pluginDir=path.join(root,'plugins'),codeFolder='sanrenjz-tools-code-security';fs.mkdirSync(path.join(pluginDir,codeFolder),{recursive:true});fs.copyFileSync(path.join(source,'app/software',codeFolder,'plugin.json'),path.join(pluginDir,codeFolder,'plugin.json'));
  const reserve=net.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  let settings={remoteControl:{enabled:true,port}};
  const manager={pluginDir,pluginWindows:new Map(),getPluginStorageItem:(name,key)=>storage.get(name+':'+key),setPluginStorageItem:(name,key,value)=>storage.set(name+':'+key,value)};
  ipcMain.handle('plugin-storage-get-async',(_e,name,key)=>manager.getPluginStorageItem(name,key));ipcMain.handle('plugin-storage-set-async',(_e,name,key,value)=>manager.setPluginStorageItem(name,key,value));
  const remote=new RemoteService({app:{getPath:()=>root,getAppPath:()=>source,getVersion:()=>app.getVersion()},BrowserWindow,ipcMain,session,safeStorage,manager,loadSettings:()=>settings,saveSettings:value=>{settings=value}});remote.castPlugins=new CastPluginLoader(remote);
  let socket;
  try{
    await remote.start();assert(remote.status().running);assert.strictEqual(await remote.castPlugins.refresh(),null);
    remote.identity.devices.push({id:'test-device',name:'回环验收设备',token:'temporary-test-token'});
    socket=new WebSocket(`wss://127.0.0.1:${port}/ws`,{rejectUnauthorized:false});await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
    socket.send(JSON.stringify({type:'hello',deviceId:'test-device',token:'temporary-test-token'}));
    for(let i=0;i<50&&!remote.client;i++)await pause(50);assert(remote.client);
    assert.strictEqual((await remote.dispatch('cast-status',{})).installed,false);
    assert((await remote.dispatch('chat-tools',{})).some(tool=>tool.id==='id-generator'));
    const task=await remote.dispatch('chat',{text:'生成 2 个 UUID'});
    for(let i=0;i<100&&!['done','failed'].includes(remote.chat.tasks.get(task.id).state);i++)await pause(100);
    const result=remote.chat.tasks.get(task.id);assert.strictEqual(result.state,'done',result.error);assert((result.reply.match(/[a-f0-9]{8}-[a-f0-9-]{27,}/g)||[]).length===2);
    console.log('REMOTE_WITHOUT_CAST_PASS: 未安装投放插件时真实 Electron 服务启动、WSS 认证、聊天目录及隐藏执行器 UUID 回复通过；使用回环网络，不代表手机新版本验收');
  }finally{socket?.terminate();remote.castPlugins.close();await remote.stop();fs.rmSync(root,{recursive:true,force:true});}
})().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)});
