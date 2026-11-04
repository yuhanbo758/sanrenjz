const assert = require('node:assert/strict');
const core = require('../app/software/sanrenjz-tools-focus-worklog/focus-core');

const migrated = core.normalize(null, [{ project: '项目A', minutes: 30, note: '旧记录', date: '2026-09-27' }]);
assert.equal(migrated.logs.length, 1);
assert.equal(migrated.logs[0].project, '项目A');
assert.equal(migrated.logs[0].type, 'legacy');

const state = core.defaults();
state.tasks.push({ id: 'one', title: '写报告', project: '甲', estimate: 2, actual: 0 });
Object.assign(state.timer, { taskId: 'one', taskTitle: '写报告', project: '甲', duration: 1500, remaining: 1500, runningUntil: Date.UTC(2026, 8, 27, 3) });
assert.equal(core.remaining(state.timer, Date.UTC(2026, 8, 27, 3) - 61000), 61);
assert.equal(core.completePhase(state, Date.UTC(2026, 8, 27, 3) - 1), false);
assert.equal(core.completePhase(state, Date.UTC(2026, 8, 27, 3)), true);
assert.equal(state.logs.length, 1);
assert.equal(state.logs[0].taskId, 'one');
assert.equal(state.tasks[0].actual, 1);
assert.equal(state.timer.phase, 'shortBreak');
assert.equal(core.completePhase(state, Date.UTC(2026, 8, 27, 3) + 1), false);
state.timer.runningUntil = Date.UTC(2026, 8, 27, 4);
assert.equal(core.completePhase(state, Date.UTC(2026, 8, 27, 4)), true);
assert.equal(state.timer.phase, 'focus');
state.timer.cycle = 3;
state.timer.runningUntil = Date.UTC(2026, 8, 27, 5);
assert.equal(core.completePhase(state, Date.UTC(2026, 8, 27, 5)), true);
assert.equal(state.timer.phase, 'longBreak');
assert.equal(core.summary(state.logs, core.localDate(Date.UTC(2026, 8, 27, 5))).pomodoros, 2);
console.log('focus-worklog logic tests passed');
