'use strict';
const fs = require('fs');
const path = require('path');

function loadAppLogo({ appDirectory, resourcesPath }) {
    const candidates = [path.join(appDirectory, 'build', 'icon.png'), resourcesPath && path.join(resourcesPath, 'build', 'icon.png')].filter(Boolean);
    for (const file of candidates) {
        try {
            const bytes = fs.readFileSync(file);
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) continue;
            // extraResources 图标位于 ASAR 外；读取后直接嵌入，避免安装态相对路径失效。
            return `data:image/png;base64,${bytes.toString('base64')}`;
        } catch (_) { /* 损坏的首选资源仍可尝试另一安装布局。 */ }
    }
    return '';
}

function createAccountAvatar({ image, logo, createImage = () => new Image() }) {
    let generation = 0, target = '', pending;
    const show = (source, custom = false) => {
        image.classList.toggle('custom-avatar', custom);
        if (image.getAttribute('src') !== source) {
            image.hidden = true;
            if (source) image.src = source;
            else image.removeAttribute('src');
        } else if (image.complete && image.naturalWidth > 0) image.hidden = false;
    };
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => { image.hidden = image.naturalWidth === 0; });
    image.addEventListener('error', () => { image.hidden = true; target = ''; show(logo); });
    show(logo);
    return {
        update(preference) {
            const nextTarget = preference?.custom && typeof preference.dataUrl === 'string' &&
                preference.dataUrl.length <= 2 * 1024 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(preference.dataUrl)
                ? preference.dataUrl : '';
            if (target === nextTarget) return;
            target = nextTarget;
            const current = ++generation;
            if (pending) { pending.onload = null; pending.onerror = null; pending = null; }
            show(logo);
            if (!target) return;
            // 本地头像先解码再替换；恢复默认后，旧图片的迟到事件不能覆盖 logo。
            const candidate = pending = createImage();
            candidate.referrerPolicy = 'no-referrer';
            candidate.onload = () => {
                if (current !== generation) return;
                pending = null;
                if (candidate.naturalWidth > 0) show(nextTarget, true);
            };
            candidate.onerror = () => { if (current === generation) { pending = null; target = ''; show(logo); } };
            candidate.src = nextTarget;
        }
    };
}

module.exports = { loadAppLogo, createAccountAvatar };
