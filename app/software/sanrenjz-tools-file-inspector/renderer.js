const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let current = 'file-content-search';
let searchPaths = [], leftDir = '', rightDir = '', treeDir = '';
let searchResult = null, compareResult = null, treeResult = null;
let busy = false, dragDepth = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  clearTimeout(element.timer); element.timer = setTimeout(() => element.classList.remove('show'), 2300);
}
function bar(id, message, state = '') {
  const element = $(id); element.className = `bar ${state}`;
  element.querySelector('span:last-of-type').textContent = message;
}
function show(tool) {
  current = tool;
  $$('.tab').forEach(element => element.classList.toggle('active', element.dataset.tool === tool));
  $$('.panel').forEach(element => element.classList.toggle('active', element.dataset.panel === tool));
}
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
async function run(button, work) {
  if (busy) return;
  busy = true; button.disabled = true;
  try { await work(); }
  catch (error) { toast(errorMessage(error)); bar(`#${current === 'file-content-search' ? 'fs' : current === 'folder-compare' ? 'fc' : 'dt'}Bar`, errorMessage(error), 'err'); }
  finally { busy = false; button.disabled = false; }
}
function setSearchPaths(paths) {
  const roots = api.inspector.describePaths(paths);
  if (roots.length > 1 && roots.some(root => root.directory)) throw new Error('请只拖入一个目录，或拖入多个文件');
  searchPaths = roots.map(root => root.path);
  $('#fsDir').textContent = roots.length === 1 ? roots[0].path : `${roots.length} 个文件：${roots.map(root => root.path.split(/[\\/]/).pop()).join('、')}`;
  $('#fsDir').title = roots.map(root => root.path).join('\n');
}
function setDirectory(slot, path) {
  const root = api.inspector.describePaths([path])[0];
  if (!root.directory) throw new Error('这里需要目录，请拖入文件夹');
  if (slot === 'A') { leftDir = root.path; $('#fcDirA').textContent = root.path; }
  else if (slot === 'B') { rightDir = root.path; $('#fcDirB').textContent = root.path; }
  else { treeDir = root.path; $('#dtDir').textContent = root.path; }
}
function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function saveCsv(name, headers, rows) {
  const text = '\ufeff' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const result = api.saveResult({ title: '导出检查结果', defaultPath: name, filters: [{ name: 'CSV', extensions: ['csv'] }], text });
  if (!result.cancelled) toast('已导出 CSV');
}

$$('.tab').forEach(element => element.addEventListener('click', () => show(element.dataset.tool)));
$('#fsPick').onclick = () => { const path = api.selectDirectory('选择搜索目录'); if (path) setSearchPaths([path]); };
$('#fcPickA').onclick = () => { const path = api.selectDirectory('选择目录 A'); if (path) setDirectory('A', path); };
$('#fcPickB').onclick = () => { const path = api.selectDirectory('选择目录 B'); if (path) setDirectory('B', path); };
$('#dtPick').onclick = () => { const path = api.selectDirectory('选择目录'); if (path) setDirectory('tree', path); };

$('#fsRun').onclick = () => run($('#fsRun'), async () => {
  if (!searchPaths.length) throw new Error('请选择或拖入文件、目录');
  const query = $('#fsQuery').value;
  if (!query) throw new Error('请输入搜索内容');
  searchResult = null; $('#fsExport').disabled = true;
  bar('#fsBar', '搜索中…'); $('#fsResult').className = 'result empty'; $('#fsResult').textContent = '搜索中…';
  const result = await api.inspector.search(searchPaths, { query, extensions: $('#fsExt').value, caseSensitive: $('#fsCase').checked, regex: $('#fsRegex').checked, maxSizeMb: $('#fsMax').value });
  searchResult = result;
  const container = $('#fsResult');
  if (!result.matches.length) { container.className = 'result empty'; container.textContent = '未找到匹配'; }
  else {
    container.className = 'result'; container.replaceChildren();
    for (const item of result.matches) {
      const row = document.createElement('div'); row.className = 'match'; row.title = item.path;
      row.innerHTML = `<div class="mp">${escapeHtml(item.relativePath)}:${item.line}</div><div class="ml">${escapeHtml(item.text)}</div>`;
      row.onclick = () => api.showPath(item.path);
      container.appendChild(row);
    }
  }
  $('#fsExport').disabled = !result.matches.length;
  bar('#fsBar', `匹配 ${result.matches.length} 处 · 扫描 ${result.scanned}/${result.total} 文件 · 跳过大文件 ${result.skippedLarge}、二进制 ${result.skippedBinary}、链接 ${result.skipped.links}、不可读 ${result.skipped.unreadable}${result.limited ? ' · 已达结果上限' : ''}`, 'ok');
});
$('#fsQuery').addEventListener('keydown', event => { if (event.key === 'Enter') $('#fsRun').click(); });
$('#fsExport').onclick = () => { if (searchResult) saveCsv('内容搜索结果.csv', ['路径', '行号', '内容'], searchResult.matches.map(item => [item.path, item.line, item.text])); };

