const path = require('path');
const { createRequire } = require('module');

// 打包后插件位于安装目录 plugins，依赖仍在 resources/app.asar/node_modules。
const resources = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
const appRequire = createRequire(path.join(resources, 'app.asar', 'package.json'));

function loadDependency(name) {
  try { return require(name); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return appRequire(name);
  }
}

function resolveDependency(name) {
  try { return require.resolve(name); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return appRequire.resolve(name);
  }
}

module.exports = { loadDependency, resolveDependency };
