'use strict';
const fs = require('fs');
const path = require('path');

function parseReleaseVersion(version) {
    const number = '(?:0|[1-9][0-9]*)';
    const identifier = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
    const pattern = new RegExp(`^${number}\\.${number}\\.${number}(?:-(${identifier}(?:\\.${identifier})*))?$`);
    const match = typeof version === 'string' ? pattern.exec(version) : null;
    if (!match || match[0] !== version) throw new Error('发布版本号必须为严格 SemVer 正式版或预发布版，不能包含构建元数据');
    // 正式与预览通道由版本决定，不能用环境变量把预发布号标成正式版。
    const prerelease = Boolean(match[1]);
    return { version, tag: `v${version}`, prerelease, channel: prerelease ? 'preview' : 'stable' };
}
function main(root = path.resolve(__dirname, '..')) {
    const result = parseReleaseVersion(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\nprerelease=${result.prerelease}\nchannel=${result.channel}\n`);
    console.log(JSON.stringify(result));
    return result;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { parseReleaseVersion, main };
