const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const inspector = require('./inspector-service');
const PLUGIN_NAME="文件检查工作台", TOOLS=["file-content-search","folder-compare","directory-tree"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,inspector:{
  droppedPaths:files=>Array.from(files||[],file=>webUtils?.getPathForFile?.(file)||file.path||'').filter(Boolean),
  describePaths:paths=>inspector.normalizeRoots(paths),
  search:inspector.search,
  compare:inspector.compare,
  tree:inspector.tree
},migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['文件内容搜索','文件夹对比','目录树生成器'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-file-content-search':{mode:'none',args:{enter:action=>dispatch('file-content-search',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-folder-compare':{mode:'none',args:{enter:action=>dispatch('folder-compare',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-directory-tree':{mode:'none',args:{enter:action=>dispatch('directory-tree',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
