const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fflate = require('fflate');
const archive = require('../app/software/sanrenjz-tools-archive-studio/archive-service');

test('多文件与文件夹创建、预览、选择性解压和跳过同名文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-studio-'));
  try {
    const folder = path.join(root, 'docs'); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.txt'), 'A');
    const file = path.join(root, 'b.txt'); fs.writeFileSync(file, 'B');
    const zip = path.join(root, 'sample.zip');
    archive.create([folder, file], zip, 6);
    const summary = archive.inspect(zip);
    assert.deepEqual(summary.entries.map(item => item.name).sort(), ['b.txt', 'docs/a.txt']);
    const output = path.join(root, 'out');
    assert.deepEqual(archive.extract(zip, output, ['docs/a.txt']), { written: 1, skipped: 0, outputDirectory: output });
    assert.equal(fs.readFileSync(path.join(output, 'docs', 'a.txt'), 'utf8'), 'A');
    assert.equal(fs.existsSync(path.join(output, 'b.txt')), false);
    assert.equal(archive.extract(zip, output, ['docs/a.txt']).skipped, 1);
    assert.throws(() => archive.extract(zip, output, ['docs/a.txt'], false), /已有同名文件/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('预览阶段拒绝越界路径与大小写重复路径', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-studio-'));
  try {
    const zip = path.join(root, 'unsafe.zip');
    fs.writeFileSync(zip, fflate.zipSync({ '../escape.txt': fflate.strToU8('bad') }));
    assert.throws(() => archive.inspect(zip), /不安全路径/);
    fs.writeFileSync(zip, fflate.zipSync({ 'A.txt': fflate.strToU8('A'), 'a.txt': fflate.strToU8('a') }));
    assert.throws(() => archive.inspect(zip), /重复路径/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
