'use strict';

const ROLES = new Set(['global', 'pin', 'panel']);
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super', 'Command'];
const MODIFIER_NAMES = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', win: 'Super', windows: 'Super', super: 'Super', command: 'Command', cmd: 'Command' };

function modifierName(value) {
    const name = String(value || '').toLowerCase().replace(/(?:left|right)$/, '');
    if (name === 'meta') return process.platform === 'darwin' ? 'Command' : 'Super';
    if (name === 'commandorcontrol' || name === 'cmdorctrl') return process.platform === 'darwin' ? 'Command' : 'Ctrl';
    return MODIFIER_NAMES[name] || '';
}
function mainKey(value, code = '') {
    if (code === 'Space' || value === ' ') return 'Space';
    const key = String(value || '').trim();
    const aliases = { space: 'Space', spacebar: 'Space', esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down', left: 'Left', right: 'Right', del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert', backspace: 'Backspace', tab: 'Tab', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', capslock: 'Capslock', numlock: 'Numlock', scrolllock: 'Scrolllock', printscreen: 'PrintScreen', plus: 'Plus' };
    if (value === '+') return 'Plus';
    if (aliases[key.toLowerCase()]) return aliases[key.toLowerCase()];
    if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
    return key.length === 1 ? key.toUpperCase() : key;
}
function normalizeAccelerator(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    const parts = value.split('+').map(part => part.trim());
    if (parts.some(part => !part)) return '';
    const modifiers = new Set();
    const keys = [];
    for (const part of parts) {
        const modifier = modifierName(part);
        if (modifier) modifiers.add(modifier); else keys.push(mainKey(part));
    }
    if (keys.length !== 1 || !keys[0]) return '';
    return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), keys[0]].join('+');
}
function inputAccelerator(input) {
    if (modifierName(input.key) || modifierName(input.code) || ['AltGraph', 'Unidentified', 'Dead'].includes(input.key)) return '';
    const key = mainKey(input.key, input.code);
    const modifiers = [];
    if (input.control) modifiers.push('Ctrl');
    if (input.alt) modifiers.push('Alt');
    if (input.shift) modifiers.push('Shift');
    if (input.meta) modifiers.push(process.platform === 'darwin' ? 'Command' : 'Super');
    return key && modifiers.length ? normalizeAccelerator([...modifiers, key].join('+')) : '';
}

class HotkeyController {
    constructor({ globalShortcut, window, onCaptured = () => {} }) {
        this.globalShortcut = globalShortcut;
        this.window = window;
        // BrowserWindow销毁后访问其webContents getter会抛错，生命周期清理只用缓存引用。
        this.webContents = window.webContents;
        this.onCaptured = onCaptured;
        this.bindings = new Map();
        this.capture = null;
        this.draining = null;
        this.temporary = null;
        this.disposed = false;
        this._inTransaction = false;
        this._inputListener = (event, input) => this._beforeInput(event, input);
        this._blurListener = () => this.endCapture();
        this._destroyListener = () => this.dispose();
        this.webContents.on('before-input-event', this._inputListener);
        window.on('blur', this._blurListener);
        window.on('closed', this._destroyListener);
        this.webContents.on('destroyed', this._destroyListener);
    }

    register(role, accelerator, callback) {
        if (this.disposed || !ROLES.has(role)) return false;
        const previous = this.bindings.get(role);
        if (accelerator === '' && role === 'panel') {
            if (!previous) return true;
            try { this.globalShortcut.unregister(previous.accelerator); } catch (_) { return false; }
            this.bindings.delete(role); return true;
        }
        const normalized = normalizeAccelerator(accelerator);
        if (!normalized || typeof callback !== 'function') return false;
        if ([...this.bindings.values()].some(binding => binding.role !== role && binding.accelerator === normalized)) return false;
        if (previous?.accelerator === normalized) { previous.callback = callback; return true; }
        const binding = { role, accelerator: normalized, callback };
        try {
            if (!this.globalShortcut.register(normalized, () => this._dispatch(binding))) return false;
            if (previous) {
                try { this.globalShortcut.unregister(previous.accelerator); }
                catch (_) { this.globalShortcut.unregister(normalized); return false; }
            }
            this.bindings.set(role, binding);
            return true;
        } catch (_) { return false; }
    }

    _focused() {
        try { return !this.disposed && !this.window.isDestroyed?.() && (!this.window.isFocused || this.window.isFocused()); }
        catch (_) { return false; }
    }
    _emit(payload) {
        try { this.onCaptured(payload); } catch (_) { /* 窗口销毁与IPC发送可能竞态，不能让系统回调崩溃。 */ }
    }
    _dispatch(binding) {
        if (this.bindings.get(binding.role) !== binding || this.disposed) return;
        if (this.capture || this.draining) {
            if (!this._focused()) { this.endCapture(); return; }
            if (this.capture) this._captured(binding.accelerator);
            return;
        }
        binding.callback();
    }

