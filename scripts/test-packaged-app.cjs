const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) throw new Error('请指定 Windows 解包版 EXE 路径');
const pythonIndex = process.argv.indexOf('--python');
const pythonExecutable = pythonIndex >= 0 ? process.argv[pythonIndex + 1] : '';
if (pythonIndex >= 0 && (!pythonExecutable || !fs.existsSync(pythonExecutable))) throw new Error('请指定已安装且可用的 Python 解释器');
const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-package-'));
const profile = path.join(sandbox, 'profile'); fs.mkdirSync(profile);
const output = path.join(root, 'dist', 'packaged-app-report.json');
const report = { executable: path.resolve(executable), assertions: [], errors: [] };
const logs = fs.createWriteStream(path.join(root, 'dist', 'packaged-app-console.log'));
const child = spawn(path.resolve(executable), ['--remote-debugging-port=0', '--disable-gpu'], { windowsHide: true, env: { ...process.env, SANRENJZ_USER_DATA: profile, SANRENJZ_ACCEPTANCE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(logs, { end: false }); child.stderr.pipe(logs, { end: false });
let exited = false, connection, serial = 0;
let ownedPythonFixture = '';
child.once('exit', () => { exited = true; });
const pending = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, label) { if (!value) throw new Error(label); report.assertions.push(label); }
async function command(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 15000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
        connection.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
}
(async () => {
    try {
        let page;
        for (let i = 0; i < 150; i++) {
            if (exited) throw new Error('打包版启动失败，请检查 packaged-app-console.log');
            const active = path.join(profile, 'DevToolsActivePort');
            if (fs.existsSync(active)) {
                const port = fs.readFileSync(active, 'utf8').split('\n')[0];
                try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && /index\.html/.test(item.url)); } catch { }
                if (page) break;
            }
            await delay(100);
        }
        if (!page) throw new Error('未找到打包主界面');
        connection = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { connection.once('open', resolve); connection.once('error', reject); });
        connection.on('message', bytes => { const value = JSON.parse(String(bytes)); if (value.id && pending.has(value.id)) { const request = pending.get(value.id); pending.delete(value.id); value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result); } });
        for (let i = 0; i < 150; i++) { if (await evaluate("Boolean(document.getElementById('migration-dialog') && typeof cachedPlugins !== 'undefined' && cachedPlugins?.length)")) break; await delay(100); }
        await evaluate("require('@electron/remote').getCurrentWindow().webContents.setBackgroundThrottling(false); const qaStyle=document.createElement('style');qaStyle.textContent='*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}';document.head.appendChild(qaStyle); true;");
        const initial = await evaluate("(async()=>({title:document.title,list:await require('electron').ipcRenderer.invoke('unified:list'),status:await require('electron').ipcRenderer.invoke('python:status')}))()");
        assert(initial.title === '三人聚智', '真实打包版标题及ASAR外模块加载');
        assert(initial.list.length === 44, '默认包恰好40个效率插件和4个Python插件');
        assert(initial.status.mode === 'none' && !initial.status.configured, '默认包无Python仍正常启动');
        assert(initial.list.filter(p => p.engine === 'python').length === 4, 'Python目录种子正确安装到python-plugins');
        const resources = path.join(path.dirname(executable), 'resources');
        assert(fs.existsSync(path.join(resources, 'config', 'python-runtime.json')), '实际资源目录包含运行时清单');
        const native = await evaluate("(()=>{const Database=require('better-sqlite3');const db=new Database(':memory:');const value=db.prepare('select 1 as ok').get().ok;db.close();return value;})()");
        assert(native === 1, '打包后SQLite原生依赖真实加载');
        await evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.getElementById('settings-modal').classList.remove('show')");
        assert(await evaluate("!document.getElementById('python-quick-logs').hidden && document.getElementById('python-quick-logs').getBoundingClientRect().width>0 && document.getElementById('python-quick-settings').hidden"), '打包版效率工具页面常显统一日志入口');
        await evaluate("document.querySelector('[data-engine=python]').click()");
        assert(await evaluate("[...document.querySelectorAll('.plugin-card')].filter(c=>c.style.display!=='none').length===4"), '真实打包版菜单可用');
        assert(await evaluate("(()=>{const logs=document.getElementById('python-quick-logs'),env=document.getElementById('python-quick-settings');return !logs.hidden && logs.getBoundingClientRect().right<=env.getBoundingClientRect().left && document.querySelector('.engine-nav').getBoundingClientRect().height<=44 && document.getElementById('header').getBoundingClientRect().height<=54;})()"), '打包版顶部导航紧凑且日志位于Python环境左侧');
        await evaluate("document.getElementById('python-quick-logs').click()");
        for (let i=0;i<100;i++) { if(await evaluate("document.getElementById('python-logs-dialog').open")) break; await delay(30); }
        assert(await evaluate("document.getElementById('python-logs-dialog').open && document.getElementById('python-log-output').textContent.includes('暂无运行日志')"), '打包版日志快捷入口直接打开运行日志');
        await evaluate("document.getElementById('python-logs-dialog').close()");
        const captureNavigation = "require('@electron/remote').getCurrentWindow().webContents.capturePage({x:0,y:0,width:innerWidth,height:Math.ceil(document.querySelector('.engine-nav').getBoundingClientRect().bottom)}).then(value=>value.toPNG().toString('base64'))";
        await evaluate(captureNavigation); await delay(120);
        fs.writeFileSync(path.join(root, 'dist', 'packaged-nav-compact.png'), Buffer.from(await evaluate(captureNavigation), 'base64'));
        await evaluate("document.getElementById('python-quick-settings').click()");
        for (let i = 0; i < 100; i++) { if (await evaluate("document.getElementById('merge-python').classList.contains('active')")) break; await delay(30); }
        assert(await evaluate("document.getElementById('merge-python').classList.contains('active')"), '真实打包版环境设置可用');
        assert(await evaluate("document.querySelectorAll('#merge-python .settings-card').length===5 && document.getElementById('save-settings-btn').textContent==='完成' && document.getElementById('python-diagnose').disabled"), '打包版环境卡片与即时保存语义可用');
        assert(await evaluate("require('electron').ipcRenderer.invoke('python:config-location').then(value=>Boolean(value.path && value.defaultPath && !value.custom))"), '打包版配置目录读取不依赖Python');
        await evaluate("require('@electron/remote').getCurrentWindow().webContents.capturePage().then(()=>true)");
        await delay(120);
        const environmentScreenshot = await evaluate("require('@electron/remote').getCurrentWindow().webContents.capturePage().then(value=>value.toPNG().toString('base64'))");
        fs.writeFileSync(path.join(root, 'dist', 'packaged-environment-settings.png'), Buffer.from(environmentScreenshot, 'base64'));
        await evaluate("window.openPluginManagement('python')");
        const management = await evaluate("({total:document.querySelectorAll('.plugin-management-item').length,python:document.querySelectorAll('.plugin-management-item[data-engine=python]').length,visible:[...document.querySelectorAll('.plugin-management-item')].filter(row=>row.style.display!=='none').map(row=>row.dataset.engine),pythonSettings:[...document.querySelectorAll('.plugin-management-item[data-engine=python]')].every(row=>row.querySelector('[data-setting=showInMainUI]').checked && !row.querySelector('[data-setting=autoStartWithMain]').checked && !row.querySelector('.pm-keyword-input')),status:document.getElementById('plugin-management-status').textContent})");
        assert(management.total === 44 && management.python === 4, '真实打包版设置聚合40个效率插件和4个Python插件');
        assert(management.visible.length === 4 && management.visible.every(engine=>engine==='python'), '真实打包版插件管理类型筛选可用');
        assert(management.pythonSettings, 'Python管理默认显示不自启且不提供无效窗口设置');
        const ranking = await evaluate("(()=>{const {searchCatalog}=require(require('path').join(process.resourcesPath,'app','search_utils.js'));const plugins=[{name:'技能插件',searchText:'skill'}],contents=[{title:'skill gitea',searchTitle:'skill gitea',searchBody:'',contentType:'text-snippet'}];return {multi:searchCatalog('skill gitea',plugins,contents)[0].title,single:searchCatalog('skill',plugins,contents)[0].name};})()");
        assert(ranking.multi==='skill gitea' && ranking.single==='技能插件', '打包版搜索先比较多词覆盖，同覆盖保留插件优先');
        await delay(350);
        await evaluate("require('@electron/remote').getCurrentWindow().webContents.capturePage().then(()=>true)");
        await delay(120);
        const screenshot = await evaluate("require('@electron/remote').getCurrentWindow().webContents.capturePage().then(value=>value.toPNG().toString('base64'))");
        fs.writeFileSync(path.join(root, 'dist', 'packaged-python-settings.png'), Buffer.from(screenshot, 'base64'));
        const catalog = await evaluate("require('electron').ipcRenderer.invoke('search-catalog-get')");
        assert(catalog.plugins.filter(p=>p.engine==='python').length === 4, '打包后全局搜索覆盖Python');
        if (pythonExecutable) {
            const fixture = path.join(path.dirname(path.resolve(executable)), 'python-plugins', 'sanrenjz-acceptance-safe.py');
            if (fs.existsSync(fixture)) throw new Error('验收临时文件已存在，拒绝覆盖');
            fs.writeFileSync(fixture, 'import time\nprint("打包版 Python 安全运行🌟", flush=True)\ntime.sleep(0.15)\n', { encoding: 'utf8', flag: 'wx' });
            ownedPythonFixture = fixture;
            const runtime = await evaluate(`require('electron').ipcRenderer.invoke('python:select-path',${JSON.stringify(path.resolve(pythonExecutable))})`);
            assert(runtime.success !== false && runtime.version, '打包版实际验证并选择现有Python');
            const id = 'python:sanrenjz-acceptance-safe.py';
            const started = await evaluate(`require('electron').ipcRenderer.invoke('unified:run',${JSON.stringify(id)})`);
            assert(started.success && started.pid, '打包版通过统一IPC实际启动隔离Python文件');
            let records = [];
            for (let i = 0; i < 160; i++) {
                records = await evaluate(`require('electron').ipcRenderer.invoke('python:logs',${JSON.stringify(id)})`);
                if (records.some(record => record.message.includes('已退出'))) break;
                await delay(40);
            }
            assert(records.some(record=>record.stream==='stdout' && record.message==='打包版 Python 安全运行🌟'), '打包版Python日志保持中文与emoji完整');
            const current = await evaluate(`require('electron').ipcRenderer.invoke('unified:list',{includeHidden:true}).then(items=>items.find(item=>item.id===${JSON.stringify(id)}))`);
            assert(current && !current.isRunning && records.some(record=>record.message.includes('已退出')), '打包版Python退出后管理状态清理完成');
            const unifiedPython = await evaluate("require('electron').ipcRenderer.invoke('runtime:logs')");
            assert(unifiedPython.records.some(record=>record.id===id && record.engine==='python' && record.message==='打包版 Python 安全运行🌟'), '打包版Python输出进入统一日志缓存');
            fs.rmSync(ownedPythonFixture); ownedPythonFixture = '';
            await evaluate("require('electron').ipcRenderer.invoke('python:clear')");
        }
        const runTarget = initial.list.find(p=>p.id==='tools:sanrenjz-tools-time-calculation');
        assert(Boolean(runTarget), '内置效率插件可定位');
        await evaluate(`require('electron').ipcRenderer.invoke('unified:run',${JSON.stringify(runTarget.id)})`);
        assert(await evaluate("require('@electron/remote').BrowserWindow.getAllWindows().some(w=>w.getTitle().includes('时间'))"), '效率插件通过实际管理器启动');
        const unifiedTools = await evaluate("require('electron').ipcRenderer.invoke('runtime:logs')");
        assert(unifiedTools.records.some(record=>record.id===runTarget.id && record.engine==='tools'), '打包版效率插件生命周期进入统一日志缓存');
        await evaluate("document.getElementById('settings-modal').classList.remove('show');document.querySelector('[data-engine=tools]').click();document.getElementById('python-quick-logs').click()");
        for(let i=0;i<100;i++){if(await evaluate("document.getElementById('python-logs-dialog').open && !document.getElementById('runtime-log-status').textContent.includes('正在')"))break;await delay(30);}
        assert(await evaluate("document.getElementById('runtime-log-engine').value==='all' && document.getElementById('runtime-log-plugin').options.length>=45"), '打包版统一日志默认全部类型并提供完整插件筛选');
        await evaluate("document.getElementById('runtime-log-engine').value='tools';document.getElementById('runtime-log-engine').dispatchEvent(new Event('change'))");
        assert(await evaluate("document.getElementById('python-log-output').textContent.includes('[效率工具]') && !document.getElementById('python-log-output').textContent.includes('[py程序]')"), '打包版效率类型筛选生效');
        if(pythonExecutable){
            await evaluate("document.getElementById('runtime-log-engine').value='python';document.getElementById('runtime-log-engine').dispatchEvent(new Event('change'))");
            assert(await evaluate("document.getElementById('python-log-output').textContent.includes('[py程序]') && !document.getElementById('python-log-output').textContent.includes('[效率工具]')"), '打包版Python类型筛选生效');
        }
        await evaluate("document.getElementById('runtime-log-engine').value='all';document.getElementById('runtime-log-engine').dispatchEvent(new Event('change'))");
        const captureUnified = "require('@electron/remote').getCurrentWindow().webContents.capturePage().then(value=>value.toPNG().toString('base64'))";
        await evaluate(captureUnified); await delay(120);
        fs.writeFileSync(path.join(root,'dist','packaged-unified-logs.png'),Buffer.from(await evaluate(captureUnified),'base64'));
        await evaluate("document.getElementById('python-logs-dialog').close()");
        const closed = new Promise(resolve => child.once('exit', code => { report.exitCode = code; resolve(); }));
        await evaluate("setTimeout(()=>require('@electron/remote').app.quit(),20); true").catch(() => {});
        let quitDeadline;
        await Promise.race([closed, new Promise(resolve=>{quitDeadline=setTimeout(resolve,12000)})]);
        clearTimeout(quitDeadline);
        assert(exited, '两阶段退出清理后应用正常结束');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
    finally {
        connection?.close();
        if (!exited && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        if (ownedPythonFixture) fs.rmSync(ownedPythonFixture, { force: true });
        fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); logs.end();
        if (exited) try { fs.rmSync(sandbox,{recursive:true,force:true}); } catch { }
    }
})();
