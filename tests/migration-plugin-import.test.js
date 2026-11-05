'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { MigrationManager } = require('../app/migration-manager');
const { PluginCatalog } = require('../app/plugin-catalog');
const { PythonManager } = require('../app/python-manager');
const { createMergedHost } = require('../app/merged-host');

function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), 'utf8'); }
function snapshot(directory) {
    const result = {};
    const visit = folder => {
        if (!fs.existsSync(folder)) return;
        for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, item.name);
            if (item.isDirectory()) visit(file);
            else if (item.isFile()) result[path.relative(directory, file).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        }
    };
    visit(directory); return result;
}
function fixture(t) {
    // macOS 的 /var 临时别名先规范为真实父目录，避免触发产品的链接保护。
    const temporaryParent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporaryParent, 'sanrenjz-plugin-migration-'));
    assert.equal(path.dirname(path.resolve(root)), temporaryParent);
    const previousAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(root, 'isolated-appdata');
    const appRoot = path.join(root, 'current-app'), userData = path.join(root, 'current-user');
    const toolsDir = path.join(appRoot, 'app', 'software'), pythonDir = path.join(appRoot, 'app', 'python-software');
    const settingsFile = path.join(userData, 'settings.json');
    write(settingsFile, { pythonMode: 'none', customPythonPath: '', globalHotkey: 'Alt+Space', autoStart: false, migrationPrompted: true, pluginPreferences: {}, unrelatedSetting: 'keep-current' });
    const loadSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const saveSettings = update => { const next = { ...loadSettings(), ...update }; write(settingsFile, next); return next; };
    const calls = { refresh: 0, interpreter: 0, run: 0 };
    const manager = new MigrationManager({ appRoot, userData, toolsDir, pythonDir, loadSettings, saveSettings,
        inspectInterpreter: async () => { calls.interpreter++; throw new Error('禁止迁移检查启动Python'); },
        onChanged: async () => { calls.refresh++; return { helperUpdates: [] }; } });
    manager.detectInstallations = () => [];
    t.after(() => {
        if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
    });
    return { root, appRoot, userData, toolsDir, pythonDir, settingsFile, loadSettings, saveSettings, calls, manager };
}
function tool(folder, name = '合成私有工具') {
    write(path.join(folder, 'plugin.json'), { pluginName: name, main: 'index.html', description: '隔离迁移样例，不运行', features: [{ code: 'fixture-only', cmds: ['迁移私有样例'] }] });
    write(path.join(folder, 'index.html'), '<!doctype html><p>合成迁移工具，测试期间禁止打开</p>');
    write(path.join(folder, 'assets', 'resource.dat'), Buffer.from([1,3,5,7]));
    write(path.join(folder, 'lib', 'helper.js'), 'throw new Error("fixture must not run");');
    return folder;
}
function python(folder, name = '合成私有Python', entry = 'src/main.py') {
    write(path.join(folder, 'settings.json'), { name, main_file: entry, config_file: 'data/user.json', description: '隔离迁移程序，不运行' });
    write(path.join(folder, entry), entry.endsWith('.enc') ? 'encrypted-fixture-not-real-code' : 'raise RuntimeError("migration fixture must never run")\n');
    write(path.join(folder, 'requirements.txt'), 'migration_fixture_dependency==0.0.0\n');
    write(path.join(folder, 'libs', 'helper.py'), 'raise RuntimeError("fixture helper must not import")\n');
    write(path.join(folder, 'assets', 'resource.dat'), Buffer.from([2,4,6,8]));
    write(path.join(folder, 'data', 'user.json'), { fixture: 'private-config-only-in-temporary-directory' });
    return folder;
}
function sourceWith(result, product, id) {
    return result.sources.find(source => source.product === product && source.plugins?.some(plugin => plugin.engine === product && plugin.id === id));
}
function assertPreview(source, product, id) {
    assert(source, `未在预览中列出${product}:${id}`);
    assert(source.plugins.some(item => item.id === id && item.engine === product && typeof item.name === 'string'));
    assert(source.pluginLocations.some(item => item.engine === product && path.isAbsolute(item.path) && item.count > 0));
}

