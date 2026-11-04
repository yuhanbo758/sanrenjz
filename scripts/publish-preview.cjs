'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { expectedNames } = require('./collect-ci-artifacts.cjs');

const TARGETS = [
    { directory: 'public-windows-x64', target: 'win-x64', cliPlatform: 'win', platform: 'win32', arch: 'x64', signing: 'unsigned' },
    { directory: 'public-macos-x64', target: 'mac-x64', cliPlatform: 'mac', platform: 'darwin', arch: 'x64', signing: 'ad-hoc' },
    { directory: 'public-macos-arm64', target: 'mac-arm64', cliPlatform: 'mac', platform: 'darwin', arch: 'arm64', signing: 'ad-hoc' },
    { directory: 'public-linux-x64', target: 'linux-x64', cliPlatform: 'linux', platform: 'linux', arch: 'x64', signing: 'none' },
];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function fileInfo(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('发布输入必须是非空普通文件');
    return { bytes: stat.size, sha256: hash(fs.readFileSync(file)) };
}
function directory(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('发布输入目录不得为链接或文件');
}
function sameNames(actual, expected) {
    return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
function checksums(text) {
    const entries = new Map();
    for (const line of text.replace(/\r\n/g, '\n').trimEnd().split('\n')) {
        const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
        if (!match || entries.has(match[2])) throw new Error('SHA256清单含非法路径、格式或重复项');
        entries.set(match[2], match[1]);
    }
    return entries;
}
function validateInputs(root, { sourceCommit = process.env.GITHUB_SHA || '', input = path.join(root, 'dist/release-input') } = {}) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'sanrenjz' || !/^\d+\.\d+\.\d+-[a-zA-Z0-9.-]+$/.test(pkg.version)) throw new Error('只允许为三人聚智显式预览版本发布');
    if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error('发布必须指定完整来源提交');
    directory(input);
    if (!sameNames(fs.readdirSync(input), TARGETS.map(target => target.directory))) throw new Error('四个平台产物必须齐全且不得含额外输入');
    const allFiles = new Map();
    const targets = [];
    for (const target of TARGETS) {
        const source = path.join(input, target.directory); directory(source);
        const infoPath = path.join(source, 'build-info.json'); fileInfo(infoPath);
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        const expected = expectedNames(pkg, target.cliPlatform, target.arch);
        if (!sameNames(fs.readdirSync(source), [...expected, 'build-info.json', 'SHA256SUMS.txt'])) throw new Error(`产物目录包含未知或缺失文件：${target.target}`);
        if (info.schemaVersion !== 1 || info.version !== pkg.version || info.target !== target.target || info.platform !== target.platform || info.arch !== target.arch || info.sourceCommit !== sourceCommit || info.bundledPython !== false || info.personal !== false || info.published !== false || info.signing !== target.signing || info.notarized !== false || info.runtimeVerified !== true || !Number.isSafeInteger(info.runtimeAssertions) || info.runtimeAssertions <= 0 || !Number.isSafeInteger(info.auditedEntries) || info.auditedEntries <= 0) throw new Error(`构建元数据与发布目标不符：${target.target}`);
        if (!Array.isArray(info.files) || !sameNames(info.files.map(file => file.filename), expected)) throw new Error(`安装包列表不符：${target.target}`);
        const sumPath = path.join(source, 'SHA256SUMS.txt'); fileInfo(sumPath);
        const sums = checksums(fs.readFileSync(sumPath, 'utf8'));
        if (!sameNames(sums.keys(), expected)) throw new Error(`SHA256清单不完整：${target.target}`);
        const verified = [];
        for (const entry of info.files) {
            if (typeof entry.filename !== 'string' || path.basename(entry.filename) !== entry.filename || !expected.includes(entry.filename) || allFiles.has(entry.filename) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('安装包元数据含非法路径、大小、校验值或重复名称');
            const sourcePath = path.join(source, entry.filename);
            const actual = fileInfo(sourcePath);
            if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256 || sums.get(entry.filename) !== entry.sha256) throw new Error(`安装包校验不符：${entry.filename}`);
            const record = { filename: entry.filename, bytes: actual.bytes, sha256: actual.sha256 };
            verified.push(record);
            allFiles.set(entry.filename, { ...record, sourcePath, target: target.target });
        }
        targets.push({ target: target.target, platform: target.platform, arch: target.arch, signing: target.signing, notarized: false, auditedEntries: info.auditedEntries, runtimeVerified: true, runtimeAssertions: info.runtimeAssertions, files: verified });
    }
    if (allFiles.size !== 7) throw new Error('四个平台必须包含7个安装包');
    return { version: pkg.version, tag: `v${pkg.version}`, sourceCommit, targets, files: [...allFiles.values()].sort((left, right) => left.filename.localeCompare(right.filename, 'en')) };
}
function prepareRelease(root = path.resolve(__dirname, '..'), options = {}) {
    const validated = validateInputs(root, options);
    const output = options.output || path.join(root, 'dist/release-assets');
    const manifest = {
        schemaVersion: 1, version: validated.version, tag: validated.tag, sourceCommit: validated.sourceCommit,
        preview: true, bundledPython: false, privatePluginsIncluded: false, targets: validated.targets,
        files: validated.files.map(({ sourcePath, ...file }) => file),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const records = [...validated.files.map(({ sourcePath, target, ...file }) => file), { filename: 'release-manifest.json', bytes: manifestBytes.length, sha256: hash(manifestBytes) }];
    const sumBytes = Buffer.from(records.map(file => `${file.sha256}  ${file.filename}\n`).join(''));
    const assets = [...records, { filename: 'SHA256SUMS.txt', bytes: sumBytes.length, sha256: hash(sumBytes) }];
    if (fs.existsSync(output)) {
        directory(output);
        if (!sameNames(fs.readdirSync(output), assets.map(file => file.filename))) throw new Error('发布输出目录已包含不同文件，停止覆盖');
        for (const asset of assets) {
            const actual = fileInfo(path.join(output, asset.filename));
            if (actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes) throw new Error('发布输出目录已包含不同内容，停止覆盖');
        }
    } else {
        fs.mkdirSync(output, { recursive: true });
        for (const file of validated.files) fs.copyFileSync(file.sourcePath, path.join(output, file.filename), fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(path.join(output, 'release-manifest.json'), manifestBytes, { flag: 'wx' });
        fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), sumBytes, { flag: 'wx' });
    }
    return { ...validated, output, assets, manifest };
}
function gh(args, { json = false, allowMissing = false, outputFile } = {}) {
    let descriptor;
    let result;
    try {
        if (outputFile) descriptor = fs.openSync(outputFile, 'wx');
        result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(outputFile ? { stdio: ['ignore', descriptor, 'pipe'] } : {}) });
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    if (result.error || result.status !== 0) {
        if (allowMissing && /HTTP 404/.test(result.stderr || '')) return null;
        const status = /HTTP (\d{3})/.exec(result.stderr || '');
        throw new Error(`GitHub操作失败${status ? `（HTTP ${status[1]}）` : ''}，命令类别：${args[0]}`);
    }
    return json ? JSON.parse(result.stdout) : (result.stdout || '').trim();
}
function tagCommit(repository, tag, run = gh) {
    const ref = run(['api', '--header', 'Cache-Control: no-cache', `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`], { json: true, allowMissing: true });
    if (!ref) return null;
    let object = ref.object;
    for (let index = 0; object?.type === 'tag' && index < 10; index++) object = run(['api', `repos/${repository}/git/tags/${object.sha}`], { json: true }).object;
    if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/i.test(object.sha)) throw new Error('发布标签不能解析为提交');
    return object.sha;
}
function verifyRemoteAssets(repository, tag, remoteAssets, prepared, { complete = false, run = gh } = {}) {
    const expected = new Map(prepared.assets.map(asset => [asset.filename, asset]));
    const seen = new Set();
    for (const asset of remoteAssets) {
        const local = expected.get(asset.name);
        if (!local || seen.has(asset.name) || asset.size !== local.bytes || (asset.state && asset.state !== 'uploaded')) throw new Error('远端Release含未知、重复或大小不同的资产，停止覆盖');
        seen.add(asset.name);
        if (asset.digest) {
            if (asset.digest.toLowerCase() !== `sha256:${local.sha256}`) throw new Error('远端Release已有资产校验不同，必须使用新版本');
        } else {
            const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-release-verify-'));
            try {
                if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error('远端资产缺少有效标识');
                run(['api', '--header', 'Accept: application/octet-stream', '--header', 'Cache-Control: no-cache', `repos/${repository}/releases/assets/${asset.id}`], { outputFile: path.join(temporary, asset.name) });
                if (fileInfo(path.join(temporary, asset.name)).sha256 !== local.sha256) throw new Error('远端Release已有资产校验不同，必须使用新版本');
            } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
        }
    }
    if (complete && seen.size !== expected.size) throw new Error('远端已公开Release的资产不完整，停止修改');
    return prepared.assets.filter(asset => !seen.has(asset.filename));
}
function validateReleaseState(release, target, prepared) {
    if (target && target !== prepared.sourceCommit) throw new Error('既有标签指向其他提交，必须使用新版本');
    if (!release) return;
    if (release.tag_name !== prepared.tag || release.prerelease !== true || (!target && release.target_commitish !== prepared.sourceCommit) || (!release.draft && target !== prepared.sourceCommit)) throw new Error('既有Release的预览状态或来源不符，停止修改');
}
function findRelease(repository, tag, run = gh) {
    // 按tag接口只保证公开Release；列表对有写权限的任务也返回草稿，按ID继续操作。
    const pages = run(['api', '--paginate', '--slurp', '--header', 'Cache-Control: no-cache', `repos/${repository}/releases?per_page=100`], { json: true });
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('无法解析Release列表');
    const matches = pages.flat().filter(release => release.tag_name === tag);
    if (matches.length > 1) throw new Error('同一标签存在多份Release，停止猜测');
    if (!matches.length) return null;
    if (!Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw new Error('Release标识无效');
    return run(['api', '--header', 'Cache-Control: no-cache', `repos/${repository}/releases/${matches[0].id}`], { json: true });
}
function validateCreatedRelease(release, prepared) {
    if (!release || !Number.isSafeInteger(release.id) || release.id <= 0 || release.draft !== true || release.prerelease !== true || release.tag_name !== prepared.tag || release.target_commitish !== prepared.sourceCommit || !Array.isArray(release.assets) || release.assets.length !== 0) throw new Error('创建草稿响应缺少有效标识、来源或预览状态');
    return release;
}
function jsonRequest(root, name, method, endpoint, payload, run) {
    const file = path.join(root, 'dist', name);
    fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
    return run(['api', '--method', method, '--header', 'Content-Type: application/json; charset=utf-8', '--input', file, endpoint], { json: true });
}
const pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
function releaseById(repository, id, run, wait, expectedAssets = 0) {
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) wait(200 * attempt);
        const release = run(['api', '--header', 'Cache-Control: no-cache', `repos/${repository}/releases/${id}`], { json: true, allowMissing: true });
        if (!release) continue;
        if (release.id !== id || !Array.isArray(release.assets)) throw new Error('Release标识或资产响应不符');
        if (release.assets.length >= expectedAssets) return release;
    }
    throw new Error('Release按标识读取暂不可用或资产未就绪');
}
function publishRelease(prepared, root = path.resolve(__dirname, '..'), { run = gh, wait = pause } = {}) {
    const repository = process.env.GITHUB_REPOSITORY || '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('缺少明确的GitHub发布仓库');
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error('Release发布需要仅用于当前任务的GitHub凭据');
    let target = tagCommit(repository, prepared.tag, run);
    let release = findRelease(repository, prepared.tag, run);
    validateReleaseState(release, target, prepared);
    if (release && !release.draft) {
        verifyRemoteAssets(repository, prepared.tag, release.assets || [], prepared, { complete: true, run });
        return { url: release.html_url, alreadyPublished: true };
    }
    if (!release) {
        const body = `三人聚智 ${prepared.version} 多平台预览版\n\n来源提交：${prepared.sourceCommit}\n\n- Windows x64：未签名测试安装包。\n- macOS Intel / Apple Silicon：仅 ad-hoc 签名，未使用 Developer ID，未公证；首次打开可能需要系统确认。\n- Linux x64：AppImage 与 tar.gz 测试包。\n- 默认不携带 Python 运行时、私有插件或用户配置。请按 SHA256SUMS.txt 校验下载文件。\n- 各目标已完成原生运行与公开范围检查，不能替代用户设备上的安装、升级与权限验收。\n`;
        // 创建响应的ID是权威结果，不依赖列表或pending-tag索引的即时可见性。
        release = validateCreatedRelease(jsonRequest(root, 'preview-release-create.json', 'POST', `repos/${repository}/releases`, { tag_name: prepared.tag, target_commitish: prepared.sourceCommit, name: `三人聚智 ${prepared.version} 预览版`, body, draft: true, prerelease: true }, run), prepared);
    }
    if (!release) throw new Error('无法读取刚创建的Release草稿');
    const releaseId = release.id;
    const endpoint = `repos/${repository}/releases/${releaseId}`;
    validateReleaseState(release, tagCommit(repository, prepared.tag, run), prepared);
    if (!release.draft) throw new Error('发布暂存必须是草稿');
    const missing = verifyRemoteAssets(repository, prepared.tag, release.assets || [], prepared, { run });
    for (const asset of missing) {
        const uploaded = run(['api', '--method', 'POST', '--header', 'Content-Type: application/octet-stream', '--input', path.join(prepared.output, asset.filename), `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.filename)}`], { json: true });
        if (!uploaded || uploaded.name !== asset.filename || !Number.isSafeInteger(uploaded.id) || uploaded.id <= 0) throw new Error('上传资产响应标识或名称不符');
        verifyRemoteAssets(repository, prepared.tag, [uploaded], prepared, { run });
    }
    release = releaseById(repository, release.id, run, wait, prepared.assets.length);
    verifyRemoteAssets(repository, prepared.tag, release.assets || [], prepared, { complete: true, run });
    target = tagCommit(repository, prepared.tag, run);
    validateReleaseState(release, target, prepared);
    release = jsonRequest(root, 'preview-release-publish.json', 'PATCH', endpoint, { draft: false, prerelease: true }, run);
    if (!release || release.id !== releaseId || release.draft !== false || release.prerelease !== true || release.tag_name !== prepared.tag || !Array.isArray(release.assets)) throw new Error('Release最终状态不符');
    let publishedCommit;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) wait(200 * attempt);
        publishedCommit = tagCommit(repository, prepared.tag, run);
        if (publishedCommit) break;
    }
    if (publishedCommit !== prepared.sourceCommit) throw new Error('Release标签来源不符');
    verifyRemoteAssets(repository, prepared.tag, release.assets, prepared, { complete: true, run });
    return { url: release.html_url, alreadyPublished: false };
}
function main(argv = process.argv.slice(2)) {
    if (argv.length > 1 || argv.some(arg => !['--prepare-only', '--publish'].includes(arg))) throw new Error('只支持--prepare-only或--publish');
    const root = path.resolve(__dirname, '..');
    const prepared = prepareRelease(root);
    const result = argv.includes('--publish') ? publishRelease(prepared, root) : { preparedOnly: true };
    console.log(JSON.stringify({ version: prepared.version, tag: prepared.tag, sourceCommit: prepared.sourceCommit, targets: prepared.targets.length, assets: prepared.assets.length, ...result }));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { TARGETS, checksums, validateInputs, prepareRelease, verifyRemoteAssets, validateReleaseState, findRelease, validateCreatedRelease, releaseById, publishRelease };
