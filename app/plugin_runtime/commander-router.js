(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CommanderRouter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_AI_TARGETS = [
        { id: 'meeting', name: 'AI 会议纪要', folder: 'sanrenjz-tools-ai-meeting', feature: 'plugin-market-ai-meeting', autoRun: true, keywords: ['会议总结', '会议纪要', '会议记录', '整理会议', '开会纪要'] },
        { id: 'writing', name: 'AI 写作工作室', folder: 'sanrenjz-tools-ai-writing', feature: 'plugin-market-ai-writing', autoRun: true, keywords: ['润色', '改写一下', '帮我改写', '扩写', '缩写', '生成标题', '起个标题'] },
        { id: 'review', name: 'AI 代码审查', folder: 'sanrenjz-tools-ai-code-review', feature: 'plugin-market-ai-code-review', autoRun: true, keywords: ['代码审查', '审查代码', '代码评审', 'code review', '检查代码'] },
        { id: 'git', name: 'AI Git 助手', folder: 'sanrenjz-tools-ai-git', feature: 'plugin-market-ai-git', autoRun: true, keywords: ['提交信息', 'commit message', 'git commit', '生成提交说明'] },
        { id: 'regex', name: 'AI 正则助手', folder: 'sanrenjz-tools-ai-regex', feature: 'plugin-market-ai-regex', autoRun: true, keywords: ['正则表达式', '写个正则', '写一段正则', '正则匹配'] },
        { id: 'sql', name: 'AI SQL 助手', folder: 'sanrenjz-tools-ai-sql', feature: 'plugin-market-ai-sql', autoRun: true, keywords: ['写sql', '写 sql', 'sql语句', 'sql 语句', '生成sql', '生成 sql', '查询语句'] },
        { id: 'prompt', name: 'AI 提示词工坊', folder: 'sanrenjz-tools-ai-prompt', feature: 'plugin-market-ai-prompt', autoRun: true, keywords: ['优化提示词', '提示词优化', '写个提示词', '生成提示词'] },
        { id: 'learning', name: 'AI 学习卡片', folder: 'sanrenjz-tools-ai-learning', feature: 'plugin-market-ai-learning', autoRun: true, keywords: ['制定学习计划', '学习计划', '费曼学习', '出几道题', '出练习题'] },
        { id: 'document', name: 'AI 文档阅读器', folder: 'sanrenjz-tools-ai-document', feature: 'plugin-market-ai-document', autoRun: false, keywords: ['总结文档', '文档总结', '读一下文档', '文档速读'] }
    ];

    // plugin.json 的命令词是主要事实源；这里只补充自然语言与功能名不完全同序的高价值同义表达。
    const FEATURE_ALIASES = {
        'plugin-market-image-converter': ['ico', '图片改成', '图片转成', '图片转换格式', '转换图片格式', '图标格式'],
        'plugin-market-archive-tool': ['压缩文件', '打包文件', '解压文件', '解压缩'],
        'plugin-market-qr-barcode': ['生成二维码', '制作二维码', '扫码识别'],
        'plugin-market-config-converter': ['配置转成', '配置格式转换'],
        'plugin-market-svg-workbench': ['svg转png', 'svg 转 png'],
        'plugin-market-csv-table': ['表格转json', 'json转csv'],
        'image-crop': ['裁成封面', '裁剪封面']
    };

    const MEANINGFUL_TERMS = [
        'ico', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg', 'pdf', 'csv', 'json', 'yaml', 'toml',
        'xml', 'zip', 'base64', 'md5', 'sha256', 'hmac', 'jwt', 'uuid', 'hosts', 'sqlite', 'markdown',
        '图片', '裁剪', '压缩', '缩放', '水印', '拼接', '二维码', '条码', '文件', '重命名', '校验',
        '解压', '目录树', '文本', '编码', '正则', '对比', '去重', '排序', '时间戳', '时区', '日期',
        '单位换算', '计算器', '颜色', '色板', '数据库', '数据表', '密码', '便签', '笔记', '待办',
        '习惯', '番茄钟', '工时', '局域网', '书签', '网页', '微信多开', '语音输入'
    ];

    const EXPLICIT_AI_PATTERNS = [
        /(?:交给|调用|使用|让|用)\s*(?:ai|人工智能|大模型|模型)/i,
        /(?:ai|人工智能|大模型)\s*(?:回答|处理|生成|分析|总结|改写|创作)/i,
        /优化提示词|提示词优化|生成提示词|反向提示词/i
    ];

    function normalizeText(value) {
        return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function isExplicitAiRequest(message) {
        const text = normalizeText(message);
        return EXPLICIT_AI_PATTERNS.some(pattern => pattern.test(text));
    }

    function isExplanationRequest(message) {
        const text = normalizeText(message);
        const action = /(?:调用|打开|启动|运行|帮我|替我|请把|给我处理)/.test(text);
        return !action && /(?:什么是|是什么意思|介绍一下|解释一下|工作原理|如何使用|怎么使用|能做什么|支持什么|为什么|有什么区别|是否需要)/.test(text);
    }

    function findAiTarget(message, targets, installedPlugins) {
        const text = normalizeText(message);
        let best = null;
        let bestLength = 0;
        for (const target of Array.isArray(targets) ? targets : []) {
            const installed = (installedPlugins || []).some(plugin =>
                plugin.folder === target.folder && plugin.features.some(feature => feature.code === target.feature));
            if (!installed) continue;
            for (const keyword of target.keywords || []) {
                const normalizedKeyword = normalizeText(keyword);
                if (text.includes(normalizedKeyword) && normalizedKeyword.length > bestLength) {
                    best = { ...target, kind: 'ai' };
                    bestLength = normalizedKeyword.length;
                }
            }
        }
        return best;
    }

    function scoreLocalFeature(message, plugin, feature) {
        const text = normalizeText(message);
        const pluginName = normalizeText(plugin.name);
        const explain = normalizeText(feature.explain);
        const searchable = normalizeText([
            plugin.name,
            plugin.description,
            plugin.category,
            feature.explain,
            feature.description,
            ...(feature.keywords || [])
        ].join(' '));
        let score = 0;
        const reasons = [];

        if (pluginName.length >= 2 && text.includes(pluginName)) {
            score += 360;
            reasons.push(plugin.name);
        }
        if (explain.length >= 2 && text.includes(explain)) {
            score += 260;
            reasons.push(feature.explain);
        }
        for (const keyword of feature.keywords || []) {
            const normalizedKeyword = normalizeText(keyword);
            if (normalizedKeyword.length >= 2 && text.includes(normalizedKeyword)) {
                score += 180 + Math.min(normalizedKeyword.length * 3, 45);
                reasons.push(keyword);
            }
        }
        for (const alias of FEATURE_ALIASES[feature.code] || []) {
            const normalizedAlias = normalizeText(alias);
            if (text.includes(normalizedAlias)) {
                score += 280 + Math.min(normalizedAlias.length * 4, 60);
                reasons.push(alias);
            }
        }
        for (const term of MEANINGFUL_TERMS) {
            const normalizedTerm = normalizeText(term);
            if (!text.includes(normalizedTerm) || !searchable.includes(normalizedTerm)) continue;
            const ascii = /^[a-z0-9.+_-]+$/i.test(normalizedTerm);
            score += ascii ? 120 : Math.min(35 + normalizedTerm.length * 18, 105);
            reasons.push(term);
        }

        return {
            score: score + Math.min(Number(feature.priority) || 0, 30),
            reasons: [...new Set(reasons)]
        };
    }

    function findLocalTool(message, installedPlugins, excludedFeatureCodes = new Set()) {
        const candidates = [];
        for (const plugin of Array.isArray(installedPlugins) ? installedPlugins : []) {
            if (plugin.folder === 'sanrenjz.tools-ai') continue;
            for (const feature of plugin.features || []) {
                if (excludedFeatureCodes.has(feature.code)) continue;
                const scored = scoreLocalFeature(message, plugin, feature);
                candidates.push({ plugin, feature, ...scored });
            }
        }
        candidates.sort((left, right) => right.score - left.score || right.feature.priority - left.feature.priority);
        const best = candidates[0];
        if (!best || best.score < 120) return null;

        // 同分且没有明确点名插件时不擅自打开，交给后续 AI 路由或普通对话处理。
        const second = candidates[1];
        const namedPlugin = normalizeText(message).includes(normalizeText(best.plugin.name));
        if (second && second.score === best.score && !namedPlugin) return null;
        return {
            kind: 'local',
            name: best.plugin.name,
            folder: best.plugin.folder,
            feature: best.feature.code,
            featureName: best.feature.explain,
            autoRun: false,
            matchReason: best.reasons.slice(0, 3).join('、')
        };
    }

    function detectCommanderRoute(message, installedPlugins, aiTargets = DEFAULT_AI_TARGETS) {
        const text = normalizeText(message);
        if (!text) return null;
        // 问插件原理或能力不是执行任务；即使提到插件名，也应由助手解释。
        if (isExplanationRequest(text)) return null;
        const explicitAi = isExplicitAiRequest(text);
        const aiFeatureCodes = new Set(aiTargets.map(target => target.feature));

        // 明确点名某个已安装插件时，插件名称比“AI”字样优先级更高，例如“调用 AI语音输入法插件”。
        const namedPlugin = (installedPlugins || [])
            .filter(plugin => plugin.folder !== 'sanrenjz.tools-ai')
            .filter(plugin => normalizeText(plugin.name).length >= 2 && text.includes(normalizeText(plugin.name)))
            .sort((left, right) => normalizeText(right.name).length - normalizeText(left.name).length)[0];
        if (namedPlugin) {
            const namedAiTarget = aiTargets.find(target => target.folder === namedPlugin.folder);
            if (namedAiTarget) return { ...namedAiTarget, kind: 'ai' };
            return findLocalTool(text, [namedPlugin], new Set());
        }

        // 明确要求 AI 时尊重用户意图；否则普通本地工具始终先于生成式 AI 插件。
        if (!explicitAi) {
            const localRoute = findLocalTool(text, installedPlugins, aiFeatureCodes);
            if (localRoute) return localRoute;
        }
        return findAiTarget(text, aiTargets, installedPlugins);
    }

    return {
        DEFAULT_AI_TARGETS,
        detectCommanderRoute,
        findAiTarget,
        findLocalTool,
        isExplicitAiRequest,
        isExplanationRequest,
        normalizeText,
        scoreLocalFeature
    };
});
