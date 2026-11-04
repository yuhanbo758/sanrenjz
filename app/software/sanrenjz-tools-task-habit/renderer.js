const api = window.pluginAPI;
const core = window.taskHabitCore;
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
let todos = [];
let habits = [];
let timer = core.timerDefaults();
let timerSaveQueue = Promise.resolve();
const newTaskId = () => `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
let current = 'todo-list';
let shownWeek = core.weekStart(new Date());
let editingIndex = -1;
let dragDepth = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2400);
}
function showTool(tool) {
  current = tool;
  $$('.tab').forEach(el => el.classList.toggle('active', el.dataset.tool === tool));
  $$('.panel').forEach(el => el.classList.toggle('active', el.dataset.panel === tool));
  if (tool === 'habit-tracker') renderHabits();
  if (tool === 'pomodoro') renderFocus();
}
function saveTimer() {
  const snapshot = JSON.parse(JSON.stringify(timer));
  timerSaveQueue = timerSaveQueue.catch(() => {}).then(async () => {
    if (await api.storage.set('pomodoro-v1', snapshot) === false) throw new Error('存储失败');
  });
  timerSaveQueue.catch(() => toast('计时数据保存失败'));
  return timerSaveQueue;
}
$$('.tab').forEach(el => el.addEventListener('click', () => showTool(el.dataset.tool)));

async function saveTodos() {
  try {
    if (await api.storage.set('todos', todos) === false) throw new Error('存储失败');
    renderTodos();
    return true;
  } catch (_) {
    const saved = await api.storage.get('todos').catch(() => null);
    if (Array.isArray(saved)) todos = saved;
    renderTodos();
    toast('任务保存失败，请重试');
    return false;
  }
}
function renderTodos() {
  const done = todos.filter(task => task.completed).length;
  $('#todoTotal').textContent = todos.length;
  $('#todoDone').textContent = done;
  $('#todoPct').textContent = todos.length ? `${Math.round(done / todos.length * 100)}%` : '0%';
  const today = core.dateKey(new Date());
  const rows = core.visibleTodos(todos, $('#todoFilter').value, $('#todoSearch').value, $('#todoSort').value, today);
  $('#todoVisible').textContent = `显示 ${rows.length} / ${todos.length} 项`;
  $('#todoList').innerHTML = rows.length ? rows.map(({ task, index }) => {
    const overdue = !task.completed && task.dueDate && task.dueDate < today;
    const priority = ['high', 'normal', 'low'].includes(task.priority) ? task.priority : 'normal';
    return `<div class="todo-item${task.completed ? ' done' : ''}${overdue ? ' overdue' : ''}"><button class="todo-check${task.completed ? ' checked' : ''}" data-action="toggle" data-tog="${index}" aria-label="切换完成状态"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg></button><span class="todo-text">${escapeHtml(task.title)}</span>${task.dueDate ? `<span class="todo-due">${overdue ? '逾期' : '到期'} ${escapeHtml(task.dueDate)}</span>` : ''}<span class="todo-pri pri-${priority}">${{ high: '高', normal: '普通', low: '低' }[priority]}</span><span class="muted">🍅 ${Number(task.pomodoros) || 0}/${Number(task.estimate) || 1}</span><span class="todo-actions">${task.completed ? '' : `<button class="todo-edit" data-focus="${index}">专注</button>`}<button class="todo-edit" data-action="edit" data-edit="${index}">编辑</button><button class="todo-del" data-del="${index}" aria-label="删除任务">×</button></span></div>`;
  }).join('') : `<div class="todo-empty">${todos.length ? '没有符合条件的任务' : '还没有任务，可添加或拖入文件'}</div>`;
}
$('#todoList').addEventListener('click', async event => {
  const toggle = event.target.closest('[data-tog]');
  const edit = event.target.closest('[data-edit]');
  const focus = event.target.closest('[data-focus]');
  const remove = event.target.closest('[data-del]');
  if (toggle) { todos[Number(toggle.dataset.tog)].completed = !todos[Number(toggle.dataset.tog)].completed; await saveTodos(); }
  if (focus) {
    if (timer.runningUntil || core.remainingSeconds(timer) < timer.duration || timer.phase !== 'focus') return toast('请先完成或重置当前计时');
    timer.taskId = todos[Number(focus.dataset.focus)].id;
    timer.taskTitle = todos[Number(focus.dataset.focus)].title;
    saveTimer(); showTool('pomodoro'); return;
  }
  if (edit) {
    editingIndex = Number(edit.dataset.edit);
    const task = todos[editingIndex];
    $('#editTitle').value = task.title;
    $('#editPriority').value = task.priority || 'normal';
    $('#editDue').value = task.dueDate || '';
    $('#editEstimate').value = Number(task.estimate) || 1;
    $('#editDialog').classList.add('open');
    $('#editTitle').focus();
  }
  if (remove && confirm(`删除任务“${todos[Number(remove.dataset.del)].title}”？`)) {
    todos.splice(Number(remove.dataset.del), 1);
    await saveTodos();
  }
});
$('#editCancel').onclick = () => $('#editDialog').classList.remove('open');
$('#editForm').onsubmit = async event => {
  event.preventDefault();
  const title = $('#editTitle').value.trim();
  if (!title || editingIndex < 0 || !todos[editingIndex]) return;
  Object.assign(todos[editingIndex], { title, priority: $('#editPriority').value, dueDate: $('#editDue').value, estimate: Math.max(1, Math.min(99, Number($('#editEstimate').value) || 1)) });
  await saveTodos();
  $('#editDialog').classList.remove('open');
  editingIndex = -1;
};
$('#todoAdd').onclick = async () => {
  const title = $('#todoInput').value.trim();
  if (!title) { toast('请输入任务'); return; }
  todos.unshift({ id: newTaskId(), title, priority: $('#todoPri').value, dueDate: $('#todoDue').value, completed: false, estimate: 1, pomodoros: 0 });
  await saveTodos();
  $('#todoInput').value = '';
  $('#todoDue').value = '';
};
$('#todoInput').onkeydown = event => { if (event.key === 'Enter') $('#todoAdd').click(); };
['todoSearch', 'todoFilter', 'todoSort'].forEach(id => { $(`#${id}`).addEventListener(id === 'todoSearch' ? 'input' : 'change', renderTodos); });

