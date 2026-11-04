const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const batch = require('./batch-service');
const PLUGIN_NAME="文件批处理中心", TOOLS=["batch-renamer","file-checksum"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,batch:{
  droppedPaths:files=>Array.from(files||[],file=>webUtils?.getPathForFile?.(file)||file.path||'').filter(Boolean),
  collect:(paths,recursive)=>batch.collect(paths,recursive),
  planRename:(files,options)=>batch.planRename(files,options),
  executeRename:plan=>batch.executeRename(plan),
  checksum:files=>batch.checksum(files)
},migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['批量重命名','文件校验器'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-batch-renamer':{mode:'none',args:{enter:action=>dispatch('batch-renamer',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-file-checksum':{mode:'none',args:{enter:action=>dispatch('file-checksum',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
