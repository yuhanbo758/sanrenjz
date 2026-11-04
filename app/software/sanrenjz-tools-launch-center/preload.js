const { contextBridge, ipcRenderer, shell } = require('electron');
const fs = require('fs');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const projectService = require('./project-service');
const PLUGIN_NAME="启动中心", TOOLS=["bookmark-launcher","project-launcher"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,project:{start:projectService.start,stop:projectService.stop,status:projectService.snapshot,clearLogs:projectService.clearLogs,openDirectory:directory=>{if(!fs.existsSync(directory)||!fs.statSync(directory).isDirectory())throw new Error('项目目录不存在');return shell.openPath(directory);}},migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['书签启动器','项目启动器'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-bookmark-launcher':{mode:'none',args:{enter:action=>dispatch('bookmark-launcher',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-project-launcher':{mode:'none',args:{enter:action=>dispatch('project-launcher',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',()=>{projectService.stopAll();disposeToolRuntime();});
