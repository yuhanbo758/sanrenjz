(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  root.CsvCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DELIMITERS = [',', '\t', ';', '|'];

  function parse(text, delimiter) {
    const rows = []; let row = []; let field = ''; let quoted = false; let closed = false;
    const source = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { quoted = false; closed = true; }
        else field += ch;
      } else if (ch === delimiter) { row.push(field); field = ''; closed = false; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && source[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; closed = false;
      } else if (ch === '"' && field === '' && !closed) quoted = true;
      else if (closed && (ch === ' ' || ch === '\t')) { /* 引号后的空白保留为字段内容。 */ field += ch; closed = false; }
      else if (closed || ch === '"') throw new Error(`第 ${rows.length + 1} 行存在不合法的引号`);
      else field += ch;
    }
    if (quoted) throw new Error('CSV 引号未闭合');
    if (field !== '' || row.length || closed) { row.push(field); rows.push(row); }
    while (rows.length && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
    return rows;
  }

  function detectDelimiter(text) {
    // 只比较前几条逻辑记录，避免多行引号字段中的分隔符影响识别。
    const candidates = DELIMITERS.map(delimiter => {
      try {
        const rows = parse(text, delimiter).slice(0, 8);
        const widths = rows.map(row => row.length);
        const common = widths.filter(width => width > 1 && width === widths[0]).length;
        return { delimiter, score: common * 10 + Math.min(widths[0] || 0, 10) };
      } catch (_) { return { delimiter, score: 0 }; }
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].score > 1 ? candidates[0].delimiter : ',';
  }

  function fromJson(text) {
    const value = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!Array.isArray(value) || !value.length) throw new Error('JSON 需要是非空对象数组或二维数组');
    if (value.every(item => Array.isArray(item))) return value.map(row => row.map(cell => cell == null ? '' : String(cell)));
    if (!value.every(item => item && typeof item === 'object' && !Array.isArray(item))) throw new Error('JSON 数组中的行类型不一致');
    const headers = [...new Set(value.flatMap(item => Object.keys(item)))];
    return [headers, ...value.map(item => headers.map(key => item[key] == null ? '' : typeof item[key] === 'object' ? JSON.stringify(item[key]) : String(item[key])))];
  }

  function inspect(rows) {
    if (!rows.length || !rows[0].length) throw new Error('没有可读取的表头');
    const headers = rows[0];
    const blankHeaders = headers.filter(header => !header.trim()).length;
    const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index).length;
    const irregularRows = rows.slice(1).filter(row => row.length !== headers.length).length;
    return { blankHeaders, duplicateHeaders, irregularRows };
  }

  function view(rows, query, sortColumn, sortDirection) {
    const headers = rows[0] || [];
    const needle = String(query || '').toLocaleLowerCase();
    const records = rows.slice(1).map((row, index) => ({ row, index })).filter(item =>
      !needle || item.row.some(cell => String(cell).toLocaleLowerCase().includes(needle)));
    if (sortColumn !== null && sortColumn !== undefined) {
      const col = Number(sortColumn);
      records.sort((a, b) => {
        const left = String(a.row[col] ?? ''); const right = String(b.row[col] ?? '');
        const number = /^-?\d+(\.\d+)?$/;
        const result = number.test(left.trim()) && number.test(right.trim())
          ? Number(left) - Number(right) : left.localeCompare(right, 'zh-CN', { numeric: true });
        return result * sortDirection || a.index - b.index;
      });
    }
    return [headers, ...records.map(item => item.row)];
  }

  function toCsv(rows, delimiter) {
    return rows.map(row => row.map(value => {
      const field = String(value ?? '');
      return field.includes(delimiter) || /["\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
    }).join(delimiter)).join('\r\n');
  }

  function toJson(rows) {
    const [headers = [], ...data] = rows;
    if (inspect(rows).blankHeaders || inspect(rows).duplicateHeaders) throw new Error('JSON 导出需要非空且不重复的表头');
    return JSON.stringify(data.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))), null, 2);
  }

  return { parse, detectDelimiter, fromJson, inspect, view, toCsv, toJson };
});