for (const [basename, product] of [['sanrenjz-tools','tools'],['yuhanbopy-app','python']]) {
    test(`安装目录恰叫${basename}仍识别插件程序，不能误当只有配置的profile`, async t => {
        const f = fixture(t), old = path.join(f.root, 'legacy-install', basename), id = `unlisted-${product}-fixture`;
        if (product === 'tools') tool(path.join(old, 'plugins', id)); else python(path.join(old, 'plugins', id));
        const before = snapshot(old), inspected = await f.manager.inspect({ installationRoots: [old] });
        const source = sourceWith(inspected, product, id); assertPreview(source, product, id);
        assert.equal(source.root, old); assert.equal(product === 'tools' ? source.toolsCount : source.pythonCount, 1);
        const result = await f.manager.migrate({ sourceId: source.id, toolsPlugins: product === 'tools', pythonPlugins: product === 'python' });
        assert.equal(result.success, true); assert(fs.existsSync(path.join(product === 'tools' ? f.toolsDir : f.pythonDir, id, product === 'tools' ? 'plugin.json' : 'settings.json')));
        assert.deepEqual(snapshot(old), before); assert.equal(f.calls.interpreter, 0);
    });
}

test('直接选择单个效率插件或Python插件，复制依赖资源并保持两个协议', async t => {
    const f = fixture(t), tools = tool(path.join(f.root, 'sources', 'direct-tool-fixture')), py = python(path.join(f.root, 'sources', 'direct-python-fixture'));
    const before = snapshot(path.join(f.root, 'sources'));
    for (const [directory, product, id] of [[tools,'tools','direct-tool-fixture'],[py,'python','direct-python-fixture']]) {
        const inspected = await f.manager.inspect({ installationRoots: [directory] }), source = sourceWith(inspected, product, id); assertPreview(source, product, id);
        const result = await f.manager.migrate({ sourceId: source.id, toolsPlugins: product === 'tools', pythonPlugins: product === 'python' }); assert(result.success);
    }
    assert.equal(fs.readFileSync(path.join(f.pythonDir,'direct-python-fixture','requirements.txt'),'utf8'),'migration_fixture_dependency==0.0.0\n');
    assert.equal(fs.readFileSync(path.join(f.pythonDir,'direct-python-fixture','libs','helper.py'),'utf8'),'raise RuntimeError("fixture helper must not import")\n');
    assert(fs.readFileSync(path.join(f.toolsDir,'direct-tool-fixture','assets','resource.dat')).equals(Buffer.from([1,3,5,7])));
    assert.deepEqual(snapshot(path.join(f.root,'sources')),before); assert(!fs.existsSync(path.join(f.userData,'python-plugin-configs'))); assert.equal(f.calls.interpreter,0);
});

test('效率插件自带node_modules及依赖内部runtime精确保留，配置与Python环境排除不放宽',async t=>{
    const f=fixture(t),old=path.join(f.root,'旧程序 中文 空格'),id='unlisted-node-dependency-tool',directory=tool(path.join(old,'plugins',id));
    const dependencyFiles={
        'node_modules/fixture-dependency/index.js':'throw new Error("do not execute dependency fixture");\n',
        'node_modules/fixture-dependency/package.json':JSON.stringify({name:'fixture-dependency',main:'index.js',version:'0.0.0'}),
        'node_modules/fixture-dependency/runtime/helper.js':'throw new Error("do not execute nested runtime fixture");\n',
        'node_modules/@babel/runtime/helpers.js':'throw new Error("do not execute scoped runtime fixture");\n'
    };
    for(const [name,content]of Object.entries(dependencyFiles))write(path.join(directory,...name.split('/')),content);
    for(const name of ['runtime/not-a-runtime-to-copy.txt','python/python.exe','.venv/pyvenv.cfg','local-environment/pyvenv.cfg','local-environment/Lib/site-packages/test.py','account-token.bin','Network/Cookies','Cookies','operation.log'])write(path.join(directory,...name.split('/')),'never-migrate-fixture');
    const sourceData=path.join(f.root,'旧私密配置 中文 空格');
    write(path.join(process.env.APPDATA,'sanrenjz-tools','settings.json'),{customPluginDataPath:sourceData});
    write(path.join(sourceData,'keep-config.json'),{fixture:true});write(path.join(sourceData,'node_modules','config-dependency','index.js'),'never-copy-config-node-modules');write(path.join(sourceData,'runtime','private-runtime.json'),'never-copy-config-runtime');
    const before=snapshot(old),dataBefore=snapshot(sourceData),inspected=await f.manager.inspect({installationRoots:[old]}),source=sourceWith(inspected,'tools',id);assertPreview(source,'tools',id);
    const result=await f.manager.migrate({sourceId:source.id,toolsPlugins:true,configs:true});assert(result.success);
    for(const [name,content]of Object.entries(dependencyFiles))assert.equal(fs.readFileSync(path.join(f.toolsDir,id,...name.split('/')),'utf8'),content);
    for(const name of ['runtime','python','.venv','local-environment','account-token.bin','Network','Cookies','operation.log'])assert(!fs.existsSync(path.join(f.toolsDir,id,name)),`不得复制${name}`);
    assert(fs.existsSync(path.join(f.userData,'plugin-data','keep-config.json')));assert(!fs.existsSync(path.join(f.userData,'plugin-data','node_modules')));assert(!fs.existsSync(path.join(f.userData,'plugin-data','runtime')));
    assert.deepEqual(snapshot(old),before);assert.deepEqual(snapshot(sourceData),dataBefore);assert.equal(f.calls.interpreter,0);
});

