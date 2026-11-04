const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
if (process.platform !== 'win32') throw new Error('此验收仅在 Windows 运行');
const installer = path.resolve(process.argv[2] || '');
if (!fs.existsSync(installer) || !installer.endsWith('.exe')) throw new Error('需要有效安装包路径');
// 不覆盖用户现有的新应用安装。两个旧产品的注册信息不属于这个名称。
const existing = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); $n=@(foreach($r in $p){Get-ChildItem -LiteralPath $r -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object {$_.DisplayName -eq '三人聚智'}}).Count; Write-Output $n"], { encoding: 'utf8', windowsHide: true });
if (existing.status !== 0 || Number(existing.stdout.trim()) !== 0) throw new Error('检测到已有三人聚智安装或无法核实注册信息，跳过真实安装验收');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(runtime, '.installer-acceptance-'));
const installed = path.join(sandbox, '应用 程序');
const profile = path.join(sandbox, 'profile'); fs.mkdirSync(profile);
const relative = path.relative(runtime, sandbox);
if (!relative.startsWith('.installer-acceptance-') || relative.includes(path.sep)) throw new Error('验收目录不在项目 runtime 中');
const report = { installer, installationRoot: installed, assertions: [], errors: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(value, label) { if (!value) throw new Error(label); report.assertions.push(label); }
async function execute(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, SANRENJZ_USER_DATA: profile, SANRENJZ_ACCEPTANCE: '1' }, stdio: 'ignore' });
        const timer = setTimeout(() => { spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}); reject(new Error('安装器执行超时')); }, 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`安装器退出码 ${code}`)); });
    });
}
(async () => {
    let uninstall;
    try {
        await execute(installer, ['/S', `/D=${installed}`]);
        assert(fs.existsSync(path.join(installed, '三人聚智.exe')), 'NSIS 在中文和空格路径安装成功');
        assert(!fs.existsSync(path.join(installed, 'runtime')), '首次安装不包含Python运行时');
        uninstall = fs.readdirSync(installed).find(name => /uninstall.*\.exe$/i.test(name));
        assert(Boolean(uninstall), '安装包含卸载器');
        const canaries = ['plugins/本地效率插件/keep.txt', 'python-plugins/本地Python插件/keep.txt', 'plugin-configs/keep.json', 'runtime/python/本地环境/keep.txt'];
        const content = crypto.randomBytes(24).toString('hex');
        for (const file of canaries) { const target = path.join(installed,file); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,content); }
        fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({ pythonMode:'none',marker:'installer-acceptance' }));
        await execute(installer, ['/S', `/D=${installed}`]);
        for (const file of canaries) assert(fs.existsSync(path.join(installed,file)) && fs.readFileSync(path.join(installed,file),'utf8') === content, `升级保留 ${file.split('/')[0]}`);
        assert(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'))).marker==='installer-acceptance', '升级保留独立用户数据');
        assert(!fs.existsSync(`${installed}.sanrenjz-update-backup`), '全部恢复成功后清理升级备份');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); process.exitCode=1; }
    finally {
        if (uninstall && fs.existsSync(path.join(installed,uninstall))) {
            try {
                await execute(path.join(installed,uninstall), ['/S']);
                for(let i=0;i<100 && fs.existsSync(path.join(installed,'三人聚智.exe'));i++) await delay(100);
                assert(!fs.existsSync(path.join(installed,'三人聚智.exe')), '验收安装已卸载');
            } catch (error) { report.success=false;report.errors.push(`验收卸载：${error.message}`);process.exitCode=1; }
        }
        fs.writeFileSync(path.join(root,'dist','windows-installer-report.json'),JSON.stringify(report,null,2));
        console.log(JSON.stringify(report));
        // 不删除安装失败材料；成功时也保留很小的隔离数据和报告供复核。
    }
})();
