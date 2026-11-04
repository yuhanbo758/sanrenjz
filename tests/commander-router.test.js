'use strict';

const assert = require('assert');
const path = require('path');
const { listInstalledPluginCapabilities } = require('../app/plugin_runtime/commander-plugin-catalog');
const {
    DEFAULT_AI_TARGETS,
    detectCommanderRoute,
    isExplicitAiRequest
} = require('../app/plugin_runtime/commander-router');

(async () => {
    const pluginRoot = path.join(__dirname, '..', 'app', 'software');
    const installedPlugins = await listInstalledPluginCapabilities(pluginRoot, process.platform);
    assert.ok(installedPlugins.length >= 30, '应从真实插件目录读取本地能力目录');

    const icoRoute = detectCommanderRoute('我需要将图片改成ico，调用插件', installedPlugins);
    assert.strictEqual(icoRoute.kind, 'local');
    assert.strictEqual(icoRoute.name, '图片优化器');
    assert.strictEqual(icoRoute.feature, 'plugin-market-image-converter');
    assert.strictEqual(icoRoute.autoRun, false);

    const browserRoute = detectCommanderRoute('打开浏览器：我爱你', installedPlugins);
    assert.strictEqual(browserRoute.folder, 'obsidian-surfing');
    assert.strictEqual(browserRoute.feature, 'main-feature');

    const cropRoute = detectCommanderRoute('把这张图片裁剪成封面，调用插件', installedPlugins);
    assert.strictEqual(cropRoute.folder, 'sanrenjz-tools-cut_image');
    assert.strictEqual(cropRoute.feature, 'image-crop');

    const qrRoute = detectCommanderRoute('生成二维码，调用插件', installedPlugins);
    assert.strictEqual(qrRoute.folder, 'sanrenjz-tools-qr-barcode');

    const textRoute = detectCommanderRoute('请把这段文本去重，调用插件', installedPlugins);
    assert.strictEqual(textRoute.feature, 'plugin-market-line-processor');

    const meetingRoute = detectCommanderRoute('会议总结：项目已经完成验收', installedPlugins, DEFAULT_AI_TARGETS);
    assert.strictEqual(meetingRoute.kind, 'ai');
    assert.strictEqual(meetingRoute.feature, 'plugin-market-ai-meeting');
    assert.strictEqual(meetingRoute.autoRun, true);

    const aiRegexRoute = detectCommanderRoute('用AI写一段正则匹配手机号', installedPlugins);
    assert.strictEqual(aiRegexRoute.feature, 'plugin-market-ai-regex');
    assert.strictEqual(isExplicitAiRequest('用AI写一段正则匹配手机号'), true);

    const namedAiToolRoute = detectCommanderRoute('调用AI语音输入法插件', installedPlugins);
    assert.strictEqual(namedAiToolRoute.folder, 'sanrenjz-tools-speech_input');

    // 用户明确要求 AI 时不得擅自改为普通本地工具；无对应 AI 插件则回到本助手回答。
    assert.strictEqual(detectCommanderRoute('用AI回答怎么把图片改成ico', installedPlugins), null);

    // 只有“图片”这种宽泛描述时不应在多个图片插件之间武断选择。
    assert.strictEqual(detectCommanderRoute('处理一下图片，调用插件', installedPlugins), null);
    assert.strictEqual(detectCommanderRoute('图片优化器插件的工作原理是什么？', installedPlugins), null);
    assert.strictEqual(detectCommanderRoute('什么是 AI 会议纪要？', installedPlugins), null);

    console.log('Commander router tests passed: local-first, AI fallback, explicit AI, ambiguity guard');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
