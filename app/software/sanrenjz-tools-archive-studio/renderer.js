const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const exFiles = [];
const crFiles = [];
const previews = new Map();
const checked = new Map();
let exDir = '';
let busy = false;

function esc(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function nameOf(file) { return String(file).split(/[\\/]/).pop(); }
function fmtSize(value) { return value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(2)} MB`; }
function setBar(id, message, state = '') {
  const bar = $(id);
  bar.className = `bar ${state}`;
  bar.querySelector('span:last-child').textContent = message;
}
function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(node.timer); node.timer = setTimeout(() => node.classList.remove('show'), 2600);
}
function updateButtons() {
  $('#exExtract').disabled = busy || !exFiles.length || !exDir || !previews.has($('#exArchive').value);
  $('#exBatch').disabled = busy || !exFiles.length || !exDir;
  $('#crCreate').disabled = busy || !crFiles.length;
}
function addArchives(files) {
  const invalid = [];
  for (const file of files) {
    if (!/\.zip$/i.test(file)) { invalid.push(nameOf(file)); continue; }
    if (!exFiles.includes(file)) exFiles.push(file);
  }
  const selected = $('#exArchive').value;
  $('#exArchive').innerHTML = exFiles.map(file => `<option value="${esc(file)}">${esc(nameOf(file))}</option>`).join('');
  $('#exArchive').value = exFiles.includes(selected) ? selected : exFiles[0] || '';
  renderPreview(); updateButtons();
  if (invalid.length) toast(`已忽略 ${invalid.length} 个非 ZIP 文件`);
  else if (files.length) setBar('#exBar', `已添加 ${exFiles.length} 个 ZIP`, 'ok');
}
function addSources(files) {
  for (const file of files) if (!crFiles.includes(file)) crFiles.push(file);
  renderSources(); updateButtons();
}
function renderSources() {
  if (!crFiles.length) { $('#crList').innerHTML = '<div class="empty"><span>添加文件或文件夹后显示清单</span></div>'; return; }
  $('#crList').innerHTML = crFiles.map((file, index) => `<div class="entry"><span class="nm" title="${esc(file)}">${esc(nameOf(file))}</span><span class="sz">${esc(file)}</span><button class="remove" data-index="${index}" aria-label="移除">×</button></div>`).join('');
  $('#crList').querySelectorAll('.remove').forEach(button => button.onclick = () => { crFiles.splice(Number(button.dataset.index), 1); renderSources(); updateButtons(); });
  setBar('#crBar', `已选择 ${crFiles.length} 个源项目`, 'ok');
}
function renderPreview() {
  const file = $('#exArchive').value;
  const summary = previews.get(file);
  const list = $('#exList');
  if (!summary) {
    list.innerHTML = '<div class="empty"><span>选择 ZIP 后点击“预览内容”</span></div>';
    $('#exSummary').textContent = file ? `队列 ${exFiles.length} 个 ZIP` : '';
    updateButtons(); return;
  }
  const filter = $('#exSearch').value.trim().toLowerCase();
  const selected = checked.get(file);
  const visible = summary.entries.filter(item => item.name.toLowerCase().includes(filter));
  list.innerHTML = visible.length ? visible.map(item => `<label class="entry"><input type="checkbox" data-name="${esc(item.name)}" ${selected.has(item.name) ? 'checked' : ''}><span class="nm" title="${esc(item.name)}">${item.directory ? '📁 ' : '📄 '}${esc(item.name)}</span><span class="sz">${fmtSize(item.size)}</span></label>`).join('') : '<div class="empty"><span>没有匹配的条目</span></div>';
  list.querySelectorAll('input').forEach(input => input.onchange = () => { input.checked ? selected.add(input.dataset.name) : selected.delete(input.dataset.name); });
  $('#exSummary').textContent = `${summary.entries.length} 项 · 解压后 ${fmtSize(summary.totalBytes)} · ZIP ${fmtSize(summary.bytes)}`;
  updateButtons();
}
async function preview(file) {
  const result = api.archive.inspect(file);
  previews.set(file, result);
  checked.set(file, new Set(result.entries.filter(item => !item.directory).map(item => item.name)));
  renderPreview();
  return result;
}
async function work(action) {
  if (busy) return;
  busy = true; updateButtons();
  try { await action(); }
  catch (error) { setBar('#exBar', error.message || String(error), 'err'); toast(error.message || String(error)); }
  finally { busy = false; updateButtons(); }
}

$$('.mtab').forEach(tab => tab.onclick = () => {
  $$('.mtab').forEach(item => item.classList.toggle('active', item === tab));
  $$('.panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.mode));
});
$('#exDrop').onclick = $('#exAdd').onclick = () => addArchives(api.selectFiles({ multiple: true, filters: [{ name: 'ZIP', extensions: ['zip'] }] }));
$('#exClear').onclick = () => { exFiles.length = 0; previews.clear(); checked.clear(); $('#exArchive').innerHTML = ''; renderPreview(); setBar('#exBar', '队列已清空'); };
$('#exRemove').onclick = () => {
  const file = $('#exArchive').value; if (!file) return;
  exFiles.splice(exFiles.indexOf(file), 1); previews.delete(file); checked.delete(file);
  $('#exArchive').querySelector('option:checked')?.remove(); renderPreview();
};
$('#exArchive').onchange = renderPreview;
$('#exSearch').oninput = renderPreview;
$('#exAll').onclick = () => { const file = $('#exArchive').value; const summary = previews.get(file); if (summary) { checked.set(file, new Set(summary.entries.filter(item => !item.directory).map(item => item.name))); renderPreview(); } };
$('#exNone').onclick = () => { const file = $('#exArchive').value; if (previews.has(file)) { checked.set(file, new Set()); renderPreview(); } };
$('#exPickDir').onclick = () => { const dir = api.selectDirectory('选择解压目录'); if (dir) { exDir = dir; $('#exDir').textContent = dir; updateButtons(); } };
$('#exOpenDir').onclick = async () => { if (!exDir) { toast('请先选择解压目录'); return; } const error = await api.archive.openFolder(exDir); if (error) toast(error); };
$('#exPreview').onclick = () => work(async () => {
  const file = $('#exArchive').value;
  if (!file) { toast('请先添加 ZIP'); return; }
  setBar('#exBar', '正在读取 ZIP 目录…');
  const result = await preview(file);
  setBar('#exBar', `已预览 ${result.entries.length} 个条目`, 'ok');
});
$('#exExtract').onclick = () => work(async () => {
  const file = $('#exArchive').value;
  if (!file || !exDir) { toast('请选择 ZIP 和解压目录'); return; }
  const names = [...checked.get(file)];
  if (!names.length) { toast('请勾选需要解压的文件'); return; }
  const index = exFiles.indexOf(file);
  const folder = $('#exSeparate').checked ? api.archive.joinOutput(exDir, `${index + 1}-${nameOf(file).replace(/\.zip$/i, '')}`) : exDir;
  const result = api.archive.extract(file, folder, names, $('#exSkip').checked);
  setBar('#exBar', `完成：写入 ${result.written} 个，跳过 ${result.skipped} 个`, 'ok');
  $('#exResults').textContent = `${nameOf(file)}：写入 ${result.written} 个，跳过 ${result.skipped} 个`;
  toast('解压完成');
});
$('#exBatch').onclick = () => work(async () => {
  if (!exDir || !exFiles.length) { toast('请选择 ZIP 和解压目录'); return; }
  let success = 0; let failed = 0; let written = 0;
  const results = [];
  for (const [index, file] of exFiles.entries()) {
    setBar('#exBar', `正在处理 ${index + 1}/${exFiles.length}：${nameOf(file)}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const folder = $('#exSeparate').checked ? api.archive.joinOutput(exDir, `${index + 1}-${nameOf(file).replace(/\.zip$/i, '')}`) : exDir;
      const result = api.archive.extract(file, folder, [], $('#exSkip').checked);
      success++; written += result.written; results.push(`✓ ${nameOf(file)}：写入 ${result.written}，跳过 ${result.skipped}`);
    } catch (error) { failed++; results.push(`✗ ${nameOf(file)}：${error.message}`); }
  }
  $('#exResults').innerHTML = results.map(line => `<div>${esc(line)}</div>`).join('');
  setBar('#exBar', `批量完成：成功 ${success} 个 ZIP，失败 ${failed} 个，写入 ${written} 个文件`, failed ? 'err' : 'ok');
});
$('#crDrop').onclick = $('#crAddFiles').onclick = () => addSources(api.selectFiles({ multiple: true }));
$('#crAddFolder').onclick = () => { const dir = api.selectDirectory('选择要打包的文件夹'); if (dir) addSources([dir]); };
$('#crClear').onclick = () => { crFiles.length = 0; renderSources(); setBar('#crBar', '队列已清空'); updateButtons(); };
$('#crCreate').onclick = () => work(async () => {
  if (!crFiles.length) { toast('请先添加文件或文件夹'); return; }
  const out = api.chooseSavePath({ title: '保存 ZIP', defaultPath: '三人聚智压缩包.zip', filters: [{ name: 'ZIP', extensions: ['zip'] }] });
  if (!out) return;
  setBar('#crBar', '正在创建 ZIP…');
  try {
    const result = api.archive.create(crFiles, out, Number($('#crLevel').value));
    setBar('#crBar', `已创建 ${result.files} 个文件 · ${fmtSize(result.bytes)}`, 'ok'); toast(`已保存：${nameOf(result.output)}`);
  } catch (error) { setBar('#crBar', error.message, 'err'); toast(error.message); }
});

for (const [id, add] of [['#exDrop', addArchives], ['#crDrop', addSources]]) {
  const zone = $(id);
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('dragging'); add(api.archive.droppedPaths(event.dataTransfer.files)); });
}
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
window.addEventListener('plugin-enter', event => {
  const payload = event.detail?.action?.payload || event.detail?.action?.clipboardText || '';
  if (typeof payload === 'string' && /\.zip$/i.test(payload)) addArchives([payload]);
});
updateButtons();
