const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.json', '.docx', '.pdf'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const resources = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
const appRequire = createRequire(path.join(resources, 'app.asar', 'package.json'));

function dependency(name) {
  try { return require(name); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return appRequire(name);
  }
}

function check(name, bytes) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw new Error(`不支持 ${ext || '无扩展名'} 文件`);
  if (bytes > MAX_FILE_BYTES) throw new Error('单个文件不能超过 10 MB');
  return ext;
}

function extractPdf(buffer) {
  return new Promise((resolve, reject) => {
    // PDF 在独立 Node 进程提取，避免解析库在 Electron 页面误判运行环境。
    const child = spawn(process.execPath, [path.join(__dirname, 'writing-pdf-worker.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PDF 解析超时')); }, 45000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { child.kill(); reject(new Error('PDF 提取内容过长')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 1000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || 'PDF 解析失败'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', error => { child.kill(); reject(error); });
    child.stdin.end(buffer);
  });
}

async function extract(name, data) {
  const buffer = Buffer.from(data);
  const ext = check(name, buffer.length);
  let text;
  if (ext === '.pdf') text = await extractPdf(buffer);
  else if (ext === '.docx') text = (await dependency('mammoth').extractRawText({ buffer })).value;
  else {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    text = decoder.decode(buffer).replace(/^\uFEFF/, '');
    if (text.includes('\0')) throw new Error('文件包含二进制内容');
    if (ext === '.json') text = JSON.stringify(JSON.parse(text), null, 2);
  }
  text = String(text || '').trim();
  if (!text) throw new Error('文件没有可提取的文字；扫描版 PDF 请先 OCR');
  if (text.length > 40000) throw new Error('文件提取文字超过 4 万字，请先裁剪内容');
  return { name: path.basename(name), text, characters: text.length };
}

async function read(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('请选择文件');
  check(filePath, stat.size);
  return extract(filePath, await fs.promises.readFile(filePath));
}

module.exports = { EXTENSIONS, MAX_FILE_BYTES, check, extract, read };
