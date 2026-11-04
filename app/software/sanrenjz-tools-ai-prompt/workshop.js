const api = window.aiAPI;
const $ = selector => document.querySelector(selector);
let prompts = [];
let external = [];
let activeId = null;
let folder = '';
let requestId = '';
let saveTimer = null;
let saveQueue = Promise.resolve();
let mentionStart = -1;
let mentionEnd = -1;
let mentionItems = [];
let mentionIndex = 0;
let optimized = '';
let optimizationSource = '';
const variableValues = new Map();
let sourceLanguageManual = false;

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.remove('show'), 2200);
}

const providerManager = AIProviderManager.create(api, { capability: 'text', notify: toast });
function newId() { return `local:${crypto.randomUUID()}`; }
function localPrompt() { return prompts.find(item => item.id === activeId); }
function activePrompt() { return localPrompt() || external.find(item => item.id === activeId); }
function persist() {
  clearTimeout(saveTimer);
  const snapshot = JSON.parse(JSON.stringify(prompts));
  saveQueue = saveQueue.catch(() => {}).then(() => api.storage.set('prompt-library', snapshot));
  return saveQueue.catch(error => toast(`保存失败：${error.message}`));
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persist(); $('#saveStat').textContent = '已保存'; }, 400);
}
function promptButton(item) {
  const button = document.createElement('button');
  button.className = `lib-item${item.id === activeId ? ' active' : ''}`;
  button.type = 'button';
  button.dataset.id = item.id;
  const title = document.createElement('div');
  title.className = 'lt';
  title.textContent = item.title || '未命名';
  const subtitle = document.createElement('div');
  subtitle.className = 'lm';
  subtitle.textContent = item.source || '本地模板';
  button.append(title, subtitle);
  button.onclick = () => selectPrompt(item.id);
  return button;
}
function renderLib() {
  const list = $('#libList');
  list.replaceChildren();
  const query = $('#libSearch').value.trim().toLocaleLowerCase();
  let count = 0;
  for (const [heading, items] of [['本地模板', prompts], ['文件夹（只读）', external]]) {
    const matches = items.filter(item => `${item.title}\n${item.body}`.toLocaleLowerCase().includes(query));
    if (!matches.length) continue;
    const section = document.createElement('div');
    section.className = 'lib-section';
    section.textContent = `${heading} · ${matches.length}`;
    list.append(section);
    matches.forEach(item => list.append(promptButton(item)));
    count += matches.length;
  }
  if (!count) list.textContent = '没有匹配的提示词';
  $('#deleteBtn').disabled = !localPrompt();
}
function selectPrompt(id) {
  const item = prompts.find(p => p.id === id) || external.find(p => p.id === id);
  if (!item) return;
  if (requestId) api.cancel(requestId);
  requestId = '';
  optimized = '';
  $('#saveAsBtn').disabled = true;
  $('#optBtn').disabled = false;
  $('#stopBtn').disabled = true;
  $('#pvStat').textContent = '等待';
  $('#pvOut').classList.add('empty');
  $('#pvOut').textContent = '编辑提示词后点击「优化」';
  activeId = id;
  $('#pTitle').value = item.title;
  $('#pBody').value = item.body;
  $('#pTitle').readOnly = Boolean(item.source);
  $('#saveStat').textContent = item.source ? '外部文件只读；编辑正文会创建本地副本' : '';
  variableValues.clear();
  sourceLanguageManual = false;
  renderVariables();
  hideMention();
  renderLib();
}
function ensureEditable() {
  const item = activePrompt();
  if (!item) return null;
  if (!item.source) return item;
  // 文件夹仅作为素材源；首次编辑时生成本地副本，避免覆盖用户文件。
  const copy = { id: newId(), title: `${item.title}（副本）`, body: item.body };
  prompts.unshift(copy);
  activeId = copy.id;
  $('#pTitle').value = copy.title;
  $('#pTitle').readOnly = false;
  toast('已创建本地副本');
  return copy;
}
function updateDraft() {
  const item = ensureEditable();
  if (!item) return;
  item.title = $('#pTitle').value;
  item.body = $('#pBody').value;
  scheduleSave();
  renderLib();
}
function renderVariables() {
  const names = [...new Set([...$('#pBody').value.matchAll(/\{\{([\w-]+)\}\}/g)].map(match => match[1]))];
  const tags = $('#varList');
  tags.replaceChildren();
  const rows = $('#varInputs');
  rows.replaceChildren();
  const isCodeTemplate = names.includes('code');
  for (const name of names) {
    const tag = document.createElement('span');
    tag.className = 'var-tag';
    tag.textContent = `{{${name}}}`;
    tags.append(tag);
    const row = document.createElement('div');
    row.className = 'var-row';
    const label = document.createElement('label');
    label.textContent = isCodeTemplate ? ({ language: '源语言', target: '目标语言', code: '代码' }[name] || name) : name;
    const control = document.createElement('div');
    control.className = 'var-control';
    let input;
    if (isCodeTemplate && (name === 'language' || name === 'target')) {
      input = document.createElement('select');
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = name === 'language' ? '自动识别 / 选择源语言' : '请选择目标语言';
      input.append(empty);
      for (const [value, title] of PromptLanguage.languages) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = title;
        input.append(option);
      }
      input.value = variableValues.get(name) || '';
      input.onchange = () => {
        if (name === 'language') {
          sourceLanguageManual = Boolean(input.value);
          variableValues.set(name, input.value);
          if (!sourceLanguageManual) syncSourceLanguage();
          else $('#languageHint').textContent = '已手动选择；可重新选择“自动识别”';
        } else variableValues.set(name, input.value);
      };
      if (name === 'language') {
        const hint = document.createElement('small');
        hint.id = 'languageHint';
        hint.className = 'var-hint';
        control.append(input, hint);
      } else control.append(input);
    } else {
      input = document.createElement(isCodeTemplate && name === 'code' ? 'textarea' : 'input');
      input.placeholder = name === 'code' ? '粘贴代码或通过超级面板传入' : `填写 ${name}`;
      input.value = variableValues.get(name) || '';
      input.oninput = () => {
        variableValues.set(name, input.value);
        if (name === 'code') syncSourceLanguage();
      };
      control.append(input);
    }
    input.dataset.var = name;
    row.append(label, control);
    rows.append(row);
  }
  if (isCodeTemplate && names.includes('language')) {
    if (sourceLanguageManual) $('#languageHint').textContent = '已手动选择；可重新选择“自动识别”';
    else syncSourceLanguage();
  }
  if (!names.length) tags.textContent = '无变量';
}
function syncSourceLanguage() {
  const select = $('#varInputs [data-var="language"]');
  if (!select || sourceLanguageManual) return;
  const detected = PromptLanguage.detect(variableValues.get('code'));
  const language = detected?.language || '';
  variableValues.set('language', language);
  select.value = language;
  $('#languageHint').textContent = detected
    ? `自动识别：${language}（${detected.reason}）；可手动更改`
    : '未能可靠识别，请选择源语言';
}
function renderedPrompt() {
  const missing = [];
  const result = $('#pBody').value.replace(/\{\{([\w-]+)\}\}/g, (token, name) => {
    const value = variableValues.get(name);
    if (!value?.trim()) { missing.push(name); return token; }
    return value;
  });
  if (missing.length) throw new Error(`请填写变量：${[...new Set(missing)].join('、')}`);
  return result;
}
function variableNames(text) {
  return [...new Set([...text.matchAll(/\{\{([\w-]+)\}\}/g)].map(match => match[1]))];
}
function hideMention() { $('#mention').hidden = true; mentionStart = -1; mentionItems = []; }
function renderMention() {
  const box = $('#mention');
  box.replaceChildren();
  if (!mentionItems.length) { box.hidden = true; return; }
  mentionItems.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.toggle('active', index === mentionIndex);
    button.textContent = item.title;
    const source = document.createElement('small');
    source.textContent = item.source || '本地模板';
    button.append(source);
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => insertMention(item);
    box.append(button);
  });
  box.hidden = false;
}
function updateMention() {
  const input = $('#pBody');
  const prefix = input.value.slice(0, input.selectionStart);
  const match = /(^|\s)@([^@\s]*)$/u.exec(prefix);
  if (!match) { hideMention(); return; }
  mentionStart = prefix.length - match[2].length - 1;
  mentionEnd = input.selectionStart;
  const query = match[2].toLocaleLowerCase();
  mentionItems = [...prompts, ...external].filter(item =>
    `${item.title}\n${item.body}`.toLocaleLowerCase().includes(query)).slice(0, 20);
  mentionIndex = 0;
  renderMention();
}
function insertMention(item) {
  const input = $('#pBody');
  if (mentionStart < 0) return;
  const start = mentionStart;
  const value = input.value;
  const inserted = item.body;
  input.value = value.slice(0, start) + inserted + value.slice(mentionEnd);
  input.setSelectionRange(start + inserted.length, start + inserted.length);
  hideMention();
  updateDraft();
  renderVariables();
  input.focus();
}
async function refreshFiles() {
  if (!folder) { external = []; renderLib(); $('#folderStat').textContent = '未设置提示词文件夹'; return; }
  try {
    external = await api.promptFiles.list(folder);
    $('#folderStat').textContent = `已读取 ${external.length} 个 Markdown / TXT 文件（只读，最多 200 个）`;
    if (String(activeId).startsWith('file:') && !external.some(item => item.id === activeId)) {
      if (prompts.length) selectPrompt(prompts[0].id);
      else { activeId = null; $('#pTitle').value = ''; $('#pBody').value = ''; renderVariables(); }
    }
    renderLib();
  } catch (error) {
    external = [];
    $('#folderStat').textContent = `读取失败：${error.message}`;
    renderLib();
  }
}
function createPrompt(title = '新提示词', body = '') {
  const item = { id: newId(), title, body };
  prompts.unshift(item);
  persist();
  selectPrompt(item.id);
  return item;
}
window.newPrompt = () => { createPrompt(); $('#pTitle').focus(); $('#pTitle').select(); };
window.toggleDrawer = () => {
  $('#drawer').classList.toggle('open');
  $('#overlay').classList.toggle('show');
};

