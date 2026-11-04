'use strict';

const assert = require('assert');
const path = require('path');
const { listInstalledPluginCapabilities } = require('../app/plugin_runtime/commander-plugin-catalog');
const { buildDecisionRequest, resolveDecision, decideRoute } = require('../app/plugin_runtime/commander-jev');

(async () => {
    const installed = await listInstalledPluginCapabilities(path.join(__dirname, '..', 'app', 'software'));
    const targets = require('../app/plugin_runtime/commander-router').DEFAULT_AI_TARGETS;
    const request = buildDecisionRequest('整理一下这份会议内容', installed, targets, 'openrouter');
    assert.strictEqual(request.endpoint.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.strictEqual(request.body.model, 'typesafe/jev-1.13');
    assert.ok(request.body.questions.route.criteria.reply);
    const meeting = [...request.routes].find(([, route]) => route.feature === 'plugin-market-ai-meeting');
    assert.ok(meeting, '已安装会议插件应进入候选列表');
    const answer = { type: 'choice', choice: meeting[0], probabilities: { [meeting[0]]: 0.96 }, confidence: 0.91 };
    assert.strictEqual(resolveDecision(answer, request.routes).folder, 'sanrenjz-tools-ai-meeting');
    assert.strictEqual(resolveDecision({ ...answer, confidence: 0.29 }, request.routes), null);
    assert.strictEqual(resolveDecision({ ...answer, choice: 'plugin_999' }, request.routes), null);
    assert.strictEqual(resolveDecision({ ...answer, choice: 'reply' }, request.routes), null);

    let requestBody;
    const route = await decideRoute({ message: '整理一下这份会议内容', plugins: installed, aiTargets: targets,
        provider: 'typesafe', apiKey: 'test-key', fetchImpl: async (url, options) => {
            assert.strictEqual(url, 'https://api.typesafe.ai/v1/systemone');
            assert.strictEqual(options.headers.Authorization, 'Bearer test-key');
            requestBody = JSON.parse(options.body);
            const typeSafeMeeting = Object.entries(requestBody.questions.route.criteria)
                .find(([, label]) => label.includes('AI 会议纪要'))[0];
            return { ok: true, json: async () => ({ answers: { route: {
                type: 'choice', choice: typeSafeMeeting,
                probabilities: { [typeSafeMeeting]: 0.94 }, confidence: 0.9
            } } }) };
        } });
    assert.strictEqual(requestBody.model, 'jev-latest');
    assert.strictEqual(route.kind, 'ai');
    assert.strictEqual(route.autoRun, false, 'Jev 推断出的 AI 插件仅打开并填入，不自动调用付费模型');

    const explicit = buildDecisionRequest('用 AI 处理图片', installed, targets, 'openrouter');
    assert.ok([...explicit.routes.values()].some(item => item.kind === 'local'), 'Jev 启用后应看到全部本地插件，由它判断是否调用');
    const allFeatureCount = installed.filter(plugin => plugin.folder !== 'sanrenjz.tools-ai')
        .reduce((sum, plugin) => sum + plugin.features.length, 0);
    assert.strictEqual(explicit.routes.size, allFeatureCount, '不得只给 Jev 前 18 个候选');
    const synthetic = { folder: 'local-image-generator', name: '图片生成', category: 'AI 工具',
        description: '根据文字生成图片', features: [{ code: 'create-image', explain: '文生图',
            description: '根据提示词生成图片', keywords: ['图片生成'] }] };
    const withInstalledImageGenerator = buildDecisionRequest('打开图片生成插件', [...installed, synthetic], targets, 'typesafe');
    const imageOption = [...withInstalledImageGenerator.routes].find(([, item]) => item.folder === 'local-image-generator');
    assert.ok(imageOption, '新安装的图片生成插件必须进入 Jev 候选');
    assert.strictEqual(resolveDecision({ type: 'choice', choice: imageOption[0],
        probabilities: { [imageOption[0]]: 0.74 }, confidence: 0.51 }, withInstalledImageGenerator.routes)?.folder,
    'local-image-generator', '有效插件选择不应被过高阈值误杀');
    assert.ok(![...explicit.routes.values()].some(item => item.name === '图片生成'), '当前真实目录并未安装图片生成插件');
    const absentRequest = buildDecisionRequest('打开图片生成插件', installed, targets, 'typesafe');
    const imageUnderstanding = [...absentRequest.routes].find(([, item]) => item.name === 'AI 图片理解');
    assert.ok(imageUnderstanding);
    assert.strictEqual(resolveDecision({ type: 'choice', choice: imageUnderstanding[0],
        probabilities: { [imageUnderstanding[0]]: 0.99 }, confidence: 0.99 }, absentRequest.routes,
    '打开图片生成插件'), null, '不能把图片理解误报为图片生成插件');
    console.log('Commander Jev tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
