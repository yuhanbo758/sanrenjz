const { contextBridge, ipcRenderer, shell, webUtils } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const archive = require('./archive-service');
const fs = require('fs');
const path = require('path');
const PLUGIN_NAME="压缩包工作台", TOOLS=["archive-tool"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,
  archive:{
    inspect:file=>archive.inspect(file),
    extract:(file,dir,names,skip)=>archive.extract(file,dir,names,skip),
    create:(files,out,level)=>archive.create(files,out,level),
    sourceInfo:files=>archive.collectSources(files),
    isDirectory:file=>fs.statSync(file).isDirectory(),
    joinOutput:(dir,name)=>path.join(dir,name),
    droppedPaths:files=>Array.from(files||[],file=>webUtils?.getPathForFile?.(file)||file.path||'').filter(Boolean),
    openFolder:dir=>shell.openPath(dir)
  },
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['压缩包工具'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-archive-tool':{mode:'none',args:{enter:action=>dispatch('archive-tool',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
