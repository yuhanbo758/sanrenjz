const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
function esc(value) { return String(value).replace(/[&<>\"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])); }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(el.timer); el.timer = setTimeout(() => el.classList.remove('show'), 2200); }
function setBar(message, status) { const el = $('#bar'); el.className = `bar ${status || ''}`; el.querySelector('span:last-child').textContent = message; }
let files = [], rotation = 0, mode = 'merge', busy = false;
const selected = () => files.map(file => ({ path: file.path, range: file.range, reverse: file.reverse }));
function markChanged() { $('#pageCount').textContent = '-'; setBar('设置已更改，建议预览输出'); }

async function addFiles(paths) {
  if (busy) return;
  const unique = [...new Set((paths || []).filter(value => typeof value === 'string' && /\.pdf$/i.test(value)))].filter(value => !files.some(file => file.path.toLowerCase() === value.toLowerCase()));
  if (!unique.length) { toast('没有新的 PDF 文件'); return; }
  busy = true; setBar('正在读取 PDF…');
  const errors = [];
  for (const filePath of unique) {
    try { files.push({ ...await api.inspectPdf(filePath), range: '', reverse: false }); }
    catch (error) { errors.push(`${filePath.split(/[\\/]/).pop()}：${error.message}`); }
  }
  busy = false; render();
  setBar(errors.length ? errors.join('；').slice(0, 200) : `已添加 ${unique.length} 个文件`, errors.length ? 'err' : 'ok');
}
function chooseFiles() { const paths = api.selectFiles({ multiple: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] }); if (paths?.length) addFiles(paths); }
$('#dropZone').onclick = chooseFiles;
$('#addBtn').onclick = chooseFiles;
document.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $('.body').classList.add('dragging'); } });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('.body').classList.remove('dragging'); });
document.addEventListener('drop', event => { event.preventDefault(); $('.body').classList.remove('dragging'); addFiles([...event.dataTransfer.files].map(file => file.path).filter(Boolean)); });
$$('.rot-btn').forEach(button => button.onclick = () => { rotation = +button.dataset.rot; $$('.rot-btn').forEach(item => item.classList.toggle('active', item === button)); markChanged(); });
$$('.mode-btn').forEach(button => button.onclick = () => { mode = button.dataset.mode; $$('.mode-btn').forEach(item => item.classList.toggle('active', item === button)); markChanged(); });
$('#clearBtn').onclick = () => { if (busy) return; files = []; render(); setBar('已清空'); };

function render() {
  $('#fileCount').textContent = files.length;
  $('#previewBtn').disabled = !files.length;
  $('#saveBtn').disabled = !files.length;
  $('#pageCount').textContent = '-';
  if (!files.length) { $('#fileList').innerHTML = '<div class="empty"><span>点击左侧或拖入 PDF 文件</span></div>'; return; }
  $('#fileList').innerHTML = files.map((file, index) => `<div class="pdf-card"><div class="pdf-thumb"><span class="ord">${index + 1}</span>PDF</div><div class="pdf-info"><div class="nm" title="${esc(file.path)}">${esc(file.name)}</div><div class="meta">${file.pages} 页 · ${(file.bytes / 1048576).toFixed(1)} MB</div><div class="pdf-config"><input data-range="${index}" aria-label="${esc(file.name)} 的页码范围" placeholder="全部 / 奇数 / 偶数 / 1-3,5" value="${esc(file.range)}"><label><input type="checkbox" data-reverse="${index}" ${file.reverse ? 'checked' : ''}>倒序</label></div></div><div class="pdf-actions"><button class="mini" data-up="${index}" title="上移" aria-label="上移">↑</button><button class="mini" data-down="${index}" title="下移" aria-label="下移">↓</button><button class="mini" data-del="${index}" title="移除" aria-label="移除">×</button></div></div>`).join('');
  $$('#fileList [data-range]').forEach(el => el.oninput = () => { files[+el.dataset.range].range = el.value; markChanged(); });
  $$('#fileList [data-reverse]').forEach(el => el.onchange = () => { files[+el.dataset.reverse].reverse = el.checked; markChanged(); });
  $$('#fileList [data-up]').forEach(el => el.onclick = () => { const index = +el.dataset.up; if (index > 0) { [files[index - 1], files[index]] = [files[index], files[index - 1]]; render(); } });
  $$('#fileList [data-down]').forEach(el => el.onclick = () => { const index = +el.dataset.down; if (index < files.length - 1) { [files[index + 1], files[index]] = [files[index], files[index + 1]]; render(); } });
  $$('#fileList [data-del]').forEach(el => el.onclick = () => { files.splice(+el.dataset.del, 1); render(); });
}
$('#previewBtn').onclick = async () => {
  if (busy) return; busy = true; setBar('正在预览…');
  try { const plan = await api.previewPdf(selected(), rotation); $('#pageCount').textContent = plan.pages; setBar(mode === 'split' ? `将生成 ${plan.pages} 个单页 PDF` : `将输出 ${plan.pages} 页 PDF`, 'ok'); }
  catch (error) { setBar(error.message, 'err'); }
  finally { busy = false; }
};
$('#saveBtn').onclick = async () => {
  if (busy) return;
  let output, outputDirectory;
  if (mode === 'merge') output = api.chooseSavePath({ title: '保存 PDF', defaultPath: 'PDF页面整理结果.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  else outputDirectory = api.selectDirectory('选择拆分结果目录');
  if (!(output || outputDirectory)) return;
  busy = true; $('#saveBtn').disabled = true; setBar('处理中…');
  try { const result = await api.savePdf(selected(), { mode, rotation, output, outputDirectory }); toast(`已保存 ${result.outputs.length} 个 PDF`); setBar(`已保存 ${result.pages} 页，生成 ${result.outputs.length} 个文件`, 'ok'); $('#pageCount').textContent = result.pages; }
  catch (error) { setBar(error.message, 'err'); }
  finally { busy = false; $('#saveBtn').disabled = !files.length; }
};
window.addEventListener('plugin-enter', event => { const text = event.detail?.action?.payload || event.detail?.action?.clipboardText || event.detail?.payload || event.detail?.clipboardText || ''; if (typeof text === 'string' && /\.pdf$/i.test(text.trim())) addFiles([text.trim()]); });
