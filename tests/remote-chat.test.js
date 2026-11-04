'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const { ChatService } = require('../app/remote/chat-service');
const { definitions, validateCall } = require('../app/remote/chat-tools');
const { calculate } = require('../app/remote/numeric-expression');
assert.strictEqual(calculate('(2+3)*4'),'20');assert.strictEqual(calculate('-1.5e2 / 3 + 4 % 3'),'-49');
for(const input of ['process.exit()','1/0','2**3','1;2','('.repeat(40)+'1'+')'.repeat(40)])assert.throws(()=>calculate(input));
const plugins = [{ id: 'sanrenjz-tools-text-engineering', name: '文本工程实验室', features: [{ code: 'plugin-market-line-processor' }] }, { id: 'sanrenjz-tools-code-security', name: '编码与安全工具箱', features: [{ code: 'plugin-market-id-generator' }] }, { id: 'sanrenjz-tools-notes-center', name: '本地笔记中心', features: [] }];
const available = definitions(plugins);
assert.throws(() => validateCall({ tool: 'execute', input: 'process.exit()' }, available));
assert.throws(() => validateCall({ tool: 'line-processor', options: { output: 'C:/data' } }, available));
assert.throws(() => validateCall({ tool: 'calculation-paper', input: 'global.process.exit()' }, [...available, { id: 'calculation-paper' }]));
assert.strictEqual(available.length, 3);
const storage = new Map(); let executions = 0;
const remote = { ipcMain: new EventEmitter(), manager: { getPluginStorageItem: (p, key) => storage.get(`${p}:${key}`), setPluginStorageItem: (p, key, value) => storage.set(`${p}:${key}`, value) }, uploads: new Map(), client: { device: { id: 'device-a' } }, send: () => {}, catalog: async () => plugins };
const chat = new ChatService(remote);
chat.models = async () => ({ models: [] });
chat.job = async (method, value) => {
  if (method === 'complete') return { text: JSON.stringify({ tool: 'markdown-notes', input: '真实笔记正文', options: { title: '测试笔记' } }) };
  executions++; return ['uuid-a','uuid-b'];
};
async function settled(id) { for (let i = 0; i < 50; i++) { const task = chat.tasks.get(id); if (task.state !== 'planning') return task; await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error('任务没有完成'); }
(async () => {
  const task = await chat.start({ text: '记一篇测试笔记' }, 'device-a'); const confirmation = await settled(task.id);
  assert.strictEqual(confirmation.state, 'confirmation'); assert.strictEqual(storage.get('本地笔记中心:md-notes'), undefined);
  assert.throws(() => chat.confirm({ id: task.id, approved: true }, 'device-b'));
  chat.confirm({ id: task.id, approved: true }, 'device-a'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.strictEqual(storage.get('本地笔记中心:md-notes').length, 1);
  assert.throws(() => chat.confirm({ id: task.id, approved: true }, 'device-a'));
  assert.strictEqual(chat.history('device-b').length, 0);
  remote.uploads.set('file-a', { complete: true, deviceId: 'device-a', path: '/tmp/test.txt', name: 'test.txt' });
  assert.throws(() => chat.file('device-b', 'file-a'));
  const cancelled = await chat.start({ text: '记第二篇笔记' }, 'device-a'); await settled(cancelled.id); chat.cancel(cancelled.id, 'device-a');
  assert.throws(() => chat.confirm({ id: cancelled.id, approved: true }, 'device-a'));
  assert.strictEqual(storage.get('本地笔记中心:md-notes').length, 1);
  console.log('REMOTE_CHAT_PASS: 工具白名单、路径与代码拒绝、设备隔离、明确确认、取消及防止重复执行通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
