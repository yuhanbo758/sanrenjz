const assert = require('assert');
const core = require('../app/software/sanrenjz-tools-csv-data/csv-core');

const source = '\uFEFF姓名,备注,数量\r\n张三,"第一行\n第二行",10\r\n李四,"含""引号"",逗号",2\r\n';
const rows = core.parse(source, ',');
assert.deepStrictEqual(rows, [
  ['姓名', '备注', '数量'],
  ['张三', '第一行\n第二行', '10'],
  ['李四', '含"引号",逗号', '2']
]);
assert.strictEqual(core.detectDelimiter('姓名\t年龄\n张三\t20'), '\t');
assert.strictEqual(core.detectDelimiter('姓名;年龄\n张三;20'), ';');
assert.deepStrictEqual(core.parse(core.toCsv(rows, ','), ','), rows);
assert.deepStrictEqual(core.view(rows, '李四', 2, -1)[1], rows[2]);
assert.deepStrictEqual(core.view(rows, '', 2, 1).slice(1).map(row => row[2]), ['2', '10']);
assert.deepStrictEqual(core.fromJson('[{"姓名":"张三","年龄":20},{"姓名":"李四","城市":"上海"}]'), [
  ['姓名', '年龄', '城市'], ['张三', '20', ''], ['李四', '', '上海']
]);
assert.deepStrictEqual(JSON.parse(core.toJson(rows))[0], { 姓名: '张三', 备注: '第一行\n第二行', 数量: '10' });
assert.strictEqual(core.inspect([['a', 'b'], ['1']]).irregularRows, 1);
assert.throws(() => core.toJson([['a', 'a'], ['1', '2']]), /重复/);
assert.throws(() => core.parse('a,b\n"未闭合', ','), /未闭合/);
console.log('CSV 数据表核心测试通过');
