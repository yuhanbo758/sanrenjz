'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('node:assert/strict');
const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const root=process.env.SANRENJZ_MIGRATION_PLUGIN_ROOT;
if(!root||!path.isAbsolute(root)||!path.basename(root).startsWith('sanrenjz-plugin-migration-electron-')||fs.lstatSync(root).isSymbolicLink())throw new Error('父进程需分配有效隔离目录');
const profile=path.join(root,'new-profile'),appRoot=path.join(root,'新应用 中文 空格'),toolsDir=path.join(appRoot,'app','software'),pythonDir=path.join(appRoot,'app','python-software');
process.env.APPDATA=path.join(root,'isolated-appdata');process.env.SANRENJZ_USER_DATA=profile;process.env.SANRENJZ_ACCEPTANCE='1';
app.setName('sanrenjz-migration-plugin-test');app.setPath('userData',profile);app.disableHardwareAcceleration();
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),'utf8');};
const settingsFile=path.join(profile,'settings.json');write(settingsFile,{pythonMode:'none',globalHotkey:'Alt+Space',autoStart:false,migrationPrompted:true,pluginPreferences:{},unrelated:'keep'});
const loadSettings=()=>JSON.parse(fs.readFileSync(settingsFile,'utf8')),saveSettings=update=>{const next={...loadSettings(),...update};write(settingsFile,next);return next;};
const oldTools=path.join(root,'旧安装 中文 空格','sanrenjz-tools'),oldPython=path.join(root,'旧安装 中文 空格','yuhanbopy-app');
const tool=path.join(oldTools,'plugins','synthetic-private-tool'),py=path.join(oldPython,'plugins','synthetic-private-python');
write(path.join(tool,'plugin.json'),{pluginName:'Electron合成私有工具',main:'index.html',description:'合成迁移验收，不运行',features:[{code:'fixture',cmds:['私有迁移fixture']}]});
write(path.join(tool,'index.html'),'<p>fixture must never be opened</p>');write(path.join(tool,'node_modules','fixture-dependency','runtime','helper.js'),'throw new Error("dependency fixture must never execute");');
write(path.join(py,'settings.json'),{name:'Electron合成私有Python',main_file:'src/main.py',config_file:'config.json'});write(path.join(py,'src','main.py'),'raise RuntimeError("fixture must never execute")');write(path.join(py,'requirements.txt'),'fixture_dependency==0.0.0');write(path.join(py,'assets','resource.dat'),'fixture-resource');write(path.join(py,'config.json'),{});
const sourceHash=directory=>{const values={};const visit=folder=>{for(const item of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())visit(file);else values[path.relative(directory,file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}};visit(directory);return values;};
const sourceBefore=sourceHash(path.join(root,'旧安装 中文 空格'));
const output=path.resolve(__dirname,'../dist/migration-plugin-import-validation');
const report={isolatedProfile:true,realElectronIpc:true,assertions:[],errors:[],sourcePluginsSynthetic:true};
const check=(condition,label)=>{assert(condition,label);report.assertions.push(label);};
const {PluginCatalog}=require('../app/plugin-catalog'),RealManager=require('../app/software_manager'),{createMergedHost}=require('../app/merged-host');
let host,win,manager,runCalls=0,environmentCalls=0;const selectedRoots=[oldTools,oldPython],refreshes=[],events=[];
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selectedRoots.shift()]});
process.on('unhandledRejection',error=>report.errors.push(String(error)));
app.whenReady().then(async()=>{
    try{
        for(const directory of [toolsDir,pythonDir])fs.mkdirSync(directory,{recursive:true});
        win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false}});
        win.webContents.setBackgroundThrottling(false);
        manager=new RealManager(win,{loadSettings});manager.pluginDir=toolsDir;manager.catalog=new PluginCatalog(toolsDir);manager.runPlugin=async()=>{runCalls++;throw new Error('禁止测试运行效率业务');};
        host=createMergedHost({app,appRoot,ipcMain,dialog,shell,getWindow:()=>win,getManager:()=>manager,loadSettings,saveSettings,refresh:async reason=>{refreshes.push(reason);await manager.catalog.read(true);},send:(name,payload)=>{events.push(name);if(!win.isDestroyed())win.webContents.send(name,payload);}});
        host.migration.detectInstallations=()=>[];
        for(const method of ['resolve','inspect','install','discover'])host.environment[method]=async()=>{environmentCalls++;throw new Error('禁止测试安装或检查Python环境');};
        host.python.run=async()=>{runCalls++;throw new Error('禁止测试运行Python业务');};
        ipcMain.handle('fixture:management',()=>host.managementList());
        ipcMain.handle('fixture:search',async()=>({plugins:await host.list(true),entries:await host.searchEntries()}));
        const harness=path.join(root,'harness.html');write(harness,'<!doctype html><meta charset="utf-8"><p>隔离迁移IPC验收</p>');await win.loadFile(harness);
        const invoke=(channel,...args)=>win.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},...${JSON.stringify(args)})`);
        check((await invoke('unified:list')).length===0,'迁移前真实主目录为空且来源完全隔离');
        for(const [product,id]of [['tools','synthetic-private-tool'],['python','synthetic-private-python']]){
            const inspected=await invoke('migration:choose'),source=inspected.sources.find(item=>item.product===product&&item.plugins?.some(plugin=>plugin.id===id));
            check(source&&source.importable[product==='tools'?'toolsPlugins':'pythonPlugins']===1,`真实IPC识别${product}同名旧安装的插件程序`);
            const result=await invoke('migration:run',{sourceId:source.id,toolsPlugins:product==='tools',pythonPlugins:product==='python'});check(result.success,`真实Electron复制${product}插件成功`);
        }
        const list=await invoke('unified:list'),management=await invoke('fixture:management'),search=await invoke('fixture:search');
        for(const id of ['tools:synthetic-private-tool','python:synthetic-private-python/src/main.py']){
            check(list.some(item=>item.id===id),`迁移后真实主列表包含${id}`);check(management.some(item=>item.id===id),`统一管理列表包含${id}`);check(search.plugins.some(item=>item.id===id),`快捷搜索聚合目录包含${id}`);
        }
        check(search.entries.some(item=>item.id==='python:synthetic-private-python/src/main.py'&&item.searchText.includes('electron合成私有python')),'Python快捷搜索文本即时更新');
        check(search.plugins.find(item=>item.id==='tools:synthetic-private-tool').features[0].cmds.includes('私有迁移fixture'),'效率工具真实清单关键词可进入搜索目录');
        check(fs.readFileSync(path.join(toolsDir,'synthetic-private-tool','node_modules','fixture-dependency','runtime','helper.js'),'utf8').includes('must never execute'),'实际Electron复制保留插件依赖内部runtime');
        check(fs.existsSync(path.join(pythonDir,'synthetic-private-python','assets','resource.dat'))&&fs.existsSync(path.join(pythonDir,'synthetic-private-python','requirements.txt')),'Python资源与依赖声明复制完整');
        check(list.every(item=>!item.isRunning&&!item.autoStart),'导入后两类插件均未运行也未自动启动');
        check(runCalls===0&&environmentCalls===0&&loadSettings().pythonMode==='none','真实迁移和目录查询没有运行插件、pip、解释器扫描或安装');
        check(refreshes.length>=2&&events.includes('python:changed'),'实际迁移回调刷新目录并通知renderer');
        assert.deepEqual(sourceHash(path.join(root,'旧安装 中文 空格')),sourceBefore);check(true,'旧程序文件逐项SHA保持不变');
        check(loadSettings().globalHotkey==='Alt+Space'&&loadSettings().autoStart===false&&loadSettings().unrelated==='keep','现有宿主配置和快捷键保留');
        check(manager.pluginDir===toolsDir&&host.python.pluginDir===pythonDir,'两个实际管理器都写入临时新应用目录');
        check(report.errors.length===0,'真实Electron导入无未处理异常');report.success=true;
    }catch(error){report.success=false;report.errors.push(error.stack||String(error));}
    finally{
        await host?.python.shutdown();if(win&&!win.isDestroyed())win.destroy();
        fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'electron-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
        // 原生进程结束后再由父进程清理profile，不能在quit回调里删除活动目录。
        app.exit(report.success?0:1);
    }
});
setTimeout(()=>{console.error('真实Electron迁移验收超时');app.exit(2);},60000).unref();
