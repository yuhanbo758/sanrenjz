'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { BUNDLE_ID, atomicJSON, checkedJob, checkBundle, samePublisher, runCommand, delay } = require('./mac-update-worker');

class MacUpdateInstaller {
    constructor({ updatesDir, executable = process.execPath, version, arch = process.arch, platform = process.platform,
        run = runCommand, spawnWorker = spawn, validate = checkBundle, emit = () => {} }) {
        this.updatesDir = path.resolve(updatesDir);
        this.executable = executable;
        this.version = version;
        this.arch = arch;
        this.platform = platform;
        this.run = run;
        this.spawnWorker = spawnWorker;
        this.validate = validate;
        this.emit = emit;
        this.busy = false;
        this.pendingFile = path.join(this.updatesDir, 'mac-install-pending.json');
    }

    targetApp() {
        const candidate = path.resolve(path.dirname(this.executable), '..', '..');
        if (!candidate.endsWith('.app') || /(?:^|\/)Volumes\/|\/AppTranslocation\//.test(candidate.split(path.sep).join('/'))) {
            throw new Error('请先把应用安装到“应用程序”或用户的 Applications 目录，再使用一键更新');
        }
        const target = fs.realpathSync(candidate);
        if (target !== candidate || !fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) throw new Error('当前应用安装目录无效');
        return target;
    }

