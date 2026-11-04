const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractDocument, readDocument, checkFile } = require('../app/software/sanrenjz-tools-ai-document/document-service');
const { createXlsxFixture } = require('./ai-document-xlsx-fixture');

(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('PDF sample', { x: 50, y: 700, font: await pdf.embedFont(StandardFonts.Helvetica) });
  // pdf-parse 1.x 使用旧版 PDF.js，测试文档需关闭 PDF 对象流。
  const pdfBytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  assert.match((await extractDocument('sample.pdf', pdfBytes)).text, /PDF sample/);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ai-document-'));
  try {
    const markdown = await extractDocument('notes.md', Buffer.from('# 标题\n正文', 'utf8'));
    assert.equal(markdown.text, '# 标题\n正文');
    assert.equal((await extractDocument('data.json', Buffer.from('{"a":1}'))).text, '{\n  "a": 1\n}');
    assert.equal(checkFile('old.doc', 1), '.doc');
    assert.equal(checkFile('table.xlsx', 1), '.xlsx');
    assert.throws(() => checkFile('large.txt', 21 * 1024 * 1024), /20 MB/);
    await assert.rejects(extractDocument('bad.txt', Buffer.from([0xff, 0xfe])), /utf-8|encoded|valid/i);
    await assert.rejects(extractDocument('empty.txt', Buffer.from('  ')), /没有提取/);

    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word 正文</w:t></w:r></w:p></w:body></w:document>');
    const docx = await zip.generateAsync({ type: 'nodebuffer' });
    assert.match((await extractDocument('sample.docx', docx)).text, /Word 正文/);
    const legacy = path.join(__dirname, 'fixtures', 'ai-document-sample.doc');
    assert.match((await readDocument(legacy)).text, /Legacy Word sample 文档正文/);
    assert.match((await extractDocument('legacy.doc', await fs.promises.readFile(legacy))).text, /文档正文/);
    assert.match((await extractDocument('sample.pdf', pdfBytes)).text, /PDF sample/);
    const layout = await readDocument(path.join(__dirname, 'fixtures', 'ai-document-layout.pdf'));
    assert.match(layout.text, /Document title\n\nFirst paragraph line one\.\nSecond line of paragraph\.\n\nSecond paragraph\./);
    assert.match(layout.text, /Name\tAmount\nAlpha\t100/);
    assert.match(layout.text, /100\n\nSecond page/);
    const xlsx = await createXlsxFixture();
    const sheetText = (await extractDocument('table.xlsx', xlsx)).text;
    assert.match(sheetText, /工作表：销售\n项目\t金额\n苹果\t12\.5/);
    assert.match(sheetText, /工作表：备注\n说明\t第二个工作表/);
    await assert.rejects(extractDocument('invalid.xlsx', Buffer.from('not a spreadsheet')), /./);
    const sheetPath = path.join(temp, 'table.xlsx');
    await fs.promises.writeFile(sheetPath, xlsx);
    assert.equal((await readDocument(sheetPath)).text, sheetText);
    const file = path.join(temp, 'sample.docx');
    await fs.promises.writeFile(file, docx);
    assert.match((await readDocument(file)).text, /Word 正文/);

    console.log('AI 文档阅读器解析测试通过');
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
