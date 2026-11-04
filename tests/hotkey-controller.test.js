'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { HotkeyController, normalizeAccelerator } = require('../app/hotkey-controller');

class Shortcuts {
    constructor() { this.keys = new Map(); this.fail = new Set(); this.unregistered = []; }
    register(key, callback) { if (this.keys.has(key) || this.fail.has(key)) return false; this.keys.set(key, callback); return true; }
    unregister(key) { assert(this.keys.has(key), `不得注销未知快捷键：${key}`); this.unregistered.push(key); this.keys.delete(key); }
    press(key) { const callback = this.keys.get(key); assert(callback, `快捷键未注册：${key}`); callback(); }
}
function fixture() {
    const window = new EventEmitter(); window.focused = true; window.isFocused = () => window.focused; window.isDestroyed = () => false;
    window.webContents = new EventEmitter();
    const globalShortcut = new Shortcuts();
    const events = [];
    const controller = new HotkeyController({ globalShortcut, window, onCaptured: value => events.push(value) });
    const input = (key, type = 'keyDown', modifiers = {}) => {
        let prevented = false;
        window.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { key, type, ...modifiers });
        return prevented;
    };
    return { controller, globalShortcut, window, events, input };
}

assert.strictEqual(normalizeAccelerator('Control+ALT+spacebar'), 'Ctrl+Alt+Space');
assert.strictEqual(normalizeAccelerator('Alt+Control+a'), 'Ctrl+Alt+A');
assert.strictEqual(normalizeAccelerator('Control+Shift'), '');
assert.strictEqual(normalizeAccelerator('ctrl+DELETE'), 'Ctrl+Delete');

