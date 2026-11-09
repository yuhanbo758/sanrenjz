const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

const runtimeRoot = process.env.AI_CATALOG_RUNTIME_DIR || path.join(__dirname, '../app/plugin_runtime');

function createRuntime(fetchImpl = fetch, providers = []) {
    const calls = [];
    const context = { module: { exports: {} }, URL, AbortController, setTimeout, clearTimeout, fetch: fetchImpl,
        require: name => {
            assert.equal(name, 'electron');
            return { ipcRenderer: { invoke: async (channel, ...args) => {
                calls.push(channel);
                if (channel === 'plugin-storage-get-async') return { schemaVersion: 1, providers };
                if (channel === 'plugin-secret-get') return { value: 'fixture-key', encryptionAvailable: true };
                if (channel === 'ai-opencode-list-models') return [{ id: 'openai', models: [{ id: 'managed-current', capabilities: ['text'] }] }];
                throw new Error(`Unexpected IPC ${channel}`);
            } } };
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(runtimeRoot, 'ai-runtime.js'), 'utf8'), context);
    return { api: context.module.exports.createAiRuntime('catalog-test'), calls };
}

test('兼容目录保留各供应商前缀、处理分页去重及真实 HTTP 请求', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
        response.setHeader('content-type', 'application/json');
        const next = new URL(request.url, 'http://localhost').searchParams.has('after');
        response.end(JSON.stringify({ data: next
            ? [{ id: 'new-text', input_modalities: ['text', 'image'] }, { id: 'gpt-transcribe' }]
            : [{ id: 'new-text', input_modalities: ['text', 'image'] }], has_more: !next, last_id: 'new-text' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        for (const suffix of ['/v1', '/api/paas/v4', '/compatible-mode/v1', '/custom-prefix/v1/chat/completions']) {
            const { api, calls } = createRuntime();
            const result = await api.listProviderModels({ baseUrl: `http://127.0.0.1:${server.address().port}${suffix}`, key: 'fixture-key' });
            assert.equal(result.models.length, 2);
            assert.equal(result.models[0].capabilities.join(','), 'text,vision');
            assert.equal(result.models[1].capabilities.join(','), 'audio');
            assert.equal(calls.length, 0);
        }
        assert(requests.every(request => request.method === 'GET' && request.auth === 'Bearer fixture-key'));
        assert(requests.some(request => request.url === '/api/paas/v4/models'));
        assert(requests.some(request => request.url === '/compatible-mode/v1/models'));
        assert(requests.some(request => request.url === '/custom-prefix/v1/models'));
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Anthropic 与 MiMo 使用正确鉴权；响应元数据及分页游标可解析', async () => {
    const requests = [];
    const { api } = createRuntime(async (url, init) => {
        requests.push({ url, ...init });
        return { ok: true, json: async () => ({ data: [{ id: 'claude-current', display_name: 'Current Claude',
            capabilities: { image_input: { supported: true } } }], has_more: !url.includes('after_id='), last_id: 'claude-current' }) };
    });
    const result = await api.listProviderModels({ baseUrl: 'https://api.anthropic.com', key: 'fixture-key' });
    assert.equal(requests[0].url, 'https://api.anthropic.com/v1/models');
    assert.equal(requests[0].headers['x-api-key'], 'fixture-key');
    assert.equal(requests[0].headers.Authorization, undefined);
    assert(requests[1].url.includes('after_id=claude-current'));
    assert.equal(result.models[0].capabilities.join(','), 'text,vision');
    assert.equal(result.models[0].api, 'anthropic');
    const mimo = createRuntime(async (_url, init) => {
        assert.equal(init.headers['api-key'], 'fixture-key');
        return { ok: true, json: async () => ({ data: [{ id: 'mimo-current' }] }) };
    });
    await mimo.api.listProviderModels({ baseUrl: 'https://api.xiaomimimo.com/v1', key: 'fixture-key' });
});

test('读取已有密钥时绑定原供应商地址，托管供应商复用 OpenCode 同步', async () => {
    let network = 0;
    const { api, calls } = createRuntime(async (_url, init) => {
        network++;
        assert.equal(init.headers.Authorization, 'Bearer fixture-key');
        return { ok: true, json: async () => ({ data: [{ id: 'latest' }] }) };
    }, [{ id: 'saved', baseUrl: 'https://api.example/v1' }, { id: 'opencode:openai', transport: 'opencode', baseUrl: 'opencode://openai' }]);
    await api.listProviderModels({ providerId: 'saved', baseUrl: 'https://api.example/v1/' });
    assert(calls.includes('plugin-secret-get'));
    await assert.rejects(api.listProviderModels({ providerId: 'saved', baseUrl: 'https://other.example/v1' }), /Base URL 已改变/);
    assert.equal(network, 1);
    assert.equal((await api.listProviderModels({ providerId: 'opencode:openai' })).models[0].id, 'managed-current');
    assert(!calls.some(channel => /set|remove/.test(channel)));
});

test('错误、HTML 挑战页、空目录、分页循环和超时均拒绝更新', async () => {
    const options = { baseUrl: 'https://api.example/v1', key: 'fixture-key' };
    for (const status of [401, 403, 404, 405, 429, 500]) {
        const { api } = createRuntime(async () => ({ ok: false, status }));
        await assert.rejects(api.listProviderModels(options), new RegExp(`HTTP ${status}`));
    }
    for (const data of [{ data: [] }, { error: { message: 'never show fixture-key' } }, { data: [{ id: 'same' }], has_more: true, last_id: 'same' }]) {
        await assert.rejects(createRuntime(async () => ({ ok: true, json: async () => data })).api.listProviderModels(options));
    }
    await assert.rejects(createRuntime(async () => ({ ok: true, json: async () => { throw new Error('HTML page'); } })).api.listProviderModels(options), /有效的 JSON/);
    await assert.rejects(createRuntime((_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })).api.listProviderModels({ ...options, timeoutMs: 100 }), /超时/);
});

test('OpenRouter 模态、纯 ID 目录及新模型默认能力可归一化', async () => {
    const { api } = createRuntime(async (_url, init) => {
        assert.equal(init.redirect, 'error');
        return { ok: true, json: async () => ({ models: [
            { id: 'router/audio', name: 'Audio', architecture: { input_modalities: ['text', 'audio'] } },
            'latest-unknown', { id: 'unsafe|line' }, { id: 'text-embedding-current' }, { id: 'gpt-image-current' },
            { id: 'native/rerank', type: 'rerank' }, { id: 'image-only', architecture: { input_modalities: ['text'], output_modalities: ['image'] } }
        ] }) };
    });
    const { models } = await api.listProviderModels({ baseUrl: 'https://router.example/api/v1', key: 'fixture-key' });
    assert.equal(models.length, 2);
    assert.equal(models[0].capabilities.join(','), 'text,audio');
    assert.equal(models[1].capabilities.join(','), 'text');
});
