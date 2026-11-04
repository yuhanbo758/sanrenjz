const { contextBridge, ipcRenderer } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const path = require('node:path');
const { createHostsService, inspect } = require('./hosts-service');
const PLUGIN_NAME="Hosts 配置中心", TOOLS=["hosts-manager"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
let service;
async function hostsService(){
  if(!service){const dataDir=await ipcRenderer.invoke('get-plugin-data-directory');service=createHostsService({backupDir:path.join(dataDir,'hosts-center-backups')});}
  return service;
}
const safeCore={...core};delete safeCore.runTask;
const api={...safeCore,
  inspectHosts:inspect,
  readHosts:async()=>({ok:true,result:await(await hostsService()).read()}),
  writeHosts:async payload=>({ok:true,result:await(await hostsService()).write(payload)}),
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['Hosts 配置管家'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-hosts-manager':{mode:'none',args:{enter:action=>dispatch('hosts-manager',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
