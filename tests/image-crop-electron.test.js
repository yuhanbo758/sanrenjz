const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.on('plugin-storage-get', event => { event.returnValue = null; });
ipcMain.on('plugin-storage-set', event => { event.returnValue = true; });
ipcMain.on('show-open-dialog', event => { event.returnValue = []; });
ipcMain.on('show-save-dialog', event => { event.returnValue = null; });

async function waitFor(window, expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await window.webContents.executeJavaScript(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`等待界面状态超时: ${expression}`);
}

app.whenReady().then(async () => {
    let window;
    let failure = null;
    try {
        const pluginDirectory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-cut_image');
        window = new BrowserWindow({
            show: false,
            width: 1200,
            height: 800,
            webPreferences: {
                preload: path.join(pluginDirectory, 'preload.js'),
                nodeIntegration: true,
                contextIsolation: false,
                webSecurity: false
            }
        });
        window.webContents.on('console-message', (_event, level, message) => {
            if (level >= 2 && !message.includes('Electron Security Warning') && !message.includes('Multiple readback')) {
                console.error('renderer:', message);
            }
        });
        await window.loadFile(path.join(pluginDirectory, 'index.html'));
        window.setSize(900, 650);
        await window.webContents.executeJavaScript(`
            window.testImageFile = (left, right, name = 'sample.png') => {
                const canvas = document.createElement('canvas');
                canvas.width = 40; canvas.height = 20;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = left; ctx.fillRect(0, 0, 20, 20);
                ctx.fillStyle = right; ctx.fillRect(20, 0, 20, 20);
                const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0));
                return new File([bytes], name, { type: '' });
            };
            window.testDrop = (target, file) => {
                const data = new DataTransfer(); data.items.add(file);
                const event = new Event('drop', { bubbles: true, cancelable: true });
                Object.defineProperty(event, 'dataTransfer', { value: data });
                target.dispatchEvent(event);
                return event.defaultPrevented;
            };
            void 0;
        `);

        // 初次拖入故意落在工具栏，验证窗口级事件和 Windows 空 MIME 文件名回退。
        assert.strictEqual(await window.webContents.executeJavaScript(
            `window.testDrop(document.querySelector('.toolbar'), window.testImageFile('#ff0000', '#0000ff'))`
        ), true);
        await waitFor(window, `document.querySelector('#canvasContainer').classList.contains('active')`);
        const layout = await window.webContents.executeJavaScript(`(() => {
            const area = document.querySelector('.canvas-area').getBoundingClientRect();
            const canvas = document.querySelector('#imageCanvas').getBoundingClientRect();
            const crop = document.querySelector('#cropBtn').getBoundingClientRect();
            return { pageOverflow: document.documentElement.scrollHeight > innerHeight + 1,
                canvasFits: canvas.left >= area.left && canvas.right <= area.right && canvas.top >= area.top && canvas.bottom <= area.bottom,
                cropVisible: crop.top >= 0 && crop.bottom <= innerHeight };
        })()`);
        assert.deepStrictEqual(layout, { pageOverflow: false, canvasFits: true, cropVisible: true });
        const initial = await window.webContents.executeJavaScript(`({
            info: document.querySelector('#imageInfo').textContent,
            left: [...document.querySelector('#imageCanvas').getContext('2d').getImageData(20, 20, 1, 1).data].slice(0, 3),
            right: [...document.querySelector('#imageCanvas').getContext('2d').getImageData(60, 20, 1, 1).data].slice(0, 3)
        })`);
        assert.match(initial.info, /40 × 20 px/);
        assert.deepStrictEqual(initial.left, [255, 0, 0]);
        assert.deepStrictEqual(initial.right, [0, 0, 255]);

        await window.webContents.executeJavaScript(`document.querySelector('#flipHorizontalBtn').click()`);
        let left = await window.webContents.executeJavaScript(
            `[...document.querySelector('#imageCanvas').getContext('2d').getImageData(20, 20, 1, 1).data].slice(0, 3)`
        );
        assert.deepStrictEqual(left, [0, 0, 255]);
        const exported = await window.webContents.executeJavaScript(`(async () => {
            document.querySelector('#resolutionScale').value = '1';
            let href = '';
            const click = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { href = this.href; };
            try { document.querySelector('#downloadBtn').click(); }
            finally { HTMLAnchorElement.prototype.click = click; }
            const image = new Image(); image.src = href; await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
            return { mime: href.slice(0, 22), width: image.width, height: image.height,
                left: [...ctx.getImageData(20, 20, 1, 1).data].slice(0, 3) };
        })()`);
        assert.deepStrictEqual(exported, { mime: 'data:image/png;base64,', width: 80, height: 40, left: [0, 0, 255] });
        await window.webContents.executeJavaScript(`document.querySelector('#undoBtn').click()`);
        left = await window.webContents.executeJavaScript(
            `[...document.querySelector('#imageCanvas').getContext('2d').getImageData(20, 20, 1, 1).data].slice(0, 3)`
        );
        assert.deepStrictEqual(left, [255, 0, 0]);
        await window.webContents.executeJavaScript(`document.querySelector('#redoBtn').click(); document.querySelector('#resetBtn').click()`);
        left = await window.webContents.executeJavaScript(
            `[...document.querySelector('#imageCanvas').getContext('2d').getImageData(20, 20, 1, 1).data].slice(0, 3)`
        );
        assert.deepStrictEqual(left, [255, 0, 0]);

        // 上传框已隐藏时仍可从画布区再次拖入，并替换前一张图片。
        await window.webContents.executeJavaScript(
            `testDrop(document.querySelector('#canvasContainer'), testImageFile('#00ff00', '#00ff00'))`
        );
        await waitFor(window, `[...document.querySelector('#imageCanvas').getContext('2d').getImageData(20, 20, 1, 1).data][1] === 255`);
        assert.strictEqual(await window.webContents.executeJavaScript(`document.querySelector('#undoBtn').disabled`), true);

        await window.webContents.executeJavaScript(`(async () => {
            const data = new DataTransfer();
            data.items.add(new File([await testImageFile('#ff0000', '#ff0000').arrayBuffer()], 'clipboard.png', { type: 'image/png' }));
            document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        })()`);
        await waitFor(window, `[...document.querySelector('#imageCanvas').getContext('2d').getImageData(20, 20, 1, 1).data][0] === 255`);

        await window.webContents.executeJavaScript(`
            document.querySelector('#rotateRightBtn').click();
            document.querySelector('#undoBtn').click();
        `);
        assert.strictEqual(await window.webContents.executeJavaScript(
            `document.querySelector('#imageInfo').textContent.includes('40 × 20 px')`
        ), true);
        await window.webContents.executeJavaScript(`
            document.querySelector('#cropWidth').value = '20';
            document.querySelector('#cropHeight').value = '20';
            document.querySelector('#cropHeight').dispatchEvent(new Event('input'));
            document.querySelector('#cropBtn').click();
        `);
        await waitFor(window, `document.querySelector('#imageInfo').textContent.includes('图片 20 × 20 px')`);
        await window.webContents.executeJavaScript(`document.querySelector('#undoBtn').click()`);
        assert.strictEqual(await window.webContents.executeJavaScript(
            `document.querySelector('#imageInfo').textContent.includes('图片 40 × 20 px')`
        ), true);
        await window.webContents.executeJavaScript(`document.querySelector('#addTextBtn').click()`);
        assert.strictEqual(await window.webContents.executeJavaScript(`document.querySelector('#redoBtn').disabled`), true);
        await window.webContents.executeJavaScript(`document.querySelector('#undoBtn').click()`);
        assert.strictEqual(await window.webContents.executeJavaScript(
            `document.querySelector('#redoBtn').title.includes('添加文字')`
        ), true);
        await window.webContents.executeJavaScript(`document.querySelector('#redoBtn').click()`);
        assert.strictEqual(await window.webContents.executeJavaScript(`document.querySelector('#redoBtn').disabled`), true);
        console.log('图片裁剪工具 Electron 交互检查通过');
    } catch (error) {
        console.error(error);
        failure = error;
    } finally {
        if (window && !window.isDestroyed()) window.destroy();
        app.exit(failure ? 1 : 0);
    }
}).catch(error => {
    console.error(error);
    app.exit(1);
});
