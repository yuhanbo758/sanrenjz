const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createCompletionProfile } = require('./opencode-profile');

const START_TIMEOUT_MS = 20000;
const MAX_ERROR_LENGTH = 600;
const TRANSIENT_RETRY_ATTEMPTS = 3;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trimError(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH);
}

function requestError(status, detail) {
  const message = trimError(detail) || `HTTP ${status}`;
  return new Error(`OpenCode 返回 ${status}：${message}`);
}

function isRetryableOpenCodeError(error) {
  const message = trimError(error?.message || error);
  return /unknown certificate verification error|certificate verification failed|unable to verify the first certificate|econnreset|etimedout|eai_again|fetch failed|socket hang up|connection reset/i.test(message);
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) throw requestError(response.status, text);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('OpenCode 返回了无效 JSON');
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function executableCandidates() {
  const values = [];
  if (process.env.OPENCODE_BIN) values.push(process.env.OPENCODE_BIN);
  if (process.platform === 'win32') {
    if (process.env.APPDATA) values.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
    if (process.env.APPDATA) values.push(path.join(process.env.APPDATA, 'npm', 'opencode.cmd'));
    values.push('opencode.cmd');
  } else {
    values.push('opencode');
  }
  return [...new Set(values.filter(Boolean))];
}

function resolveExecutable() {
  for (const candidate of executableCandidates()) {
    if (!path.isAbsolute(candidate) || fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 OpenCode。请先安装 OpenCode CLI，并至少完成一个供应商认证');
}

function modelCapabilities(model) {
  // OpenCode 旧目录使用 modalities.input 数组；当前 /provider 返回
  // capabilities.input 对象。两种格式都要读取，否则 OpenAI OAuth 模型会被误标为纯文本。
  const legacyInput = Array.isArray(model?.modalities?.input) ? model.modalities.input : [];
  const currentCapabilities = model?.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
  const currentInput = currentCapabilities.input && typeof currentCapabilities.input === 'object'
    ? Object.entries(currentCapabilities.input).filter(([, enabled]) => enabled === true).map(([type]) => type)
    : [];
  const input = [...new Set([...legacyInput, ...currentInput])];
  const capabilities = ['text'];
  if (input.some(value => value === 'image' || value === 'video' || value === 'pdf') || model?.attachment === true || currentCapabilities.attachment === true) {
    capabilities.push('vision');
  }
  if (input.includes('audio')) capabilities.push('audio');
  return capabilities;
}

function parseProviderCatalog(payload) {
  if (!payload || !Array.isArray(payload.all)) throw new Error('OpenCode 模型目录格式无效');
  const connected = new Set(Array.isArray(payload.connected) ? payload.connected.map(String) : []);
  return payload.all
    .filter(provider => provider && connected.has(String(provider.id || '')))
    .map(provider => ({
      id: String(provider.id),
      name: String(provider.name || provider.id),
      transport: 'opencode',
      source: 'opencode',
      managed: true,
      baseUrl: `opencode://${provider.id}`,
      models: Object.entries(provider.models || {}).map(([key, model]) => ({
        id: String(key),
        label: String(model?.name || model?.id || key),
        capabilities: modelCapabilities(model),
        status: String(model?.status || ''),
        reasoning: Boolean(model?.reasoning),
        contextWindow: Number(model?.limit?.context || 0) || undefined
      })).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
    }))
    .filter(provider => provider.models.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function contentParts(content) {
  if (typeof content === 'string') return { text: content, files: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), files: [] };
  const text = [];
  const files = [];
  for (const part of content) {
    if (part?.type === 'text' && part.text) text.push(String(part.text));
    if (part?.type === 'image_url' && part.image_url?.url) {
      const url = String(part.image_url.url);
      const match = /^data:([^;,]+)[^,]*,/i.exec(url);
      files.push({ type: 'file', mime: match?.[1] || 'image/png', filename: 'image', url });
    }
  }
  return { text: text.join('\n'), files };
}

function buildPrompt(messages) {
  const system = [];
  const transcript = [];
  const files = [];
  for (const message of messages || []) {
    const parsed = contentParts(message?.content);
    if (message?.role === 'system') system.push(parsed.text);
    else transcript.push(`${message?.role === 'assistant' ? 'Assistant' : 'User'}:\n${parsed.text}`);
    files.push(...parsed.files);
  }
  const prompt = transcript.join('\n\n').trim();
  return {
    system: [
      ...system.filter(Boolean),
      'This is a direct model-completion request. Do not call tools or modify files. Answer only from the supplied conversation and attachments.'
    ].join('\n\n'),
    parts: [{ type: 'text', text: prompt || '请直接回答。' }, ...files]
  };
}

class OpenCodeRuntime {
  constructor(options = {}) {
    this.fetch = options.fetch || global.fetch;
    this.spawn = options.spawn || spawn;
    this.serverUrl = String(options.serverUrl || '').replace(/\/+$/, '');
    this.child = null;
    this.starting = null;
    this.active = new Map();
    this.pendingRequests = 0;
    this.runtimeDirectory = options.runtimeDirectory || path.join(os.tmpdir(), 'sanrenjz-tools-opencode-runtime');
    this.environment = options.env || process.env;
    this.homeDirectory = options.homeDirectory || os.homedir();
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1500;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;
    this.idleTimer = null;
    this.startController = null;
    this.generation = 0;
  }

  async start() {
    if (this.serverUrl) return this.serverUrl;
    if (this.starting) return this.starting;
    const starting = this._start();
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async _start() {
    if (typeof this.fetch !== 'function') throw new Error('当前运行环境不支持访问 OpenCode Server');
    const generation = this.generation;
    const controller = new AbortController();
    this.startController = controller;
    let child;
    let url;
    try {
      const port = await getFreePort();
      if (controller.signal.aborted || generation !== this.generation) throw new Error('OpenCode 启动已取消');
      const executable = resolveExecutable();
      url = `http://127.0.0.1:${port}`;
      const profile = createCompletionProfile(this.runtimeDirectory, this.environment, this.homeDirectory);
      child = this.spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--log-level', 'ERROR'], {
        cwd: profile.cwd,
        env: profile.env,
        windowsHide: true,
        shell: false,
        // 未消费的 pipe 会塞满并阻塞子进程；模型调用通过 HTTP 返回，无需收集 CLI 输出。
        stdio: ['ignore', 'ignore', 'ignore']
      });
      this.child = child;
      let launchError = '';
      child.once('error', error => { launchError = error.message; });
      child.once('exit', code => {
        if (this.child === child) {
          this.child = null;
          if (this.serverUrl === url) this.serverUrl = '';
        }
        if (!this.serverUrl && !launchError) launchError = `OpenCode Server 已退出（${code ?? 'unknown'}）`;
      });
      const deadline = Date.now() + this.startTimeoutMs;
      while (Date.now() < deadline && !controller.signal.aborted) {
        if (launchError) throw new Error(`无法启动 OpenCode：${launchError}`);
        try {
          await this._requestAt(url, '/provider', { headers: { Accept: 'application/json' }, signal: controller.signal }, Math.min(1500, deadline - Date.now()));
          if (this.child === child && generation === this.generation && !controller.signal.aborted) {
            this.serverUrl = url;
            this._scheduleIdleStop();
            return url;
          }
        } catch (_) {
          if (launchError || controller.signal.aborted) break;
        }
        await delay(Math.min(150, Math.max(0, deadline - Date.now())));
      }
      throw new Error(controller.signal.aborted ? 'OpenCode 启动已取消' : launchError || '启动 OpenCode Server 超时');
    } catch (error) {
      if (this.child === child) this.child = null;
      if (child && !child.killed) child.kill();
      throw error;
    } finally {
      if (this.startController === controller) this.startController = null;
    }
  }

  async _requestAt(baseUrl, pathname, options = {}, timeoutMs = this.requestTimeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    try {
      const response = await this.fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal });
      return await readJson(response);
    } catch (error) {
      if (timedOut && !options.signal?.aborted) throw new Error('OpenCode 请求超时');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  _scheduleIdleStop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.active.size || this.pendingRequests || !this.child || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => { if (!this.active.size && !this.pendingRequests) this.stop(); }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async request(pathname, options = {}) {
    this.pendingRequests += 1;
    try {
      const baseUrl = await this.start();
      clearTimeout(this.idleTimer);
      return await this._requestAt(baseUrl, pathname, options);
    } finally { this.pendingRequests -= 1; this._scheduleIdleStop(); }
  }

  async listModels() {
    return parseProviderCatalog(await this.request('/provider', { headers: { Accept: 'application/json' } }));
  }

  async complete(request = {}) {
    const requestId = String(request.requestId || `${Date.now()}-${Math.random()}`);
    if (this.active.has(requestId)) throw new Error('OpenCode 请求标识正在使用');
    const controller = new AbortController();
    const active = { controller, sessionId: '', baseUrl: '' };
    this.active.set(requestId, active);
    clearTimeout(this.idleTimer);
    let timedOut = false;
    const requestedTimeout = Number(request.timeoutMs || this.requestTimeoutMs);
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Number.isFinite(requestedTimeout) ? Math.max(50, requestedTimeout) : 60000);
    try {
      const baseUrl = await this.start();
      active.baseUrl = baseUrl;
      if (controller.signal.aborted) throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
      const prompt = buildPrompt(request.messages);
      for (let attempt = 0; attempt < TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
        let sessionId = '';
        try {
          const session = await this._requestAt(baseUrl, '/session', {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: 'sanrenjz-tools AI 请求',
              // 供应商接入只需要模型采样，禁止 OpenCode Agent 触发任何本地工具。
              permission: [{ permission: '*', pattern: '*', action: 'deny' }]
            })
          });
          sessionId = String(session?.id || '');
          if (!sessionId) throw new Error('OpenCode 未返回会话 ID');
          active.sessionId = sessionId;
          const result = await this._requestAt(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: { providerID: String(request.providerId || ''), modelID: String(request.modelId || '') },
              tools: { '*': false },
              system: prompt.system,
              parts: prompt.parts
            })
          });
          if (result?.info?.error) {
            const detail = result.info.error?.data?.message || result.info.error?.name || '模型调用失败';
            throw new Error(`OpenCode 模型调用失败：${trimError(detail)}`);
          }
          const text = (result?.parts || [])
            .filter(part => part?.type === 'text' && !part.ignored)
            .map(part => String(part.text || ''))
            .join('');
          if (!text) throw new Error('OpenCode 模型未返回文本内容');
          return { requestId, text, model: String(request.modelId || ''), provider: String(request.providerId || '') };
        } catch (error) {
          if (error?.name === 'AbortError' || controller.signal.aborted) throw error;
          if (attempt >= TRANSIENT_RETRY_ATTEMPTS - 1 || !isRetryableOpenCodeError(error)) throw error;
          // OpenCode 偶发在首个上游连接上返回临时证书错误；保留 TLS 校验并用新会话短暂重试。
          await delay(300 * (attempt + 1));
        } finally {
          active.sessionId = '';
          if (sessionId) {
            // 清理只能访问原服务；stop 后不能经 request/start 意外重启一个新服务。
            if (controller.signal.aborted) {
              await this._requestAt(baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' }, this.cleanupTimeoutMs).catch(() => {});
            }
            await this._requestAt(baseUrl, `/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, this.cleanupTimeoutMs).catch(() => {});
          }
        }
      }
      throw new Error('OpenCode 模型调用失败');
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) throw new Error(timedOut ? 'OpenCode 请求超时，请稍后重试' : '请求已取消');
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.active.get(requestId) === active) this.active.delete(requestId);
      this._scheduleIdleStop();
    }
  }

  cancel(requestId) {
    const active = this.active.get(String(requestId || ''));
    if (!active) return false;
    if (active.sessionId && active.baseUrl) {
      this._requestAt(active.baseUrl, `/session/${encodeURIComponent(active.sessionId)}/abort`, { method: 'POST' }, this.cleanupTimeoutMs).catch(() => {});
    }
    active.controller.abort();
    return true;
  }

  stop() {
    this.generation += 1;
    this.startController?.abort();
    this.startController = null;
    this.starting = null;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    for (const active of this.active.values()) active.controller.abort();
    const child = this.child;
    this.child = null;
    this.serverUrl = '';
    if (child && !child.killed) child.kill();
  }
}

module.exports = { OpenCodeRuntime, buildPrompt, isRetryableOpenCodeError, parseProviderCatalog };
