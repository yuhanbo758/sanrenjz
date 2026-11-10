'use strict';
// 独立于宿主生命周期：退出旧进程后才切换应用目录，只使用 Node 内置模块。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const runCommand = promisify(execFile);
const BUNDLE_ID = 'com.sanrenjz.app';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const plainDirectory = file => fs.lstatSync(file).isDirectory() && !fs.lstatSync(file).isSymbolicLink();

function atomicJSON(file, value) {
    const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
}

function checkedJob(file) {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('更新任务文件不能是符号链接');
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    const directory = path.dirname(path.resolve(file));
    const parent = path.dirname(directory);
    if (job.protocol !== 1 || !/^[a-f0-9]{32}$/.test(job.token) || !Number.isSafeInteger(job.pid) || job.pid <= 1 ||
        !['x64', 'arm64'].includes(job.arch) || !/^\d+\.\d+\.\d+$/.test(job.version) ||
        !/^\d+\.\d+\.\d+$/.test(job.currentVersion) || job.bundleId !== BUNDLE_ID ||
        !path.basename(directory).startsWith('.sanrenjz-update-') || !plainDirectory(directory) ||
        fs.realpathSync(directory) !== directory || !path.isAbsolute(job.targetApp) ||
        path.dirname(job.targetApp) !== parent || !job.targetApp.endsWith('.app') ||
        path.basename(file) !== 'job.json') throw new Error('更新任务路径或内容无效');
    return { ...job, directory, replacement: path.join(directory, 'incoming.app'), backup: path.join(directory, 'previous.app'),
        failed: path.join(directory, 'failed.app'), ready: path.join(directory, 'ready.json'),
        acknowledgment: path.join(directory, 'started.json'), status: path.join(directory, 'status.json') };
}

async function checkBundle(appPath, { version, arch }, run = runCommand) {
    if (!plainDirectory(appPath) || fs.realpathSync(appPath) !== path.resolve(appPath)) throw new Error('应用目录无效或包含目录联接');
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout);
    if (info.CFBundleIdentifier !== BUNDLE_ID || info.CFBundleShortVersionString !== version ||
        typeof info.CFBundleExecutable !== 'string' || !info.CFBundleExecutable || /[\\/]/.test(info.CFBundleExecutable) ||
        info.CFBundleExecutable === '.' || info.CFBundleExecutable === '..') throw new Error('更新应用的身份或版本不符');
    // 挂载镜像为只读；复制前确认每条内部链接均落在这一个应用包内。
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (!inside(appPath, fs.realpathSync(file))) throw new Error('应用包包含越界链接');
            if (entry.isDirectory()) walk(file);
        }
    };
    walk(appPath);
    const executable = path.join(appPath, 'Contents', 'MacOS', info.CFBundleExecutable);
    const binary = await run('/usr/bin/lipo', ['-archs', executable], { timeout: 15000, maxBuffer: 8192 });
    if (binary.stdout.trim() !== (arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error('更新应用架构不匹配');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { timeout: 120000, maxBuffer: 16384 });
    const signature = await run('/usr/bin/codesign', ['--display', '--verbose=4', appPath], { timeout: 15000, maxBuffer: 16384 });
    const text = signature.stdout + signature.stderr;
    if (!text.split(/\r?\n/).includes(`Identifier=${BUNDLE_ID}`)) throw new Error('更新应用签名标识不符');
    return { team: /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim() || 'not set' };
}

function samePublisher(current, incoming) {
    // 正式签名的安装不能降级为 ad-hoc 或切换发布者；无证书版本不冒充正式身份。
    if (current.team !== 'not set' && current.team !== incoming.team) throw new Error('更新应用签名发布者与当前版本不一致');
}

