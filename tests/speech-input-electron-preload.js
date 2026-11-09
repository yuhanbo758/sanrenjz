const { EventEmitter } = require('events');
const childProcess = require('child_process');

// 测试窗口不注册系统全局键盘钩子。
childProcess.spawn = () => {
    const process = new EventEmitter();
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    process.stdout.setEncoding = () => {};
    process.stderr.setEncoding = () => {};
    process.stdin = { end() {} };
    process.kill = () => process.emit('exit', 0);
    if (window.__speechTest) window.__speechTest.hook = process;
    return process;
};

const storage = new Map([['settings', { model: 'gemini', geminiKey: 'test-key', textPostProcessEnabled: false }]]);
window.__speechTest = { inserts: [], copies: [], storage, sharedCalls: [], audioCalls: [], openaiCalls: [], savedOpenAIKey: '', failOpenAIKeySave: false };
window.electronAPI = {
    storage: {
        get: key => storage.get(key),
        set: (key, value) => storage.set(key, value),
        remove: key => storage.delete(key)
    },
    action: {
        copy: text => window.__speechTest.copies.push(text),
        insert: async text => { window.__speechTest.inserts.push(text); return { success: true }; }
    },
    window: { createIndicatorWindow: () => {}, closeIndicatorWindow: async () => {}, close: async () => {}, hide: async () => {} },
    sharedAi: {
        listModels: async () => [{ kind: 'text', providerId: 'opencode:openai', modelId: 'gpt-6-sol',
            label: 'OpenCode / GPT-6 Sol', selected: true }],
        processText: async request => { window.__speechTest.sharedCalls.push(request); return `共享处理：${request.text}`; }
    },
    openaiCompatible: {
        transcribe: async request => { window.__speechTest.audioCalls.push(request); return 'OpenAI 转写文本'; }
    },
    openai: {
        getStatus: async () => ({ hasKey: !!window.__speechTest.savedOpenAIKey, encryptionAvailable: true }),
        saveKey: async key => {
            if (window.__speechTest.failOpenAIKeySave) throw new Error('模拟安全存储失败');
            window.__speechTest.savedOpenAIKey = key.trim();
            return { success: true };
        },
        transcribe: async request => { window.__speechTest.openaiCalls.push(request); return 'OpenAI 官方转写文本'; }
    },
    dialog: { defaultDownloadDir: () => '', chooseDirectory: () => '' },
    lan: {
        getStatus: () => ({ wsRunning: false, clients: 0, localIps: [] }),
        onEvent: () => {}, start: () => [], stop: () => {}, setClipboardSync: () => {}, pushClipboardImage: () => false
    },
    utils: { openExternal: () => {} }
};
