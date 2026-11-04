const api = window.pluginAPI;
const core = window.FocusCore;
const $ = selector => document.querySelector(selector);
let state = core.defaults();
let editingTask = null;
let saveQueue = Promise.resolve();
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('show'), 2600); }
function save() {
  // 顺序写入完整快照，避免连续按钮操作使较旧的状态最后落盘。
  const snapshot = JSON.parse(JSON.stringify(state));
  saveQueue = saveQueue.catch(() => {}).then(() => api.storage.set('focus-state-v2', snapshot));
  saveQueue.catch(() => toast('保存失败，请检查插件数据目录'));
  return saveQueue;
}
function tab(name) {
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(el => el.classList.toggle('active', el.id === `${name}Panel`));
  if (name === 'logs') renderLogs();
  if (name === 'tasks') renderTasks();
}
function taskName(id) { return state.tasks.find(t => t.id === id); }
function renderTimer() {
  const t = state.timer, left = core.remaining(t);
  $('#time').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  $('#phase').textContent = t.phase === 'focus' ? t.runningUntil ? '专注中' : left < t.duration ? '专注已暂停' : '准备专注' : t.phase === 'longBreak' ? '长休息' : '短休息';
  $('#ring').classList.toggle('break', t.phase !== 'focus');
  $('#ringFront').setAttribute('stroke-dashoffset', String(270.18 * (1 - left / Math.max(1, t.duration))));
  $('#start').textContent = t.runningUntil ? '暂停' : left < t.duration ? '继续' : t.phase === 'focus' ? '开始专注' : '开始休息';
  $('#skip').hidden = t.phase === 'focus';
  $('#interrupt').disabled = !t.runningUntil || t.phase !== 'focus';
  $('#interruptCount').textContent = t.interruptions ? `已中断 ${t.interruptions} 次` : '';
  $('#taskSelect').disabled = !!t.runningUntil || left < t.duration || t.phase !== 'focus';
  for (const id of ['focusMin', 'shortBreakMin', 'longBreakMin']) $(id === 'focusMin' ? '#focusMin' : `#${id}`).disabled = !!t.runningUntil || left < t.duration;
  $('#dots').innerHTML = Array.from({ length: state.settings.longEvery }, (_, i) => `<span class="dot${i < t.cycle % state.settings.longEvery ? ' done' : ''}"></span>`).join('');
}
function renderSelect() {
  const select = $('#taskSelect');
  const open = state.tasks.filter(t => !t.completedAt);
  select.innerHTML = '<option value="">不关联任务 · 默认项目</option>' + open.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title)} · ${escapeHtml(t.project)}</option>`).join('');
  select.value = open.some(t => t.id === state.timer.taskId) ? state.timer.taskId : '';
  $('#taskBadge').textContent = `(${open.length})`;
  $('#taskHint').textContent = state.timer.taskId && !open.some(t => t.id === state.timer.taskId) ? `本轮任务：${state.timer.taskTitle}` : '完成的专注会归到所选任务。';
  renderTimer();
}
function renderOverview() {
  const today = core.localDate();
  const todayLogs = state.logs.filter(l => l.date === today && l.type === 'pomodoro');
  $('#todayMinutes').textContent = todayLogs.reduce((n, l) => n + Number(l.minutes || 0), 0);
  $('#todayPomos').textContent = todayLogs.length;
  $('#todayDone').textContent = state.tasks.filter(t => t.completedAt && core.localDate(t.completedAt) === today).length;
  const open = state.tasks.filter(t => !t.completedAt).slice(0, 4);
  $('#todayTasks').innerHTML = open.length ? open.map(t => `<div class="today-task"><span class="title">${escapeHtml(t.title)}</span><span class="label">${t.actual || 0}/${t.estimate} 番茄</span><button class="btn small" data-pick="${escapeHtml(t.id)}">专注</button></div>`).join('') : '<p class="notice">暂无待完成任务。可直接开始计时，或先添加任务。</p>';
}
function renderTasks() {
  const filter = $('#taskFilter').value;
  const items = state.tasks.filter(t => filter === 'all' || (filter === 'done') === !!t.completedAt)
    .sort((a, b) => Number(!!a.completedAt) - Number(!!b.completedAt) || ({ high: 0, normal: 1, low: 2 }[a.priority] || 1) - ({ high: 0, normal: 1, low: 2 }[b.priority] || 1) || String(a.due || '9999').localeCompare(b.due || '9999'));
  $('#taskCount').textContent = `${items.length} 项 · ${state.tasks.filter(t => !t.completedAt).length} 项待完成`;
  $('#taskList').innerHTML = items.length ? items.map(t => `<div class="item${t.completedAt ? ' done' : ''}"><div class="main"><div class="title">${escapeHtml(t.title)}</div><div class="meta">${escapeHtml(t.project)} · ${t.actual || 0}/${t.estimate} 番茄${t.due ? ` · 截止 ${escapeHtml(t.due)}` : ''}${t.completedAt ? ` · 完成于 ${escapeHtml(core.localDate(t.completedAt))}` : ''}</div></div>${t.priority === 'high' ? '<span class="pill">优先</span>' : ''}<button class="btn small" data-task-action="${t.completedAt ? 'reopen' : 'complete'}" data-id="${escapeHtml(t.id)}">${t.completedAt ? '重开' : '完成'}</button><button class="btn small" data-task-action="edit" data-id="${escapeHtml(t.id)}">设置</button><button class="btn small danger" data-task-action="delete" data-id="${escapeHtml(t.id)}">删除</button></div>`).join('') : '<div class="card empty">没有符合条件的任务</div>';
}
function renderLogs() {
  const sum = core.summary(state.logs), today = core.localDate();
  $('#logToday').textContent = sum.today;
  $('#logWeek').textContent = sum.week;
  $('#logPomos').textContent = sum.pomodoros;
  const filter = $('#logFilter').value;
  const items = state.logs.filter(l => filter === 'all' || filter === 'today' && l.date === today || filter === 'week' && l.date >= sum.weekStart && l.date <= today)
    .sort((a, b) => String(b.endedAt || b.date).localeCompare(String(a.endedAt || a.date)));
  $('#logCount').textContent = `${items.length} 条`;
  $('#logList').innerHTML = items.length ? items.map(l => `<div class="item"><div class="main"><div class="title">${escapeHtml(l.taskTitle || l.project)}</div><div class="meta">${escapeHtml(l.project)} · ${escapeHtml(l.date)} · ${l.type === 'pomodoro' ? '番茄专注' : l.type === 'manual' ? '手动记录' : '旧版记录'}${l.note ? ` · ${escapeHtml(l.note)}` : ''}</div></div><b>${Number(l.minutes) || 0} 分钟</b><button class="btn small danger" data-log-delete="${escapeHtml(l.id)}">删除</button></div>`).join('') : '<div class="card empty">暂无工时记录</div>';
}
function renderAll() { renderSelect(); renderOverview(); renderTasks(); renderLogs(); }
function synchronizeClock() {
  if (core.completePhase(state)) {
    save(); renderAll(); toast(state.timer.phase === 'focus' ? '休息结束，可开始下一轮' : '专注完成，已记录工时');
  } else renderTimer();
}
function resetTimer() {
  const t = state.timer;
  if ((t.runningUntil || t.remaining < t.duration) && !confirm('放弃当前未完成的计时？')) return;
  t.runningUntil = null; t.phase = 'focus'; t.duration = state.settings.focus * 60; t.remaining = t.duration; t.interruptions = 0;
  save(); renderAll();
}
function newTaskForm(task = null) {
  editingTask = task && task.id || null;
  $('#taskForm').hidden = false;
  $('#taskTitle').value = task && task.title || '';
  $('#taskProject').value = task && task.project || '默认项目';
  $('#taskEstimate').value = task && task.estimate || 1;
  $('#taskPriority').value = task && task.priority || 'normal';
  $('#taskDue').value = task && task.due || '';
  tab('tasks'); $('#taskTitle').focus();
}
async function init() {
  try {
    const raw = await api.storage.get('focus-state-v2');
    const old = raw ? [] : await api.storage.get('worklog');
    state = core.normalize(raw, old);
    if (!raw) await save();
    $('#focusMin').value = state.settings.focus;
    $('#shortBreakMin').value = state.settings.shortBreak;
    $('#longBreakMin').value = state.settings.longBreak;
    synchronizeClock(); renderAll();
    setInterval(synchronizeClock, 1000);
    document.addEventListener('visibilitychange', synchronizeClock);
  } catch (error) { toast(`读取专注数据失败：${error.message}`); }
}
document.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => tab(el.dataset.tab)));
$('#start').onclick = () => {
  const t = state.timer;
  if (t.runningUntil) { t.remaining = core.remaining(t); t.runningUntil = null; }
  else {
    if (t.phase === 'focus' && t.remaining === t.duration) {
      t.taskId = $('#taskSelect').value || null;
      const task = taskName(t.taskId); t.taskTitle = task ? task.title : ''; t.project = task ? task.project : '默认项目';
    }
    t.runningUntil = Date.now() + t.remaining * 1000;
  }
  save(); renderTimer();
};
$('#taskSelect').onchange = event => {
  const task = taskName(event.target.value);
  state.timer.taskId = task ? task.id : null;
  state.timer.taskTitle = task ? task.title : '';
  state.timer.project = task ? task.project : '默认项目';
  save(); renderOverview();
};
$('#reset').onclick = resetTimer;
$('#skip').onclick = () => { state.timer.phase = 'focus'; state.timer.runningUntil = null; state.timer.duration = state.settings.focus * 60; state.timer.remaining = state.timer.duration; save(); renderTimer(); };
$('#interrupt').onclick = () => { state.timer.interruptions++; save(); renderTimer(); };
for (const [id, key, max] of [['focusMin', 'focus', 180], ['shortBreakMin', 'shortBreak', 90], ['longBreakMin', 'longBreak', 90]]) {
  $(`#${id}`).onchange = event => {
    const value = core.clamp(event.target.value, 1, max, state.settings[key]);
    state.settings[key] = value; event.target.value = value;
    if (!state.timer.runningUntil && state.timer.remaining === state.timer.duration && (state.timer.phase === 'focus' ? key === 'focus' : state.timer.phase === key)) {
      state.timer.duration = value * 60; state.timer.remaining = state.timer.duration;
    }
    save(); renderTimer();
  };
}
$('#newTaskShortcut').onclick = () => newTaskForm();
$('#showTaskForm').onclick = () => newTaskForm();
$('#cancelTask').onclick = () => { $('#taskForm').hidden = true; editingTask = null; };
$('#taskForm').onsubmit = event => {
  event.preventDefault();
  const title = $('#taskTitle').value.trim(), project = $('#taskProject').value.trim() || '默认项目';
  if (!title) return;
  const data = { title, project, estimate: core.clamp($('#taskEstimate').value, 1, 99, 1), priority: $('#taskPriority').value, due: $('#taskDue').value };
  const task = taskName(editingTask);
  if (task) Object.assign(task, data);
  else state.tasks.unshift({ id: core.uid(), ...data, actual: 0, createdAt: new Date().toISOString(), completedAt: null });
  editingTask = null; $('#taskForm').hidden = true; save(); renderAll(); toast('任务已保存');
};
$('#taskFilter').onchange = renderTasks;
$('#taskList').onclick = event => {
  const button = event.target.closest('[data-task-action]'); if (!button) return;
  const task = taskName(button.dataset.id); if (!task) return;
  const action = button.dataset.taskAction;
  if (action === 'edit') return newTaskForm(task);
  if (action === 'delete') { if (!confirm(`删除任务“${task.title}”？已完成的工时记录会保留。`)) return; state.tasks = state.tasks.filter(t => t !== task); }
  else task.completedAt = action === 'complete' ? new Date().toISOString() : null;
  save(); renderAll();
};
$('#todayTasks').onclick = event => {
  const button = event.target.closest('[data-pick]'); if (!button) return;
  if ($('#taskSelect').disabled) return toast('当前一轮结束后才能切换任务');
  $('#taskSelect').value = button.dataset.pick;
  $('#taskSelect').dispatchEvent(new Event('change'));
  tab('timer'); toast('已选择任务，开始专注即可记录');
};
$('#showLogForm').onclick = () => { $('#logForm').hidden = false; $('#logDate').value = core.localDate(); $('#logProject').value = taskName($('#taskSelect').value)?.project || '默认项目'; };
$('#cancelLog').onclick = () => { $('#logForm').hidden = true; };
$('#logForm').onsubmit = event => {
  event.preventDefault(); const minutes = core.clamp($('#logMinutes').value, 1, 1440, 0);
  if (!minutes || !$('#logProject').value.trim() || !$('#logDate').value) return toast('请填写项目、日期与有效分钟数');
  state.logs.unshift({ id: core.uid(), type: 'manual', taskId: null, taskTitle: '', project: $('#logProject').value.trim(), minutes, date: $('#logDate').value, note: $('#logNote').value.trim() });
  $('#logForm').reset(); $('#logForm').hidden = true; save(); renderAll(); toast('工时已添加');
};
$('#logFilter').onchange = renderLogs;
$('#logList').onclick = event => {
  const button = event.target.closest('[data-log-delete]'); if (!button) return;
  const log = state.logs.find(l => l.id === button.dataset.logDelete); if (!log || !confirm('删除这条工时记录？')) return;
  state.logs = state.logs.filter(l => l !== log);
  if (log.type === 'pomodoro') { const task = taskName(log.taskId); if (task) task.actual = Math.max(0, (task.actual || 0) - 1); }
  save(); renderAll();
};
$('#exportCsv').onclick = () => {
  // 防止任务名等用户文本被电子表格当作公式执行。
  const quote = value => {
    const text = String(value ?? '');
    return `"${(/^[\s]*[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const rows = [['日期', '项目', '任务', '分钟', '来源', '中断次数', '备注'], ...state.logs.map(l => [l.date, l.project, l.taskTitle || '', l.minutes, l.type === 'pomodoro' ? '番茄专注' : l.type === 'manual' ? '手动' : '旧版', l.interruptions || 0, l.note || ''])];
  const blob = new Blob(['\ufeff', rows.map(row => row.map(quote).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `专注工时-${core.localDate()}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
};
window.addEventListener('plugin-enter', event => { const tool = event.detail && event.detail.toolId; if (tool === 'worklog') tab('logs'); else tab('timer'); });
init();
