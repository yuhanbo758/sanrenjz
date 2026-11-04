const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCompletionProfile, parseJsonc } = require('../app/plugin_runtime/opencode-profile');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-opencode-profile-test-'));
try {
  const home = path.join(fixture, 'home');
  const xdg = path.join(fixture, 'user-config');
  const userConfig = path.join(xdg, 'opencode');
  fs.mkdirSync(userConfig, { recursive: true }); fs.mkdirSync(home);
  const original = `{
    // 注释和 URL 中的 // 必须区别处理。
    "provider": { "custom": { "options": { "baseURL": "https://example.invalid/v1", "apiKey": "{file:./test-credential.txt}" },
      "models": { "chat": { "limit": { "context": 1000, "output": 100 } } } } },
    "mcp": { "obsidian": { "type": "local", "command": ["node", "should-not-run.js"] } },
    "plugin": ["./memory-sync.js"], "permission": {"*": "allow"},
  }`;
  fs.writeFileSync(path.join(userConfig, 'opencode.jsonc'), original);
  fs.writeFileSync(path.join(userConfig, 'test-credential.txt'), 'test-only-value\n');
  fs.writeFileSync(path.join(home, 'opencode.json'), JSON.stringify({ provider: { custom: { models: { chat: { limit: { output: 200 } } } } }, instructions: ['vault-notes.md'] }));
  const authDir = path.join(fixture, 'auth-data');
  const sourceEnv = { XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: authDir, OPENCODE_CONFIG: path.join(userConfig, 'opencode.jsonc') };
  const result = createCompletionProfile(path.join(fixture, 'private-runtime'), sourceEnv, home);
  const effective = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
  assert.deepStrictEqual(effective.provider.custom.models.chat.limit, { context: 1000, output: 200 });
  assert.strictEqual(effective.provider.custom.options.apiKey, 'test-only-value');
  assert.strictEqual(effective.provider.custom.options.baseURL, 'https://example.invalid/v1');
  assert.deepStrictEqual(effective.mcp, {});
  assert.deepStrictEqual(effective.plugin, []);
  assert.deepStrictEqual(effective.instructions, []);
  assert.deepStrictEqual(effective.permission, { '*': 'deny' });
  assert.strictEqual(result.env.XDG_DATA_HOME, authDir, '认证路径必须复用，不能复制 OAuth 文件');
  assert.notStrictEqual(result.env.XDG_CONFIG_HOME, xdg);
  assert.strictEqual(result.env.OPENCODE_DB, path.join(fixture, 'private-runtime', 'sessions.db'));
  assert.strictEqual(result.env.XDG_STATE_HOME, path.join(fixture, 'private-runtime', 'state'));
  assert.strictEqual(result.env.OPENCODE_CONFIG, undefined);
  assert.ok(result.cwd.startsWith(path.join(fixture, 'private-runtime')));
  assert.strictEqual(fs.readFileSync(path.join(userConfig, 'opencode.jsonc'), 'utf8'), original);
  assert.deepStrictEqual(fs.readdirSync(result.env.OPENCODE_CONFIG_DIR), [], '不应落盘供应商凭据或复制全局插件');
  assert.deepStrictEqual(parseJsonc('{"text":"escaped \\\" quote, } //",/*comment*/"items":[1,2,],}'), { text: 'escaped " quote, } //', items: [1, 2] });
  assert.throws(() => parseJsonc('{broken'), SyntaxError);
  console.log('OpenCode profile tests passed: JSONC, provider/model preservation, file references, isolated config and unchanged auth/global files');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
