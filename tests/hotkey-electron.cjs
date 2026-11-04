const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, globalShortcut, session } = require('electron');
const profile = process.argv[2], phase = process.argv[3];
if (!profile || !phase) throw new Error('需要隔离 profile 和验收阶段');
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_TEST_HIDDEN = '1';
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
const registered = new Map(), blocked = new Set();
globalShortcut.register = (key, callback) => {
    if (blocked.has(key) || registered.has(key)) return false;
    registered.set(key, callback); return true;
};
globalShortcut.unregister = key => registered.delete(key);
globalShortcut.unregisterAll = () => registered.clear();
globalShortcut.isRegistered = key => registered.has(key);
const report = { phase, assertions: [], errors: [] };
const check = (value, text) => { assert(value, text); report.assertions.push(text); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await wait(30); } throw new Error('等待界面状态超时'); }
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })));
require('../main');
app.whenReady().then(async () => {
    try {
        let win;
        await until(() => { win = BrowserWindow.getAllWindows()[0]; return Boolean(win); });
        // 隐藏测试窗口模拟拥有焦点，不抢占用户桌面焦点。
        win.isFocused = () => true;
        const evaluate = expression => win.webContents.executeJavaScript(expression);
        await until(() => evaluate("Boolean(document.getElementById('use-alt-space-btn') && typeof captureHotkey==='function' && cachedPlugins?.length)").catch(() => false));
        if (phase === 'restart') {
            check(registered.has('Ctrl+Alt+F10'), '新进程保留用户选择，不强改 Alt+Space');
            check(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'))).globalHotkey==='Ctrl+Alt+F10', '重启不改写保存值');
        } else {
            await evaluate("window.__alerts=[];window.alert=text=>window.__alerts.push(text);document.getElementById('settings-btn').click();document.querySelector('.sidebar-item[data-target=shortcuts]').click()");
            await until(() => evaluate("settingsReady && !settingsLoading && !document.getElementById('change-hotkey-btn').disabled && document.getElementById('global-hotkey-input').value==='Ctrl+Shift+F11'"));
            await evaluate("document.getElementById('change-hotkey-btn').click()");
            await until(() => evaluate("document.getElementById('change-hotkey-btn').textContent==='取消录入'"));
            check(registered.has('Alt+Space'), '录入时请求临时注册 Alt+Space');
            registered.get('Alt+Space')();
            await until(() => evaluate("document.getElementById('global-hotkey-input').value==='Alt+Space' && !isCapturingHotkey"));
            check(BrowserWindow.getAllWindows().length===1,'录入已注册组合键不打开搜索或其他窗口');
            registered.get('Ctrl+Shift+F11')();
            check(BrowserWindow.getAllWindows().length===1,'按键未释放前抑制已有快捷键回调');
            win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space',modifiers:['alt']});
            win.webContents.sendInputEvent({type:'keyUp',keyCode:'Alt'});
            await until(() => !registered.has('Alt+Space'));
            await evaluate("document.getElementById('change-hotkey-btn').click()");
            await until(() => evaluate("document.getElementById('change-hotkey-btn').textContent==='取消录入'"));
            win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
            await until(() => evaluate("!isCapturingHotkey && document.getElementById('global-hotkey-input').value==='Alt+Space'"));
            check(true,'Esc 取消恢复录入前的值');
            await evaluate("document.getElementById('change-hotkey-btn').click()");
            await until(() => evaluate("document.getElementById('change-hotkey-btn').textContent==='取消录入'"));
            win.webContents.sendInputEvent({type:'keyDown',keyCode:'K',modifiers:['control','shift']});
            await until(() => evaluate("document.getElementById('global-hotkey-input').value==='Ctrl+Shift+K' && !isCapturingHotkey"));
            win.webContents.sendInputEvent({type:'keyUp',keyCode:'K'});
            check(true,'Electron before-input-event 录入组合键');
            await evaluate("document.getElementById('use-alt-space-btn').click()");
            const before = fs.readFileSync(path.join(profile,'settings.json'),'utf8');
            blocked.add('Alt+Space');
            const failed = await evaluate("require('electron').ipcRenderer.invoke('save-settings',{globalHotkey:'Alt+Space'}).then(()=>'',e=>e.message)");
            check(failed.includes('注册失败') && fs.readFileSync(path.join(profile,'settings.json'),'utf8')===before,'注册失败不保存，磁盘设置不变');
            check(registered.has('Ctrl+Shift+F11') && registered.has('Ctrl+D'),'注册失败恢复原有快捷键');
            blocked.delete('Alt+Space');
            await evaluate("require('electron').ipcRenderer.invoke('save-settings',{globalHotkey:'Alt+Space'})");
            check(registered.has('Alt+Space') && !registered.has('Ctrl+Shift+F11'),'保存 Alt+Space 成功并注销旧组合键');
            const globalCallback = registered.get('Alt+Space');
            blocked.add('Alt+Space');
            await evaluate("require('electron').ipcRenderer.invoke('save-settings',{pluginSearchSettings:{fixture:{keywords:['新关键词']}}})");
            check(registered.get('Alt+Space')===globalCallback,'普通设置保存不重注册快捷键');
            blocked.delete('Alt+Space');
            await evaluate("require('electron').ipcRenderer.invoke('save-settings',{superPanelHotkey:'Ctrl+Alt+F9'})");
            await evaluate("document.getElementById('super-panel-hotkey-input').value='Ctrl+Alt+F9';document.getElementById('clear-super-panel-hotkey-btn').click();");
            check(await evaluate("document.getElementById('super-panel-hotkey-input').value===''"),'超级面板快捷键可从界面清除');
            await evaluate("require('electron').ipcRenderer.invoke('save-settings',{superPanelHotkey:''})");
            check(!registered.has('Ctrl+Alt+F9'),'保存清除后释放超级面板快捷键');
            await evaluate("document.getElementById('change-hotkey-btn').click()");
            await until(() => evaluate("document.getElementById('change-hotkey-btn').textContent==='取消录入'"));
            registered.get('Alt+Space')();
            await until(() => evaluate("!isCapturingHotkey && document.getElementById('global-hotkey-input').value==='Alt+Space'"));
            check(BrowserWindow.getAllWindows().length===1,'录入当前全局 Alt+Space 不执行唤起动作');
            win.webContents.sendInputEvent({type:'keyUp',keyCode:'Alt'});
            await evaluate("require('electron').ipcRenderer.invoke('save-settings',{globalHotkey:'Ctrl+Alt+F10'})");
            check(registered.has('Ctrl+Alt+F10') && !registered.has('Alt+Space'),'再次修改不会残留旧快捷键');
        }
        report.success = true;
    } catch (error) { report.success=false;report.errors.push(error.stack||String(error));process.exitCode=1; }
    finally {
        fs.mkdirSync(path.join(__dirname,'..','dist'),{recursive:true});
        fs.writeFileSync(path.join(__dirname,'..','dist',`hotkey-${phase}-report.json`),JSON.stringify(report,null,2));
        console.log('HOTKEY_REPORT '+JSON.stringify(report));
        if(report.success) { app.isQuiting=true;app.quit(); } else app.exit(1);
    }
});
setTimeout(()=>{console.error('快捷键界面验收超时');app.exit(2)},20000).unref();
