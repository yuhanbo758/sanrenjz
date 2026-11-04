const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const PLUGIN_NAME="图片悬浮板", TOOLS=["image-pinboard"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,
  readImageFile(filePath){
    const extension=path.extname(filePath).toLowerCase();
    const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.bmp':'image/bmp','.gif':'image/gif'}[extension];
    if(!mime)throw new Error('不支持此图片格式');
    if(fs.statSync(filePath).size>20*1024*1024)throw new Error('图片不能超过 20 MB');
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  },
  copyImage:dataUrl=>clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)),
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['图片悬浮板'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-image-pinboard':{mode:'none',args:{enter:action=>dispatch('image-pinboard',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
