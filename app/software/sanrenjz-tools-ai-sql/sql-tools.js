(function (root, factory) {
  const tools = factory();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  if (root) root.SqlTools = tools;
})(typeof window !== 'undefined' ? window : null, function () {
  const clauses = ['GROUP BY', 'ORDER BY', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'UNION ALL', 'INSERT INTO', 'DELETE FROM', 'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'UPDATE', 'SET', 'JOIN', 'ON', 'WITH', 'UNION', 'RETURNING'];
  const clausePattern = new RegExp('^(?:' + clauses.map(value => value.replace(/ /g, '\\s+')).join('|') + ')\\b', 'i');

  // 词法扫描时保留字符串、引用标识符与注释，避免格式化误改其中的 SQL 关键字。
  function tokenize(sql) {
    const source = String(sql || '');
    const tokens = [];
    let i = 0;
    while (i < source.length) {
      const start = i;
      const pair = source.slice(i, i + 2);
      if (/\s/.test(source[i])) { while (i < source.length && /\s/.test(source[i])) i++; tokens.push({ type: 'space', text: source.slice(start, i) }); continue; }
      if (pair === '--' || pair === '/*' || source[i] === '#') {
        if (pair === '/*') { i = source.indexOf('*/', i + 2); i = i < 0 ? source.length : i + 2; }
        else { i = source.indexOf('\n', i); i = i < 0 ? source.length : i; }
        tokens.push({ type: 'comment', text: source.slice(start, i) }); continue;
      }
      const quote = source[i];
      if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
        const end = quote === '[' ? ']' : quote;
        i++;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === end) { if (source[i + 1] === end) { i += 2; continue; } i++; break; }
          i++;
        }
        tokens.push({ type: 'quoted', text: source.slice(start, i) }); continue;
      }
      if (/[(),;]/.test(source[i])) { i++; tokens.push({ type: 'punct', text: source.slice(start, i) }); continue; }
      while (i < source.length && !/[\s(),;'"`\[\]#]/.test(source[i]) && source.slice(i, i + 2) !== '--' && source.slice(i, i + 2) !== '/*') i++;
      if (i === start) i++;
      tokens.push({ type: 'word', text: source.slice(start, i) });
    }
    return tokens;
  }

  function format(sql) {
    const tokens = tokenize(sql).filter(token => token.type !== 'space');
    let output = ''; let depth = 0; let clauseUntil = -1;
    const newline = () => { output = output.trimEnd() + '\n' + '  '.repeat(Math.max(0, depth)); };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const upper = token.text.toUpperCase();
      if (token.type === 'comment') { if (output.trim() && !output.endsWith('\n')) newline(); output += token.text.trimEnd(); newline(); continue; }
      if (token.text === '(') { output = output.trimEnd() + '('; depth++; continue; }
      if (token.text === ')') { depth = Math.max(0, depth - 1); output = output.trimEnd() + ')'; continue; }
      if (token.text === ',') { output = output.trimEnd() + ','; if (depth === 0) newline(); else output += ' '; continue; }
      if (token.text === ';') { output = output.trimEnd() + ';'; newline(); continue; }
      // 只在顶层断开主要子句；括号内的子查询保留原有语义，不尝试改写。
      const remaining = tokens.slice(i).map(part => part.text).join(' ');
      const match = depth === 0 && i > clauseUntil && token.type === 'word' ? clausePattern.exec(remaining) : null;
      if (match && match[0].toUpperCase().split(/\s+/)[0] === upper) {
        clauseUntil = i + match[0].trim().split(/\s+/).length - 1;
        if (output.trim()) newline();
      }
      if (output && !/[\s(]$/.test(output)) output += ' ';
      output += i <= clauseUntil && token.type === 'word' ? upper : token.text;
    }
    return output.trim();
  }

  function extractBlocks(text) {
    const source = String(text || '');
    const blocks = [];
    const fence = /```(?:sql|mysql|postgresql|sqlite|tsql|plsql)?\s*\n([\s\S]*?)```/gi;
    let cursor = 0; let match;
    while ((match = fence.exec(source))) {
      if (match.index > cursor && source.slice(cursor, match.index).trim()) blocks.push({ type: 'text', text: source.slice(cursor, match.index).trim() });
      blocks.push({ type: 'sql', text: match[1].trim() }); cursor = fence.lastIndex;
    }
    if (source.slice(cursor).trim()) blocks.push({ type: cursor === 0 && /^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|EXPLAIN)\b/i.test(source.trim()) ? 'sql' : 'text', text: source.slice(cursor).trim() });
    return blocks;
  }

  function mainSql(text) {
    const block = extractBlocks(text).find(item => item.type === 'sql');
    if (block) return block.text;
    return extractBlocks(text)[0]?.type === 'sql' ? String(text).trim() : '';
  }

  function inspect(sql) {
    const code = tokenize(sql).filter(token => token.type !== 'comment' && token.type !== 'quoted').map(token => token.text).join(' ').replace(/\s+/g, ' ');
    const findings = [];
    if (/\b(UPDATE|DELETE)\b/i.test(code) && !/\bWHERE\b/i.test(code)) findings.push('检测到 UPDATE/DELETE 且未发现 WHERE；执行前检查影响范围。');
    if (/\b(DROP|TRUNCATE|ALTER)\b/i.test(code)) findings.push('检测到结构或清空操作；请先核对目标对象和备份。');
    if (/\bSELECT\s+\*/i.test(code)) findings.push('检测到 SELECT *；可按实际需要明确列名。');
    if (/\bJOIN\b/i.test(code) && !/\bON\b|\bUSING\b/i.test(code) && !/\bCROSS\s+JOIN\b/i.test(code)) findings.push('JOIN 未见 ON/USING；请核对是否会产生笛卡尔积。');
    return findings;
  }

  function plan(sql, dialect) {
    const code = String(sql || '').trim().replace(/;\s*$/, '');
    const tokens = tokenize(code).filter(token => token.type !== 'space' && token.type !== 'comment');
    const first = tokens[0]?.text.toUpperCase();
    const forbidden = tokens.some(token => token.type === 'word' && /^(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|CALL|EXEC|EXECUTE)$/i.test(token.text));
    if (!['SELECT', 'WITH'].includes(first) || forbidden || tokens.some(token => token.text === ';')) throw new Error('仅为单条只读 SELECT/WITH 查询生成计划命令；请先确认 SQL。');
    const prefix = ({ MySQL: 'EXPLAIN FORMAT=JSON', PostgreSQL: 'EXPLAIN (FORMAT JSON)', SQLite: 'EXPLAIN QUERY PLAN', Oracle: 'EXPLAIN PLAN FOR' })[dialect];
    if (dialect === 'SQL Server') return `SET SHOWPLAN_XML ON;\nGO\n${code};\nGO\nSET SHOWPLAN_XML OFF;\nGO`;
    if (!prefix) throw new Error('请选择支持的数据库方言');
    return dialect === 'SQL Server' ? `${prefix}${code};\nSET SHOWPLAN_XML OFF;` : `${prefix} ${code};`;
  }
  return { tokenize, format, extractBlocks, mainSql, inspect, plan };
});
