'use strict';

const ENDPOINTS = {
    openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
    typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' }
};

function buildDecisionRequest(message, plugins, aiTargets, provider) {
    const endpoint = ENDPOINTS[provider];
    if (!endpoint) throw new Error('未选择有效的 Jev 供应商');
    const installed = Array.isArray(plugins) ? plugins : [];
    const targetFolders = new Set((aiTargets || []).map(target => target.folder));
    const routes = new Map();
    const criteria = {
        reply: '由当前 LLM 直接回复。适用于闲聊、解释、写诗等通用文本生成，或没有真正具备所需功能的已安装插件。不能把图片编辑或图片理解当作图片生成。'
    };
    for (const plugin of installed) {
        if (plugin.folder === 'sanrenjz.tools-ai') continue;
        for (const feature of plugin.features || []) {
            const id = `plugin_${routes.size}`;
            const ai = targetFolders.has(plugin.folder) || /AI\s*工具/i.test(plugin.category || '');
            routes.set(id, {
                kind: ai ? 'ai' : 'local', folder: plugin.folder, feature: feature.code,
                name: plugin.name, featureName: feature.explain, autoRun: false,
                capabilityText: [plugin.name, plugin.description, feature.explain, feature.description,
                    ...(feature.keywords || [])].join(' ')
            });
            criteria[id] = `${plugin.name}｜${feature.explain || ''}：${feature.description || plugin.description || ''}。命令词：${(feature.keywords || []).slice(0, 5).join('、')}`.slice(0, 260);
        }
    }
    // TypeSafe Choice 最多 255 项；目录超限时显式失败，不能静默截断而漏掉已安装插件。
    if (Object.keys(criteria).length > 255) throw new Error('已安装插件功能超过 Jev 单次可判断上限');
    return {
        endpoint,
        routes,
        body: {
            model: endpoint.model,
            state: { user_request: String(message || '').slice(0, 12000) },
            questions: {
                route: {
                    type: 'choice',
                    instructions: '在“由当前 LLM 回复”和“打开某个已安装插件功能”之间选择。用户明确要求打开/调用插件，且列表中确有具备该能力的插件时选该插件；专用任务如会议纪要也可选对应插件。闲聊、解释、写诗等通用生成选 reply。严格按功能而非名字相似度判断；没有所需能力时选 reply，绝不能假称已打开插件。',
                    criteria
                }
            }
        }
    };
}

function resolveDecision(answer, routes, message = '') {
    if (!answer || answer.type !== 'choice' || answer.choice === 'reply') return null;
    const probability = Number(answer.probabilities?.[answer.choice]);
    const confidence = Number(answer.confidence);
    if (!routes.has(answer.choice) || probability < 0.55 || confidence < 0.3) return null;
    const route = routes.get(answer.choice);
    const namedRequest = String(message).match(/(?:打开|调用|启动)\s*([^\s，。？！、]{2,12})插件/);
    if (namedRequest && !/(?:的|相关|一个|任何|可以|能够)/.test(namedRequest[1])) {
        const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
        // 用户直接点名能力时，不能把“图片理解”等相似名称冒充“图片生成”。
        if (!normalize(route.capabilityText).includes(normalize(namedRequest[1]).replace(/^ai/, ''))) return null;
    }
    return route;
}

async function decideRoute({ message, plugins, aiTargets, provider, apiKey, fetchImpl = fetch }) {
    if (!apiKey) throw new Error('请先配置 Jev 判断专用 API Key');
    const { endpoint, routes, body } = buildDecisionRequest(message, plugins, aiTargets, provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetchImpl(endpoint.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`Jev 判断服务返回 HTTP ${response.status}`);
        const result = await response.json();
        return resolveDecision(result?.answers?.route, routes, message);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { ENDPOINTS, buildDecisionRequest, resolveDecision, decideRoute };
