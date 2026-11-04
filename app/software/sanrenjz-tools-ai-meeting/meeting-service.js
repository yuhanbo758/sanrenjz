const path = require('path');
const { createRequire } = require('module');

const resources = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
const appRequire = createRequire(path.join(resources, 'app.asar', 'package.json'));
function dependency(name) {
  try { return require(name); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return appRequire(name); }
}

const DOCUMENT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.doc', '.docx', '.xlsx', '.pptx'];
const AUDIO_EXTENSIONS = ['.webm', '.wav', '.mp3', '.m4a', '.mp4', '.ogg'];
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function checkFile(name, size) {
  const extension = path.extname(String(name || '')).toLowerCase();
  const kind = DOCUMENT_EXTENSIONS.includes(extension) ? 'document' : AUDIO_EXTENSIONS.includes(extension) ? 'audio' : '';
  if (!kind) throw new Error(`不支持 ${extension || '无扩展名'} 文件；旧版 .ppt/.xls 请先另存为 .pptx/.xlsx`);
  if (size <= 0) throw new Error('文件为空');
  if (size > (kind === 'audio' ? MAX_AUDIO_BYTES : MAX_DOCUMENT_BYTES)) throw new Error(`单个${kind === 'audio' ? '音频' : '文档'}不能超过 ${kind === 'audio' ? 25 : 20} MB`);
  return kind;
}

function decodeXml(text) {
  return text.replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, decimal, entity) => {
    if (hex || decimal) {
      const code = parseInt(hex || decimal, hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
  });
}

function extractPptx(buffer) {
  const { unzipSync } = dependency('fflate');
  let total = 0;
  const zip = unzipSync(new Uint8Array(buffer), {
    // 只展开幻灯片 XML，限制膨胀后的总量，避免演示文稿内嵌媒体占用内存。
    filter: file => {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(file.name)) return false;
      total += file.originalSize || 0;
      if (total > 40 * 1024 * 1024) throw new Error('PPTX 幻灯片文字过大');
      return true;
    }
  });
  const slides = Object.keys(zip).sort((a, b) => Number(/slide(\d+)/.exec(a)[1]) - Number(/slide(\d+)/.exec(b)[1]));
  if (!slides.length) throw new Error('PPTX 中没有幻灯片');
  return slides.map((name, index) => {
    const xml = Buffer.from(zip[name]).toString('utf8');
    // a:p 对应段落；a:t 对应文字，保留页码和段落边界供模型引用。
    const paragraphs = [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)]
      .map(match => [...match[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map(part => decodeXml(part[1])).join('').trim()).filter(Boolean);
    return `第 ${index + 1} 页\n${paragraphs.join('\n')}`;
  }).join('\n\n');
}

async function extractDocument(name, data) {
  const buffer = Buffer.from(data);
  if (checkFile(name, buffer.length) !== 'document') throw new Error('请选择办公文档');
  const extension = path.extname(name).toLowerCase();
  let text;
  if (extension === '.pptx') text = extractPptx(buffer);
  else if (extension === '.docx') text = (await dependency('mammoth').extractRawText({ buffer })).value;
  else if (extension === '.doc') text = (await new (dependency('word-extractor'))().extract(buffer)).getBody();
  else if (extension === '.xlsx') {
    const readXlsxFile = dependency('read-excel-file/node');
    const sheets = await readXlsxFile.readSheetNames(buffer);
    text = (await Promise.all(sheets.map(async sheet => {
      const rows = await readXlsxFile(buffer, { sheet });
      return `工作表：${sheet}\n${rows.map(row => row.map(cell => cell == null ? '' : String(cell).replace(/[\r\n\t]+/g, ' ')).join('\t')).join('\n')}`;
    }))).join('\n\n');
  } else {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (text.includes('\0')) throw new Error('文件包含二进制内容');
  }
  text = String(text || '').trim();
  if (!text) throw new Error('文件中没有可提取的文字');
  return { name: path.basename(name), text, characters: text.length };
}

function transcriptionUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('语音服务地址必须是 HTTP(S)');
  return `${raw.replace(/\/(?:chat\/completions|responses|audio\/transcriptions)$/, '')}/audio/transcriptions`;
}

async function transcribeAudio({ name, data, model, provider, secret }, fetcher = fetch) {
  const buffer = Buffer.from(data);
  if (checkFile(name, buffer.length) !== 'audio') throw new Error('请选择音频文件');
  if (!String(model || '').trim()) throw new Error('请先填写语音转写模型 ID');
  if (!secret) throw new Error('所选供应商尚未配置 API Key');
  if (provider?.transport === 'opencode' || /^opencode:\/\//i.test(provider?.baseUrl || '')) throw new Error('OpenCode 托管模型不提供此语音转写接口，请选择 OpenAI 兼容供应商');
  const form = new FormData();
  form.set('model', model.trim());
  form.set('file', new Blob([buffer]), path.basename(name));
  form.set('response_format', 'json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetcher(transcriptionUrl(provider.baseUrl), {
      method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: form, signal: controller.signal
    });
    const payload = await response.text();
    if (!response.ok) throw new Error(`语音转写失败（HTTP ${response.status}）：${payload.slice(0, 200)}`);
    let result;
    try { result = JSON.parse(payload); } catch (_) { throw new Error('语音服务未返回 JSON 结果'); }
    if (!String(result.text || '').trim()) throw new Error('语音服务未返回转写文字');
    return result.text.trim();
  } finally { clearTimeout(timer); }
}

module.exports = { DOCUMENT_EXTENSIONS, AUDIO_EXTENSIONS, checkFile, extractDocument, extractPptx, transcriptionUrl, transcribeAudio };