    async detach(device) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try { await this.run('/usr/bin/hdiutil', ['detach', device], { timeout: 30000, maxBuffer: 16384 }); return; }
            catch (error) {
                if (error.code !== 16 || !/Resource busy/i.test(String(error.stderr)) || attempt === 2) throw error;
                await delay(250 * (attempt + 1));
            }
        }
    }

    async start(downloaded) {
        if (this.busy) throw new Error('正在准备安装更新，请稍候');
        if (this.platform !== 'darwin') throw new Error('当前平台不支持此安装方式');
        this.busy = true;
        let device;
        try {
            const targetApp = this.targetApp();
            const current = await this.validate(targetApp, { version: this.version, arch: this.arch }, this.run);
            // 安装时再次校验，拒绝直接构造路径绕过下载服务。
            const bytes = fs.readFileSync(downloaded.path);
            if (!Number.isSafeInteger(downloaded.bytes) || bytes.length !== downloaded.bytes ||
                crypto.createHash('sha256').update(bytes).digest('hex') !== downloaded.sha256 ||
                fs.lstatSync(downloaded.path).isSymbolicLink()) throw new Error('更新包已发生变化，请重新下载');
            this.pruneOldSuccess(targetApp);
            let directory;
            try { directory = fs.mkdtempSync(path.join(path.dirname(targetApp), '.sanrenjz-update-')); }
            catch (_) { throw new Error('应用安装目录不可写。请授予该目录写入权限，或将应用安装到当前用户的 Applications 目录后重试'); }
            fs.chmodSync(directory, 0o700);
            const mount = path.join(directory, 'volume'); fs.mkdirSync(mount);
            const attachment = await this.run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist', downloaded.path], { timeout: 60000, maxBuffer: 1024 * 1024 });
            const parsed = await this.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: attachment.stdout, timeout: 15000, maxBuffer: 1024 * 1024 });
            const entities = JSON.parse(parsed.stdout)['system-entities'];
            const entity = Array.isArray(entities) && entities.find(item => item['mount-point'] === mount);
            if (!entity || !/^\/dev\/disk\d+(?:s\d+)*$/.test(entity['dev-entry'])) throw new Error('更新镜像挂载结果无效，已保留本次材料');
            device = entity['dev-entry'];
            const apps = fs.readdirSync(mount).filter(name => name.endsWith('.app'));
            if (apps.length !== 1) throw new Error('更新镜像必须只包含一个应用');
            const incoming = path.join(mount, apps[0]);
            const incomingSignature = await this.validate(incoming, downloaded, this.run);
            samePublisher(current, incomingSignature);
            const replacement = path.join(directory, 'incoming.app');
            await this.run('/usr/bin/ditto', [incoming, replacement], { timeout: 180000, maxBuffer: 16384 });
            await this.validate(replacement, downloaded, this.run);
            // 必须先成功卸载本次镜像，再退出应用；不能把原生卸载失败当作成功。
            await this.detach(device); device = null;
            const jobFile = path.join(directory, 'job.json');
            const job = { protocol: 1, token: crypto.randomBytes(16).toString('hex'), pid: process.pid,
                targetApp, version: downloaded.version, currentVersion: this.version, arch: this.arch, bundleId: BUNDLE_ID };
            atomicJSON(jobFile, job);
            fs.copyFileSync(path.join(__dirname, 'mac-update-worker.js'), path.join(directory, 'worker.js'), fs.constants.COPYFILE_EXCL);
            atomicJSON(this.pendingFile, { jobFile, token: job.token });
            await this.launch(jobFile);
            return { success: true, message: '更新已准备好，程序正在退出并安装，完成后将自动重新打开' };
        } catch (error) {
            this.busy = false;
            if (device) {
                try { await this.detach(device); }
                catch (_) { throw new Error('更新镜像卸载失败，旧程序保持运行，请稍后重试；本次恢复材料已保留'); }
            }
            if (/^(请先把应用安装|当前应用安装目录无效|应用安装目录不可写|更新包已发生变化|更新镜像|更新应用|应用目录无效|应用包包含越界|更新任务|更新助手|更新恢复目录)/.test(error.message || '')) throw error;
            throw new Error('准备安装失败，旧程序保持运行；请检查磁盘空间与安装目录权限后重试');
        }
    }

    async launch(file) {
        const job = checkedJob(file);
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
        delete env.NODE_OPTIONS; delete env.NODE_PATH;
        const child = this.spawnWorker(this.executable, [path.join(job.directory, 'worker.js'), file], {
            cwd: job.directory, env, detached: true, stdio: 'ignore', windowsHide: true
        });
        let failure;
        child.on('error', error => { failure = error; });
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            if (failure || child.signalCode || (child.exitCode !== null && child.exitCode !== undefined)) break;
            try {
                const ready = JSON.parse(fs.readFileSync(job.ready, 'utf8'));
                if (ready.token === job.token && ready.workerPid === child.pid) { child.unref(); this.watch(job); return; }
            } catch (_) { }
            await delay(50);
        }
        try { child.kill(); } catch (_) { }
        throw new Error('更新助手未能启动，旧程序保持运行，请重试');
    }

    acknowledgeStartup() {
        try {
            const pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
            const job = checkedJob(pending.jobFile);
            if (job.token !== pending.token || job.targetApp !== this.targetApp()) return false;
            if (job.version !== this.version) {
                try {
                    const status = JSON.parse(fs.readFileSync(job.status, 'utf8'));
                    if (status.token === job.token && ['failed', 'rolled-back', 'recovery-required', 'exit-timeout'].includes(status.state)) {
                        this.emit({ type: 'error', message: '上次自动更新未完成，当前仍为旧版本；旧程序或恢复材料已保留，可在应用更新中重试' });
                    }
                } catch (_) { }
                return false;
            }
            atomicJSON(job.acknowledgment, { token: job.token, version: this.version, pid: process.pid });
            return true;
        } catch (_) { return false; }
    }

    watch(job) {
        const deadline = Date.now() + 150000;
        const timer = setInterval(() => {
            try {
                const status = JSON.parse(fs.readFileSync(job.status, 'utf8'));
                if (status.token !== job.token) return;
                clearInterval(timer);
                this.busy = false;
                if (status.state !== 'success') this.emit({ type: 'error', message: '自动更新未完成，旧版或恢复材料已保留，请重新打开应用更新后重试' });
            } catch (_) { if (Date.now() >= deadline) { clearInterval(timer); this.busy = false; } }
        }, 1000);
        timer.unref();
    }

    pruneOldSuccess(targetApp) {
        const parent = path.dirname(targetApp), completed = [];
        for (const name of fs.readdirSync(parent)) {
            if (!name.startsWith('.sanrenjz-update-')) continue;
            try {
                const job = checkedJob(path.join(parent, name, 'job.json'));
                const status = JSON.parse(fs.readFileSync(job.status, 'utf8'));
                if (job.targetApp !== targetApp || status.state !== 'success' || status.token !== job.token) continue;
                if (!Number.isSafeInteger(status.workerPid) || status.workerPid <= 1) continue;
                try { process.kill(status.workerPid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
                completed.push({ directory: job.directory, modified: fs.statSync(job.status).mtimeMs });
            } catch (_) { }
        }
        completed.sort((a, b) => b.modified - a.modified);
        // 留下最近一次成功更新的旧程序；仅清理已结束助手持有的更旧事务。
        for (const item of completed.slice(1)) {
            if (path.dirname(item.directory) === parent && fs.realpathSync(item.directory) === item.directory) {
                try { fs.rmSync(item.directory, { recursive: true }); } catch (_) { /* 无权清理的旧备份保留，不阻断新更新。 */ }
            }
        }
    }
}

module.exports = { MacUpdateInstaller };
