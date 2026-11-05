const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountAvatar } = require('../app/account-avatar');

function imageFixture() {
    const attributes = new Map(), listeners = {}, classes = new Set();
    return {
        complete: true, naturalWidth: 1024, hidden: true,
        classList: { toggle(key, enabled) { enabled ? classes.add(key) : classes.delete(key); }, contains(key) { return classes.has(key); } },
        addEventListener(event, callback) { listeners[event] = callback; },
        getAttribute(key) { return attributes.get(key); }, removeAttribute(key) { attributes.delete(key); },
        get src() { return attributes.get('src'); }, set src(value) { attributes.set('src', value); },
        emit(event) { listeners[event]?.(); }
    };
}
test('头像只读取本地PNG数据，不加载外部头像地址', () => {
    const image = imageFixture(), candidates = [];
    const avatar = createAccountAvatar({ image, logo: 'data:fixture-logo', createImage() { const item = { naturalWidth: 64 }; candidates.push(item); return item; } });
    for (const dataUrl of ['https://external.test/avatar.png', 'file:///private/photo.jpg', 'data:image/svg+xml;base64,YQ==']) avatar.update({ custom: true, dataUrl });
    assert.equal(candidates.length, 0); assert.equal(image.src, 'data:fixture-logo');
    avatar.update({ custom: true, dataUrl: 'data:image/png;base64,YQ==' });
    assert.equal(candidates.length, 1); assert.equal(image.src, 'data:fixture-logo');
    candidates[0].onload(); assert.equal(image.src, 'data:image/png;base64,YQ=='); assert(image.classList.contains('custom-avatar'));
});
test('本地图片失败回退可重试，恢复默认后的迟到解码不能覆盖logo', () => {
    const image = imageFixture(), candidates = [];
    const avatar = createAccountAvatar({ image, logo: 'data:fixture-logo', createImage() { const item = { naturalWidth: 64 }; candidates.push(item); return item; } });
    const preference = { custom: true, dataUrl: 'data:image/png;base64,YQ==' };
    avatar.update(preference); candidates[0].onerror();
    assert.equal(image.src, 'data:fixture-logo');
    avatar.update(preference); assert.equal(candidates.length, 2);
    const late = candidates[1].onload; avatar.update({ custom: false }); late();
    assert.equal(image.src, 'data:fixture-logo'); assert(!image.classList.contains('custom-avatar'));
    avatar.update(preference); candidates[2].onload(); image.emit('error');
    assert.equal(image.src, 'data:fixture-logo'); assert(image.hidden);
});
