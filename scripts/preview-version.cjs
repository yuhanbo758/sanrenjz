const fs = require('fs');
const path = require('path');
const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) throw new Error('自动发布仅接受明确的预览版本号');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
console.log(JSON.stringify({ version, tag: `v${version}`, prerelease: true }));
