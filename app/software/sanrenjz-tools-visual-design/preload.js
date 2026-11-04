const { contextBridge, ipcRenderer, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const PLUGIN_NAME="视觉设计实验室", TOOLS=["palette-extractor","color-workbench","svg-workbench"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
function extractPalette({ filePath, dataUrl, count = 8 } = {}) {
  if (!filePath && !dataUrl) throw new Error('请先选择图片');
  if (filePath) {
    if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(path.extname(filePath).toLowerCase())) throw new Error('不支持的图片格式');
    if (fs.statSync(filePath).size > 30 * 1024 * 1024) throw new Error('图片不能超过 30 MB');
  }
  const image = filePath ? nativeImage.createFromPath(filePath) : nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error('无法解码图片');
  const size = image.getSize();
  if (size.width * size.height > 80000000) throw new Error('图片尺寸过大');
  const sample = image.resize({ width: Math.min(120, size.width), height: Math.min(120, size.height), quality: 'good' });
  const pixels = sample.toBitmap();
  const bins = new Map();
  // 对通道量化后计数，并忽略透明像素；避免逐像素精确颜色让照片噪声占满色板。
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const b = pixels[i], g = pixels[i + 1], r = pixels[i + 2];
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bin = bins.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bin.count++; bin.r += r; bin.g += g; bin.b += b; bins.set(key, bin);
  }
  const limit = Math.max(1, Math.min(12, Number(count) || 8));
  const selected = [];
  for (const bin of [...bins.values()].sort((a, b) => b.count - a.count)) {
    const rgb = [bin.r, bin.g, bin.b].map(value => Math.round(value / bin.count));
    if (selected.some(item => item.rgb.every((value, index) => Math.abs(value - rgb[index]) < 20))) continue;
    selected.push({ rgb, hex: '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase(), count: bin.count });
    if (selected.length >= limit) break;
  }
  if (!selected.length) throw new Error('图片没有可提取的不透明颜色');
  return { colors: selected, width: size.width, height: size.height };
}
function readSvgFile(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.svg') throw new Error('请选择 SVG 文件');
  if (fs.statSync(filePath).size > 2 * 1024 * 1024) throw new Error('SVG 文件不能超过 2 MB');
  return fs.readFileSync(filePath, 'utf8');
}
function imagePreview(filePath) {
  const image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) throw new Error('无法预览图片');
  const size = image.getSize();
  const scale = Math.min(1, 900 / Math.max(size.width, size.height));
  return image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }).toDataURL();
}
const api={...core,extractPalette,readSvgFile,imagePreview,migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['色板提取器','颜色工作台','SVG 工作台'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-palette-extractor':{mode:'none',args:{enter:action=>dispatch('palette-extractor',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-color-workbench':{mode:'none',args:{enter:action=>dispatch('color-workbench',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-svg-workbench':{mode:'none',args:{enter:action=>dispatch('svg-workbench',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
