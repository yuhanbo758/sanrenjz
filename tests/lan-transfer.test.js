const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const transfer = require('../app/software/sanrenjz-tools-lan-transfer/transfer-service');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-transfer-test-'));
  try {
    const started = await transfer.start(directory);
    assert.equal(started.running, true);
    const token = new URL(started.urls[0]).searchParams.get('token');
    const base = `http://127.0.0.1:${started.port}`;
    const url = route => `${base}${route}?token=${token}`;
    assert.equal((await fetch(`${base}/api/state`)).status, 403);
    assert.equal((await fetch(url('/'))).status, 200);

    let response = await fetch(url('/api/text'), { method: 'POST', body: '手机发来的文字' });
    assert.equal(response.status, 200);
    assert.equal(transfer.status().received[0].text, '手机发来的文字');
    response = await fetch(url('/api/text'), { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(response.status, 413);

    response = await fetch(url('/api/file'), { method: 'POST', headers: { 'X-Filename': encodeURIComponent('../测试.txt') }, body: 'file content' });
    assert.equal(response.status, 200);
    const received = transfer.status().received[0];
    assert.equal(received.name, '测试.txt');
    assert.equal(fs.readFileSync(received.file, 'utf8'), 'file content');
    assert.equal(path.dirname(received.file), directory);

    const tooLarge = await new Promise((resolve, reject) => {
      const request = http.request(url('/api/file'), { method: 'POST', headers: { 'X-Filename': 'large.bin', 'Content-Length': String(200 * 1024 * 1024 + 1) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      request.on('error', reject); request.end();
    });
    assert.equal(tooLarge, 413);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.part')).length, 0);

    await new Promise(resolve => {
      const request = http.request(url('/api/file'), { method: 'POST', headers: { 'X-Filename': 'interrupted.bin', 'Content-Length': '1000000' } });
      request.on('error', () => {});
      request.write('partial');
      setTimeout(() => { request.destroy(); resolve(); }, 60);
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.part')).length, 0);

    transfer.shareText('电脑发来的文字');
    await transfer.shareFiles([received.file]);
    let shares = (await (await fetch(url('/api/state'))).json()).shares;
    assert.equal(shares.length, 2);
    assert.equal(shares.find(item => item.kind === 'text').text, '电脑发来的文字');
    const file = shares.find(item => item.kind === 'file');
    response = await fetch(url(`/api/download/${file.id}`));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'file content');
    transfer.removeShare(file.id);
    assert.equal((await fetch(url(`/api/download/${file.id}`))).status, 404);
    await transfer.stop();
    assert.equal(transfer.status().running, false);
    console.log('局域网快传 HTTP 收发、鉴权、限额和分享测试通过');
  } finally {
    await transfer.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
