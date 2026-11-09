const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
// 导入验证止于首个业务启动操作；边界消失必须明确失败，不能让slice(-1)执行整个主进程。
const startupBoundary = source.indexOf('const gotSingleInstanceLock = app.requestSingleInstanceLock();');
assert.ok(startupBoundary > 0, '主进程启动导入边界不存在，请更新导入验证范围');
const startupImports = source.slice(0, startupBoundary);
const temporaryParent = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temporaryParent, 'tools-packaged-imports-'));
try {
  const resources = path.join(fixture, 'resources');
  const archive = path.join(resources, 'app.asar');
  fs.mkdirSync(archive, { recursive: true });
  // 按真实打包规则提供宿主JS及公共运行时依赖，ASAR内保持没有app目录。
  const appResources = require('../package.json').build.extraResources.find(entry => entry.from === 'app' && entry.to === 'app');
  assert.ok(appResources?.filter.includes('*.js') && appResources.filter.includes('plugin_runtime/**/*'), '运行模块必须纳入extraResources');
  const applicationModules = path.join(root, 'app'), packagedModules = path.join(resources, 'app');
  fs.mkdirSync(packagedModules, { recursive: true });
  for (const entry of fs.readdirSync(applicationModules, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) fs.copyFileSync(path.join(applicationModules, entry.name), path.join(packagedModules, entry.name));
  }
  fs.cpSync(path.join(applicationModules, 'plugin_runtime'), path.join(packagedModules, 'plugin_runtime'), {
    recursive: true, filter: filename => fs.statSync(filename).isDirectory() || filename.endsWith('.js')
  });
  for (const packaged of [false, true]) {
    const localRequire = createRequire(path.join(packaged ? archive : root, 'main.js'));
    const imports = [];
    vm.runInNewContext(startupImports, {
      process: { resourcesPath: resources, env: {} },
      require(name) {
        if (name === 'electron') return { app: { isPackaged: packaged, setName() {}, setPath() {}, getPath() { return fixture; } } };
        const value = localRequire(name);
        imports.push(name);
        return value;
      }
    });
    assert.ok(imports.some(name => name.includes('opencode-runtime')));
    assert.ok(imports.some(name => name.includes('plugin-window-ready')));
    assert.ok(imports.some(name => name.includes('release-updates')));
    assert.ok(!fs.existsSync(path.join(archive, 'app')), '打包夹具不能从ASAR内意外加载app模块');
  }
  console.log('Main startup imports passed: development and packaged extraResources layout');
} finally {
  assert.strictEqual(path.dirname(path.resolve(fixture)), temporaryParent);
  assert.ok(path.basename(fixture).startsWith('tools-packaged-imports-') && !fs.lstatSync(fixture).isSymbolicLink());
  fs.rmSync(fixture, { recursive: true, force: true });
}