$('#promptSettingsBtn').onclick = () => { $('#promptDrawer').classList.add('open'); $('#promptOverlay').classList.add('show'); };
function closePromptDrawer() { $('#promptDrawer').classList.remove('open'); $('#promptOverlay').classList.remove('show'); }
$('#closePromptDrawer').onclick = closePromptDrawer;
$('#promptOverlay').onclick = closePromptDrawer;
$('#choosePath').onclick = async () => {
  const chosen = api.promptFiles.chooseDirectory();
  if (!chosen) return;
  folder = chosen;
  $('#promptPath').value = folder;
  await api.storage.set('prompt-settings', { folder });
  await refreshFiles();
};
$('#clearPath').onclick = async () => {
  folder = '';
  $('#promptPath').value = '';
  await api.storage.set('prompt-settings', { folder });
  await refreshFiles();
};
$('#refreshFiles').onclick = refreshFiles;
$('#libSearch').oninput = renderLib;
$('#pTitle').oninput = updateDraft;
$('#pBody').oninput = () => { updateDraft(); renderVariables(); updateMention(); };
$('#pBody').onkeyup = event => { if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) updateMention(); };
$('#pBody').onkeydown = event => {
  if ($('#mention').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); hideMention(); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length;
    renderMention();
  }
  if (event.key === 'Enter') { event.preventDefault(); insertMention(mentionItems[mentionIndex]); }
};
$('#copyRenderedBtn').onclick = async () => {
  try { api.copyText(renderedPrompt()); toast('已复制填充结果'); }
  catch (error) { toast(error.message); }
};
$('#duplicateBtn').onclick = () => {
  const item = activePrompt();
  if (item) createPrompt(`${item.title}（副本）`, item.body);
};
$('#deleteBtn').onclick = () => {
  const item = localPrompt();
  if (!item || !confirm(`删除本地模板“${item.title}”？`)) return;
  prompts = prompts.filter(prompt => prompt.id !== item.id);
  persist();
  if (prompts.length || external.length) selectPrompt((prompts[0] || external[0]).id);
  else { activeId = null; $('#pTitle').value = ''; $('#pBody').value = ''; renderVariables(); renderLib(); }
};
$('#saveAsBtn').onclick = () => {
  if (!optimized.trim()) return;
  createPrompt(`${activePrompt()?.title || '提示词'}（优化版）`, optimized.trim());
  toast('优化结果已另存为本地模板');
};
api.onChunk(chunk => {
  if (chunk.requestId !== requestId) return;
  optimized = chunk.text;
  $('#pvOut').classList.remove('empty');
  $('#pvOut').textContent = optimized;
});
$('#optBtn').onclick = async () => {
  const body = $('#pBody').value.trim();
  if (!body) { toast('请输入提示词'); return; }
  requestId = crypto.randomUUID();
  const current = requestId;
  optimized = '';
  optimizationSource = body;
  $('#saveAsBtn').disabled = true;
  $('#optBtn').disabled = true;
  $('#stopBtn').disabled = false;
  $('#pvStat').textContent = '优化中…';
  $('#pvOut').classList.remove('empty');
  $('#pvOut').textContent = '';
  try {
    const result = await api.complete({ requestId: current, capability: 'text',
      selection: await providerManager.getSelection(), stream: true,
      messages: [{ role: 'user', content: '优化下面的提示词，使任务、上下文、输出格式和约束更清楚。保留所有 {{变量}} 原样，且只输出可直接使用的完整优化版提示词，不要解释。\n\n' + body }] });
    if (current !== requestId) return;
    optimized = result.text || optimized;
    $('#pvOut').textContent = optimized;
    const missing = variableNames(optimizationSource).filter(name => !variableNames(optimized).includes(name));
    $('#pvStat').textContent = missing.length ? `缺少变量：${missing.join('、')}` : '已完成';
    $('#saveAsBtn').disabled = !optimized.trim() || missing.length > 0;
  } catch (error) {
    if (current !== requestId) return;
    $('#pvOut').textContent = error.message;
    $('#pvStat').textContent = error.message === '请求已取消' ? '已取消' : '失败';
  } finally {
    if (current === requestId) { $('#optBtn').disabled = false; $('#stopBtn').disabled = true; }
  }
};
$('#stopBtn').onclick = () => {
  if (!requestId) return;
  api.cancel(requestId);
  requestId = '';
  $('#optBtn').disabled = false;
  $('#stopBtn').disabled = true;
  $('#pvStat').textContent = '已取消';
};
$('#copyBtn').onclick = async () => {
  if (!optimized.trim()) { toast('暂无优化结果'); return; }
  api.copyText(optimized);
  toast('已复制优化结果');
};
window.addEventListener('plugin-enter', event => {
  const text = event.detail?.payload || event.detail?.clipboardText || '';
  if (!text) return;
  if (!activePrompt()) createPrompt('来自选中文本', text);
  else if (variableNames($('#pBody').value).includes('code')) {
    variableValues.set('code', text);
    renderVariables();
  } else { $('#pBody').value = text; updateDraft(); renderVariables(); }
  if (event.detail?.featureArgs?.autoRun) setTimeout(() => $('#optBtn').click(), 150);
});

async function init() {
  const saved = await api.storage.get('prompt-library');
  prompts = Array.isArray(saved) ? saved.filter(item => item && item.id && typeof item.body === 'string') : [];
  // 兼容旧版以毫秒时间戳作为 ID 的本地模板。
  if (saved == null) {
    createPrompt('代码翻译', '请将以下{{language}}代码翻译为{{target}}语言，保持功能不变：\n\n```\n{{code}}\n```');
  } else if (prompts.length) selectPrompt(prompts[0].id);
  else renderLib();
  const settings = await api.storage.get('prompt-settings');
  folder = settings?.folder || '';
  $('#promptPath').value = folder;
  await refreshFiles();
}
init().catch(error => toast(`加载失败：${error.message}`));
