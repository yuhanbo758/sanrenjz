'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { TARGETS, validateInputs, prepareRelease, verifyRemoteAssets, validateReleaseState, checksums, publishRelease } = require('../scripts/publish-preview.cjs');
const { expectedNames } = require('../scripts/collect-ci-artifacts.cjs');
const { parseReleaseVersion, main: versionGate } = require('../scripts/preview-version.cjs');
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
function fixture(version = '1.2.3-preview.1') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-preview-test-')); roots.push(root);
    const pkg = { name: 'sanrenjz', version };
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
function mockGitHub(prepared, { published = false, partial = false, wrongTag = false, wrongDigest = false, missingDigest = false, delayedList = false, missingCreateField, wrongCreatedCommit = false, unavailableIdReads = 0, wrongPublishedId = false } = {}) {
    const calls = [];
    let tag = wrongTag ? 'b'.repeat(40) : published || partial ? sourceCommit : null;
    const allAssets = prepared.assets.map((asset, index) => ({ id: index + 1, name: asset.filename, size: asset.bytes, digest: `sha256:${asset.sha256}`, state: 'uploaded' }));
    let release = published || partial ? { id: 123, tag_name: prepared.tag, target_commitish: sourceCommit, prerelease: prepared.prerelease, draft: !published, html_url: `https://github.com/owner/repo/releases/tag/${prepared.tag}`, assets: published ? [...allAssets] : [allAssets[0]] } : null;
    if (wrongDigest && release) release.assets[0] = { ...release.assets[0], digest: `sha256:${'b'.repeat(64)}` };
    if (missingDigest && release) release.assets[0] = { ...release.assets[0], digest: null };
    let created = false;
    const requests = [];
    const copy = value => JSON.parse(JSON.stringify(value));
    const run = (args, options = {}) => {
        calls.push(args);
        if (args[0] === 'api') {
            const endpoint = args.at(-1);
            const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
            if (endpoint.includes('/git/ref/tags/')) return tag ? { object: { type: 'commit', sha: tag } } : null;
            if (endpoint.includes('/releases/tags/')) throw new Error('测试禁止通过公开tag接口读取草稿');
            if (endpoint.endsWith('/releases?per_page=100')) {
                assert(args.includes('Cache-Control: no-cache'));
                return [release && !(created && delayedList) ? [release] : []];
            }
            if (endpoint.endsWith('/releases') && method === 'POST') {
                const raw = fs.readFileSync(args[args.indexOf('--input') + 1]);
                assert(raw[0] !== 0xef && raw.toString('utf8').includes('三人聚智'));
                const payload = JSON.parse(raw.toString('utf8'));
                assert(payload.draft === true && payload.prerelease === prepared.prerelease && payload.tag_name === prepared.tag && payload.target_commitish === sourceCommit);
                assert(!Object.hasOwn(payload, 'make_latest'), '草稿阶段不设置latest');
                requests.push({ method, payload });
                release = { id: 123, tag_name: prepared.tag, target_commitish: sourceCommit, prerelease: prepared.prerelease, draft: true, html_url: `https://github.com/owner/repo/releases/tag/${prepared.tag}`, assets: [] };
                created = true;
                const response = copy(release);
                if (missingCreateField) delete response[missingCreateField];
                if (wrongCreatedCommit) response.target_commitish = 'b'.repeat(40);
                return response;
            }
            if (endpoint.startsWith('https://uploads.github.com/repos/owner/repo/releases/123/assets?name=') && method === 'POST') {
                assert(args.includes('Content-Type: application/octet-stream'));
                const name = new URL(endpoint).searchParams.get('name');
                const asset = allAssets.find(value => value.name === name);
                const file = args[args.indexOf('--input') + 1];
                assert(asset && hash(fs.readFileSync(file)) === asset.digest.slice(7) && !release.assets.some(value => value.name === asset.name));
                release.assets.push(asset);
                return copy(asset);
            }
            if (endpoint.endsWith('/releases/123') && method === 'GET') {
                if (unavailableIdReads-- > 0) return null;
                return copy(release);
            }
            if (endpoint.endsWith('/releases/123') && method === 'PATCH') {
                const payload = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
                assert.deepEqual(payload, { draft: false, prerelease: prepared.prerelease, ...(!prepared.prerelease ? { make_latest: 'true' } : {}) });
                requests.push({ method, payload });
                assert(release.assets.length === 9);
                release.draft = false; tag = sourceCommit;
                return { ...copy(release), id: wrongPublishedId ? 999 : release.id };
            }
            if (endpoint.includes('/releases/assets/') && method === 'GET') {
                const asset = allAssets.find(value => value.id === Number(endpoint.split('/').at(-1)));
                assert(asset && options.outputFile && args.includes('Accept: application/octet-stream'));
                fs.copyFileSync(path.join(prepared.output, asset.name), options.outputFile);
                return '';
            }
        }
        throw new Error('出现未预期的GitHub调用');
    };
    return { run, calls, requests, wait: () => {} };
}
try {
    for (const version of ['0.0.0', '0.1.7', '1.2.3', '123.456.789']) {
        const parsed = parseReleaseVersion(version);
        check(parsed.version === version && parsed.tag === `v${version}` && parsed.prerelease === false && parsed.channel === 'stable', '严格稳定版本必须进入正式通道');
    }
    for (const version of ['1.2.3-preview.1', '1.2.3-alpha.0', '1.2.3-0', '1.2.3-rc.1-A']) {
        const parsed = parseReleaseVersion(version);
        check(parsed.prerelease === true && parsed.channel === 'preview', '有效预发布标识必须进入预览通道');
    }
    for (const version of ['01.2.3', '1.02.3', '1.2.03', '1.2', 'v1.2.3', '1.2.3-', '1.2.3-alpha..1', '1.2.3-01', '1.2.3-alpha.01', '1.2.3+build.1', '1.2.3-preview.1+build', '1.2.3\n', ' 1.2.3', '1.2.3/escape', '', null, 123]) reject(() => parseReleaseVersion(version), /严格 SemVer/);
    let f = fixture();
    const validated = validateInputs(f.root, { sourceCommit });
    check(validated.files.length === 7 && validated.targets.length === 4, '四目标和7包必须完整');
    let prepared = prepareRelease(f.root, { sourceCommit });
    check(prepared.prerelease === true && prepared.channel === 'preview' && prepared.manifest.preview === true, '预览版元数据继续明确标记预览通道');
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
    reject(() => validateReleaseState({ tag_name: prepared.tag, prerelease: false, draft: false }, sourceCommit, prepared), /发布通道/);
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
    f = fixture(); write(path.join(f.root, 'package.json'), { ...f.pkg, version: '1.2.3+build' }); reject(() => validateInputs(f.root, { sourceCommit }), /严格 SemVer/);
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
        check(network.requests[0].payload.name.includes('预览版') && network.requests[0].payload.body.includes('预览版') && !Object.hasOwn(network.requests.at(-1).payload, 'make_latest'), '预览版保留标题与说明且不提升latest');
        check(network.calls.some(args => args[1] === '--paginate') && !network.calls.some(args => args.includes('--clobber') || args.includes('delete')), '草稿使用分页列表，禁止覆盖或删除');
        const mutating = args => args.includes('--method') && ['POST', 'PATCH', 'DELETE'].includes(args[args.indexOf('--method') + 1]);
        const uploads = args => args.at(-1).startsWith('https://uploads.github.com/');
        check(network.calls.filter(uploads).length === 9 && network.calls.every(args => args[0] === 'api'), '上传与公开全程按REST ID定位');
        network = mockGitHub(prepared, { published: true });
        check(publishRelease(prepared, f.root, network).alreadyPublished === true && !network.calls.some(mutating), '相同已公开Release保持只读');
        network = mockGitHub(prepared, { partial: true });
        check(!publishRelease(prepared, f.root, network).alreadyPublished && network.calls.filter(uploads).length === 8, '同提交草稿只补齐8个缺失资产');
        network = mockGitHub(prepared, { published: true, wrongDigest: true });
        reject(() => publishRelease(prepared, f.root, network), /校验不同/);
        check(!network.calls.some(mutating), '已有公开资产不同时不得修改远端');
        network = mockGitHub(prepared, { wrongTag: true }); reject(() => publishRelease(prepared, f.root, network), /其他提交/);
        network = mockGitHub(prepared, { published: true, missingDigest: true });
        check(publishRelease(prepared, f.root, network).alreadyPublished && network.calls.some(args => args.at(-1).includes('/releases/assets/')), '缺少服务器digest时按资产ID下载验证');
        network = mockGitHub(prepared, { delayedList: true });
        check(!publishRelease(prepared, f.root, network).alreadyPublished && network.calls.filter(args => args.includes('--paginate')).length === 1, '创建响应的ID不依赖后续列表可见性');
        for (const field of ['id', 'tag_name', 'target_commitish', 'draft', 'prerelease', 'assets']) {
            network = mockGitHub(prepared, { missingCreateField: field });
            reject(() => publishRelease(prepared, f.root, network), /创建草稿响应/);
            check(network.calls.filter(uploads).length === 0, '创建响应缺字段不得上传或猜测Release');
        }
        network = mockGitHub(prepared, { wrongCreatedCommit: true }); reject(() => publishRelease(prepared, f.root, network), /创建草稿响应/);
        network = mockGitHub(prepared, { unavailableIdReads: 2 });
        check(!publishRelease(prepared, f.root, network).alreadyPublished && network.calls.filter(args => args.at(-1).endsWith('/releases/123') && !mutating(args)).length === 3, '按ID读取仅有限重试后继续完整验证');
        network = mockGitHub(prepared, { unavailableIdReads: 9 }); reject(() => publishRelease(prepared, f.root, network), /暂不可用/);
        check(!network.calls.some(args => args.includes('PATCH')), 'ID不可读时不得公开草稿');
        network = mockGitHub(prepared, { wrongPublishedId: true }); reject(() => publishRelease(prepared, f.root, network), /最终状态/);

        f = fixture('0.1.7'); prepared = prepareRelease(f.root, { sourceCommit });
        check(prepared.prerelease === false && prepared.channel === 'stable' && prepared.manifest.preview === false, '正式版manifest不得标成预览版');
        check(prepared.assets.length === 9 && prepared.files.every(file => file.filename.startsWith('sanrenjz-0.1.7-')), '正式版仍须完整验证四目标7包');
        network = mockGitHub(prepared);
        check(!publishRelease(prepared, f.root, network).alreadyPublished, '正式版全新发布同样先草稿再上传再公开');
        const createdPayload = network.requests[0].payload;
        check(createdPayload.prerelease === false && !createdPayload.name.includes('预览') && !createdPayload.body.includes('预览') && createdPayload.name.includes('0.1.7'), '正式版标题与说明不得使用预览标记');
        check(createdPayload.body.includes('未签名') && createdPayload.body.includes('ad-hoc') && createdPayload.body.includes('未公证') && createdPayload.body.includes('不携带 Python'), '正式通道仍准确说明签名与公开包边界');
        check(network.requests.at(-1).payload.make_latest === 'true' && network.requests.at(-1).payload.prerelease === false, '正式版仅在公开PATCH显式设为latest');
        network = mockGitHub(prepared, { published: true });
        check(publishRelease(prepared, f.root, network).alreadyPublished && !network.calls.some(mutating), '已公开的同内容正式版保持只读');
        network = mockGitHub(prepared, { partial: true });
        check(!publishRelease(prepared, f.root, network).alreadyPublished && network.calls.filter(uploads).length === 8, '正式版草稿也只补缺少资产');
        reject(() => validateReleaseState({ tag_name: prepared.tag, prerelease: true, draft: false }, sourceCommit, prepared), /发布通道/);
        network = mockGitHub(prepared, { missingCreateField: 'prerelease' }); reject(() => publishRelease(prepared, f.root, network), /创建草稿响应/);
    } finally {
        if (oldRepository === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = oldRepository;
        if (oldCredential === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldCredential;
    }
    f = fixture('0.1.7');
    const oldOutput = process.env.GITHUB_OUTPUT; const oldLog = console.log;
    process.env.GITHUB_OUTPUT = path.join(f.root, 'github-output.txt'); console.log = () => {};
    try {
        const result = versionGate(f.root);
        check(result.prerelease === false && result.channel === 'stable', '版本门禁必须接受有效正式版本');
        check(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8') === 'version=0.1.7\ntag=v0.1.7\nprerelease=false\nchannel=stable\n', '门禁保留原有输出并准确增加通道字段');
        write(path.join(f.root, 'package.json'), { ...f.pkg, version: '1.2.3-01' });
        reject(() => versionGate(f.root), /严格 SemVer/);
        check(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8').split('\n').length === 5, '非法版本不得向Actions输出追加内容');
        write(path.join(f.root, 'package.json'), { ...f.pkg, version: '0.1.8-preview.1' });
        check(versionGate(f.root).prerelease === true, '门禁继续支持预览版本');
        check(fs.readFileSync(process.env.GITHUB_OUTPUT, 'utf8').endsWith('prerelease=true\nchannel=preview\n'), '预览版Actions输出必须保持预览通道');
    } finally {
        console.log = oldLog;
        if (oldOutput === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = oldOutput;
    }
    console.log(`Release passed: ${count} assertions for stable/preview channels, complete targets, hashes, immutable tags/assets, metadata, paths and idempotence`);
} finally { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); }
