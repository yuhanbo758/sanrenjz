const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
test('真实 Electron 录入/注册/保存/新进程重启（不向用户桌面注入按键）', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(),'sanrenjz-hotkey-'));
    fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({globalHotkey:'Ctrl+Shift+F11',pinHotkey:'Ctrl+D',superPanelHotkey:'',enableRightClickPanel:false,autoStart:false,migrationPrompted:true}));
    try {
        for(const phase of ['capture','restart']) {
            const child=spawnSync(require('electron'),[path.join(__dirname,'hotkey-electron.cjs'),profile,phase],{encoding:'utf8',windowsHide:true,timeout:30000});
            fs.writeFileSync(path.join(__dirname,'..','dist',`hotkey-${phase}-console.log`),(child.stdout||'')+(child.stderr||''));
            if(child.status!==0) console.error((child.stderr||'')+String(child.error||''));
            assert.equal(child.status,0,`${phase} 实际 Electron 退出成功`);
        }
    } finally { fs.rmSync(profile,{recursive:true,force:true}); }
});
