const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('../app/software/sanrenjz-tools-code-security/security-tools');

async function main() {
  const sample = '中文😀 & <';
  for (const [encode, decode] of [['base64-encode', 'base64-decode'], ['base64url-encode', 'base64url-decode'], ['hex-encode', 'hex-decode'], ['unicode-encode', 'unicode-decode'], ['html-encode', 'html-decode']]) {
    assert.strictEqual(tools.transformText(tools.transformText(sample, encode), decode), sample, `${encode} 应能往返`);
  }
  assert.throws(() => tools.transformText('YQ?', 'base64-decode'), /无效/);
  assert.throws(() => tools.transformText('e4b', 'hex-decode'), /HEX/);
  assert.throws(() => tools.transformText('Zh==', 'base64-decode'), /无效/);
  assert.strictEqual(tools.transformText('{"a": 1}', 'json-minify'), '{"a":1}');
  assert.strictEqual(tools.transformText('{"a":1}', 'json-format'), '{\n  "a": 1\n}');
  assert.strictEqual(tools.hashText('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  assert.strictEqual(tools.hashText('abc', { key: 'secret' }), crypto.createHmac('sha256', 'secret').update('abc').digest('hex'));
  const ids = tools.generateIds({ type: 'password', count: 10, length: 32 });
  assert.strictEqual(ids.length, 10);
  assert.ok(ids.every(id => id.length === 32));
  assert.strictEqual(new Set(ids).size, 10);
  assert.throws(() => tools.generateIds({ type: 'password', count: 201 }), /数量/);
  assert.throws(() => tools.generateIds({ type: 'password', length: 8 }), /至少/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-security-'));
  try {
    const textFile = path.join(temp, '文本.txt');
    const binaryFile = path.join(temp, 'binary.bin');
    fs.writeFileSync(textFile, '\uFEFF第一行\n第二行', 'utf8');
    fs.writeFileSync(binaryFile, Buffer.from([0, 255, 1, 2]));
    const loaded = await tools.loadTextFile(textFile);
    assert.strictEqual(loaded.text, '第一行\n第二行');
    assert.strictEqual(loaded.name, '文本.txt');
    await assert.rejects(tools.loadTextFile(binaryFile), /二进制/);
    assert.strictEqual((await tools.encodeFileBase64(binaryFile)).base64, fs.readFileSync(binaryFile).toString('base64'));
    const digest = await tools.hashFile(binaryFile);
    assert.strictEqual(digest.hex, crypto.createHash('sha256').update(fs.readFileSync(binaryFile)).digest('hex'));
    assert.strictEqual(digest.size, 4);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log('code security tests passed');
}
main().catch(error => { console.error(error); process.exit(1); });
