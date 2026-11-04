const assert = require('assert');
const http = require('http');
const Module = require('module');

// 本文件用本地 HTTP 服务模拟 OpenAI 兼容接口。
// electron IPC mock 采用主进程真实返回形状：plugin-secret-get 返回 { value, encryptionAvailable }。
async function main() {
  let config = {
    schemaVersion: 1,
    providers: [{
      id: 'mock', name: 'Mock', baseUrl: '',
      models: [
        { id: 'text', label: 'Text', capabilities: ['text'] },
        { id: 'vision', label: 'Vision', capabilities: ['text', 'vision'] }
      ]
    }],
    selections: { text: { providerId: 'mock', modelId: 'text' }, vision: { providerId: 'mock', modelId: 'vision' } },
    timeoutMs: 500
  };
  const seenAuthHeaders = [];
  const openCodeRequests = [];
  let secretGetCount = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const data = JSON.parse(body || '{}');
      seenAuthHeaders.push(request.headers.authorization || '');
      const content = data.messages?.[0]?.content || data.input || '';
      if (data.model === 'bad-model') { response.writeHead(404); response.end('model not found'); return; }
      if (content.includes('AUTH')) { response.writeHead(401); response.end('bad key'); return; }
      if (content.includes('SLOW')) {
        const timer = setTimeout(() => {
          if (!response.destroyed) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
          }
        }, 1200);
        response.on('close', () => clearTimeout(timer));
        return;
      }
      if (data.stream === false) {
        response.writeHead(200, { 'content-type': 'application/json' });
        const text = content.includes('MODEL') ? `model:${data.model}` : (content.includes('ping') ? 'pong' : 'non-stream');
        response.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"\u4f60"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"\u597d"}}]}\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.providers[0].baseUrl = `http://127.0.0.1:${server.address().port}`;
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        ipcRenderer: {
          invoke(_channel, _name, key, value) {
            if (_channel === 'plugin-storage-get-async') return Promise.resolve(config);
            if (_channel === 'plugin-storage-set-async') { config = value; return Promise.resolve(true); }
            if (_channel === 'plugin-secret-get') {
              secretGetCount += 1;
              return Promise.resolve({ value: 'mock-key', encryptionAvailable: true });
            }
            if (_channel === 'ai-opencode-complete') {
              openCodeRequests.push(_name);
              return Promise.resolve({ requestId: _name.requestId, text: 'opencode-result', model: _name.modelId });
            }
            if (_channel === 'ai-opencode-cancel') return Promise.resolve(true);
            return Promise.resolve(true);
          }
        }
      };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../app/plugin_runtime/ai-runtime')];
    const { createAiRuntime } = require('../app/plugin_runtime/ai-runtime');
    let chunks = '';
    const api = createAiRuntime('\u6d4b\u8bd5', chunk => { chunks = chunk.text; });
    let result = await api.complete({ requestId: 'stream', messages: [{ role: 'user', content: 'HELLO' }] });
    assert.strictEqual(result.text, '\u4f60\u597d');
    assert.strictEqual(chunks, '\u4f60\u597d');
    assert.ok(seenAuthHeaders.includes('Bearer mock-key'), 'Authorization 必须发送解包后的 API Key 原文');
    result = await api.complete({ requestId: 'plain', stream: false, messages: [{ role: 'user', content: 'HELLO' }] });
    assert.strictEqual(result.text, 'non-stream');
    config.providers.push({ id: 'deepseek', name: 'DeepSeek', baseUrl: config.providers[0].baseUrl, models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', capabilities: ['text'] }] });
    result = await api.complete({ requestId: 'provider-selection', selection: { providerId: 'deepseek', modelId: 'deepseek-chat' }, stream: false, messages: [{ role: 'user', content: 'MODEL' }] });
    assert.strictEqual(result.text, 'model:deepseek-chat');
    // 模拟旧版屏幕翻译保存后丢失 transport/source/sourceProviderId 的受损配置。
    config.providers.push({ id: 'opencode:openai', name: 'OpenAI', baseUrl: 'opencode://openai', models: [{ id: 'gpt-codex', label: 'GPT Codex', capabilities: ['text'] }] });
    const secretsBeforeOpenCode = secretGetCount;
    result = await api.complete({ requestId: 'opencode', selection: { providerId: 'opencode:openai', modelId: 'gpt-codex' }, messages: [{ role: 'user', content: 'CODEX' }] });
    assert.strictEqual(result.text, 'opencode-result');
    assert.strictEqual(openCodeRequests[0].providerId, 'openai');
      assert.strictEqual(openCodeRequests[0].modelId, 'gpt-codex');
      assert.strictEqual(openCodeRequests[0].timeoutMs, config.timeoutMs, '共享配置中的超时必须传给主进程 OpenCode Runtime');
    assert.strictEqual(secretGetCount, secretsBeforeOpenCode, 'OpenCode 路由不得读取或要求 API Key');
    const normalized = await api.getConfig();
    assert.strictEqual(normalized.providers.find(provider => provider.id === 'opencode:openai').transport, 'opencode');
    await assert.rejects(() => api.complete({ requestId: 'auth', messages: [{ role: 'user', content: 'AUTH' }] }), /鉴权失败/);
    config.selections.vision = { providerId: 'mock', modelId: 'text' };
    await assert.rejects(() => api.complete({ requestId: 'vision-mismatch', capability: 'vision', messages: [] }), /不支持\s*图片理解/);
    config.selections.vision = { providerId: 'mock', modelId: 'vision' };
    await assert.rejects(() => api.complete({ requestId: 'timeout', stream: false, timeoutMs: 100, messages: [{ role: 'user', content: 'SLOW' }] }), /超时/);
    const pending = api.complete({ requestId: 'cancel', stream: false, timeoutMs: 2000, messages: [{ role: 'user', content: 'SLOW' }] });
    setTimeout(() => api.cancel('cancel'), 30);
    await assert.rejects(() => pending, /取消/);
    const probe = await api.testProvider({
      baseUrl: config.providers[0].baseUrl,
      models: [{ id: 'text', capabilities: ['text'] }, { id: 'bad-model', capabilities: ['text'] }],
      key: 'mock-key',
      timeoutMs: 3000
    });
    assert.strictEqual(probe.total, 2);
    assert.strictEqual(probe.okCount, 1);
    assert.strictEqual(probe.results[0].modelId, 'text');
    assert.strictEqual(probe.results[0].ok, true);
    assert.strictEqual(probe.results[1].modelId, 'bad-model');
    assert.strictEqual(probe.results[1].ok, false);
    console.log('AI runtime mock tests passed: stream, non-stream, provider selection, keyless OpenCode recovery/routing, auth header, timeout, cancel, capability guard, per-model provider test');
  } finally {
    Module._load = original;
    server.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
