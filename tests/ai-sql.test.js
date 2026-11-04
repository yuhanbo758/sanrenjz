const assert = require('assert');
const tools = require('../app/software/sanrenjz-tools-ai-sql/sql-tools');

const source = "select 'from, where' as phrase, id from users where name='O''Brien' order by id; -- keep SELECT";
const formatted = tools.format(source);
assert.ok(formatted.includes("'from, where'"));
assert.ok(formatted.includes("'O''Brien'"));
assert.ok(formatted.includes('\nFROM users\nWHERE'));
assert.ok(formatted.includes('\nORDER BY id;'));
assert.ok(formatted.includes('-- keep SELECT'));

const blocks = tools.extractBlocks('说明\n```sql\nSELECT * FROM users;\n```\n请核对索引');
assert.deepStrictEqual(blocks.map(block => block.type), ['text', 'sql', 'text']);
assert.strictEqual(tools.mainSql('说明\n```sql\nSELECT 1;\n```'), 'SELECT 1;');
assert.strictEqual(tools.extractBlocks('SELECT 1;')[0].type, 'sql');
assert.ok(tools.inspect('UPDATE users SET active = 0').some(note => note.includes('WHERE')));
assert.deepStrictEqual(tools.inspect("SELECT 'DELETE FROM users' AS sample"), []);
assert.ok(tools.inspect('SELECT * FROM users').some(note => note.includes('SELECT *')));
assert.strictEqual(tools.plan('SELECT id FROM users;', 'SQLite'), 'EXPLAIN QUERY PLAN SELECT id FROM users;');
assert.ok(tools.plan('SELECT 1', 'SQL Server').includes('GO\nSELECT 1;\nGO'));
assert.throws(() => tools.plan('DELETE FROM users', 'PostgreSQL'), /只读/);
assert.throws(() => tools.plan('WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x', 'PostgreSQL'), /只读/);
assert.throws(() => tools.plan('SELECT 1; DROP TABLE users', 'MySQL'), /单条/);
console.log('AI SQL local tools: OK');
