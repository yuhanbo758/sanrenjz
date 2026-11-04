const { contextBridge, ipcRenderer } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const pdfService = require('./pdf-service');
const PLUGIN_NAME="PDF 页面工作台", TOOLS=["pdf-organizer"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,inspectPdf:pdfService.inspectPdf,previewPdf:pdfService.buildPlan,savePdf:pdfService.savePdf,migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['PDF 页面整理'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-pdf-organizer':{mode:'none',args:{enter:action=>dispatch('pdf-organizer',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
