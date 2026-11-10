'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPOSITORY = 'yuhanbo758/sanrenjz';
const GITHUB_RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DOWNLOAD_HOSTS = new Set(['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

function parseVersion(value, stableOnly = false) {
    const number = '(?:0|[1-9][0-9]*)';
    const identifier = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
    const match = typeof value === 'string' && new RegExp(`^(${number})\\.(${number})\\.(${number})(?:-(${identifier}(?:\\.${identifier})*))?$`).exec(value);
    if (!match || match[0] !== value || (stableOnly && match[4])) throw new Error('更新版本号无效，请前往官方 Releases 查看');
    return { numbers: match.slice(1, 4).map(BigInt), prerelease: Boolean(match[4]) };
}

function newerThanStable(version, currentVersion) {
    const incoming = parseVersion(version, true), current = parseVersion(currentVersion);
    for (let index = 0; index < 3; index++) {
        if (incoming.numbers[index] !== current.numbers[index]) return incoming.numbers[index] > current.numbers[index];
    }
    return current.prerelease;
}

function installerName(version, platform, arch) {
    parseVersion(version, true);
    if (platform === 'win32' && arch === 'x64') return `sanrenjz-${version}-win-x64.exe`;
    if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) return `sanrenjz-${version}-mac-${arch}.dmg`;
    if (platform === 'linux' && arch === 'x64') return `sanrenjz-${version}-linux-x64.AppImage`;
    throw new Error('当前平台或架构暂无对应更新包，请前往官方 Releases 查看');
}

function assetUrl(asset, tag) {
    const expected = `https://github.com/${REPOSITORY}/releases/download/${tag}/${asset.name}`;
    if (asset.browser_download_url !== expected) throw new Error('更新包来源不符合官方仓库，请重新检查更新');
    return expected;
}

function trustedRedirect(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('更新下载地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !DOWNLOAD_HOSTS.has(url.hostname)) {
        throw new Error('更新下载被重定向到非官方地址，已停止');
    }
    return url.toString();
}

function networkError(error) {
    if (error?.updateMessage) return error;
    const code = String(error?.code || error?.message || '');
    const result = new Error(/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(code)
        ? '无法解析 GitHub 地址，请检查网络或代理后重试'
        : /TIMED_OUT|ETIMEDOUT|timeout/i.test(code)
            ? '连接 GitHub 超时，请检查网络或代理后重试'
            : '连接 GitHub 失败，请检查网络或代理后重试');
    result.updateMessage = true;
    return result;
}

function updateError(message) { const error = new Error(message); error.updateMessage = true; return error; }

function operationError(error) {
    if (error?.updateMessage) return error;
    if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return updateError('更新目录不可写，请检查目录权限后重试');
    if (error?.code === 'ENOSPC') return updateError('磁盘空间不足，请释放空间后重新下载');
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST'].includes(error?.code)) return updateError('更新文件或目录无法访问，请检查更新目录后重试');
    return updateError('更新操作失败，请检查网络、磁盘空间和更新目录权限后重试');
}

class ReleaseUpdates {
    constructor({ currentVersion, platform = process.platform, arch = process.arch, updatesDir, request, emit = () => {}, timeoutMs = 30000, downloadTimeoutMs = 20 * 60 * 1000 }) {
        parseVersion(currentVersion);
        if (typeof request !== 'function' || !updatesDir) throw new Error('更新服务未正确初始化');
        this.currentVersion = currentVersion;
        this.platform = platform;
        this.arch = arch;
        this.updatesDir = path.resolve(updatesDir);
        this.request = request;
        this.emit = emit;
        this.timeoutMs = timeoutMs;
        this.downloadTimeoutMs = downloadTimeoutMs;
        this.candidate = null;
        this.downloaded = null;
        this.busy = false;
        this.cancelled = false;
        this.cancelRequest = null;
    }

    event(type, payload = {}) {
        try { this.emit({ type, source: 'github', ...payload }); } catch (_) { /* 界面关闭不应破坏下载清理。 */ }
    }

    async operation(callback) {
        if (this.busy) throw updateError('更新操作正在进行，请稍候');
        this.busy = true;
        this.cancelled = false;
        try { return await callback(); }
        catch (error) {
            const safeError = operationError(error);
            this.event(safeError.cancelled ? 'cancelled' : 'error', { message: safeError.message });
            throw safeError;
        } finally { this.busy = false; this.cancelRequest = null; }
    }

    cancel() {
        if (!this.busy) return;
        // 取消属于整个操作，网络结束后的异步校验阶段也不能再提交安装包。
        this.cancelled = true;
        if (this.cancelRequest) this.cancelRequest();
    }

    assertNotCancelled() {
        if (!this.cancelled) return;
        const error = updateError('已取消更新操作');
        error.cancelled = true;
        throw error;
    }

    async receive(url, options = {}, redirects = 0) {
        this.assertNotCancelled();
        if (redirects > 5) throw updateError('更新下载重定向次数过多');
        trustedRedirect(url);
        const result = await this.receiveOnce(url, options);
        this.assertNotCancelled();
        if (result.redirect) return this.receive(trustedRedirect(new URL(result.redirect, url).toString()), options, redirects + 1);
        return result;
    }

    receiveOnce(url, { file, maxBytes = 2 * 1024 * 1024, expectedBytes, onProgress } = {}) {
        return new Promise((resolve, reject) => {
            let request, response, output, settled = false, received = 0, timer, deadline;
            const chunks = [];
            const cleanup = () => { clearTimeout(timer); clearTimeout(deadline); if (this.cancelRequest === cancel) this.cancelRequest = null; };
            const finish = (error, value) => {
                if (settled) return;
                settled = true; cleanup();
                if (error) {
                    try { request?.abort(); } catch (_) { }
                    if (output) {
                        output.once('close', () => { try { fs.unlinkSync(file); } catch (_) { } reject(error); });
                        output.destroy();
                    } else reject(error);
                } else resolve(value);
            };
            const cancel = () => { const error = updateError('已取消更新操作'); error.cancelled = true; finish(error); };
            const touch = () => { clearTimeout(timer); timer = setTimeout(() => finish(updateError('连接 GitHub 超时，请检查网络或代理后重试')), this.timeoutMs); };
            this.cancelRequest = cancel;
            try {
                // Chromium 网络栈沿用系统代理；更新请求不携带商店 Cookie 或账号令牌。
                request = this.request({ method: 'GET', url, redirect: 'manual', useSessionCookies: false, credentials: 'omit' });
                request.setHeader('Accept', file ? 'application/octet-stream' : 'application/vnd.github+json');
                request.setHeader('User-Agent', 'sanrenjz-updater');
                request.setHeader('Cache-Control', 'no-cache');
                request.on('error', error => finish(networkError(error)));
                request.on('abort', () => { if (!settled) finish(updateError('更新请求已中止')); });
                request.on('redirect', (_code, _method, location) => {
                    if (settled) return;
                    try { trustedRedirect(new URL(location, url).toString()); }
                    catch (error) { finish(updateError(error.message)); return; }
                    finish(null, { redirect: location });
                    try { request.abort(); } catch (_) { }
                });
                request.on('response', incoming => {
                    response = incoming;
                    const status = Number(response.statusCode);
                    const location = response.headers?.location;
                    if ([301, 302, 303, 307, 308].includes(status) && location) {
                        finish(null, { redirect: Array.isArray(location) ? location[0] : location });
                        response.resume?.(); return;
                    }
                    if (status !== 200) {
                        finish(updateError(status === 403 || status === 429 ? 'GitHub 请求频率受限，请稍后重试' : status === 404 ? '官方仓库暂未提供可用正式版，请稍后重试' : `GitHub 请求失败（HTTP ${status}），请稍后重试`));
                        response.resume?.(); return;
                    }
                    if (file) {
                        try { output = fs.createWriteStream(file, { flags: 'wx' }); }
                        catch (error) { finish(updateError('无法写入更新目录，请检查磁盘空间和目录权限')); return; }
                        output.on('error', () => finish(updateError('无法写入更新目录，请检查磁盘空间和目录权限')));
                        output.on('drain', () => response.resume?.());
                        output.on('finish', () => {
                            output.close(() => finish(null, { bytes: received }));
                        });
                    }
                    response.on('data', chunk => {
                        if (settled) return;
                        touch(); received += chunk.length;
                        if (received > (file ? expectedBytes : maxBytes)) { finish(updateError('更新文件大小不符，已停止下载')); return; }
                        if (file) {
                            if (!output.write(chunk)) response.pause?.();
                            if (onProgress) onProgress({ transferred: received, total: expectedBytes, percent: received / expectedBytes * 100 });
                        } else chunks.push(Buffer.from(chunk));
                    });
                    response.on('error', error => finish(networkError(error)));
                    response.on('aborted', () => finish(updateError('更新下载连接中断，请重新下载')));
                    response.on('end', () => {
                        if (settled) return;
                        if (file) {
                            if (received !== expectedBytes) finish(updateError('更新文件大小不符，请重新下载'));
                            else output.end();
                        } else finish(null, { bytes: received, data: Buffer.concat(chunks) });
                    });
                });
                touch();
                deadline = setTimeout(() => finish(updateError('更新请求超过最长等待时间，请重试')), file ? this.downloadTimeoutMs : this.timeoutMs);
                request.end();
            } catch (error) { finish(networkError(error)); }
        });
    }

    async check() {
        return this.operation(async () => {
            this.candidate = null; this.downloaded = null;
            this.event('checking');
            const response = await this.receive(API_URL);
            let release;
            try { release = JSON.parse(response.data.toString('utf8')); } catch (_) { throw updateError('GitHub 返回了无效版本信息，请稍后重试'); }
            const version = typeof release.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
            try { parseVersion(version, true); } catch (_) { throw updateError('官方更新信息不是有效正式版，请前往 Releases 查看'); }
            if (release.draft !== false || release.prerelease !== false || release.html_url !== `https://github.com/${REPOSITORY}/releases/tag/v${version}`) throw updateError('官方更新来源或发布状态无效');
            const available = newerThanStable(version, this.currentVersion);
            const info = { version, releaseUrl: release.html_url, platform: this.platform, arch: this.arch, installAction: this.platform === 'win32' ? 'install' : this.platform === 'darwin' ? 'install-macos' : 'show-folder' };
            if (available) {
                let name;
                try { name = installerName(version, this.platform, this.arch); } catch (error) { throw updateError(error.message); }
                const matches = (Array.isArray(release.assets) ? release.assets : []).filter(asset => asset.name === name && asset.state === 'uploaded');
                if (matches.length !== 1 || !Number.isSafeInteger(matches[0].size) || matches[0].size <= 0) throw updateError('正式版缺少当前平台的有效安装包，请前往 Releases 查看');
                const asset = matches[0];
                let url;
                try { url = assetUrl(asset, `v${version}`); } catch (error) { throw updateError(error.message); }
                let sha256;
                if (asset.digest) {
                    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw updateError('更新包 SHA256 信息无效，已停止');
                    sha256 = asset.digest.slice(7).toLowerCase();
                } else {
                    const sums = release.assets.filter(item => item.name === 'SHA256SUMS.txt' && item.state === 'uploaded');
                    if (sums.length !== 1) throw updateError('正式版缺少 SHA256 校验信息，已停止');
                    let sumsUrl;
                    try { sumsUrl = assetUrl(sums[0], `v${version}`); } catch (error) { throw updateError(error.message); }
                    const text = (await this.receive(sumsUrl, { maxBytes: 1024 * 1024 })).data.toString('utf8');
                    const lines = text.split(/\r?\n/).map(line => /^([a-f0-9]{64})[ \t]+\*?(.+)$/.exec(line)).filter(match => match && match[2] === name);
                    if (lines.length !== 1) throw updateError('更新包 SHA256 清单缺失或重复，已停止');
                    sha256 = lines[0][1].toLowerCase();
                }
                this.assertNotCancelled();
                this.candidate = { ...info, assetName: name, bytes: asset.size, url, sha256 };
                Object.assign(info, { assetName: name, bytes: asset.size });
            }
            this.event(available ? 'available' : 'not-available', { info });
            return { success: true, source: 'github', available, updateInfo: info };
        });
    }

    async verifyFile(file, expected) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) throw updateError('更新包已损坏或发生变化，请重新下载');
        const sha256 = await new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256'), stream = fs.createReadStream(file);
            stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject);
            stream.on('end', () => resolve(hash.digest('hex')));
        });
        if (sha256 !== expected.sha256) throw updateError('更新包 SHA256 校验失败，请重新下载');
    }

    async download() {
        return this.operation(async () => {
            this.downloaded = null;
            if (!this.candidate) throw updateError('尚未发现可下载的新版本，请先检查更新');
            const candidate = this.candidate;
            fs.mkdirSync(this.updatesDir, { recursive: true });
            if (!fs.lstatSync(this.updatesDir).isDirectory() || fs.lstatSync(this.updatesDir).isSymbolicLink()) throw updateError('更新目录无效，请检查目录权限');
            const finalPath = path.join(this.updatesDir, candidate.assetName);
            if (fs.existsSync(finalPath) && fs.lstatSync(finalPath).isSymbolicLink()) throw updateError('更新包路径无效，请检查更新目录');
            const temporaryPath = `${finalPath}.${crypto.randomBytes(8).toString('hex')}.part`;
            try {
                this.event('download-progress', { progress: { percent: 0, transferred: 0, total: candidate.bytes } });
                await this.receive(candidate.url, { file: temporaryPath, expectedBytes: candidate.bytes, onProgress: progress => this.event('download-progress', { progress }) });
                this.assertNotCancelled();
                await this.verifyFile(temporaryPath, candidate);
                this.assertNotCancelled();
                fs.renameSync(temporaryPath, finalPath);
                this.downloaded = { ...candidate, path: finalPath };
                const { url, sha256, ...info } = candidate;
                this.event('downloaded', { info, installAction: candidate.installAction, message: this.platform === 'win32' ? '安装包已下载并通过 SHA256 校验，点击“安装更新”继续' : this.platform === 'darwin' ? '更新包已通过 SHA256 校验，点击“安装并重启”自动完成更新' : '安装包已下载并通过 SHA256 校验，请打开下载目录完成更新' });
                return { success: true, path: finalPath, mode: 'manual-github', installAction: candidate.installAction, updateInfo: info };
            } catch (error) {
                try { fs.unlinkSync(temporaryPath); } catch (_) { }
                throw error;
            }
        });
    }

    async verifyDownloaded() {
        if (this.busy) throw updateError('更新操作正在进行，请稍候');
        if (!this.downloaded) throw updateError('尚未下载有效安装包，请先下载更新');
        try {
            // 点击安装时重新核对文件，不能信任先前下载完成状态。
            await this.verifyFile(this.downloaded.path, this.downloaded);
            return { path: this.downloaded.path, version: this.downloaded.version, platform: this.platform, arch: this.arch, installAction: this.downloaded.installAction, bytes: this.downloaded.bytes, sha256: this.downloaded.sha256 };
        } catch (error) {
            this.downloaded = null;
            throw error?.updateMessage ? error : updateError('更新包不存在或无法读取，请重新下载');
        }
    }
}

module.exports = { ReleaseUpdates, GITHUB_RELEASES_URL, API_URL, parseVersion, newerThanStable, installerName };
