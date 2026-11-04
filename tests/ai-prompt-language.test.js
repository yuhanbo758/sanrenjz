const assert = require('assert');
const { detect } = require('../app/software/sanrenjz-tools-ai-prompt/prompt-language');

const examples = [
  ['```python\ndef greet():\n    print("hi")\n```', 'Python'],
  ['const answer = items.map(x => x + 1);', 'JavaScript'],
  ['interface User { name: string }', 'TypeScript'],
  ['public class Demo { public static void main(String[] args) { System.out.println("hi"); } }', 'Java'],
  ['#include <iostream>\nint main() { std::cout << "hi"; }', 'C++'],
  ['package main\nfunc main() { fmt.Println("hi") }', 'Go'],
  ['SELECT id FROM users WHERE active = 1;', 'SQL'],
  ['{"name":"test","enabled":true}', 'JSON'],
  ['<html><body><div>Hello</div></body></html>', 'HTML']
];
for (const [code, expected] of examples) assert.strictEqual(detect(code)?.language, expected, code);
assert.strictEqual(detect('int main() { return 0; }'), null, 'C/C++ 模糊片段应要求手动选择');
assert.strictEqual(detect('hello world'), null, '普通文本不应猜测编程语言');
console.log('AI 提示词工坊代码语言识别与低置信度回退验证通过');
