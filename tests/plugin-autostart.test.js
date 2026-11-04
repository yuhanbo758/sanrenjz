const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-autostart-restart-'));
try {
    const directory = path.join(profile, 'plugins', 'speech-fixture');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ enableRightClickPanel: false, autoStart: false }));
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: 'AI语音输入法', main: 'index.html', features: [{ code: 'speech-config' }] }));
    fs.writeFileSync(path.join(directory, 'index.html'), `<script>window.businessRuns=0;window.exports={'speech-config':{mode:'none',args:{enter(){window.businessRuns++}}}};</script>`);
    const electron = require('electron');
    for (const phase of ['save', 'restart']) {
        const args = [path.join(__dirname, 'plugin-autostart-electron.test.js'), profile, phase];
        if (process.argv.includes('--expect-blocked')) args.push('--expect-blocked');
        if (process.argv.includes('--default-userdata')) args.push('--default-userdata');
        const result = spawnSync(electron, args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
        for (const line of `${result.stdout || ''}\n${result.stderr || ''}`.split(/\r?\n/)) {
            if (line.startsWith('AUTOSTART_')) console.log(line);
        }
        if (result.status !== 0) console.error(result.stderr || result.error || result.stdout);
        assert.strictEqual(result.status, 0, `${phase} 阶段失败`);
    }
} finally {
    fs.rmSync(profile, { recursive: true, force: true });
}
