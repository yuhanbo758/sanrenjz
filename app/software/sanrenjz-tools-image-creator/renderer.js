const api = window.pluginAPI;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SUPPORTED = /\.(png|jpe?g|webp|bmp)$/i;
let current = 'image-watermark';
let mainImage = null;
let collage = [];

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element.timer);
  element.timer = setTimeout(() => element.classList.remove('show'), 2200);
}

function setMode(mode) {
  if (!['image-watermark', 'image-collage', 'screenshot-beautifier'].includes(mode)) return;
  current = mode;
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tool === mode));
  $$('[data-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === mode));
  $('#wmPos').closest('.opt').style.display = $('#wmMode').value === 'repeat' ? 'none' : '';
  $('#imageQueue').classList.toggle('show', mode === 'image-collage' && collage.length > 0);
  render();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error('图片尺寸无效'));
    image.onerror = () => reject(new Error('图片无法解码'));
    image.src = url;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function addSources(sources, append = true) {
  const isCollage = current === 'image-collage';
  let added = 0;
  for (const source of sources) {
    try {
      const name = typeof source === 'string' ? source.split(/[\\/]/).pop() : source.name || '剪贴板图片';
      if (typeof source === 'string' && !SUPPORTED.test(source)) throw new Error('不支持的图片格式');
      if (typeof source !== 'string' && source.type && !source.type.startsWith('image/')) throw new Error('不支持的文件类型');
      const url = typeof source === 'string' ? api.readFileDataUrl(source) : await fileToDataUrl(source);
      const image = await loadImage(url);
      if (isCollage) {
        if (!append && !added) collage = [];
        collage.push({ image, url, name });
      } else mainImage = image;
      added++;
    } catch (error) { toast(`${error.message || '读取失败'}：${typeof source === 'string' ? source.split(/[\\/]/).pop() : source.name || '图片'}`); }
  }
  if (added) { renderQueue(); render(); }
}

