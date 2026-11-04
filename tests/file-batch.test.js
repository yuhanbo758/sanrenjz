const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const batch = require('../app/software/sanrenjz-tools-file-batch/batch-service');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-batch-'));
  try {
    const nested = path.join(root, '子目录'); fs.mkdirSync(nested);
    const a = path.join(root, '甲 1.TXT');
    const b = path.join(root, '乙 2.TXT');
    const c = path.join(nested, '丙.txt');
    fs.writeFileSync(a, 'alpha'); fs.writeFileSync(b, 'beta'); fs.writeFileSync(c, 'gamma');
    assert.equal(batch.collect([root]).length, 2);
    assert.equal(batch.collect([root], true).length, 3);
    const files = batch.collect([a, b]);
    const plan = batch.planRename(files, { find: '\\s+\\d', replace: '', regex: true, prefix: '档案-', number: true, padding: 3, extensions: 'txt', caseMode: 'lower' });
    assert.equal(plan.length, 2);
    assert.ok(plan.every(row => row.after.startsWith('档案-00') && row.after.endsWith('.TXT')));
    assert.throws(() => batch.planRename(files, { find: '.+', replace: '同名', regex: true }), /目标文件冲突/);
    assert.throws(() => batch.planRename(files, { prefix: '../' }), /文件名无效/);
    const stale = batch.planRename(files, { prefix: '前-' });
    fs.appendFileSync(a, '!');
    assert.throws(() => batch.executeRename(stale), /源文件已变化/);
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
    const fresh = batch.planRename(files, { prefix: '前-' });
    const originalRename = fs.renameSync;
    let failed = false;
    fs.renameSync = function(from, to) {
      if (!failed && to === fresh[1].to) { failed = true; throw new Error('模拟目标写入失败'); }
      return originalRename.call(fs, from, to);
    };
    try { assert.throws(() => batch.executeRename(fresh), /模拟目标写入失败/); }
    finally { fs.renameSync = originalRename; }
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
    assert.equal(fs.readdirSync(root).filter(name => name.includes('.sanrenjz-rename-')).length, 0);
    assert.equal(batch.executeRename(fresh), 2);
    assert.ok(fresh.every(row => fs.existsSync(row.to) && !fs.existsSync(row.from)));
    const hashes = await batch.checksum(fresh.map(row => row.to));
    assert.equal(hashes.length, 2);
    assert.ok(hashes.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
    console.log('文件批处理服务测试通过');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
