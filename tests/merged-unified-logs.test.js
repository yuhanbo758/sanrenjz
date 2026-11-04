const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

test('统一日志真实宿主：两类采集、同名筛选、实时更新、导出和配置保留', () => {
    const output = path.join(__dirname, '..', 'dist', 'unified-logs-validation');
    fs.mkdirSync(output, { recursive: true });
    const reportPath = path.join(output, 'report.json');
    fs.rmSync(reportPath, { force: true });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'merged-unified-logs-electron.cjs')], {
        cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 100000, maxBuffer: 4 * 1024 * 1024
    });
    fs.writeFileSync(path.join(output, 'console.log'), (result.stdout || '') + (result.stderr || ''), 'utf8');
    if (result.status !== 0) console.error((result.stdout || '').slice(-10000) + (result.stderr || '').slice(-10000));
    assert.equal(result.status, 0, `统一日志真实界面失败；${result.error || ''}`);
    assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).success, true, '子进程报告必须确认完成');
});
