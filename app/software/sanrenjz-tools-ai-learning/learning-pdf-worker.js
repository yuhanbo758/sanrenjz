const fs = require('fs');
const pdfjs = require('./vendor/pdfjs-dist/build/pdf.js');

(async () => {
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(process.argv[2])), useSystemFonts: true });
  try {
    const document = await task.promise;
    const pages = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
      page.cleanup();
    }
    const text = pages.join('\n\n').trim();
    if (!text) throw new Error('没有提取到文本；扫描版 PDF 需要先进行 OCR');
    process.stdout.write(text);
  } finally { await task.destroy(); }
})().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
