const { app, BrowserWindow, ipcMain, nativeImage, clipboard } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PluginManager = require('../app/software_manager');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pinboard-test-'));
app.setPath('userData', temporary);
const pluginPath = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-image-pinboard');
const config = require(path.join(pluginPath, 'plugin.json'));
const storage = new Map();
let savePath = path.join(temporary, 'view.png');
let openPath = '';
ipcMain.handle('plugin-storage-get-async', (_event, _name, key) => storage.get(key) ?? null);
ipcMain.handle('plugin-storage-set-async', (_event, _name, key, value) => { storage.set(key, value); return true; });
ipcMain.on('show-open-dialog', event => { event.returnValue = openPath ? [openPath] : []; });
ipcMain.on('show-save-dialog', event => { event.returnValue = savePath; });

async function waitFor(window, expression) {
    for (let i = 0; i < 100; i++) {
        if (await window.webContents.executeJavaScript(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`等待界面状态超时: ${expression}`);
}

app.whenReady().then(async () => {
    let main;
    let manager;
    try {
        manager = new PluginManager(null);
        manager.pluginMeta.set(config.pluginName, { pluginPath, pluginConfig: config });
        ipcMain.handle('create-plugin-indicator-window', (_event, name) => manager.createOrShowPluginIndicatorWindow(name));
        ipcMain.handle('close-plugin-indicator-window', (_event, name) => manager.closePluginIndicatorWindow(name));
        ipcMain.handle('minimize-plugin-window', () => true);
        main = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: {
            preload: path.join(pluginPath, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false
        } });
        await main.loadFile(path.join(pluginPath, 'index.html'));
        const initial = await main.webContents.executeJavaScript(`({header:!!document.querySelector('.head'),overflow:document.documentElement.scrollHeight>innerHeight+1,actionVisible:document.querySelector('#floatBtn').getBoundingClientRect().bottom<=innerHeight})`);
        assert.deepStrictEqual(initial, { header: false, overflow: false, actionVisible: true });

        await main.webContents.executeJavaScript(`window.testImage = (left,right) => {
            const canvas=document.createElement('canvas');canvas.width=40;canvas.height=20;
            const ctx=canvas.getContext('2d');ctx.fillStyle=left;ctx.fillRect(0,0,20,20);ctx.fillStyle=right;ctx.fillRect(20,0,20,20);
            const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),x=>x.charCodeAt(0));
            return new File([bytes],'image.png',{type:''});
        };
        window.testDrop=(target,file)=>{const data=new DataTransfer();data.items.add(file);const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:data});target.dispatchEvent(event);return event.defaultPrevented;};
        void 0;`);
        assert.strictEqual(await main.webContents.executeJavaScript(`testDrop(document.querySelector('#favoriteBtn'),testImage('#ff0000','#0000ff'))`), true);
        await waitFor(main, `document.querySelector('#pinImg')?.naturalWidth===40`);
        assert.strictEqual(storage.has('pinboard-list'), false, '导入不应自动收藏');

        await main.webContents.executeJavaScript(`document.querySelector('#favoriteBtn').click()`);
        await waitFor(main, `document.querySelectorAll('.pinned-item').length===1`);
        assert.strictEqual(storage.get('pinboard-list').length, 1);
        await main.webContents.executeJavaScript(`document.querySelector('#flipXBtn').click();document.querySelector('#saveBtn').click()`);
        assert.strictEqual(fs.existsSync(savePath), true);
        const exported = nativeImage.createFromPath(savePath);
        assert.deepStrictEqual(exported.getSize(), { width: 40, height: 20 });
        const pixels = exported.toBitmap();
        assert.deepStrictEqual([...pixels.subarray(0, 3)], [255, 0, 0], '水平翻转后左侧应是蓝色 BGRA');
        await main.webContents.executeJavaScript(`document.querySelector('#copyBtn').click()`);
        assert.deepStrictEqual(clipboard.readImage().getSize(), { width: 40, height: 20 });

        openPath = path.join(temporary, 'picked.png');
        fs.copyFileSync(savePath, openPath);
        await main.webContents.executeJavaScript(`document.querySelector('#pickBtn').click()`);
        await waitFor(main, `document.querySelector('#imageMeta').textContent.includes('picked.png')`);
        await main.webContents.executeJavaScript(`(async()=>{
            const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
            const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),x=>x.charCodeAt(0));
            const data=new DataTransfer();data.items.add(new File([bytes],'pasted.png',{type:'image/png'}));
            window.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
        })()`);
        await waitFor(main, `document.querySelector('#imageMeta').textContent.includes('pasted.png')`);

        await main.webContents.executeJavaScript(`testDrop(document.querySelector('#stageArea'),testImage('#00ff00','#00ff00'))`);
        await waitFor(main, `document.querySelector('#pinImg')?.naturalWidth===40 && document.querySelector('#pinImg').src!==document.querySelector('.pi-thumb').src`);
        for (const [width, height] of [[900, 650], [1180, 760]]) {
            main.setSize(width, height);
            const layout = await main.webContents.executeJavaScript(`({overflow:document.documentElement.scrollHeight>innerHeight+1,stageWidth:document.querySelector('#stageArea').getBoundingClientRect().width,sideRight:document.querySelector('.side').getBoundingClientRect().right})`);
            assert.strictEqual(layout.overflow, false, `${width}×${height} 出现页面滚动`);
            assert(layout.stageWidth >= 500 && layout.sideRight <= width + 1, `${width}×${height} 布局异常`);
        }
        await main.webContents.executeJavaScript(`document.querySelector('.pinned-item button').click()`);
        await waitFor(main, `document.querySelectorAll('.pinned-item').length===0`);
        assert.strictEqual(storage.get('pinboard-list').length, 0);

        await main.webContents.executeJavaScript(`document.querySelector('#floatBtn').click()`);
        for (let i = 0; i < 100 && !manager.pluginAuxWindows.get(`${config.pluginName}::indicator`); i++) await new Promise(resolve => setTimeout(resolve, 40));
        const indicator = manager.pluginAuxWindows.get(`${config.pluginName}::indicator`);
        assert(indicator, '应创建悬浮窗口');
        await waitFor(indicator, `document.querySelector('#floatImg')?.naturalWidth===40`);
        const initialSize = indicator.getSize();
        assert.strictEqual(initialSize[0], 400);
        assert(Math.abs(initialSize[1] - 300) <= 2, `悬浮窗口高度异常: ${initialSize[1]}`);
        assert.strictEqual(indicator.isAlwaysOnTop(), true);
        indicator.setSize(460, 320);
        await new Promise(resolve => setTimeout(resolve, 100));
        const resizedSize = indicator.getSize();
        manager.closePluginIndicatorWindow(config.pluginName);
        await new Promise(resolve => setTimeout(resolve, 100));
        manager.createOrShowPluginIndicatorWindow(config.pluginName);
        const reopened = manager.pluginAuxWindows.get(`${config.pluginName}::indicator`);
        await waitFor(reopened, `document.querySelector('#floatImg')?.naturalWidth===40`);
        const reopenedSize = reopened.getSize();
        assert(Math.abs(reopenedSize[0] - resizedSize[0]) <= 4, `重新打开后的宽度异常: ${reopenedSize[0]}`);
        assert(Math.abs(reopenedSize[1] - resizedSize[1]) <= 4, `重新打开后的高度异常: ${reopenedSize[1]}`);
        const savedBounds = manager.getPluginStorageItem(config.pluginName, 'indicatorBounds');
        manager.closePluginIndicatorWindow(config.pluginName);
        const savedAgain = manager.getPluginStorageItem(config.pluginName, 'indicatorBounds');
        assert.deepStrictEqual([savedAgain.width, savedAgain.height], [savedBounds.width, savedBounds.height], '未调整大小时不应逐次增大窗口');
        manager.pluginMeta.set('default-indicator-test', { pluginPath, pluginConfig: { main: 'index.html', preload: 'preload.js' } });
        manager.createOrShowPluginIndicatorWindow('default-indicator-test');
        const defaultIndicator = manager.pluginAuxWindows.get('default-indicator-test::indicator');
        await waitFor(defaultIndicator, `document.readyState==='complete'`);
        assert.deepStrictEqual(defaultIndicator.getSize(), [72, 72], '未配置尺寸的旧插件继续使用 72×72 指示器');
        manager.closePluginIndicatorWindow('default-indicator-test');
        console.log('图片悬浮板 Electron 测试通过');
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        manager?.closePluginIndicatorWindow(config.pluginName);
        main?.destroy();
        app.exit(process.exitCode || 0);
    }
});