function pickImage() {
  const files = api.selectFiles({ multiple: current === 'image-collage', filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
  if (files?.length) addSources(files, true);
}

async function pasteImage() {
  try {
    const url = api.readClipboardImage();
    if (!url) return toast('剪贴板中没有图片');
    const image = await loadImage(url);
    if (current === 'image-collage') collage.push({ image, url, name: `粘贴图片 ${collage.length + 1}` });
    else mainImage = image;
    renderQueue(); render();
  } catch (error) { toast(error.message || '粘贴失败'); }
}

function renderQueue() {
  const queue = $('#imageQueue');
  queue.replaceChildren();
  queue.classList.toggle('show', current === 'image-collage' && collage.length > 0);
  collage.forEach((entry, index) => {
    const tile = document.createElement('div'); tile.className = 'queue-item';
    const image = document.createElement('img'); image.src = entry.url; image.alt = '';
    const name = document.createElement('span'); name.textContent = entry.name; name.title = entry.name;
    tile.append(image, name);
    for (const [label, target] of [['←', index - 1], ['→', index + 1]]) {
      const button = document.createElement('button'); button.textContent = label; button.title = '调整顺序';
      button.disabled = target < 0 || target >= collage.length;
      button.onclick = () => { [collage[index], collage[target]] = [collage[target], collage[index]]; renderQueue(); render(); };
      tile.appendChild(button);
    }
    const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '移除图片';
    remove.onclick = () => { collage.splice(index, 1); renderQueue(); render(); };
    tile.appendChild(remove); queue.appendChild(tile);
  });
  $('#cgCount').textContent = `${collage.length} 张 · 可在预览下方排序或移除`;
}

function getCanvas() {
  let canvas = $('#stage canvas');
  if (!canvas) { canvas = document.createElement('canvas'); $('#stage').replaceChildren(canvas); }
  return canvas;
}

function showEmpty() {
  const empty = document.createElement('div'); empty.className = 'empty-c';
  empty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg><span>点击选择图片，或拖入 / 粘贴图片</span>';
  empty.onclick = pickImage;
  $('#stage').replaceChildren(empty);
}

function render() {
  const available = current === 'image-collage' ? collage.length > 0 : !!mainImage;
  $('#exportBtn').disabled = !available;
  $('#clearBtn').disabled = !available;
  if (!available) { showEmpty(); $('#imageMeta').textContent = '可拖入图片，或按 Ctrl+V 粘贴'; return; }
  try {
    const canvas = getCanvas();
    if (current === 'image-collage') renderCollage(canvas);
    else if (current === 'image-watermark') renderWatermark(canvas);
    else renderScreenshot(canvas);
    $('#imageMeta').textContent = `${canvas.width} × ${canvas.height} px`;
  } catch (error) { $('#exportBtn').disabled = true; toast(error.message || '预览失败'); }
}

function checkCanvas(canvas, width, height) {
  if (width < 1 || height < 1 || width > 16000 || height > 16000 || width * height > 64000000) throw new Error('输出图片过大，请调小单元格或输出比例');
  canvas.width = width; canvas.height = height;
  return canvas.getContext('2d');
}

function renderWatermark(canvas) {
  const image = mainImage;
  const ctx = checkCanvas(canvas, image.naturalWidth, image.naturalHeight);
  ctx.drawImage(image, 0, 0);
  const value = $('#wmText').value.trim(); if (!value) return;
  const size = Number($('#wmSize').value), angle = Number($('#wmAngle').value) * Math.PI / 180;
  const stroke = Number($('#wmStroke').value);
  ctx.font = `bold ${size}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.globalAlpha = Number($('#wmOpacity').value) / 100;
  ctx.fillStyle = $('#wmColor').value; ctx.strokeStyle = '#000000'; ctx.lineWidth = stroke * 2; ctx.lineJoin = 'round';
  const width = ctx.measureText(value).width;
  // 平铺使用与文字实际宽度相关的步长，避免长文本重叠成一片。
  const draw = (x, y) => { ctx.save(); ctx.translate(x, y); ctx.rotate(angle); if (stroke) ctx.strokeText(value, 0, 0); ctx.fillText(value, 0, 0); ctx.restore(); };
  if ($('#wmMode').value === 'repeat') {
    const stepX = Math.max(width + size * 2, size * 5), stepY = size * 4;
    for (let y = -stepY; y < canvas.height + stepY; y += stepY) for (let x = -stepX; x < canvas.width + stepX; x += stepX) draw(x + (Math.floor(y / stepY) % 2 ? stepX / 2 : 0), y);
  } else {
    const position = $('#wmPos .active')?.dataset.pos || 'mc'; const margin = Math.max(20, size / 2 + stroke);
    const x = position.endsWith('l') ? margin + width / 2 : position.endsWith('r') ? canvas.width - margin - width / 2 : canvas.width / 2;
    const y = position.startsWith('t') ? margin + size / 2 : position.startsWith('b') ? canvas.height - margin - size / 2 : canvas.height / 2;
    draw(x, y);
  }
  ctx.globalAlpha = 1;
}

function renderCollage(canvas) {
  const columns = Number($('#cgLayout').value), gap = Number($('#cgGap').value), width = Math.max(100, Math.min(2000, Number($('#cgWidth').value) || 600));
  const first = collage[0].image;
  const ratio = $('#cgRatio').value === 'auto' ? first.naturalWidth / first.naturalHeight : Number($('#cgRatio').value);
  const height = Math.max(1, Math.round(width / ratio)), rows = Math.ceil(collage.length / columns);
  const outputWidth = columns * width + (columns + 1) * gap, outputHeight = rows * height + (rows + 1) * gap;
  const ctx = checkCanvas(canvas, outputWidth, outputHeight);
  ctx.fillStyle = $('#cgBg').value; ctx.fillRect(0, 0, outputWidth, outputHeight);
  collage.forEach((entry, index) => {
    const x = gap + (index % columns) * (width + gap), y = gap + Math.floor(index / columns) * (height + gap);
    const img = entry.image, cover = $('#cgFit').value === 'cover';
    const scale = cover ? Math.max(width / img.naturalWidth, height / img.naturalHeight) : Math.min(width / img.naturalWidth, height / img.naturalHeight);
    const drawWidth = img.naturalWidth * scale, drawHeight = img.naturalHeight * scale;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    ctx.drawImage(img, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight); ctx.restore();
  });
}

function renderScreenshot(canvas) {
  const image = mainImage, scale = Number($('#sbScale').value), padding = Number($('#sbPadding').value), shadow = Number($('#sbShadow').value);
  const width = image.naturalWidth, height = image.naturalHeight;
  const ctx = checkCanvas(canvas, (width + padding * 2) * scale, (height + padding * 2) * scale);
  ctx.scale(scale, scale); ctx.fillStyle = $('#sbBg').value; ctx.fillRect(0, 0, width + padding * 2, height + padding * 2);
  ctx.save(); ctx.shadowColor = `rgba(0,0,0,${shadow / 160})`; ctx.shadowBlur = shadow; ctx.shadowOffsetY = shadow / 3;
  ctx.beginPath(); ctx.roundRect(padding, padding, width, height, Number($('#sbRadius').value));
  ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.shadowColor = 'transparent'; ctx.clip(); ctx.drawImage(image, padding, padding); ctx.restore();
}

$$('.tab').forEach(tab => tab.onclick = () => setMode(tab.dataset.tool));
$('#pickBtn').onclick = pickImage; $('#pasteBtn').onclick = pasteImage;
$('#clearBtn').onclick = () => { if (current === 'image-collage') collage = []; else mainImage = null; renderQueue(); render(); };
$('#wmPos').onclick = event => { const button = event.target.closest('[data-pos]'); if (!button) return; $$('#wmPos button').forEach(item => item.classList.toggle('active', item === button)); render(); };
$('#wmMode').onchange = () => { $('#wmPos').closest('.opt').style.display = $('#wmMode').value === 'repeat' ? 'none' : ''; render(); };
for (const id of ['wmSize', 'wmOpacity', 'wmStroke', 'wmAngle', 'cgGap', 'sbRadius', 'sbPadding', 'sbShadow']) {
  $('#' + id).oninput = () => { const value = $('#' + id + 'Val'); if (value) value.textContent = $('#' + id).value + (id === 'wmOpacity' ? '%' : id === 'wmAngle' ? '°' : ''); render(); };
}
for (const id of ['wmText', 'wmColor', 'cgWidth', 'cgBg', 'sbBg']) $('#' + id).oninput = render;
for (const id of ['cgLayout', 'cgRatio', 'cgFit', 'sbScale']) $('#' + id).onchange = render;
$('#exportBtn').onclick = () => {
  const canvas = $('#stage canvas'); if (!canvas) return;
  const format = $('#exportFormat').value;
  try {
    // JPEG 不保存透明度，先铺白底，避免透明区域在不同查看器里变黑。
    let output = canvas;
    if (format === 'jpeg') {
      output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
      const context = output.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, output.width, output.height); context.drawImage(canvas, 0, 0);
    }
    const dataUrl = output.toDataURL('image/' + format, .92);
    const result = api.saveCanvasImage({ dataUrl, format });
    if (!result.cancelled) toast('已保存图片');
  } catch (error) { toast(error.message || '导出失败'); }
};

const stage = $('#stage');
window.addEventListener('dragover', event => { event.preventDefault(); stage.classList.add('dragging'); });
window.addEventListener('dragleave', event => { if (!event.relatedTarget) stage.classList.remove('dragging'); });
window.addEventListener('drop', event => { event.preventDefault(); stage.classList.remove('dragging'); addSources([...event.dataTransfer.files], true); });
window.addEventListener('paste', event => {
  if (event.target.matches('input,textarea,[contenteditable]')) return;
  const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
  if (files.length) { event.preventDefault(); addSources(files, true); }
});
window.addEventListener('plugin-enter', event => {
  if (event.detail?.toolId) setMode(event.detail.toolId);
  const action = event.detail?.action || {};
  const path = action.payload || action.clipboardText || '';
  if (typeof path === 'string' && SUPPORTED.test(path)) addSources([path], true);
});
render();
