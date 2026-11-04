'use strict';

/**
 * Returns true only when a model explicitly says the request did not contain
 * usable audio. Ordinary transcripts may legitimately contain words such as
 * "语音" and "没有", so proximity-only matching is intentionally avoided.
 */
function looksLikeMissingAudioReply(text) {
    const message = String(text || '').trim();
    if (!message) return false;

    const chinesePatterns = [
        /(?:没有|未)(?:收到|检测到|识别到|找到|提供|上传|包含|附加).{0,10}(?:音频|语音|录音|音频文件)/i,
        /(?:音频|语音|录音|音频文件)(?:数据|内容|附件)?(?:缺失|为空|未提供|未上传|不可用|不存在)/i,
        /请(?:提供|上传|附加).{0,10}(?:音频|语音|录音|音频文件)/i,
        /无法(?:访问|读取|获取|处理).{0,10}(?:音频|语音|录音|音频文件)/i
    ];
    const englishPatterns = [
        /\bno\s+(?:audio|audio\s+file|recording)\s+(?:was\s+)?(?:provided|uploaded|attached|found|detected)\b/i,
        /\b(?:audio|audio\s+file|recording)\s+(?:is\s+)?(?:missing|empty|not\s+provided|not\s+uploaded|required|unavailable)\b/i,
        /\bwithout\s+(?:an?\s+)?(?:audio|audio\s+file|recording)\b/i,
        /\bplease\s+(?:provide|upload|attach)\s+(?:an?\s+)?(?:audio|audio\s+file|recording)\b/i
    ];
    return [...chinesePatterns, ...englishPatterns].some(pattern => pattern.test(message));
}

module.exports = { looksLikeMissingAudioReply };
