const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const PLUGIN_NAME="二维码与条码工具", TOOLS=["qr-barcode"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,
  generateQrAdvanced:async(text,options)=>{
    try {
      const QRCode=require('qrcode');
      const safe={width:Math.max(160,Math.min(1600,Number(options.size)||360)),margin:Math.max(1,Math.min(8,Number(options.margin)||2)),errorCorrectionLevel:['L','M','Q','H'].includes(options.level)?options.level:'M',color:{dark:options.dark+'FF',light:options.light+'FF'}};
      return {ok:true,dataUrl:await QRCode.toDataURL(String(text),safe),svg:await QRCode.toString(String(text),{...safe,type:'svg'})};
    } catch(error){return {ok:false,error:error.message};}
  },
  copyImage:dataUrl=>{const image=nativeImage.createFromDataURL(dataUrl);if(image.isEmpty())throw new Error('没有可复制的图片');clipboard.writeImage(image);},
  readImageFile:filePath=>{const extension=path.extname(filePath).toLowerCase();const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.bmp':'image/bmp'}[extension];if(!mime)throw new Error('不支持的图片格式');const stat=fs.statSync(filePath);if(stat.size>20*1024*1024)throw new Error('图片不能超过 20 MB');return 'data:'+mime+';base64,'+fs.readFileSync(filePath).toString('base64');},
  decodeBarcode:async dataUrl=>{const ZXing=require('./vendor/zxing.min.js');const image=new Image();image.src=dataUrl;await image.decode();const reader=new ZXing.BrowserMultiFormatReader();const result=await reader.decodeFromImageElement(image);return {text:result.getText(),format:ZXing.BarcodeFormat[result.getBarcodeFormat()]};},
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['二维码与条码工具'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-qr-barcode':{mode:'none',args:{enter:action=>dispatch('qr-barcode',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