// 文件导入以明确确认作为写入边界，单次限制避免大文件占用渲染线程和存储。
async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (files.length > 10) { toast('一次最多导入 10 个文件'); return; }
  const added = [];
  try {
    for (const file of files) {
      if (!/\.(txt|md)$/i.test(file.name) || file.size > 1024 * 1024) throw new Error('仅支持每个不超过 1 MB 的 TXT / Markdown 文件');
      const content = await file.text();
      for (const raw of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^#{1,6}\s/.test(line)) continue;
        const box = line.match(/^(?:[-*+]\s+)?\[([ xX])\]\s+(.+)$/);
        const title = (box ? box[2] : line.replace(/^[-*+]\s+/, '')).trim();
        if (title) added.push({ id: newTaskId(), title: title.slice(0, 200), priority: 'normal', dueDate: '', completed: !!box && box[1].toLowerCase() === 'x', estimate: 1, pomodoros: 0 });
        if (added.length > 1000) throw new Error('一次最多导入 1000 条任务');
      }
    }
    if (!added.length) { toast('文件中没有可导入的任务'); return; }
    if (!confirm(`从 ${files.length} 个文件导入 ${added.length} 条任务？`)) return;
    todos.unshift(...added);
    $('#todoFilter').value = 'all';
    if (await saveTodos()) toast(`已导入 ${added.length} 条任务`);
  } catch (error) { toast(error.message || '导入失败'); }
}
$('#importTasks').onclick = () => $('#taskFiles').click();
$('#taskFiles').onchange = event => { importFiles(event.target.files).finally(() => { event.target.value = ''; }); };
window.addEventListener('dragenter', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); dragDepth++; $('#dropMask').classList.add('show'); } });
window.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', event => { if (event.dataTransfer?.types?.includes('Files')) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropMask').classList.remove('show'); } });
window.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('#dropMask').classList.remove('show'); importFiles(event.dataTransfer.files); });

