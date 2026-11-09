const clone = value => JSON.parse(JSON.stringify(value));
const state = { settings: { quickCommands: [], customModels: [], jevProvider: 'off', commanderEnabled: false }, notices: [], savedKey: '', failKey: false,
    shared: { providerId: 'shared-provider', modelId: 'gpt-6-luna' } };
window.__assistantTest = state;
window.aiAPI = {
    getConfig: async () => ({ providers: [], selections: {} }), saveConfig: async () => true,
    hasProviderSecret: async () => false
};
window.services = {
    getSettings: () => clone(state.settings), saveSettings: settings => { state.settings = clone(settings); return true; },
    getSharedProviderGroups: async () => [{ id: 'shared-provider', name: '共享供应商', models: [
        { value: 'z-model', label: 'Zebra', provider: 'shared:shared-provider' },
        { value: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'shared:shared-provider' }
    ] }],
    getLegacyModels: () => state.settings.openaiModels || [{ value: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai' }],
    getSharedTextSelection: async () => clone(state.shared), saveSharedTextSelection: async (providerId, modelId) => { state.shared = { providerId, modelId }; },
    hasDirectOpenAIKey: async () => !!state.savedKey,
    saveDirectOpenAIKey: async key => { if (state.failKey) throw new Error('fixture key save failure'); state.savedKey = key; },
    loadOpenAIModels: async () => [
        { value: 'z-model', label: 'Zebra', provider: 'openai' },
        { value: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai' },
        { value: 'alpha', label: 'Alpha', provider: 'openai' }
    ],
    showNotification: message => state.notices.push(message), registerFeatures() {}
};
