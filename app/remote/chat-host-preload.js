'use strict';
const { ipcRenderer, nativeImage } = require('electron');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const Module = require('module');
const appPath = ipcRenderer.sendSync('remote-chat-host-path');
if (!appPath) throw new Error('电脑执行器身份校验失败');
const hostRequire = Module.createRequire(path.join(appPath, 'package.json'));
const loadedCores = new Map();
// 独立插件位于 resources/app，依赖位于 app.asar；保留插件源码，只补充依赖查找目录。
function core(relative) {
  const file = path.resolve(__dirname, relative);
  if (!loadedCores.has(file)) {
    const instance = new Module(file, module); instance.filename = file;
    instance.paths = [...Module._nodeModulePaths(path.dirname(file)), path.join(appPath, 'node_modules')];
    instance._compile(fs.readFileSync(file, 'utf8'), file); loadedCores.set(file, instance.exports);
  }
  return loadedCores.get(file);
}
const { createAiRuntime } = require('../plugin_runtime/ai-runtime');
const { createToolRuntime } = require('../plugin_runtime/tool-runtime');
const { TEXT_TOOLS } = require('./chat-tools');
const { calculate } = require('./numeric-expression');
const ai = createAiRuntime('余汉波AI助手');
const tools = createToolRuntime({ pluginName: '手机聊天工具执行器', allowedTools: Object.keys(TEXT_TOOLS) });
function numeric(value, fallback, max) { const n = value == null ? fallback : Number(value); if (!Number.isFinite(n) || n < 1 || n > max) throw new Error('数值参数超出范围'); return Math.round(n); }
async function executeTool({ call, files, output }) {
  const { tool, input, options } = call;
  const directories = files.filter(item => item.directory), paths = files.filter(item => !item.directory).map(item => item.path);
  if(tool==='calculation-paper')return calculate(input);
  if (tool === 'line-processor' || tool === 'text-diff' || tool === 'regex-lab') {
    const textCore = core('../software/sanrenjz-tools-text-engineering/text-core.js');
    if (tool === 'line-processor') return textCore.processLines(input, options);
    if (tool === 'text-diff') return textCore.compareText(input, String(options.rightText || ''));
    return textCore.inspectRegex(input, String(options.pattern || ''), options.flags || 'g', options.replacement || '', options.replacement != null);
  }
  if (tool === 'csv-table') {
    const csvCore = core('../software/sanrenjz-tools-csv-data/csv-core.js');
    const delimiter = options.delimiter || csvCore.detectDelimiter(input); if (delimiter.length !== 1) throw new Error('CSV 分隔符必须为单字符');
    const rows = csvCore.parse(input, delimiter), view = csvCore.view(rows, options.query || '', options.sortColumn, 1);
    return { text: options.action === 'json' ? csvCore.toJson(view) : csvCore.toCsv(view, delimiter), inspection: csvCore.inspect(rows) };
  }
  if (TEXT_TOOLS[tool]) {
    const result = await tools.runTask({ toolId: tool, input, options: { ...options, count: numeric(options.count, 1, 100) } });
    if (!result.ok) throw new Error(result.error); return result.result;
  }
  if (tool === 'document-read') {
    const documentCore = core('../software/sanrenjz-tools-ai-document/document-service.js');
    return Promise.all(files.filter(item => !item.directory).map(async item => ({ ...await documentCore.readDocument(item.path), name: item.name })));
  }
  if (tool === 'file-checksum') {
    const rows = []; for (const file of files.filter(item=>!item.directory)) { const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk); rows.push({ name: file.name, sha256: hash.digest('hex') }); } return rows;
  }
  if (tool === 'directory-tree' || tool === 'file-content-search') {
    if (!directories.length) throw new Error('请先在手机选择电脑目录');
    const inspector = core('../software/sanrenjz-tools-file-inspector/inspector-service.js');
    return tool === 'directory-tree' ? inspector.tree(directories[0].path, { ...options, maxDepth: numeric(options.maxDepth, 3, 12) }) : inspector.search(directories.map(item => item.path), { ...options, extensions: Array.isArray(options.extensions) ? options.extensions.join(',') : options.extensions });
  }
  if (tool === 'qr-barcode') { await hostRequire('qrcode').toFile(output, input, { width: numeric(options.size, 480, 1200), margin: 2 }); return { artifact: output, mime: 'image/png', message: '二维码已生成' }; }
  if (tool === 'pdf-organizer') { const pdf = core('../software/sanrenjz-tools-pdf-studio/pdf-service.js');const result=await pdf.savePdf(paths.map(file => ({ path: file, pages: '' })), { mode: 'merge', rotation: options.rotation || 0, output }); return { pages:result.pages,message:`PDF 已生成，共 ${result.pages} 页`,artifact: output, mime: 'application/pdf' }; }
  if (tool === 'archive-tool') {
    const archive = core('../software/sanrenjz-tools-archive-studio/archive-service.js');
    if (options.action === 'create') {const result=archive.create(paths,output);return{files:result.files,bytes:result.bytes,message:`ZIP 已生成，包含 ${result.files} 个文件`,artifact:output,mime:'application/zip'};}
    if (!paths[0]) throw new Error('请先选择 ZIP 文件'); return archive.inspect(paths[0]);
  }
  if (tool === 'image-converter' || tool === 'image-resizer') {
    if (paths.length !== 1) throw new Error('请先选择一张图片');
    let image = nativeImage.createFromPath(paths[0]); if (image.isEmpty()) throw new Error('图片无法解码');
    if (tool === 'image-resizer') image = image.resize({ ...(options.width ? { width: numeric(options.width, 640, 4096) } : {}), ...(options.height ? { height: numeric(options.height, 640, 4096) } : {}), quality: 'best' });
    const jpg = options.format === 'jpg'; await fs.promises.writeFile(output, jpg ? image.toJPEG(numeric(options.quality, 90, 100)) : image.toPNG());
    return { artifact: output, mime: jpg ? 'image/jpeg' : 'image/png', dimensions: image.getSize() };
  }
  throw new Error('该工具没有可自动执行的业务接口');
}
let toolQueue = Promise.resolve();
ipcRenderer.on('remote-chat-job', async (_event, job) => {
  try {
    let value;
    if (job.method === 'cancel') { ai.cancel(job.value); return; }
    if (job.method === 'models') {
      const config = await ai.getConfig();
      value = { selected: config.selections.text, models: config.providers.flatMap(provider => provider.models.filter(model => !model.capabilities || model.capabilities.includes('text')).map(model => ({ providerId: provider.id, modelId: model.id, name: `${provider.name} / ${model.label || model.id}` }))) };
    } else if (job.method === 'complete') value = await ai.complete(job.value);
    else if (job.method === 'tool') { const result = toolQueue.then(() => executeTool(job.value)); toolQueue = result.catch(() => {}); value = await result; }
    else throw new Error('不支持的执行器任务');
    ipcRenderer.send('remote-chat-result', { id: job.id, value });
  } catch (error) { ipcRenderer.send('remote-chat-result', { id: job.id, error: error.message }); }
});
