const fs = require('fs')
const path = require('path')
const { contextBridge, ipcRenderer, clipboard } = require('electron');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');
const { listInstalledPluginCapabilities } = require('../../plugin_runtime/commander-plugin-catalog');
const { decideRoute } = require('../../plugin_runtime/commander-jev');
const AI_SHARED_NAME = 'AI 共享配置中心';
const ASSISTANT_SYSTEM_PROMPT = '你是余汉波AI助手。插件打开由外部总指挥实际执行；你不能自行打开设备上的插件。除非已有真实插件调用结果，不得声称插件已打开或任务已由插件完成。若用户要求的插件未被打开，应如实说明并继续提供有帮助的回答。';

// 插件配置
const PLUGIN_NAME = '余汉波AI助手';

// 共享 AI Runtime：供供应商目录组件（AIProviderManager）管理共享供应商、密钥与连通性测试
const aiRuntimeForCatalog = createAiRuntime(PLUGIN_NAME, chunk => {
    if (typeof window.__aiRuntimeChunkListener === 'function') window.__aiRuntimeChunkListener(chunk);
});
try {
    contextBridge.exposeInMainWorld('aiAPI', aiRuntimeForCatalog);
} catch (_) {
    // 当前插件窗口未启用 contextIsolation 时，contextBridge 不可用，直接挂到 window
    window.aiAPI = aiRuntimeForCatalog;
}

// 默认设置
const DEFAULT_SETTINGS = {
    openrouterApiKey: '',
    geminiApiKey: '',
    deepseekApiKey: '',
    defaultModel: 'google/gemini-pro',
    savePath: '',  // 添加保存路径设置
    customModels: [],
    promptsPath: '',
    quickCommands: [], // 用户自定义快捷指令列表
    jevProvider: 'off'
};

const OPENAI_DEFAULT_MODELS = ['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'].map(value => ({
    value, label: value.replace('gpt-', 'GPT-').replace(/-(astra|luna|sol)$/, (_, name) => ` ${name[0].toUpperCase()}${name.slice(1)}`), provider: 'openai'
}));

async function getDirectOpenAISecret() {
    const result = await ipcRenderer.invoke('plugin-secret-get', PLUGIN_NAME, 'direct-openai-api-key');
    return result?.encryptionAvailable === true ? String(result.value || '') : '';
}

function openAITextStream(response, abortController, timer) {
    const reader = response.body.getReader();
    return new ReadableStream({
        async start(controller) {
            const decoder = new TextDecoder();
            let pending = '';
            const consume = line => {
                if (!line.startsWith('data:')) return;
                const text = line.slice(5).trim();
                if (!text || text === '[DONE]') return;
                const data = JSON.parse(text);
                if (data.error) throw new Error('OpenAI 流式生成失败');
                const token = data.choices?.[0]?.delta?.content;
                if (token) controller.enqueue(token);
            };
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    pending += decoder.decode(value, { stream: true });
                    const lines = pending.split(/\r?\n/); pending = lines.pop();
                    for (const line of lines) consume(line);
                }
                pending += decoder.decode();
                if (pending.trim()) consume(pending);
                controller.close();
            } catch (error) { controller.error(abortController.signal.aborted ? new Error('OpenAI 请求已取消或超时') : error); }
            finally { clearTimeout(timer); reader.releaseLock(); }
        },
        cancel() { abortController.abort(); }
    });
}

