const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-ui-'));
process.env.SANRENJZ_USER_DATA = path.join(temporary, 'profile');
fs.mkdirSync(process.env.SANRENJZ_USER_DATA, { recursive: true });
fs.writeFileSync(path.join(process.env.SANRENJZ_USER_DATA, 'settings.json'), JSON.stringify({ migrationPrompted: true }));
process.env.SANRENJZ_ACCEPTANCE = '1';
const report = { assertions: [], errors: [], navigation: [] };
const navigationOutput = path.resolve(__dirname, '../dist/nav-compact-validation');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, label) => { if (!value) throw new Error(label); report.assertions.push(label); };
process.on('unhandledRejection', error => { report.errors.push(String(error)); });
require('../main');
app.whenReady().then(async () => {
    let win;
    try {
        for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows()[0]; if (win) break; await delay(100); }
        if (!win) throw new Error('主窗口未创建');
        win.webContents.setBackgroundThrottling(false);
        win.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !/ERR_FILE_NOT_FOUND|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|Font Awesome|favicon/.test(message)) report.errors.push(message); });
        for (let i = 0; i < 150; i++) { if (await win.webContents.executeJavaScript("Boolean(document.getElementById('migration-dialog') && typeof cachedPlugins !== 'undefined' && cachedPlugins?.length)").catch(() => false)) break; await delay(100); }
        const initial = await win.webContents.executeJavaScript(`(async()=>({title:document.title,python:await require('electron').ipcRenderer.invoke('python:status'),engines:[...document.querySelectorAll('.engine-tab')].map(b=>b.textContent),count:cachedPlugins?.length,visible:[...document.querySelectorAll('.plugin-card')].filter(c=>c.style.display!=='none').map(c=>c.dataset.engine),errors:document.body.innerText.includes('undefined')}))()`);
        assert(initial.title === '三人聚智', '新应用标题');
        assert(initial.python.mode === 'none' && !initial.python.configured, '没有 Python 仍可启动主界面');
        assert(initial.engines.join(',') === '效率工具,py程序', '两类菜单');
        assert(initial.count >= 44 && initial.visible.every(e => e === 'tools'), '默认效率工具视图及两类完整目录');
        await win.webContents.executeJavaScript("document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelector('[data-engine=python]').click();");
        const py = await win.webContents.executeJavaScript("({visible:[...document.querySelectorAll('.plugin-card')].filter(c=>c.style.display!=='none').map(c=>c.dataset.engine),buttons:document.querySelectorAll('.py-run').length})");
        assert(py.visible.length >= 4 && py.visible.every(e => e === 'python'), 'py程序菜单筛选');
        assert(py.buttons >= 4, 'Python 运行停止日志入口');
        assert(await win.webContents.executeJavaScript("(() => { const logs=document.getElementById('python-quick-logs'),settings=document.getElementById('python-quick-settings');if(!logs||!settings)return false;const l=logs.getBoundingClientRect(),s=settings.getBoundingClientRect();return !logs.hidden&&!settings.hidden&&l.width>0&&s.width>0&&l.right<=s.left+1;})()"), 'py程序顶部日志入口显示在Python环境左侧');
        await win.webContents.executeJavaScript("document.getElementById('python-quick-logs').click()");
        for (let i = 0; i < 100; i++) { if (await win.webContents.executeJavaScript("document.getElementById('python-logs-dialog').open")) break; await delay(25); }
        assert(await win.webContents.executeJavaScript("document.getElementById('python-logs-dialog').open && Boolean(document.getElementById('python-log-output'))"), '顶部日志入口直达已有运行日志弹窗');
        await win.webContents.executeJavaScript("document.querySelector('#python-logs-dialog .dialog-top button').click();document.querySelector('[data-engine=tools]').click()");
        assert(await win.webContents.executeJavaScript("!document.getElementById('python-logs-dialog').open && !document.getElementById('python-quick-logs').hidden && getComputedStyle(document.getElementById('python-quick-logs')).display!=='none' && document.getElementById('python-quick-settings').hidden && getComputedStyle(document.getElementById('python-quick-settings')).display==='none'"), '日志弹窗可关闭且效率页保留统一日志入口、隐藏Python环境入口');
        await win.webContents.executeJavaScript("document.querySelector('[data-engine=python]').click()");
        await win.webContents.executeJavaScript("document.getElementById('search-box').value='terminal';document.getElementById('search-box').dispatchEvent(new Event('input'));document.querySelector('[data-engine=tools]').click();document.querySelector('[data-engine=python]').click();");
        assert(await win.webContents.executeJavaScript("document.getElementById('search-box').value==='terminal' && [...document.querySelectorAll('.plugin-card')].filter(c=>c.style.display!=='none').length===1"), '共享查询词跨菜单保留');
        await win.webContents.executeJavaScript("document.getElementById('local-file-btn').click()");
        assert(await win.webContents.executeJavaScript("document.getElementById('open-plugin-dialog').open && document.querySelectorAll('#open-plugin-dialog [data-kind]').length===4"), '三类打开插件及ZIP入口');
        await win.webContents.executeJavaScript("document.getElementById('open-plugin-dialog').close();document.getElementById('python-quick-settings').click()");
        await delay(300);
        assert(await win.webContents.executeJavaScript("document.getElementById('merge-python').classList.contains('active') && Boolean(document.getElementById('python-manage-plugins')) && !document.getElementById('python-program-management')"), '环境设置提供统一插件管理入口');
        await win.webContents.executeJavaScript("document.getElementById('python-manage-plugins').click()");
        for (let i = 0; i < 100; i++) {
            if (await win.webContents.executeJavaScript("document.querySelectorAll('.plugin-management-item[data-engine=python]').length>=4")) break;
            await delay(50);
        }
        assert(await win.webContents.executeJavaScript("document.getElementById('plugins').classList.contains('active') && document.getElementById('plugin-manager-engine').value==='python' && [...document.querySelectorAll('.plugin-management-item')].filter(row=>row.style.display!=='none').every(row=>row.dataset.engine==='python')"), 'Python 插件在统一管理页显示并筛选');
        const catalog = await win.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('search-catalog-get')");
        assert(catalog.plugins.some(p => p.engine === 'python') && catalog.plugins.some(p => p.engine === 'tools'), '全局搜索聚合两类插件');
        assert(await win.webContents.executeJavaScript("Boolean(document.getElementById('update-release-btn') && document.getElementById('update-check-btn'))"), '提供独立正式版更新及发布页面入口（联网与下载由更新专用验收覆盖）');
        await win.webContents.executeJavaScript("document.getElementById('settings-modal').classList.remove('show');document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());true;");
        fs.mkdirSync(navigationOutput, { recursive: true });
        for (const [width, height] of [[900,650],[1000,680],[1180,760],[1500,900]]) {
            win.setSize(width,height); await delay(80);
            assert(await win.webContents.executeJavaScript("document.getElementById('header').scrollWidth<=document.documentElement.clientWidth+1"), `${width}×${height} 顶部操作无横向溢出`);
            const navigation = await win.webContents.executeJavaScript("(() => {const nav=document.querySelector('.engine-nav'),n=nav.getBoundingClientRect(),header=document.getElementById('header').getBoundingClientRect();const buttons=[...nav.querySelectorAll('button')].filter(button=>!button.hidden).map(button=>{const r=button.getBoundingClientRect();return {id:button.id||button.dataset.engine,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});return {viewportWidth:innerWidth,headerHeight:header.height,navHeight:n.height,navLeft:n.left,navRight:n.right,navTop:n.top,navBottom:n.bottom,navOverflow:nav.scrollWidth-nav.clientWidth,buttons,captureHeight:Math.ceil(n.bottom)};})()");
            report.navigation.push({ width, height, ...navigation });
            assert(navigation.navOverflow <= 1 && navigation.buttons.every(button=>button.width>0&&button.height>0&&button.left>=navigation.navLeft-1&&button.right<=navigation.navRight+1&&button.top>=navigation.navTop-1&&button.bottom<=navigation.navBottom+1), `${width}×${height} 类型导航按钮完整可达且无横向溢出`);
            const firstCenter = (navigation.buttons[0].top + navigation.buttons[0].bottom) / 2;
            const singleRow = navigation.buttons.every(button=>Math.abs((button.top+button.bottom)/2-firstCenter)<=2);
            assert(singleRow ? navigation.navHeight<=48 : width===900&&navigation.navHeight<=96, `${width}×${height} 类型导航保持紧凑高度且不裁切换行`);
            const rectangle = { x: 0, y: 0, width: navigation.viewportWidth, height: navigation.captureHeight };
            await win.webContents.capturePage(rectangle); await delay(120);
            fs.writeFileSync(path.join(navigationOutput, `top-${width}x${height}.png`), (await win.webContents.capturePage(rectangle)).toPNG());
        }
        assert(report.errors.length === 0, '无未处理的界面脚本错误');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); process.exitCode = 1; }
    finally {
        const output = path.join(__dirname, '..', 'dist', 'merged-electron-report.json'); fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify(report,null,2));
        fs.mkdirSync(navigationOutput, { recursive: true }); fs.writeFileSync(path.join(navigationOutput, 'report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report)); app.isQuiting = true; app.exit(report.success ? 0 : 1);
    }
});
setTimeout(() => { console.error('集成验收超时'); app.exit(2); }, 60000).unref();
