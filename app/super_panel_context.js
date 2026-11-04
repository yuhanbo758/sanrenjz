'use strict';

function detectTextContextTypes(textValue, hasImage = false) {
    const text = String(textValue || '').trim();
    const types = new Set();
    if (hasImage) types.add('image');
    if (!text) {
        if (types.size === 0) types.add('empty');
        return Array.from(types);
    }
    types.add('text');
    if (/^https?:\/\/\S+$/i.test(text)) types.add('url');
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) types.add('email');
    if (/^[\d+\-*/().\s]+$/.test(text) && /\d/.test(text)) types.add('expression');
    if (/[\u4e00-\u9fff]/.test(text)) types.add('chinese');
    if (/[a-zA-Z]/.test(text)) types.add('english');
    if (/^(\{|\[)[\s\S]*(\}|\])$/.test(text)) {
        try { JSON.parse(text); types.add('json'); } catch (_) { }
    }
    if (/\b(function|const|let|var|class|def|import|SELECT|INSERT|UPDATE)\b|=>|<\/?[a-z][^>]*>/i.test(text)) types.add('code');
    return Array.from(types);
}

module.exports = { detectTextContextTypes };
