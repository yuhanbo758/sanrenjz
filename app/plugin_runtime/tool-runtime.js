const { ipcRenderer, clipboard, nativeImage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const { execFile, spawn } = require('child_process');
// 共享内核只保存当前窗口的插件身份；具体工具由每次调用的 toolId 决定。
const profile = { id: '', name: '', kind: '' };

const TOOL_KINDS = {
  'json-workbench': 'text', 'config-converter': 'text', 'xml-workbench': 'text',
  'codec-assistant': 'text', 'hash-hmac': 'text', 'id-generator': 'text',
  'time-converter': 'text', 'regex-lab': 'text', 'jwt-inspector': 'text',
  'text-diff': 'text', 'csv-table': 'text', 'line-processor': 'text',
  'calculation-paper': 'text', 'unit-converter': 'text', 'date-world-clock': 'text',
  'color-workbench': 'text', 'svg-workbench': 'text',
  'image-compressor': 'image', 'image-converter': 'image', 'image-resizer': 'image',
  'image-watermark': 'image', 'image-collage': 'image', 'screenshot-beautifier': 'image',
  'palette-extractor': 'image', 'qr-barcode': 'image',
  'batch-renamer': 'file', 'file-content-search': 'file', 'folder-compare': 'file',
  'text-encoding': 'file', 'directory-tree': 'file', 'file-checksum': 'file',
  'pdf-organizer': 'file', 'archive-tool': 'file',
  'markdown-notes': 'system', 'floating-notes': 'system', 'todo-list': 'system',
  'pomodoro-focus': 'system', 'worklog': 'system', 'bookmark-launcher': 'system',
  'habit-tracker': 'system', 'hosts-manager': 'system', 'lan-transfer': 'system',
  'image-pinboard': 'system', 'project-launcher': 'system'
};

let lanServer = null;
let projectProcess = null;

/** 统一把错误转换为可直接显示的中文消息，避免把 Electron/Node 对象泄露到页面。 */
function safeError(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function ensureArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function walkDirectory(root, options = {}) {
  const maxFiles = Number(options.maxFiles || 20000);
  const rows = [];
  const pending = [root];
  while (pending.length && rows.length < maxFiles) {
    const current = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) {
        let stat;
        try { stat = fs.statSync(fullPath); } catch (_) { continue; }
        rows.push({
          path: fullPath,
          relativePath: path.relative(root, fullPath),
          name: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          extension: path.extname(entry.name).toLowerCase()
        });
        if (rows.length >= maxFiles) break;
      }
    }
  }
  return rows;
}

function hashFile(filePath, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest('hex');
}

function queryJson(value, query) {
  if (!query.trim()) return value;
  const parts = query.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  return parts.reduce((current, key) => current == null ? undefined : current[key], value);
}

function parseProperties(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const index = line.search(/[:=]/);
    const key = index < 0 ? line : line.slice(0, index).trim();
    result[key] = index < 0 ? '' : line.slice(index + 1).trim();
  }
  return result;
}

function parseSimpleYaml(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const match = rawLine.match(/^\s*([^:#]+):\s*(.*)$/);
    if (match) result[match[1].trim()] = parseScalar(match[2]);
  }
  return result;
}

function parseSimpleToml(text) {
  const result = {};
  let current = result;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = result;
      for (const part of section[1].split('.')) current = current[part] ||= {};
      continue;
    }
    const match = line.match(/^([^=]+)=\s*(.*)$/);
    if (match) current[match[1].trim()] = parseScalar(match[2]);
  }
  return result;
}

function parseScalar(value) {
  const text = String(value).trim();
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function toYaml(value, indent = 0) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return Object.entries(value).map(([key, item]) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return `${' '.repeat(indent)}${key}:\n${toYaml(item, indent + 2)}`;
    return `${' '.repeat(indent)}${key}: ${Array.isArray(item) ? JSON.stringify(item) : String(item)}`;
  }).join('\n');
}

function toToml(value, prefix = '') {
  const scalar = [];
  const sections = [];
  for (const [key, item] of Object.entries(value || {})) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const full = prefix ? `${prefix}.${key}` : key;
      sections.push(`[${full}]\n${toToml(item, full)}`);
    } else scalar.push(`${key} = ${JSON.stringify(item)}`);
  }
  return [...scalar, ...sections].filter(Boolean).join('\n\n');
}

function formatXml(xml) {
  const compact = xml.replace(/>\s+</g, '><').trim();
  let depth = 0;
  return compact.replace(/(<[^>]+>)/g, '$1\n').split('\n').filter(Boolean).map(token => {
    if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
    const line = `${'  '.repeat(depth)}${token}`;
    if (/^<[^!?/][^>]*[^/]>/i.test(token) && !/<\/[^>]+>$/.test(token)) depth += 1;
    return line;
  }).join('\n');
}

