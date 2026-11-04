function renderPdfPage(items) {
  const lines = [];
  let line = '';
  let baseline = null;
  let height = 0;
  let right = null;
  let previousBaseline = null;
  let previousHeight = 0;

  function flush() {
    if (!line.trim()) return;
    // PDF 没有段落结构；用行距保留明显的段落间隔。
    if (previousBaseline !== null && baseline !== null &&
        previousBaseline - baseline > Math.max(previousHeight, height, 1) * 2) lines.push('');
    lines.push(line.trimEnd());
    previousBaseline = baseline;
    previousHeight = height;
    line = '';
    baseline = null;
    height = 0;
    right = null;
  }

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const x = Number(item.transform?.[4]);
    const y = Number(item.transform?.[5]);
    const itemHeight = Math.abs(Number(item.height)) || Math.abs(Number(item.transform?.[3])) || 12;
    if (item.str && Number.isFinite(y) && baseline !== null && Math.abs(y - baseline) > Math.max(height, itemHeight) * 0.55) flush();
    if (item.str) {
      if (baseline === null) baseline = Number.isFinite(y) ? y : null;
      height = Math.max(height, itemHeight);
      if (!item.str.trim()) {
        // PDF 表格列间常被提取成带宽度的空白文字片段。
        line += Number(item.width) > itemHeight * 3 ? '\t' : item.str;
      } else {
        const gap = right !== null && Number.isFinite(x) ? x - right : 0;
        if (line && !/[\s]$/.test(line)) {
          if (gap > itemHeight * 3) line += '\t';
          else if (gap > itemHeight * 0.2) line += ' ';
        }
        line += item.str;
      }
      if (Number.isFinite(x)) right = x + (Number(item.width) || 0);
    }
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join('\n');
}

module.exports = { renderPdfPage };
