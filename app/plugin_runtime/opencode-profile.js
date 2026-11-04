const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDER_FIELDS = ['provider', 'model', 'small_model', 'enabled_providers', 'disabled_providers'];

function parseJsonc(text) {
  // 先保留完整字符串，再移除注释与尾逗号，避免误伤 URL、转义引号或字符串内的逗号。
  const withoutComments = String(text).replace(/^\uFEFF/, '')
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : ' ');
  return JSON.parse(withoutComments.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : ''));
}

function resolveFileReferences(value, directory) {
  if (typeof value === 'string') {
    return value.replace(/\{file:([^}]+)\}/g, (_match, filename) => {
      const expanded = filename.startsWith('~/') || filename.startsWith('~\\')
        ? path.join(os.homedir(), filename.slice(2)) : filename;
      return fs.readFileSync(path.resolve(directory, expanded), 'utf8').trim();
    });
  }
  if (Array.isArray(value)) return value.map(item => resolveFileReferences(item, directory));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFileReferences(item, directory)]));
  }
  return value;
}

function mergeProviders(target, source) {
  for (const key of PROVIDER_FIELDS) {
    if (!(key in source)) continue;
    if (key === 'provider') {
      for (const [id, provider] of Object.entries(source.provider || {})) {
        const previous = target.provider?.[id] || {};
        target.provider ||= {};
        target.provider[id] = mergeObjects(previous, provider);
      }
    } else target[key] = source[key];
  }
}

function mergeObjects(previous, next) {
  return Object.fromEntries([...new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])].map(key => {
    const left = previous?.[key];
    const right = next?.[key];
    if (!(key in (next || {}))) return [key, left];
    return [key, left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)
      ? mergeObjects(left, right) : right];
  }));
}

function createCompletionProfile(directory, sourceEnv = process.env, home = os.homedir()) {
  const globalDirectory = path.join(sourceEnv.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const sources = ['config.json', 'opencode.json', 'opencode.jsonc'].map(name => path.join(globalDirectory, name));
  if (sourceEnv.OPENCODE_CONFIG) sources.push(sourceEnv.OPENCODE_CONFIG);
  // 旧 Runtime 在用户主目录启动；仅继承其中供应商字段，权限和自动化配置不进入新服务。
  sources.push(path.join(home, 'opencode.json'), path.join(home, 'opencode.jsonc'));
  if (sourceEnv.OPENCODE_CONFIG_DIR) {
    sources.push(path.join(sourceEnv.OPENCODE_CONFIG_DIR, 'opencode.json'), path.join(sourceEnv.OPENCODE_CONFIG_DIR, 'opencode.jsonc'));
  }
  const config = {};
  for (const filename of [...new Set(sources)]) {
    if (!fs.existsSync(filename)) continue;
    try {
      const parsed = parseJsonc(fs.readFileSync(filename, 'utf8'));
      // 凭据只随进程环境传入，不复制到独立配置文件、日志或渲染进程。
      mergeProviders(config, resolveFileReferences(Object.fromEntries(
        PROVIDER_FIELDS.filter(key => key in parsed).map(key => [key, parsed[key]])
      ), path.dirname(filename)));
    } catch (_) { throw new Error(`无法读取 OpenCode 供应商配置：${path.basename(filename)}`); }
  }
  if (sourceEnv.OPENCODE_CONFIG_CONTENT) {
    try { mergeProviders(config, parseJsonc(sourceEnv.OPENCODE_CONFIG_CONTENT)); }
    catch (_) { throw new Error('无法读取 OpenCode 内联供应商配置'); }
  }
  Object.assign(config, {
    $schema: 'https://opencode.ai/config.json',
    permission: { '*': 'deny' }, tools: { '*': false },
    mcp: {}, plugin: [], instructions: [], snapshot: false,
    lsp: false, formatter: false, autoupdate: false, share: 'disabled'
  });
  const configHome = path.join(directory, 'config');
  const configDirectory = path.join(configHome, 'opencode');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.mkdirSync(path.join(directory, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'state'), { recursive: true });
  const env = {
    ...sourceEnv,
    XDG_CONFIG_HOME: configHome,
    // 单独保存会话数据库与锁状态；仅认证目录继续复用，避免 OAuth 副本过期或并发回写。
    OPENCODE_DB: path.join(directory, 'sessions.db'),
    XDG_STATE_HOME: path.join(directory, 'state'),
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_SHARE: 'true',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true'
  };
  // 自定义文件指针可能把全局插件/MCP 重新引入；认证数据目录保持原值以复用 OAuth。
  delete env.OPENCODE_CONFIG;
  return { cwd: path.join(directory, 'workspace'), env };
}

module.exports = { createCompletionProfile, parseJsonc };
