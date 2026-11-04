const {contextBridge,clipboard}=require('electron');
const {createAiRuntime}=require('../../plugin_runtime/ai-runtime');
let emit=()=>{};
const api=createAiRuntime('AI 正则助手',chunk=>emit(chunk));
api.onChunk=listener=>{emit=listener;return()=>{emit=()=>{}}};
api.copyText=text=>clipboard.writeText(String(text));
try{contextBridge.exposeInMainWorld('aiAPI',api)}catch(_){window.aiAPI=api}
function enter(action){window.dispatchEvent(new CustomEvent('plugin-enter',{detail:action||{}}))}
window.exports={'plugin-market-ai-regex':{mode:'none',args:{enter,search:(_a,_w,setList)=>setList([]),select:()=>{}}}};
