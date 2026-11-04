const { contextBridge, ipcRenderer } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const securityTools = require('./security-tools');
const PLUGIN_NAME="编码与安全工具箱", TOOLS=["codec-assistant","hash-hmac","jwt-inspector","id-generator"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,
  transformText:securityTools.transformText,
  hashText:securityTools.hashText,
  hashFile:securityTools.hashFile,
  loadTextFile:securityTools.loadTextFile,
  encodeFileBase64:securityTools.encodeFileBase64,
  generateIds:securityTools.generateIds,
  selectFile:()=>ipcRenderer.sendSync('show-open-dialog',{properties:['openFile']}),
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['编解码助手','哈希与 HMAC','JWT 检查器','ID 生成器'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-codec-assistant':{mode:'none',args:{enter:action=>dispatch('codec-assistant',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-hash-hmac':{mode:'none',args:{enter:action=>dispatch('hash-hmac',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-jwt-inspector':{mode:'none',args:{enter:action=>dispatch('jwt-inspector',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-id-generator':{mode:'none',args:{enter:action=>dispatch('id-generator',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
