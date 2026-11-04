const assert = require('assert');
const { parseLiteral, extract, formatLiteral } = require('../app/software/sanrenjz-tools-ai-regex/regex-core');

assert.deepStrictEqual(parseLiteral('/a\\/b/gi'), { source: 'a\\/b', flags: 'gi' });
assert.deepStrictEqual(parseLiteral('/a\\\\/g'), { source: 'a\\\\', flags: 'g' });
assert.strictEqual(formatLiteral('a/b', 'g'), '/a\\/b/g');
assert.deepStrictEqual(extract('## 正则\n```regex\n/(foo)(?<bar>bar)/gi\n```\n说明'), { source: '(foo)(?<bar>bar)', flags: 'gi' });
assert.deepStrictEqual(extract('```regex\n^\\d+$\n```'), { source: '^\\d+$', flags: '' });
assert.deepStrictEqual(extract('正则表达式：/a+/g\n解释'), { source: 'a+', flags: 'g' });
assert.strictEqual(extract('只有说明，没有可识别的表达式'), null);
console.log('AI 正则助手提取规则验证通过');
