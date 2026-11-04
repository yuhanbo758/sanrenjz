const assert = require('assert');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { createXlsxFixture } = require('./ai-document-xlsx-fixture');
const { checkFile, extractDocument, transcriptionUrl, transcribeAudio } = require('../app/software/sanrenjz-tools-ai-meeting/meeting-service');

(async () => {
  const zip = new JSZip();
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>第二页 &amp; 决策</a:t></a:r></a:p></p:sld>');
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>第一页议题</a:t></a:r></a:p></p:sld>');
  zip.file('ppt/media/image1.png', Buffer.alloc(1024));
  const pptx = await zip.generateAsync({ type: 'nodebuffer' });
  const slides = (await extractDocument('meeting.pptx', pptx)).text;
  assert.match(slides, /第 1 页\n第一页议题\n\n第 2 页\n第二页 & 决策/);
  assert.equal((await extractDocument('notes.txt', Buffer.from('会议记录'))).text, '会议记录');
  assert.match((await extractDocument('table.xlsx', await createXlsxFixture())).text, /工作表：销售\n项目\t金额/);
  assert.match((await extractDocument('old.doc', fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-document-sample.doc')))).text, /文档正文/);
  assert.throws(() => checkFile('old.ppt', 100), /另存为/);
  assert.throws(() => checkFile('old.xls', 100), /另存为/);
  assert.throws(() => checkFile('large.wav', 26 * 1024 * 1024), /25 MB/);
  assert.equal(transcriptionUrl('https://example.test/v1/'), 'https://example.test/v1/audio/transcriptions');
  let sent;
  const result = await transcribeAudio({ name: 'record.webm', data: Buffer.from('audio'), model: 'whisper-1', provider: { baseUrl: 'https://example.test/v1' }, secret: 'test-secret' }, async (url, options) => {
    sent = { url, options };
    return { ok: true, text: async () => JSON.stringify({ text: '会议转写内容' }) };
  });
  assert.equal(result, '会议转写内容');
  assert.equal(sent.url, 'https://example.test/v1/audio/transcriptions');
  assert.equal(sent.options.body.get('model'), 'whisper-1');
  assert.equal(sent.options.headers.Authorization, 'Bearer test-secret');
  await assert.rejects(transcribeAudio({ name: 'record.webm', data: Buffer.from('audio'), model: 'whisper-1', provider: { baseUrl: 'opencode://x' }, secret: 'test' }), /OpenCode/);
  console.log('AI 会议纪要文档解析与语音请求测试通过');
})().catch(error => { console.error(error); process.exitCode = 1; });
