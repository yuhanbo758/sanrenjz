const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { suites } = require('../scripts/plugin-market/catalog');

const root=path.resolve(__dirname,'..');

function loadSuite(suite){
  let api;const original=Module._load;
  global.window={exports:{},addEventListener(){},dispatchEvent(){}};global.CustomEvent=class{constructor(type,options){this.type=type;this.detail=options?.detail}};
  Module._load=function(request,parent,isMain){if(request==='electron')return{contextBridge:{exposeInMainWorld(_name,value){api=value}},ipcRenderer:{invoke(){return Promise.resolve(null)},sendSync(){return []}},clipboard:{writeText(){},readText(){return''},readImage(){return{isEmpty:()=>true}}},nativeImage:{createFromDataURL(){return{getSize:()=>({width:0,height:0}),toBitmap:()=>Buffer.alloc(0)}}},shell:{openExternal(){},showItemInFolder(){}}};return original.call(this,request,parent,isMain)};
  try{const file=path.join(root,'app','software',suite.folder,'preload.js');delete require.cache[require.resolve(file)];delete require.cache[require.resolve('../app/plugin_runtime/tool-runtime')];require(file);return api}finally{Module._load=original}
}

async function main(){
  assert.strictEqual(suites.length,20);
  const structured=loadSuite(suites.find(item=>item.id==='structured-data'));
  let response=await structured.runTask({toolId:'json-workbench',input:'{"a":{"b":2}}',options:{query:'a.b'}});assert.strictEqual(response.result,'2');
  response=await structured.runTask({toolId:'config-converter',input:'{"name":"tools"}',options:{source:'json',target:'properties'}});assert.match(response.result,/name=tools/);
  response=await structured.runTask({toolId:'xml-workbench',input:'<root><x>1</x></root>',options:{action:'format'}});assert.match(response.result,/\n/);
  response=await structured.runTask({toolId:'hosts-manager',input:'',options:{}});assert.strictEqual(response.ok,false,'跨套件能力必须被拒绝');

  const security=loadSuite(suites.find(item=>item.id==='code-security'));
  response=await security.runTask({toolId:'hash-hmac',input:'abc',options:{algorithm:'sha256'}});assert.strictEqual(response.result.length,64);
  response=await security.runTask({toolId:'id-generator',options:{type:'uuid',count:4}});assert.strictEqual(response.result.split('\n').length,4);

  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sanrenjz-suite-'));
  try{
    const left=path.join(temp,'含 空格');const right=path.join(temp,'右侧');fs.mkdirSync(left);fs.mkdirSync(right);fs.writeFileSync(path.join(left,'alpha.txt'),'第一行\n搜索目标','utf8');fs.writeFileSync(path.join(right,'alpha.txt'),'不同','utf8');
    const inspect=loadSuite(suites.find(item=>item.id==='file-inspector'));
    response=await inspect.runTask({toolId:'file-content-search',options:{directory:left,query:'搜索目标',extensions:'txt'}});assert.strictEqual(response.result[0].line,2);
    response=await inspect.runTask({toolId:'folder-compare',options:{directoryA:left,directoryB:right,hash:true}});assert.ok(response.result.some(item=>item.status));
    response=await inspect.runTask({toolId:'directory-tree',options:{directory:left,format:'markdown'}});assert.match(response.result,/alpha\.txt/);
    const batch=loadSuite(suites.find(item=>item.id==='file-batch'));
    response=await batch.runTask({toolId:'file-checksum',options:{files:[path.join(left,'alpha.txt')]}});assert.strictEqual(response.result[0].sha256.length,64);
  }finally{fs.rmSync(temp,{recursive:true,force:true})}
  console.log('plugin suite logic tests passed: permissions, text/security, temporary file workflows');
}
main().catch(error=>{console.error(error);process.exit(1)});
