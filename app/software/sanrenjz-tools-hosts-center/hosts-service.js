const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

function getHostsPath() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts';
}

function inspect(text) {
  const errors = [], warnings = [], domains = new Map();
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    const body = line.split('#', 1)[0].trim();
    if (!body) return;
    const parts = body.split(/\s+/);
    if (parts.length < 2 || net.isIP(parts[0]) === 0) {
      errors.push({ line: index + 1, message: '需要以有效 IP 开头，后跟至少一个主机名' });
      return;
    }
    for (const host of parts.slice(1)) {
      if (!/^[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?$/.test(host) || host.includes('..')) {
        errors.push({ line: index + 1, message: `主机名格式无效：${host}` });
        continue;
      }
      const key = host.toLowerCase();
      if (domains.has(key)) warnings.push({ line: index + 1, message: `${host} 与第 ${domains.get(key)} 行重复，解析结果可能与预期不同` });
      else domains.set(key, index + 1);
    }
  });
  return { errors, warnings, entries: domains.size, lines: lines.length };
}

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function createHostsService({ hostsPath = getHostsPath(), backupDir }) {
  if (!backupDir) throw new Error('缺少备份目录');
  async function read() {
    const bytes = await fs.readFile(hostsPath);
    // 不猜测本机代码页；遇到非 UTF-8 时拒绝编辑，避免保存时损坏原始注释。
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    return { hostsPath, content, revision: hash(bytes), bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), eol: content.includes('\r\n') ? '\r\n' : '\n' };
  }
  async function write({ content, revision, bom, eol }) {
    if (typeof content !== 'string' || !revision) throw new Error('请先读取当前 Hosts');
    const report = inspect(content);
    if (report.errors.length) throw new Error(`第 ${report.errors[0].line} 行：${report.errors[0].message}`);
    const current = await fs.readFile(hostsPath);
    if (hash(current) !== revision) throw new Error('Hosts 已被其他程序修改，请先复制草稿，再重新读取当前文件');
    const normalized = content.replace(/\r\n|\r|\n/g, eol === '\r\n' ? '\r\n' : '\n');
    const next = Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(normalized, 'utf8')]);
    if (next.equals(current)) return { unchanged: true, revision };
    await fs.mkdir(backupDir, { recursive: true });
    const backup = path.join(backupDir, `hosts-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.bak`);
    await fs.writeFile(backup, current, { flag: 'wx' });
    try { await fs.writeFile(hostsPath, next); }
    catch (error) { throw new Error(`写入失败（可能需要管理员权限）；原文件备份于 ${backup}。${error.message}`); }
    const actual = await fs.readFile(hostsPath);
    if (!actual.equals(next)) throw new Error(`写入后校验失败；原文件备份于 ${backup}`);
    return { backup, revision: hash(actual), report };
  }
  return { read, write };
}

module.exports = { createHostsService, inspect };
