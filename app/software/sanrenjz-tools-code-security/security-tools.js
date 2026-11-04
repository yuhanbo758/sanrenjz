const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const ALGORITHMS = new Set(['md5', 'sha1', 'sha256', 'sha384', 'sha512']);
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';

function strictBase64(value, url = false) {
  const source = String(value).replace(/\s/g, '');
  const normalized = url ? source.replace(/-/g, '+').replace(/_/g, '/') : source;
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1 ||
      (normalized.includes('=') && normalized.length % 4 !== 0)) throw new Error('Base64 内容或填充格式无效');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) throw new Error('Base64 内容无效');
  return bytes;
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function transformText(input, action) {
  const value = String(input);
  if (action === 'base64-encode') return Buffer.from(value).toString('base64');
  if (action === 'base64-decode') return decodeUtf8(strictBase64(value));
  if (action === 'base64url-encode') return Buffer.from(value).toString('base64url');
  if (action === 'base64url-decode') return decodeUtf8(strictBase64(value, true));
  if (action === 'url-encode') return encodeURIComponent(value);
  if (action === 'url-decode') return decodeURIComponent(value);
  if (action === 'hex-encode') return Buffer.from(value).toString('hex');
  if (action === 'hex-decode') {
    const hex = value.replace(/\s/g, '');
    if (!hex || hex.length % 2 || !/^[\da-f]+$/i.test(hex)) throw new Error('HEX 必须由完整的十六进制字节组成');
    return decodeUtf8(Buffer.from(hex, 'hex'));
  }
  if (action === 'unicode-encode') return [...value].map(char => {
    const code = char.codePointAt(0);
    if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, '0')}`;
    const offset = code - 0x10000;
    return `\\u${(0xd800 + (offset >> 10)).toString(16)}\\u${(0xdc00 + (offset & 1023)).toString(16)}`;
  }).join('');
  if (action === 'unicode-decode') return value.replace(/\\u([\da-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  if (action === 'html-encode') return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  if (action === 'html-decode') return value.replace(/&(amp|lt|gt|quot|#39);/gi, token => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[token.toLowerCase()]));
  if (action === 'json-format') return JSON.stringify(JSON.parse(value), null, 2);
  if (action === 'json-minify') return JSON.stringify(JSON.parse(value));
  throw new Error('不支持的编解码操作');
}

function hashText(input, { algorithm = 'sha256', encoding = 'hex', key = '' } = {}) {
  if (!ALGORITHMS.has(algorithm)) throw new Error('不支持的摘要算法');
  if (!['hex', 'base64'].includes(encoding)) throw new Error('不支持的摘要格式');
  const digest = key ? crypto.createHmac(algorithm, String(key)) : crypto.createHash(algorithm);
  return digest.update(String(input), 'utf8').digest(encoding);
}

async function hashFile(filePath, algorithm = 'sha256') {
  if (!ALGORITHMS.has(algorithm)) throw new Error('不支持的摘要算法');
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('请选择普通文件');
  const digest = crypto.createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { name: path.basename(filePath), size: stat.size, algorithm, hex: digest.digest('hex') };
}

async function loadTextFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('请选择普通文件');
  if (stat.size > MAX_TEXT_BYTES) throw new Error('文本文件不能超过 8 MB；大文件请使用文件摘要');
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.includes(0)) throw new Error('检测到二进制内容；请使用文件摘要');
  let text;
  try { text = decodeUtf8(bytes); } catch (_) { throw new Error('仅支持 UTF-8 文本；请先转换文件编码'); }
  return { name: path.basename(filePath), size: stat.size, text: text.replace(/^\uFEFF/, '') };
}

async function encodeFileBase64(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('请选择普通文件');
  if (stat.size > MAX_TEXT_BYTES) throw new Error('文件转 Base64 不能超过 8 MB；大文件请使用文件摘要');
  return { name: path.basename(filePath), size: stat.size, base64: (await fs.promises.readFile(filePath)).toString('base64') };
}

function randomFrom(alphabet, length) {
  const out = [];
  // 拒绝超出整倍数区间的随机字节，避免模运算分布偏差。
  const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
  while (out.length < length) for (const byte of crypto.randomBytes(Math.max(32, length - out.length))) {
    if (byte < ceiling) out.push(alphabet[byte % alphabet.length]);
    if (out.length === length) break;
  }
  return out.join('');
}

function generateIds({ type = 'uuid', count = 8, length = 21 } = {}) {
  count = Number(count); length = Number(length);
  if (!Number.isInteger(count) || count < 1 || count > 200 || !Number.isInteger(length) || length < 4 || length > 128) throw new Error('数量需为 1–200，长度需为 4–128');
  if (type === 'password' && length < 12) throw new Error('随机密码长度至少为 12 位');
  const alphabet = type === 'password' ? 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*' : ID_ALPHABET;
  if (!['uuid', 'nanoid', 'password', 'hex'].includes(type)) throw new Error('不支持的随机值类型');
  return Array.from({ length: count }, () => type === 'uuid' ? crypto.randomUUID() : type === 'hex' ? crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length) : randomFrom(alphabet, length));
}

module.exports = { transformText, hashText, hashFile, loadTextFile, encodeFileBase64, generateIds, MAX_TEXT_BYTES };
