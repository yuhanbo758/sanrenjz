'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_SIZES = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// 路径由原250px品牌图的绿人和地弧轮廓矢量化，固定源数据避免反复放大低分辨率PNG。
const LOGO = `<circle fill="#009d4e" cx="107" cy="63.5" r="14"/>
<path fill="#009d4e" d="M71 65C72.33 64.5 72.33 62.83 76 65C79.67 67.17 87.83 75 93 78C98.17 81 102.17 82.5 107 83C111.83 83.5 114.83 83.33 122 81C129.17 78.67 143.33 70.83 150 69C156.67 67.17 159.5 69.33 162 70C164.5 70.67 164.67 71 165 73C165.33 75 167.5 77.5 164 82C160.5 86.5 147.33 96.17 144 100C140.67 103.83 139.83 100.17 144 105C148.17 109.83 164.5 123.33 169 129C173.5 134.67 171.33 136.67 171 139C170.67 141.33 169.33 142.33 167 143C164.67 143.67 164.5 146.17 157 143C149.5 139.83 129.33 127.17 122 124C114.67 120.83 116.17 122 113 124C109.83 126 106.17 134 103 136C99.83 138 96 136.67 94 136C92 135.33 91 137 91 132C91 127 97.17 114.17 94 106C90.83 97.83 76.33 88.17 72 83C67.67 77.83 68.67 77.5 68 75C67.33 72.5 67.5 69.67 68 68C68.5 66.33 69.67 65.5 71 65Z"/>
<path fill="#2b8100" d="M88 139C104.33 137.17 117 138 132 140C147 142 163 145.5 178 151C193 156.5 210.83 166 222 173C233.17 180 248.17 193.17 245 193C241.83 192.83 218.5 177.5 203 172C187.5 166.5 166.33 161.5 152 160C137.67 158.5 126.33 160.5 117 163C107.67 165.5 101.67 175 96 175C90.33 175 89 166 83 163C77 160 68.5 157.67 60 157C51.5 156.33 41.17 157.17 32 159C22.83 160.83 7.67 168 5 168C2.33 168 11.17 161.83 16 159C20.83 156.17 22 154.33 34 151C46 147.67 71.67 140.83 88 139Z"/>`;

