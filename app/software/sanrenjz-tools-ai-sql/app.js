const api = window.aiAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const providerManager = AIProviderManager.create(api, { capability: 'text', notify: toast });
const labels = { 生成: '生成 SQL', 解释: '解释 SQL', 优化: '优化 SQL', 格式化: '格式化 SQL', 检查: '检查风险', 计划: '生成计划命令' };
const hints = {
  生成: '用自然语言描述查询需求。生成结果只供审阅，不会连接数据库或执行 SQL。',
  解释: '粘贴 SQL，逐段解释用途、过滤条件和潜在影响。',
  优化: '粘贴 SQL，获取改写建议；性能结论需结合真实索引与执行计划验证。',
  格式化: '在本地排版 SQL，不调用模型；会保留字符串、标识符和注释内容。',
  检查: '在本地检查常见风险；静态检查无法证明 SQL 安全。',
  计划: '只为单条 SELECT/WITH 查询生成对应方言的 EXPLAIN 命令，不连接数据库。'
};
let mode = '生成';
let requestId = '';
let running = false;
let resultText = '';

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(node._timer); node._timer = setTimeout(() => node.classList.remove('show'), 2000);
}
function toggleDrawer() { $('#drawer').classList.toggle('open'); $('#overlay').classList.toggle('show'); }
function setMode(next) {
  if (running) return;
  mode = next;
  $$('.modes .mode').forEach(button => button.classList.toggle('active', button.dataset.mode === next));
  $('#genLabel').textContent = labels[next]; $('#modeHint').textContent = hints[next];
  $('#input').placeholder = next === '生成' ? '用自然语言描述查询需求，如「查询最近 7 天注册的用户」' : '粘贴 SQL 语句';
}

function renderResult(text) {
  resultText = String(text || '');
  const container = $('#result'); container.replaceChildren();
  if (!resultText) { container.classList.add('empty'); container.textContent = '结果将显示在这里'; $('#copySqlBtn').disabled = true; return; }
  container.classList.remove('empty');
  for (const block of SqlTools.extractBlocks(resultText)) {
    const section = document.createElement('section'); section.className = 'result-section';
    const title = document.createElement('h3'); title.textContent = block.type === 'sql' ? 'SQL' : '说明';
    const body = document.createElement(block.type === 'sql' ? 'pre' : 'p');
    body.textContent = block.type === 'sql' ? SqlTools.format(block.text) : block.text;
    section.append(title, body); container.append(section);
  }
  $('#copySqlBtn').disabled = !SqlTools.mainSql(resultText);
}

function localTask(input, dialect) {
  if (mode === '格式化') return '```sql\n' + SqlTools.format(input) + '\n```';
  if (mode === '计划') return '```sql\n' + SqlTools.plan(input, dialect) + '\n```';
  return SqlTools.inspect(input).join('\n') || '未发现内置规则覆盖的常见风险。仍需人工核对语义、权限和影响范围。';
}

function makePrompt(input, dialect, schema) {
  const tasks = {
    生成: '请先给出一个 sql 代码块，再简短说明表结构假设和参数。',
    解释: '请逐段解释用途、条件、连接和潜在影响；引用 SQL 时使用 sql 代码块。',
    优化: '请给出可审阅的优化后 sql 代码块，并说明每项改动、索引建议及需要用真实执行计划验证的部分。'
  };
  return `任务：${labels[mode]}。数据库方言：${dialect}。\n${schema ? '表结构：' + schema + '\n' : ''}${mode === '生成' ? '需求' : 'SQL'}：${input}\n\n${tasks[mode]}不要声称已执行 SQL 或验证性能。`;
}

async function run() {
  const input = $('#input').value.trim(); if (!input) { toast('请输入内容'); return; }
  const dialect = $('#dialect').value; const schema = $('#schema').value.trim();
  if (['格式化', '检查', '计划'].includes(mode)) {
    try { renderResult(localTask(input, dialect)); $('#resStat').textContent = '本地完成'; }
    catch (error) { renderResult(error.message); $('#resStat').textContent = '无法生成'; }
    return;
  }
  requestId = crypto.randomUUID(); const currentId = requestId; running = true;
  $('#genBtn').disabled = true; $('#stopBtn').disabled = false; $('#resStat').textContent = '生成中…'; renderResult('');
  try {
    const response = await api.complete({ requestId: currentId, capability: 'text', selection: await providerManager.getSelection(), stream: true, messages: [{ role: 'user', content: makePrompt(input, dialect, schema) }] });
    if (running && currentId === requestId) { renderResult(response.text); $('#resStat').textContent = '已完成'; }
  } catch (error) {
    if (running && currentId === requestId) { renderResult(error.message); $('#resStat').textContent = error.message === '请求已取消' ? '已取消' : '失败'; }
  } finally {
    if (currentId === requestId) { running = false; $('#genBtn').disabled = false; $('#stopBtn').disabled = true; }
  }
}

async function copy(text) {
  if (!text) { toast('暂无可复制内容'); return; }
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch (error) { toast('复制失败：' + error.message); }
}

$$('.modes .mode').forEach(button => button.onclick = () => setMode(button.dataset.mode));
$('#input').addEventListener('input', () => $('#inCnt').textContent = $('#input').value.length + ' 字');
api.onChunk(chunk => { if (running && chunk.requestId === requestId) renderResult(chunk.text); });
$('#genBtn').onclick = run;
$('#stopBtn').onclick = () => {
  if (!running) return;
  api.cancel(requestId); running = false; requestId = '';
  $('#genBtn').disabled = false; $('#stopBtn').disabled = true; $('#resStat').textContent = '已取消';
};
$('#copyBtn').onclick = () => copy(resultText);
$('#copySqlBtn').onclick = () => copy(SqlTools.mainSql(resultText));
window.addEventListener('plugin-enter', event => {
  const text = event.detail?.payload || event.detail?.clipboardText || '';
  if (text) { $('#input').value = text; $('#input').dispatchEvent(new Event('input')); }
  if (event.detail?.featureArgs?.autoRun && text) setTimeout(() => { if (!$('#genBtn').disabled) $('#genBtn').click(); }, 150);
});
