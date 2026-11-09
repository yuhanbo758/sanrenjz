const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plugin = process.env.AI_ASSISTANT_PLUGIN_DIR || path.resolve(__dirname, '../app/software/sanrenjz.tools-ai');
function loadServices(options = {}) {
    let settings = {};
    const secrets = new Map(), requests = [], catalogs = [];
    const runtime = { getConfig: async () => ({ providers: [] }), listProviderModels: async request => {
        catalogs.push(request);
        return { models: [{ id: 'gpt-current', capabilities: ['text', 'vision'] }, { id: 'gpt-transcribe', capabilities: ['audio'] }] };
    } };
    const context = { window: {}, ReadableStream, TextDecoder, Buffer, AbortController, setTimeout, clearTimeout,
        console: { log() {}, error() {} },
        require: name => {
            if (name === 'electron') return {
                contextBridge: { exposeInMainWorld: (key, value) => { context.window[key] = value; } },
                ipcRenderer: {
                    sendSync: (channel, _plugin, _key, value) => {
                        if (channel === 'plugin-storage-get') return settings;
                        if (channel === 'plugin-storage-set') { settings = value; return true; }
                    },
                    invoke: async (channel, _plugin, key, value) => {
                        if (channel === 'plugin-secret-get') return { value: secrets.get(key) || '', encryptionAvailable: options.encrypted !== false };
                        if (channel === 'plugin-secret-set') { secrets.set(key, value); return { success: true, encryptionAvailable: true }; }
                        throw new Error(`Unexpected IPC ${channel}`);
                    }
                }
            };
            if (name === '../../plugin_runtime/ai-runtime') return { createAiRuntime: () => runtime };
            if (name.startsWith('../../plugin_runtime/')) return {};
            return require(name);
        },
        fetch: async (url, init) => {
            requests.push({ url, ...init });
            if (options.status) return { ok: false, status: options.status };
            const bytes = Buffer.from('data: {"choices":[{"delta":{"content":"你好，OpenAI"}}]}\r\n\r\ndata: [DONE]\n');
            return { ok: true, body: new ReadableStream({ start(controller) {
                for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
                controller.close();
            } }) };
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(plugin, 'preload.js'), 'utf8'), context);
    return { services: context.window.services, secrets, requests, catalogs, settings: () => settings };
}

test('助手 OpenAI 密钥加密保存、模型加载与默认列表', async () => {
    const fixture = loadServices();
    assert(fixture.services.getLegacyModels().some(model => model.provider === 'openai' && model.value === 'gpt-6-luna'));
    await fixture.services.saveDirectOpenAIKey(' fixture-openai-key ');
    assert.equal(await fixture.services.hasDirectOpenAIKey(), true);
    assert(!JSON.stringify(fixture.settings()).includes('fixture-openai-key'));
    const models = await fixture.services.loadOpenAIModels('');
    assert.equal(models.length, 1);
    assert.equal(models[0].provider, 'openai');
    assert.equal(fixture.catalogs[0].baseUrl, 'https://api.openai.com/v1');
    assert.equal(fixture.catalogs[0].key, 'fixture-openai-key');
    const unavailable = loadServices({ encrypted: false });
    await assert.rejects(unavailable.services.saveDirectOpenAIKey('fixture-key'), /加密存储/);
    assert.equal(unavailable.secrets.size, 0);
});

test('助手 OpenAI 官方直连传递所选模型、上下文与图片并完整解析分片', async () => {
    const fixture = loadServices();
    await fixture.services.saveDirectOpenAIKey('fixture-openai-key');
    const stream = await fixture.services.callAPI('解释图片', { provider: 'openai', value: 'gpt-6-luna' },
        [{ role: 'user', content: '之前的问题' }], { type: 'image', mimeType: 'image/png', content: 'ZmFrZQ==' });
    let text = '';
    for await (const chunk of stream) text += chunk;
    assert.equal(text, '你好，OpenAI');
    assert.equal(fixture.requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(fixture.requests[0].headers.Authorization, 'Bearer fixture-openai-key');
    const body = JSON.parse(fixture.requests[0].body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.messages[1].content, '之前的问题');
    assert.equal(body.messages.at(-1).content[1].type, 'image_url');
});

test('助手 OpenAI 无密钥及权限错误明确报错', async () => {
    const fixture = loadServices({ status: 401 });
    const call = () => fixture.services.callAPI('测试', { provider: 'openai', value: 'gpt-6-luna' }, []);
    await assert.rejects(call(), /OpenAI API Key/);
    assert.equal(fixture.requests.length, 0);
    await fixture.services.saveDirectOpenAIKey('fixture-openai-key');
    await assert.rejects(call(), /HTTP 401/);
});
