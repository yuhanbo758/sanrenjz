const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const processes = new Map();
const MAX_LOGS = 400;

function snapshot(id) {
  const item = processes.get(id);
  return item ? { running: item.running, pid: item.child?.pid || null, exitCode: item.exitCode, logs: [...item.logs] } : { running: false, pid: null, exitCode: null, logs: [] };
}

function append(item, text, kind) {
  for (const line of String(text).split(/\r?\n/)) {
    if (line) item.logs.push({ text: line.slice(0, 4000), kind, time: new Date().toLocaleTimeString() });
  }
  if (item.logs.length > MAX_LOGS) item.logs.splice(0, item.logs.length - MAX_LOGS);
}

function start(project) {
  const id = String(project?.id || '');
  const directory = String(project?.directory || '').trim();
  const command = String(project?.command || '').trim();
  if (!id || !directory || !command || command.length > 2000) throw new Error('请填写有效的项目目录和启动命令');
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('项目目录不存在');
  if (processes.get(id)?.running) throw new Error('此项目已在运行');

  // 命令由用户主动保存并点击运行；shell 负责 Windows 引号与 npm 脚本解析。
  const child = spawn(command, { cwd: directory, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const item = { child, running: true, exitCode: null, logs: [] };
  processes.set(id, item);
  append(item, `> ${command}`, 'command');
  child.stdout.on('data', data => append(item, data.toString('utf8'), 'output'));
  child.stderr.on('data', data => append(item, data.toString('utf8'), 'error'));
  child.on('error', error => { item.running = false; append(item, error.message, 'error'); });
  child.on('exit', code => { item.running = false; item.exitCode = code; append(item, `进程已退出（代码 ${code ?? '未知'}）`, code === 0 ? 'info' : 'error'); });
  return snapshot(id);
}

function stop(id) {
  const item = processes.get(String(id));
  if (!item?.running) return snapshot(String(id));
  if (process.platform === 'win32' && item.child.pid) {
    // cmd/npm 会再创建子进程；只结束外层 shell 会留下实际服务。
    const result = spawnSync('taskkill', ['/PID', String(item.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error('停止进程失败，请检查进程状态');
  } else item.child.kill('SIGTERM');
  item.running = false;
  append(item, '已请求停止进程', 'info');
  return snapshot(String(id));
}

function stopAll() {
  for (const [id, item] of processes) if (item.running) {
    try { stop(id); } catch (_) { item.child.kill(); }
  }
}

function clearLogs(id) {
  const item = processes.get(String(id));
  if (item) item.logs = [];
  return snapshot(String(id));
}

module.exports = { start, stop, stopAll, snapshot, clearLogs };
