const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const textCore = require('./text-core');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const PLUGIN_NAME="文本工程实验室", TOOLS=["regex-lab","text-diff","line-processor","text-encoding"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt','.md','.markdown','.csv','.tsv','.json','.jsonl','.log','.xml','.html','.htm','.css','.js','.ts','.jsx','.tsx','.py','.java','.c','.cpp','.h','.sh','.ps1','.ini','.cfg','.conf','.yaml','.yml','.toml','.sql','.svg']);
function checkTextPath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('请选择本机文本文件');
  if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('仅支持常见纯文本文件，不支持文档或二进制文件');
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error('文件必须是 20 MB 以下的普通文本文件');
  return stat;
}
function decode(buffer, encoding) {
  if (!iconv.encodingExists(encoding)) throw new Error('不支持的文本编码');
  let text;
  try { text = encoding === 'utf8' ? new TextDecoder('utf-8', { fatal: true }).decode(buffer) : iconv.decode(buffer, encoding); }
  catch (error) { if (encoding === 'utf8') throw new Error('文件不是有效 UTF-8，请手动选择正确的导入编码'); throw error; }
  if (text.includes('\0')) throw new Error('文件包含 NUL 字节，可能不是纯文本');
  return text.replace(/^\uFEFF/, '');
}
const api={...core,
  textCore,
  readTextFile: async (filePath, encoding = 'utf8') => {
    checkTextPath(filePath);
    return { path: filePath, text: decode(await fs.promises.readFile(filePath), encoding) };
  },
  convertFiles: async (files, options = {}, execute = false) => {
    const suffix = String(options.suffix || '');
    if (!/^\.[^\\/:*?"<>|]{1,80}$/.test(suffix) || suffix === '.' || suffix === '..') throw new Error('后缀须以点开头，且不能包含路径或非法字符');
    if (!iconv.encodingExists(options.sourceEncoding) || !iconv.encodingExists(options.targetEncoding)) throw new Error('不支持的文本编码');
    const results = [];
    for (const filePath of [...new Set(files)].slice(0, 100)) {
      try {
        checkTextPath(filePath);
        let text = decode(await fs.promises.readFile(filePath), options.sourceEncoding);
        if (options.newline === 'lf') text = text.replace(/\r\n?/g, '\n');
        if (options.newline === 'crlf') text = text.replace(/\r?\n/g, '\r\n');
        const encoded = iconv.encode(text, options.targetEncoding);
        // 非 Unicode 目标编码可能静默把不可表示字符替换为问号，写入前先回读校验。
        if (iconv.decode(encoded, options.targetEncoding) !== text) throw new Error('目标编码无法无损表示全部字符，已跳过');
        const output = `${filePath}${suffix}`;
        const exists = fs.existsSync(output);
        if (execute && exists) throw new Error('目标文件已存在，已跳过以避免覆盖');
        if (execute) await fs.promises.writeFile(output, encoded, { flag: 'wx' });
        results.push({ source: filePath, output, characters: text.length, exists, status: execute ? 'written' : 'preview' });
      } catch (error) {
        results.push({ source: filePath, status: 'error', error: error.message });
      }
    }
    return results;
  },
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['正则实验室','文本差异对比','行处理器','文本编码转换'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-regex-lab':{mode:'none',args:{enter:action=>dispatch('regex-lab',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-text-diff':{mode:'none',args:{enter:action=>dispatch('text-diff',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-line-processor':{mode:'none',args:{enter:action=>dispatch('line-processor',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-text-encoding':{mode:'none',args:{enter:action=>dispatch('text-encoding',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