test('任意命名的混合插件集合识别两类插件和独立py文件，不依赖公开白名单', async t => {
    const f = fixture(t), collection = path.join(f.root,'我的 旧插件集合');
    tool(path.join(collection,'synthetic-private-tool')); python(path.join(collection,'synthetic-private-python'));write(path.join(collection,'standalone.py'),'raise RuntimeError("must not run")');write(path.join(collection,'notes.txt'),'not a plugin');
    const before=snapshot(collection),inspected=await f.manager.inspect({installationRoots:[collection]});
    const tools=sourceWith(inspected,'tools','synthetic-private-tool'),py=sourceWith(inspected,'python','synthetic-private-python');assertPreview(tools,'tools','synthetic-private-tool');assertPreview(py,'python','synthetic-private-python');
    assert.equal(tools.toolsCount,1);assert.equal(py.pythonCount,2);assert(py.plugins.some(item=>item.id==='standalone.py'));
    assert((await f.manager.migrate({sourceId:tools.id,toolsPlugins:true})).success);assert((await f.manager.migrate({sourceId:py.id,pythonPlugins:true})).success);
    assert(fs.existsSync(path.join(f.pythonDir,'standalone.py')));assert(!fs.existsSync(path.join(f.pythonDir,'notes.txt')));assert.deepEqual(snapshot(collection),before);
    const publicPlugins=require('../config/public-plugins.json');assert(!publicPlugins.tools.includes('synthetic-private-tool')&&!publicPlugins.python.includes('synthetic-private-python'));
    assert.equal(f.loadSettings().pluginPreferences['合成私有工具'].autoStartWithMain,false);assert.equal(f.loadSettings().pluginPreferences['python:synthetic-private-python/src/main.py'].autoStartWithMain,false);
});

test('安装根、resources与resources/app三种入口列出相同的实际内置插件位置', async t => {
    const f=fixture(t),install=path.join(f.root,'旧便携 应用'),resources=path.join(install,'resources'),app=path.join(resources,'app');
    tool(path.join(app,'software','resource-tool'));python(path.join(app,'python-software','resource-python'));
    for(const directory of [install,resources,app]){
        const inspected=await f.manager.inspect({installationRoots:[directory]});
        assertPreview(sourceWith(inspected,'tools','resource-tool'),'tools','resource-tool');assertPreview(sourceWith(inspected,'python','resource-python'),'python','resource-python');
    }
});

test('安装态用户插件优先于同名内置种子，重复选择不重复导入', async t => {
    const f=fixture(t),install=path.join(f.root,'旧应用'),id='same-plugin';
    tool(path.join(install,'plugins',id),'用户版本');write(path.join(install,'plugins',id,'index.html'),'user-current');
    tool(path.join(install,'resources','app','software',id),'内置旧版本');write(path.join(install,'resources','app','software',id,'index.html'),'bundled-old');
    const inspected=await f.manager.inspect({installationRoots:[install,path.join(install,'plugins')]}),source=sourceWith(inspected,'tools',id);assertPreview(source,'tools',id);assert.equal(source.toolsCount,1);
    assert((await f.manager.migrate({sourceId:source.id,toolsPlugins:true})).success);assert.equal(fs.readFileSync(path.join(f.toolsDir,id,'index.html'),'utf8'),'user-current');
    const before=snapshot(f.toolsDir),again=await f.manager.migrate({sourceId:source.id,toolsPlugins:true});assert(again.success&&again.conflicts.some(item=>item.type==='plugin'&&item.id===id));assert.deepEqual(snapshot(f.toolsDir),before);
});

