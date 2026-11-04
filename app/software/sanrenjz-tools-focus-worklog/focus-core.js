// 专注数据与计时计算。保持纯函数，便于检查重载后的时间和旧记录迁移。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FocusCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const uid = () => `f-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const localDate = (value = Date.now()) => {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const defaults = () => ({
    version: 2, tasks: [], logs: [], settings: { focus: 25, shortBreak: 5, longBreak: 15, longEvery: 4 },
    timer: { phase: 'focus', remaining: 1500, runningUntil: null, taskId: null, taskTitle: '', project: '默认项目', duration: 1500, cycle: 0, interruptions: 0 }
  });
  const clamp = (n, min, max, fallback) => Number.isFinite(+n) && +n >= min && +n <= max ? Math.round(+n) : fallback;
  function normalize(raw, legacy = []) {
    const state = defaults();
    if (raw && raw.version === 2) {
      state.tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
      state.logs = Array.isArray(raw.logs) ? raw.logs : [];
      state.settings = { ...state.settings, ...(raw.settings || {}) };
      state.timer = { ...state.timer, ...(raw.timer || {}) };
    } else if (Array.isArray(legacy)) {
      state.logs = legacy.map(l => ({ id: uid(), taskId: null, taskTitle: '', project: String(l.project || '默认项目'), minutes: clamp(l.minutes, 1, 1440, 25), note: String(l.note || ''), date: /^\d{4}-\d\d-\d\d$/.test(l.date || '') ? l.date : localDate(), type: 'legacy' }));
    }
    for (const key of ['focus', 'shortBreak', 'longBreak', 'longEvery']) {
      const limit = key === 'longEvery' ? [2, 10] : key === 'focus' ? [1, 180] : [1, 90];
      state.settings[key] = clamp(state.settings[key], ...limit, defaults().settings[key]);
    }
    return state;
  }
  function remaining(timer, now = Date.now()) {
    return timer.runningUntil ? Math.max(0, Math.ceil((timer.runningUntil - now) / 1000)) : Math.max(0, timer.remaining);
  }
  function completePhase(state, now = Date.now()) {
    const t = state.timer;
    if (!t.runningUntil || t.runningUntil > now) return false;
    const endedAt = t.runningUntil;
    t.runningUntil = null;
    if (t.phase === 'focus') {
      const minutes = Math.round(t.duration / 60);
      state.logs.unshift({ id: uid(), taskId: t.taskId, taskTitle: t.taskTitle, project: t.project, minutes,
        note: t.interruptions ? `中断 ${t.interruptions} 次` : '', interruptions: t.interruptions, date: localDate(endedAt), endedAt: new Date(endedAt).toISOString(), type: 'pomodoro' });
      const task = state.tasks.find(x => x.id === t.taskId);
      if (task) task.actual = (task.actual || 0) + 1;
      t.cycle += 1;
      t.phase = t.cycle % state.settings.longEvery === 0 ? 'longBreak' : 'shortBreak';
    } else t.phase = 'focus';
    t.duration = 60 * state.settings[t.phase === 'focus' ? 'focus' : t.phase];
    t.remaining = t.duration;
    t.interruptions = 0;
    return true;
  }
  function summary(logs, today = localDate()) {
    const date = new Date(`${today}T12:00:00`);
    const weekday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - weekday);
    const weekStart = localDate(date);
    const inWeek = logs.filter(l => l.date >= weekStart && l.date <= today);
    const minutes = items => items.reduce((n, l) => n + Number(l.minutes || 0), 0);
    return { today: minutes(logs.filter(l => l.date === today)), week: minutes(inWeek), pomodoros: inWeek.filter(l => l.type === 'pomodoro').length, weekStart };
  }
  return { uid, localDate, defaults, normalize, clamp, remaining, completePhase, summary };
});
