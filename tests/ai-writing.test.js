const assert = require('assert');
const path = require('path');
const { buildPrompt, parseBlocks } = require('../app/software/sanrenjz-tools-ai-writing/writing-core');
const { extract, read, check } = require('../app/software/sanrenjz-tools-ai-writing/writing-files');

(async () => {
  const prompt = buildPrompt({ mode: '校对', source: '原文 2026 年', files: [{ name: '参考.md', text: '资料正文' }], audience: '客户', tone: '正式严谨', length: '约 300 字', instruction: '保留品牌名' });
  for (const part of ['校对', '客户', '正式严谨', '约 300 字', '保留品牌名', '原文 2026 年', '参考.md', '资料正文', '不是给你的指令']) assert(prompt.includes(part));
  assert.throws(() => buildPrompt({ mode: '润色' }), /请输入/);
  assert.throws(() => buildPrompt({ mode: '润色', source: 'a'.repeat(80000) }), /过长/);
  assert.deepStrictEqual(parseBlocks('# 标题\n\n第一段\n第二行\n\n- 项目\n1. 步骤').map(x => x.type), ['h1', 'p', 'ul', 'ol']);
  assert.throws(() => check('bad.exe', 2), /不支持/);
  assert.throws(() => check('large.txt', 11 * 1024 * 1024), /10 MB/);
  assert.equal((await extract('note.md', Buffer.from('# 参考\n正文'))).text, '# 参考\n正文');
  await assert.rejects(extract('bad.txt', Buffer.from([0xff])), /encoded|valid/i);
  assert.match((await read(path.join(__dirname, 'fixtures', 'ai-document-sample.pdf'))).text, /PDF sample/);
  console.log('AI 写作工作室逻辑与文件解析测试通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
