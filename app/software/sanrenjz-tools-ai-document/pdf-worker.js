const chunks = [];
const path = require('path');
const { loadDependency, resolveDependency } = require('./dependency-loader');
const { renderPdfPage } = require('./pdf-layout');
console.warn = (...parts) => process.stderr.write(parts.join(' ') + '\n');
console.log = (...parts) => process.stderr.write(parts.join(' ') + '\n');
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  let task;
  try {
    const pdfjs = loadDependency('pdfjs-dist/build/pdf.js');
    const fonts = path.join(path.dirname(resolveDependency('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
    task = pdfjs.getDocument({ data: new Uint8Array(Buffer.concat(chunks)), useSystemFonts: false, standardFontDataUrl: fonts });
    const document = await task.promise;
    const pages = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(renderPdfPage(content.items));
      page.cleanup();
    }
    process.stdout.write(JSON.stringify({ text: pages.join('\n\n') }));
  } catch (error) {
    process.stderr.write(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    if (task) await task.destroy();
  }
});