async function saveHabits() {
  try {
    if (await api.storage.set('habits', habits) === false) throw new Error('存储失败');
    renderHabits();
    return true;
  } catch (_) {
    const saved = await api.storage.get('habits').catch(() => null);
    if (Array.isArray(saved)) habits = saved;
    renderHabits();
    toast('习惯保存失败，请重试');
    return false;
  }
}
function renderHabits() {
  const now = new Date();
  const today = core.dateKey(now);
  const days = Array.from({ length: 7 }, (_, index) => core.addDays(shownWeek, index));
  $('#weekRange').textContent = `${core.dateKey(days[0])} ～ ${core.dateKey(days[6])}`;
  $('#weekNext').disabled = core.dateKey(core.weekStart(now)) <= core.dateKey(shownWeek);
  const cards = habits.map((habit, index) => {
    const count = days.filter(day => core.isChecked(habit, day, now)).length;
    const goal = Number(habit.weeklyGoal) || 7;
    const cells = days.map((day, dayIndex) => {
      const checked = core.isChecked(habit, day, now);
      const future = core.dateKey(day) > today;
      return `<div class="day-cell"><div class="day-label">周${dayNames[dayIndex]}</div><button class="day-check${checked ? ' checked' : ''}${core.dateKey(day) === today ? ' today' : ''}" data-day="${index}:${core.dateKey(day)}" data-date="${core.dateKey(day)}" ${future ? 'disabled' : ''} aria-label="${escapeHtml(core.dateKey(day))}打卡"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg></button></div>`;
    }).join('');
    return `<div class="habit-card"><div class="habit-name">${escapeHtml(habit.name)}<button class="habit-del" data-hdel="${index}" aria-label="删除习惯">×</button></div><div class="habit-streak">本周 ${count}/${goal} 天 · 连续 ${core.streak(habit, now)} 天</div><div class="week-row">${cells}</div></div>`;
  });
  $('#habitGrid').innerHTML = cards.join('') || '<div class="todo-empty">添加一个习惯开始打卡</div>';
  $('#habitSummary').textContent = `${habits.length} 个习惯`;
}
$('#habitGrid').onclick = async event => {
  const dayButton = event.target.closest('[data-day]');
  const deleteButton = event.target.closest('[data-hdel]');
  if (dayButton && !dayButton.disabled) {
    const [indexText, date] = dayButton.dataset.day.split(':');
    const habit = habits[Number(indexText)];
    habit.days ||= {};
    habit.days[date] = !core.isChecked(habit, core.fromKey(date), new Date());
    await saveHabits();
  }
  if (deleteButton && confirm(`删除习惯“${habits[Number(deleteButton.dataset.hdel)].name}”及其打卡记录？`)) {
    habits.splice(Number(deleteButton.dataset.hdel), 1);
    await saveHabits();
  }
};
$('#habitAdd').onclick = async () => {
  const name = $('#habitInput').value.trim();
  if (!name) { toast('请输入习惯名称'); return; }
  habits.push({ name, weeklyGoal: Number($('#habitGoal').value), days: {}, weeks: {} });
  await saveHabits();
  $('#habitInput').value = '';
};
$('#habitInput').onkeydown = event => { if (event.key === 'Enter') $('#habitAdd').click(); };
$('#weekPrev').onclick = () => { shownWeek = core.addDays(shownWeek, -7); renderHabits(); };
$('#weekNext').onclick = () => { shownWeek = core.addDays(shownWeek, 7); renderHabits(); };
$('#weekToday').onclick = () => { shownWeek = core.weekStart(new Date()); renderHabits(); };
function renderFocus() {
  const select = $('#focusTask');
  const options = todos.filter(task => !task.completed);
  select.innerHTML = '<option value="">不关联任务</option>' + options.map(task => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)}</option>`).join('');
  select.value = options.some(task => task.id === timer.taskId) ? timer.taskId : '';
  const left = core.remainingSeconds(timer);
  $('#timerTime').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  $('#timerPhase').textContent = timer.phase === 'focus' ? timer.runningUntil ? '专注中' : left < timer.duration ? '专注已暂停' : '准备专注' : timer.phase === 'longBreak' ? '长休息' : '短休息';
  $('#timerStart').textContent = timer.runningUntil ? '暂停' : left < timer.duration ? '继续' : timer.phase === 'focus' ? '开始专注' : '开始休息';
  $('#timerSkip').hidden = timer.phase === 'focus';
  $('#timerHint').textContent = timer.phase === 'focus' ? '完成一轮后自动计入任务进度' : '休息需手动开始';
  select.disabled = !!timer.runningUntil || left < timer.duration || timer.phase !== 'focus';
  for (const id of ['focusMinutes', 'shortMinutes', 'longMinutes']) $('#' + id).disabled = !!timer.runningUntil || left < timer.duration;
  const today = core.dateKey(new Date());
  const todaySessions = timer.sessions.filter(s => core.dateKey(new Date(s.endedAt)) === today);
  $('#todayPomos').textContent = todaySessions.length;
  $('#todayFocusMinutes').textContent = todaySessions.reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
  $('#sessionList').innerHTML = timer.sessions.length ? timer.sessions.slice(0, 12).map(s => `<div class="session-row"><span>${escapeHtml(s.taskTitle)} · ${escapeHtml(core.dateKey(new Date(s.endedAt)))}</span><b>${Number(s.minutes) || 0} 分钟</b></div>`).join('') : '<div class="empty-state">完成第一轮后，这里会显示记录</div>';
}
function tickTimer() {
  const phase = core.finishTimer(timer, todos);
  if (phase) {
    saveTimer();
    if (phase === 'focus') saveTodos();
    renderTodos();
    toast(phase === 'focus' ? '专注完成，已记录番茄' : '休息结束，可以开始下一轮');
  }
  if (current === 'pomodoro') renderFocus();
}
$('#focusTask').onchange = event => { timer.taskId = event.target.value || null; timer.taskTitle = todos.find(task => task.id === timer.taskId)?.title || ''; saveTimer(); };
$('#timerStart').onclick = () => {
  if (timer.runningUntil) { timer.remaining = core.remainingSeconds(timer); timer.runningUntil = null; }
  else { if (timer.phase === 'focus' && timer.remaining === timer.duration) { timer.taskId = $('#focusTask').value || null; timer.taskTitle = todos.find(task => task.id === timer.taskId)?.title || ''; } timer.runningUntil = Date.now() + timer.remaining * 1000; }
  saveTimer(); renderFocus();
};
$('#timerReset').onclick = () => {
  if ((timer.runningUntil || timer.remaining < timer.duration) && !confirm('放弃当前未完成的计时？')) return;
  timer.runningUntil = null; timer.phase = 'focus'; timer.duration = timer.settings.focus * 60; timer.remaining = timer.duration;
  saveTimer(); renderFocus();
};
$('#timerSkip').onclick = () => { timer.runningUntil = null; timer.phase = 'focus'; timer.duration = timer.settings.focus * 60; timer.remaining = timer.duration; saveTimer(); renderFocus(); };
for (const [id, key, max] of [['focusMinutes', 'focus', 180], ['shortMinutes', 'shortBreak', 90], ['longMinutes', 'longBreak', 90]]) {
  $('#' + id).onchange = event => {
    const value = Number(event.target.value);
    if (!Number.isInteger(value) || value < 1 || value > max) { event.target.value = timer.settings[key]; return toast(`请输入 1 到 ${max} 分钟`); }
    timer.settings[key] = value;
    if (!timer.runningUntil && timer.remaining === timer.duration && (timer.phase === key || timer.phase === 'focus' && key === 'focus')) timer.duration = timer.remaining = value * 60;
    saveTimer(); renderFocus();
  };
}
window.addEventListener('plugin-enter', event => {
  const detail = event.detail || {};
  if (detail.toolId) showTool(detail.toolId);
  const text = detail.action?.payload || detail.action?.clipboardText || detail.payload || detail.clipboardText || '';
  if (text && current === 'todo-list') $('#todoInput').value = String(text);
});
Promise.all([api.storage.get('todos'), api.storage.get('habits'), api.storage.get('pomodoro-v1')]).then(([savedTodos, savedHabits, savedTimer]) => {
  todos = Array.isArray(savedTodos) ? savedTodos : [];
  habits = Array.isArray(savedHabits) ? savedHabits : [];
  timer = core.normalizeTimer(savedTimer);
  if (todos.some(task => !task.id)) { todos.forEach(task => { task.id ||= newTaskId(); }); saveTodos(); }
  $('#focusMinutes').value = timer.settings.focus;
  $('#shortMinutes').value = timer.settings.shortBreak;
  $('#longMinutes').value = timer.settings.longBreak;
  tickTimer();
  renderTodos();
  renderHabits();
  renderFocus();
  setInterval(tickTimer, 1000);
  document.addEventListener('visibilitychange', tickTimer);
}).catch(error => toast(`读取数据失败：${error.message}`));