function filteredCompare() {
  if (!compareResult) return [];
  const status = $('#fcFilter').value, query = $('#fcPathFilter').value.toLocaleLowerCase();
  return compareResult.items.filter(item => (status === 'all' || item.status === status) && item.relativePath.toLocaleLowerCase().includes(query));
}
function renderCompare() {
  const rows = filteredCompare(), container = $('#fcResult');
  if (!rows.length) { container.className = 'result empty'; container.textContent = '当前筛选无结果'; }
  else {
    container.className = 'result';
    container.innerHTML = `<table class="cmp-table"><thead><tr><th>相对路径</th><th>状态</th><th>左大小</th><th>右大小</th></tr></thead><tbody>${rows.map(item => `<tr><td>${escapeHtml(item.relativePath)}</td><td class="${({ '相同': 'st-same', '不同': 'st-diff', '仅左侧': 'st-left', '仅右侧': 'st-right' })[item.status]}">${item.status}</td><td>${formatSize(item.leftSize)}</td><td>${formatSize(item.rightSize)}</td></tr>`).join('')}</tbody></table>`;
  }
  $('#fcExport').disabled = !rows.length;
  bar('#fcBar', `显示 ${rows.length}/${compareResult.items.length} 项 · 跳过链接 ${compareResult.skipped.links}、不可读 ${compareResult.skipped.unreadable}`, 'ok');
}
$('#fcRun').onclick = () => run($('#fcRun'), async () => {
  if (!leftDir || !rightDir) throw new Error('请选择两个目录');
  compareResult = null; $('#fcExport').disabled = true;
  bar('#fcBar', '比较中…'); $('#fcResult').className = 'result empty'; $('#fcResult').textContent = '比较中…';
  compareResult = await api.inspector.compare(leftDir, rightDir, { hash: $('#fcHash').checked });
  renderCompare();
});
$('#fcFilter').onchange = () => { if (compareResult) renderCompare(); };
$('#fcPathFilter').oninput = () => { if (compareResult) renderCompare(); };
$('#fcExport').onclick = () => saveCsv('目录比较结果.csv', ['相对路径', '状态', '左大小（字节）', '右大小（字节）'], filteredCompare().map(item => [item.relativePath, item.status, item.leftSize ?? '', item.rightSize ?? '']));

$('#dtRun').onclick = () => run($('#dtRun'), async () => {
  if (!treeDir) throw new Error('请选择目录');
  treeResult = null; $('#dtSave').disabled = true;
  bar('#dtBar', '生成中…'); $('#dtResult').className = 'result empty'; $('#dtResult').textContent = '生成中…';
  treeResult = await api.inspector.tree(treeDir, { format: $('#dtFmt').value, extensions: $('#dtExt').value, maxDepth: $('#dtDepth').value, showSize: $('#dtSize').checked });
  $('#dtResult').className = 'result';
  const pre = document.createElement('div'); pre.className = 'tree'; pre.textContent = treeResult.text || '没有符合条件的文件';
  $('#dtResult').replaceChildren(pre);
  $('#dtSave').disabled = !treeResult.text;
  bar('#dtBar', `生成 ${treeResult.count} 个文件 · 跳过链接 ${treeResult.skipped.links}、不可读 ${treeResult.skipped.unreadable}`, 'ok');
});
$('#dtCopy').onclick = () => { if (!treeResult?.text) return toast('暂无内容'); api.copyText(treeResult.text); toast('已复制'); };
$('#dtSave').onclick = () => {
  if (!treeResult?.text) return;
  const extension = $('#dtFmt').value === 'json' ? 'json' : $('#dtFmt').value === 'markdown' ? 'md' : 'txt';
  const result = api.saveResult({ title: '保存目录树', defaultPath: `目录树.${extension}`, text: treeResult.text, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
  if (!result.cancelled) toast('已保存');
};

document.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; $('#dropOverlay').classList.add('show'); });
document.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('dragleave', event => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropOverlay').classList.remove('show'); });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.remove('show');
  const paths = api.inspector.droppedPaths(event.dataTransfer.files);
  if (!paths.length) return toast('未识别到本地文件或目录');
  try {
    if (current === 'file-content-search') setSearchPaths(paths);
    else if (current === 'directory-tree') setDirectory('tree', paths[0]);
    else {
      if (paths.length > 2) throw new Error('比较最多接受两个目录');
      const target = event.target.closest('#fcDirA, #fcPickA, #fcDirB, #fcPickB');
      if (paths.length === 2) { setDirectory('A', paths[0]); setDirectory('B', paths[1]); }
      else setDirectory(target?.id.endsWith('B') ? 'B' : leftDir ? 'B' : 'A', paths[0]);
    }
  } catch (error) { toast(errorMessage(error)); }
});
window.addEventListener('plugin-enter', event => {
  const id = event.detail?.toolId;
  if (id) show(id);
  const query = event.detail?.action?.payload || event.detail?.action?.clipboardText || event.detail?.payload || event.detail?.clipboardText || '';
  if (query && current === 'file-content-search') $('#fsQuery').value = String(query);
});
