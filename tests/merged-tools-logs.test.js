const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

test('效率插件真实日志采集：HTML控制台、生命周期与JS子进程完整输出', () => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const reportPath = path.resolve(__dirname, '../dist/merged-tools-logs-report.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.rmSync(reportPath, { force: true });
    const result = spawnSync(require('electron'), [path.join(__dirname, 'merged-tools-logs-electron.cjs')], { env, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 3 * 1024 * 1024 });
    const logPath = path.resolve(__dirname, '../dist/merged-tools-logs-console.log');
    fs.writeFileSync(logPath, (result.stdout || '') + (result.stderr || ''));
    if (result.status !== 0) console.error((result.stdout || '').slice(-10000) + (result.stderr || '').slice(-10000));
    assert.equal(result.status, 0, `真实采集验收失败：${logPath}；${result.error || ''}`);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.success, true);
    const relative = path.relative(os.tmpdir(), path.resolve(report.temporaryRoot));
    assert(relative.startsWith('sanrenjz-tools-logs-') && !relative.includes(path.sep), '仅清理本次明确创建的临时目录');
    fs.rmSync(report.temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
