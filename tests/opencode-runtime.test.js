const assert = require('assert');
const http = require('http');
const { OpenCodeRuntime, buildPrompt, isRetryableOpenCodeError, parseProviderCatalog } = require('../app/plugin_runtime/opencode-runtime');

const catalog = {
  connected: ['openai', 'custom'],
  all: [
    {
      id: 'openai', name: 'OpenAI', models: {
        'gpt-codex': { name: 'GPT Codex', reasoning: true, attachment: true, limit: { context: 200000 }, modalities: { input: ['text', 'image'], output: ['text'] } },
        'gpt-5.6-luna': {
          name: 'GPT-5.6 Luna', limit: { context: 400000 },
          capabilities: { attachment: true, input: { text: true, image: true, audio: false, video: false, pdf: true } }
        },
        'gpt-5.6-audio': {
          name: 'GPT-5.6 Audio',
          capabilities: { attachment: true, input: { text: true, image: true, audio: true, video: false, pdf: false } }
        }
      }
    },
    {
      id: 'custom', name: 'Custom', models: {
        chat: { name: 'Chat', reasoning: false, attachment: false, limit: { context: 32000 } }
      }
    },
    { id: 'offline', name: 'Offline', models: { hidden: { name: 'Hidden' } } }
  ]
};

const parsed = parseProviderCatalog(catalog);
assert.deepStrictEqual(parsed.map(provider => provider.id).sort(), ['custom', 'openai']);
const openAiModels = parsed.find(provider => provider.id === 'openai').models;
assert.deepStrictEqual(openAiModels.find(model => model.id === 'gpt-codex').capabilities, ['text', 'vision']);
assert.deepStrictEqual(openAiModels.find(model => model.id === 'gpt-5.6-luna').capabilities, ['text', 'vision']);
assert.deepStrictEqual(openAiModels.find(model => model.id === 'gpt-5.6-audio').capabilities, ['text', 'vision', 'audio']);

const prompt = buildPrompt([
  { role: 'system', content: 'system rule' },
  { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }
]);
assert.ok(prompt.system.includes('Do not call tools'));
assert.strictEqual(prompt.parts[0].text, 'User:\nhello');
assert.strictEqual(prompt.parts[1].mime, 'image/png');
assert.strictEqual(isRetryableOpenCodeError(new Error('unknown certificate verification error')), true);
assert.strictEqual(isRetryableOpenCodeError(new Error('model is not supported')), false);

let createdBody;
let promptBody;
let sessionCounter = 0;
let deletedCount = 0;
let transientAttempts = 0;
let unsupportedAttempts = 0;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/provider') return response.end(JSON.stringify(catalog));
    if (request.method === 'POST' && request.url === '/session') {
      createdBody = body;
      sessionCounter += 1;
      return response.end(JSON.stringify({ id: `session-${sessionCounter}` }));
    }
    if (request.method === 'POST' && /^\/session\/session-\d+\/message$/.test(request.url)) {
      promptBody = body;
      const text = body?.parts?.find(part => part.type === 'text')?.text || '';
      if (text.includes('retry')) {
        transientAttempts += 1;
        if (transientAttempts === 1) {
          return response.end(JSON.stringify({ info: { error: { data: { message: 'unknown certificate verification error' } } }, parts: [] }));
        }
        return response.end(JSON.stringify({ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'retried' }] }));
      }
      if (text.includes('unsupported')) {
        unsupportedAttempts += 1;
        return response.end(JSON.stringify({ info: { error: { data: { message: 'model is not supported' } } }, parts: [] }));
      }
      return response.end(JSON.stringify({ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] }));
    }
    if (request.method === 'DELETE' && /^\/session\/session-\d+$/.test(request.url)) {
      deletedCount += 1;
      return response.end('true');
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const runtime = new OpenCodeRuntime({ serverUrl: `http://127.0.0.1:${port}` });
    const providers = await runtime.listModels();
    assert.strictEqual(providers.length, 2);
    const result = await runtime.complete({
      requestId: 'test', providerId: 'openai', modelId: 'gpt-codex',
      messages: [{ role: 'user', content: 'hello' }]
    });
    assert.strictEqual(result.text, 'done');
    assert.deepStrictEqual(createdBody.permission, [{ permission: '*', pattern: '*', action: 'deny' }]);
    assert.deepStrictEqual(promptBody.model, { providerID: 'openai', modelID: 'gpt-codex' });
    assert.deepStrictEqual(promptBody.tools, { '*': false });
    const retried = await runtime.complete({
      requestId: 'retry', providerId: 'openai', modelId: 'gpt-codex',
      messages: [{ role: 'user', content: 'retry' }]
    });
    assert.strictEqual(retried.text, 'retried');
    assert.strictEqual(transientAttempts, 2);
    await assert.rejects(() => runtime.complete({
      requestId: 'unsupported', providerId: 'openai', modelId: 'gpt-codex',
      messages: [{ role: 'user', content: 'unsupported' }]
    }), /model is not supported/);
    assert.strictEqual(unsupportedAttempts, 1, '非临时模型错误不得重试');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(deletedCount, 4);
    console.log('OpenCode runtime tests passed: connected catalog, Codex model routing, transient TLS retry, non-retryable errors, denied tools, cleanup');
  } finally {
    server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
