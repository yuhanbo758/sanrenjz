const assert = require('assert');
const codecs = require('../app/software/sanrenjz-tools-image-optimizer/image-codecs');

function testResolveDimensions() {
  assert.deepStrictEqual(codecs.resolveDimensions(800, 800, 256, 256, true), { width: 256, height: 256 });
  assert.deepStrictEqual(codecs.resolveDimensions(800, 400, 200, '', true), { width: 200, height: 100 });
  assert.deepStrictEqual(codecs.resolveDimensions(800, 400, '', 100, true), { width: 200, height: 100 });
  assert.deepStrictEqual(codecs.resolveDimensions(800, 400, '', '', true), { width: 800, height: 400 });
  assert.deepStrictEqual(codecs.resolveDimensions(800, 400, 256, 256, false), { width: 256, height: 256 });
}

function testIcoContainer() {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const ico = codecs.encodeIco(png, 256, 256);
  const view = new DataView(ico.buffer);
  assert.strictEqual(view.getUint16(0, true), 0);
  assert.strictEqual(view.getUint16(2, true), 1);
  assert.strictEqual(view.getUint16(4, true), 1);
  assert.strictEqual(ico[6], 0, '256 像素在 ICO 目录中必须编码为 0');
  assert.strictEqual(ico[7], 0, '256 像素在 ICO 目录中必须编码为 0');
  assert.strictEqual(view.getUint32(14, true), png.length);
  assert.strictEqual(view.getUint32(18, true), 22);
  assert.deepStrictEqual(Array.from(ico.slice(22)), Array.from(png));
  assert.throws(() => codecs.encodeIco(png, 512, 512), /不能超过 256/);
}

function testBmpPixels() {
  const bmp = codecs.encodeBmp({ width: 1, height: 1, data: Uint8ClampedArray.from([10, 20, 30, 40]) });
  const view = new DataView(bmp.buffer);
  assert.strictEqual(String.fromCharCode(bmp[0], bmp[1]), 'BM');
  assert.strictEqual(view.getUint32(2, true), 58);
  assert.strictEqual(view.getInt32(18, true), 1);
  assert.strictEqual(view.getInt32(22, true), -1);
  assert.deepStrictEqual(Array.from(bmp.slice(54)), [30, 20, 10, 40]);
}

testResolveDimensions();
testIcoContainer();
testBmpPixels();
console.log('image optimizer codec tests passed');
