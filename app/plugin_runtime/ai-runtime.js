const { ipcRenderer } = require('electron');

const STORAGE_NAME = 'AI 共享配置中心';
const CONFIG_KEY = 'runtime-config';
const DEFAULT_CONFIG = {
  schemaVersion: 1,
  providers: [{
    id: 'openai', name: 'OpenAI 兼容服务', baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', capabilities: ['text', 'vision'] }]
  }],
  selections: { text: { providerId: 'openai', modelId: 'gpt-4o-mini' }, vision: { providerId: 'openai', modelId: 'gpt-4o-mini' } },
  timeoutMs: 60000
};

const API_STYLES = ['openai', 'anthropic', 'responses'];

const activeRequests = new Map();

function safeClone(value) { return JSON.parse(JSON.stringify(value)); }
function normalizeBaseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function isOpenCodeProvider(provider) {
  return provider?.transport === 'opencode'
    || provider?.source === 'opencode'
    || /^opencode:\/\//i.test(String(provider?.baseUrl || '').trim());
}

function openCodeProviderId(provider) {
  if (provider?.sourceProviderId) return String(provider.sourceProviderId);
  const route = /^opencode:\/\/([^/?#]+)/i.exec(String(provider?.baseUrl || '').trim());
  if (route?.[1]) return decodeURIComponent(route[1]);
  return String(provider?.id || '').replace(/^opencode:/i, '');
}

function normalizeConfig(config) {
  const next = { ...safeClone(DEFAULT_CONFIG), ...safeClone(config || {}) };
  next.providers = (Array.isArray(next.providers) ? next.providers : []).map(provider => {
    if (!isOpenCodeProvider(provider)) return provider;
    return {
      ...provider,
      transport: 'opencode',
      source: 'opencode',
      managed: true,
      sourceProviderId: openCodeProviderId(provider),
      models: (Array.isArray(provider.models) ? provider.models : []).map(model => ({
        ...model,
        sourceModelId: model.sourceModelId || model.id
      }))
    };
  });
  return next;
}
function errorMessage(error) {
  if (error?.name === 'AbortError') return '请求已取消';
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map(part => (part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n');
}

function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const blocks = [];
  for (const part of content) {
    if (part?.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    else if (part?.type === 'image_url' && part.image_url?.url) {
      const dataUrl = part.image_url.url;
      const match = /^data:([^;,]+);([^,]+),(.+)$/s.exec(dataUrl);
      if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[3] } });
      else blocks.push({ type: 'image', source: { type: 'url', url: dataUrl } });
    }
  }
  return blocks.length ? blocks : '';
}

function toAnthropicPayload(messages) {
  let system = '';
  const converted = [];
  for (const message of messages || []) {
    if (message.role === 'system') { system += (system ? '\n' : '') + contentToText(message.content); continue; }
    converted.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(message.content) });
  }
  return { system: system || undefined, messages: converted };
}

function toResponsesContent(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'input_text', text: String(content ?? '') }];
  const parts = [];
  for (const part of content) {
    if (part?.type === 'text') parts.push({ type: 'input_text', text: part.text || '' });
    else if (part?.type === 'image_url') parts.push({ type: 'input_image', image_url: part.image_url?.url || '' });
  }
  return parts.length ? parts : [{ type: 'input_text', text: '' }];
}

function toResponsesPayload(messages) {
  let instructions = '';
  const input = [];
  for (const message of messages || []) {
    if (message.role === 'system') { instructions += (instructions ? '\n' : '') + contentToText(message.content); continue; }
    input.push({ type: 'message', role: message.role === 'assistant' ? 'assistant' : 'user', content: toResponsesContent(message.content) });
  }
  return { instructions: instructions || undefined, input };
}

