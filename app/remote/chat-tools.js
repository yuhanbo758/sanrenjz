'use strict';
// 只登记能返回真实结果的业务接口；界面入口不能冒充可自动执行的工具。
const TEXT_TOOLS = {
  'json-workbench': ['JSON 格式化、压缩、查询', 'action=format|minify; query=可选字段路径'],
  'config-converter': ['JSON/YAML/TOML/Properties 转换（简单平面配置）', 'source/target=json|yaml|toml|properties'],
  'xml-workbench': ['XML 格式化或压缩', 'action=format|minify'],
  'codec-assistant': ['Base64、URL、HEX、Unicode、HTML 编解码', 'action=base64-encode|base64-decode|url-encode|url-decode|hex-encode|hex-decode|unicode-encode|unicode-decode|html-encode|html-decode'],
  'hash-hmac': ['文本摘要', 'algorithm=sha256|sha512|sha1|md5; encoding=hex|base64'],
  'id-generator': ['生成 UUID 或随机标识', 'type=uuid|random; count=1..100'],
  'time-converter': ['日期与时间戳转换', 'timeZone=可选 IANA 时区'],
  'date-world-clock': ['日期加减天数', 'days=整数'],
  'unit-converter': ['长度、重量、面积、速度、温度换算', 'unitType=length|weight|area|speed|temperature; fromUnit/toUnit=单位代码'],
  'calculation-paper': ['纯数值四则运算', '无 options；仅数值与算术运算符'],
  'color-workbench': ['HEX 颜色、RGB 与对比度', '无 options'],
  'text-diff': ['比较两段文本', 'rightText=第二段文本'],
  'line-processor': ['文本行去重、排序、编号、筛选', 'unique/sort/number/trim/removeEmpty/reverse=布尔; filter/prefix/suffix=文本'],
  'csv-table': ['CSV 检查、排序、转换 JSON', 'action=json|csv; delimiter=单字符; query=筛选文本; sortColumn=列索引'],
  'regex-lab': ['正则匹配与替换', 'pattern=表达式; flags=gimsuy; replacement=可选替换文本']
};
const EXTRA_TOOLS = {
  'qr-barcode': ['生成二维码图片', 'size=128..1200'],
  'document-read': ['从已选择的 PDF/DOC/DOCX/XLSX/文本附件提取文字', '无 options'],
  'file-checksum': ['计算已选择文件的 SHA256', '无 options'],
  'directory-tree': ['读取已选择目录的目录树', 'format=text|markdown|json; showSize=布尔; maxDepth=1..12'],
  'file-content-search': ['搜索已选择目录内的文件内容', 'query=关键词; extensions=后缀列表'],
  'pdf-organizer': ['将已选择 PDF 合并成新文件', 'rotation=0|90|180|270'],
  'archive-tool': ['将已选择文件生成新 ZIP，或查看 ZIP 内容', 'action=create|inspect'],
  'image-converter': ['将已选择图片转换成 PNG/JPEG', 'format=png|jpg; quality=1..100'],
  'image-resizer': ['调整已选择图片尺寸并生成新图片', 'width/height=1..4096; format=png|jpg; quality=1..100'],
  'markdown-notes': ['在本地笔记中心新增笔记（需确认）', 'title=标题'],
  'cast-status': ['获取电脑媒体投放状态', '无 options'],
  'cast-enqueue': ['将链接或已选择媒体加入电脑播放队列（需确认）', 'url=HTTP(S) 可播放链接; title=标题']
};
const PLUGIN_OVERRIDES = { 'document-read': 'sanrenjz-tools-ai-document', 'markdown-notes': 'sanrenjz-tools-notes-center', 'cast-status': 'sanrenjz-tools-cast-receiver', 'cast-enqueue': 'sanrenjz-tools-cast-receiver' };
const CONFIRM = new Set(['markdown-notes', 'cast-enqueue']);
function definitions(plugins) {
  const result = [];
  for (const [id, [description, options]] of Object.entries({ ...TEXT_TOOLS, ...EXTRA_TOOLS })) {
    const plugin = plugins.find(p => PLUGIN_OVERRIDES[id] ? p.id === PLUGIN_OVERRIDES[id] : p.features.some(f => f.code === `plugin-market-${id}`));
    if (plugin) result.push({ id, pluginId: plugin.id, pluginName: plugin.name, description, options, confirmation: CONFIRM.has(id) });
  }
  return result;
}
function validateCall(call, available) {
  if (!call || !available.some(tool => tool.id === call.tool)) throw new Error('AI 选择的工具未登记或未安装');
  const input = call.input == null ? '' : call.input;
  if (typeof input !== 'string' || input.length > 100000) throw new Error('工具输入过长或格式无效');
  const options = call.options || {};
  if (!options || typeof options !== 'object' || Array.isArray(options) || JSON.stringify(options).length > 110000) throw new Error('工具参数无效');
  // 路径仅来自用户选定的附件能力，禁止模型直接指定磁盘路径、输出路径或执行代码。
  const allowed = new Set(['action','source','target','query','algorithm','encoding','type','count','length','timeZone','days','unitType','fromUnit','toUnit','rightText','unique','sort','number','trim','removeEmpty','reverse','filter','prefix','suffix','delimiter','sortColumn','pattern','flags','replacement','size','format','showSize','maxDepth','extensions','rotation','quality','width','height','title','url']);
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key) || (typeof value === 'object' && !(key === 'extensions' && Array.isArray(value) && value.every(v => typeof v === 'string')))) throw new Error(`工具不接受参数：${key}`);
  }
  if (call.tool === 'calculation-paper' && !/^[\d\s+\-*/%().eE]+$/.test(input)) throw new Error('远程计算只接受数值表达式，不接受 JavaScript 或变量');
  if (options.algorithm && !['sha256','sha512','sha1','md5'].includes(options.algorithm)) throw new Error('不支持的摘要算法');
  if (options.encoding && !['hex','base64'].includes(options.encoding)) throw new Error('不支持的摘要输出格式');
  if (options.flags && !/^[gimsuy]*$/.test(options.flags)) throw new Error('正则标记无效');
  return { tool: call.tool, input, options };
}
module.exports = { TEXT_TOOLS, EXTRA_TOOLS, CONFIRM, definitions, validateCall };
