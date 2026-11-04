const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { catalog } = require('./plugin-market/catalog');

const root = path.resolve(__dirname, '..');
const sizes = [16, 24, 32, 48, 64, 128, 256];
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

/** 把原创 SVG 通过 Electron/Chromium 渲染为真实 PNG，并封装为包含多尺寸图层的标准 ICO。 */
async function renderIcon(window, plugin) {
  const directory = path.join(root, 'app', 'software', plugin.folder);
  const svg = fs.readFileSync(path.join(directory, 'logo.svg'), 'utf8');
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const html = `<style>*{box-sizing:border-box}html,body{margin:0;width:256px;height:256px;overflow:hidden;background:transparent}img{display:block;width:256px;height:256px}</style><img src="${dataUrl}">`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await window.webContents.executeJavaScript('document.images[0].decode()');
  const captured = await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const source = nativeImage.createFromBuffer(captured.toPNG());
  await writeFileWithRetry(path.join(directory, 'logo.png'), source.toPNG());
  const layers = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  await writeFileWithRetry(path.join(directory, 'logo.ico'), createIco(layers));
}

/** Windows 图标文件偶尔会被外壳或实时扫描器短暂占用，有限重试可避免生成流程随机失败。 */
async function writeFileWithRetry(filePath, content) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try { fs.writeFileSync(filePath, content); return; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, attempt * 80)); }
  }
  throw lastError;
}

function createIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach((image, index) => {
    const size = sizes[index]; const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size; header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0; header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, frame: false, transparent: true, width: 256, height: 256, useContentSize: true, webPreferences: { offscreen: true, contextIsolation: true } });
  try {
    for (const plugin of catalog) await renderIcon(window, plugin);
    console.log(`原创图标渲染完成：${catalog.length} 个 SVG、PNG 和多尺寸 ICO。`);
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); window.destroy(); app.exit(1);
  }
});
