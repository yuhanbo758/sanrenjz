'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');
const requireHost = require('module').createRequire(path.join(require('electron').app.getAppPath(), 'package.json'));
const selfsigned = requireHost('selfsigned');
const { WebSocket, WebSocketServer } = requireHost('ws');
const { VERSION, equal, parse, localAddress } = require('./protocol');
const { ChatService } = require('./chat-service');
const MAX_FILE = 512 * 1024 * 1024;
class RemoteService {
  constructor(options) {
    Object.assign(this, options);
    this.chat = new ChatService(this);
    this.directory = path.join(this.app.getPath('userData'), 'remote-control');
    this.uploads = new Map(); this.downloads = new Map();
    this.client = null; this.server = null; this.discovery = null;
    this.pairCode = null; this.error = ''; this.requests = new Map();
    this.lifecycle = Promise.resolve();
  }
  settings() { const saved = this.loadSettings().remoteControl || {}; return { enabled: saved.enabled === true, port: Number(saved.port || 19876) }; }
  async loadIdentity() {
    if (this.identity) return;
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能启动远程控制');
    await fs.promises.mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, 'identity.bin');
    if (fs.existsSync(file)) this.identity = JSON.parse(this.safeStorage.decryptString(await fs.promises.readFile(file)));
    else {
      const tls = selfsigned.generate([{ name: 'commonName', value: 'sanrenjz-tools-local' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
      this.identity = { pcId: crypto.randomUUID(), tls: { key: tls.private, cert: tls.cert }, devices: [] };
      await this.persist();
    }
    this.fingerprint = new crypto.X509Certificate(this.identity.tls.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  }
  async persist() {
    const file = path.join(this.directory, 'identity.bin'), temporary = file + '.tmp';
    await fs.promises.writeFile(temporary, this.safeStorage.encryptString(JSON.stringify(this.identity)));
    await fs.promises.rename(temporary, file);
  }
  addresses() {
    return [...new Set(Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal && localAddress(item.address)).map(item => `wss://${item.address}:${this.settings().port}/ws`))];
  }
  status() {
    return { running: Boolean(this.server?.listening), settings: this.settings(), pcId: this.identity?.pcId, addresses: this.addresses(), connectedDevice: this.client?.device.name || null, error: this.error, devices: (this.identity?.devices || []).map(({ id, name, createdAt }) => ({ id, name, createdAt })) };
  }
  // 启动包含异步证书读取，必须将整个生命周期串行化，避免重复监听或关闭新实例。
  transition(action) {
    const result = this.lifecycle.then(action);
    this.lifecycle = result.catch(() => {});
    return result;
  }
  configure(settings) {
    const port = Number(settings.port || 19876);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535');
    const next = { enabled: settings.enabled === true, port };
    return this.transition(async () => {
      const all = this.loadSettings(); all.remoteControl = next;
      this.saveSettings(all); await this._stop(); if (next.enabled) await this._start(); return this.status();
    });
  }
  start() { return this.transition(() => this._start()); }
  listenError(error) {
    const detail = error.code === 'EADDRINUSE'
      ? `手机遥控端口 ${this.settings().port} 已被其他服务占用，请在设置中更换端口或关闭占用程序。`
      : `手机遥控服务启动失败：${error.message}`;
    this.error = detail;
    return Object.assign(new Error(detail), { code: error.code });
  }
  async _start() {
    if (this.server?.listening) return this.status();
    try {
      await this.loadIdentity();
      this.server = https.createServer(this.identity.tls, (_request, response) => { response.writeHead(404); response.end(); });
      this.wss = new WebSocketServer({ server: this.server, path: '/ws', maxPayload: 1024 * 1024 });
      // ws 会转发 HTTP Server 的 error；两个发射器都要处理，不能只等待 listen 的拒绝。
      this.wss.on('error', error => { this.listenError(error); });
      this.server.on('error', error => { this.listenError(error); });
      this.wss.on('connection', (socket, request) => { if(!localAddress(request.socket.remoteAddress)||this.wss.clients.size>32){socket.close(4003,'仅允许局域网连接');return;} this.accept(socket); });
      await new Promise((resolve, reject) => {
        const server = this.server;
        const onError = error => { server.removeListener('listening', onListen); reject(error); };
        const onListen = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListen);
        server.listen(this.settings().port, '0.0.0.0');
      });
      this.discovery = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.discovery.on('error', () => {});
      this.discovery.on('message', (message, remote) => {
        if (!localAddress(remote.address)||message.toString() !== 'SANRENJZ_REMOTE_DISCOVER_V1' || message.length > 64) return;
        const reply = JSON.stringify({ v: VERSION, name: os.hostname(), pcId: this.identity.pcId, port: this.settings().port });
        this.discovery.send(reply, remote.port, remote.address);
      });
      this.discovery.bind(19875);
      this.timer = setInterval(() => {
        for (const socket of this.wss.clients) { if (socket.isAlive === false) socket.terminate(); else { socket.isAlive = false; socket.ping(); } }
      }, 15000);
      this.error = ''; return this.status();
    } catch (error) { const reported = this.listenError(error); await this._stop(); throw reported; }
  }
  async pairing() {
    if (!this.server) throw new Error('请先启用局域网远程控制');
    this.pairCode = { code: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + 120000 };
    return { v: VERSION, pcId: this.identity.pcId, name: os.hostname(), addresses: this.addresses(), fingerprint: this.fingerprint, ...this.pairCode };
  }
  accept(socket) {
    socket.on('error', () => {});
    socket.isAlive = true; socket.on('pong', () => { socket.isAlive = true; });
    let authorized = false, failures = 0;
    const timeout = setTimeout(() => { if (!authorized) socket.close(4001, '认证超时'); }, 10000);
    socket.on('message', async raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!authorized) {
          if (message.type === 'pair') {
            if (!this.pairCode || Date.now() > this.pairCode.expiresAt || !equal(message.code, this.pairCode.code)) throw new Error('配对码无效或已过期');
            const device = { id: crypto.randomUUID(), name: String(message.name || 'Android 手机').slice(0, 80), token: crypto.randomBytes(32).toString('base64'), createdAt: new Date().toISOString() };
            this.identity.devices.push(device); this.pairCode = null; await this.persist();
            socket.send(JSON.stringify({ type: 'paired', value: { ...device, pcId: this.identity.pcId } }));
            return;
          }
          const device = this.identity.devices.find(item => equal(item.id, message.deviceId) && equal(item.token, message.token));
          if (message.type !== 'hello' || !device) throw new Error('设备未配对或已撤销');
          authorized = true; clearTimeout(timeout);
          await this.activate({ socket, device, send: value => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); } });
          return;
        }
        if (this.client?.socket !== socket) throw new Error('该会话已被替换');
        await this.incoming(message);
      } catch (error) { socket.send(JSON.stringify({ type: 'error', value: error.message })); if (++failures >= 3) socket.close(4003, '认证失败'); }
    });
    socket.once('close', () => { clearTimeout(timeout); if (this.client?.socket === socket) this.disconnected(); });
  }
  async activate(client) {
    clearTimeout(this.disconnectTimer);
    this.mirror?.stop('控制连接已重新建立');
    const previous = this.client; this.client = client;
    if (previous?.socket && previous.socket !== client.socket) previous.socket.close(4000, '已在另一连接恢复');
    if (previous?.device.id !== client.device.id) this.requests.clear();
    this.send({ type: 'ready', value: { v: VERSION, name: os.hostname(), pcId: this.identity.pcId, mode: 'lan' } });
    this.send({ type: 'chat-state', value: this.chat.status(client.device.id) });
  }
  send(value) { this.client?.send(value); }
  async incoming(message) {
    if (message.type === 'request') await this.request(message.value);
    else if(message.type==='mirror-frame'||message.type==='mirror-audio'){
      // 停止后管道中可能仍有少量画面，丢弃过期帧，不能误报错误或断开聊天连接。
      if(!this.mirror?.session||this.mirror.session.id!==message.value?.id)return;
      this.mirror.receive(this.client.device.id,message.value,message.type==='mirror-audio');
    }
    else if(message.type==='mirror-capabilities')this.mirror?.capabilities(this.client.device.id,message.value);
    else if(message.type==='mirror-input-result')this.mirror?.inputResult(this.client.device.id,message.value);
    else if (message.type === 'ping') this.send({ type: 'pong' });
    else throw new Error('不支持的消息类型');
  }
  async request(raw) {
    const client = this.client;
    if (!client) throw new Error('连接已断开');
    let request;
    try {
      request = parse(raw);
      // 保留同一连接的请求结果；重发不得再次执行模型、文件或播放操作。
      if (!this.requests.has(request.id)) {
        if (this.requests.size >= 1000) this.requests.delete(this.requests.keys().next().value);
        const execute = () => { if (this.client !== client) throw new Error('会话已失效'); return this.dispatch(request.method, request.params); };
        const task = Promise.resolve().then(execute);
        this.requests.set(request.id, task.then(value => ({ v: VERSION, id: request.id, result: value })).catch(error => ({ v: VERSION, id: request.id, error: error.message })));
      }
      const reply = await this.requests.get(request.id);
      if (client !== this.client) return;
      this.send({ type: 'result', value: reply });
      return reply;
    } catch (error) { this.send({ type: 'error', value: error.message }); return { error: error.message }; }
  }
  async catalog() {
    const entries = await fs.promises.readdir(this.manager.pluginDir, { withFileTypes: true }), plugins = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(this.manager.pluginDir, entry.name);
      try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, 'plugin.json'), 'utf8'));
        plugins.push({ id: entry.name, name: manifest.pluginName || entry.name, description: manifest.description || '', version: manifest.version, compatibility: 'computer-only', features: (manifest.features || []).map(feature => ({ code: feature.code, name: feature.explain || feature.code })) });
      } catch (_) {}
    }
    return plugins;
  }
  async dispatch(method, params) {
    if (method === 'catalog') return this.catalog();
    const deviceId = this.client.device.id;
    if (method === 'chat-tools') return this.chat.catalog();
    if (method === 'chat-models') return this.chat.models();
    if (method === 'chat') return this.chat.start(params, deviceId);
    if (method === 'chat-status') return this.chat.status(deviceId);
    if (method === 'chat-history') return this.chat.history(deviceId, params.conversationId);
    if (method === 'chat-cancel') return this.chat.cancel(params.id, deviceId);
    if (method === 'chat-confirm') return this.chat.confirm(params, deviceId);
    if (method === 'file-select') return this.chat.selectFile(params, deviceId);
    if (method === 'files') return this.listFiles(params.path);
    if (method === 'upload-start') return this.uploadStart(params);
    if (method === 'upload-chunk') return this.uploadChunk(params);
    if (method === 'upload-end') return this.uploadEnd(params.id);
    if (method === 'download') return this.download(params);
    if (method === 'account') return this.accountStatus ? this.accountStatus() : { message: '账号登录请在电脑完成' };
    if (method === 'settings') return { version: this.app.getVersion(), connection: '局域网', message: '电脑提权、登录和外部程序交互请在电脑完成' };
    if (method.startsWith('cast-') || method.startsWith('mirror-')) {
      if (!this.castPlugins) throw new Error('电脑未安装媒体投放接收器');
      return this.castPlugins.request(method, params);
    }
    throw new Error('不支持的操作');
  }
  async listFiles(directory) {
    if (!directory) return { path: '', entries: [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).filter(root => fs.existsSync(root)).map(root => ({ name: root, path: root, directory: true })) };
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.startsWith('\\\\')) throw new Error('请选择电脑本地目录');
    const real = await fs.promises.realpath(directory), info = await fs.promises.stat(real);
    if (!info.isDirectory()) throw new Error('目标不是目录');
    const entries = await fs.promises.readdir(real, { withFileTypes: true });
    return { path: real, parent: path.dirname(real), entries: entries.filter(entry => !entry.isSymbolicLink()).slice(0, 500).map(entry => ({ name: entry.name, path: path.join(real, entry.name), directory: entry.isDirectory() })) };
  }
  async uploadStart(params) {
    const name = path.basename(String(params.name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const size = Number(params.size);
    if (!name || name.length > 180 || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE || this.uploads.size >= 30) throw new Error('文件名、大小或上传数量超出限制');
    const id = crypto.randomUUID(), directory = path.join(this.directory, 'received');
    await fs.promises.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${id}-${name}`);
    const handle = await fs.promises.open(target + '.part', 'wx');
    this.uploads.set(id, { path: target, handle, name, size, received: 0, deviceId: this.client.device.id });
    return { id };
  }
  async uploadChunk(params) {
    const upload = this.uploads.get(params.id);
    if (!upload || upload.deviceId !== this.client.device.id || upload.complete || upload.busy || Number(params.offset) !== upload.received) throw new Error('上传顺序无效');
    const buffer = Buffer.from(String(params.data || ''), 'base64');
    if (buffer.length > 65536 || upload.received + buffer.length > upload.size) throw new Error('上传分片超出限制');
    upload.busy=true;
    try{await upload.handle.write(buffer); upload.received += buffer.length; return { received: upload.received };}finally{upload.busy=false;}
  }
  async uploadEnd(id) {
    const upload = this.uploads.get(id);
    if (!upload || upload.deviceId !== this.client.device.id || upload.busy || upload.received !== upload.size) throw new Error('上传尚未完成');
    if(upload.complete)return{id,name:upload.name};
    await upload.handle.close(); upload.handle = null;
    await fs.promises.rename(upload.path + '.part', upload.path); upload.complete = true;
    return { id, name: upload.name };
  }
  async download(params) {
    const item = this.downloads.get(params.id);
    if (!item || item.deviceId !== this.client.device.id) throw new Error('下载任务不可用');
    const offset = Number(params.offset || 0), info = await fs.promises.stat(item.path);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size) throw new Error('下载位置无效');
    const file = await fs.promises.open(item.path, 'r');
    try { const data = Buffer.alloc(Math.min(32768, info.size - offset)); const { bytesRead } = await file.read(data, 0, data.length, offset); return { name: path.basename(item.path), size: info.size, offset, data: data.subarray(0, bytesRead).toString('base64'), done: offset + bytesRead >= info.size }; }
    finally { await file.close(); }
  }
  async revoke(id) {
    if (!this.identity) await this.loadIdentity();
    this.identity.devices = this.identity.devices.filter(device => device.id !== id); await this.persist();
    this.chat.revoke(id);
    if(this.mirror?.session?.deviceId===id)this.mirror.stop('设备已撤销');
    if (this.client?.device.id === id) { this.send({ type: 'revoked', value: '电脑已撤销此设备，请重新扫码配对' }); this.client.socket?.close(4003, '设备已撤销'); await this.release(); }
    return this.status();
  }
  disconnected() { this.mirror?.stop('局域网连接已断开');this.disconnectTimer = setTimeout(() => this.release().catch(() => {}), 15000); }
  async release() {
    this.client = null; this.requests.clear();
    for (const [id, item] of this.uploads) if (!item.complete) { await item.handle?.close().catch(() => {}); await fs.promises.unlink(item.path + '.part').catch(() => {}); this.uploads.delete(id); }
  }
  stop() { return this.transition(() => this._stop()); }
  async _stop() {
    this.mirror?.stop('电脑遥控服务已停止');
    this.chat.stop();
    clearInterval(this.timer); clearTimeout(this.disconnectTimer);
    const server = this.server; this.server = null;
    if (this.discovery) { try { this.discovery.close(); } catch (_) {} this.discovery = null; }
    if (this.wss) { for (const socket of this.wss.clients) socket.terminate(); this.wss.close(); this.wss = null; }
    if (server) await new Promise(resolve => server.close(resolve));
    await this.release();
  }
}
module.exports = { RemoteService, MAX_FILE };
