const { contextBridge, ipcRenderer } = require('electron');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const fs = require('fs');
const path = require('path');
const { runJson } = require('./json-tools');
const PLUGIN_NAME="结构化数据工作台", TOOLS=["json-workbench","config-converter","xml-workbench"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
// 共享转换器只解析简单配置；遇到会被静默丢失的语法时直接报错。
function checkConfigSubset(input,options){
  const source=options.source||'json',target=options.target||'yaml';
  if(source==='yaml'&&input.split(/\r?\n/).some(line=>{const trimmed=line.trim();return trimmed&&!trimmed.startsWith('#')&&(!/^[^\s:#][^:#]*:\s*/.test(line)||/[&*][\w-]+|^---|:\s*[>|]/.test(line));}))throw new Error('当前 YAML 转换仅支持顶层键值，不支持嵌套、列表、引用或多行块');
  if(source==='toml'&&input.split(/\r?\n/).some(line=>{const trimmed=line.trim();return trimmed&&!trimmed.startsWith('#')&&(!/^\[[^\[\]]+\]$|^[^=\s][^=]*=/.test(trimmed)||/^\[\[|=\s*[\[{]/.test(trimmed));}))throw new Error('当前 TOML 转换不支持表数组、数组或内联表');
  if(source==='json'&&['yaml','toml','properties'].includes(target)){
    const value=JSON.parse(input);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置转换需要顶层对象');
    if(target==='yaml'&&Object.values(value).some(item=>item===null||typeof item==='object'||typeof item==='string'&&(/^(true|false|-?\d+(\.\d+)?)$/i.test(item)||item.includes('\n'))))throw new Error('当前 YAML 输出仅支持无歧义的顶层标量键值');
    if(target==='toml'&&Object.values(value).some(item=>item===null))throw new Error('当前 TOML 输出不支持 null 值');
    if(target==='properties'&&Object.values(value).some(item=>item!==null&&typeof item==='object'))throw new Error('Properties 输出仅支持标量键值');
  }
}
const api={...core,
  async runTask(payload){
    if(payload?.toolId==='json-workbench'){
      try { return {ok:true,...runJson(String(payload.input||''),payload.options||{})}; }
      catch(error){ return {ok:false,error:error.message}; }
    }
    if(payload?.toolId==='config-converter'){
      try{checkConfigSubset(String(payload.input||''),payload.options||{});}catch(error){return {ok:false,error:error.message};}
    }
    return core.runTask(payload);
  },
  importText(){
    const files=core.selectFiles({multiple:false,title:'导入结构化数据',filters:[{name:'文本数据',extensions:['json','jsonl','xml','yaml','yml','toml','properties','txt']}]});
    const selected=files?.[0];
    if(!selected)return {cancelled:true};
    if(fs.statSync(selected).size>5*1024*1024)throw new Error('文件超过 5 MB，请使用较小的文本文件');
    return {cancelled:false,name:path.basename(selected),text:fs.readFileSync(selected,'utf8')};
  },
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['JSON 工作台','配置格式转换','XML 工作台'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-json-workbench':{mode:'none',args:{enter:action=>dispatch('json-workbench',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-config-converter':{mode:'none',args:{enter:action=>dispatch('config-converter',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-xml-workbench':{mode:'none',args:{enter:action=>dispatch('xml-workbench',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
