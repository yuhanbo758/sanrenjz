'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');
const packagedIndex = process.argv.indexOf('--packaged');
const packaged = packagedIndex >= 0;
const executable = packaged ? path.resolve(process.argv[packagedIndex + 1] || '') : require('electron');
if (packaged && (!process.argv[packagedIndex + 1] || !fs.statSync(executable).isFile())) throw new Error('请提供真实解包程序的 EXE');
const mode = packaged ? 'packaged' : 'source';
const output = path.join(root, 'dist', 'account-avatar-validation'); fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-avatar-'));
const profile = path.join(temporary, 'profile'); fs.mkdirSync(profile);
const settings = JSON.stringify({ migrationPrompted: true, pythonMode: 'none', autoStart: false, globalHotkey: '', pinHotkey: '', superPanelHotkey: '', enableRightClickPanel: false });
fs.writeFileSync(path.join(profile, 'settings.json'), settings);
const expectedBytes = fs.readFileSync(path.join(root, 'build', 'icon.png'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expectedHash = sha256(expectedBytes);
const report = { mode, hidden: true, isolatedProfile: true, realAuthentication: false, localOnly: true, assertions: [], errors: [], screenshots: [], processes: [], expectedLogoSha256: expectedHash };
const anonymousRequests = [];
const anonymousShop = http.createServer((request, response) => {
    anonymousRequests.push({ method: request.method, status: 401, hasCookie: Boolean(request.headers.cookie), hasAuthorization: Boolean(request.headers.authorization) });
    response.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end('{"authenticated":false}');
});
const check = (value, label) => { if (!value) throw new Error(label); report.assertions.push(label); };
const env = { ...process.env, SANRENJZ_USER_DATA: profile, SANRENJZ_ACCEPTANCE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const args = [...(packaged ? [] : [root]), '--remote-debugging-port=0', '--disable-gpu'];
let child, childClosed, log = '', connection, serial = 0, closed = true, exitCode, exitSignal;
const pending = new Map();
function startApp(phase) {
    if (!closed) throw new Error('上一测试进程尚未关闭');
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    closed = false; exitCode = undefined; exitSignal = undefined;
    child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const processReport = { phase, pid: child.pid }; report.processes.push(processReport);
    childClosed = new Promise(resolve => child.once('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; Object.assign(processReport, { exitCode: code, signal }); resolve(); }));
    child.stdout.on('data', bytes => { log += bytes.toString('utf8'); }); child.stderr.on('data', bytes => { log += bytes.toString('utf8'); });
    child.once('error', error => { report.errors.push(error.message); });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; if (closed) throw new Error(`程序提前退出：${exitCode}`); await delay(30); }
    throw new Error(label);
}
function command(method, params = {}) {
    const id = ++serial;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP超时：${method}`)); }, 15000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        connection.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
}
async function connectApp() {
    let page;
    await until(async () => {
        const active = path.join(profile, 'DevToolsActivePort'); if (!fs.existsSync(active)) return false;
        // Chromium写入握手文件时Windows可能短暂独占；在同一有界就绪等待中读取完整端口。
        try {
            const port = fs.readFileSync(active, 'utf8').split('\n')[0]; if (!/^\d+$/.test(port)) return false;
            page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page' && /index\.html/.test(item.url));
        } catch (_) { return false; }
        return Boolean(page);
    }, '未找到真实主界面的CDP端点');
    connection = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { connection.once('open', resolve); connection.once('error', reject); });
    connection.on('message', bytes => { const message = JSON.parse(String(bytes)); if (!pending.has(message.id)) return; const request = pending.get(message.id); pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); });
    await until(() => evaluate("typeof updateAccountUI==='function' && Boolean(document.getElementById('account-avatar-select-btn'))"), '本地头像UI未初始化');
    check(await evaluate("loadAccount().then(()=>new Promise(resolve=>setImmediate(()=>resolve(accountState.authenticated===false))))"), '本地401匿名账号初始化完成后才测试头像显示');
}
async function quitApp(label) {
    await evaluate("setImmediate(()=>require('@electron/remote').app.quit()); true;").catch(() => {});
    let deadline;
    await Promise.race([childClosed, new Promise(resolve => { deadline = setTimeout(resolve, 12000); })]); clearTimeout(deadline);
    check(closed && exitCode === 0, `${label}正常退出且退出码为0`);
    connection?.close(); connection = null;
}
const getPreference = () => evaluate("require('electron').ipcRenderer.invoke('account-avatar:get')");
async function setPicker(result) {
    // 仅在独立验收进程中替换系统选择器，保留真实IPC、图片解码和存储路径。
    const script = `dialog.showOpenDialog = async () => (${JSON.stringify(result)});`;
    await evaluate(`(()=>{const remote=require('@electron/remote');remote.require('vm').runInNewContext(${JSON.stringify(script)},{dialog:remote.dialog});return true;})()`);
}
async function clickAvatar(id) { await evaluate(`document.getElementById(${JSON.stringify(id)}).click();true;`); }
async function traceAvatarOperations() {
    await evaluate("(()=>{const ipc=require('electron').ipcRenderer,original=ipc.invoke.bind(ipc);window.__avatarTrace=[];window.__accountRenderTrace=[];const renderAccount=updateAccountUI;updateAccountUI=account=>{window.__accountRenderTrace.push({authenticated:!!account?.authenticated,fixture:!!account?.user?.id?.startsWith('avatar-fixture')});return renderAccount(account);};ipc.invoke=(channel,...args)=>{const result=original(channel,...args);if(!['account-avatar:select','account-avatar:reset'].includes(channel))return result;return result.then(value=>{window.__avatarTrace.push({channel,custom:value.custom,cancelled:!!value.cancelled});return value;},error=>{window.__avatarTrace.push({channel,error:true});throw error;});};return true;})()");
}
async function clickOperation(id, label, expectsError = false) {
    const before = await evaluate('window.__avatarTrace.length');
    await clickAvatar(id);
    await until(() => evaluate(`window.__avatarTrace.length>${before} && !document.getElementById('account-avatar-select-btn').disabled`), `${label}IPC未完成`);
    const result = await evaluate('window.__avatarTrace[window.__avatarTrace.length-1]');
    check(Boolean(result.error) === expectsError, `${label}真实IPC${expectsError ? '拒绝无效文件' : '成功返回'}`);
    return result;
}
async function customLoaded(dataUrl, label) {
    const hash = sha256(Buffer.from(dataUrl.split(',')[1], 'base64'));
    await until(async () => { const image = await logoState(); return image.visible && image.complete && image.width > 0 && image.hash === hash; }, `${label}：自定义头像未加载`);
    check((await logoState()).hash === hash, `${label}显示本地存储返回的PNG`);
}
function pngChunks(bytes) {
    const types = [];
    for (let offset = 8; offset + 12 <= bytes.length;) { const size = bytes.readUInt32BE(offset); types.push(bytes.toString('ascii', offset + 4, offset + 8)); offset += size + 12; }
    return types;
}
function addFixtureMetadata(png) {
    const text = Buffer.from('Comment\0fixture-only-no-personal-data'), type = Buffer.from('tEXt');
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([type, text])) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    const chunk = Buffer.alloc(text.length + 12); chunk.writeUInt32BE(text.length); type.copy(chunk, 4); text.copy(chunk, 8); chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    return Buffer.concat([png.subarray(0, png.length - 12), chunk, png.subarray(png.length - 12)]);
}
async function logoState() {
    return evaluate(`(() => { const image=document.getElementById('account-avatar'),button=document.getElementById('avatar-btn'); return { visible:!image.hidden&&getComputedStyle(image).display!=='none',complete:image.complete,width:image.naturalWidth,height:image.naturalHeight,hash:require('crypto').createHash('sha256').update(Buffer.from(image.src.split(',')[1]||'','base64')).digest('hex'),data:image.src.startsWith('data:image/png;base64,'),member:button.classList.contains('member'),after:getComputedStyle(button,'::after').content,buttonChildren:button.children.length }; })()`);
}
async function loaded(label) {
    await until(async () => { const image = await logoState(); return image.visible && image.complete && image.width === 1024; }, `${label}：logo未加载`);
    const image = await logoState();
    check(image.width === 1024 && image.height === 1024 && image.hash === expectedHash && image.data, `${label}使用1024px原始logo且字节SHA256一致`);
    return image;
}
async function capture(name) {
    const image = await evaluate(`(() => { const element=document.getElementById('header'),r=element.getBoundingClientRect(); return require('@electron/remote').getCurrentWindow().webContents.capturePage({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}).then(image=>image.toPNG().toString('base64')); })()`);
    const filename = `${mode}-${name}.png`; fs.writeFileSync(path.join(output, filename), Buffer.from(image, 'base64')); report.screenshots.push(filename);
}
async function captureMenu(name) {
    await evaluate("if(!document.getElementById('account-dropdown').classList.contains('show'))document.getElementById('avatar-btn').click();true;");
    const image = await evaluate("(()=>{const r=document.getElementById('account-dropdown').getBoundingClientRect();return require('@electron/remote').getCurrentWindow().webContents.capturePage({x:Math.max(0,Math.floor(r.left)-8),y:0,width:Math.ceil(r.width)+16,height:Math.ceil(r.bottom)+8}).then(image=>image.toPNG().toString('base64'));})()");
    const filename = `${mode}-${name}.png`; fs.writeFileSync(path.join(output, filename), Buffer.from(image, 'base64')); report.screenshots.push(filename);
    await evaluate('document.body.click();true;');
}

(async () => {
    try {
        await new Promise((resolve, reject) => { anonymousShop.once('error', reject); anonymousShop.listen(0, '127.0.0.1', resolve); });
        env.SANRENJZ_TOOLS_SHOP_BASE_URL = `http://127.0.0.1:${anonymousShop.address().port}`;
        startApp('initial'); await connectApp();
        const layout = await evaluate("({packaged:require('@electron/remote').app.isPackaged,version:require('@electron/remote').app.getVersion(),visible:require('@electron/remote').getCurrentWindow().isVisible(),resourcesPath:process.resourcesPath,appDirectory:avatarDocumentDirectory,rendererDirectory:__dirname,hasRelativeLogo:require('fs').existsSync(require('path').join(avatarDocumentDirectory,'build','icon.png'))})");
        check(layout.packaged === packaged && !layout.visible, '实际目标模式匹配且窗口始终隐藏');
        report.version = layout.version;
        report.resourceLayout = layout;
        if (packaged) {
            let asar; try { asar = require('@electron/asar'); } catch (_) { asar = require('asar'); }
            const resources = path.join(path.dirname(executable), 'resources');
            const archived = asar.listPackage(path.join(resources, 'app.asar')).map(name => name.replace(/\\/g, '/').replace(/^\//, ''));
            check(!archived.includes('build/icon.png') && !layout.hasRelativeLogo, '真实ASAR内部没有build/icon.png');
            check(fs.existsSync(path.join(resources, 'build', 'icon.png')) && sha256(fs.readFileSync(path.join(resources, 'build', 'icon.png'))) === expectedHash, '真实resources/build包含同一PNG资源');
        } else check(layout.hasRelativeLogo, '源态从实际build目录读取PNG');
        const initialPreference = await getPreference();
        await traceAvatarOperations();
        check(initialPreference.custom === false && initialPreference.dataUrl === null, '独立profile默认没有本机头像');
        await until(() => evaluate("document.getElementById('account-avatar-reset-btn').disabled"), '默认状态未禁用恢复按钮');
        check(await evaluate("Boolean(document.getElementById('account-avatar-select-btn') && document.getElementById('account-avatar-reset-btn').disabled && document.querySelector('.account-avatar-note').textContent.includes('本机'))"), '未登录也提供本机头像入口，默认禁用恢复操作');
        await loaded('未登录'); await capture('logged-out');
        // 只清理本次临时会话，阻断匿名初始请求的迟到结果；显示状态通过UI函数模拟，不伪造服务端认证。
        await evaluate("require('electron').ipcRenderer.invoke('account:logout').then(account=>{updateAccountUI(account);return true;})");
        await captureMenu('local-default-menu');
        await evaluate("updateAccountUI({authenticated:true,user:{id:'avatar-fixture-a',username:'头像验收A'},access:{tools:{available:true,member:false},python:{available:true,member:false}}}); true;");
        await loaded('模拟登录无头像'); await capture('logged-in-no-avatar');
        // 在同一渲染任务内检查模拟会员；匿名账号查询的迟到结果不应被误当作CSS回归。
        const member = await evaluate("(()=>{updateAccountUI({authenticated:true,user:{id:'avatar-fixture-a',username:'头像验收A'},access:{tools:{available:true,member:true},python:{available:true,member:false}}});const button=document.getElementById('avatar-btn');return {member:button.classList.contains('member'),after:getComputedStyle(button,'::after').content,buttonChildren:button.children.length};})()");
        report.membershipRenderSnapshot = member;
        check(member.member && ['none', 'normal', '""'].includes(member.after) && member.buttonChildren === 1, '会员状态不添加覆盖logo的角标');
        await loaded('会员账号');
        report.accountRenderTrace = await evaluate('window.__accountRenderTrace');
        await capture('member');
        await evaluate("updateAccountUI({authenticated:true,user:{id:'avatar-fixture-b',username:'头像验收B'},access:{tools:{available:true,member:false},python:{available:true,member:true}}}); true;");
        await loaded('切换账号');
        await evaluate("updateAccountUI({authenticated:false,user:null,access:{}}); true;");
        const loggedOut = await loaded('退出登录'); check(!loggedOut.member, '退出后清除会员边框且保留logo');
        await evaluate("window.__avatarErrorProbe={seen:false,hidden:false};document.getElementById('account-avatar').addEventListener('error',()=>{window.__avatarErrorProbe={seen:true,hidden:document.getElementById('account-avatar').hidden};},{once:true});document.getElementById('account-avatar').src='data:image/png;base64,invalid-image';true;");
        await until(() => evaluate('window.__avatarErrorProbe.seen'), '坏图片未触发error回退');
        check(await evaluate('window.__avatarErrorProbe.hidden'), '图片加载失败时立即隐藏，避免显示破图图标');
        await loaded('坏图片回退'); await capture('bad-image-recovered');

        const fixtures = path.join(temporary, 'fixtures'); fs.mkdirSync(fixtures);
        const raster = await evaluate("(()=>{const pixels=Buffer.alloc(64*64*4);for(let p=0;p<pixels.length;p+=4){pixels[p]=201;pixels[p+1]=99;pixels[p+2]=17;pixels[p+3]=160;}const image=require('electron').nativeImage.createFromBitmap(pixels,{width:64,height:64});return {png:image.toPNG().toString('base64'),jpeg:image.toJPEG(90).toString('base64')};})()");
        const pngFile = path.join(fixtures, '本机头像 fixture.png'), jpegFile = path.join(fixtures, '本机头像 fixture.jpeg'), webpFile = path.join(fixtures, '本机头像 fixture.webp'), invalidFile = path.join(fixtures, 'invalid.png');
        fs.writeFileSync(pngFile, addFixtureMetadata(Buffer.from(raster.png, 'base64')));
        fs.writeFileSync(jpegFile, Buffer.from(raster.jpeg, 'base64'));
        // 3×3半透明纯色图，由Pillow生成的固定无个人信息WebP fixture。
        fs.writeFileSync(webpFile, Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAoAAEAfQsUY0uaCBiOh/AAA=', 'base64'));
        fs.writeFileSync(invalidFile, 'invalid image fixture');
        const originalFixtures = [pngFile, jpegFile, webpFile, invalidFile].map(file => ({ file, hash: sha256(fs.readFileSync(file)) }));
        await setPicker({ canceled: true, filePaths: [] });
        const cancelled = await evaluate("require('electron').ipcRenderer.invoke('account-avatar:select')");
        check(cancelled.cancelled === true && cancelled.custom === false, '系统文件选择取消明确返回cancelled并保留默认');
        await clickAvatar('account-avatar-select-btn');
        await until(() => evaluate("!document.getElementById('account-avatar-select-btn').disabled"), '取消后按钮未恢复');
        await loaded('界面取消选择');
        await setPicker({ canceled: false, filePaths: [pngFile] });
        await clickOperation('account-avatar-select-btn', 'PNG选择');
        let preference;
        await until(async () => { preference = await getPreference(); return preference.custom; }, '本机PNG选择未保存');
        check(preference.dataUrl.startsWith('data:image/png;base64,'), '真实IPC解码并只返回安全PNG数据');
        await customLoaded(preference.dataUrl, 'PNG选择成功'); await capture('local-custom-png');
        await captureMenu('local-selected-menu');
        const pngBytes = Buffer.from(preference.dataUrl.split(',')[1], 'base64');
        check(!pngBytes.includes(Buffer.from('fixture-only-no-personal-data')) && pngChunks(pngBytes).every(type => ['IHDR','PLTE','IDAT','IEND','tRNS'].includes(type)), '实际PNG输出剔除文本等元数据');
        const alpha = await evaluate(`require('electron').nativeImage.createFromDataURL(${JSON.stringify(preference.dataUrl)}).getBitmap()[3]`);
        check(alpha > 0 && alpha < 255, '实际PNG转码保留透明度');
        check(await evaluate("!document.getElementById('account-avatar-reset-btn').disabled"), '保存自定义图片后启用恢复默认');
        const originalCustomHash = sha256(pngBytes);
        await setPicker({ canceled: false, filePaths: [invalidFile] });
        await clickOperation('account-avatar-select-btn', '无效PNG选择', true);
        await until(() => evaluate("[...document.querySelectorAll('.notification')].some(element=>element.textContent.includes('头像修改失败')) && !document.getElementById('account-avatar-select-btn').disabled"), '无效PNG未显示可重试错误');
        check(sha256(Buffer.from((await getPreference()).dataUrl.split(',')[1], 'base64')) === originalCustomHash, '无效图片失败保留原本机头像且不覆盖');
        await setPicker({ canceled: true, filePaths: [] });
        const cancelExisting = await evaluate("require('electron').ipcRenderer.invoke('account-avatar:select')");
        check(cancelExisting.cancelled && sha256(Buffer.from(cancelExisting.dataUrl.split(',')[1], 'base64')) === originalCustomHash, '已有头像时取消选择保持原图');
        for (const [name, file] of [['JPEG', jpegFile]]) {
            await setPicker({ canceled: false, filePaths: [file] }); await clickOperation('account-avatar-select-btn', `${name}选择`);
            preference = await getPreference(); check(preference.custom && preference.dataUrl.startsWith('data:image/png;base64,'), `${name}实际解码并规范化为PNG`);
            await customLoaded(preference.dataUrl, `${name}显示`);
        }
        const beforeUnsupported = sha256(Buffer.from(preference.dataUrl.split(',')[1], 'base64'));
        await setPicker({ canceled: false, filePaths: [webpFile] }); await clickOperation('account-avatar-select-btn', '不支持的WebP', true);
        check(sha256(Buffer.from((await getPreference()).dataUrl.split(',')[1], 'base64')) === beforeUnsupported, 'WebP明确拒绝且保留旧图');
        await evaluate("updateAccountUI({authenticated:true,user:{id:'different-fixture',username:'其他模拟账号',customAvatarUrl:'https://outside.invalid/avatar.png'},access:{}});true;");
        await customLoaded(preference.dataUrl, '切换账号保留本机头像');
        await evaluate("require('electron').ipcRenderer.invoke('account:logout').then(account=>updateAccountUI(account))");
        await customLoaded(preference.dataUrl, '未登录保留本机头像'); await capture('local-custom-logged-out');
        const storedFiles = fs.readdirSync(path.join(profile, 'account-avatar')).sort();
        check(storedFiles.includes('avatar.json') && storedFiles.some(name => /^[a-f0-9]{64}\.png$/.test(name)), '头像只保存为独立目录中的manifest与哈希PNG');
        check(!fs.readFileSync(path.join(profile, 'account-avatar', 'avatar.json'), 'utf8').includes(pngFile), 'manifest不记录原图片路径');
        const savedHash = sha256(Buffer.from(preference.dataUrl.split(',')[1], 'base64')); report.customPngSha256 = savedHash;
        check(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8') === settings, '头像选择取消与失败均不修改settings.json');
        await quitApp('首次进程'); startApp('restart'); await connectApp();
        await traceAvatarOperations();
        const restarted = await getPreference();
        check(restarted.custom && sha256(Buffer.from(restarted.dataUrl.split(',')[1], 'base64')) === savedHash, '同一隔离profile跨真实进程重启保留本机头像');
        await customLoaded(restarted.dataUrl, '重启自动加载'); await capture('local-custom-restarted');
        await clickOperation('account-avatar-reset-btn', '恢复默认');
        await until(async () => !(await getPreference()).custom, '恢复默认未清除本机选择');
        await loaded('恢复默认');
        const reset = await getPreference(); check(reset.custom === false && reset.dataUrl === null, '恢复默认返回明确空本机偏好');
        check(!fs.readdirSync(path.join(profile, 'account-avatar')).some(name => /^[a-f0-9]{64}\.png$/.test(name)), '恢复默认移除本次受管PNG，不影响原图片');
        check(await evaluate("document.getElementById('account-avatar-reset-btn').disabled"), '恢复默认后按钮禁用'); await capture('local-reset'); await captureMenu('local-reset-menu');
        check(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8') === settings, '重启与恢复默认不修改现有设置');
        check(originalFixtures.every(item => sha256(fs.readFileSync(item.file)) === item.hash), '选择和恢复从不修改原始图片字节');
        check(anonymousRequests.length > 0 && anonymousRequests.every(request => !request.hasCookie && !request.hasAuthorization), '账号查询仅访问本地401 fixture，不使用真实Cookie或凭据');
        await quitApp('重启进程'); report.success = true;
    } catch (error) {
        report.success = false; report.errors.push(error.stack || String(error)); process.exitCode = 1;
        if (connection && !closed) {
            try { report.failureState = { image: await logoState(), ui: await evaluate("({custom:localAvatar.custom,busy:avatarBusy,operation:avatarOperation,selectDisabled:document.getElementById('account-avatar-select-btn').disabled,resetDisabled:document.getElementById('account-avatar-reset-btn').disabled,trace:window.__avatarTrace,logoLength:defaultAccountLogo.length,appDirectory:avatarDocumentDirectory,rendererDirectory:__dirname,resourcesPath:process.resourcesPath,srcLength:document.getElementById('account-avatar').getAttribute('src')?.length})") }; } catch (_) { }
        }
    }
    finally {
        connection?.close();
        for (const request of pending.values()) request.reject(new Error('验收结束')); pending.clear();
        if (!closed && child.pid) {
            if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else child.kill('SIGKILL');
            await childClosed;
        }
        report.exitCode = exitCode; report.exitSignal = exitSignal;
        anonymousShop.closeAllConnections(); await new Promise(resolve => anonymousShop.close(resolve)); report.anonymousShopRequests = anonymousRequests;
        // 父进程等待子进程完全关闭后，只清理本次分配的profile。
        if (closed && path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('sanrenjz-avatar-') && !fs.lstatSync(temporary).isSymbolicLink()) {
            fs.rmSync(temporary, { recursive: true, force: true }); report.temporaryProfileRemoved = !fs.existsSync(temporary);
        }
        fs.writeFileSync(path.join(output, `${mode}-console.log`), log);
        fs.writeFileSync(path.join(output, `${mode}-report.json`), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    }
})();
