const { contextBridge, ipcRenderer } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const transfer = require('./transfer-service');
const PLUGIN_NAME="局域网快传", TOOLS=["lan-transfer"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,transfer:{start:transfer.start,stop:transfer.stop,status:transfer.status,shareText:transfer.shareText,shareFiles:transfer.shareFiles,removeShare:transfer.removeShare},migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['局域网快传'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-lan-transfer':{mode:'none',args:{enter:action=>dispatch('lan-transfer',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',()=>{transfer.stop().catch(()=>{});disposeToolRuntime();});
