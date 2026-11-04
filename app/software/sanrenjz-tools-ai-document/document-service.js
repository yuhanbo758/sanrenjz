const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadDependency } = require('./dependency-loader');

const SUPPORTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xlsx', '.txt', '.md', '.markdown', '.csv', '.json', '.log'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function extractPdf(buffer) {
  return new Promise((resolve, reject) => {
    // pdf-parse 1.x 在 Electron 渲染进程中误判为浏览器；用独立 Node 模式进程提取。
    const child = spawn(process.execPath, [path.join(__dirname, 'pdf-worker.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const output = [];
    let outputBytes = 0;
    let errorText = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PDF 解析超时')); }, 60000);
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 40 * 1024 * 1024) { child.kill(); reject(new Error('PDF 提取文字过大')); }
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => { errorText += chunk.toString().slice(0, 1000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(errorText.trim() || 'PDF 解析失败'));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8')).text); }
      catch (error) { reject(new Error('PDF 解析结果无效：' + error.message)); }
    });
    child.stdin.on('error', error => { child.kill(); reject(error); });
    child.stdin.end(buffer);
  });
}

function checkFile(name, size) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new Error(`不支持 ${ext || '无扩展名'} 文件`);
  if (size > MAX_FILE_BYTES) throw new Error('单个文件不能超过 20 MB');
  return ext;
}

async function extractXlsx(buffer) {
  const readXlsxFile = loadDependency('read-excel-file/node');
  const sheets = await readXlsxFile.readSheetNames(buffer);
  const parts = [];
  for (const sheet of sheets) {
    const rows = await readXlsxFile(buffer, { sheet });
    const body = rows.map(row => row.map(value => {
      if (value == null) return '';
      if (value instanceof Date) return value.toISOString().replace(/T00:00:00\.000Z$/, '');
      return String(value).replace(/[\t\r\n]+/g, ' ');
    }).join('\t')).join('\n');
    parts.push(`工作表：${sheet}\n${body}`);
  }
  return parts.join('\n\n');
}

async function extractDocument(name, buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const ext = checkFile(name, buffer.length);
  let text;
  if (ext === '.pdf') {
    text = await extractPdf(buffer);
  } else if (ext === '.doc') {
    // .doc 是 OLE 二进制格式，不能按 UTF-8 或 DOCX ZIP 解码。
    text = (await new (loadDependency('word-extractor'))().extract(buffer)).getBody();
  } else if (ext === '.docx') {
    text = (await loadDependency('mammoth').extractRawText({ buffer })).value;
  } else if (ext === '.xlsx') {
    // 保留工作表边界和行列分隔，便于阅读与向 AI 提问。
    text = await extractXlsx(buffer);
  } else {
    // 文本文件必须是 UTF-8；避免把其他编码或二进制误显示成正文。
    text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) throw new Error('文件不是有效的 UTF-8 文本');
    if (text.includes('\0')) throw new Error('文件包含二进制内容');
    if (ext === '.json') text = JSON.stringify(JSON.parse(text), null, 2);
  }
  text = String(text || '').trim();
  if (!text) throw new Error('没有提取到可阅读文字；扫描版 PDF 需要先进行 OCR');
  return { name: path.basename(name), text, characters: text.length };
}

async function readDocument(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('文件路径无效');
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('请选择文件');
  checkFile(filePath, stat.size);
  return extractDocument(filePath, await fs.promises.readFile(filePath));
}

module.exports = { SUPPORTED_EXTENSIONS, MAX_FILE_BYTES, checkFile, extractDocument, readDocument };
