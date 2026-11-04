const assert = require('assert');
const { runJson } = require('../app/software/sanrenjz-tools-structured-data/json-tools');

assert.strictEqual(runJson('{"a.b":{"items":[null,2]}}', {query:'$["a.b"].items[1]'}).result, '2');
assert.strictEqual(runJson('{"a":null}', {query:'a'}).result, 'null');
assert.throws(() => runJson('{"a":1}', {query:'b'}), /路径不存在/);
assert.throws(() => runJson('{"a":1}', {query:'a['}), /路径语法错误/);
assert.deepStrictEqual(runJson('{"a":[1,{"b":true}]}', {action:'validate'}).stats,
  {objects:2, arrays:1, values:2, maxDepth:3});
assert.match(runJson('{"a":[1]}', {action:'tree'}).result, /\[0\]: 1/);
assert.strictEqual(runJson('[{"a":1},{"a":2}]', {action:'array-to-jsonl'}).result, '{"a":1}\n{"a":2}');
assert.deepStrictEqual(JSON.parse(runJson('{"a":1}\n{"a":2}', {action:'jsonl-to-array'}).result), [{a:1},{a:2}]);
assert.throws(() => runJson('{"a":1}\ninvalid', {action:'jsonl-to-array'}), /第 2 条/);
console.log('structured data JSON tests passed');