async function replaceAndRestart(job, { validate = checkBundle, run = runCommand, waitForStartup } = {}) {
    const current = await validate(job.targetApp, { version: job.currentVersion, arch: job.arch });
    const incoming = await validate(job.replacement, job);
    samePublisher(current, incoming);
    if (fs.existsSync(job.backup) || fs.existsSync(job.failed)) throw new Error('更新恢复目录已存在，停止覆盖');
    let movedOld = false, movedNew = false;
    try {
        // 两次重命名在同一父目录/文件系统内进行，复制失败不会破坏旧应用。
        fs.renameSync(job.targetApp, job.backup); movedOld = true;
        fs.renameSync(job.replacement, job.targetApp); movedNew = true;
        await run('/usr/bin/open', ['-n', job.targetApp], { timeout: 15000, maxBuffer: 8192 });
    } catch (error) {
        try {
            if (movedNew) fs.renameSync(job.targetApp, job.failed);
            if (movedOld) fs.renameSync(job.backup, job.targetApp);
            atomicJSON(job.status, { protocol: 1, state: 'rolled-back', token: job.token });
            if (movedOld) await run('/usr/bin/open', ['-n', job.targetApp], { timeout: 15000, maxBuffer: 8192 });
        } catch (_) {
            atomicJSON(job.status, { protocol: 1, state: 'recovery-required', token: job.token });
            throw new Error('更新回滚未完成，恢复材料已保留');
        }
        throw error;
    }
    const acknowledged = await waitForStartup();
    // open 返回成功不等于新宿主启动成功；未收到确认时保留两份应用，不删除备份。
    atomicJSON(job.status, { protocol: 1, state: acknowledged ? 'success' : 'startup-unconfirmed', token: job.token, workerPid: process.pid });
    return acknowledged;
}

async function worker(file) {
    if (process.platform !== 'darwin') throw new Error('此更新助手仅支持 macOS');
    const job = checkedJob(file);
    atomicJSON(job.ready, { token: job.token, workerPid: process.pid });
    const deadline = Date.now() + 60000;
    while (true) {
        let alive = true;
        try { process.kill(job.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
        if (!alive) break;
        if (Date.now() >= deadline) {
            atomicJSON(job.status, { protocol: 1, state: 'exit-timeout', token: job.token });
            return;
        }
        await delay(100);
    }
    try { const started = await replaceAndRestart(job, { waitForStartup: async () => {
        const startupDeadline = Date.now() + 60000;
        while (Date.now() < startupDeadline) {
            try {
                const acknowledgment = JSON.parse(fs.readFileSync(job.acknowledgment, 'utf8'));
                if (acknowledgment.token === job.token && acknowledgment.version === job.version) return true;
            } catch (_) { }
            await delay(200);
        }
        return false;
    } });
        if (!started) await runCommand('/usr/bin/osascript', ['-e', 'display alert "三人聚智更新尚未确认" message "新版本尚未确认启动，旧程序备份已保留。请检查系统安全提示，或重新打开三人聚智确认版本。" as warning buttons {"好"} default button "好" giving up after 60'], { timeout: 65000, maxBuffer: 8192 });
    } catch (error) {
        // 切换前验证失败时旧程序仍在原位，也应重新打开；回滚路径自己负责重启。
        if (!fs.existsSync(job.status)) {
            atomicJSON(job.status, { protocol: 1, state: 'failed', token: job.token });
            try {
                await checkBundle(job.targetApp, { version: job.currentVersion, arch: job.arch });
                await runCommand('/usr/bin/open', ['-n', job.targetApp], { timeout: 15000, maxBuffer: 8192 });
            } catch (_) { }
        }
        throw error;
    }
}

if (require.main === module) worker(process.argv[2]).catch(async () => {
    try {
        const job = checkedJob(process.argv[2]);
        if (!fs.existsSync(job.status)) atomicJSON(job.status, { protocol: 1, state: 'failed', token: job.token });
        await runCommand('/usr/bin/osascript', ['-e', 'display alert "三人聚智更新未完成" message "旧程序或恢复材料已保留，请重新打开应用检查更新。若无法启动，请从原安装目录旁的更新备份恢复。" as warning buttons {"好"} default button "好" giving up after 60'], { timeout: 65000, maxBuffer: 8192 });
    } catch (_) { }
    process.exitCode = 1;
});

module.exports = { BUNDLE_ID, inside, atomicJSON, checkedJob, checkBundle, samePublisher, replaceAndRestart, runCommand, delay };
