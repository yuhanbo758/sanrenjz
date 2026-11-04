(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProviderUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function normalizeBaseUrl(baseUrl) {
        let value = String(baseUrl || '').trim().replace(/\/+$/, '');
        value = value.replace(/\/chat\/completions$/i, '');
        if (!/^https?:\/\//i.test(value)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
        return value;
    }

    function parseMultimodalTranslation(content) {
        const normalized = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const start = normalized.indexOf('{');
        const end = normalized.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('多模态模型未返回可解析的原文与译文');
        let parsed;
        try { parsed = JSON.parse(normalized.slice(start, end + 1)); }
        catch (_) { throw new Error('多模态模型返回格式不正确，请重试或更换模型'); }
        const sourceText = String(parsed.sourceText || parsed.source || '').trim();
        const translatedText = String(parsed.translatedText || parsed.translation || '').trim();
        if (!sourceText || !translatedText) throw new Error('多模态模型未完整返回原文与译文');
        return { sourceText, translatedText };
    }

    return { normalizeBaseUrl, parseMultimodalTranslation };
});
