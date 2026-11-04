const { createRequire } = require('module');
const path = require('path');
const resources = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
const appRequire = createRequire(path.join(resources, 'app.asar', 'package.json'));
function dependency(name) {
  try { return require(name); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return appRequire(name); }
}
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  let task;
  try {
    const pdfjs = dependency('pdfjs-dist/build/pdf.js');
    task = pdfjs.getDocument({ data: new Uint8Array(Buffer.concat(chunks)), useSystemFonts: false });
    const document = await task.promise;
    const pages = [];
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' '));
      page.cleanup();
    }
    process.stdout.write(pages.join('\n\n'));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  } finally { if (task) await task.destroy(); }
});
