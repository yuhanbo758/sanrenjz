'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process');
test('真实Electron迁移IPC、两类管理器和搜索刷新，禁止启动合成私有程序',async()=>{
    const temporaryParent=fs.realpathSync(os.tmpdir());
    const temporary=fs.mkdtempSync(path.join(temporaryParent,'sanrenjz-plugin-migration-electron-'));let result;
    try{
        result=await new Promise((resolve,reject)=>{
            const env={...process.env,SANRENJZ_MIGRATION_PLUGIN_ROOT:temporary};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
            const child=spawn(require('electron'),[path.join(__dirname,'migration-plugin-import-electron.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='';
            child.stdout.on('data',chunk=>{log+=chunk.toString('utf8');});child.stderr.on('data',chunk=>{log+=chunk.toString('utf8');});child.once('error',reject);child.once('close',code=>resolve({code,log}));
        });
    }finally{
        assert.equal(path.dirname(path.resolve(temporary)),temporaryParent);assert(path.basename(temporary).startsWith('sanrenjz-plugin-migration-electron-'));assert(!fs.lstatSync(temporary).isSymbolicLink());
        fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:50});
    }
    const output=path.resolve(__dirname,'../dist/migration-plugin-import-validation');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'electron.log'),result.log);assert.equal(result.code,0,result.log.slice(-7000));
});
