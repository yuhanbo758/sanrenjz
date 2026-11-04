const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../app/software/sanrenjz-tools-file-inspector/inspector-service');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-inspector-'));
  try {
    const left = path.join(root, 'left'), right = path.join(root, 'right');
    fs.mkdirSync(left); fs.mkdirSync(right); fs.mkdirSync(path.join(left, 'sub'));
    fs.writeFileSync(path.join(left, 'a.txt'), 'Alpha\nalpha\n搜索目标', 'utf8');
    fs.writeFileSync(path.join(right, 'a.txt'), 'Alpha\nalpha\n搜索目标', 'utf8');
    fs.writeFileSync(path.join(left, 'sub', 'only.md'), 'nested', 'utf8');
    fs.writeFileSync(path.join(left, 'binary.bin'), Buffer.from([0, 1, 2]));
    const insensitive = await service.search([left], { query: 'alpha', extensions: 'txt' });
    assert.equal(insensitive.matches.length, 2);
    const regex = await service.search([path.join(left, 'a.txt')], { query: '^A.*a$', regex: true, caseSensitive: true });
    assert.equal(regex.matches.length, 1);
    await assert.rejects(service.search([left], { query: '[', regex: true }), SyntaxError);
    const binary = await service.search([left], { query: 'Alpha' });
    assert.equal(binary.skippedBinary, 1);
    const diff = await service.compare(left, right, { hash: true });
    assert.equal(diff.items.find(item => item.relativePath === 'a.txt').status, '相同');
    assert.equal(diff.items.find(item => item.relativePath === path.join('sub', 'only.md')).status, '仅左侧');
    fs.writeFileSync(path.join(right, 'a.txt'), 'changed', 'utf8');
    assert.equal((await service.compare(left, right, { hash: true })).items.find(item => item.relativePath === 'a.txt').status, '不同');
    const tree = await service.tree(left, { maxDepth: 1, extensions: '.txt', format: 'json' });
    assert.equal(tree.count, 1);
    assert.deepEqual(JSON.parse(tree.text).map(item => item.path), ['a.txt']);
    await assert.rejects(service.compare(left, left), /不同目录/);
    console.log('file inspector service tests passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
