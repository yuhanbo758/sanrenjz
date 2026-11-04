const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
let current = 'markdown-notes';
let notes = [];
let activeId = null;
let viewMode = 'split';
let saveTimer = null;
let writeQueue = Promise.resolve();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), 2200);
}
function makeId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function activeNote() { return notes.find(note => String(note.id) === String(activeId)); }
function modifiedAt(note) { return Number(note.updatedAt || note.createdAt || note.id) || 0; }
function showError(error) { toast(error?.message || String(error)); $('#saveStatus').textContent = '保存失败'; }

// 写入按快照串行执行，快速切换和连续输入也不会让旧请求覆盖新内容。
function persistNotes() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const snapshot = JSON.parse(JSON.stringify(notes));
  $('#saveStatus').textContent = '保存中…';
  writeQueue = writeQueue.catch(() => {}).then(() => api.storage.set('md-notes', snapshot));
  writeQueue.then(() => { if (!saveTimer) $('#saveStatus').textContent = '已保存'; }).catch(showError);
  return writeQueue;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  $('#saveStatus').textContent = '待保存';
  saveTimer = setTimeout(() => { saveTimer = null; persistNotes(); }, 400);
}
function flushPending() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; return persistNotes(); }
  return writeQueue;
}
function inlineMarkdown(text) {
  let result = escapeHtml(text);
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, rawUrl) => {
    const url = rawUrl.trim();
    return /^(https?:\/\/|mailto:)/i.test(url) && !/[\u0000-\u001f\s"'<>]/.test(url)
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  return result.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}
function markdownHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [], list = [], code = [];
  let inCode = false;
  const flushParagraph = () => { if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`); paragraph = []; };
  const flushList = () => { if (list.length) output.push(`<ul>${list.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`); list = []; };
  const flushCode = () => { output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { flushParagraph(); flushList(); if (inCode) flushCode(); inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (!line.trim()) { flushParagraph(); flushList(); }
    else if (heading) { flushParagraph(); flushList(); output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); }
    else if (item) { flushParagraph(); list.push(item[1]); }
    else if (/^>\s?/.test(line)) { flushParagraph(); flushList(); output.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`); }
    else { flushList(); paragraph.push(line); }
  }
  if (inCode) flushCode();
  flushParagraph(); flushList();
  return output.join('') || '<p style="color:var(--faint)">预览会显示在这里</p>';
}
function updatePreview() {
  const note = activeNote();
  if (!note) return;
  $('#notePreview').innerHTML = markdownHtml(note.content);
  const content = note.content || '';
  $('#noteStats').textContent = `${Array.from(content).length} 字 · ${content ? content.split(/\r\n?|\n/).length : 0} 行`;
}
function setView(mode) {
  viewMode = mode;
  $$('.ed-view button').forEach(button => button.classList.toggle('active', button.dataset.view === mode));
  $('#noteContent').style.display = mode === 'preview' ? 'none' : '';
  $('#notePreview').style.display = mode === 'edit' ? 'none' : '';
  updatePreview();
}
function renderList() {
  const query = $('#noteSearch').value.trim().toLocaleLowerCase();
  const filtered = notes.filter(note => `${note.title || ''}\n${note.content || ''}`.toLocaleLowerCase().includes(query));
  const sort = $('#noteSort').value;
  filtered.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) ||
    (sort === 'title' ? String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN') :
      sort === 'created' ? (Number(b.createdAt || b.id) || 0) - (Number(a.createdAt || a.id) || 0) : modifiedAt(b) - modifiedAt(a)));
  $('#noteCount').textContent = query ? `${filtered.length} / ${notes.length} 篇笔记` : `${notes.length} 篇笔记`;
  $('#noteItems').innerHTML = filtered.map(note => `<div class="nl-item${String(note.id) === String(activeId) ? ' active' : ''}" data-id="${escapeHtml(note.id)}" tabindex="0" role="button" aria-label="打开${escapeHtml(note.title || '无标题')}"><div class="nt">${note.pinned ? '📌 ' : ''}${escapeHtml(note.title || '无标题')}</div><div class="np">${escapeHtml(String(note.content || '').replace(/\s+/g, ' ').slice(0, 80)) || '空笔记'}</div></div>`).join('') || '<div style="padding:20px;text-align:center;color:var(--faint);font-size:13px">无匹配笔记</div>';
}
function selectNote(id) {
  const note = notes.find(item => String(item.id) === String(id));
  if (!note) return;
  flushPending().catch(showError);
  activeId = note.id;
  $('#noteTitle').value = note.title || '';
  $('#noteContent').value = note.content || '';
  $('#pinNote').textContent = note.pinned ? '取消置顶' : '置顶';
  $('#mdEmpty').style.display = 'none';
  $('#editorArea').style.display = 'flex';
  renderList(); updatePreview();
}
async function loadNotes() {
  try {
    const stored = await api.storage.get('md-notes');
    if (Array.isArray(stored)) notes = stored;
    else {
      notes = [{ id: makeId(), title: '欢迎使用', content: '# 欢迎使用\n\n这是你的第一篇 **Markdown** 笔记。\n\n- 支持列表\n- 支持 `代码`\n- 支持 [链接](https://sanrenjz.com)', createdAt: Date.now(), updatedAt: Date.now() }];
      await persistNotes();
    }
    renderList();
    if (notes.length) selectNote(notes[0].id);
    else { $('#editorArea').style.display = 'none'; $('#mdEmpty').style.display = 'flex'; }
    setView('split');
  } catch (error) { showError(error); }
}
function editActive() {
  const note = activeNote(); if (!note) return;
  note.title = $('#noteTitle').value;
  note.content = $('#noteContent').value;
  note.updatedAt = Date.now();
  renderList(); updatePreview(); scheduleSave();
}
async function newNote(title = '新笔记', content = '') {
  flushPending().catch(showError);
  const note = { id: makeId(), title, content, createdAt: Date.now(), updatedAt: Date.now(), pinned: false };
  notes.unshift(note);
  selectNote(note.id);
  await persistNotes();
  return note;
}
async function loadStickies() {
  try {
    if (stickyTimer) await persistStickies();
    await stickyQueue;
    const stickies = await api.storage.get('stickies') || [];
    stickyDraft = stickies;
    $('#fnGrid').innerHTML = '<div class="fn-add" id="fnAdd"><span>+ 添加便签</span></div>' + stickies.map((note, index) => `<div class="fn-card" data-i="${index}"><button class="fn-del" data-del="${index}" title="删除便签">×</button><button class="fn-copy" data-copy="${index}" title="复制便签内容">复制</button><textarea data-sti="${index}" spellcheck="false" placeholder="随手记…">${escapeHtml(note.text)}</textarea><div class="fn-time">${escapeHtml(note.time)}</div></div>`).join('');
  } catch (error) { showError(error); }
}
let stickyTimer = null;
let stickyQueue = Promise.resolve();
let stickyDraft = null;
function persistStickies() {
  clearTimeout(stickyTimer); stickyTimer = null;
  const snapshot = JSON.parse(JSON.stringify(stickyDraft));
  stickyQueue = stickyQueue.catch(() => {}).then(() => api.storage.set('stickies', snapshot));
  stickyQueue.catch(showError);
  return stickyQueue;
}
async function currentStickies() {
  if (stickyTimer) await persistStickies();
  await stickyQueue.catch(showError);
  return stickyDraft || await api.storage.get('stickies') || [];
}
$$('.tab').forEach(tab => tab.addEventListener('click', () => {
  current = tab.dataset.tool;
  $$('.tab').forEach(item => item.classList.toggle('active', item === tab));
  $$('.panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === current));
  if (current === 'floating-notes') loadStickies();
}));
$('#noteItems').addEventListener('click', event => { const item = event.target.closest('.nl-item'); if (item) selectNote(item.dataset.id); });
$('#noteItems').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.nl-item')) { event.preventDefault(); selectNote(event.target.dataset.id); } });
$('#newNote').onclick = () => newNote().then(() => $('#noteTitle').focus()).catch(showError);
$('#noteSearch').oninput = renderList;
$('#noteSort').onchange = renderList;
$('#noteTitle').oninput = editActive;
$('#noteContent').oninput = editActive;
$$('.ed-view button').forEach(button => button.onclick = () => setView(button.dataset.view));
$('#copyNote').onclick = () => { const note = activeNote(); if (!note) return; api.notes.copy(note.content || ''); toast('已复制 Markdown 正文'); };
$('#pinNote').onclick = () => { const note = activeNote(); if (!note) return; note.pinned = !note.pinned; note.updatedAt = Date.now(); $('#pinNote').textContent = note.pinned ? '取消置顶' : '置顶'; renderList(); persistNotes().catch(showError); };
$('#duplicateNote').onclick = () => { const note = activeNote(); if (!note) return; newNote(`${note.title || '无标题'} - 副本`, note.content || '').then(() => toast('已创建副本')).catch(showError); };
$('#delNote').onclick = async () => {
  const note = activeNote(); if (!note || !confirm(`删除笔记“${note.title || '无标题'}”？`)) return;
  flushPending().catch(showError);
  notes = notes.filter(item => String(item.id) !== String(note.id));
  activeId = null;
  if (notes.length) selectNote(notes[0].id);
  else { $('#mdEmpty').style.display = 'flex'; $('#editorArea').style.display = 'none'; }
  renderList();
  try { await persistNotes(); toast('已删除'); } catch (error) { showError(error); }
};
$('#importNote').onclick = async () => {
  try {
    const imported = await api.notes.importMarkdown();
    if (!imported.length) return;
    flushPending().catch(showError);
    const now = Date.now();
    const created = imported.map(({title, content}) => ({id:makeId(), title, content, createdAt:now, updatedAt:now, pinned:false}));
    notes.unshift(...created);
    selectNote(created[0].id);
    await persistNotes(); toast(`已导入 ${created.length} 篇笔记`);
  } catch (error) { showError(error); }
};
$('#exportNote').onclick = async () => {
  const note = activeNote(); if (!note) return;
  try { if (await api.notes.exportMarkdown(note.title, note.content || '')) toast('Markdown 已导出'); }
  catch (error) { showError(error); }
};
$('#fnGrid').addEventListener('click', async event => {
  const add = event.target.closest('#fnAdd');
  const del = event.target.closest('[data-del]');
  const copy = event.target.closest('[data-copy]');
  if (!add && !del && !copy) return;
  try {
    const stickies = await currentStickies();
    if (add) stickies.unshift({text:'', time:new Date().toLocaleString('zh-CN').slice(5)});
    if (del) { if (!confirm('删除这张便签？')) return; stickies.splice(Number(del.dataset.del), 1); }
    if (copy) { api.notes.copy(stickies[Number(copy.dataset.copy)]?.text || ''); toast('已复制便签内容'); return; }
    stickyDraft = stickies;
    await persistStickies(); await loadStickies();
    if (add) $('#fnGrid textarea')?.focus();
  } catch (error) { showError(error); }
});
$('#fnGrid').addEventListener('input', event => {
  if (!event.target.matches('[data-sti]')) return;
  const index = Number(event.target.dataset.sti);
  if (!stickyDraft?.[index]) return;
  stickyDraft[index].text = event.target.value;
  stickyDraft[index].time = new Date().toLocaleString('zh-CN').slice(5);
  clearTimeout(stickyTimer);
  stickyTimer = setTimeout(persistStickies, 350);
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); flushPending().then(() => toast('已保存')).catch(showError);
  }
});
window.addEventListener('plugin-enter', event => {
  const tool = event.detail?.toolId;
  if (!tool) return;
  const tab = $(`.tab[data-tool="${tool}"]`);
  tab?.click();
});
window.addEventListener('beforeunload', () => {
  // 关闭窗口时用一次同步写入兜住未到期的防抖保存。
  if (saveTimer) api.notes.flushSync?.('md-notes', notes);
  if (stickyTimer) api.notes.flushSync?.('stickies', stickyDraft);
});
loadNotes();
