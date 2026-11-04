const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
let current = 'batch-renamer';
let sourcePaths = [];
let files = [];
let plan = null;
let hashes = [];
let busy = false;

function esc(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(node._timer); node._timer = setTimeout(() => node.classList.remove('show'), 2400); }
function status(id, message, kind = '') { const bar = $(id); bar.className = `bar ${kind}`; bar.querySelector('span:last-child').textContent = message; }
function invalidate() { plan = null; $('#rnExec').disabled = true; }
function setBusy(value) { busy = value; for (const button of $$('button')) if (button.id !== 'rnExec' && button.id !== 'csExport') button.disabled = value; $('#rnExec').disabled = value || !plan; $('#csExport').disabled = value || !hashes.length; }
function showTool(id) { current = id; $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tool === id)); $$('.panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === id)); }
$$('.tab').forEach(tab => tab.onclick = () => showTool(tab.dataset.tool));

function refreshSources() {
  try {
    files = api.batch.collect(sourcePaths, $('#recursive').checked);
    $('#sourceSummary').textContent = files.length ? `已加入 ${files.length} 个文件，来自 ${sourcePaths.length} 个来源` : '拖入文件或目录，或点击左侧添加';
    invalidate(); hashes = []; $('#csExport').disabled = true;
    $('#rnTable').innerHTML = '<div class="empty"><span>文件清单已变化，请预览重命名</span></div>';
    $('#csTable').innerHTML = '<div class="empty"><span>选择文件后计算校验和</span></div>';
  } catch (error) { toast(error.message); }
}
function addSources(paths) {
  if (!paths.length) return;
  const previous = sourcePaths;
  sourcePaths = [...new Set([...sourcePaths, ...paths])];
  try { api.batch.collect(sourcePaths, $('#recursive').checked); refreshSources(); }
  catch (error) { sourcePaths = previous; toast(error.message); }
}
$('#pickFiles').onclick = () => addSources(api.selectFiles({ multiple: true }));
$('#pickDir').onclick = () => { const dir = api.selectDirectory('选择待处理目录'); if (dir) addSources([dir]); };
$('#clearFiles').onclick = () => { sourcePaths = []; refreshSources(); };
$('#recursive').onchange = refreshSources;
let dragDepth = 0;
document.addEventListener('dragenter', event => { event.preventDefault(); dragDepth += 1; $('#dropZone').classList.add('dragging'); });
document.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('dragleave', event => { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropZone').classList.remove('dragging'); });
document.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('#dropZone').classList.remove('dragging');
  const paths = api.batch.droppedPaths(event.dataTransfer.files);
  if (paths.length) addSources(paths); else toast('没有识别到本地文件或目录');
});

function renameOptions() { return { find: $('#rnFind').value, replace: $('#rnReplace').value, prefix: $('#rnPrefix').value, suffix: $('#rnSuffix').value, number: $('#rnNumber').checked, regex: $('#rnRegex').checked, start: Number($('#rnStart').value), padding: Number($('#rnPad').value), extensions: $('#rnExt').value, caseMode: $('#rnCase').value }; }
$$('.rules input,.rules select').forEach(input => { input.addEventListener('input', invalidate); input.addEventListener('change', invalidate); });
$('#rnPreview').onclick = () => {
  if (!files.length) return toast('请先添加文件或目录');
  try {
    plan = api.batch.planRename(files, renameOptions());
    if (!plan.length) { $('#rnExec').disabled = true; $('#rnTable').innerHTML = '<div class="empty"><span>没有需要重命名的文件</span></div>'; status('#rnBar', '无需重命名', 'ok'); return; }
    $('#rnTable').innerHTML = `<table><thead><tr><th>所在目录</th><th>原文件名</th><th>新文件名</th></tr></thead><tbody>${plan.map(row => `<tr><td>${esc(row.from.slice(0, -row.before.length))}</td><td class="from">${esc(row.before)}</td><td class="to">${esc(row.after)}</td></tr>`).join('')}</tbody></table>`;
    $('#rnExec').disabled = false;
    status('#rnBar', `预览完成，${plan.length} 个文件待重命名`, 'ok');
  } catch (error) { invalidate(); status('#rnBar', error.message, 'err'); }
};
$('#rnExec').onclick = () => {
  if (!plan?.length || busy) return;
  if (!window.confirm(`确认按预览结果重命名 ${plan.length} 个文件？`)) return;
  setBusy(true);
  try {
    const count = api.batch.executeRename(plan);
    sourcePaths = sourcePaths.filter(item => !files.includes(item));
    refreshSources();
    $('#rnTable').innerHTML = '<div class="empty"><span>重命名完成，重新添加文件可继续处理</span></div>';
    status('#rnBar', `已重命名 ${count} 个文件`, 'ok'); toast('重命名完成');
  } catch (error) { invalidate(); status('#rnBar', error.message, 'err'); }
  finally { setBusy(false); }
};

function renderHashes() {
  const expected = $('#csExpected').value.trim().toLowerCase();
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) { status('#csBar', '请输入 64 位 SHA-256 值', 'err'); return; }
  $('#csTable').innerHTML = `<table><thead><tr><th>文件</th><th>SHA-256</th><th>比对</th><th></th></tr></thead><tbody>${hashes.map((row, index) => `<tr><td>${esc(row.file)}</td><td style="word-break:break-all">${esc(row.sha256)}</td><td>${expected ? (row.sha256 === expected ? '一致' : '不一致') : '—'}</td><td><button class="btn" data-copy="${index}">复制</button></td></tr>`).join('')}</tbody></table>`;
  $$('#csTable [data-copy]').forEach(button => button.onclick = () => { api.copyText(hashes[Number(button.dataset.copy)].sha256); toast('已复制 SHA-256'); });
  status('#csBar', expected ? `${hashes.filter(row => row.sha256 === expected).length} 个文件匹配` : `已计算 ${hashes.length} 个文件`, 'ok');
}
$('#csExpected').oninput = () => { if (hashes.length) renderHashes(); };
$('#csCalc').onclick = async () => {
  if (!files.length) return toast('请先添加文件或目录');
  setBusy(true); status('#csBar', `计算 ${files.length} 个文件中…`);
  try { hashes = await api.batch.checksum(files); renderHashes(); $('#csExport').disabled = false; }
  catch (error) { hashes = []; status('#csBar', error.message, 'err'); }
  finally { setBusy(false); }
};
$('#csExport').onclick = () => {
  if (!hashes.length) return;
  const csv = '文件,SHA-256\r\n' + hashes.map(row => [row.file, row.sha256].map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const result = api.saveResult({ title: '导出 SHA-256 清单', defaultPath: 'SHA-256-清单.csv', text: '\uFEFF' + csv, filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (!result.cancelled) toast('清单已导出');
};
window.addEventListener('plugin-enter', event => { const id = event.detail?.toolId; if (id) showTool(id); });
