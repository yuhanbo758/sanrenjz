const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHostsService, inspect } = require('../app/software/sanrenjz-tools-hosts-center/hosts-service');

test('校验 Hosts 行并提示重复域名', () => {
  const report = inspect('# 注释\n127.0.0.1 localhost alias\n::1 localhost\ninvalid bad.local');
  assert.equal(report.entries, 2);
  assert.equal(report.warnings[0].line, 3);
  assert.equal(report.errors[0].line, 4);
});

test('写入前备份、保留 BOM 和 CRLF，并拒绝过期内容', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-center-'));
  try {
    const hostsPath = path.join(root, 'hosts');
    const first = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('127.0.0.1 localhost\r\n')]);
    fs.writeFileSync(hostsPath, first);
    const service = createHostsService({ hostsPath, backupDir: path.join(root, 'backups') });
    const read = await service.read();
    assert.equal(read.bom, true); assert.equal(read.eol, '\r\n');
    const result = await service.write({ ...read, content: read.content + '192.0.2.1 example.test\n' });
    assert.deepEqual(fs.readFileSync(result.backup), first);
    assert.equal(fs.readFileSync(hostsPath, 'utf8'), '\uFEFF127.0.0.1 localhost\r\n192.0.2.1 example.test\r\n');
    await assert.rejects(service.write({ ...read, content: '127.0.0.1 changed.test' }), /其他程序修改/);
    const latest = await service.read();
    await assert.rejects(service.write({ ...latest, content: 'invalid host' }), /第 1 行/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
