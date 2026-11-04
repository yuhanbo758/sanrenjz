const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
let loaded = null;
let busy = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  clearTimeout(element.timer); element.timer = setTimeout(() => element.classList.remove('show'), 2200);
}
function setStatus(message, state = '') {
  $('#statusbar').className = 'statusbar' + (state ? ' ' + state : '');
  $('#statusText').textContent = message;
}
function setBusy(value) {
  busy = value;
  for (const id of ['loadBtn', 'writeBtn', 'clearBtn', 'resetBtn']) $('#' + id).disabled = value;
}
function jumpTo(line) {
  const editor = $('#editor'); const lines = editor.value.split('\n');
  let start = 0; for (let i = 0; i < line - 1; i++) start += lines[i].length + 1;
  editor.focus(); editor.setSelectionRange(start, start + (lines[line - 1] || '').length);
}
function inspect() {
  const report = api.inspectHosts($('#editor').value); const box = $('#issues'); box.replaceChildren();
  for (const [items, kind] of [[report.errors, 'error'], [report.warnings, 'warn']]) {
    for (const item of items) {
      const button = document.createElement('button'); button.className = 'issue issue-' + kind;
      button.textContent = `第 ${item.line} 行：${item.message}`; button.onclick = () => jumpTo(item.line);
      box.append(button);
    }
  }
  box.classList.toggle('show', box.childElementCount > 0);
  $('#editStat').textContent = `${report.lines} 行 · ${report.entries} 个域名`;
  return report;
}
function preview() {
  const report = inspect();
  const before = (loaded?.content || '').replace(/\r\n/g, '\n').split('\n');
  const after = $('#editor').value.split('\n'); let html = '';
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] === after[i]) html += `<span class="diff-line diff-same">${escapeHtml(before[i] ?? '') || '&nbsp;'}</span>`;
    else {
      if (before[i] !== undefined) html += `<span class="diff-line diff-del">- ${escapeHtml(before[i]) || '&nbsp;'}</span>`;
      if (after[i] !== undefined) html += `<span class="diff-line diff-add">+ ${escapeHtml(after[i]) || '&nbsp;'}</span>`;
    }
  }
  $('#diffOut').innerHTML = before.join('\n') === after.join('\n') ? '<div class="empty-diff">无差异</div>' : html;
  setStatus(report.errors.length ? `发现 ${report.errors.length} 处格式错误` : report.warnings.length ? `发现 ${report.warnings.length} 处重复提示` : '差异预览完成', report.errors.length ? 'err' : report.warnings.length ? 'warn' : 'ok');
  return report;
}
$('#editor').addEventListener('input', inspect);
$('#diffBtn').onclick = preview;
$('#copyBtn').onclick = () => { api.copyText($('#editor').value); toast('已复制编辑区内容'); };
$('#clearBtn').onclick = () => {
  if (!$('#editor').value || confirm('清空编辑区？此操作暂不写入系统 Hosts。')) {
    $('#editor').value = ''; inspect(); $('#editor').focus();
  }
};
$('#resetBtn').onclick = () => {
  if (!loaded) return toast('请先读取 Hosts');
  if ($('#editor').value !== loaded.content && !confirm('放弃编辑区修改并恢复到上次读取的内容？')) return;
  $('#editor').value = loaded.content; preview();
};
function findNext() {
  const query = $('#search').value.trim().toLowerCase(); if (!query) return;
  const editor = $('#editor'), text = editor.value.toLowerCase();
  let position = text.indexOf(query, editor.selectionEnd); if (position < 0) position = text.indexOf(query);
  if (position < 0) return toast('未找到匹配内容');
  editor.focus(); editor.setSelectionRange(position, position + query.length);
}
$('#nextBtn').onclick = findNext;
$('#search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); findNext(); } });
$('#loadBtn').onclick = async () => {
  if (busy) return;
  if (loaded && $('#editor').value !== loaded.content && !confirm('重新读取会覆盖编辑区草稿，确认继续？')) return;
  setBusy(true); setStatus('读取中…', 'warn');
  try {
    loaded = (await api.readHosts()).result; $('#editor').value = loaded.content;
    $('#pathInfo').textContent = loaded.hostsPath; preview(); setStatus('已加载当前 Hosts 文件', 'ok');
  } catch (error) { setStatus(error.message, 'err'); }
  finally { setBusy(false); }
};
$('#writeBtn').onclick = async () => {
  if (busy) return; if (!loaded) return toast('请先读取 Hosts');
  const content = $('#editor').value, report = preview();
  if (report.errors.length) return toast('请先修正格式错误');
  if (content.replace(/\r\n/g, '\n') === loaded.content.replace(/\r\n/g, '\n')) return toast('没有需要写入的变化');
  if (!confirm(`确认写入系统 Hosts？\n${report.entries} 个域名，${report.warnings.length} 处重复提示。\n写入前会自动备份；清空内容也会覆盖系统文件。`)) return;
  setBusy(true); setStatus('写入中…', 'warn');
  try {
    const result = (await api.writeHosts({ content, revision: loaded.revision, bom: loaded.bom, eol: loaded.eol })).result;
    loaded = (await api.readHosts()).result; $('#editor').value = loaded.content; preview(); setStatus('写入成功', 'ok');
    if (result.backup) {
      const link = $('#backupLink'); link.style.display = 'inline';
      link.textContent = '查看备份：' + result.backup.split(/[\\/]/).pop(); link.onclick = () => api.showPath(result.backup);
    }
    toast('Hosts 已更新');
  } catch (error) { setStatus(error.message, 'err'); toast('写入失败，请查看状态栏'); }
  finally { setBusy(false); }
};
window.addEventListener('plugin-enter', event => {
  const text = event.detail?.action?.payload || event.detail?.action?.clipboardText || event.detail?.payload || event.detail?.clipboardText || '';
  if (!text) return;
  if ($('#editor').value && !confirm('使用传入内容替换编辑区草稿？')) return;
  $('#editor').value = text; inspect();
});
inspect();