function decodeJwtPart(part) {
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
}

function textDiff(left, right) {
  const a = left.split('\n');
  const b = right.split('\n');
  const max = Math.max(a.length, b.length);
  const output = [];
  for (let index = 0; index < max; index += 1) {
    if (a[index] === b[index]) output.push(`  ${a[index] ?? ''}`);
    else {
      if (a[index] !== undefined) output.push(`- ${a[index]}`);
      if (b[index] !== undefined) output.push(`+ ${b[index]}`);
    }
  }
  return output.join('\n');
}

function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function runPowerShell(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...extraEnv } },
      (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()));
  });
}

async function runTextTask(input, options) {
  switch (profile.id) {
    case 'json-workbench': {
      const value = JSON.parse(input);
      const queried = queryJson(value, options.query || '');
      return options.action === 'minify' ? JSON.stringify(queried) : JSON.stringify(queried, null, 2);
    }
    case 'config-converter': {
      const source = options.source || 'json';
      const target = options.target || 'yaml';
      const value = source === 'json' ? JSON.parse(input) : source === 'properties' ? parseProperties(input) : source === 'toml' ? parseSimpleToml(input) : parseSimpleYaml(input);
      if (target === 'json') return JSON.stringify(value, null, 2);
      if (target === 'properties') return Object.entries(value).map(([key, item]) => `${key}=${typeof item === 'object' ? JSON.stringify(item) : item}`).join('\n');
      if (target === 'toml') return toToml(value);
      return toYaml(value);
    }
    case 'xml-workbench': return options.action === 'minify' ? input.replace(/>\s+</g, '><').trim() : formatXml(input);
    case 'codec-assistant': {
      const action = options.action || 'base64-encode';
      if (action === 'base64-encode') return Buffer.from(input, 'utf8').toString('base64');
      if (action === 'base64-decode') return Buffer.from(input, 'base64').toString('utf8');
      if (action === 'url-encode') return encodeURIComponent(input);
      if (action === 'url-decode') return decodeURIComponent(input);
      if (action === 'hex-encode') return Buffer.from(input, 'utf8').toString('hex');
      if (action === 'hex-decode') return Buffer.from(input.replace(/\s+/g, ''), 'hex').toString('utf8');
      if (action === 'unicode-encode') return [...input].map(char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`).join('');
      if (action === 'unicode-decode') return input.replace(/\\u([\da-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
      if (action === 'html-encode') return input.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      return input.replace(/&(amp|lt|gt|quot|#39);/g, token => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[token]));
    }
    case 'hash-hmac': {
      const algorithm = options.algorithm || 'sha256';
      return options.key ? crypto.createHmac(algorithm, options.key).update(input).digest(options.encoding || 'hex') : crypto.createHash(algorithm).update(input).digest(options.encoding || 'hex');
    }
    case 'id-generator': {
      const count = Math.min(1000, Math.max(1, Number(options.count || 1)));
      const length = Math.min(128, Math.max(4, Number(options.length || 21)));
      const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';
      return Array.from({ length: count }, () => options.type === 'uuid' ? crypto.randomUUID() : Array.from(crypto.randomBytes(length), byte => alphabet[byte % alphabet.length]).join('')).join('\n');
    }
    case 'time-converter': {
      const date = input.trim() ? (/^\d{10,13}$/.test(input.trim()) ? new Date(Number(input.trim()) * (input.trim().length === 10 ? 1000 : 1)) : new Date(input.trim())) : new Date();
      if (Number.isNaN(date.getTime())) throw new Error('无法识别输入的日期或时间戳');
      return JSON.stringify({ iso: date.toISOString(), local: date.toLocaleString('zh-CN', { timeZone: options.timeZone || undefined }), timestampSeconds: Math.floor(date.getTime() / 1000), timestampMilliseconds: date.getTime() }, null, 2);
    }
    case 'regex-lab': {
      const expression = new RegExp(options.pattern || '', options.flags || 'g');
      if (options.replacement !== undefined && options.replacement !== '') return input.replace(expression, options.replacement);
      const matcher = expression.global ? expression : new RegExp(expression.source, `${expression.flags}g`);
      return JSON.stringify([...input.matchAll(matcher)].map(match => ({ value: match[0], index: match.index, groups: match.slice(1), namedGroups: match.groups || {} })), null, 2);
    }
    case 'jwt-inspector': {
      const parts = input.trim().split('.');
      if (parts.length !== 3) throw new Error('JWT 必须包含 header.payload.signature 三段');
      const header = decodeJwtPart(parts[0]);
      const payload = decodeJwtPart(parts[1]);
      let verified = null;
      if (options.secret) {
        const algorithm = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }[header.alg];
        if (!algorithm) throw new Error('当前仅支持 HS256、HS384、HS512 本地验证');
        const signature = Buffer.from(crypto.createHmac(algorithm, options.secret).update(`${parts[0]}.${parts[1]}`).digest('base64url'));
        const provided = Buffer.from(parts[2]);
        verified = signature.length === provided.length && crypto.timingSafeEqual(signature, provided);
      }
      return JSON.stringify({ header, payload, expired: payload.exp ? Date.now() >= payload.exp * 1000 : null, verified }, null, 2);
    }
    case 'text-diff': return textDiff(input, options.rightText || '');
    case 'csv-table': {
      const rows = parseCsv(input, options.delimiter || ',');
      const sorted = options.sortColumn === '' || options.sortColumn == null ? rows : [rows[0], ...rows.slice(1).sort((a, b) => String(a[Number(options.sortColumn)] || '').localeCompare(String(b[Number(options.sortColumn)] || ''), 'zh-CN'))];
      if (options.action === 'json') {
        const [headers = [], ...data] = sorted;
        return JSON.stringify(data.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || '']))), null, 2);
      }
      return sorted.map(row => row.map(field => /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field).join(options.delimiter || ',')).join('\n');
    }
    case 'line-processor': {
      let lines = input.split(/\r?\n/);
      if (options.filter) lines = lines.filter(line => line.includes(options.filter));
      if (options.unique) lines = [...new Set(lines)];
      if (options.sort) lines.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
      return lines.map((line, index) => `${options.number ? `${index + 1}. ` : ''}${options.prefix || ''}${line}${options.suffix || ''}`).join('\n');
    }
    case 'calculation-paper': {
      const variables = Object.create(null); const rows = [];
      for (const raw of input.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        const assign = raw.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/); const expression = assign ? assign[2] : raw;
        if (!/^[\d\s+\-*/%().A-Za-z_]+$/.test(expression)) throw new Error(`不支持的表达式：${raw}`);
        const names = Object.keys(variables); const value = Function(...names, `'use strict';return (${expression})`)(...names.map(name => variables[name]));
        if (!Number.isFinite(Number(value))) throw new Error(`计算结果无效：${raw}`);
        if (assign) variables[assign[1]] = Number(value); rows.push(`${raw} = ${value}`);
      }
      return rows.join('\n');
    }
    case 'unit-converter': {
      const groups = { length:{mm:.001,cm:.01,m:1,km:1000}, weight:{g:.001,kg:1,t:1000}, area:{m2:1,km2:1e6,mu:666.6666667}, speed:{'m/s':1,'km/h':1/3.6} };
      const value=Number(input||options.value); if(!Number.isFinite(value))throw new Error('请输入有效数字');
      if(options.unitType==='temperature'){const c=options.fromUnit==='f'?(value-32)*5/9:options.fromUnit==='k'?value-273.15:value;return String(options.toUnit==='f'?c*9/5+32:options.toUnit==='k'?c+273.15:c)}
      const group=groups[options.unitType||'length'];if(!group?.[options.fromUnit]||!group?.[options.toUnit])throw new Error('请选择有效单位');return String(value*group[options.fromUnit]/group[options.toUnit]);
    }
    case 'date-world-clock': { const date=new Date(input||Date.now());if(Number.isNaN(date.getTime()))throw new Error('日期格式无效');date.setDate(date.getDate()+Number(options.days||0));return JSON.stringify({date:date.toISOString().slice(0,10),local:date.toLocaleString('zh-CN'),utc:date.toUTCString(),weekDay:date.toLocaleDateString('zh-CN',{weekday:'long'})},null,2); }
    case 'color-workbench': { const hex=(input.trim()||'#6750a4').replace('#','');if(!/^[0-9a-f]{6}$/i.test(hex))throw new Error('请输入 6 位 HEX 颜色');const rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16));const lum=rgb.map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);return JSON.stringify({hex:'#'+hex.toUpperCase(),rgb:`rgb(${rgb.join(', ')})`,contrastWithWhite:(1.05/(lum+.05)).toFixed(2),contrastWithBlack:((lum+.05)/.05).toFixed(2)},null,2); }
    case 'svg-workbench': return options.action==='minify'?input.replace(/>\s+</g,'><').replace(/\s{2,}/g,' ').trim():input.replace(/>\s*</g,'>\n<');
    default: throw new Error(`文本内核尚未注册任务：${profile.id}`);
  }
}

async function runImageTask(input, options, execute) {
  if (profile.id === 'qr-barcode') return generateQr(input || options.text || '', options.size || 480);
  const files = ensureArray(options.files).filter(Boolean); const first = files[0];
  if (!first) throw new Error('请先选择图片');
  const image = nativeImage.createFromPath(first); if (image.isEmpty()) throw new Error('无法读取所选图片');
  const size = image.getSize();
  if (profile.id === 'palette-extractor') {
    const bitmap=image.resize({width:48,height:48}).toBitmap();const counts=new Map();
    for(let i=0;i<bitmap.length;i+=16){const key=[bitmap[i+2],bitmap[i+1],bitmap[i]].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();counts.set(key,(counts.get(key)||0)+1)}
    return [...counts].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([hex,count])=>({hex:'#'+hex,count}));
  }
  const result={tool:profile.id,files:files.length,width:size.width,height:size.height,source:first};
  if(execute&&options.output){let output=image;if(profile.id==='image-resizer'&&options.width)output=image.resize({width:Number(options.width),height:Number(options.height)||undefined,quality:'best'});const ext=path.extname(options.output).toLowerCase();fs.writeFileSync(options.output,ext==='.jpg'||ext==='.jpeg'?output.toJPEG(Number(options.quality||88)):output.toPNG());result.output=options.output;result.bytes=fs.statSync(options.output).size;}
  return result;
}

async function runFileTask(input, options, execute) {
  const files = ensureArray(options.files).filter(Boolean);
  switch (profile.id) {
    case 'batch-renamer': {
      if (!options.directory) throw new Error('请先选择目录');
      const entries = fs.readdirSync(options.directory, { withFileTypes: true }).filter(item => item.isFile());
      const start = Number(options.start || 1);
      const plan = entries.map((entry, index) => {
        const ext = path.extname(entry.name); const base = path.basename(entry.name, ext);
        const replaced = options.find
          ? options.regex
            ? base.replace(new RegExp(options.find, 'g'), options.replace || '')
            : base.split(options.find).join(options.replace || '')
          : base;
        const next = `${options.prefix || ''}${options.number ? String(start + index).padStart(Number(options.padding || 2), '0') + '-' : ''}${replaced}${options.suffix || ''}${ext}`;
        return { from: path.join(options.directory, entry.name), to: path.join(options.directory, next), before: entry.name, after: next };
      }).filter(item => item.from !== item.to);
      const destinations = new Set();
      for (const item of plan) {
        if (destinations.has(item.to) || (fs.existsSync(item.to) && !plan.some(row => row.from === item.to))) throw new Error(`目标文件冲突：${item.after}`);
        destinations.add(item.to);
      }
      if (execute) {
        const temporary = plan.map((item, index) => ({ ...item, temp: `${item.from}.sanrenjz-${Date.now()}-${index}.tmp` }));
        temporary.forEach(item => fs.renameSync(item.from, item.temp));
        try { temporary.forEach(item => fs.renameSync(item.temp, item.to)); }
        catch (error) { temporary.filter(item => fs.existsSync(item.temp)).forEach(item => fs.renameSync(item.temp, item.from)); throw error; }
      }
      return plan;
    }
    case 'file-content-search': {
      if (!options.directory || !options.query) throw new Error('请选择目录并输入搜索内容');
      const extensions = String(options.extensions || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
      const matches = [];
      for (const file of walkDirectory(options.directory, { maxFiles: 20000 })) {
        if (extensions.length && !extensions.includes(file.extension.replace('.', ''))) continue;
        if (file.size > Number(options.maxSizeMb || 5) * 1024 * 1024) continue;
        let text; try { text = fs.readFileSync(file.path, 'utf8'); } catch (_) { continue; }
        text.split(/\r?\n/).forEach((line, index) => { if (line.includes(options.query)) matches.push({ path: file.path, line: index + 1, text: line.trim().slice(0, 300) }); });
        if (matches.length >= 5000) break;
      }
      return matches;
    }
    case 'folder-compare': {
      if (!options.directoryA || !options.directoryB) throw new Error('请选择两个需要比较的目录');
      const left = new Map(walkDirectory(options.directoryA).map(item => [item.relativePath, item]));
      const right = new Map(walkDirectory(options.directoryB).map(item => [item.relativePath, item]));
      return [...new Set([...left.keys(), ...right.keys()])].sort().map(relativePath => {
        const a = left.get(relativePath); const b = right.get(relativePath);
        if (!a) return { relativePath, status: '仅右侧' };
        if (!b) return { relativePath, status: '仅左侧' };
        const same = options.hash ? hashFile(a.path) === hashFile(b.path) : a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000;
        return { relativePath, status: same ? '相同' : '不同', leftSize: a.size, rightSize: b.size };
      });
    }
    case 'text-encoding': {
      if (!files.length) throw new Error('请选择文本文件');
      const iconv = require('iconv-lite');
      const results = [];
      for (const filePath of files) {
        const source = fs.readFileSync(filePath);
        let text = iconv.decode(source, options.sourceEncoding || 'utf8');
        if (options.newline === 'lf') text = text.replace(/\r\n?/g, '\n');
        if (options.newline === 'crlf') text = text.replace(/\r?\n/g, '\r\n');
        const output = `${filePath}${options.suffix || '.converted.txt'}`;
        if (execute) fs.writeFileSync(output, iconv.encode(text, options.targetEncoding || 'utf8'));
        results.push({ source: filePath, output, characters: text.length });
      }
      return results;
    }
    case 'directory-tree': {
      if (!options.directory) throw new Error('请选择目录');
      const filesInTree = walkDirectory(options.directory);
      if (options.format === 'json') return JSON.stringify(filesInTree.map(item => item.relativePath), null, 2);
      return filesInTree.map(item => `${options.format === 'markdown' ? '- ' : ''}${item.relativePath}`).join('\n');
    }
    case 'file-checksum': {
      if (!files.length) throw new Error('请选择文件');
      return files.map(filePath => ({ file: filePath, sha256: hashFile(filePath) }));
    }
    case 'pdf-organizer': {
      if (!files.length) throw new Error('请选择 PDF 文件');
      const { PDFDocument, degrees } = require('pdf-lib');
      const output = await PDFDocument.create();
      for (const filePath of files) {
        const source = await PDFDocument.load(fs.readFileSync(filePath));
        const indexes = source.getPageIndices();
        const pages = await output.copyPages(source, indexes);
        pages.forEach(page => { if (Number(options.rotation || 0)) page.setRotation(degrees(Number(options.rotation))); output.addPage(page); });
      }
      const bytes = await output.save();
      if (execute) {
        const target = options.output || path.join(path.dirname(files[0]), 'PDF页面整理结果.pdf');
        fs.writeFileSync(target, bytes);
        return { output: target, pages: output.getPageCount(), bytes: bytes.length };
      }
      return { pages: output.getPageCount(), bytes: bytes.length, hint: '预览完成，点击开始处理后写入文件' };
    }
    case 'archive-tool': {
      const fflate = require('fflate');
      if (options.action === 'create') {
        if (!files.length) throw new Error('请选择需要压缩的文件');
        const names = files.map(filePath => path.basename(filePath));
        const duplicate = names.find((name, index) => names.indexOf(name) !== index);
        if (duplicate) throw new Error(`存在同名文件，无法安全创建压缩包：${duplicate}`);
        const data = Object.fromEntries(files.map((filePath, index) => [names[index], new Uint8Array(fs.readFileSync(filePath))]));
        const zipped = fflate.zipSync(data, { level: Number(options.level || 6) });
        const target = options.output || path.join(path.dirname(files[0]), '三人聚智压缩包.zip');
        if (execute) fs.writeFileSync(target, zipped);
        return { output: target, files: files.length, bytes: zipped.length };
      }
      if (!files[0]) throw new Error('请选择 ZIP 文件');
      const entries = fflate.unzipSync(new Uint8Array(fs.readFileSync(files[0])));
      const names = Object.keys(entries);
      if (execute && options.outputDirectory) {
        for (const [name, bytes] of Object.entries(entries)) {
          const safeTarget = path.resolve(options.outputDirectory, name);
          const safeRoot = `${path.resolve(options.outputDirectory)}${path.sep}`;
          if (!safeTarget.startsWith(safeRoot)) throw new Error(`压缩包包含不安全路径：${name}`);
          fs.mkdirSync(path.dirname(safeTarget), { recursive: true });
          fs.writeFileSync(safeTarget, bytes);
        }
      }
      return names.map(name => ({ name, bytes: entries[name].length }));
    }
    default: return runTextTask(input, options);
  }
}

async function runSystemTask(input, options, execute) {
  switch (profile.id) {
    case 'local-file-search': {
      if (!options.query) throw new Error('请输入文件名关键字');
      if (process.platform === 'win32') {
        try {
          const stdout = await new Promise((resolve, reject) => execFile('es.exe', ['-n', '500', options.query], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, out) => error ? reject(error) : resolve(out)));
          return stdout.split(/\r?\n/).filter(Boolean).map(filePath => ({ path: filePath, source: 'Everything' }));
        } catch (_) { /* 未安装 Everything 时自动使用目录扫描。 */ }
      }
      if (!options.directory) throw new Error('未检测到 Everything，请选择回退搜索目录');
      return walkDirectory(options.directory).filter(item => item.name.toLowerCase().includes(options.query.toLowerCase())).slice(0, 1000);
    }
    case 'disk-analyzer': {
      if (!options.directory) throw new Error('请选择需要分析的目录');
      const files = walkDirectory(options.directory, { maxFiles: 100000 });
      const extensions = {};
      let total = 0;
      files.forEach(file => { total += file.size; extensions[file.extension || '[无扩展名]'] = (extensions[file.extension || '[无扩展名]'] || 0) + file.size; });
      return { totalBytes: total, fileCount: files.length, largestFiles: files.sort((a, b) => b.size - a.size).slice(0, 100), extensionBytes: extensions };
    }
    case 'process-monitor': {
      const rows = process.platform === 'win32'
        ? JSON.parse((await runPowerShell("Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path | ConvertTo-Json -Compress")) || '[]')
        : [];
      if (execute && options.pid) {
        const pid = Number(options.pid);
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('无效或受保护的进程 ID');
        process.kill(pid);
        return { stopped: pid };
      }
      return ensureArray(rows).sort((a, b) => Number(b.WorkingSet64 || 0) - Number(a.WorkingSet64 || 0));
    }
    case 'port-inspector': {
      if (process.platform !== 'win32') return { message: '当前首版端口详情在 Windows 上完整支持。' };
      const output = await runPowerShell("Get-NetTCPConnection -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | Sort-Object LocalPort | ConvertTo-Json -Compress");
      return ensureArray(JSON.parse(output || '[]'));
    }
    case 'environment-manager': {
      if (execute && options.name) {
        if (!/^[A-Za-z_][A-Za-z0-9_()]*$/.test(options.name)) throw new Error('环境变量名称格式不正确');
        if (process.platform === 'win32') {
          const previous = await runPowerShell("[Environment]::GetEnvironmentVariable($env:SANRENJZ_ENV_NAME, 'User')", { SANRENJZ_ENV_NAME: options.name });
          await runPowerShell("[Environment]::SetEnvironmentVariable($env:SANRENJZ_ENV_NAME, $env:SANRENJZ_ENV_VALUE, 'User')", { SANRENJZ_ENV_NAME: options.name, SANRENJZ_ENV_VALUE: String(options.value || '') });
          return { updated: options.name, previous, current: String(options.value || ''), restoreHint: '把原值重新填入并执行即可恢复' };
        }
        else throw new Error('首版环境变量写入仅支持 Windows 用户变量');
      }
      if (process.platform === 'win32') {
        const output = await runPowerShell("[Environment]::GetEnvironmentVariables('User').GetEnumerator() | Sort-Object Key | Select-Object Key,Value | ConvertTo-Json -Compress");
        return ensureArray(JSON.parse(output || '[]'));
      }
      return Object.entries(process.env).sort().map(([Key, Value]) => ({ Key, Value }));
    }
    case 'hosts-manager': {
      const hostsPath = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts') : '/etc/hosts';
      if (execute) {
        const backup = `${hostsPath}.sanrenjz-backup-${Date.now()}`;
        fs.copyFileSync(hostsPath, backup);
        try { fs.writeFileSync(hostsPath, String(input || ''), 'utf8'); }
        catch (error) { throw new Error(`写入失败，通常需要管理员权限。备份位置：${backup}。${error.message}`); }
        return { hostsPath, backup };
      }
      return { hostsPath, content: fs.readFileSync(hostsPath, 'utf8') };
    }
    case 'lan-transfer': return handleLanTransfer(options, execute);
    case 'project-launcher': return handleProject(options, execute);
    case 'markdown-notes': case 'floating-notes': return { type:profile.id,title:options.title||'',content:input,updatedAt:new Date().toISOString() };
    case 'todo-list': return { title:options.title||input,priority:options.priority||'normal',dueDate:options.dueDate||'',completed:Boolean(options.completed) };
    case 'habit-tracker': return { name:options.title||input,date:options.date||new Date().toISOString().slice(0,10),checked:options.checked!==false };
    case 'pomodoro-focus': return { focusMinutes:Number(options.focusMinutes||25),breakMinutes:Number(options.breakMinutes||5),started:execute };
    case 'worklog': return { project:options.title||'默认项目',minutes:Number(options.minutes||0),note:input,date:options.date||new Date().toISOString().slice(0,10) };
    case 'bookmark-launcher': return { title:options.title||input,url:options.url||input,opened:false };
    case 'image-pinboard': return { hasImage:Boolean(options.dataUrl),scale:Number(options.scale||1),rotation:Number(options.rotation||0),opacity:Number(options.opacity||1) };
    default: throw new Error(`系统内核尚未注册任务：${profile.id}`);
  }
}

async function handleLanTransfer(options, execute) {
  if (!execute) return lanServer ? { running: true, address: lanServer.address(), received: lanServer.received || [] } : { running: false, received: [] };
  if (options.action === 'stop') {
    if (lanServer) lanServer.close();
    lanServer = null;
    return { running: false };
  }
  if (lanServer) return { running: true, address: lanServer.address() };
  const received = [];
  lanServer = http.createServer((request, response) => {
    if (request.method === 'POST') {
      const chunks = [];
      request.on('data', chunk => { if (chunks.reduce((sum, item) => sum + item.length, 0) < 20 * 1024 * 1024) chunks.push(chunk); });
      request.on('end', () => {
        const data = Buffer.concat(chunks); const requestedName = request.headers['x-filename'];
        if (requestedName && options.outputDirectory) {
          const safeName = path.basename(decodeURIComponent(String(requestedName))); const target = path.join(options.outputDirectory, `${Date.now()}-${safeName}`);
          fs.mkdirSync(options.outputDirectory, { recursive: true }); fs.writeFileSync(target, data); received.push({ time: new Date().toISOString(), file: target, bytes: data.length });
        } else received.push({ time: new Date().toISOString(), text: data.toString('utf8') });
        response.end('已收到');
      });
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<meta name="viewport" content="width=device-width"><h2>局域网快传</h2><textarea id="t" style="width:100%;height:160px" placeholder="输入文字"></textarea><button onclick="fetch(\'/\',{method:\'POST\',body:t.value}).then(()=>alert(\'文字发送成功\'))">发送文字</button><hr><input id="f" type="file"><button onclick="f.files[0]&&fetch(\'/\',{method:\'POST\',headers:{\'X-Filename\':encodeURIComponent(f.files[0].name)},body:f.files[0]}).then(()=>alert(\'文件发送成功\'))">发送文件</button>');
  });
  lanServer.received = received;
  await new Promise((resolve, reject) => { lanServer.once('error', reject); lanServer.listen(Number(options.port || 0), '0.0.0.0', resolve); });
  const address = lanServer.address();
  const networks = Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal);
  return { running: true, port: address.port, urls: networks.map(item => `http://${item.address}:${address.port}`), received };
}

function handleProject(options, execute) {
  if (options.action === 'stop' && projectProcess) {
    projectProcess.kill(); projectProcess = null; return { running: false };
  }
  if (!execute) return { running: Boolean(projectProcess), pid: projectProcess?.pid || null };
  if (!options.directory || !options.command) throw new Error('请选择项目目录并填写启动命令');
  let [command, ...args] = String(options.command).match(/(?:[^\s"]+|"[^"]*")+/g)?.map(item => item.replace(/^"|"$/g, '')) || [];
  if (!command) throw new Error('启动命令为空');
  if (process.platform === 'win32' && ['npm', 'npx', 'pnpm', 'yarn'].includes(command.toLowerCase())) command = `${command}.cmd`;
  projectProcess = spawn(command, args, { cwd: options.directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  projectProcess.stdout?.on('data', chunk => logs.push(chunk.toString('utf8')));
  projectProcess.stderr?.on('data', chunk => logs.push(chunk.toString('utf8')));
  projectProcess.on('exit', () => { projectProcess = null; });
  return { running: true, pid: projectProcess.pid, logs };
}

async function runTask(payload = {}) {
  const requestedTool = String(payload.toolId || profile.id || '');
  if (!TOOL_KINDS[requestedTool]) return { ok: false, error: `未注册的工具：${requestedTool}` };
  const previous = { id: profile.id, kind: profile.kind };
  profile.id = requestedTool;
  profile.kind = TOOL_KINDS[requestedTool];
  try {
    const input = String(payload.input || '');
    const options = payload.options || {};
    const execute = payload.execute === true;
    let result;
    if (profile.kind === 'text') result = await runTextTask(input, options);
    else if (profile.kind === 'file') result = await runFileTask(input, options, execute);
    else if (profile.kind === 'system') result = await runSystemTask(input, options, execute);
    else if (profile.kind === 'image') result = await runImageTask(input, options, execute);
    else throw new Error('此插件的交互逻辑由渲染端本地内核处理');
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  } finally {
    profile.id = previous.id;
    profile.kind = previous.kind;
  }
}

function selectFiles(options = {}) {
  return ipcRenderer.sendSync('show-open-dialog', {
    title: options.title || '选择文件',
    properties: options.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: options.filters || []
  }) || [];
}

function selectDirectory(title = '选择目录') {
  const result = ipcRenderer.sendSync('show-open-dialog', { title, properties: ['openDirectory', 'createDirectory'] });
  return result?.[0] || '';
}

function saveResult(options = {}) {
  const target = ipcRenderer.sendSync('show-save-dialog', { title: options.title || '保存结果', defaultPath: options.defaultPath || 'result.txt', filters: options.filters || [] });
  if (!target) return { cancelled: true };
  if (options.dataUrl) {
    const image = nativeImage.createFromDataURL(options.dataUrl);
    const format = path.extname(target).toLowerCase();
    fs.writeFileSync(target, format === '.jpg' || format === '.jpeg' ? image.toJPEG(Number(options.quality || 90)) : image.toPNG());
  } else if (options.base64) fs.writeFileSync(target, Buffer.from(options.base64, 'base64'));
  else fs.writeFileSync(target, String(options.text || ''), 'utf8');
  return { cancelled: false, path: target };
}

function chooseSavePath(options = {}) {
  return ipcRenderer.sendSync('show-save-dialog', {
    title: options.title || '选择保存位置',
    defaultPath: options.defaultPath || 'result.txt',
    filters: options.filters || []
  }) || '';
}

async function generateQr(text, size) {
  try {
    const QRCode = require('qrcode');
    const dataUrl = await QRCode.toDataURL(String(text || ''), { width: Math.max(128, Math.min(1600, Number(size || 480))), margin: 2, errorCorrectionLevel: 'M' });
    return { ok: true, dataUrl };
  } catch (error) { return { ok: false, error: safeError(error) }; }
}

function decodeQr(dataUrl) {
  try {
    const jsQR = require('jsqr');
    const image = nativeImage.createFromDataURL(dataUrl);
    const { width, height } = image.getSize();
    const bgra = image.toBitmap();
    const rgba = new Uint8ClampedArray(bgra.length);
    for (let index = 0; index < bgra.length; index += 4) {
      rgba[index] = bgra[index + 2]; rgba[index + 1] = bgra[index + 1]; rgba[index + 2] = bgra[index]; rgba[index + 3] = bgra[index + 3];
    }
    const decoded = jsQR(rgba, width, height);
    return { ok: true, text: decoded?.data || '' };
  } catch (error) { return { ok: false, error: safeError(error) }; }
}

function createToolRuntime(options = {}) {
  profile.name = String(options.pluginName || '三人聚智工具');
  profile.id = String(options.defaultTool || '');
  const allowedTools = new Set(options.allowedTools || []);
  const guardedRunTask = payload => {
    const toolId = String(payload?.toolId || profile.id || '');
    if (!allowedTools.has(toolId)) return Promise.resolve({ ok: false, error: `当前插件无权调用工具：${toolId}` });
    return runTask({ ...payload, toolId });
  };
  return {
  profile: { name: profile.name, id: profile.id, tools: [...allowedTools] },
  runTask: guardedRunTask,
  selectFiles,
  selectDirectory,
  chooseSavePath,
  saveResult,
  generateQr,
  decodeQr,
  readFileDataUrl(filePath) {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const mime = extension === 'svg' ? 'image/svg+xml' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'image/png';
    return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
  },
  copyText(text) { clipboard.writeText(String(text || '')); },
  readClipboardText() { return clipboard.readText(); },
  readClipboardImage() { const image = clipboard.readImage(); return image.isEmpty() ? '' : image.toDataURL(); },
  openExternal(url) { return shell.openExternal(url); },
  showPath(filePath) { return shell.showItemInFolder(filePath); },
  storage: {
    get: key => ipcRenderer.invoke('plugin-storage-get-async', profile.name, key),
    set: (key, value) => ipcRenderer.invoke('plugin-storage-set-async', profile.name, key, value)
  },
  window: {
    togglePin: () => ipcRenderer.invoke('toggle-plugin-pin-window', profile.name),
    keepAlive: () => ipcRenderer.invoke('minimize-plugin-window', profile.name, { keepAlive: true }),
    showIndicator: () => ipcRenderer.invoke('create-plugin-indicator-window', profile.name),
    closeIndicator: () => ipcRenderer.invoke('close-plugin-indicator-window', profile.name)
  }
  };
}

function disposeToolRuntime() {
  if (lanServer) lanServer.close();
  if (projectProcess) projectProcess.kill();
  lanServer = null;
  projectProcess = null;
}

module.exports = { createToolRuntime, disposeToolRuntime, TOOL_KINDS };