function pngSize(buffer) {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('无效PNG资源');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function createIco(images) {
    if (images.length !== ICON_SIZES.length) throw new Error('ICO图层数量不符');
    const header = Buffer.alloc(6 + images.length * 16);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    for (let index = 0; index < images.length; index++) {
        const size = ICON_SIZES[index], entry = 6 + index * 16, png = images[index];
        const dimensions = pngSize(png);
        if (dimensions.width !== size || dimensions.height !== size) throw new Error('ICO图层分辨率不符');
        header[entry] = size === 256 ? 0 : size; header[entry + 1] = size === 256 ? 0 : size;
        header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
        offset += png.length;
    }
    return Buffer.concat([header, ...images]);
}

function inspectIco(buffer) {
    if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error('无效ICO头');
    const count = buffer.readUInt16LE(4), directoryEnd = 6 + count * 16, sizes = [];
    if (!count || directoryEnd > buffer.length) throw new Error('ICO目录被截断');
    let expectedOffset = directoryEnd;
    for (let index = 0; index < count; index++) {
        const entry = 6 + index * 16, width = buffer[entry] || 256, height = buffer[entry + 1] || 256;
        const length = buffer.readUInt32LE(entry + 8), offset = buffer.readUInt32LE(entry + 12);
        if (offset !== expectedOffset || length === 0 || offset + length > buffer.length) throw new Error('ICO图层边界非法');
        const png = pngSize(buffer.subarray(offset, offset + length));
        if (width !== height || png.width !== width || png.height !== height) throw new Error('ICO图层尺寸与目录不符');
        sizes.push(width); expectedOffset = offset + length;
    }
    if (expectedOffset !== buffer.length) throw new Error('ICO存在未登记数据');
    return sizes;
}

function createIcns(images) {
    if (images.length !== ICNS_SIZES.length) throw new Error('ICNS图层数量不符');
    const chunks = images.map((png, index) => {
        const [type, size] = ICNS_SIZES[index], dimensions = pngSize(png);
        if (dimensions.width !== size || dimensions.height !== size) throw new Error('ICNS图层分辨率不符');
        const header = Buffer.alloc(8); header.write(type, 0, 4, 'ascii'); header.writeUInt32BE(8 + png.length, 4);
        return Buffer.concat([header, png]);
    });
    const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    return Buffer.concat([header, ...chunks]);
}

function inspectIcns(buffer) {
    if (buffer.length < 8 || buffer.toString('ascii', 0, 4) !== 'icns' || buffer.readUInt32BE(4) !== buffer.length) throw new Error('无效ICNS头');
    const layers = {}, known = new Map(ICNS_SIZES);
    let offset = 8;
    while (offset < buffer.length) {
        if (offset + 8 > buffer.length) throw new Error('ICNS目录被截断');
        const type = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32BE(offset + 4);
        if (length <= 8 || offset + length > buffer.length || Object.hasOwn(layers, type) || !known.has(type)) throw new Error('ICNS图层非法');
        const dimensions = pngSize(buffer.subarray(offset + 8, offset + length));
        if (dimensions.width !== known.get(type) || dimensions.height !== known.get(type)) throw new Error('ICNS图层尺寸不符');
        layers[type] = dimensions.width; offset += length;
    }
    return layers;
}

function checkAssets(directory = path.join(ROOT, 'build')) {
    const icon = pngSize(fs.readFileSync(path.join(directory, 'icon.png')));
    const background = pngSize(fs.readFileSync(path.join(directory, 'dmg-background.png')));
    const ico = inspectIco(fs.readFileSync(path.join(directory, 'icon.ico')));
    const icns = inspectIcns(fs.readFileSync(path.join(directory, 'icon.icns')));
    if (icon.width !== 1024 || icon.height !== 1024) throw new Error('通用图标必须为1024×1024');
    if (background.width !== 540 || background.height !== 380) throw new Error('DMG背景必须匹配540×380窗口');
    if (ICON_SIZES.some(size => !ico.includes(size)) || icns.ic09 !== 512 || icns.ic10 !== 1024) throw new Error('缺少平台必需图标尺寸');
    return { icon, background, ico, icns };
}

async function generate() {
    const { app, BrowserWindow, nativeImage } = require('electron');
    app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
    const profile = path.join(ROOT, 'dist', '.build-assets-profile'); fs.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
    await app.whenReady();
    const window = new BrowserWindow({ show: false, frame: false, width: 1024, height: 1024, useContentSize: true, backgroundColor: '#ffffff', webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
    const render = async (svg, width, height) => {
        window.setContentSize(width, height);
        const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
        const html = `<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}img{display:block;width:100%;height:100%}</style><img src="${data}">`;
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        await window.webContents.executeJavaScript('document.images[0].decode()');
        await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        // capturePage随系统DPI输出物理像素，统一回指定尺寸，避免开发机缩放影响构建资源。
        return nativeImage.createFromBuffer((await window.webContents.capturePage({ x: 0, y: 0, width, height })).toPNG()).resize({ width, height, quality: 'best' });
    };
    try {
        const icon = await render(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 250 250"><rect width="250" height="250" fill="white"/>${LOGO}</svg>`, 1024, 1024);
        const scaled = size => icon.resize({ width: size, height: size, quality: 'best' }).toPNG();
        fs.writeFileSync(path.join(ROOT, 'build/icon.png'), icon.toPNG());
        fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), createIco(ICON_SIZES.map(scaled)));
        fs.writeFileSync(path.join(ROOT, 'build/icon.icns'), createIcns(ICNS_SIZES.map(([, size]) => scaled(size))));
        const background = await render(`<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#f3faf6"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><rect width="540" height="380" fill="url(#g)"/><g transform="translate(242 0) scale(.224)">${LOGO}</g><text x="270" y="82" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-weight="600" font-size="26" fill="#17452d">三人聚智</text><text x="270" y="108" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="13" fill="#587267">效率工具与 Python 程序管理</text><path d="M242 220H298M287 209L298 220L287 231" fill="none" stroke="#519c72" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><text x="270" y="340" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, sans-serif" font-size="14" fill="#587267">将应用拖到 Applications 文件夹以完成安装</text></svg>`, 540, 380);
        fs.writeFileSync(path.join(ROOT, 'build/dmg-background.png'), background.toPNG());
        console.log(JSON.stringify(checkAssets()));
    } finally { window.destroy(); app.quit(); }
}

function main() {
    if (process.argv.includes('--check')) { console.log(JSON.stringify(checkAssets())); return; }
    if (!process.versions.electron) {
        const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
        const child = spawnSync(require('electron'), [__filename, '--render'], { env, windowsHide: true, stdio: 'inherit' });
        if (child.error) throw child.error;
        process.exitCode = child.status === null ? 1 : child.status;
        return;
    }
    generate().catch(error => { console.error(error); require('electron').app.exit(1); });
}
if (require.main === module) main();
module.exports = { ICON_SIZES, ICNS_SIZES, pngSize, createIco, inspectIco, createIcns, inspectIcns, checkAssets };
