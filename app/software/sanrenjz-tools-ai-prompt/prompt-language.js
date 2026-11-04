(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptLanguage = api;
})(typeof window === 'undefined' ? null : window, function () {
  const languages = [
    ['Python', 'Python'], ['JavaScript', 'JavaScript'], ['TypeScript', 'TypeScript'],
    ['Java', 'Java'], ['C#', 'C#'], ['C++', 'C++'], ['C', 'C'], ['Go', 'Go'],
    ['Rust', 'Rust'], ['Kotlin', 'Kotlin'], ['Swift', 'Swift'], ['PHP', 'PHP'],
    ['Ruby', 'Ruby'], ['SQL', 'SQL'], ['HTML', 'HTML'], ['CSS', 'CSS'],
    ['JSON', 'JSON'], ['Bash', 'Shell / Bash']
  ];
  const aliases = {
    py: 'Python', python: 'Python', js: 'JavaScript', javascript: 'JavaScript',
    jsx: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TypeScript',
    java: 'Java', cs: 'C#', csharp: 'C#', cpp: 'C++', 'c++': 'C++', cc: 'C++',
    c: 'C', go: 'Go', rs: 'Rust', rust: 'Rust', kt: 'Kotlin', kotlin: 'Kotlin',
    swift: 'Swift', php: 'PHP', rb: 'Ruby', ruby: 'Ruby', sql: 'SQL',
    html: 'HTML', htm: 'HTML', css: 'CSS', json: 'JSON', sh: 'Bash', bash: 'Bash'
  };
  const rules = {
    Python: [[/^(?:async\s+)?def\s+\w+\s*\(/m, 5], [/^class\s+\w+.*:/m, 3], [/^from\s+\w+\s+import\s+/m, 4], [/\b(?:print|range|len)\s*\(/, 2], [/^\s{4,}\w+\s*=/m, 1]],
    JavaScript: [[/\b(?:const|let)\s+\w+\s*=/, 2], [/=>/, 3], [/\bconsole\.(?:log|error)\s*\(/, 4], [/\bfunction\s+\w+\s*\([^)]*\)\s*\{/, 3], [/\b(?:require\(|module\.exports|document\.querySelector)/, 3]],
    TypeScript: [[/\binterface\s+\w+\s*\{/, 5], [/\btype\s+\w+\s*=/, 4], [/\b(?:const|let)\s+\w+\s*:\s*(?:string|number|boolean)\b/, 5], [/\bimport\s+type\s+/, 5]],
    Java: [[/\bpublic\s+(?:static\s+)?class\s+\w+/, 5], [/\bSystem\.out\.print(?:ln)?\s*\(/, 5], [/^import\s+java\./m, 5]],
    'C#': [[/^using\s+System(?:\.|;)/m, 5], [/\bConsole\.Write(?:Line)?\s*\(/, 5], [/\bnamespace\s+\w+\s*[\{;]/, 4]],
    'C++': [[/^#include\s*<(?:iostream|vector|string|memory)>/m, 5], [/\bstd::/, 5], [/\b(?:cout|cin)\s*(?:<<|>>)/, 5]],
    C: [[/^#include\s*<(?:stdio|stdlib|string)\.h>/m, 5], [/\bprintf\s*\(/, 3], [/\bmalloc\s*\(/, 3]],
    Go: [[/^package\s+\w+/m, 4], [/\bfunc\s+(?:main|\w+)\s*\(/, 4], [/\bfmt\.(?:Println|Printf)\s*\(/, 5]],
    Rust: [[/\bfn\s+main\s*\(/, 5], [/\blet\s+mut\s+/, 4], [/\bprintln!\s*\(/, 5], [/^use\s+std::/m, 5]],
    Kotlin: [[/\bfun\s+main\s*\(/, 5], [/\b(?:data\s+class|val\s+\w+\s*:)/, 4]],
    Swift: [[/^import\s+(?:Foundation|SwiftUI)/m, 5], [/\bfunc\s+\w+\s*\([^)]*\)\s*->/, 5]],
    PHP: [[/<\?php\b/i, 6], [/\$\w+\s*=/, 2]],
    Ruby: [[/^\s*def\s+\w+/m, 4], [/\bputs\s+/, 3], [/^\s*end\s*$/m, 2]],
    SQL: [[/\bSELECT\b[\s\S]*\bFROM\b/i, 6], [/\bCREATE\s+TABLE\b/i, 6], [/\bINSERT\s+INTO\b/i, 6], [/\bUPDATE\s+\w+\s+SET\b/i, 6]],
    HTML: [[/<!DOCTYPE\s+html\b/i, 6], [/<html\b/i, 5], [/<(?:div|section|p|span|body)\b[^>]*>/i, 4]],
    CSS: [[/(?:^|\n)\s*[.#]?[\w-]+(?:\s*,\s*[.#]?[\w-]+)*\s*\{\s*[\w-]+\s*:/m, 5]],
    Bash: [[/^#!\/bin\/(?:ba)?sh\b/m, 6], [/\b(?:echo|export)\s+/, 2], [/\$\{?[A-Z_][A-Z_0-9]*\}?/, 2]]
  };

  function detect(code) {
    const text = String(code || '').trim();
    if (!text) return null;
    const fence = /^```\s*([\w+#.-]+)\s*\r?\n/.exec(text);
    if (fence && aliases[fence[1].toLowerCase()]) return { language: aliases[fence[1].toLowerCase()], reason: '代码块标记' };
    try {
      if (/^[\[{]/.test(text)) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return { language: 'JSON', reason: 'JSON 语法' };
      }
    } catch (_) { /* 不是完整 JSON，继续按语法特征判断。 */ }
    const scores = Object.entries(rules).map(([language, patterns]) => ({
      language, score: patterns.reduce((total, [pattern, weight]) => total + (pattern.test(text) ? weight : 0), 0)
    })).sort((a, b) => b.score - a.score);
    const [first, second] = scores;
    // 只有信号足够强且明显胜过次高分才自动填充，短片段或混合语法交给用户选择。
    if (first.score < 4 || first.score - second.score < 2) return null;
    return { language: first.language, reason: '代码语法' };
  }

  return { languages, detect };
});
