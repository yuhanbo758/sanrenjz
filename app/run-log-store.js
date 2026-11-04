'use strict';

const ENGINES = new Set(['tools', 'python']);
const STREAMS = new Set(['system', 'stdout', 'stderr']);
const MAX_MESSAGE_CHARS = 16000;
const TRUNCATED = ' [输出过长，已截断]';

function sourceIdentity(value) {
    if (!value || !ENGINES.has(value.engine) || typeof value.id !== 'string'
        || !value.id.startsWith(`${value.engine}:`) || value.id.length <= value.engine.length + 1
        || value.id.length > 4096 || /[\u0000-\u001f\u007f]/.test(value.id)) return null;
    return { id: value.id, engine: value.engine };
}

function sourceName(value, fallback) {
    return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
}

function truncate(value, limit) {
    if (value.length <= limit) return value;
    if (limit <= TRUNCATED.length) return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
    return value.slice(0, limit - TRUNCATED.length).replace(/[\uD800-\uDBFF]$/, '') + TRUNCATED;
}

function redactLogMessage(value) {
    // 只处理有界文字，不展开对象或配置；整行 Cookie/Authorization 不拆分后再泄露其后字段。
    return String(value ?? '').slice(0, MAX_MESSAGE_CHARS * 4)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/(["']?(?:authorization|cookie)["']?\s*[:=]\s*)[^\r\n]*/gi, '$1[已隐藏]')
        .replace(/(["']?(?:(?:access|refresh|id)[_-]?token|token|password|(?:client[_-]?)?secret|api[_-]?key)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}]+)/gi, '$1[已隐藏]');
}

function validateLogFilter(filter = {}) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)
        || Object.keys(filter).some(key => !['engine', 'id'].includes(key))) throw new Error('无效的日志筛选条件');
    const engine = filter.engine ?? 'all';
    const id = filter.id ?? '';
    if (!['all', 'tools', 'python'].includes(engine) || typeof id !== 'string') throw new Error('无效的日志类型或插件');
    if (id) {
        const sourceEngine = id.startsWith('tools:') ? 'tools' : id.startsWith('python:') ? 'python' : '';
        if (!sourceIdentity({ engine: sourceEngine, id })) throw new Error('无效的插件日志标识');
        if (engine !== 'all' && sourceEngine !== engine) throw new Error('日志插件与类型筛选不一致');
    }
    return { engine, id };
}

class RunLogStore {
    constructor({ limit = 4000, maxChars = 2 * 1024 * 1024, onLog = () => {}, clock = () => new Date() } = {}) {
        if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxChars) || maxChars < 1024) throw new Error('无效的日志缓存上限');
        this.limit = limit;
        this.maxChars = maxChars;
        this.onLog = onLog;
        this.clock = clock;
        this.sequence = 0;
        this.records = [];
        this.totalChars = 0;
        this.installed = new Map();
        this.names = new Map();
        this.counts = new Map();
    }

    registerSource(source) {
        const identity = sourceIdentity(source);
        if (!identity) return;
        const item = { ...identity, name: sourceName(source.name, identity.id), installed: true };
        this.installed.set(item.id, item);
        this.names.set(item.id, item.name);
    }

    registerSources(sources) {
        this.installed.clear();
        for (const source of sources || []) this.registerSource(source);
        for (const id of this.names.keys()) if (!this.installed.has(id) && !this.counts.has(id)) this.names.delete(id);
    }

    append(value) {
        const identity = sourceIdentity(value);
        if (!identity) return null;
        const name = sourceName(value.name || this.names.get(identity.id), identity.id);
        const parsedTime = Date.parse(value.timestamp || '');
        const timestamp = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : this.clock().toISOString();
        const stream = STREAMS.has(value.stream) ? value.stream : 'system';
        const overhead = identity.id.length + identity.engine.length + name.length + timestamp.length + stream.length;
        const available = Math.min(MAX_MESSAGE_CHARS, this.maxChars - overhead);
        if (available <= 0) return null;
        const message = truncate(redactLogMessage(value.message), available);
        const record = { sequence: ++this.sequence, ...identity, name, timestamp, stream, message };
        this.names.set(identity.id, name);
        this.records.push(record);
        this.counts.set(identity.id, (this.counts.get(identity.id) || 0) + 1);
        this.totalChars += overhead + message.length;
        // 条数和总字符双重限制，避免高频大日志长期占用宿主内存。
        while (this.records.length > this.limit || this.totalChars > this.maxChars) {
            const removed = this.records.shift();
            this.totalChars -= removed.id.length + removed.engine.length + removed.name.length + removed.timestamp.length + removed.stream.length + removed.message.length;
            const count = this.counts.get(removed.id) - 1;
            if (count) this.counts.set(removed.id, count);
            else {
                this.counts.delete(removed.id);
                if (!this.installed.has(removed.id)) this.names.delete(removed.id);
            }
        }
        try { Promise.resolve(this.onLog({ ...record })).catch(() => {}); } catch (_) { /* 日志窗口不可用不能中断插件。 */ }
        return { ...record };
    }

    query(filter) {
        const { engine, id } = validateLogFilter(filter);
        return this.records.filter(record => (engine === 'all' || record.engine === engine) && (!id || record.id === id)).map(record => ({ ...record }));
    }

    sources() {
        const result = new Map(this.installed);
        for (const record of this.records) if (!result.has(record.id)) result.set(record.id, {
            id: record.id, engine: record.engine, name: this.names.get(record.id) || record.name, installed: false
        });
        return [...result.values()].map(source => ({ ...source })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.engine.localeCompare(b.engine) || a.id.localeCompare(b.id));
    }

    snapshot() {
        return { records: this.query(), plugins: this.sources(), limit: this.limit, maxChars: this.maxChars, sequence: this.sequence };
    }
}

module.exports = { RunLogStore, validateLogFilter, redactLogMessage };
