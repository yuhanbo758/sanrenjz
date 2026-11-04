'use strict';

/**
 * 对已经预归一化的搜索目录执行纯内存评分，便于渲染层和 Node 测试复用。
 */
function searchCatalog(query, plugins, contents, limit = 50) {
    const keywords = [...new Set(String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean))];
    if (keywords.length === 0) return [];
    const results = [];
    const scoreText = (text, exactWeight, includeWeight) => {
        let score = 0;
        const matched = new Set();
        for (const keyword of keywords) {
            if (text.includes(keyword)) {
                score += text === keyword ? exactWeight : includeWeight;
                matched.add(keyword);
            }
        }
        return { score, matched };
    };
    const matchBonus = count => (count > 1 ? (count - 1) * 50 : 0) + (count === keywords.length && count > 1 ? 100 : 0);

    for (const plugin of plugins || []) {
        const match = scoreText(String(plugin.searchText ?? `${plugin.name || ''}\n${plugin.description || ''}`).toLowerCase(), 100, 50);
        if (match.score > 0) results.push({ ...plugin, type: 'plugin', score: match.score + matchBonus(match.matched.size), matchedKeywordsCount: match.matched.size, totalKeywords: keywords.length });
    }
    for (const content of contents || []) {
        const titleMatch = scoreText(String(content.searchTitle ?? content.title ?? '').toLowerCase(), 100, 80);
        const bodyMatch = scoreText(`${content.searchBody ?? content.content ?? ''}\n${content.preview || ''}`.toLowerCase(), 30, 30);
        // 不同词可能分散在标题、正文和预览中，覆盖数应取并集，不能取单字段最大值。
        const matched = new Set([...titleMatch.matched, ...bodyMatch.matched]).size;
        const score = titleMatch.score + bodyMatch.score + matchBonus(matched);
        if (score > 0) results.push({ ...content, type: 'content', score, matchedKeywordsCount: matched, totalKeywords: keywords.length });
    }
    const typePriority = item => item.type === 'plugin' ? 2 : (item.contentType === 'command' ? 1 : 0);
    // 先满足用户的多词意图；覆盖相同时保留插件、命令、片段的优先级，再比较相关性。
    return results.sort((a, b) => b.matchedKeywordsCount - a.matchedKeywordsCount || typePriority(b) - typePriority(a) || b.score - a.score).slice(0, limit);
}

module.exports = { searchCatalog };
