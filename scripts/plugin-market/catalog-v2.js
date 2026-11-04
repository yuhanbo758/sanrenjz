/** 20 个合并工具套件与 10 个 AI 插件的唯一清单。 */
const suites = [
  ['structured-data','结构化数据工作台',['json-workbench','config-converter','xml-workbench'],'数据在格式之间流动、校验并精确定位节点。','#6d5dfc','split-orbit'],
  ['csv-data','CSV 数据表',['csv-table'],'像表格一样筛选、排序并在 CSV 与 JSON 之间转换。','#0f9d8a','sheet-grid'],
  ['code-security','编码与安全工具箱',['codec-assistant','hash-hmac','jwt-inspector','id-generator'],'编码、摘要、令牌与安全随机 ID 的组合工作区。','#e15b3d','vault-cards'],
  ['text-engineering','文本工程实验室',['regex-lab','text-diff','line-processor','text-encoding'],'正则、差异、行处理与文件编码集中调试。','#7c3aed','lab-console'],
  ['time-calculation','时间与计算中心',['time-converter','date-world-clock','unit-converter','calculation-paper'],'把时间、日期、单位和逐行计算放到同一张工作桌。','#1565c0','clock-dial'],
  ['file-batch','文件批处理中心',['batch-renamer','file-checksum'],'先预览命名和校验清单，再执行文件修改。','#c2410c','batch-rail'],
  ['file-inspector','文件检查工作台',['file-content-search','folder-compare','directory-tree'],'搜索内容、比较目录并生成结构树。','#2f6f62','explorer-tree'],
  ['pdf-studio','PDF 页面工作台',['pdf-organizer'],'合并、拆分、旋转、排序和提取 PDF 页面。','#b42318','page-stack'],
  ['archive-studio','压缩包工作台',['archive-tool'],'创建、预览并安全解压 ZIP，拦截越界路径。','#9a6700','archive-box'],
  ['image-optimizer','图片优化器',['image-compressor','image-converter','image-resizer'],'批量调整质量、格式和尺寸，并即时比较体积。','#d63384','image-stage'],
  ['image-creator','图片创作台',['image-watermark','image-collage','screenshot-beautifier'],'水印、拼接和截图美化共用一块可视画布。','#e8590c','canvas-islands'],
  ['visual-design','视觉设计实验室',['palette-extractor','color-workbench','svg-workbench'],'从图片与 SVG 中提取颜色，检查对比度并导出作品。','#5f3dc4','swatch-wall'],
  ['qr-barcode','二维码与条码工具',['qr-barcode'],'生成、识别、导出并保存最近使用记录。','#087f5b','scan-frame'],
  ['notes-center','本地笔记中心',['markdown-notes','floating-notes'],'Markdown 资料库与轻便便签并排管理。','#3b5bdb','paper-desk'],
  ['task-habit','任务与习惯',['todo-list','habit-tracker'],'把一次性任务和长期习惯放在同一条进度线上。','#2b8a3e','kanban-garden'],
  ['focus-worklog','专注与工时',['pomodoro-focus','worklog'],'专注计时直接沉淀为项目工时与周期报告。','#c92a2a','focus-ring'],
  ['launch-center','启动中心',['bookmark-launcher','project-launcher'],'网址、项目目录、启动命令和运行日志统一启动。','#364fc7','launch-radar'],
  ['lan-transfer','局域网快传',['lan-transfer'],'创建临时局域网接收站，传输文字与文件。','#00838f','network-nodes'],
  ['image-pinboard','图片悬浮板',['image-pinboard'],'从剪贴板取图，置顶查看并控制缩放、旋转与透明度。','#ad1457','floating-frame'],
  ['hosts-center','Hosts 配置中心',['hosts-manager'],'配置组、差异预览、自动备份与权限反馈。','#455a64','host-map']
].map((item,index)=>({id:item[0],folder:`sanrenjz-tools-${item[0]}`,name:item[1],tools:item[2],description:item[3],accent:item[4],layout:item[5],order:index+1,type:'suite'}));

const aiPlugins = [
  ['ai-writing','AI 写作工作室','draft-quill','#c026d3','导入素材，设定受众与语气，完成润色、改写、大纲、续写、校对和摘要。',['润色','改写','扩写','缩写','标题','大纲','续写','校对','摘要']],
  ['ai-document','AI 文档阅读器','reading-room','#2563eb','拖拽导入 Word、PDF、XLSX 与文本，提取信息、审校、对比文档并问答。',['摘要','目录','文档问答','DOC 阅读','PDF 阅读','XLSX 阅读','文档对比']],
  ['ai-meeting','AI 会议纪要','meeting-board','#0f766e','录音转写、导入会议资料，整理议题、决策、待办与风险。',['整理纪要','提取决策','提取待办','录音转写','上传会议资料']],
  ['ai-code-review','AI 代码审查','review-terminal','#dc2626','检查代码或 Git Diff，按严重程度输出问题，不改动文件。',['审查代码','审查 Diff','安全检查']],
  ['ai-regex','AI 正则助手','regex-blueprint','#7c3aed','用自然语言生成、解释和修复正则，并在本地样本上验证。',['生成正则','解释正则','修复正则']],
  ['ai-sql','AI SQL 助手','query-plan','#ca8a04','按数据库方言生成、解释、格式化和优化 SQL，不连接数据库。',['生成 SQL','解释 SQL','优化 SQL']],
  ['ai-git','AI Git 助手','commit-graph','#ea580c','拖入 Git 项目，按范围生成提交说明、变更日志、Release Notes、PR 描述与变更风险分析。',['提交说明','变更日志','Release Notes','PR 描述','变更风险']],
  ['ai-prompt','AI 提示词工坊','prompt-layers','#4f46e5','管理本地与文件夹提示词，通过 @ 插入、变量填充和 AI 优化生成副本。',['优化提示词','提示词模板','提示词变量']],
  ['ai-image','AI 图片理解','vision-lens','#db2777','生成图片描述、标签、无障碍文本、分析和反向提示词。',['图片描述','标签','无障碍文本','反向提示词']],
  ['ai-learning','AI 学习卡片','study-deck','#16a34a','从文本或文档生成知识点、问答、术语表、测试题和 Anki CSV。',['知识卡片','测试题','术语表','Anki CSV']]
].map((item,index)=>({id:item[0],folder:`sanrenjz-tools-${item[0]}`,name:item[1],layout:item[2],accent:item[3],description:item[4],actions:item[5],order:index+21,type:'ai'}));

const removedTools = ['clipboard-history','local-file-search','disk-analyzer','process-monitor','port-inspector','environment-manager'];
const catalog = [...suites,...aiPlugins];
module.exports = { suites, aiPlugins, removedTools, catalog };
