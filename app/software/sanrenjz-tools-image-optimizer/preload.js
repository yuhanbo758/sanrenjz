const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const PLUGIN_NAME="图片优化器", TOOLS=["image-compressor","image-converter","image-resizer"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const OUTPUT_EXTENSIONS={png:new Set(['.png']),jpg:new Set(['.jpg','.jpeg']),webp:new Set(['.webp']),bmp:new Set(['.bmp']),ico:new Set(['.ico'])};
function detectImageFormat(data){
  if(data.length>=8&&data.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'png';
  if(data.length>=3&&data[0]===0xff&&data[1]===0xd8&&data[2]===0xff)return 'jpg';
  if(data.length>=12&&data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP')return 'webp';
  if(data.length>=2&&data.subarray(0,2).toString('ascii')==='BM')return 'bmp';
  if(data.length>=4&&data.readUInt16LE(0)===0&&data.readUInt16LE(2)===1)return 'ico';
  return '';
}
const api={...core,
  readFileDataUrl:(filePath)=>{
    const extension=path.extname(filePath).slice(1).toLowerCase();
    const mime={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',bmp:'image/bmp',gif:'image/gif',ico:'image/x-icon'}[extension];
    if(!mime)throw new Error('不支持的图片格式');
    if(fs.statSync(filePath).size>50*1024*1024)throw new Error('单张图片不能超过 50 MB');
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  },
  writeImageFile:async(filePath,bytes,format,options={})=>{
    const target=path.resolve(String(filePath||''));
    const expected=String(format||'').toLowerCase();
    if(!OUTPUT_EXTENSIONS[expected])throw new Error('不支持的输出格式');
    const extension=path.extname(target).toLowerCase();
    if(!OUTPUT_EXTENSIONS[expected].has(extension))throw new Error(`保存扩展名必须是 ${[...OUTPUT_EXTENSIONS[expected]].join(' 或 ')}`);
    const data=Buffer.from(bytes);
    if(!data.length||data.length>256*1024*1024)throw new Error('图片数据无效或过大');
    const actual=detectImageFormat(data);
    if(actual!==expected)throw new Error(`格式转换失败：编码结果为 ${actual||'未知格式'}，目标格式为 ${expected}`);
    await fs.promises.writeFile(target,data,{flag:options.noOverwrite?'wx':'w'});
    return {path:target,bytes:data.length,format:actual};
  },
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['图片压缩器','图片格式转换','图片尺寸调整'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}
};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-image-compressor':{mode:'none',args:{enter:action=>dispatch('image-compressor',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-image-converter':{mode:'none',args:{enter:action=>dispatch('image-converter',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-image-resizer':{mode:'none',args:{enter:action=>dispatch('image-resizer',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
