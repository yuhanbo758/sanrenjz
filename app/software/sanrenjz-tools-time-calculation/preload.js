const { contextBridge, ipcRenderer } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const timeTools = require('./time-core');
const { checkClock } = require('./clock-sync');
const PLUGIN_NAME="时间与计算中心", TOOLS=["time-converter","date-world-clock","unit-converter","calculation-paper"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,timeTools,checkClock:()=>checkClock(),migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['时间转换器','日期与世界时钟','单位换算器','计算稿纸'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-time-converter':{mode:'none',args:{enter:action=>dispatch('time-converter',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-date-world-clock':{mode:'none',args:{enter:action=>dispatch('date-world-clock',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-unit-converter':{mode:'none',args:{enter:action=>dispatch('unit-converter',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-calculation-paper':{mode:'none',args:{enter:action=>dispatch('calculation-paper',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