test('跨类型同名插件分别导入，目标已有程序与配置完整保留且报告冲突', async t => {
    const f=fixture(t),old=path.join(f.root,'sources'),tools=tool(path.join(old,'tool-install','plugins','same-name')),py=python(path.join(old,'python-install','plugins','same-name'));
    tool(path.join(f.toolsDir,'same-name'),'当前工具');write(path.join(f.toolsDir,'same-name','index.html'),'keep-current-tool');
    write(path.join(f.userData,'python-plugin-configs','same-name.json'),{keep:'current-config'});const before=snapshot(old),currentTool=snapshot(path.join(f.toolsDir,'same-name'));
    for(const [directory,product]of [[path.dirname(tools),'tools'],[path.dirname(py),'python']]){
        const inspected=await f.manager.inspect({installationRoots:[directory]}),source=sourceWith(inspected,product,'same-name');assertPreview(source,product,'same-name');
        const result=await f.manager.migrate({sourceId:source.id,toolsPlugins:product==='tools',pythonPlugins:product==='python',configs:product==='python'});assert(result.success);
        if(product==='tools')assert(result.conflicts.some(item=>item.type==='plugin'&&item.id==='same-name'));
        else assert(result.conflicts.some(item=>item.type==='config'&&item.id==='same-name.json'));
    }
    assert.deepEqual(snapshot(path.join(f.toolsDir,'same-name')),currentTool);assert(fs.existsSync(path.join(f.pythonDir,'same-name','src','main.py')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.userData,'python-plugin-configs','same-name.json'))),{keep:'current-config'});assert.deepEqual(snapshot(old),before);
});

test('依赖声明、资源与enc入口能列入真实管理器，但迁移和列表不得安装或启动', async t => {
    const f=fixture(t),old=path.join(f.root,'collection');tool(path.join(old,'unlisted-tools'));python(path.join(old,'unlisted-python'),'加密合成Python','main.enc');
    const inspected=await f.manager.inspect({installationRoots:[old]});
    for(const product of ['tools','python']){const source=sourceWith(inspected,product,`unlisted-${product==='tools'?'tools':'python'}`);assertPreview(source,product,`unlisted-${product==='tools'?'tools':'python'}`);assert((await f.manager.migrate({sourceId:source.id,toolsPlugins:product==='tools',pythonPlugins:product==='python'})).success);}
    const catalog=new PluginCatalog(f.toolsDir),tools=await catalog.read(true);assert.equal(tools.length,1);assert.equal(tools[0].folder,'unlisted-tools');
    let environmentCalls=0;const manager=new PythonManager({pluginDir:f.pythonDir,userData:f.userData,appRoot:f.appRoot,loadSettings:f.loadSettings,saveSettings:f.saveSettings,environment:{resolve:async()=>{environmentCalls++;throw new Error('must not resolve');}}});
    const programs=manager.list();assert.equal(programs.length,1);assert.equal(programs[0].id,'python:unlisted-python/main.enc');assert(programs[0].requirementsPath.endsWith('requirements.txt'));assert(!programs[0].autoStart&&!programs[0].isRunning);assert.equal(environmentCalls,0);assert.equal(f.calls.interpreter,0);await manager.shutdown();
});

test('单个插件复制失败清理暂存，源和目标既有插件保持原字节', async t => {
    const f=fixture(t),old=path.join(f.root,'sources'),directory=tool(path.join(old,'broken-copy')),before=snapshot(old);
    const inspected=await f.manager.inspect({installationRoots:[directory]}),source=sourceWith(inspected,'tools','broken-copy');assertPreview(source,'tools','broken-copy');
    const original=fs.copyFileSync;fs.copyFileSync=(from,...args)=>{if(path.resolve(from)===path.join(directory,'assets','resource.dat'))throw Object.assign(new Error('fixture'),{code:'EACCES'});return original(from,...args);};
    let result;try{result=await f.manager.migrate({sourceId:source.id,toolsPlugins:true});}finally{fs.copyFileSync=original;}
    assert.equal(result.success,false);assert(!fs.existsSync(path.join(f.toolsDir,'broken-copy')));assert(!fs.readdirSync(f.toolsDir).some(name=>name.includes('.migration-')));assert.deepEqual(snapshot(old),before);assert(fs.existsSync(path.join(result.backupPath,'report.json')));
});

