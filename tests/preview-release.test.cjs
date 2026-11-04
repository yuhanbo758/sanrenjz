'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { TARGETS, validateInputs, prepareRelease, verifyRemoteAssets, validateReleaseState, checksums, publishRelease } = require('../scripts/publish-preview.cjs');
const { expectedNames } = require('../scripts/collect-ci-artifacts.cjs');
const sourceCommit = 'a'.repeat(40);
const roots = [];
let count = 0;
const check = (value, message) => { assert(value, message); count++; };
const reject = (callback, pattern) => { assert.throws(callback, pattern); count++; };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-preview-test-')); roots.push(root);
    const pkg = { name: 'sanrenjz', version: '1.2.3-preview.1' };
    write(path.join(root, 'package.json'), pkg);
    const targets = [];
    for (const target of TARGETS) {
        const directory = path.join(root, 'dist/release-input', target.directory);
        const files = expectedNames(pkg, target.cliPlatform, target.arch).map(filename => {
            const data = Buffer.from(`Synthetic public installer ${target.target}`);
            write(path.join(directory, filename), data);
            return { filename, bytes: data.length, sha256: hash(data) };
        });
        const info = { schemaVersion: 1, target: target.target, version: pkg.version, platform: target.platform, arch: target.arch, files, sourceCommit, auditedEntries: 20, bundledPython: false, personal: false, published: false, signing: target.signing, notarized: false, runtimeVerified: true, runtimeAssertions: 17 };
        write(path.join(directory, 'build-info.json'), info);
        write(path.join(directory, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.filename}\n`).join(''));
        targets.push({ ...target, directory, info });
    }
    return { root, pkg, targets };
}
function mockGitHub(prepared, { published = false, partial = false, wrongTag = false, wrongDigest = false, missingDigest = false } = {}) {
    const calls = [];
    let tag = wrongTag ? 'b'.repeat(40) : published || partial ? sourceCommit : null;
    const allAssets = prepared.assets.map(asset => ({ name: asset.filename, size: asset.bytes, digest: `sha256:${asset.sha256}`, state: 'uploaded' }));
    let release = published || partial ? { id: 123, tag_name: prepared.tag, target_commitish: sourceCommit, prerelease: true, draft: !published, html_url: `https://github.com/owner/repo/releases/tag/${prepared.tag}`, assets: published ? [...allAssets] : [allAssets[0]] } : null;
    if (wrongDigest && release) release.assets[0] = { ...release.assets[0], digest: `sha256:${'b'.repeat(64)}` };
    if (missingDigest && release) release.assets[0] = { ...release.assets[0], digest: null };
    const run = args => {
        calls.push(args);
        if (args[0] === 'api') {
            const endpoint = args.at(-1);
            if (endpoint.includes('/git/ref/tags/')) return tag ? { object: { type: 'commit', sha: tag } } : null;
            if (endpoint.includes('/releases/tags/')) throw new Error('测试禁止通过公开tag接口读取草稿');
            if (endpoint.endsWith('/releases?per_page=100')) return [release ? [release] : []];
            if (endpoint.endsWith('/releases/123')) return JSON.parse(JSON.stringify(release));
        }
        if (args[0] === 'release' && args[1] === 'create') {
            assert(args.includes('--draft') && args.includes('--prerelease'));
            release = { id: 123, tag_name: prepared.tag, target_commitish: sourceCommit, prerelease: true, draft: true, html_url: `https://github.com/owner/repo/releases/tag/${prepared.tag}`, assets: [] };
            return '';
        }
        if (args[0] === 'release' && args[1] === 'upload') {
            for (const file of args.slice(3, args.indexOf('--repo'))) {
                const asset = allAssets.find(value => value.name === path.basename(file));
                assert(asset && !release.assets.some(value => value.name === asset.name));
                release.assets.push(asset);
            }
            return '';
        }
        if (args[0] === 'release' && args[1] === 'edit') {
            assert(args.includes('--draft=false') && release.assets.length === 9);
            release.draft = false; tag = sourceCommit;
            return '';
        }
        if (args[0] === 'release' && args[1] === 'download') {
            const filename = args[args.indexOf('--pattern') + 1];
            const destination = args[args.indexOf('--dir') + 1];
            fs.copyFileSync(path.join(prepared.output, filename), path.join(destination, filename));
            return '';
        }
        throw new Error('出现未预期的GitHub调用');
    };
    return { run, calls };
}
try {
    let f = fixture();
    const validated = validateInputs(f.root, { sourceCommit });
    check(validated.files.length === 7 && validated.targets.length === 4, '四目标和7包必须完整');
    let prepared = prepareRelease(f.root, { sourceCommit });
    check(prepared.assets.length === 9 && fs.readdirSync(prepared.output).length === 9, '只发布7包和两份汇总文件');
    const sums = checksums(fs.readFileSync(path.join(prepared.output, 'SHA256SUMS.txt'), 'utf8'));
    check(sums.size === 8 && sums.has('release-manifest.json'), '全局校验覆盖安装包与manifest');
    for (const [name, sha] of sums) check(hash(fs.readFileSync(path.join(prepared.output, name))) === sha, '全局校验必须来自实际输出');
    check(!JSON.stringify(prepared.manifest).includes(f.root) && !JSON.stringify(prepared.manifest).includes('sourcePath'), '发布manifest不得暴露本地路径');
    check(prepareRelease(f.root, { sourceCommit }).assets.length === 9, '相同本地输入应幂等');
    const remote = prepared.assets.map(asset => ({ name: asset.filename, size: asset.bytes, digest: `sha256:${asset.sha256}`, state: 'uploaded' }));
    check(verifyRemoteAssets('owner/repo', prepared.tag, remote, prepared, { complete: true }).length === 0, '相同远端资产应无需变更');
    check(verifyRemoteAssets('owner/repo', prepared.tag, remote.slice(0, 3), prepared).length === 6, '草稿只应补齐缺少资产');
    reject(() => verifyRemoteAssets('owner/repo', prepared.tag, remote.slice(0, 3), prepared, { complete: true }), /不完整/);
    reject(() => verifyRemoteAssets('owner/repo', prepared.tag, [{ ...remote[0], digest: `sha256:${'b'.repeat(64)}` }], prepared), /校验不同/);
    reject(() => verifyRemoteAssets('owner/repo', prepared.tag, [...remote, { name: 'unknown-file.bin', size: 1 }], prepared), /未知/);
    reject(() => verifyRemoteAssets('owner/repo', prepared.tag, [remote[0], remote[0]], prepared), /重复/);
    reject(() => verifyRemoteAssets('owner/repo', prepared.tag, [{ ...remote[0], size: 1 }], prepared), /大小不同/);
    validateReleaseState(null, sourceCommit, prepared); count++;
    validateReleaseState({ tag_name: prepared.tag, prerelease: true, draft: false, target_commitish: 'main' }, sourceCommit, prepared); count++;
    reject(() => validateReleaseState(null, 'b'.repeat(40), prepared), /其他提交/);
    reject(() => validateReleaseState({ tag_name: prepared.tag, prerelease: false, draft: false }, sourceCommit, prepared), /预览状态/);
    reject(() => validateReleaseState({ tag_name: prepared.tag, prerelease: true, draft: true, target_commitish: 'main' }, null, prepared), /来源不符/);
    reject(() => validateReleaseState({ tag_name: prepared.tag, prerelease: true, draft: false, target_commitish: sourceCommit }, null, prepared), /来源不符/);

    f = fixture(); fs.rmSync(f.targets[3].directory, { recursive: true, force: true }); reject(() => validateInputs(f.root, { sourceCommit }), /四个平台/);
    f = fixture(); write(path.join(f.targets[0].directory, f.targets[0].info.files[0].filename), 'modified'); reject(() => validateInputs(f.root, { sourceCommit }), /校验不符/);
    f = fixture(); write(path.join(f.targets[1].directory, 'build-info.json'), { ...f.targets[1].info, sourceCommit: 'b'.repeat(40) }); reject(() => validateInputs(f.root, { sourceCommit }), /元数据/);
    f = fixture(); write(path.join(f.targets[1].directory, 'build-info.json'), { ...f.targets[1].info, bundledPython: true }); reject(() => validateInputs(f.root, { sourceCommit }), /元数据/);
    f = fixture(); write(path.join(f.targets[1].directory, 'build-info.json'), { ...f.targets[1].info, personal: true }); reject(() => validateInputs(f.root, { sourceCommit }), /元数据/);
    f = fixture(); write(path.join(f.targets[1].directory, 'build-info.json'), { ...f.targets[1].info, runtimeVerified: false }); reject(() => validateInputs(f.root, { sourceCommit }), /元数据/);
    f = fixture(); write(path.join(f.targets[1].directory, '.env'), 'synthetic'); reject(() => validateInputs(f.root, { sourceCommit }), /未知/);
    f = fixture(); write(path.join(f.targets[1].directory, 'SHA256SUMS.txt'), `${'a'.repeat(64)}  ../escape.zip\n`); reject(() => validateInputs(f.root, { sourceCommit }), /非法路径/);
    f = fixture(); write(path.join(f.targets[1].directory, 'build-info.json'), { ...f.targets[1].info, files: [f.targets[1].info.files[0], f.targets[1].info.files[0]] }); reject(() => validateInputs(f.root, { sourceCommit }), /安装包列表/);
    f = fixture(); write(path.join(f.targets[1].directory, 'build-info.json'), { ...f.targets[1].info, signing: 'Developer ID' }); reject(() => validateInputs(f.root, { sourceCommit }), /元数据/);
    f = fixture(); write(path.join(f.root, 'package.json'), { ...f.pkg, version: '1.2.3' }); reject(() => validateInputs(f.root, { sourceCommit }), /预览版本/);
    f = fixture(); reject(() => validateInputs(f.root, { sourceCommit: '' }), /完整来源/);
    f = fixture(); prepared = prepareRelease(f.root, { sourceCommit }); write(path.join(prepared.output, 'unexpected.txt'), 'fixture'); reject(() => prepareRelease(f.root, { sourceCommit }), /停止覆盖/);
    f = fixture(); prepared = prepareRelease(f.root, { sourceCommit }); write(path.join(prepared.output, prepared.assets[0].filename), 'modified'); reject(() => prepareRelease(f.root, { sourceCommit }), /停止覆盖/);
    f = fixture();
    try {
        const original = f.targets[0].directory;
        fs.renameSync(original, `${original}-outside`);
        fs.symlinkSync(`${original}-outside`, original, process.platform === 'win32' ? 'junction' : 'dir');
        // 外部真实目录也会成为未知输入，任一保护都必须阻止发布。
        reject(() => validateInputs(f.root, { sourceCommit }), /四个平台|链接/);
    } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
    f = fixture(); prepared = prepareRelease(f.root, { sourceCommit });
    const oldRepository = process.env.GITHUB_REPOSITORY;
    const oldCredential = process.env.GH_TOKEN;
    process.env.GITHUB_REPOSITORY = 'owner/repo'; process.env.GH_TOKEN = 'fixture';
    try {
        let network = mockGitHub(prepared);
        check(publishRelease(prepared, f.root, network).alreadyPublished === false, '全新发布必须先草稿再上传再公开');
        check(network.calls.some(args => args[1] === '--paginate') && !network.calls.some(args => args.includes('--clobber') || args.includes('delete')), '草稿使用分页列表，禁止覆盖或删除');
        network = mockGitHub(prepared, { published: true });
        check(publishRelease(prepared, f.root, network).alreadyPublished === true && !network.calls.some(args => ['create', 'upload', 'edit'].includes(args[1])), '相同已公开Release保持只读');
        network = mockGitHub(prepared, { partial: true });
        check(!publishRelease(prepared, f.root, network).alreadyPublished && network.calls.find(args => args[1] === 'upload').slice(3, -2).length === 8, '同提交草稿只补齐8个缺失资产');
        network = mockGitHub(prepared, { published: true, wrongDigest: true });
        reject(() => publishRelease(prepared, f.root, network), /校验不同/);
        check(!network.calls.some(args => ['create', 'upload', 'edit'].includes(args[1])), '已有公开资产不同时不得修改远端');
        network = mockGitHub(prepared, { wrongTag: true }); reject(() => publishRelease(prepared, f.root, network), /其他提交/);
        network = mockGitHub(prepared, { published: true, missingDigest: true });
        check(publishRelease(prepared, f.root, network).alreadyPublished && network.calls.some(args => args[1] === 'download'), '缺少服务器digest时下载验证');
    } finally {
        if (oldRepository === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = oldRepository;
        if (oldCredential === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldCredential;
    }
    console.log(`Preview release passed: ${count} assertions for complete targets, hashes, immutable tags/assets, metadata, paths and idempotence`);
} finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); }