// 内置模型列表
const BUILT_IN_MODELS = [
    {value: 'deepseek-chat', label: 'DeepSeek V3', provider: 'deepseek'},
    {value: 'deepseek-reasoner', label: 'DeepSeek R1', provider: 'deepseek'},
    {value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini'},
    {value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'gemini'},
    {value: 'gemini-3-pro-preview', label: 'Gemini 3.0 Pro Preview', provider: 'gemini'},
    {value: 'openai/gpt-4o', label: 'GPT-4O', provider: 'openrouter'},
    {value: 'openai/gpt-4o-mini', label: 'GPT-4O Mini', provider: 'openrouter'},
    {value: 'google/gemini-2.5-pro-exp-03-25:free', label: 'Gemini 2.5 Pro Exp', provider: 'openrouter'},
    {value: 'google/gemini-3-pro-preview', label: 'Gemini 3.0 Pro Preview', provider: 'openrouter'},
    {value: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 Free', provider: 'openrouter'},
    {value: 'deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek Chat V3 Free', provider: 'openrouter'},
];

function getSharedModels() {
    try {
        const config = ipcRenderer.sendSync('plugin-storage-get', AI_SHARED_NAME, 'runtime-config');
        return (config?.providers || []).flatMap(provider => (provider.models || []).filter(model => model.capabilities?.includes('text')).map(model => ({
            value: model.id, label: `${model.label || model.id} · 共享`, provider: `shared:${provider.id}`
        })));
    } catch (_) { return []; }
}

window.exports = {
    "ai": {
        mode: "none",
        args: {
            enter: (action) => {
                // 1. 设置待处理指令 (如果有)
                // window.pendingQuickCommand = cmd; // 这通常在 select 中设置

                // 2. 获取输入文本
                // 用户要求：不自动粘贴剪贴板内容，仅处理选中文本
                let textToFill = '';
                if (action.type === 'over' && action.payload) {
                    textToFill = action.payload;
                } 
                // 移除自动读取剪贴板的逻辑
                
                // 将文本存储到全局变量
                window.pendingText = textToFill;
                
                // 3. 跳转到主界面 (如果已经在主界面，这一步可能没效果，但在 electron SPA 中通常意味着显示窗口)
                if (window.newChat) window.newChat();
                
                // 4. 填充文本逻辑
                const fillText = () => {
                    const textarea = document.getElementById('promptInput');
                    if (textarea && window.pendingText) {
                        textarea.value = window.pendingText;
                        textarea.dispatchEvent(new Event('input'));
                        textarea.focus();
                        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
                        window.pendingText = null;
                    }
                };
                
                fillText();
                if (document.readyState !== 'complete') {
                    document.addEventListener('DOMContentLoaded', fillText);
                }
            }
        }
    },
    "ai-quick": {
        mode: "list",
        args: {
            enter: (action, callbackSetList) => {
                // 获取用户配置的快捷指令
                const settings = window.services.getSettings();
                const commands = settings.quickCommands || [];
                
                if (commands.length === 0) {
                    callbackSetList([{
                        title: '暂无快捷指令',
                        description: '请先在插件设置中添加快捷指令',
                        icon: 'logo.png'
                    }]);
                    return;
                }

                // 转换格式供 uTools 显示
                const items = commands.map(cmd => ({
                    title: cmd.title,
                    description: `${cmd.modelLabel} - ${cmd.prompt ? cmd.prompt.slice(0, 30) + '...' : '无预设提示词'}`,
                    icon: 'logo.png',
                    data: cmd // 存储完整指令数据
                }));
                
                callbackSetList(items);
            },
            /**
             * 在超级面板中选择某个快捷指令后，跳转到主界面并应用指令
             * @param {Object} action - 超级面板动作上下文
             * @param {Object} itemData - 列表项数据
             */
            select: (action, itemData) => {
                const cmd = itemData.data;
                if (!cmd) return;

                // 将指令和选中文本传递给主界面
                window.pendingQuickCommand = cmd;
                if (action.type === 'over' && action.payload) {
                    window.pendingText = action.payload;
                } 
                // 移除自动读取剪贴板
                
                // 尝试跳转到插件主功能或显示主窗口
                // 优先尝试显示主窗口，如果支持的话
                try {
                    if (typeof utools.showMainWindow === 'function') {
                        utools.showMainWindow();
                    } else if (typeof utools.redirect === 'function') {
                        utools.redirect('ai');
                    }
                } catch (e) {}

                // 若主界面已加载，立即应用
                if (window.applyQuickCommand) {
                    window.applyQuickCommand(cmd);
                } else {
                    // 如果主界面还没加载完，等待加载
                    // 注意：如果重定向导致页面刷新，window对象会重置，pendingQuickCommand 会丢失
                    // 但如果是单页应用切换视图，window对象通常保留
                    // 为了保险，可以在这里不做额外处理，依赖 window.onload 中的检查
                }
            }
        }
    }
}

window.services = {
    // 获取内置模型列表
    getBuiltInModels: () => [...getSharedModels(), ...window.services.getLegacyModels()],

    // 获取旧版本地直连模型（不含共享目录模型），供界面单独分组展示
    getLegacyModels: () => [...BUILT_IN_MODELS, ...(window.services.getSettings().openaiModels || OPENAI_DEFAULT_MODELS).map(model => ({ ...model, provider: 'openai' }))],

    hasDirectOpenAIKey: async () => !!(await getDirectOpenAISecret()),
    saveDirectOpenAIKey: async value => {
        const key = String(value || '').trim();
        if (!key) return;
        const status = await ipcRenderer.invoke('plugin-secret-get', PLUGIN_NAME, 'direct-openai-api-key');
        if (!status?.encryptionAvailable) throw new Error('系统加密存储不可用');
        const result = await ipcRenderer.invoke('plugin-secret-set', PLUGIN_NAME, 'direct-openai-api-key', key);
        if (!result?.success || !result?.encryptionAvailable) throw new Error('OpenAI 密钥加密保存失败');
    },
    loadOpenAIModels: async inputKey => {
        const key = String(inputKey || '').trim() || await getDirectOpenAISecret();
        const result = await aiRuntimeForCatalog.listProviderModels({ baseUrl: 'https://api.openai.com/v1', key });
        return result.models.filter(model => model.capabilities?.includes('text')).map(model => ({ value: model.id, label: model.label || model.id, provider: 'openai' }));
    },

    // 获取共享供应商分组：每个供应商一组，仅保留声明 text 能力的模型
    getSharedProviderGroups: async () => {
        try {
            const config = await window.aiAPI.getConfig();
            return (config?.providers || [])
                .map(provider => ({
                    id: provider.id,
                    name: provider.name || provider.id,
                    models: (provider.models || [])
                        .filter(model => (model.capabilities || []).includes('text'))
                        .map(model => ({
                            value: model.id,
                            label: model.label || model.id,
                            provider: `shared:${provider.id}`
                        }))
                }))
                .filter(group => group.models.length > 0);
        } catch (_) {
            return [];
        }
    },

    // 读取共享目录当前文本模型选择（与其他 AI 插件的默认模型来源保持一致）
    getSharedTextSelection: async () => {
        try {
            const config = await window.aiAPI.getConfig();
            return config?.selections?.text || null;
        } catch (_) {
            return null;
        }
    },

    // 持久化共享目录文本模型选择，切换模型时与其他 AI 插件共享同一状态
    saveSharedTextSelection: async (providerId, modelId) => {
        try {
            const config = await window.aiAPI.getConfig();
            config.selections = config.selections || {};
            config.selections.text = { providerId, modelId };
            await window.aiAPI.saveConfig(config);
        } catch (error) { throw error; }
    },

    // 获取设置
    getSettings: () => {
        try {
            const settings = ipcRenderer.sendSync('plugin-storage-get', PLUGIN_NAME, 'ai-settings');
            // 确保 quickCommands 存在
            const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
            if (!merged.quickCommands) merged.quickCommands = [];
            return merged;
        } catch (error) {
            console.error('获取设置失败:', error);
            return DEFAULT_SETTINGS;
        }
    },

    // 保存设置
    saveSettings: (settings) => {
        try {
            return ipcRenderer.sendSync('plugin-storage-set', PLUGIN_NAME, 'ai-settings', settings) !== false;
        } catch (error) {
            console.error('保存设置失败:', error);
            return false;
        }
    },

    hasDecisionKey: async provider => aiRuntimeForCatalog.hasProviderSecret(`commander-jev-${provider}`),
    saveDecisionKey: async (provider, key) => {
        if (!['openrouter', 'typesafe'].includes(provider)) throw new Error('无效的 Jev 供应商');
        return aiRuntimeForCatalog.saveProviderSecret(`commander-jev-${provider}`, key);
    },
    decideCommanderRoute: async (message, plugins, aiTargets, provider) => {
        if (!['openrouter', 'typesafe'].includes(provider)) return null;
        let key = await aiRuntimeForCatalog.getProviderSecret(`commander-jev-${provider}`);
        if (!key && provider === 'openrouter') key = window.services.getSettings().openrouterApiKey;
        return decideRoute({ message, plugins, aiTargets, provider, apiKey: key });
    },

    getConversations: () => {
        const stored = ipcRenderer.sendSync('plugin-storage-get', PLUGIN_NAME, 'conversations-v1');
        return Array.isArray(stored) ? stored : [];
    },
    saveConversation: conversation => {
        if (!conversation || !conversation.id || !Array.isArray(conversation.messages)) return false;
        const records = window.services.getConversations();
        const index = records.findIndex(item => item.id === conversation.id);
        if (!conversation.messages.length) {
            if (index >= 0) records.splice(index, 1);
        } else if (index >= 0) records[index] = conversation;
        else records.push(conversation);
        ipcRenderer.sendSync('plugin-storage-set', PLUGIN_NAME, 'conversations-v1', records);
        return true;
    },
    deleteConversation: async conversationId => {
        if (typeof conversationId !== 'string' || !conversationId) return false;
        const records = await ipcRenderer.invoke('plugin-storage-get-async', PLUGIN_NAME, 'conversations-v1');
        if (!Array.isArray(records)) return false;
        const remaining = records.filter(item => item?.id !== conversationId);
        if (remaining.length === records.length) return false;
        return ipcRenderer.invoke('plugin-storage-set-async', PLUGIN_NAME, 'conversations-v1', remaining);
    },
    clearConversations: () => ipcRenderer.invoke('plugin-storage-remove-async', PLUGIN_NAME, 'conversations-v1'),

    showNotification: (body) => {
        if (Notification.permission === 'granted') {
            new Notification('AI 助手', { body });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    new Notification('AI 助手', { body });
                }
            });
        }
    },

    // 选择文件
    selectFile: () => {
        const result = ipcRenderer.sendSync('show-open-dialog', {
            title: '选择文件',
            properties: ['openFile']
        });
        return result ? result[0] : null;
    },

    // 读取文件内容
    readFile: (filePath) => {
        try {
            const stats = fs.statSync(filePath);
            if (stats.size > 10 * 1024 * 1024) { // 10MB 限制
                throw new Error('文件过大，最大支持 10MB');
            }

            const ext = path.extname(filePath).toLowerCase();
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
            
            if (isImage) {
                const data = fs.readFileSync(filePath);
                const base64 = data.toString('base64');
                return {
                    type: 'image',
                    content: base64,
                    mimeType: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}`,
                    name: path.basename(filePath)
                };
            } else {
                // 默认为文本
                const content = fs.readFileSync(filePath, 'utf8');
                return {
                    type: 'text',
                    content: content,
                    name: path.basename(filePath)
                };
            }
        } catch (error) {
            console.error('读取文件失败:', error);
            throw error;
        }
    },

    selectSavePath: () => {
        const result = ipcRenderer.sendSync('show-open-dialog', {
            title: '选择保存目录',
            properties: ['openDirectory']
        });
        return result ? result[0] : null;
    },

    saveChatHistory: (content) => {
        try {
            const settings = window.services.getSettings();
            if (!settings.savePath) {
                window.services.showNotification('请先在设置中选择 Markdown 导出目录');
                return false;
            }

            const normalizedPath = path.normalize(settings.savePath);
            if (!fs.existsSync(normalizedPath)) {
                fs.mkdirSync(normalizedPath, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const safeFileName = `chat-${timestamp}.md`;
            const filePath = path.join(normalizedPath, safeFileName);

            fs.writeFileSync(filePath, content, 'utf8');
            window.services.showNotification('对话已手动导出为 Markdown: ' + filePath);
            return true;
        } catch (error) {
            window.services.showNotification('保存失败: ' + error.message);
            return false;
        }
    },

    getChatHistory: async () => {
        const settings = window.services.getSettings();
        if (!settings.savePath) return [];
        
        const history = [];
        try {
            if (!fs.existsSync(settings.savePath)) return [];
            const files = await fs.promises.readdir(settings.savePath);
            
            for (const file of files) {
                if (file.endsWith('.md') && file.startsWith('chat-')) {
                    const filePath = path.join(settings.savePath, file);
                    try {
                        const stats = await fs.promises.stat(filePath);
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        // 简单的预览提取
                        let preview = content.slice(0, 100).replace(/[\r\n]/g, ' ');
                        history.push({
                            name: file,
                            path: filePath,
                            date: stats.mtime.toLocaleString(),
                            modifiedAt: stats.mtimeMs,
                            preview: preview + '...'
                        });
                    } catch (e) {}
                }
            }
            // 按时间倒序
            return history.sort((a, b) => b.modifiedAt - a.modifiedAt);
        } catch (error) {
            console.error(error);
            return [];
        }
    },

    loadChatFile: async (filePath) => {
        const savePath = window.services.getSettings().savePath;
        if (!savePath || path.dirname(path.resolve(filePath)) !== path.resolve(savePath)
            || !/^chat-.*\.md$/i.test(path.basename(filePath))) throw new Error('无效的历史记录路径');
        return await fs.promises.readFile(filePath, 'utf8');
    },
    chooseChatExport: () => {
        const savePath = window.services.getSettings().savePath;
        if (!savePath) return null;
        const selected = ipcRenderer.sendSync('show-open-dialog', {
            title: '打开已导出的对话', defaultPath: savePath,
            properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }]
        });
        return selected?.[0] || null;
    },

    insertContent: (content, type = 'text') => {
        return ipcRenderer.invoke('handle-content-insertion', {
            content: content,
            type: type
        });
    },

    // 注册插件特性（快捷指令）到主程序
    /**
     * 将快捷指令特性以可序列化的形式注册到主进程
     * 函数级注释：
     * - 仅保留 code/explain/cmds 三个字段，剔除函数、复杂对象，避免“An object could not be cloned”
     * - 确保 cmds 内部元素为字符串或简单对象（仅保留常用字段）
     */
    registerFeatures: (features) => {
        try {
            const sanitizeCmd = (c) => {
                if (typeof c === 'string') return c;
                if (c && typeof c === 'object') {
                    const out = {};
                    if (c.type) out.type = String(c.type);
                    if (typeof c.label === 'string' || Array.isArray(c.label)) out.label = c.label;
                    if (typeof c.minLength === 'number') out.minLength = c.minLength;
                    if (typeof c.maxLength === 'number') out.maxLength = c.maxLength;
                    if (c.match && typeof c.match === 'object') out.match = c.match;
                    return out;
                }
                return String(c);
            };

            const safeFeatures = Array.isArray(features) ? features.map(f => ({
                code: String(f.code || ''),
                explain: String(f.explain || ''),
                cmds: Array.isArray(f.cmds) ? f.cmds.map(sanitizeCmd) : []
            })) : [];

            return ipcRenderer.invoke('register-plugin-features', PLUGIN_NAME, safeFeatures)
                .catch(err => {
                    console.error('注册插件特性失败:', err);
                    return false;
                });
        } catch (error) {
            console.error('注册插件特性失败:', error);
            return false;
        }
    },

    copyToClipboard: (text) => {
        clipboard.writeText(text);
        window.services.showNotification('已复制到剪贴板');
    },

    // 总指挥读取当前真实插件目录，程序小店新增或升级插件后无需维护硬编码清单。
    listInstalledPluginCapabilities: () => listInstalledPluginCapabilities(path.resolve(__dirname, '..')),

    // 总指挥：打开匹配的本地工具或把任务移交给 AI 插件处理。
    // 复用主进程 execute-super-panel-action 的插件调用通道：
    // 主进程会把 clipboardText 包装成 {type:'over', payload} 传给目标插件的 enter(action)，
    // feature.args 会作为 featureArgs 一并透传，目标插件据此可实现"自动执行"
    delegateToPlugin: async (pluginFolder, featureCode, text, options = {}) => {
        try {
            const delegationOptions = options && typeof options === 'object' ? options : {};
            // __dirname 即本插件目录，先回到插件根目录再进入目标插件（开发态与打包态路径一致）
            const targetPath = path.resolve(__dirname, '..', pluginFolder);
            if (!fs.existsSync(path.join(targetPath, 'plugin.json'))) {
                return { success: false, error: `未安装插件：${pluginFolder}` };
            }
            return await ipcRenderer.invoke('execute-super-panel-action', {
                action: {
                    type: 'plugin',
                    pluginPath: targetPath,
                    // 路由只打开目标窗口并传入文本；由调用方显式控制 autoRun，
                    // 防止首次派发或再次打开时意外触发模型调用。
                    feature: { code: featureCode, args: { autoRun: delegationOptions.autoRun === true } }
                },
                clipboardText: String(text || '')
            });
        } catch (error) {
            console.error('移交插件失败:', error);
            return { success: false, error: error.message };
        }
    },

    async callAPI(message, modelConfig, conversationHistory, fileAttachment = null) {
        const settings = window.services.getSettings();
        
        if (!modelConfig || !modelConfig.value || !modelConfig.provider) {
            throw new Error('无效的模型配置');
        }

        const modelInfo = {
            value: modelConfig.value,
            provider: modelConfig.provider
        };

        if (modelInfo.provider.startsWith('shared:')) {
            const providerId = modelInfo.provider.slice('shared:'.length);
            return new ReadableStream({
                start(controller) {
                    const shared = createAiRuntime(PLUGIN_NAME, chunk => chunk.token && controller.enqueue(chunk.token));
                    shared.complete({ requestId: `legacy-chat-${Date.now()}`, selection: { providerId, modelId: modelInfo.value }, capability: fileAttachment?.type === 'image' ? 'vision' : 'text', stream: true, messages: [{ role: 'system', content: ASSISTANT_SYSTEM_PROMPT }, ...conversationHistory.map(item => ({ role: item.role, content: item.content })), { role: 'user', content: message }] })
                        .then(() => controller.close()).catch(error => controller.error(error));
                }
            });
        }

        // 准备消息列表
        let messages = [
            {
                role: "system",
                content: ASSISTANT_SYSTEM_PROMPT
            },
            ...conversationHistory.map(msg => ({
                role: msg.role,
                content: msg.content
            }))
        ];

        // 处理当前用户消息和附件
        let userContent = message;
        let imagePart = null;

        if (fileAttachment) {
            if (fileAttachment.type === 'text') {
                userContent += `\n\n[文件内容 ${fileAttachment.name}]:\n${fileAttachment.content}`;
            } else if (fileAttachment.type === 'image') {
                // 图片处理逻辑依赖于提供商
                imagePart = fileAttachment;
            }
        }

        if (modelInfo.provider === 'openai') {
            const key = await getDirectOpenAISecret();
            if (!key) throw new Error('请先在设置中填写并保存 OpenAI API Key');
            const content = imagePart ? [{ type: 'text', text: userContent },
                { type: 'image_url', image_url: { url: `data:${imagePart.mimeType};base64,${imagePart.content}` } }] : userContent;
            messages.push({ role: 'user', content });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 120000);
            try {
                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST', signal: controller.signal,
                    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: modelInfo.value, messages, stream: true })
                });
                if (!response.ok) throw new Error(`OpenAI 请求失败（HTTP ${response.status}），请检查密钥、模型权限与额度`);
                return openAITextStream(response, controller, timer);
            } catch (error) { clearTimeout(timer); throw error; }
        }

        // OpenRouter / DeepSeek (通常是 OpenAI 格式)
        if (modelInfo.provider === 'openrouter' || modelInfo.provider === 'deepseek') {
            let apiKey = modelInfo.provider === 'deepseek' ? settings.deepseekApiKey : settings.openrouterApiKey;
            let url = modelInfo.provider === 'deepseek' ? 'https://api.deepseek.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';

            if (!apiKey) throw new Error(`请先设置 ${modelInfo.provider} API Key`);

            const newMessage = { role: "user", content: userContent };
            
            // 如果是 OpenRouter 且有图片，尝试使用 multimodal 格式 (OpenAI Vision 格式)
            if (modelInfo.provider === 'openrouter' && imagePart) {
                newMessage.content = [
                    { type: "text", text: message },
                    { 
                        type: "image_url", 
                        image_url: { 
                            url: `data:${imagePart.mimeType};base64,${imagePart.content}` 
                        } 
                    }
                ];
            }

            messages.push(newMessage);

            let response;
            try {
                response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'http://localhost:8080',
                    'X-Title': 'uTools AI Plugin'
                },
                body: JSON.stringify({
                    model: modelInfo.value,
                    messages: messages,
                    stream: true
                })
            });
            } catch (e) {
                throw new Error('网络请求失败，请检查密钥和网络连接');
            }

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error?.message || '请求失败');
            }

            return new ReadableStream({
                async start(controller) {
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    try {
                        while (true) {
                            const {done, value} = await reader.read();
                            if (done) break;
                            const chunk = decoder.decode(value);
                            const lines = chunk.split('\n');
                            for (const line of lines) {
                                if (line.trim() === '' || line.trim() === 'data: [DONE]') continue;
                                if (line.startsWith('data: ')) {
                                    try {
                                        const parsed = JSON.parse(line.slice(6));
                                        const content = parsed.choices[0]?.delta?.content || '';
                                        if (content) controller.enqueue(content);
                                    } catch (e) { }
                                }
                            }
                        }
                    } catch (error) { controller.error(error); } 
                    finally { controller.close(); }
                }
            });
        } 
        // Gemini 原生 API
        else if (modelInfo.provider === 'gemini') {
            if (!settings.geminiApiKey) throw new Error('请先设置 Gemini API Key');

            // Gemini 的 history 格式不同，需要转换
            // 它是 contents: [{ role: 'user'|'model', parts: [{text: ...}] }]
            // system instruction 是单独的参数 (systemInstruction)
            
            let contents = conversationHistory.filter(msg => msg.role !== 'system').map(msg => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            }));

            // 当前消息
            let currentParts = [{ text: message }];
            
            // 如果有文件
            if (fileAttachment) {
                if (fileAttachment.type === 'text') {
                    currentParts[0].text += `\n\n[文件内容 ${fileAttachment.name}]:\n${fileAttachment.content}`;
                } else if (fileAttachment.type === 'image') {
                    currentParts.push({
                        inlineData: {
                            mimeType: fileAttachment.mimeType,
                            data: fileAttachment.content
                        }
                    });
                }
            }

            contents.push({
                role: 'user',
                parts: currentParts
            });

            let geminiResponse;
            try {
                geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelInfo.value}:generateContent?key=${settings.geminiApiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: contents,
                        systemInstruction: { parts: [{ text: [ASSISTANT_SYSTEM_PROMPT,
                            ...conversationHistory.filter(msg => msg.role === 'system').map(msg => msg.content)].join('\n') }] }
                    })
                });
            } catch (e) {
                throw new Error('网络请求失败，请检查密钥和网络连接');
            }

            if (!geminiResponse.ok) {
                const error = await geminiResponse.json();
                throw new Error(error.error?.message || '请求失败');
            }

            return new ReadableStream({
                async start(controller) {
                    try {
                        const response = await geminiResponse.json();
                        if (!response.candidates || !response.candidates[0].content.parts[0].text) {
                            throw new Error('无效的响应格式');
                        }
                        const text = response.candidates[0].content.parts[0].text;
                        // 简单流式模拟
                        const chunkSize = 20;
                        for (let i = 0; i < text.length; i += chunkSize) {
                            controller.enqueue(text.slice(i, i + chunkSize));
                            await new Promise(r => setTimeout(r, 10));
                        }
                    } catch (error) { controller.error(error); }
                    finally { controller.close(); }
                }
            });
        }

        throw new Error(`不支持的模型提供商: ${modelInfo.provider}`);
    },

    // 选择提示词路径
    selectPromptsPath: () => {
        const result = ipcRenderer.sendSync('show-open-dialog', {
            title: '选择提示词文件夹',
            properties: ['openDirectory']
        });
        return result ? result[0] : null;
    },

    // 获取提示词列表
    async getPrompts() {
        const settings = this.getSettings();
        if (!settings.promptsPath) return [];

        const prompts = [];
        try {
            if (!fs.existsSync(settings.promptsPath)) return [];
            const files = await fs.promises.readdir(settings.promptsPath);
            
            for (const file of files) {
                if (file.endsWith('.md')) {
                    const filePath = path.join(settings.promptsPath, file);
                    try {
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        let title = file.replace('.md', '');
                        const titleMatch = content.match(/^#\s+(.+)$/m);
                        if (titleMatch) title = titleMatch[1];
                        const preview = content.replace(/^#.*\n/, '').trim().slice(0, 150);
                        const fullContent = content.replace(/^#.*\n/, '').trim();
                        prompts.push({ title, preview, content: fullContent, path: filePath });
                    } catch (error) { console.error(error); }
                }
            }
        } catch (error) { console.error(error); }
        return prompts;
    },

    async searchPrompts(searchText) {
        const prompts = await this.getPrompts();
        if (!searchText) return prompts;
        searchText = searchText.toLowerCase();
        return prompts.filter(prompt => 
            prompt.title.toLowerCase().includes(searchText) || 
            prompt.content.toLowerCase().includes(searchText)
        );
    },

    highlightMatch(text, searchText) {
        if (!searchText) return text;
        const regex = new RegExp(searchText, 'gi');
        return text.replace(regex, match => `<mark>${match}</mark>`);
    },

    getSelectedText: () => window.selectedText || '',

    addSystemMessage: (content) => {
        // 辅助函数，具体UI操作应在 index.html 中实现，这里仅保留接口兼容
    },

    selectPrompt: (prompt) => {
        // 辅助函数，具体UI操作应在 index.html 中实现
    }
};

// 动态注册快捷指令对应的特性入口
try {
    const settings = window.services.getSettings();
    if (settings && settings.quickCommands) {
        settings.quickCommands.forEach((cmd, index) => {
             const slug = (cmd.title || `cmd-${index}`).replace(/[^\w\u4e00-\u9fa5]+/g, '-').toLowerCase();
             const code = `quick-${slug}`;
             
             // 如果该 code 尚未定义，则注册
             if (!window.exports[code]) {
                 window.exports[code] = {
                     mode: "none",
                     args: {
                         enter: (action) => {
                             // 1. 设置待处理指令
                             window.pendingQuickCommand = cmd;
                             
                             // 2. 获取输入文本
                             let textToFill = '';
                             if (action.type === 'over' && action.payload) {
                                 textToFill = action.payload;
                             } 
                             window.pendingText = textToFill;
                             
                             // 3. 跳转到主界面
                             if (window.newChat) window.newChat();
                             
                             // 4. 填充文本逻辑
                             const fillText = () => {
                                 const textarea = document.getElementById('promptInput');
                                 if (textarea && window.pendingText) {
                                     textarea.value = window.pendingText;
                                     textarea.dispatchEvent(new Event('input'));
                                     textarea.focus();
                                     textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
                                     window.pendingText = null;
                                 }
                             };
                             
                             fillText();
                             if (document.readyState !== 'complete') {
                                 document.addEventListener('DOMContentLoaded', fillText);
                             }
                             
                             // 5. 立即应用指令 (直接调用 window 对象上的方法)
                             if (window.applyQuickCommand) {
                                 window.applyQuickCommand(cmd);
                             }
                         }
                     }
                 };
             }
        });
    }
} catch (e) {
    console.error('动态注册快捷指令失败:', e);
}

// 旧代码在 contextIsolation 未启用时直接调用 contextBridge 会抛出
// "Unable to load preload script"；services 已挂在 window 上，失败时忽略即可
try {
    contextBridge.exposeInMainWorld('services', window.services);
} catch (_) {}
