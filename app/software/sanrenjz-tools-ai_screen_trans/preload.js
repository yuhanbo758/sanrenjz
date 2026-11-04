const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');

const PLUGIN_NAME = 'AI 屏幕翻译';
const AI_SHARED_NAME = 'AI 共享配置中心';
const sharedAiRuntime = createAiRuntime(PLUGIN_NAME, () => {});

/**
 * 配置版本 2 使用统一供应商目录。
 * 模型 capability 为 text 或 vision，两个处理阶段复用同一份目录，避免出现互相冲突的设置入口。
 */
const DEFAULT_SETTINGS = {
    settingsVersion: 2,
    providers: [
        {
            id: 'deepseek-official',
            name: 'DeepSeek 官方',
            baseUrl: 'https://api.deepseek.com',
            models: [
                { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', capabilities: ['text'] },
                { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', capabilities: ['text'] }
            ]
        },
        {
            id: 'siliconflow',
            name: '硅基流动',
            baseUrl: 'https://api.siliconflow.cn/v1',
            models: [
                { id: 'deepseek-ai/DeepSeek-OCR', label: 'DeepSeek OCR', capabilities: ['vision'] }
            ]
        }
    ],
    textSelection: { providerId: 'deepseek-official', modelId: 'deepseek-v4-pro' },
    ocrSelection: { providerId: 'siliconflow', modelId: 'deepseek-ai/DeepSeek-OCR' },
    screenshotMode: 'staged',
    multimodalSelection: { providerId: 'siliconflow', modelId: 'deepseek-ai/DeepSeek-OCR' }
};

function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function readStoredSettings() {
    try {
        return ipcRenderer.sendSync('plugin-storage-get', PLUGIN_NAME, 'settings') || null;
    } catch (error) {
        console.error('读取翻译配置失败:', error);
        return null;
    }
}

function writeStoredSettings(settings) {
    return ipcRenderer.sendSync('plugin-storage-set', PLUGIN_NAME, 'settings', settings);
}

function normalizeProvider(provider) {
    const openCodeMatch = /^opencode:\/\/([^/?#]+)/i.exec(String(provider?.baseUrl || '').trim());
    const managedByOpenCode = provider?.transport === 'opencode' || provider?.source === 'opencode' || Boolean(openCodeMatch);
    return {
        ...provider,
        ...(managedByOpenCode ? {
            transport: 'opencode',
            source: 'opencode',
            managed: true,
            sourceProviderId: provider.sourceProviderId || decodeURIComponent(openCodeMatch?.[1] || String(provider.id || '').replace(/^opencode:/i, ''))
        } : {}),
        id: String(provider.id),
        name: String(provider.name || provider.id),
        baseUrl: String(provider.baseUrl || '').trim(),
        models: (Array.isArray(provider.models) ? provider.models : []).map(model => ({
            ...model,
            ...(managedByOpenCode ? { sourceModelId: model.sourceModelId || model.id } : {}),
            id: String(model.id),
            label: String(model.label || model.id),
            capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter(item => item === 'text' || item === 'vision' || item === 'audio') : ['text']
        }))
    };
}

/**
 * 自动迁移 1.x 的单 URL/Key 配置。旧用户继续使用原供应商，新安装则默认 DeepSeek V4 Pro。
 */
async function ensureSettings() {
    const stored = readStoredSettings();
    const shared = ipcRenderer.sendSync('plugin-storage-get', AI_SHARED_NAME, 'runtime-config');
    if (shared?.schemaVersion === 1 && Array.isArray(shared.providers) && shared.providers.length) {
        const visionSelection = shared.selections?.vision || shared.selections?.text;
        return {
            ...cloneDefaults(),
            providers: shared.providers,
            textSelection: shared.selections?.text,
            ocrSelection: visionSelection,
            screenshotMode: stored?.screenshotMode === 'multimodal' ? 'multimodal' : 'staged',
            multimodalSelection: stored?.multimodalSelection || visionSelection
        };
    }
    if (stored?.settingsVersion === 2 && Array.isArray(stored.providers)) {
        const merged = { ...cloneDefaults(), ...stored };
        // 1.2 及更早版本没有多模态选择，沿用已有 OCR 视觉模型即可无损升级。
        merged.multimodalSelection = stored.multimodalSelection || stored.ocrSelection || merged.multimodalSelection;
        merged.screenshotMode = stored.screenshotMode === 'multimodal' ? 'multimodal' : 'staged';
        return merged;
    }
    if (!stored) return cloneDefaults();

    const migrated = cloneDefaults();
    const legacyId = 'migrated-provider';
    const legacyModels = [];
    if (stored.textModel) legacyModels.push({ id: stored.textModel, label: stored.textModel, capabilities: ['text'] });
    if (stored.ocrModel && stored.ocrModel !== stored.textModel) legacyModels.push({ id: stored.ocrModel, label: stored.ocrModel, capabilities: ['vision'] });
    migrated.providers.push({
        id: legacyId,
        name: '原有供应商',
        baseUrl: stored.baseUrl || 'https://api.siliconflow.cn/v1',
        models: legacyModels.length ? legacyModels : [{ id: 'deepseek-ai/DeepSeek-V3.2', label: 'DeepSeek V3.2', capabilities: ['text'] }]
    });
    migrated.textSelection = { providerId: legacyId, modelId: stored.textModel || legacyModels[0].id };
    migrated.ocrSelection = { providerId: legacyId, modelId: stored.ocrModel || 'deepseek-ai/DeepSeek-OCR' };
    if (stored.apiKey) await ipcRenderer.invoke('plugin-secret-set', PLUGIN_NAME, `provider:${legacyId}`, stored.apiKey);
    writeStoredSettings(migrated);
    return migrated;
}

async function saveSettings(settings, providerSecrets = {}) {
    const clean = { ...settings, settingsVersion: 2 };
    clean.providers = (Array.isArray(settings.providers) ? settings.providers : []).map(normalizeProvider);
    let encryptionAvailable = true;
    for (const [providerId, secret] of Object.entries(providerSecrets)) {
        const result = await ipcRenderer.invoke('plugin-secret-set', AI_SHARED_NAME, `provider:${providerId}`, secret);
        if (result?.encryptionAvailable === false) encryptionAvailable = false;
    }
    writeStoredSettings(clean);
    ipcRenderer.sendSync('plugin-storage-set', AI_SHARED_NAME, 'runtime-config', { schemaVersion: 1, providers: clean.providers, selections: { text: clean.textSelection, vision: clean.ocrSelection }, timeoutMs: 60000 });
    return { settings: clean, encryptionAvailable };
}

let lastEnterContext = null;
function handleEnter(mode, action) {
    const payload = action && typeof action === 'object' ? String(action.payload || action.clipboardText || '') : '';
    lastEnterContext = { mode, payload, action };
    window.postMessage({ type: 'AI_SCREEN_TRANS_ENTER', data: lastEnterContext }, '*');
}

const services = {
    getSettings: ensureSettings,
    saveSettings,
    aiComplete: request => sharedAiRuntime.complete(request),
    aiCancel: requestId => sharedAiRuntime.cancel(requestId),
    listOpenCodeModels: () => ipcRenderer.invoke('ai-opencode-list-models'),
    getProviderSecret: async providerId => (await ipcRenderer.invoke('plugin-secret-get', AI_SHARED_NAME, `provider:${providerId}`)) || ipcRenderer.invoke('plugin-secret-get', PLUGIN_NAME, `provider:${providerId}`),
    removeProviderSecret: async providerId => ipcRenderer.invoke('plugin-secret-remove', AI_SHARED_NAME, `provider:${providerId}`),
    captureRegion: options => ipcRenderer.invoke('capture-screen-region', options || {}),
    setPromptMode: enabled => ipcRenderer.invoke('set-plugin-window-prompt-mode', enabled === true),
    copyText: text => {
        try { clipboard.writeText(String(text || '')); return { success: true }; }
        catch (error) { return { success: false, error: error.message }; }
    },
    closeWindow: () => ipcRenderer.invoke('close-plugin-window', PLUGIN_NAME),
    minimizeWindow: () => ipcRenderer.invoke('minimize-plugin-window', PLUGIN_NAME),
    togglePin: () => ipcRenderer.invoke('toggle-plugin-pin-window', PLUGIN_NAME),
    getInitialContext: () => {
        const context = lastEnterContext;
        lastEnterContext = null;
        return context;
    },
    getClipboardText: () => clipboard.readText(),
    readImageFromPath: filePath => {
        try {
            if (!fs.existsSync(filePath)) return null;
            const image = nativeImage.createFromPath(filePath);
            return image.isEmpty() ? null : image.toPNG().toString('base64');
        } catch (_) { return null; }
    },
    getClipboardImage: () => {
        try {
            const image = clipboard.readImage();
            if (image && !image.isEmpty()) return image.toPNG().toString('base64');
            const text = (clipboard.readText() || '').trim();
            if (text.startsWith('data:image')) return text.split(',')[1] || null;
            const possiblePath = text.replace(/^"|"$/g, '');
            if (possiblePath && fs.existsSync(possiblePath) && ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(path.extname(possiblePath).toLowerCase())) {
                const fileImage = nativeImage.createFromPath(possiblePath);
                return fileImage.isEmpty() ? null : fileImage.toPNG().toString('base64');
            }
            return null;
        } catch (error) {
            console.error('读取剪贴板图片失败:', error);
            return null;
        }
    }
};

try { contextBridge.exposeInMainWorld('services', services); }
catch (_) { window.services = services; }

window.exports = {
    'ai-screen-text-translate': { mode: 'none', args: { enter: action => handleEnter('text', action) } },
    'ai-screen-ocr-translate': { mode: 'none', args: { enter: action => handleEnter('ocr', action) } }
};
