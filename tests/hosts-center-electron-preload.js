const { inspect } = require('../app/software/sanrenjz-tools-hosts-center/hosts-service');
let content = '127.0.0.1 localhost\n';
window.pluginAPI = {
  inspectHosts: inspect,
  readHosts: async () => ({ ok: true, result: { content, revision: 'fixture', hostsPath: '临时测试文件', bom: false, eol: '\n' } }),
  writeHosts: async payload => { content = payload.content; return { ok: true, result: { backup: '临时测试备份' } }; },
  copyText: text => { window.copiedForTest = text; },
  showPath: () => {}
};
