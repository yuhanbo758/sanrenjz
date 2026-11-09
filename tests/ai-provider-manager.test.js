const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'plugin_runtime', 'ai-provider-manager.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context, { filename: 'ai-provider-manager.js' });

const models = context.window.AIProviderManager.parseModels([
  'glm-4-flash | GLM-4 Flash | text',
  'glm-4v-plus | GLM-4V Plus | text,vision',
  'deepseek-chat | DeepSeek Chat'
].join('\n'));

assert.deepStrictEqual(JSON.parse(JSON.stringify(models)), [
  { id: 'glm-4-flash', label: 'GLM-4 Flash', capabilities: ['text'] },
  { id: 'glm-4v-plus', label: 'GLM-4V Plus', capabilities: ['text', 'vision'] },
  { id: 'deepseek-chat', label: 'DeepSeek Chat', capabilities: ['text'] }
]);
// 多模态能力（vision/audio）应被解析保留，audio 不再被静默丢弃；未知能力被过滤
const multimodal = context.window.AIProviderManager.parseModels([
  'mimo-v2.5 | MiMo V2.5 多模态 | text,vision,audio',
  'MiniMax-M3 | MiniMax M3 视觉 | text,vision',
  'unknown-cap | 未知能力 | text,bogus,vision'
].join('\n'));
assert.deepStrictEqual(JSON.parse(JSON.stringify(multimodal)), [
  { id: 'mimo-v2.5', label: 'MiMo V2.5 多模态', capabilities: ['text', 'vision', 'audio'] },
  { id: 'MiniMax-M3', label: 'MiniMax M3 视觉', capabilities: ['text', 'vision'] },
  { id: 'unknown-cap', label: '未知能力', capabilities: ['text', 'vision'] }
]);

const merged = context.window.AIProviderManager.mergeOpenCodeProviders(
  [{ id: 'manual', name: 'Manual' }, { id: 'opencode:old', source: 'opencode', transport: 'opencode' }],
  [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-codex', label: 'GPT Codex', capabilities: ['text'] }] }]
);
assert.deepStrictEqual(JSON.parse(JSON.stringify(merged.providers)), [
  { id: 'manual', name: 'Manual' },
  {
    id: 'opencode:openai', name: 'OpenAI', sourceProviderId: 'openai', source: 'opencode', transport: 'opencode', managed: true,
    models: [{ id: 'gpt-codex', label: 'GPT Codex', capabilities: ['text'], sourceModelId: 'gpt-codex' }]
  }
]);
assert.strictEqual(context.window.AIProviderManager.isOpenCodeProvider({ baseUrl: 'opencode://openai' }), true);
assert.strictEqual(context.window.AIProviderManager.isOpenCodeProvider({ baseUrl: 'https://api.openai.com/v1' }), false);

const catalog = context.window.AIProviderManager.mergeCatalogModels(
  [{ id: 'kept', label: '自定义名称', capabilities: ['text', 'vision'], api: 'responses' }, { id: 'retired' }],
  [{ id: 'kept', label: 'Remote', capabilities: ['text'] }, { id: 'latest', label: 'Latest', capabilities: ['audio'] }]
);
assert.deepStrictEqual(JSON.parse(JSON.stringify(catalog)), [
  { id: 'kept', label: '自定义名称', capabilities: ['text', 'vision'], api: 'responses' },
  { id: 'latest', label: 'Latest', capabilities: ['audio'] }
]);

const searchable = [
  { providerId: 'a', providerName: 'OpenAI', modelId: 'gpt-6-luna', label: 'GPT-6 Luna' },
  { providerId: 'b', providerName: 'DeepSeek', modelId: 'deepseek-flash', label: '闪电模型' }
];
assert.equal(context.window.AIProviderManager.filterModelEntries(searchable, ' OPENAI luna ').length, 1);
assert.equal(context.window.AIProviderManager.filterModelEntries(searchable, '闪电').length, 1);
assert.equal(context.window.AIProviderManager.filterModelEntries(searchable, 'gpt-6-luna').length, 1);
assert.equal(context.window.AIProviderManager.filterModelEntries(searchable, 'OpenAI deepseek').length, 0);
const unordered = [{ id: 'z', label: 'Zebra' }, { id: 'a10', label: 'Alpha 10' }, { id: 'a2', label: 'alpha 2' }];
assert.equal(context.window.AIProviderManager.sortModels(unordered).map(model => model.id).join(','), 'a2,a10,z');
assert.equal(unordered[0].id, 'z');

console.log('AI provider manager tests passed: multi-provider parsing, managed OpenCode import, legacy route detection');
