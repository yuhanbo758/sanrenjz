const fs = require('fs');
const path = require('path');
const { PDFDocument, degrees } = require('pdf-lib');

function parsePages(expression, count) {
  const value = String(expression || '').trim().toLowerCase();
  if (!value || value === '全部') return Array.from({ length: count }, (_, i) => i);
  if (value === '奇数') return Array.from({ length: count }, (_, i) => i).filter(i => i % 2 === 0);
  if (value === '偶数') return Array.from({ length: count }, (_, i) => i).filter(i => i % 2 === 1);
  const result = [];
  for (const segment of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(segment);
    if (!match) throw new Error(`页码格式无效：${segment.trim() || '空项'}`);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end > count || end < start) throw new Error(`页码超出范围：${segment.trim()}（共 ${count} 页）`);
    for (let page = start; page <= end; page++) result.push(page - 1);
  }
  if (!result.length) throw new Error('没有选中的页面');
  return result;
}

async function inspectPdf(filePath) {
  if (typeof filePath !== 'string' || !/\.pdf$/i.test(filePath)) throw new Error('请选择 PDF 文件');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('所选路径不是文件');
  const pdf = await PDFDocument.load(fs.readFileSync(filePath));
  return { path: filePath, name: path.basename(filePath), pages: pdf.getPageCount(), bytes: stat.size };
}

// 预览和保存共用同一页码计划，避免界面统计与实际输出不一致。
async function buildPlan(items, rotation = 0) {
  if (!Array.isArray(items) || !items.length) throw new Error('请先添加 PDF 文件');
  if (!Number.isInteger(Number(rotation)) || ![0, 90, 180, 270].includes(Number(rotation))) throw new Error('旋转角度无效');
  const sources = [];
  for (const item of items) {
    const info = await inspectPdf(item.path);
    const pages = parsePages(item.range, info.pages);
    if (!pages.length) throw new Error(`${info.name} 没有选中的页面`);
    if (item.reverse) pages.reverse();
    sources.push({ ...info, selected: pages });
  }
  return { sources, pages: sources.reduce((sum, item) => sum + item.selected.length, 0), rotation: Number(rotation) };
}

async function appendPages(target, source, indices, rotation) {
  const copied = await target.copyPages(source, indices);
  copied.forEach(page => {
    if (rotation) page.setRotation(degrees((page.getRotation().angle + rotation) % 360));
    target.addPage(page);
  });
}

function uniqueOutput(directory, stem, reserved) {
  const safe = stem.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || '页面';
  let candidate = path.join(directory, `${safe}.pdf`);
  for (let n = 2; fs.existsSync(candidate) || reserved.has(candidate); n++) candidate = path.join(directory, `${safe}-${n}.pdf`);
  reserved.add(candidate);
  return candidate;
}

async function savePdf(items, options = {}) {
  const plan = await buildPlan(items, options.rotation);
  const mode = options.mode || 'merge';
  if (mode === 'merge') {
    if (!options.output) throw new Error('请选择保存位置');
    const targetPath = path.resolve(options.output);
    if (plan.sources.some(item => path.resolve(item.path).toLowerCase() === targetPath.toLowerCase())) throw new Error('输出文件不能覆盖原始 PDF');
    const target = await PDFDocument.create();
    for (const item of plan.sources) {
      const source = await PDFDocument.load(fs.readFileSync(item.path));
      await appendPages(target, source, item.selected, plan.rotation);
    }
    fs.writeFileSync(targetPath, await target.save());
    return { pages: plan.pages, outputs: [targetPath] };
  }
  if (mode !== 'split') throw new Error('未知的输出方式');
  const directory = path.resolve(options.outputDirectory || '');
  if (!options.outputDirectory || !fs.statSync(directory).isDirectory()) throw new Error('请选择有效的输出目录');
  if (plan.pages > 300) throw new Error('单次拆分最多 300 页，请缩小页码范围');
  const reserved = new Set();
  const outputs = [];
  for (const item of plan.sources) {
    const source = await PDFDocument.load(fs.readFileSync(item.path));
    const stem = path.parse(item.name).name;
    for (const index of item.selected) {
      const target = await PDFDocument.create();
      await appendPages(target, source, [index], plan.rotation);
      const output = uniqueOutput(directory, `${stem}-第${index + 1}页`, reserved);
      fs.writeFileSync(output, await target.save(), { flag: 'wx' });
      outputs.push(output);
    }
  }
  return { pages: plan.pages, outputs };
}

module.exports = { parsePages, inspectPdf, buildPlan, savePdf };
