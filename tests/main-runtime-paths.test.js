const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const startupImports = source.slice(0, source.indexOf('let autoUpdater = null;'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-packaged-imports-'));
try {
  const resources = path.join(fixture, 'resources');
  const archive = path.join(resources, 'app.asar');
  fs.mkdirSync(archive, { recursive: true });
  // 复现 extraResources 布局：ASAR 内没有 app，模块只位于 resources/app。
  for (const file of ['console-encoding.js', 'plugin_runtime/plugin-window-ready.js', 'plugin_runtime/opencode-runtime.js', 'plugin_runtime/opencode-profile.js', 'plugin_runtime/windows-hook-output.js', 'plugin_store.js', 'super_panel_context.js']) {
    const dest = path.join(resources, 'app', file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, 'app', file), dest);
  }
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
  }
  console.log('Main startup imports passed: development and packaged extraResources layout');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
