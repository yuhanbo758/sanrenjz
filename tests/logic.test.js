'use strict';

const assert = require('assert');
const { searchCatalog } = require('../app/search_utils');
const { detectTextContextTypes } = require('../app/super_panel_context');
const { normalizeBaseUrl, parseMultimodalTranslation } = require('../app/software/sanrenjz-tools-ai_screen_trans/provider-utils');
const screenshotPlugin = require('../app/software/sanrenjz-tools-ai_screen_trans/plugin.json');
const fs = require('fs');
const path = require('path');

const results = searchCatalog('截图 翻译', [
    { name: '翻译插件', searchText: '截图 翻译 deepseek' }
], [
    { title: '普通命令', searchTitle: '普通命令', searchBody: '无关内容', contentType: 'command' }
]);
assert.strictEqual(results[0].name, '翻译插件');
assert.ok(results[0].matchedKeywordsCount >= 2);
assert.strictEqual(searchCatalog('a', Array.from({ length: 100 }, (_, index) => ({ name: String(index), searchText: `a${index}` })), [], 50).length, 50);
const largeCatalog = Array.from({ length: 5000 }, (_, index) => ({ name: `插件${index}`, searchText: `插件${index} 文本 翻译` }));
const startedAt = Date.now();
assert.strictEqual(searchCatalog('文本 翻译', largeCatalog, [], 50).length, 50);
const elapsed = Date.now() - startedAt;
assert.ok(elapsed < 500, `5000 项搜索耗时过长: ${elapsed}ms`);
console.log(`5000 item search: ${elapsed}ms`);

assert.ok(detectTextContextTypes('https://example.com').includes('url'));
assert.ok(detectTextContextTypes('test@example.com').includes('email'));
assert.ok(detectTextContextTypes('{"a":1}').includes('json'));
assert.ok(detectTextContextTypes('const a = 1').includes('code'));
assert.deepStrictEqual(detectTextContextTypes('', true), ['image']);

assert.strictEqual(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
assert.strictEqual(normalizeBaseUrl('https://example.com/v1/chat/completions'), 'https://example.com/v1');
assert.throws(() => normalizeBaseUrl('example.com/v1'));
assert.deepStrictEqual(
    parseMultimodalTranslation('```json\n{"sourceText":"你好","translatedText":"Hello"}\n```'),
    { sourceText: '你好', translatedText: 'Hello' }
);
assert.throws(() => parseMultimodalTranslation('{"sourceText":"缺少译文"}'), /未完整返回/);
const screenshotFeature = screenshotPlugin.features.find(feature => feature.code === 'ai-screen-ocr-translate');
const textFeature = screenshotPlugin.features.find(feature => feature.code === 'ai-screen-text-translate');
assert.strictEqual(screenshotFeature.startHidden, true);
assert.notStrictEqual(textFeature.startHidden, true);
assert.ok(screenshotFeature.cmds.includes('OCR识别'));
assert.strictEqual(textFeature.cmds.find(command => typeof command === 'object').label, '文本翻译');
assert.strictEqual(screenshotFeature.cmds.find(command => typeof command === 'object').label, '截图翻译');

// 截图入口必须同时提供仅 OCR 和 OCR 后翻译，并暴露 OCR 文本复制按钮。
const pluginDirectory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-ai_screen_trans');
const pluginHtml = fs.readFileSync(path.join(pluginDirectory, 'index.html'), 'utf8');
const pluginRenderer = fs.readFileSync(path.join(pluginDirectory, 'renderer.js'), 'utf8');
assert.ok(pluginHtml.includes('id="promptOcrBtn"'));
assert.ok(pluginHtml.includes('id="ocrTranslateBtn"'));
assert.ok(pluginRenderer.includes('复制 OCR 文本'));
assert.ok(pluginRenderer.includes('async function recognizeScreenshot()'));
assert.ok(pluginRenderer.includes('async function translateRecognizedText()'));
assert.ok(pluginRenderer.includes("StatusBar.set('OCR 识别完成，可复制文字或继续翻译')"));
// OCR 必须把实际截图 data URL 原样传给视觉模型，不能把 JPEG/WebP 一律伪装成 PNG。
assert.ok(pluginRenderer.includes("image_url: { url: state.screenshotDataUrl }"));
assert.ok(pluginRenderer.includes('ocrRunning: false'));
assert.ok(pluginHtml.includes('id="screenshotModeSelect"'));
assert.ok(pluginHtml.includes('id="multimodalModelSelect"'));
assert.ok(pluginRenderer.includes('async function translateScreenshotWithMultimodal()'));
assert.ok(pluginRenderer.includes('state.settings.multimodalSelection'));
assert.ok(pluginRenderer.includes('window.ProviderUtils.parseMultimodalTranslation(response)'));
assert.ok(pluginRenderer.includes('async function refreshManagedModelCatalog()'));
assert.ok(pluginRenderer.includes('window.services.listOpenCodeModels()'));

// 截图叠加层需要上报实际 CSS 视口尺寸，主进程才能在 Windows DPI 缩放下正确裁剪。
const screenshotOverlay = fs.readFileSync(path.join(__dirname, '..', 'screenshot-overlay.html'), 'utf8');
const mainProcess = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert.ok(screenshotOverlay.includes('viewport: { width: innerWidth, height: innerHeight }'));
assert.ok(mainProcess.includes('payload.viewport?.width'));
assert.ok(mainProcess.includes('截图坐标换算失败，请重新截图'));
assert.ok(mainProcess.includes('capturedSourceGroups = await Promise.all(displays.map'));
assert.ok(mainProcess.includes('display.bounds.width * display.scaleFactor'));

console.log('logic tests passed');
