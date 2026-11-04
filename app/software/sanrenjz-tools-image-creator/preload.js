const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const PLUGIN_NAME="图片创作台", TOOLS=["image-watermark","image-collage","screenshot-beautifier"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['图片水印','图片拼接','截图美化器'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;},
  saveCanvasImage({dataUrl,format}){
    const extensions={png:'png',jpeg:'jpg',webp:'webp'};
    if(!Object.hasOwn(extensions,format))throw new Error('不支持的导出格式');
    const prefix=`data:image/${format};base64,`;
    if(typeof dataUrl!=='string'||!dataUrl.startsWith(prefix))throw new Error('浏览器未生成所选格式');
    const bytes=Buffer.from(dataUrl.slice(prefix.length),'base64');
    const valid=format==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
      format==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
      bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
    if(!valid)throw new Error('图片实际编码与选择的格式不一致');
    const extension=extensions[format];
    const target=core.chooseSavePath({title:'保存图片',defaultPath:`创作结果.${extension}`,filters:[{name:format.toUpperCase(),extensions:[extension]}]});
    if(!target)return {cancelled:true};
    if(path.extname(target).toLowerCase()!==`.${extension}`)throw new Error(`保存路径必须以 .${extension} 结尾`);
    fs.writeFileSync(target,bytes);
    return {cancelled:false,path:target};
  }};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-image-watermark':{mode:'none',args:{enter:action=>dispatch('image-watermark',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-image-collage':{mode:'none',args:{enter:action=>dispatch('image-collage',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-screenshot-beautifier':{mode:'none',args:{enter:action=>dispatch('screenshot-beautifier',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
