const fs = require('fs');
const path = require('path');

const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;

async function listPromptFiles(directory) {
  if (!directory) return [];
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const names = entries.filter(entry => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, MAX_FILES);
  const prompts = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const raw = (await fs.promises.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    const heading = /^#\s+(.+)\s*$/m.exec(raw);
    const title = heading ? heading[1].trim() : path.parse(name).name;
    const body = heading ? raw.replace(/^#\s+.+(?:\r?\n)?/m, '').trim() : raw.trim();
    prompts.push({ id: `file:${name}`, title, body, source: name });
  }
  return prompts;
}

module.exports = { listPromptFiles };
