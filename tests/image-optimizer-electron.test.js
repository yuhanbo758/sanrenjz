const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-optimizer-'));
const inputPath = path.join(temporaryDirectory, 'source-800.png');
let outputPath = path.join(temporaryDirectory, 'result-256.ico');
const memory = new Map();

ipcMain.on('show-open-dialog', (event, options) => { event.returnValue = options.properties?.includes('openDirectory') ? [temporaryDirectory] : []; });
ipcMain.on('show-save-dialog', event => { event.returnValue = outputPath; });
ipcMain.handle('plugin-storage-get-async', (_event, name, key) => memory.get(`${name}:${key}`) ?? null);
ipcMain.handle('plugin-storage-set-async', (_event, name, key, value) => {
  memory.set(`${name}:${key}`, value);
  return true;
});

function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        if (await predicate()) return resolve();
        if (Date.now() - startedAt > timeoutMs) return reject(new Error('等待图片保存超时'));
        setTimeout(poll, 30);
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}

app.whenReady().then(async () => {
  let window;
  const rendererErrors = [];
  try {
    const bitmap = Buffer.alloc(800 * 800 * 4);
    for (let index = 0; index < bitmap.length; index += 4) {
      bitmap[index] = 0x84;
      bitmap[index + 1] = 0x33;
      bitmap[index + 2] = 0xd6;
      bitmap[index + 3] = 0xff;
    }
    const source = nativeImage.createFromBitmap(bitmap, { width: 800, height: 800, scaleFactor: 1 });
    fs.writeFileSync(inputPath, source.toPNG());

    const pluginDirectory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-image-optimizer');
    window = new BrowserWindow({
      show: false,
      width: 1180,
      height: 760,
      webPreferences: {
        preload: path.join(pluginDirectory, 'preload.js'),
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      }
    });
    window.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) rendererErrors.push(message);
    });
    await window.loadFile(path.join(pluginDirectory, 'index.html'));
    const unifiedUi = await window.webContents.executeJavaScript(`({
      tabCount: document.querySelectorAll('.tab').length,
      sectionCount: document.querySelectorAll('.setting-section').length,
      heading: document.querySelector('.side-h h2')?.textContent
    })`);
    assert.deepStrictEqual(unifiedUi, { tabCount: 0, sectionCount: 4, heading: '优化设置' });
    const introCount = await window.webContents.executeJavaScript("document.querySelectorAll('.head,.workflow').length");
    assert.strictEqual(introCount, 0, '菜单下方不应重复显示插件介绍和流程栏');
    const focusedControl = await window.webContents.executeJavaScript(`focusToolSection('image-resizer');document.activeElement.id`);
    assert.strictEqual(focusedControl, 'targetW', '尺寸入口应定位到尺寸设置，而不是切换重复页面');
    for (const [width, height] of [[900, 650], [1180, 760], [1440, 900]]) {
      window.setSize(width, height);
      const layout = await window.webContents.executeJavaScript(`(()=>{const button=document.querySelector('#processBtn').getBoundingClientRect();return{pageOverflow:document.documentElement.scrollHeight>document.documentElement.clientHeight+1,buttonVisible:button.top>=0&&button.bottom<=innerHeight};})()`);
      assert.strictEqual(layout.pageOverflow, false, `${width}x${height} 不应出现页面级滚动`);
      assert.strictEqual(layout.buttonVisible, true, `${width}x${height} 保存按钮应固定可见`);
    }
    window.setSize(1180, 760);
    await window.webContents.executeJavaScript(`loadImage(${JSON.stringify(inputPath)})`);
    await waitFor(() => window.webContents.executeJavaScript("document.querySelector('#infoSize').textContent === '800×800'"));
    await window.webContents.executeJavaScript(`
      document.querySelector('#outputFmt').value = 'ico';
      document.querySelector('#outputFmt').dispatchEvent(new Event('change'));
      document.querySelector('#sizePreset').value = 'custom';
      document.querySelector('#targetW').value = '256';
      document.querySelector('#targetH').value = '256';
    `);
    if (process.env.IMAGE_OPTIMIZER_SCREENSHOT) {
      window.setPosition(-32000, -32000);
      window.showInactive();
      await new Promise(resolve => setTimeout(resolve, 80));
      fs.writeFileSync(process.env.IMAGE_OPTIMIZER_SCREENSHOT, (await window.capturePage()).toPNG());
      window.hide();
    }
    await window.webContents.executeJavaScript(`document.querySelector('#processBtn').click()`);
    await waitFor(() => fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0);

    const ico = fs.readFileSync(outputPath);
    assert.strictEqual(ico.readUInt16LE(0), 0);
    assert.strictEqual(ico.readUInt16LE(2), 1);
    assert.strictEqual(ico.readUInt16LE(4), 1);
    assert.strictEqual(ico[6], 0);
    assert.strictEqual(ico[7], 0);
    assert.strictEqual(ico.readUInt32LE(18), 22);
    const embeddedPng = nativeImage.createFromBuffer(ico.subarray(22));
    assert.deepStrictEqual(embeddedPng.getSize(), { width: 256, height: 256 });

    for (const format of ['png', 'jpg', 'webp', 'bmp']) {
      outputPath = path.join(temporaryDirectory, `result-320x180.${format}`);
      await window.webContents.executeJavaScript(`
        document.querySelector('#outputFmt').value = ${JSON.stringify(format)};
        document.querySelector('#outputFmt').dispatchEvent(new Event('change'));
        document.querySelector('#sizePreset').value = 'custom';
        document.querySelector('#targetW').value = '320';
        document.querySelector('#targetH').value = '180';
        document.querySelector('#processBtn').click();
      `);
      await waitFor(() => fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0);
      const output = fs.readFileSync(outputPath);
      if (format === 'png') assert.strictEqual(output.subarray(1, 4).toString('ascii'), 'PNG');
      if (format === 'jpg') assert.deepStrictEqual(Array.from(output.subarray(0, 2)), [0xff, 0xd8]);
      if (format === 'webp') {
        assert.strictEqual(output.subarray(0, 4).toString('ascii'), 'RIFF');
        assert.strictEqual(output.subarray(8, 12).toString('ascii'), 'WEBP');
      }
      if (format === 'bmp') {
        assert.strictEqual(output.subarray(0, 2).toString('ascii'), 'BM');
        assert.strictEqual(output.readInt32LE(18), 320);
        assert.strictEqual(output.readInt32LE(22), -180);
      }
      // Electron 25 的 nativeImage 无法从 WebP/BMP Buffer 解码，二者按各自文件头验证。
      if (format === 'png' || format === 'jpg') {
        assert.deepStrictEqual(nativeImage.createFromBuffer(output).getSize(), { width: 320, height: 180 });
      }
    }
    outputPath = path.join(temporaryDirectory, 'wrong-extension.png');
    await window.webContents.executeJavaScript(`
      document.querySelector('#outputFmt').value = 'webp';
      document.querySelector('#outputFmt').dispatchEvent(new Event('change'));
      document.querySelector('#processBtn').click();
    `);
    await waitFor(() => window.webContents.executeJavaScript("document.querySelector('#toast').textContent.includes('保存扩展名必须是 .webp')"));
    assert.strictEqual(fs.existsSync(outputPath), false, '扩展名与编码格式不一致时不得写入伪格式文件');
    const fakePngPath = path.join(temporaryDirectory, 'fake.png');
    const signatureError = await window.webContents.executeJavaScript(`(async()=>{try{await window.pluginAPI.writeImageFile(${JSON.stringify(fakePngPath)},new Uint8Array([0x42,0x4d,0,0]),'png');return '';}catch(error){return error.message;}})()`);
    assert.ok(signatureError.includes('编码结果为 bmp，目标格式为 png'), '写盘前必须检查真实文件签名');
    assert.strictEqual(fs.existsSync(fakePngPath), false, '二进制内容与目标格式不一致时不得写盘');
    const secondPath = path.join(temporaryDirectory, 'second.png');
    fs.writeFileSync(secondPath, nativeImage.createFromBitmap(bitmap.subarray(0, 400 * 200 * 4), { width: 400, height: 200, scaleFactor: 1 }).toPNG());
    await window.webContents.executeJavaScript(`
      const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(dropEvent, 'dataTransfer', { value: { files: [{ path: ${JSON.stringify(secondPath)} }] } });
      document.querySelector('#dropZone').dispatchEvent(dropEvent);
    `);
    await waitFor(() => window.webContents.executeJavaScript('entries.length === 2'));
    assert.strictEqual(await window.webContents.executeJavaScript('entries.length'), 2);
    await window.webContents.executeJavaScript(`
      document.querySelector('#rotateRight').click();
      document.querySelector('#flipH').click();
      document.querySelector('#sizePreset').value='50';
      document.querySelector('#outputFmt').value='png';
      document.querySelector('#outputFmt').dispatchEvent(new Event('change'));
      document.querySelector('#batchBtn').click();
    `);
    const batchFirst = path.join(temporaryDirectory, 'source-800-optimized-400x400.png');
    const batchSecond = path.join(temporaryDirectory, 'second-optimized-100x200.png');
    await waitFor(() => fs.existsSync(batchFirst) && fs.existsSync(batchSecond));
    assert.deepStrictEqual(nativeImage.createFromPath(batchSecond).getSize(), { width: 100, height: 200 }, '旋转后应按新宽高缩放');
    await window.webContents.executeJavaScript("document.querySelector('#batchBtn').click()");
    await waitFor(() => fs.existsSync(path.join(temporaryDirectory, 'source-800-optimized-400x400-1.png')));
    assert.ok(fs.existsSync(batchFirst), '第二次批量导出不应覆盖第一次输出');
    await window.webContents.executeJavaScript("document.querySelector('#removeBtn').click()");
    assert.strictEqual(await window.webContents.executeJavaScript('entries.length'), 1, '移除当前图片应更新队列');
    console.log('image optimizer Electron test passed: ICO/PNG/JPEG/WebP/BMP conversion and resize');
    app.exit(0);
  } catch (error) {
    if (window && !window.isDestroyed()) {
      const state = await window.webContents.executeJavaScript(`({
        toast: document.querySelector('#toast')?.textContent,
        button: document.querySelector('#processBtn')?.textContent,
        format: document.querySelector('#outputFmt')?.value,
        width: document.querySelector('#targetW')?.value,
        height: document.querySelector('#targetH')?.value
      })`).catch(() => null);
      console.error({ state, rendererErrors });
    }
    console.error(error);
    app.exit(1);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
