const assert = require('node:assert/strict');
const core = require('../app/software/sanrenjz-tools-task-habit/task-habit-core');

assert.equal(core.dateKey(core.weekStart(new Date(2027, 0, 1))), '2026-12-28');
assert.equal(core.dateKey(core.addDays(new Date(2026, 11, 31), 1)), '2027-01-01');
const today = new Date(2026, 8, 27, 12);
const habit = { weeks: { [core.legacyWeekKey(today)]: [false, false, false, false, false, false, true] } };
assert.equal(core.isChecked(habit, today, today), true);
habit.days = { '2026-09-27': false, '2026-09-26': true };
assert.equal(core.isChecked(habit, today, today), false);
assert.equal(core.streak(habit, today), 1);
const tasks = [
  { title: '今日报告', dueDate: '2026-09-27', priority: 'normal', completed: false },
  { title: '过期事项', dueDate: '2026-09-26', priority: 'high', completed: false },
  { title: '已完成', dueDate: '2026-09-27', priority: 'low', completed: true }
];
assert.deepEqual(core.visibleTodos(tasks, 'overdue', '', 'due', '2026-09-27').map(row => row.index), [1]);
assert.deepEqual(core.visibleTodos(tasks, 'today', '', 'due', '2026-09-27').map(row => row.index), [0]);
assert.deepEqual(core.visibleTodos(tasks, 'all', '', 'priority', '2026-09-27').map(row => row.index), [1, 0, 2]);
assert.deepEqual(core.visibleTodos(tasks, 'all', '', 'newest', '2026-09-27').map(row => row.index), [0, 1, 2]);
const timer = core.normalizeTimer({ ...core.timerDefaults(), taskId: 'task-1', taskTitle: '写报告', runningUntil: 10000 });
const focusTasks = [{ id: 'task-1', title: '写报告', pomodoros: 0 }];
assert.equal(core.remainingSeconds(timer, 9000), 1);
assert.equal(core.finishTimer(timer, focusTasks, 9999), null);
assert.equal(core.finishTimer(timer, focusTasks, 10000), 'focus');
assert.equal(core.finishTimer(timer, focusTasks, 10000), null);
assert.equal(focusTasks[0].pomodoros, 1);
assert.equal(timer.sessions[0].taskTitle, '写报告');
assert.equal(timer.phase, 'shortBreak');
timer.cycle = 3; timer.phase = 'focus'; timer.runningUntil = 20000;
assert.equal(core.finishTimer(timer, focusTasks, 20000), 'focus');
assert.equal(timer.phase, 'longBreak');
console.log('task-habit core tests passed');
