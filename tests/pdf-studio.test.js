const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const service = require('../app/software/sanrenjz-tools-pdf-studio/pdf-service');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-studio-'));
  try {
    const input = path.join(root, 'source.pdf');
    const source = await PDFDocument.create();
    [100, 200, 300].forEach(width => source.addPage([width, 400]));
    fs.writeFileSync(input, await source.save());
    assert.deepEqual(service.parsePages('1-2,2', 3), [0, 1, 1]);
    assert.deepEqual(service.parsePages('偶数', 3), [1]);
    assert.throws(() => service.parsePages('4', 3), /超出范围/);
    const items = [{ path: input, range: '1,3', reverse: true }];
    assert.equal((await service.buildPlan(items)).pages, 2);
    const output = path.join(root, 'merged.pdf');
    await service.savePdf(items, { output, rotation: 90 });
    const merged = await PDFDocument.load(fs.readFileSync(output));
    assert.deepEqual(merged.getPages().map(page => page.getWidth()), [300, 100]);
    assert.deepEqual(merged.getPages().map(page => page.getRotation().angle), [90, 90]);
    await assert.rejects(service.savePdf(items, { output: input }), /不能覆盖原始/);
    const split = await service.savePdf(items, { mode: 'split', outputDirectory: root });
    assert.equal(split.outputs.length, 2);
    assert.equal((await PDFDocument.load(fs.readFileSync(split.outputs[0]))).getPageCount(), 1);
    const second = await service.savePdf(items, { mode: 'split', outputDirectory: root });
    assert.notEqual(second.outputs[0], split.outputs[0]);
    console.log('PDF 页面工作台核心验证通过');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
