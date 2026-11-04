const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { catalog } = require('../scripts/plugin-market/catalog');

const root = path.resolve(__dirname, '..');
const output = process.argv[2] || path.join(root, 'dist', 'plugin-icon-gallery');

/**
 * 把真实 PNG 嵌入检查页，避免 file 协议路径、中文目录或空格影响截图结果。
 * 每张卡片同时显示业务名称和图形名称，便于快速发现重复、错义和小尺寸模糊。
 */
function createCards() {
  return catalog.map((plugin) => {
    const directory = path.join(root, 'app', 'software', plugin.folder);
    const png = fs.readFileSync(path.join(directory, 'logo.png')).toString('base64');
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'icon-source.json'), 'utf8'));
    return `<article><img src="data:image/png;base64,${png}" alt="${plugin.name}"><div><b>${plugin.name}</b><small>${source.name}</small></div></article>`;
  }).join('');
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(output, { recursive: true });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{margin:0;background:#eef2f8;color:#172033;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
      body{padding:28px}header{display:flex;align-items:end;justify-content:space-between;margin-bottom:22px}
      h1{margin:0;font-size:28px}p{margin:0;color:#68748a;font-size:14px}
      main{display:grid;grid-template-columns:repeat(6,1fr);gap:18px}
      article{display:flex;align-items:center;gap:13px;min-width:0;padding:14px;background:#fff;border:1px solid #dde4ef;border-radius:18px;box-shadow:0 8px 22px rgba(30,50,85,.08)}
      img{width:72px;height:72px;flex:none;object-fit:contain}div{min-width:0}b,small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      b{font-size:14px;line-height:1.35}small{margin-top:6px;color:#8390a6;font:12px Consolas,monospace}
    </style></head><body><header><h1>30 个插件图标检查</h1><p>Tabler Icons 3.44.0 · 语义图形各不重复</p></header><main>${createCards()}</main></body></html>`;
    const page = path.join(output, 'contact-sheet.html');
    fs.writeFileSync(page, html, 'utf8');
    const window = new BrowserWindow({ show: false, width: 1800, height: 840, webPreferences: { sandbox: true } });
    await window.loadFile(page);
    await window.webContents.executeJavaScript('Promise.all([...document.images].map(image => image.decode()))');
    fs.writeFileSync(path.join(output, 'contact-sheet.png'), (await window.webContents.capturePage()).toPNG());
    window.destroy();
    console.log(`图标检查画廊已生成：${output}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
