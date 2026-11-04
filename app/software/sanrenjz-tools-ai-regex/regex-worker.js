self.onmessage = ({ data }) => {
  try {
    const { source, flags, sample, replacement, positive, negative } = data;
    if (source.length > 2000 || sample.length > 20000) throw new Error('正则或样本文本过长');
    const re = new RegExp(source, flags);
    const scan = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    const matches = [];
    for (const match of sample.matchAll(scan)) {
      matches.push({ text: match[0], index: match.index, groups: match.slice(1), named: match.groups || {} });
      if (matches.length >= 200) break;
    }
    const check = (lines, expected) => lines.filter(Boolean).map(text => ({ text, passed: new RegExp(source, flags).test(text) === expected }));
    self.postMessage({ matches, preview: sample.replace(re, replacement), positive: check(positive, true), negative: check(negative, false), capped: matches.length >= 200 });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
