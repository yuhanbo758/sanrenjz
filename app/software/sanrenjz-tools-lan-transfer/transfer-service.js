const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_SHARES = 50;
let session = null;

function fileName(value) {
  let name;
  try { name = decodeURIComponent(String(value || '')); } catch { throw new Error('文件名编码无效'); }
  name = path.basename(name.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!name || name === '.' || name === '..') throw new Error('文件名无效');
  return name;
}

function publicState() {
  if (!session) return { running: false, received: [], shares: [], urls: [] };
  const port = session.server.address()?.port;
  const addresses = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'));
  return {
    running: true,
    port,
    urls: addresses.map(item => `http://${item.address}:${port}/?token=${session.token}`),
    received: session.received.slice(),
    shares: session.shares.map(({ id, name, bytes, kind, text }) => ({ id, name, bytes, kind, text }))
  };
}

function reply(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function receive(request, response, state, kind) {
  const limit = kind === 'text' ? MAX_TEXT : MAX_UPLOAD;
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > limit) return reply(response, 413, { error: '内容超过大小限制' });
  const name = kind === 'file' ? fileName(request.headers['x-filename']) : '';
  const temporary = kind === 'file' ? path.join(state.directory, `.lan-transfer-${crypto.randomUUID()}.part`) : '';
  let handle;
  let bytes = 0;
  const chunks = [];
  try {
    if (temporary) handle = await fs.promises.open(temporary, 'wx');
    // 边读边限额并写入临时文件，只有完整接收后才改名为正式文件。
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('内容超过大小限制');
      if (handle) await handle.writeFile(chunk);
      else chunks.push(chunk);
    }
    if (handle) {
      await handle.close(); handle = null;
      const target = path.join(state.directory, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name}`);
      await fs.promises.rename(temporary, target);
      state.received.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), file: target, name, bytes, kind });
    } else {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) throw new Error('文字不能为空');
      state.received.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), text, bytes, kind });
    }
    state.received.length = Math.min(state.received.length, 100);
    reply(response, 200, { ok: true });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await fs.promises.rm(temporary, { force: true }).catch(() => {});
    if (!response.headersSent) reply(response, error.message.includes('大小限制') ? 413 : 400, { error: error.message });
  }
}

async function handleRequest(request, response, state) {
  const url = new URL(request.url, 'http://localhost');
  if (url.searchParams.get('token') !== state.token) return reply(response, 403, { error: '链接无效或会话已结束' });
  if (request.method === 'GET' && url.pathname === '/') {
    return reply(response, 200, await fs.promises.readFile(path.join(__dirname, 'phone.html')), 'text/html; charset=utf-8');
  }
  if (request.method === 'GET' && url.pathname === '/api/state') {
    return reply(response, 200, { shares: publicState().shares, maxUpload: MAX_UPLOAD });
  }
  if (request.method === 'POST' && url.pathname === '/api/text') return receive(request, response, state, 'text');
  if (request.method === 'POST' && url.pathname === '/api/file') return receive(request, response, state, 'file');
  if (request.method === 'GET' && url.pathname.startsWith('/api/download/')) {
    const share = state.shares.find(item => item.id === url.pathname.slice('/api/download/'.length) && item.kind === 'file');
    if (!share) return reply(response, 404, { error: '分享文件不存在' });
    let stat;
    try { stat = await fs.promises.stat(share.file); } catch { return reply(response, 404, { error: '原文件已移动或删除' }); }
    if (!stat.isFile()) return reply(response, 404, { error: '原文件不可读取' });
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(share.name)}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(share.file).on('error', () => response.destroy()).pipe(response);
    return;
  }
  reply(response, 404, { error: '地址不存在' });
}

async function start(directory) {
  if (session) return publicState();
  const resolved = path.resolve(String(directory || ''));
  if (!directory) throw new Error('请选择保存目录');
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('保存目录不存在');
  await fs.promises.access(resolved, fs.constants.W_OK);
  const state = { directory: resolved, token: crypto.randomBytes(24).toString('base64url'), received: [], shares: [], server: null };
  state.server = http.createServer((request, response) => {
    handleRequest(request, response, state).catch(error => {
      if (!response.headersSent) reply(response, 500, { error: error.message });
      else response.destroy();
    });
  });
  state.server.requestTimeout = 5 * 60 * 1000;
  try {
    await new Promise((resolve, reject) => {
      state.server.once('error', reject);
      state.server.listen(0, '0.0.0.0', resolve);
    });
  } catch (error) {
    state.server.close();
    throw error;
  }
  session = state;
  return publicState();
}

async function stop() {
  const state = session;
  session = null;
  if (state) {
    state.server.closeAllConnections();
    await new Promise(resolve => state.server.close(resolve));
  }
  return publicState();
}

function requireSession() {
  if (!session) throw new Error('请先启动接收站');
  return session;
}

function shareText(text) {
  const state = requireSession();
  const value = String(text || '').trim();
  if (!value || Buffer.byteLength(value) > MAX_TEXT) throw new Error('文字不能为空且不能超过 1 MB');
  state.shares.unshift({ id: crypto.randomUUID(), kind: 'text', name: value.slice(0, 32), text: value, bytes: Buffer.byteLength(value) });
  state.shares.length = Math.min(state.shares.length, MAX_SHARES);
  return publicState();
}

async function shareFiles(paths) {
  const state = requireSession();
  if ((paths || []).length > MAX_SHARES) throw new Error(`一次最多分享 ${MAX_SHARES} 个文件`);
  const selected = [];
  for (const file of paths || []) {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('只能分享普通文件');
    selected.push({ id: crypto.randomUUID(), kind: 'file', name: path.basename(file), file, bytes: stat.size });
  }
  state.shares.unshift(...selected.reverse());
  state.shares.length = Math.min(state.shares.length, MAX_SHARES);
  return publicState();
}

function removeShare(id) {
  const state = requireSession();
  state.shares = state.shares.filter(item => item.id !== id);
  return publicState();
}

module.exports = { start, stop, status: publicState, shareText, shareFiles, removeShare, MAX_UPLOAD };
