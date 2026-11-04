const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let current = 'palette-extractor';
let imageSource = null;
let palette = [];
let svgResult = '';
let previewUrl = '';

function toast(message) {
  const node = $('#toast'); node.textContent = String(message); node.classList.add('show');
  clearTimeout(node._timer); node._timer = setTimeout(() => node.classList.remove('show'), 2500);
}
function setTool(id) {
  if (!['palette-extractor', 'color-workbench', 'svg-workbench'].includes(id)) return;
  current = id;
  $$('.tab').forEach(node => node.classList.toggle('active', node.dataset.tool === id));
  $$('.panel').forEach(node => node.classList.toggle('active', node.dataset.panel === id));
}
$$('.tab').forEach(node => node.addEventListener('click', () => setTool(node.dataset.tool)));
function normalizeHex(input) {
  const value = String(input || '').trim();
  if (/^#[\da-f]{3}$/i.test(value)) return '#' + [...value.slice(1)].map(char => char + char).join('').toUpperCase();
  if (/^#[\da-f]{6}$/i.test(value)) return value.toUpperCase();
  throw new Error('请输入 #RGB 或 #RRGGBB 格式的颜色');
}
function rgb(hex) { return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)); }
function luminance(hex) {
  const linear = rgb(hex).map(value => { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function harmony(hex, shift) {
  const [r, g, b] = rgb(hex).map(value => value / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0; const l = (max + min) / 2;
  let s = delta ? delta / (1 - Math.abs(2 * l - 1)) : 0;
  if (delta) h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  h = (((h * 60 + shift) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const sectors = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]];
  return '#' + sectors[Math.floor(h / 60)].map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function copy(text) { api.copyText(text); toast('已复制 ' + text); }
function analyze() {
  try {
    const bg = normalizeHex($('#cwBg').value), fg = normalizeHex($('#cwFg').value);
    $('#cwBg').value = bg; $('#cwFg').value = fg;
    $('#cwBgPicker').value = bg; $('#cwFgPicker').value = fg;
    $('#cwPreview').style.background = bg; $('#cwPreview').style.color = fg;
    const ratio = contrast(bg, fg);
    const checks = [['对比度', ratio.toFixed(2) + ':1', null], ['普通文字 AA', ratio >= 4.5 ? '通过' : '未通过', ratio >= 4.5], ['大文字 AA', ratio >= 3 ? '通过' : '未通过', ratio >= 3], ['普通文字 AAA', ratio >= 7 ? '通过' : '未通过', ratio >= 7], ['背景 RGB', rgb(bg).join(', '), null], ['文字 RGB', rgb(fg).join(', '), null]];
    $('#cwResults').replaceChildren(...checks.map(([label, value, pass]) => { const card = document.createElement('div'); card.className = 'metric' + (pass === null ? '' : pass ? ' pass' : ' fail'); const title = document.createElement('span'); title.textContent = label; const number = document.createElement('b'); number.textContent = value; card.append(title, number); return card; }));
    $('#cwHarmony').replaceChildren(...[['互补',180],['类似 -30°',-30],['类似 +30°',30],['三角色 -120°',-120],['三角色 +120°',120]].map(([label, shift]) => { const hex = harmony(bg, shift); const button = document.createElement('button'); const bar = document.createElement('i'); bar.style.background = hex; button.append(bar, document.createTextNode(`${label}\n${hex}`)); button.title = '复制 ' + hex; button.onclick = () => copy(hex); return button; }));
  } catch (error) { toast(error.message); }
}
$('#cwRun').onclick = analyze;
$('#cwSwap').onclick = () => { const bg = $('#cwBg').value; $('#cwBg').value = $('#cwFg').value; $('#cwFg').value = bg; analyze(); };
for (const side of ['Bg', 'Fg']) {
  $(`#cw${side}Picker`).oninput = event => { $(`#cw${side}`).value = event.target.value.toUpperCase(); analyze(); };
  $(`#cw${side}`).addEventListener('keydown', event => { if (event.key === 'Enter') analyze(); });
}
analyze();
function renderPalette() {
  const swatches = $('#peSwatches'); swatches.replaceChildren();
  for (const item of palette) {
    const card = document.createElement('div'); card.className = 'swatch'; card.tabIndex = 0; card.title = `复制 ${item.hex}`;
    const bar = document.createElement('div'); bar.className = 'swatch-bar'; bar.style.background = item.hex;
    const info = document.createElement('div'); info.className = 'swatch-info'; info.textContent = item.hex;
    const use = document.createElement('button'); use.className = 'btn'; use.textContent = '分析'; use.title = '送到调色台';
    use.onclick = event => { event.stopPropagation(); $('#cwBg').value = item.hex; setTool('color-workbench'); analyze(); };
    info.append(use); card.append(bar, info); card.onclick = () => copy(item.hex); card.onkeydown = event => { if (event.key === 'Enter') copy(item.hex); }; swatches.append(card);
  }
  $('#peStrip').hidden = !palette.length;
  $('#peStrip').replaceChildren(...palette.map(item => { const block = document.createElement('div'); block.style.background = item.hex; block.title = item.hex; return block; }));
  $('#peCss').disabled = $('#peExport').disabled = !palette.length;
}
async function extract(source) {
  try {
    $('#peInfo').textContent = '提取中…';
    const result = api.extractPalette({ ...source, count: Number($('#peCount').value) });
    const url = source.dataUrl || api.imagePreview(source.filePath);
    imageSource = source; palette = result.colors;
    const drop = $('#peDrop'); drop.classList.add('has-image'); drop.replaceChildren();
    const image = document.createElement('img'); image.src = url; image.alt = '导入图片预览';
    const label = document.createElement('span'); label.className = 'drop-label'; label.textContent = '拖入另一张图片可替换'; drop.append(image, label);
    $('#peInfo').textContent = `${result.width} × ${result.height} · ${palette.length} 种颜色`;
    renderPalette();
  } catch (error) { $('#peInfo').textContent = '导入失败'; toast(error.message || '图片读取失败'); }
}
$('#pePick').onclick = () => { const files = api.selectFiles({ multiple: false, filters: [{ name: '图片', extensions: ['png','jpg','jpeg','webp','bmp'] }] }); if (files?.[0]) extract({ filePath: files[0] }); };
$('#peDrop').onclick = $('#pePick').onclick;
$('#peDrop').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#pePick').click(); } };
$('#pePaste').onclick = () => { const dataUrl = api.readClipboardImage(); if (dataUrl) extract({ dataUrl }); else toast('剪贴板中没有图片'); };
$('#peCount').onchange = () => { if (imageSource) extract(imageSource); };
$('#peCss').onclick = () => copy(`:root {\n${palette.map((item, index) => `  --color-${index + 1}: ${item.hex};`).join('\n')}\n}`);
$('#peExport').onclick = () => { const result = api.saveResult({ title: '导出色板', defaultPath: 'palette.json', filters: [{ name: 'JSON', extensions: ['json'] }], text: JSON.stringify({ colors: palette.map(item => item.hex) }, null, 2) }); if (!result.cancelled) toast('色板已保存'); };
function validateSvg(source) {
  if (source.length > 2 * 1024 * 1024) throw new Error('SVG 内容不能超过 2 MB');
  const xml = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg') throw new Error('SVG 格式无效');
  return xml;
}
function transformSvg(source, action) {
  const xml = validateSvg(source);
  const serializer = new XMLSerializer();
  if (action === 'minify') {
    for (const node of [xml.documentElement, ...xml.querySelectorAll('*')]) {
      if (['text', 'tspan', 'style'].includes(node.localName)) continue;
      for (const child of [...node.childNodes]) if (child.nodeType === Node.TEXT_NODE && !child.textContent.trim()) child.remove();
    }
    return serializer.serializeToString(xml);
  }
  // 只给纯元素容器排版，含文本的节点保持原序列化，避免改坏 text/tspan 的空格。
  function format(node, depth) {
    if (node.nodeType !== Node.ELEMENT_NODE) return serializer.serializeToString(node);
    if (['text', 'tspan', 'style'].includes(node.localName)) return serializer.serializeToString(node);
    const children = [...node.childNodes];
    if (children.some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())) return serializer.serializeToString(node);
    const elements = children.filter(child => child.nodeType === Node.ELEMENT_NODE || child.nodeType === Node.COMMENT_NODE);
    if (!elements.length) return serializer.serializeToString(node);
    const shell = node.cloneNode(false);
    const opening = serializer.serializeToString(shell).replace(/\s*\/>$/, '>');
    return opening + '\n' + elements.map(child => '  '.repeat(depth + 1) + format(child, depth + 1)).join('\n') + '\n' + '  '.repeat(depth) + `</${node.nodeName}>`;
  }
  return format(xml.documentElement, 0);
}
function previewSvg(source) {
  const xml = validateSvg(source);
  // 预览只保留静态绘图节点和安全属性，避免导入的 SVG 在页面加载脚本或外部资源。
  const allowed = new Set(['svg','g','defs','rect','circle','ellipse','line','polyline','polygon','path','text','tspan','linearGradient','radialGradient','stop','clipPath','mask','pattern','symbol']);
  const attrs = new Set(['xmlns','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','transform','font-size','font-family','font-weight','text-anchor','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','id','clip-path','mask']);
  for (const node of [...xml.querySelectorAll('*')]) {
    if (!allowed.has(node.localName) || (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/2000/svg')) { node.remove(); continue; }
    for (const attr of [...node.attributes]) {
      const internalPaint = ['fill', 'stroke', 'clip-path', 'mask'].includes(attr.name) && /^url\(#[\w:.-]+\)$/.test(attr.value);
      if (!attrs.has(attr.name) || (!internalPaint && /url\s*\(|https?:|data:|javascript:/i.test(attr.value))) node.removeAttribute(attr.name);
    }
  }
  for (const attr of [...xml.documentElement.attributes]) if (!attrs.has(attr.name)) xml.documentElement.removeAttribute(attr.name);
  const blob = new Blob([new XMLSerializer().serializeToString(xml)], { type: 'image/svg+xml' });
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  const image = document.createElement('img'); image.src = previewUrl; image.alt = 'SVG 静态预览';
  $('#svgPreview').replaceChildren(image);
}
async function processSvg() {
  try {
    const input = $('#svgInput').value.trim(); if (!input) throw new Error('请输入 SVG');
    validateSvg(input);
    svgResult = transformSvg(input, $('#svgAction').value);
    validateSvg(svgResult);
    $('#svgOutput').textContent = svgResult; previewSvg(svgResult);
    $('#svgCopy').disabled = $('#svgSave').disabled = false;
    $('#svgInfo').textContent = `原始 ${input.length} 字符 → 结果 ${svgResult.length} 字符`;
  } catch (error) { svgResult = ''; $('#svgOutput').textContent = ''; $('#svgPreview').textContent = '无法预览'; $('#svgCopy').disabled = $('#svgSave').disabled = true; toast(error.message || 'SVG 处理失败'); }
}
$('#svgRun').onclick = processSvg;
$('#svgPick').onclick = () => { const files = api.selectFiles({ multiple: false, filters: [{ name: 'SVG', extensions: ['svg'] }] }); if (files?.[0]) importSvg(files[0]); };
function importSvg(filePath) { try { $('#svgInput').value = api.readSvgFile(filePath); setTool('svg-workbench'); processSvg(); } catch (error) { toast(error.message); } }
$('#svgCopy').onclick = () => copy(svgResult);
$('#svgSave').onclick = () => { const result = api.saveResult({ title: '保存 SVG', defaultPath: 'design.svg', filters: [{ name: 'SVG', extensions: ['svg'] }], text: svgResult }); if (!result.cancelled) toast('SVG 已保存'); };
$('#svgInput').oninput = () => { svgResult = ''; $('#svgCopy').disabled = $('#svgSave').disabled = true; $('#svgInfo').textContent = '源码已修改，请重新处理'; };
function handleFile(file) {
  const filePath = file?.path;
  if (!filePath) { toast('无法获取拖入文件的路径'); return; }
  if (/\.svg$/i.test(filePath)) importSvg(filePath);
  else if (/\.(png|jpe?g|webp|bmp)$/i.test(filePath)) { setTool('palette-extractor'); extract({ filePath }); }
  else toast('仅支持图片或 SVG 文件');
}
window.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', event => { if (!event.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', event => { event.preventDefault(); document.body.classList.remove('dragging'); if (event.dataTransfer?.files?.length) handleFile(event.dataTransfer.files[0]); });
window.addEventListener('paste', event => { if (event.target.matches('input,textarea,[contenteditable]')) return; const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/')); if (file) { event.preventDefault(); const reader = new FileReader(); reader.onload = () => { setTool('palette-extractor'); extract({ dataUrl: reader.result }); }; reader.readAsDataURL(file); } });
window.addEventListener('plugin-enter', event => { const id = event.detail?.toolId; if (id) setTool(id); const input = event.detail?.action?.payload || event.detail?.action?.clipboardText || event.detail?.payload || ''; if (typeof input !== 'string' || !input) return; if (current === 'color-workbench') { $('#cwBg').value = input; analyze(); } else if (current === 'svg-workbench') { $('#svgInput').value = input; processSvg(); } else if (/\.(png|jpe?g|webp|bmp)$/i.test(input)) extract({ filePath: input }); });
window.addEventListener('beforeunload', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); });