async function getConfig() {
  const stored = await ipcRenderer.invoke('plugin-storage-get-async', STORAGE_NAME, CONFIG_KEY);
  if (!stored || stored.schemaVersion !== 1) return safeClone(DEFAULT_CONFIG);
  // 旧版屏幕翻译曾在保存时剥离 OpenCode 路由字段；以 opencode:// 为不可歧义的恢复依据。
  return normalizeConfig(stored);
}

async function saveConfig(config) {
  const next = { ...normalizeConfig(config), schemaVersion: 1 };
  await ipcRenderer.invoke('plugin-storage-set-async', STORAGE_NAME, CONFIG_KEY, next);
  return next;
}

async function saveProviderSecret(providerId, value) {
  return ipcRenderer.invoke('plugin-secret-set', STORAGE_NAME, `provider:${providerId}`, String(value || '').trim());
}

async function getProviderSecret(providerId) {
  const result = await ipcRenderer.invoke('plugin-secret-get', STORAGE_NAME, `provider:${providerId}`);
  // 主进程 plugin-secret-get 返回 { value, encryptionAvailable }，这里统一解包成纯字符串，
  // 避免把对象拼进 Authorization 头（服务端会当成 "[object Object]" 无效 Key）
  if (result && typeof result === 'object') return String(result.value || '');
  return String(result || '');
}

async function hasProviderSecret(providerId) {
  return Boolean(await getProviderSecret(providerId));
}

async function listOpenCodeModels() {
  return ipcRenderer.invoke('ai-opencode-list-models');
}

function catalogModel(item, style) {
  if (typeof item === 'string') item = { id: item };
  const id = String(item?.id || item?.name || '').trim();
  if (!id || /[\r\n|]/.test(id)) return null;
  const unsupportedType = ['embedding', 'rerank', 'image_generation', 'video_generation', 'speech_generation'].includes(item.type);
  const unsupportedId = /^(?:text-(?:embedding|moderation)|omni-moderation|tts-|dall-e|gpt-image|sora(?:-|$)|gpt-(?:live|realtime)|gpt-.*-realtime)/i.test(id);
  if (unsupportedType || unsupportedId) return null;
  const inputs = item.input_modalities || item.modalities?.input || item.architecture?.input_modalities;
  const modalities = Array.isArray(inputs) ? inputs : [];
  const outputs = item.output_modalities || item.architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.length && !outputs.includes('text') && !modalities.includes('audio')) return null;
  const capabilities = [];
  const declared = Array.isArray(item.capabilities) ? item.capabilities : [];
  const input = item.capabilities?.input || {};
  if (modalities.includes('text') || declared.includes('text') || input.text === true) capabilities.push('text');
  if (modalities.some(value => ['image', 'video', 'pdf'].includes(value)) || declared.includes('vision')
    || input.image === true || item.capabilities?.image_input?.supported === true) capabilities.push('vision');
  if (modalities.includes('audio') || declared.includes('audio') || input.audio === true) capabilities.push('audio');
  if (style === 'anthropic' && !capabilities.includes('text')) capabilities.unshift('text');
  // 普通 /models 往往只给 ID；不根据“多模态”名称推断视觉或音频能力。
  if (!capabilities.length) capabilities.push(/(?:transcribe|whisper|[-_/]asr(?:$|[-_.]))/i.test(id) ? 'audio' : 'text');
  const label = String(item.display_name || item.label || item.name || id).replace(/[\r\n|]/g, ' ').trim();
  const model = { id, label: label || id, capabilities };
  if (style !== 'openai') model.api = style;
  return model;
}

