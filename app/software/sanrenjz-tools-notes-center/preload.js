const { contextBridge, ipcRenderer, clipboard } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { createToolRuntime, disposeToolRuntime } = require('../../plugin_runtime/tool-runtime');
const PLUGIN_NAME="本地笔记中心", TOOLS=["markdown-notes","floating-notes"];
const core=createToolRuntime({pluginName:PLUGIN_NAME,defaultTool:TOOLS[0],allowedTools:TOOLS});
const api={...core,
  notes:{
    copy:text=>clipboard.writeText(String(text)),
    flushSync:(key,value)=>ipcRenderer.sendSync('plugin-storage-set',PLUGIN_NAME,key,value),
    importMarkdown:async()=>{
      const files=ipcRenderer.sendSync('show-open-dialog',{title:'导入 Markdown 笔记',properties:['openFile','multiSelections'],filters:[{name:'Markdown',extensions:['md','markdown','txt']}]});
      if(!files?.length)return [];
      const result=[];
      for(const file of files){
        const stat=await fs.stat(file);
        if(stat.size>2*1024*1024)throw new Error(`${path.basename(file)} 超过 2 MB，未导入`);
        result.push({title:path.basename(file,path.extname(file)),content:await fs.readFile(file,'utf8')});
      }
      return result;
    },
    exportMarkdown:async(title,content)=>{
      const safeName=String(title||'未命名笔记').replace(/[\\/:*?"<>|]/g,'_').slice(0,80);
      const file=ipcRenderer.sendSync('show-save-dialog',{title:'导出 Markdown 笔记',defaultPath:`${safeName}.md`,filters:[{name:'Markdown',extensions:['md']}]});
      if(!file)return false;
      await fs.writeFile(file,String(content),'utf8');
      return true;
    }
  },
  migrateLegacy:async()=>{const done=await core.storage.get('migration-v1');if(done)return done;const names=['Markdown 笔记','悬浮便签'], keys=['state','settings','data','items','history','notes','tasks','habits','projects'];const snapshot={schemaVersion:1,migratedAt:new Date().toISOString(),sources:{}};for(const name of names){for(const key of keys){const value=await ipcRenderer.invoke('plugin-storage-get-async',name,key);if(value!==null&&value!==undefined)(snapshot.sources[name]||={})[key]=value;}}await core.storage.set('migration-v1',snapshot);return snapshot;}};
try{contextBridge.exposeInMainWorld('pluginAPI',api)}catch(_){window.pluginAPI=api}
function dispatch(toolId,action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:{toolId,action:action||{}}}));}
window.exports={'plugin-market-markdown-notes':{mode:'none',args:{enter:action=>dispatch('markdown-notes',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}},
'plugin-market-floating-notes':{mode:'none',args:{enter:action=>dispatch('floating-notes',action),search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
window.addEventListener('beforeunload',disposeToolRuntime);
