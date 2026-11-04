/* 日期以本地日历日保存，避免跨时区和跨年时打卡落到错误的一周。 */
(function (root) {
  function dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function fromKey(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day, 12);
  }
  function addDays(date, count) {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    next.setDate(next.getDate() + count);
    return next;
  }
  function weekStart(date) { return addDays(date, -((date.getDay() + 6) % 7)); }
  function legacyWeekKey(date) {
    const year = date.getFullYear();
    return `${year}-W${Math.floor((date - new Date(year, 0, 1)) / 604800000)}`;
  }
  function isChecked(habit, date, referenceDate = new Date()) {
    const key = dateKey(date);
    if (habit.days && Object.prototype.hasOwnProperty.call(habit.days, key)) return !!habit.days[key];
    // 旧版以打开页面当天的“周编号”保存周一至周日数组，当前周按原键读取，不改写旧数据。
    const anchor = dateKey(weekStart(date)) === dateKey(weekStart(referenceDate)) ? referenceDate : weekStart(date);
    const checks = habit.weeks?.[legacyWeekKey(anchor)];
    return !!(checks && checks[(date.getDay() + 6) % 7]);
  }
  function streak(habit, today = new Date()) {
    let day = today;
    if (!isChecked(habit, day, today)) day = addDays(day, -1);
    let count = 0;
    while (count < 3660 && isChecked(habit, day, today)) { count++; day = addDays(day, -1); }
    return count;
  }
  function visibleTodos(todos, filter, query, sort, today = dateKey(new Date())) {
    const needle = query.trim().toLocaleLowerCase();
    const rank = { high: 0, normal: 1, low: 2 };
    return todos.map((task, index) => ({ task, index })).filter(({ task }) => {
      if (needle && !String(task.title || '').toLocaleLowerCase().includes(needle)) return false;
      if (filter === 'open') return !task.completed;
      if (filter === 'done') return !!task.completed;
      if (filter === 'today') return !task.completed && task.dueDate === today;
      if (filter === 'overdue') return !task.completed && !!task.dueDate && task.dueDate < today;
      return true;
    }).sort((a, b) => {
      if (sort === 'newest') return a.index - b.index;
      if (sort === 'priority') return (rank[a.task.priority] ?? 1) - (rank[b.task.priority] ?? 1) || a.index - b.index;
      return (a.task.dueDate || '9999-12-31').localeCompare(b.task.dueDate || '9999-12-31') || (rank[a.task.priority] ?? 1) - (rank[b.task.priority] ?? 1) || a.index - b.index;
    });
  }
  const timerDefaults = () => ({ phase: 'focus', duration: 1500, remaining: 1500, runningUntil: null, taskId: null, taskTitle: '', cycle: 0, settings: { focus: 25, shortBreak: 5, longBreak: 15 }, sessions: [] });
  function normalizeTimer(raw) {
    const timer = timerDefaults();
    if (!raw || typeof raw !== 'object') return timer;
    for (const key of ['focus', 'shortBreak', 'longBreak']) {
      const value = Number(raw.settings?.[key]);
      if (Number.isInteger(value) && value >= 1 && value <= (key === 'focus' ? 180 : 90)) timer.settings[key] = value;
    }
    timer.phase = ['focus', 'shortBreak', 'longBreak'].includes(raw.phase) ? raw.phase : 'focus';
    timer.duration = Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : timer.settings[timer.phase] * 60;
    timer.remaining = Number.isFinite(raw.remaining) ? Math.max(0, Math.min(raw.remaining, timer.duration)) : timer.duration;
    timer.runningUntil = Number.isFinite(raw.runningUntil) && raw.runningUntil > 0 ? raw.runningUntil : null;
    timer.taskId = typeof raw.taskId === 'string' ? raw.taskId : null;
    timer.taskTitle = typeof raw.taskTitle === 'string' ? raw.taskTitle : '';
    timer.cycle = Number.isInteger(raw.cycle) && raw.cycle >= 0 ? raw.cycle : 0;
    timer.sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(s => s && typeof s === 'object').slice(0, 500) : [];
    return timer;
  }
  const remainingSeconds = (timer, now = Date.now()) => timer.runningUntil ? Math.max(0, Math.ceil((timer.runningUntil - now) / 1000)) : timer.remaining;
  function finishTimer(timer, tasks, now = Date.now()) {
    if (!timer.runningUntil || timer.runningUntil > now) return null;
    const endedAt = timer.runningUntil;
    const phase = timer.phase;
    timer.runningUntil = null;
    if (phase === 'focus') {
      const task = tasks.find(item => item.id === timer.taskId);
      // 按计时结束时间结算一次；重开页面时不会重复累计，也不会自动开启下一轮。
      if (task) task.pomodoros = (Number(task.pomodoros) || 0) + 1;
      timer.sessions.unshift({ id: `p-${endedAt}-${Math.random().toString(36).slice(2, 8)}`, taskId: timer.taskId, taskTitle: task?.title || timer.taskTitle || '未关联任务', minutes: Math.round(timer.duration / 60), endedAt: new Date(endedAt).toISOString() });
      timer.sessions = timer.sessions.slice(0, 500);
      timer.cycle++;
      timer.phase = timer.cycle % 4 === 0 ? 'longBreak' : 'shortBreak';
    } else timer.phase = 'focus';
    timer.duration = timer.settings[timer.phase] * 60;
    timer.remaining = timer.duration;
    return phase;
  }
  root.taskHabitCore = { dateKey, fromKey, addDays, weekStart, legacyWeekKey, isChecked, streak, visibleTodos, timerDefaults, normalizeTimer, remainingSeconds, finishTimer };
  if (typeof module !== 'undefined') module.exports = root.taskHabitCore;
})(typeof window === 'undefined' ? globalThis : window);