async function listProviderModels(options = {}) {
  const provider = options.providerId ? (await getConfig()).providers.find(item => item.id === options.providerId) : null;
  if (isOpenCodeProvider(provider)) {
    const imported = await listOpenCodeModels();
    const target = imported.find(item => item.id === openCodeProviderId(provider));
    if (!target?.models?.length) throw new Error('该 OpenCode 供应商未返回可用模型');
    return { models: target.models };
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl || provider?.baseUrl || '');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写有效的 HTTP API Base URL');
  let key = String(options.key || '').trim();
  if (!key && provider) {
    if (baseUrl !== normalizeBaseUrl(provider.baseUrl)) throw new Error('Base URL 已改变，请填写该地址对应的 API Key 后更新模型');
    key = await getProviderSecret(provider.id);
  }
  if (!key) throw new Error('请填写 API Key，或先保存供应商密钥');
  const existing = Array.isArray(options.models) ? options.models : (provider?.models || []);
  const styles = [...new Set(existing.map(modelApiStyle))];
  const anthropic = /(^|\.)anthropic\.com$/i.test(url.hostname) || /\/anthropic(?:\/|$)/i.test(url.pathname)
    || (styles.length === 1 && styles[0] === 'anthropic');
  const style = anthropic ? 'anthropic' : (styles.length === 1 ? styles[0] : 'openai');
  const prefix = url.pathname.replace(/\/(?:chat\/completions|responses|messages|models)\/?$/i, '').replace(/\/+$/, '');
  // 保留自定义网关的前缀；不把智谱、百炼等路径强制改写为 /v1。
  url.pathname = `${prefix || '/v1'}/models`;
  const headers = anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : /(^|\.)xiaomimimo\.com$/i.test(url.hostname) ? { 'api-key': key } : { Authorization: `Bearer ${key}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(60000, Math.max(100, Number(options.timeoutMs) || 20000)));
  const models = new Map(), visited = new Set();
  let page = new URL(url);
  try {
    for (let count = 0; count < 30; count++) {
      if (visited.has(page.href)) throw new Error('模型目录分页重复，请稍后重试');
      visited.add(page.href);
      const response = await fetch(page.href, { headers: { Accept: 'application/json', ...headers },
        signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error(`模型目录鉴权失败（HTTP ${response.status}），请检查 API Key 与权限`);
        if (response.status === 404 || response.status === 405) throw new Error(`供应商未提供此地址的模型目录（HTTP ${response.status}），请核对 Base URL；可继续手动维护模型`);
        throw new Error(`模型目录请求失败（HTTP ${response.status}）`);
      }
      let data;
      try { data = await response.json(); } catch (_) { throw new Error('供应商未返回有效的 JSON 模型目录'); }
      const entries = Array.isArray(data) ? data : (data?.data || data?.models);
      if (!Array.isArray(entries)) throw new Error('供应商返回的模型目录格式不受支持');
      for (const item of entries) {
        const model = catalogModel(item, style);
        if (model) models.set(model.id, model);
      }
      if (models.size > 10000) throw new Error('模型目录超过数量上限，请缩小供应商目录范围');
      if (!data.has_more) {
        if (!models.size) throw new Error('供应商未返回可用模型，原模型列表已保留');
        return { models: [...models.values()] };
      }
      const lastId = data.last_id || entries.at(-1)?.id;
      if (!lastId) throw new Error('模型目录分页缺少游标，未更新列表');
      page = new URL(url);
      page.searchParams.set(anthropic ? 'after_id' : 'after', lastId);
    }
    throw new Error('模型目录分页超过上限，未更新列表');
  } catch (error) {
    if (controller.signal.aborted) throw new Error('获取模型目录超时，请稍后重试');
    // 不把服务端原始正文或请求头带到页面，避免意外回显密钥。
    if (error instanceof TypeError) throw new Error('无法获取供应商模型目录，请检查地址、网络或供应商是否开放目录接口');
    throw error;
  } finally { clearTimeout(timer); }
}

function resolveModel(config, capability, selection) {
  const chosen = selection || config.selections?.[capability] || config.selections?.text;
  const provider = config.providers.find(item => item.id === chosen?.providerId);
  const model = provider?.models?.find(item => item.id === chosen?.modelId);
  if (!provider || !model) throw new Error('请先在供应商设置中选择可用模型');
  if (!model.capabilities?.includes(capability)) throw new Error(`模型 ${model.label || model.id} 不支持 ${capability === 'vision' ? '图片理解' : '文本'}能力`);
  return { provider, model };
}

function modelApiStyle(model) {
  return API_STYLES.includes(model.api) ? model.api : 'openai';
}

async function readStream(response, extract, requestId, modelId, onChunk) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('模型服务未返回可读流');
  const decoder = new TextDecoder();
  let buffer = ''; let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let token = '';
      try { token = extract(JSON.parse(data)); } catch (_) { continue; }
      if (token) {
        output += token;
        if (onChunk) onChunk({ requestId, token, text: output });
      }
    }
  }
  return { requestId, text: output, model: modelId };
}

function chatCompletionsExtract(data) { return data.choices?.[0]?.delta?.content || ''; }
function anthropicExtract(data) { return data.type === 'content_block_delta' ? (data.delta?.text || '') : ''; }
function responsesExtract(data) { return data.type === 'response.output_text.delta' ? (data.delta || '') : ''; }

async function performRequest({ provider, model, style, secret, request, onChunk, requestId }) {
  const base = normalizeBaseUrl(provider.baseUrl);
  const stream = request.stream !== false;
  const temperature = request.temperature ?? 0.3;

  if (style === 'anthropic') {
    const payload = { model: model.id, max_tokens: Number(request.maxTokens || 4096), ...toAnthropicPayload(request.messages), stream };
    if (!stream) payload.temperature = temperature;
    const response = await fetch(`${base}/messages`, {
      method: 'POST', signal: request.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(response.status === 401 ? `鉴权失败，请检查 API Key：${detail.slice(0, 200)}` : `模型服务返回 ${response.status}：${detail.slice(0, 240)}`);
    }
    if (!stream) {
      const data = await response.json();
      const text = (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
      return { requestId, text, model: model.id };
    }
    return readStream(response, anthropicExtract, requestId, model.id, onChunk);
  }

  if (style === 'responses') {
    const payload = { model: model.id, ...toResponsesPayload(request.messages), stream };
    if (!stream) payload.temperature = temperature;
    const response = await fetch(`${base}/responses`, {
      method: 'POST', signal: request.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(response.status === 401 ? `鉴权失败，请检查 API Key：${detail.slice(0, 200)}` : `模型服务返回 ${response.status}：${detail.slice(0, 240)}`);
    }
    if (!stream) {
      const data = await response.json();
      const text = data.output_text ?? (data.output || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
      return { requestId, text, model: model.id };
    }
    return readStream(response, responsesExtract, requestId, model.id, onChunk);
  }

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST', signal: request.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: model.id, messages: request.messages || [], temperature, stream })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(response.status === 401 ? `鉴权失败，请检查 API Key：${detail.slice(0, 200)}` : `模型服务返回 ${response.status}：${detail.slice(0, 240)}`);
  }
  if (!stream) {
    const data = await response.json();
    return { requestId, text: data.choices?.[0]?.message?.content || '', model: model.id };
  }
  return readStream(response, chatCompletionsExtract, requestId, model.id, onChunk);
}

async function probeRequest({ baseUrl, model, style, key, signal }) {
  let url, headers, body;
  if (style === 'anthropic') {
    url = `${baseUrl}/messages`;
    headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    body = JSON.stringify({ model: model.id, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
  } else if (style === 'responses') {
    url = `${baseUrl}/responses`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    body = JSON.stringify({ model: model.id, input: 'ping', stream: false });
  } else {
    url = `${baseUrl}/chat/completions`;
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
    body = JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'ping' }], stream: false });
  }
  const response = await fetch(url, { method: 'POST', signal, headers, body });
  if (response.ok) return;
  const detail = (await response.text()).slice(0, 300);
  if (response.status === 401) throw new Error(`鉴权失败（HTTP 401）：${detail || '请检查 API Key'}`);
  throw new Error(`HTTP ${response.status}：${detail || response.statusText}`);
}

async function testProvider(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || '');
  const models = Array.isArray(options.models) ? options.models.filter(model => model && model.id) : [];
  const key = String(options.key || '').trim();
  if (!baseUrl) return { ok: false, error: '缺少 Base URL' };
  if (!models.length) return { ok: false, error: '缺少模型列表' };
  if (!key) return { ok: false, error: '请先填写 API Key' };
  const timeoutMs = Math.max(3000, Number(options.timeoutMs || 20000));
  // 逐个模型探测而不是每种接口只抽查一个，才能反映订阅下每个模型的真实可用性
  const concurrency = Math.min(Math.max(1, Number(options.concurrency) || 4), 8);
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < models.length) {
      const modelIndex = cursor;
      const model = models[cursor];
      cursor += 1;
      const style = modelApiStyle(model);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await probeRequest({ baseUrl, model, style, key, signal: controller.signal });
        results.push({ modelIndex, style, modelId: model.id, ok: true });
      } catch (error) {
        results.push({ modelIndex, style, modelId: model.id, ok: false, error: errorMessage(error) });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, () => worker()));
  results.sort((a, b) => a.modelIndex - b.modelIndex);
  const okCount = results.filter(result => result.ok).length;
  return { ok: okCount === results.length, okCount, total: results.length, results };
}

async function complete(request = {}, onChunk) {
  const requestId = String(request.requestId || `${Date.now()}-${Math.random()}`);
  if (activeRequests.has(requestId)) throw new Error('请求标识正在使用');
  const config = await getConfig();
  const capability = request.capability === 'vision' ? 'vision' : 'text';
  const { provider, model } = resolveModel(config, capability, request.selection);
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    if (isOpenCodeProvider(provider)) ipcRenderer.invoke('ai-opencode-cancel', requestId).catch(() => {});
  }, Math.max(50, Number(request.timeoutMs || config.timeoutMs || 60000)));
  try {
    if (isOpenCodeProvider(provider)) {
      const result = await ipcRenderer.invoke('ai-opencode-complete', {
        ...request,
        requestId,
        timeoutMs: Number(request.timeoutMs || config.timeoutMs || 60000),
        providerId: openCodeProviderId(provider),
        modelId: model.sourceModelId || model.id
      });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (onChunk) onChunk({ requestId, token: result.text, text: result.text });
      return result;
    }
    const secret = await getProviderSecret(provider.id);
    if (!secret) throw new Error(`请先为“${provider.name}”保存 API Key`);
    return await performRequest({ provider, model, style: modelApiStyle(model), secret, request: { ...request, signal: controller.signal }, onChunk, requestId });
  } catch (error) {
    throw new Error(timedOut ? '请求超时，请稍后重试' : errorMessage(error));
  } finally {
    clearTimeout(timeout);
    activeRequests.delete(requestId);
  }
}

function cancel(requestId) {
  const controller = activeRequests.get(String(requestId || ''));
  if (!controller) return false;
  controller.abort();
  ipcRenderer.invoke('ai-opencode-cancel', String(requestId || '')).catch(() => {});
  return true;
}

function createAiRuntime(pluginName, emitChunk) {
  return {
    getConfig, saveConfig, saveProviderSecret, hasProviderSecret, getProviderSecret, testProvider, listOpenCodeModels, listProviderModels,
    removeProviderSecret: providerId => ipcRenderer.invoke('plugin-secret-remove', STORAGE_NAME, `provider:${providerId}`),
    complete: request => complete(request, emitChunk), cancel,
    storage: {
      get: key => ipcRenderer.invoke('plugin-storage-get-async', pluginName, key),
      set: (key, value) => ipcRenderer.invoke('plugin-storage-set-async', pluginName, key, value)
    }
  };
}

module.exports = { createAiRuntime, DEFAULT_CONFIG, isOpenCodeProvider, normalizeConfig, openCodeProviderId };