    beginCapture(sessionId) {
        if (this.disposed) throw new Error('快捷键控制器已经关闭');
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 160) throw new Error('无效的快捷键录入会话');
        this.endCapture();
        this.capture = { sessionId };
        let altSpaceAvailable = [...this.bindings.values()].some(binding => binding.accelerator === 'Alt+Space');
        if (!altSpaceAvailable) {
            try {
                // 原生系统菜单可能早于DOM消费Alt+Space，仅在录入期间临时向系统注册。
                altSpaceAvailable = Boolean(this.globalShortcut.register('Alt+Space', () => {
                    if (!this._focused()) { this.endCapture(); return; }
                    if (this.capture) this._captured('Alt+Space');
                }));
                if (altSpaceAvailable) this.temporary = 'Alt+Space';
            } catch (_) { altSpaceAvailable = false; }
        }
        return { sessionId, altSpaceAvailable };
    }

    _captured(accelerator) {
        if (!this.capture) return;
        const { sessionId } = this.capture;
        const parts = accelerator.split('+');
        this.capture = null;
        // 录入结果发出后仍吞掉重复消息，待组合键完全释放再恢复普通功能。
        this.draining = { sessionId, primary: parts.pop(), remainingModifiers: new Set(parts), primaryReleased: false };
        this._drainTimer = setTimeout(() => this._finishDrain(), 2000);
        this._drainTimer.unref?.();
        this._emit({ sessionId, accelerator });
    }

    _beforeInput(event, input) {
        if (!this.capture && !this.draining) return;
        if (!this._focused()) { this.endCapture(); return; }
        event.preventDefault();
        const type = String(input.type || '').toLowerCase();
        const key = mainKey(input.key, input.code);
        if (this.draining) {
            if (type === 'keyup') {
                const modifier = modifierName(input.key) || modifierName(input.code);
                if (modifier) this.draining.remainingModifiers.delete(modifier);
                if (key === this.draining.primary) this.draining.primaryReleased = true;
                if (this.draining.primaryReleased && this.draining.remainingModifiers.size === 0) this._finishDrain();
            }
            return;
        }
        if (type !== 'keydown') return;
        if (key === 'Escape') { this.endCapture(); return; }
        const accelerator = inputAccelerator(input);
        if (accelerator) this._captured(accelerator);
    }

    _releaseTemporary() {
        if (!this.temporary) return;
        const accelerator = this.temporary;
        this.temporary = null;
        try { this.globalShortcut.unregister(accelerator); } catch (_) { /* 退出时继续释放其余自有资源。 */ }
    }
    _finishDrain() {
        if (this._drainTimer) clearTimeout(this._drainTimer);
        this._drainTimer = null;
        this.draining = null;
        this._releaseTemporary();
    }
    endCapture({ cancelled = true } = {}) {
        const active = this.capture;
        this.capture = null;
        this._finishDrain();
        if (active && cancelled) this._emit({ sessionId: active.sessionId, cancelled: true });
    }

    _releaseBindings() {
        const errors = [];
        for (const [role, binding] of this.bindings) {
            try { this.globalShortcut.unregister(binding.accelerator); this.bindings.delete(role); }
            catch (_) { errors.push(`${role}(${binding.accelerator})`); }
        }
        return errors;
    }
    transaction(fn) {
        if (this.disposed || this._inTransaction || typeof fn !== 'function') throw new Error('无效的快捷键事务');
        this.endCapture();
        const snapshot = [...this.bindings.values()].map(binding => ({ ...binding }));
        this._inTransaction = true;
        try {
            if (this._releaseBindings().length) throw new Error('无法释放当前快捷键');
            const value = fn();
            if (value && typeof value.then === 'function') throw new Error('快捷键事务必须同步执行');
            return value;
        } catch (error) {
            const failures = this._releaseBindings();
            for (const binding of snapshot) {
                if (!this.register(binding.role, binding.accelerator, binding.callback)) failures.push(`${binding.role}(${binding.accelerator})`);
            }
            if (failures.length) {
                const failure = new Error(`快捷键事务失败，旧绑定恢复失败：${[...new Set(failures)].join('、')}`);
                failure.cause = error;
                throw failure;
            }
            throw error;
        } finally { this._inTransaction = false; }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.endCapture();
        for (const [target, event, listener] of [[this.webContents, 'before-input-event', this._inputListener], [this.webContents, 'destroyed', this._destroyListener], [this.window, 'blur', this._blurListener], [this.window, 'closed', this._destroyListener]]) {
            try { target.removeListener(event, listener); } catch (_) { /* 销毁清理必须幂等，单个对象失效不阻断其余释放。 */ }
        }
        this._releaseBindings();
    }
}

module.exports = { HotkeyController, normalizeAccelerator };
