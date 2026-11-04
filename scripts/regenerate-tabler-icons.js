const fs = require('fs');
const path = require('path');
const { catalog } = require('./plugin-market/catalog');

const root = path.resolve(__dirname, '..');
const software = path.join(root, 'app', 'software');
const version = '3.44.0';
const sourceBase = `https://raw.githubusercontent.com/tabler/tabler-icons/v${version}/icons/outline`;
const packPage = 'https://icon-icons.com/zh/pack/Tabler-icons/2518';
const licenseUrl = `https://raw.githubusercontent.com/tabler/tabler-icons/v${version}/LICENSE`;

/**
 * 每个插件选用不同的 Tabler 线性图标。图形来自 icon-icons 收录的同名 Tabler 系列，
 * 实际 SVG 从 Tabler 官方仓库固定版本获取，避免下载页压缩、重定向或授权信息漂移。
 */
const iconNames = {
  'structured-data': 'braces',
  'csv-data': 'table',
  'code-security': 'shield-lock',
  'text-engineering': 'text-recognition',
  'time-calculation': 'calculator',
  'file-batch': 'files',
  'file-inspector': 'folder-search',
  'pdf-studio': 'file-type-pdf',
  'archive-studio': 'file-zip',
  'image-optimizer': 'photo-cog',
  'image-creator': 'photo-edit',
  'visual-design': 'palette',
  'qr-barcode': 'qrcode',
  'notes-center': 'notebook',
  'task-habit': 'checklist',
  'focus-worklog': 'clock-hour-4',
  'launch-center': 'rocket',
  'lan-transfer': 'transfer',
  'image-pinboard': 'pinned',
  'hosts-center': 'server-cog',
  'ai-writing': 'writing',
  'ai-document': 'file-description',
  'ai-meeting': 'notes',
  'ai-code-review': 'code-circle-2',
  'ai-regex': 'regex',
  'ai-sql': 'sql',
  'ai-git': 'git-branch',
  'ai-prompt': 'bulb',
  'ai-image': 'photo-scan',
  'ai-learning': 'cards'
};

function mix(hex, target, ratio) {
  const source = hex.replace('#', '').match(/.{2}/g).map(value => parseInt(value, 16));
  const result = source.map((value, index) => Math.round(value + (target[index] - value) * ratio));
  return `#${result.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function extractIconBody(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/<path\s+stroke="none"\s+fill="none"[^>]*\/>/g, '')
    .replace(/currentColor/g, '#ffffff')
    .trim();
}

function decoration(index) {
  if (index % 4 === 0) return '<circle cx="54" cy="52" r="44" fill="#fff" opacity=".08"/><circle cx="210" cy="204" r="58" fill="#fff" opacity=".08"/>';
  if (index % 4 === 1) return '<path d="M-10 204L184 10h82v76L70 266H-10z" fill="#fff" opacity=".09"/>';
  if (index % 4 === 2) return '<path d="M22 72h212M22 184h212" stroke="#fff" stroke-width="2" opacity=".12"/><circle cx="205" cy="51" r="17" fill="#fff" opacity=".13"/>';
  return '<path d="M22 218C80 154 138 246 234 114v120H22z" fill="#fff" opacity=".1"/><circle cx="46" cy="48" r="8" fill="#fff" opacity=".25"/>';
}

function composeSvg(plugin, iconBody, index) {
  const dark = mix(plugin.accent, [8, 16, 35], 0.64);
  const light = mix(plugin.accent, [255, 255, 255], 0.18);
  const aiBadge = plugin.type === 'ai' ? `\n  <g transform="translate(184 34)"><circle cx="20" cy="20" r="20" fill="#101828" opacity=".92"/><path d="M20 8l2.8 8.2L31 19l-8.2 2.8L20 30l-2.8-8.2L9 19l8.2-2.8z" fill="#fff"/><circle cx="31" cy="8" r="3" fill="#fff" opacity=".8"/></g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="${plugin.name}">
  <defs><linearGradient id="bg" x1="24" y1="18" x2="230" y2="238" gradientUnits="userSpaceOnUse"><stop stop-color="${light}"/><stop offset=".52" stop-color="${plugin.accent}"/><stop offset="1" stop-color="${dark}"/></linearGradient><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="9" stdDeviation="8" flood-color="#000" flood-opacity=".22"/></filter></defs>
  <rect x="14" y="12" width="228" height="228" rx="58" fill="url(#bg)" filter="url(#shadow)"/>
  ${decoration(index)}
  <rect x="23" y="21" width="210" height="210" rx="49" fill="none" stroke="#fff" stroke-width="2" opacity=".16"/>
  <g transform="translate(48 48) scale(6.6667)" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconBody}</g>${aiBadge}
</svg>`;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'sanrenjz-tools-icon-builder/1.0' } });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  return response.text();
}

async function main() {
  const missing = catalog.filter(plugin => !iconNames[plugin.id]);
  if (missing.length) throw new Error(`缺少图标映射：${missing.map(item => item.id).join(', ')}`);
  const license = await fetchText(licenseUrl);
  const sources = await Promise.all(catalog.map(async plugin => {
    const iconName = iconNames[plugin.id];
    const sourceUrl = `${sourceBase}/${iconName}.svg`;
    return { plugin, iconName, sourceUrl, source: await fetchText(sourceUrl) };
  }));
  for (const [index, item] of sources.entries()) {
    const directory = path.join(software, item.plugin.folder);
    const licenseDirectory = path.join(directory, 'THIRD_PARTY_LICENSES');
    fs.mkdirSync(licenseDirectory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'logo.svg'), composeSvg(item.plugin, extractIconBody(item.source), index), 'utf8');
    fs.writeFileSync(path.join(licenseDirectory, 'Tabler-Icons-LICENSE.txt'), license, 'utf8');
    fs.writeFileSync(path.join(directory, 'icon-source.json'), `${JSON.stringify({
      name: item.iconName,
      collection: 'Tabler Icons',
      version,
      license: 'MIT',
      referencePage: packPage,
      sourceUrl: item.sourceUrl
    }, null, 2)}\n`, 'utf8');
  }
  console.log(`已更新 ${sources.length} 个 Tabler 官方 SVG 图标源。`);
}

main().catch(error => { console.error(error); process.exit(1); });
