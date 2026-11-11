'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { nextReleaseVersion, main } = require('../scripts/bump-version.cjs');

test('发布版本每十个末位版本进位，保留首位版本号', () => {
    for (const [current, next] of [['0.2.0', '0.2.1'], ['0.2.8', '0.2.9'], ['0.2.9', '0.3.0'], ['0.9.9', '0.10.0'], ['1.2.9', '1.3.0']]) {
        assert.equal(nextReleaseVersion(current), next);
    }
    for (const version of ['0.1.13', '0.2.10', '0.2.01', '0.2.0-beta.1', 'v0.2.0', '0.2.0+build']) {
        assert.throws(() => nextReleaseVersion(version));
    }
});

test('默认预览、显式应用和 CI 校验同步三个版本字段，不改其他配置', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-version-'));
    const packageFile = path.join(root, 'package.json');
    const lockFile = path.join(root, 'package-lock.json');
    const pkg = { name: 'sanrenjz', version: '0.2.9', build: { appId: 'com.sanrenjz.app' } };
    const lock = { name: 'sanrenjz', version: '0.2.9', packages: { '': { version: '0.2.9' }, fixture: { version: '2.3.4' } } };
    fs.writeFileSync(packageFile, JSON.stringify(pkg));
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    try {
        assert.deepEqual(main([], root), { current: '0.2.9', next: '0.3.0', applied: false });
        assert.equal(fs.readFileSync(packageFile, 'utf8'), JSON.stringify(pkg));
        assert.deepEqual(main(['--check'], root), { current: '0.2.9', valid: true });
        assert.deepEqual(main(['--apply'], root), { current: '0.2.9', next: '0.3.0', applied: true });
        assert.deepEqual(JSON.parse(fs.readFileSync(packageFile)), { ...pkg, version: '0.3.0' });
        assert.deepEqual(JSON.parse(fs.readFileSync(lockFile)), { ...lock, version: '0.3.0', packages: { ...lock.packages, '': { version: '0.3.0' } } });
        lock.version = '0.3.0';
        fs.writeFileSync(lockFile, JSON.stringify(lock));
        assert.throws(() => main(['--apply'], root), /版本不一致/);
        assert.equal(JSON.parse(fs.readFileSync(packageFile)).version, '0.3.0');
        assert.throws(() => main(['--apply', '--check'], root), /仅支持/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('版本递增保留 Windows 文件原有 CRLF，不改依赖版本', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-version-eol-'));
    const pkg = { name: 'sanrenjz', version: '0.2.0' };
    const lock = { version: '0.2.0', packages: { '': { version: '0.2.0' }, dependency: { version: '0.2.0' } } };
    const serialize = value => `${JSON.stringify(value, null, 2)}\n`.replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(root, 'package.json'), serialize(pkg));
    fs.writeFileSync(path.join(root, 'package-lock.json'), serialize(lock));
    try {
        main(['--apply'], root);
        pkg.version = '0.2.1';
        lock.version = '0.2.1'; lock.packages[''].version = '0.2.1';
        assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), serialize(pkg));
        assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), serialize(lock));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
