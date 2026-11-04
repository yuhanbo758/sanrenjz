const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ICON_SIZES, ICNS_SIZES, pngSize, inspectIco, inspectIcns, checkAssets } = require('../scripts/prepare-build-assets.cjs');
const build = path.resolve(__dirname, '../build');

test('实际跨平台图标和DMG背景包含要求的尺寸', () => {
    const assets = checkAssets(build);
    assert.deepEqual(assets.icon, { width: 1024, height: 1024 });
    assert.deepEqual(assets.background, { width: 540, height: 380 });
    assert.deepEqual(assets.ico, ICON_SIZES);
    assert.deepEqual(Object.entries(assets.icns), ICNS_SIZES);
});

test('PNG校验拒绝不完整图片头', () => {
    assert.throws(() => pngSize(Buffer.alloc(32)), /PNG/);
});

test('ICO图层截断及目录伪造不能通过', () => {
    const icon = fs.readFileSync(path.join(build, 'icon.ico'));
    assert.throws(() => inspectIco(icon.subarray(0, icon.length - 1)), /边界/);
    const corrupt = Buffer.from(icon); corrupt.writeUInt32LE(1, 18);
    assert.throws(() => inspectIco(corrupt), /边界/);
});

test('ICNS整体长度和图层长度必须完整', () => {
    const icon = fs.readFileSync(path.join(build, 'icon.icns'));
    assert.throws(() => inspectIcns(icon.subarray(0, icon.length - 1)), /ICNS/);
    const corrupt = Buffer.from(icon); corrupt.writeUInt32BE(0, 12);
    assert.throws(() => inspectIcns(corrupt), /图层/);
});

test('ICNS图层格式名和分辨率不能互相冒用', () => {
    const corrupt = Buffer.from(fs.readFileSync(path.join(build, 'icon.icns')));
    corrupt.write('ic10', 8, 4, 'ascii');
    assert.throws(() => inspectIcns(corrupt), /尺寸/);
});
