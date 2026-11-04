'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 提取 plugin.json 中可用于总指挥检索的文字标签，过滤函数和其他不可序列化字段。
 */
function normalizeCommandLabels(commands) {
    const labels = [];
    for (const command of Array.isArray(commands) ? commands : []) {
        if (typeof command === 'string' && command.trim()) {
            labels.push(command.trim());
            continue;
        }
        const value = command && command.label;
        if (typeof value === 'string' && value.trim()) labels.push(value.trim());
        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string' && item.trim()) labels.push(item.trim());
            }
        }
    }
    return [...new Set(labels)];
}

/**
 * 从真实插件安装目录读取能力目录。开发态传 app/software，打包态传安装目录下 plugins。
 * 单个第三方插件清单损坏时跳过该插件，不阻塞总指挥检索其他可用工具。
 */
async function listInstalledPluginCapabilities(pluginRoot, platform = process.platform) {
    const root = path.resolve(String(pluginRoot || ''));
    let entries = [];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (_) {
        return [];
    }

    const plugins = await Promise.all(entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
            try {
                const manifestPath = path.join(root, entry.name, 'plugin.json');
                const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
                const features = (Array.isArray(manifest.features) ? manifest.features : [])
                    .filter(feature => feature && typeof feature.code === 'string' && feature.code.trim())
                    .filter(feature => !Array.isArray(feature.platform) || feature.platform.includes(platform))
                    .map(feature => ({
                        code: feature.code.trim(),
                        explain: String(feature.explain || ''),
                        description: String(feature.description || ''),
                        keywords: normalizeCommandLabels(feature.cmds),
                        priority: Number(feature.priority) || 0
                    }));
                if (!features.length) return null;
                return {
                    folder: entry.name,
                    name: String(manifest.pluginName || entry.name),
                    description: String(manifest.description || ''),
                    category: String(manifest.category || ''),
                    features
                };
            } catch (_) {
                return null;
            }
        }));

    return plugins.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

module.exports = {
    listInstalledPluginCapabilities,
    normalizeCommandLabels
};