{
    const { controller, globalShortcut } = fixture();
    let runs = 0;
    assert(controller.register('global', 'Alt+Space', () => runs++));
    globalShortcut.fail.add('Ctrl+Space');
    assert.strictEqual(controller.register('global', 'Ctrl+Space', () => runs += 10), false);
    assert(globalShortcut.keys.has('Alt+Space'));
    assert.deepStrictEqual(globalShortcut.unregistered, []);
    globalShortcut.press('Alt+Space'); assert.strictEqual(runs, 1);
    assert(controller.register('global', 'Control+Alt+P', () => runs++));
    assert(!globalShortcut.keys.has('Alt+Space'));
    assert.strictEqual(controller.register('pin', 'Ctrl+Alt+P', () => {}), false);
    assert(controller.register('panel', 'Ctrl+Alt+L', () => {}));
    assert(controller.register('panel', '', () => {}));
    assert(!globalShortcut.keys.has('Ctrl+Alt+L'));
    controller.dispose(); assert.strictEqual(globalShortcut.keys.size, 0);
}
{
    const { controller, globalShortcut } = fixture();
    let runs = 0;
    controller.register('global', 'Alt+Space', () => runs++);
    controller.register('pin', 'Ctrl+D', () => runs += 10);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hotkey-persist-'));
    try {
        const settings = path.join(temporary, 'settings.json'); fs.writeFileSync(settings, '{"globalHotkey":"Alt+Space"}');
        assert.throws(() => controller.transaction(() => {
            assert(controller.register('global', 'Ctrl+Alt+P', () => runs += 100));
            fs.writeFileSync(path.join(temporary, 'missing', 'settings.json'), '{}');
        }), /ENOENT/);
        assert(globalShortcut.keys.has('Alt+Space') && globalShortcut.keys.has('Ctrl+D'));
        assert(!globalShortcut.keys.has('Ctrl+Alt+P'));
        assert.strictEqual(fs.readFileSync(settings, 'utf8'), '{"globalHotkey":"Alt+Space"}');
        globalShortcut.press('Alt+Space'); globalShortcut.press('Ctrl+D'); assert.strictEqual(runs, 11);
        assert.strictEqual(controller.transaction(() => { assert(controller.register('global', 'Ctrl+Alt+P', () => {})); return 42; }), 42);
        assert.deepStrictEqual([...globalShortcut.keys.keys()], ['Ctrl+Alt+P']);
    } finally { controller.dispose(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
{
    const { controller, globalShortcut } = fixture();
    controller.register('global', 'Alt+Space', () => {});
    assert.throws(() => controller.transaction(() => { globalShortcut.fail.add('Alt+Space'); throw new Error('persist failed'); }), /旧绑定恢复失败.*Alt\+Space/);
    controller.dispose();
}
{
    const { controller, globalShortcut, events, input } = fixture();
    let runs = 0;
    controller.register('global', 'Alt+Space', () => runs++);
    assert.deepStrictEqual(controller.beginCapture('own'), { sessionId: 'own', altSpaceAvailable: true });
    assert(input('Alt', 'keyDown', { alt: true })); assert.strictEqual(events.length, 0);
    globalShortcut.press('Alt+Space'); globalShortcut.press('Alt+Space');
    assert.deepStrictEqual(events, [{ sessionId: 'own', accelerator: 'Alt+Space' }]); assert.strictEqual(runs, 0);
    assert(input(' ', 'keyUp', { alt: true })); globalShortcut.press('Alt+Space'); assert.strictEqual(runs, 0);
    assert(input('Alt', 'keyUp')); globalShortcut.press('Alt+Space'); assert.strictEqual(runs, 1);
    assert.strictEqual(input('x'), false);
    controller.dispose();
}
{
    const { controller, globalShortcut, events, input } = fixture();
    controller.register('global', 'Ctrl+J', () => {});
    assert(controller.beginCapture('temporary').altSpaceAvailable);
    assert(globalShortcut.keys.has('Alt+Space'));
    globalShortcut.press('Alt+Space');
    assert(globalShortcut.keys.has('Alt+Space'), '释放前保留临时原生拦截');
    input(' ', 'keyUp', { alt: true }); input('Alt', 'keyUp');
    assert(!globalShortcut.keys.has('Alt+Space') && globalShortcut.keys.has('Ctrl+J'));
    controller.beginCapture('escape'); assert(input('Escape'));
    assert.deepStrictEqual(events.at(-1), { sessionId: 'escape', cancelled: true });
    assert(!globalShortcut.keys.has('Alt+Space'));
    controller.dispose();
}
{
    const { controller, globalShortcut, window, events, input } = fixture();
    globalShortcut.register('Alt+Space', () => {}); // 外部占用，控制器不能假装持有或注销。
    assert.deepStrictEqual(controller.beginCapture('occupied'), { sessionId: 'occupied', altSpaceAvailable: false });
    assert(input('x', 'keyDown', { control: true, shift: true }));
    assert.deepStrictEqual(events.at(-1), { sessionId: 'occupied', accelerator: 'Ctrl+Shift+X' });
    controller.endCapture(); assert(globalShortcut.keys.has('Alt+Space'));
    controller.beginCapture('blur'); window.focused = false; window.emit('blur');
    assert.deepStrictEqual(events.at(-1), { sessionId: 'blur', cancelled: true });
    controller.dispose(); assert(globalShortcut.keys.has('Alt+Space'));
    assert.strictEqual(window.webContents.listenerCount('before-input-event'), 0);
}
{
    const { controller, globalShortcut, events } = fixture();
    let runs = 0; controller.register('global', 'Alt+Space', () => runs++);
    const originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout;
    let release;
    const timer = { unref() {} };
    global.setTimeout = (callback, timeout) => { assert(timeout > 0 && timeout <= 3000); release = callback; return timer; };
    global.clearTimeout = value => { assert.strictEqual(value, timer); };
    try {
        controller.beginCapture('fallback'); globalShortcut.press('Alt+Space');
        assert.strictEqual(events.length, 1); assert.strictEqual(runs, 0);
        release(); globalShortcut.press('Alt+Space'); assert.strictEqual(runs, 1);
    } finally { controller.dispose(); global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout; }
}
{
    const { controller, globalShortcut, window, events } = fixture();
    controller.register('global', 'Ctrl+J', () => {}); controller.beginCapture('destroy');
    window.webContents.emit('destroyed');
    assert.deepStrictEqual(events.at(-1), { sessionId: 'destroy', cancelled: true });
    assert.strictEqual(globalShortcut.keys.size, 0);
}
{
    const { controller, globalShortcut, window, events } = fixture();
    const contents = window.webContents;
    let destroyed = false;
    Object.defineProperty(window, 'webContents', { get() { if (destroyed) throw new Error('Object has been destroyed'); return contents; } });
    window.isDestroyed = () => destroyed;
    controller.register('global', 'Ctrl+J', () => {});
    controller.beginCapture('destroyed-getter');
    destroyed = true;
    assert.throws(() => window.webContents, /destroyed/);
    assert.doesNotThrow(() => window.emit('closed'));
    assert.doesNotThrow(() => controller.dispose());
    assert.doesNotThrow(() => contents.emit('destroyed'));
    assert.deepStrictEqual(events.at(-1), { sessionId: 'destroyed-getter', cancelled: true });
    assert.strictEqual(globalShortcut.keys.size, 0);
    assert.strictEqual(contents.listenerCount('before-input-event'), 0);
    assert.strictEqual(window.listenerCount('closed'), 0);
}
{
    const { controller, globalShortcut, window, events } = fixture();
    let runs = 0;
    controller.register('global', 'Alt+Space', () => runs++);
    controller.beginCapture('focus-race');
    window.focused = false;
    globalShortcut.press('Alt+Space');
    assert.strictEqual(runs, 0, '失焦与blur事件之间的竞态不能执行正在录入的业务快捷键');
    assert.deepStrictEqual(events.at(-1), { sessionId: 'focus-race', cancelled: true });
    controller.dispose();
}
console.log('Hotkey controller passed: ownership, failed registration, real I/O rollback, restore errors, native capture routing, key-release draining, bounded fallback, Escape/blur/destroy cleanup');
