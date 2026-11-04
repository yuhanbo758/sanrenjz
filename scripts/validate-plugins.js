const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { catalog, suites, aiPlugins, removedTools } = require('./plugin-market/catalog');

const root = path.resolve(__dirname, '..');
const software = path.join(root, 'app', 'software');
const errors = [];
const codes = new Map();
const layouts = new Set();
const iconNames = new Set();
const required = ['plugin.json','index.html','preload.js','logo.svg','logo.png','logo.ico','icon-source.json','README.md'];

function fail(message) { errors.push(message); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch (error) { fail(`${file}: ${error.message}`); return null; } }

for (const entry of fs.readdirSync(software,{withFileTypes:true}).filter(item=>item.isDirectory())) {
  const file=path.join(software,entry.name,'plugin.json');
  if (!fs.existsSync(file)) continue;
  const manifest=readJson(file); if(!manifest) continue;
  for(const feature of manifest.features||[]){
    if(codes.has(feature.code)) fail(`${feature.code} 同时出现在 ${codes.get(feature.code)} 与 ${entry.name}`);
    codes.set(feature.code,entry.name);
  }
}

for(const plugin of catalog){
  const directory=path.join(software,plugin.folder);
  if(!fs.existsSync(directory)){fail(`${plugin.folder}: 目录不存在`);continue;}
  for(const file of required) if(!fs.existsSync(path.join(directory,file))) fail(`${plugin.folder}: 缺少 ${file}`);
  const iconLicense=path.join(directory,'THIRD_PARTY_LICENSES','Tabler-Icons-LICENSE.txt');
  if(!fs.existsSync(iconLicense))fail(`${plugin.folder}: 缺少 Tabler Icons MIT 许可证`);
  const manifest=readJson(path.join(directory,'plugin.json'));if(!manifest)continue;
  if(manifest.pluginName!==plugin.name)fail(`${plugin.folder}: 名称不匹配`);
  if(manifest.pluginSetting?.width!==1180||manifest.pluginSetting?.height!==760)fail(`${plugin.folder}: 默认窗口不是 1180x760`);
  if(manifest.pluginSetting?.minWidth>900||manifest.pluginSetting?.minHeight>650)fail(`${plugin.folder}: 无法缩放到 900x650`);
  const expected=plugin.type==='suite'?plugin.tools.map(id=>`plugin-market-${id}`):[`plugin-market-${plugin.id}`];
  for(const code of expected)if(!manifest.features?.some(feature=>feature.code===code))fail(`${plugin.folder}: 缺少旧入口 ${code}`);
  const html=fs.readFileSync(path.join(directory,'index.html'),'utf8');
  if(plugin.type==='ai'&&!html.includes('data-business'))fail(`${plugin.folder}: 缺少独立业务交互层`);
  if(/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html))fail(`${plugin.folder}: 引用了远程脚本或样式`);
  if(!/html,body\s*\{[^}]*height:100%[^}]*overflow:hidden/s.test(html))fail(`${plugin.folder}: 未禁止页面级滚动`);
  if(!html.includes('padding-top:32px'))fail(`${plugin.folder}: 未给主程序窗口控制栏留出空间`);
  const layout=html.match(/data-layout="([^"]+)"/)?.[1];
  if(!layout)fail(`${plugin.folder}: 缺少独立布局标识`);else if(layouts.has(layout))fail(`${plugin.folder}: 布局标识重复 ${layout}`);else layouts.add(layout);
  if(/准备就绪|所有数据默认仅在本机处理|本地处理|\d+\s*·\s*系统工具/.test(html))fail(`${plugin.folder}: 含有废弃模板文案`);
  for(const script of ['preload.js']){const result=spawnSync(process.execPath,['--check',path.join(directory,script)],{encoding:'utf8'});if(result.status!==0)fail(`${plugin.folder}/${script}: ${result.stderr.trim()}`);}
  // 图标必须保留可追溯来源，而且 30 个插件不能再次退化成同一图形的换色模板。
  const iconSource=readJson(path.join(directory,'icon-source.json'));
  if(iconSource){
    if(iconSource.collection!=='Tabler Icons'||iconSource.license!=='MIT'||!iconSource.sourceUrl?.startsWith('https://raw.githubusercontent.com/tabler/tabler-icons/'))fail(`${plugin.folder}: 图标来源信息不完整`);
    if(iconNames.has(iconSource.name))fail(`${plugin.folder}: 图标图形重复 ${iconSource.name}`);else iconNames.add(iconSource.name);
  }
  const svg=fs.readFileSync(path.join(directory,'logo.svg'),'utf8');
  if(/<text\b/i.test(svg))fail(`${plugin.folder}: SVG 不应使用文字充当图标`);
  if(!svg.includes('aria-label='))fail(`${plugin.folder}: SVG 缺少无障碍名称`);
  const ico=fs.readFileSync(path.join(directory,'logo.ico'));if(ico.length<64||ico.readUInt16LE(2)!==1||ico.readUInt16LE(4)<5)fail(`${plugin.folder}: ICO 不完整`);
}

for(const removed of removedTools)if(codes.has(`plugin-market-${removed}`))fail(`应删除的系统重复入口仍存在：${removed}`);
const expectedOld=suites.reduce((sum,item)=>sum+item.tools.length,0);
if(expectedOld!==44)fail(`合并功能应为 44 个，实际 ${expectedOld}`);
if(suites.length!==20||aiPlugins.length!==10||catalog.length!==30)fail(`目录数量错误：${suites.length}+${aiPlugins.length}`);
for(const file of ['tool-runtime.js','ai-runtime.js']){const full=path.join(root,'app','plugin_runtime',file);const result=spawnSync(process.execPath,['--check',full],{encoding:'utf8'});if(result.status!==0)fail(`plugin_runtime/${file}: ${result.stderr.trim()}`);}

if(errors.length){console.error(`插件校验失败（${errors.length} 项）\n${errors.map(item=>`- ${item}`).join('\n')}`);process.exit(1);}
console.log(`插件校验通过：20 个工具套件、10 个 AI 插件、44 个旧功能入口、${codes.size} 个全局 Feature Code。`);
