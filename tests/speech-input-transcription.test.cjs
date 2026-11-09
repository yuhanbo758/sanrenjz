const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preload = path.resolve(process.env.SPEECH_INPUT_PLUGIN_DIR || path.join(__dirname, '../app/software/sanrenjz-tools-speech_input'), 'preload.js');

function loadApi(response = { ok: true, json: async () => ({ text: '  转写结果  ' }) }, options = {}) {
    const requests = [];
    const secretCalls = [], secrets = new Map();
    const encryptionAvailable = options.encryptionAvailable !== false;
    const ipcRenderer = { invoke: async (channel, plugin, key, value) => {
        secretCalls.push({ channel, plugin, key });
        if (channel === 'plugin-secret-get') return { value: secrets.get(key) || '', encryptionAvailable };
        if (channel === 'plugin-secret-set') { secrets.set(key, value); return { success: true, encryptionAvailable }; }
        throw new Error(`Unexpected IPC: ${channel}`);
    } };
    const runtime = {
        getConfig: async () => ({ providers: options.providers || [{ id: 'audio', name: '测试音频', baseUrl: 'https://audio.example/v1',
            models: [{ id: 'gpt-transcribe', capabilities: ['audio'] }] }] }),
        getProviderSecret: async () => 'fixture-key'
    };
    const context = {
        window: {}, Buffer, AbortController, setTimeout, clearTimeout, console: { log() {} },
        require: name => name === 'electron' ? { ipcRenderer, clipboard: {}, shell: {} }
            : name === '../../plugin_runtime/ai-runtime' ? { createAiRuntime: () => runtime } : require(name),
        fetch: async (url, init) => { requests.push({ url, ...init }); return response; }
    };
    vm.runInNewContext(fs.readFileSync(preload, 'utf8'), context, { filename: preload });
    return { api: context.window.electronAPI, requests, secrets, secretCalls };
}

test('OpenAI 独立入口只需保存密钥，默认使用官方转写接口且不向页面返回密钥', async () => {
    const { api, requests, secrets } = loadApi();
    assert.equal((await api.openai.getStatus()).hasKey, false);
    await assert.rejects(api.openai.transcribe({ audioBase64: 'YQ==' }), /API Key/);
    await api.openai.saveKey(' fixture-native-key ');
    assert.equal(secrets.get('openai-asr-api-key'), 'fixture-native-key');
    const status = await api.openai.getStatus();
    assert.equal(status.hasKey, true);
    assert(!Object.hasOwn(status, 'value'));
    assert(!JSON.stringify(status).includes('fixture-native-key'));
    assert.equal(await api.openai.transcribe({ audioBase64: 'YQ==', mimeType: 'audio/webm' }), '转写结果');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(requests[0].headers.Authorization, 'Bearer fixture-native-key');
    assert(requests[0].body.toString().includes('gpt-transcribe'));
    await assert.rejects(api.openai.transcribe({ audioBase64: 'YQ==', model: 'gpt-6-luna' }), /转写模型/);
    assert.equal(requests.length, 1);
});

test('系统加密不可用时拒绝保存 OpenAI 密钥', async () => {
    const { api, secrets, secretCalls } = loadApi(undefined, { encryptionAvailable: false });
    await assert.rejects(api.openai.saveKey('fixture-key'), /加密存储不可用/);
    assert.equal(secrets.size, 0);
    assert(!secretCalls.some(call => call.channel === 'plugin-secret-set'));
});

test('共享音频目录过滤已知不支持该转写接口的模型', async () => {
    const { api } = loadApi(undefined, { providers: [
        { id: 'mimo', name: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', models: [
            { id: 'mimo-v2.5', capabilities: ['audio', 'text'] }, { id: 'mimo-v2.5-asr', capabilities: ['audio'] }] },
        { id: 'managed', name: 'OpenCode', transport: 'opencode', models: [{ id: 'gpt-audio', capabilities: ['audio'] }] },
        { id: 'official', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-transcribe', capabilities: ['audio'] }] }
    ] });
    const models = await api.sharedAi.listModels();
    assert.equal(models.filter(item => item.kind === 'audio').map(item => item.modelId).sort().join(','), 'gpt-transcribe,mimo-v2.5-asr');
    await assert.rejects(api.sharedAi.transcribe({ selection: { providerId: 'mimo', modelId: 'mimo-v2.5' } }), /不支持当前语音/);
});

test('OpenAI 普通兼容配置与共享音频模型均上传文件到转写接口', async () => {
    for (const baseUrl of ['https://audio.example', 'https://audio.example/v1/', 'https://audio.example/v1/chat/completions']) {
        for (const model of ['gpt-transcribe', 'gpt-4o-transcribe', 'whisper-1']) {
            const { api, requests } = loadApi();
            assert.equal(await api.openaiCompatible.transcribe({ baseUrl, apiKey: 'fixture-key', model,
                audioBase64: Buffer.from('fixture-audio').toString('base64'), mimeType: 'audio/webm' }), '转写结果');
            assert.equal(requests.length, 1);
            assert.equal(requests[0].url, 'https://audio.example/v1/audio/transcriptions');
            assert.match(requests[0].headers['Content-Type'], /^multipart\/form-data; boundary=/);
            const body = requests[0].body.toString('utf8');
            assert(body.includes(model) && body.includes('fixture-audio') && body.includes('name="file"'));
            assert(!body.includes('input_audio'));
        }
    }
    const { api, requests } = loadApi();
    assert.equal(await api.sharedAi.transcribe({ selection: { providerId: 'audio', modelId: 'gpt-transcribe' },
        audioBase64: Buffer.from('fixture-audio').toString('base64') }), '转写结果');
    assert.equal(requests[0].url, 'https://audio.example/v1/audio/transcriptions');
});

test('MiMo 原有音频聊天请求保持兼容', async () => {
    const { api, requests } = loadApi({ ok: true, headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ choices: [{ message: { content: 'MiMo 转写' } }] }) });
    assert.equal(await api.openaiCompatible.transcribe({ baseUrl: 'https://audio.example/v1', apiKey: 'fixture-key',
        model: 'mimo-v2.5-asr', audioBase64: Buffer.from('fixture-audio').toString('base64'), mimeType: 'audio/wav' }), 'MiMo 转写');
    assert.equal(requests[0].url, 'https://audio.example/v1/chat/completions');
    const payload = JSON.parse(requests[0].body);
    assert.equal(payload.messages[0].content[0].type, 'input_audio');
    assert.equal(payload.messages[0].content.length, 1);
});

test('转写上传拒绝空音频并保留服务返回的错误', async () => {
    const { api, requests } = loadApi({ ok: false, status: 401, json: async () => ({ error: { message: 'fixture unauthorized' } }) });
    const options = { baseUrl: 'https://audio.example/v1', apiKey: 'fixture-key', model: 'gpt-transcribe' };
    await assert.rejects(api.openaiCompatible.transcribe({ ...options, audioBase64: '' }), /音频文件须非空/);
    assert.equal(requests.length, 0);
    await assert.rejects(api.openaiCompatible.transcribe({ ...options, audioBase64: 'YQ==' }), /fixture unauthorized/);
});
