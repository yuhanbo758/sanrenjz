'use strict';
const path = require('path');
const installed = new WeakMap();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function resourceBusy(error) {
    const message = String(error?.message || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    return (error?.code === 16 || /^Exit code: 16\./.test(message)) && /Resource busy/i.test(message);
}
function install(context, options = {}) {
    if (context.electronPlatformName !== 'darwin') return false;
    const manager = context.packager?.info?.tempDirManager;
    if (!manager || !Array.isArray(manager.tempFiles)) throw new Error('DMG重试缺少本次构建的临时文件登记');
    const builderUtil = options.builderUtil || require('builder-util');
    let state = installed.get(builderUtil);
    if (state) {
        if (builderUtil.exec !== state.wrapper) throw new Error('DMG执行器已被其他钩子修改，停止覆盖');
        state.managers.add(manager);
        return true;
    }
    const originalExec = options.exec || builderUtil.exec;
    const wait = options.sleep || sleep;
    if (typeof originalExec !== 'function' || typeof wait !== 'function') throw new Error('DMG重试执行器或延迟函数无效');
    state = { managers: new Set([manager]), devices: new Set() };
    const ownedImage = file => typeof file === 'string' && path.isAbsolute(file) && path.extname(file) === '.dmg' && [...state.managers].some(owner => owner.tempFiles.some(entry => entry.path === file && !entry.isDir));
    state.wrapper = async function(file, args, ...rest) {
        const hdiutil = file === 'hdiutil' || file === '/usr/bin/hdiutil';
        // afterPack早于DMG创建，必须在attach时读取本次构建的动态登记表。
        if (hdiutil && Array.isArray(args) && args[0] === 'attach') {
            const owned = ownedImage(args.at(-1));
            const output = await originalExec.call(this, file, args, ...rest);
            const device = typeof output === 'string' && /^(\/dev\/disk[0-9]+)(?=\s|$)/.exec(output)?.[1];
            // 系统可能复用设备号；外部镜像的成功attach不能继承旧登记。
            if (device) { if (owned) state.devices.add(device); else state.devices.delete(device); }
            return output;
        }
        const target = args?.[2];
        const ownedDetach = hdiutil && Array.isArray(args) && args.length === 3 && args[0] === 'detach' && ['-quiet', '-force'].includes(args[1]) && state.devices.has(target);
        if (!ownedDetach) return originalExec.call(this, file, args, ...rest);
        for (let attempt = 0; ; attempt++) {
            try {
                const result = await originalExec.call(this, file, args, ...rest);
                state.devices.delete(target);
                return result;
            } catch (error) {
                // 保留库原有quiet回退；只给本次已挂载设备的资源忙增加有限重试。
                if (args[1] !== '-force' || !resourceBusy(error) || attempt === 3) throw error;
                await wait(3000 * (attempt + 1));
            }
        }
    };
    builderUtil.exec = state.wrapper;
    installed.set(builderUtil, state);
    return true;
}
module.exports = { install };