test('刷新全局失败回滚本次程序和设置，保留备份及原始源', async t => {
    const f=fixture(t),directory=tool(path.join(f.root,'sources','rollback-tool')),before=snapshot(path.join(f.root,'sources')),settings=fs.readFileSync(f.settingsFile);
    const inspected=await f.manager.inspect({installationRoots:[directory]}),source=sourceWith(inspected,'tools','rollback-tool');assertPreview(source,'tools','rollback-tool');
    f.manager.onChanged=async()=>{throw new Error('isolated-refresh-failure');};const result=await f.manager.migrate({sourceId:source.id,toolsPlugins:true});
    assert(!result.success&&result.rolledBack);assert(!fs.existsSync(path.join(f.toolsDir,'rollback-tool')));assert(fs.readFileSync(f.settingsFile).equals(settings));assert.deepEqual(snapshot(path.join(f.root,'sources')),before);assert(fs.existsSync(path.join(result.backupPath,'report.json')));
});

test('真实host迁移IPC刷新主目录和Python搜索目录，无Python也可导入私有合成插件', async t => {
    const f=fixture(t),old=path.join(f.root,'legacy-mixed');tool(path.join(old,'host-private-tool'));python(path.join(old,'host-private-python'));
    fs.mkdirSync(f.toolsDir,{recursive:true});const catalog=new PluginCatalog(f.toolsDir),handlers=new Map(),events=[],refreshes=[];let runCalls=0,environmentCalls=0;
    const manager={pluginDir:f.toolsDir,getPluginList:async()=> (await catalog.read()).map(item=>({path:item.path,name:item.config.pluginName,description:item.config.description,features:item.config.features})),getPluginManagementList:async()=>[],runPlugin:async()=>{runCalls++;throw new Error('must not run tool');}};
    const host=createMergedHost({app:{isPackaged:false,getPath:name=>name==='userData'?f.userData:f.root},appRoot:f.appRoot,ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[old]})},shell:{},getWindow:()=>null,getManager:()=>manager,loadSettings:f.loadSettings,saveSettings:f.saveSettings,refresh:async reason=>{refreshes.push(reason);await catalog.read(true);},send:(name,payload)=>events.push({name,payload})});
    host.migration.detectInstallations=()=>[];
    host.environment.resolve=async()=>{environmentCalls++;throw new Error('must not resolve Python');};host.environment.inspect=async()=>{environmentCalls++;throw new Error('must not inspect Python');};host.environment.install=async()=>{environmentCalls++;throw new Error('must not install Python');};host.python.run=async()=>{runCalls++;throw new Error('must not run Python');};
    const invoke=(name,...args)=>handlers.get(name)({},...args);
    assert.deepEqual(await invoke('unified:list'),[]);const inspected=await invoke('migration:choose');
    for(const product of ['tools','python']){const id=product==='tools'?'host-private-tool':'host-private-python',source=sourceWith(inspected,product,id);assertPreview(source,product,id);assert((await invoke('migration:run',{sourceId:source.id,toolsPlugins:product==='tools',pythonPlugins:product==='python'})).success);}
    const main=await invoke('unified:list');assert(main.some(item=>item.id==='tools:host-private-tool'));assert(main.some(item=>item.id==='python:host-private-python/src/main.py'));
    const search=await host.searchEntries();assert(search.some(item=>item.id==='python:host-private-python/src/main.py'&&item.searchText.includes('合成私有python')));assert(refreshes.length>=2&&refreshes.every(reason=>reason==='unified-change')&&events.filter(event=>event.name==='python:changed').length>=2);
    assert.equal(runCalls,0);assert.equal(environmentCalls,0);assert.equal(f.loadSettings().pythonMode,'none');await host.python.shutdown();
});
