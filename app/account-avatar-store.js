'use strict';
const fs = require('fs/promises');
const { constants } = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 16000000;
const MANIFEST_NAME = 'avatar.json';
const CONTROLLED_NAME = /^([a-f0-9]{64})\.png$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT = () => ({ custom: false, dataUrl: null });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const missing = error => error?.code === 'ENOENT';

function dimensions(bytes) {
    let width, height, format;
    if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13) {
        format = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
        format = 'jpeg';
        let offset = 2;
        while (offset < bytes.length) {
            if (bytes[offset++] !== 255) throw new Error('请选择有效的 PNG 或 JPEG 图片');
            while (offset < bytes.length && bytes[offset] === 255) offset++;
            const marker = bytes[offset++];
            if (marker === 0xd9 || marker === 0xda) break;
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
            if (offset + 2 > bytes.length) break;
            const length = bytes.readUInt16BE(offset);
            if (length < 2 || length > bytes.length - offset) break;
            if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
                if (length < 8) break;
                height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
            }
            offset += length;
        }
    }
    if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new Error('请选择有效的 PNG 或 JPEG 图片');
    if (width * height > MAX_PIXELS) throw new Error('头像像素不能超过 1600 万');
    return { width, height, format };
}

function cleanPng(bytes) {
    const size = dimensions(bytes);
    if (size.format !== 'png' || size.width > 512 || size.height > 512 || bytes.length > MAX_BYTES) throw new Error('头像转换失败，请重新选择图片');
    const chunks = [PNG_SIGNATURE];
    let ended = false, imageData = false;
    // 只保留渲染必需块；不依赖编码器是否缓存原PNG，明确剔除EXIF/XMP/文本/位置元数据。
    for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), end = offset + 12 + length;
        if (length > bytes.length - offset - 12) throw new Error('头像转换失败，请重新选择图片');
        if (['IHDR','PLTE','IDAT','IEND','tRNS'].includes(type)) chunks.push(bytes.subarray(offset, end));
        if (type === 'IDAT') imageData = true;
        if (type === 'IEND') { ended = true; break; }
        offset = end;
    }
    if (!ended || !imageData) throw new Error('头像转换失败，请重新选择图片');
    return Buffer.concat(chunks);
}

async function readBounded(file, maximum) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > maximum) throw new Error('图片文件无效或超过大小限制');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
        const current = await handle.stat();
        if (!current.isFile() || !current.size || current.size > maximum) throw new Error('图片文件无效或超过大小限制');
        const bytes = Buffer.alloc(maximum + 1); let total = 0;
        while (total <= maximum) { const { bytesRead } = await handle.read(bytes, total, maximum + 1 - total, null); if (!bytesRead) break; total += bytesRead; }
        if (total > maximum) throw new Error('图片文件超过大小限制');
        return bytes.subarray(0, total);
    } finally { await handle.close(); }
}

class AccountAvatarStore {
    constructor({ directory, nativeImage, dialog }) {
        if (!directory || !nativeImage?.createFromBuffer || !dialog?.showOpenDialog) throw new Error('本地头像服务未正确初始化');
        this.directory = path.resolve(directory); this.nativeImage = nativeImage; this.dialog = dialog;
        this.manifestPath = path.join(this.directory, MANIFEST_NAME);
        this.tail = Promise.resolve(); this.mutating = false; this.warned = false;
    }
    serial(task) { const pending = this.tail.then(task); this.tail = pending.catch(() => {}); return pending; }
    mutation(task) {
        if (this.mutating) return Promise.reject(new Error('头像操作正在进行，请稍后再试'));
        this.mutating = true;
        return this.serial(task).finally(() => { this.mutating = false; });
    }
    async validDirectory() {
        let stat;
        try { stat = await fs.lstat(this.directory); } catch (error) { if (missing(error)) return false; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_avatar_directory');
        // userData的祖先允许合法迁移链接，只限制头像目录为实际父根的直接普通子目录。
        const parent = await fs.realpath(path.dirname(this.directory)), actual = await fs.realpath(this.directory);
        const comparable = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (comparable(actual) !== comparable(path.join(parent, path.basename(this.directory)))) throw new Error('invalid_avatar_directory_boundary');
        return true;
    }
    async manifest() {
        if (!await this.validDirectory()) return null;
        let bytes;
        try { bytes = await readBounded(this.manifestPath, 2048); } catch (error) { if (missing(error)) return null; throw error; }
        const manifest = JSON.parse(bytes.toString('utf8'));
        if (manifest?.version !== 1 || !CONTROLLED_NAME.test(manifest.filename || '') || manifest.sha256 !== CONTROLLED_NAME.exec(manifest.filename)[1]) throw new Error('invalid_avatar_manifest');
        return manifest;
    }
    async current() {
        const manifest = await this.manifest(); if (!manifest) return null;
        const bytes = await readBounded(path.join(this.directory, manifest.filename), MAX_BYTES);
        if (digest(bytes) !== manifest.sha256) throw new Error('invalid_avatar_digest');
        const size = dimensions(bytes);
        if (size.format !== 'png' || size.width > 512 || size.height > 512 || this.nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error('invalid_avatar_image');
        return { manifest, bytes };
    }
    async read() {
        try { const current = await this.current(); return current ? { custom: true, dataUrl: `data:image/png;base64,${current.bytes.toString('base64')}` } : DEFAULT(); }
        catch (_) {
            const warning = '本地头像无法读取，已显示默认头像；原文件已保留。';
            if (!this.warned) { console.warn(warning); this.warned = true; }
            return { ...DEFAULT(), warning };
        }
    }
    get() { return this.serial(() => this.read()); }
    async ensureDirectory() {
        try { await fs.mkdir(this.directory, { recursive: true }); await this.validDirectory(); }
        catch (_) { throw new Error('本地头像目录不可写，请稍后重试'); }
    }
    async writeExclusive(file, bytes, owned) {
        let handle;
        try { handle = await fs.open(file, 'wx', 0o600); owned.add(file); await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle?.close(); }
    }
    async unlinkOwned(file, owned) {
        if (!owned.has(file)) return;
        try { await fs.unlink(file); owned.delete(file); } catch (_) { }
    }
    async removeUnreferenced(filename) {
        if (!CONTROLLED_NAME.test(filename)) return;
        try { if ((await this.manifest())?.filename === filename) return; }
        catch (_) { return; }
        try { await fs.unlink(path.join(this.directory, filename)); } catch (_) { }
    }
    select(parentWindow) {
        return this.mutation(async () => {
            let choice;
            try { choice = await this.dialog.showOpenDialog(parentWindow, { title: '选择本机头像（仅保存在此电脑）', properties: ['openFile'], filters: [{ name: 'PNG / JPEG 图片', extensions: ['png','jpg','jpeg'] }] }); }
            catch (_) { throw new Error('无法打开图片选择窗口，请稍后重试'); }
            if (choice.canceled || !choice.filePaths?.length) return { ...await this.read(), cancelled: true };
            const file = choice.filePaths[0], extension = path.extname(file).toLowerCase();
            if (!['.png','.jpg','.jpeg'].includes(extension)) throw new Error('请选择 PNG 或 JPEG 图片');
            let bytes;
            try { bytes = await readBounded(file, MAX_BYTES); } catch (_) { throw new Error('头像文件无法读取或超过 5 MB，请重新选择'); }
            const size = dimensions(bytes);
            if ((size.format === 'jpeg' ? !['.jpg','.jpeg'].includes(extension) : extension !== `.${size.format}`)) throw new Error('图片格式与文件类型不符，请重新选择');
            let output;
            try {
                const image = this.nativeImage.createFromBuffer(bytes);
                if (image.isEmpty()) throw new Error('empty');
                const decoded = image.getSize();
                if (!decoded.width || !decoded.height || decoded.width * decoded.height > MAX_PIXELS) throw new Error('size');
                const scale = Math.min(1, 512 / decoded.width, 512 / decoded.height);
                const raster = image.resize({ width: Math.max(1, Math.round(decoded.width * scale)), height: Math.max(1, Math.round(decoded.height * scale)), quality: 'best' });
                output = cleanPng(raster.toPNG({ scaleFactor: 1 }));
            } catch (_) { throw new Error('头像图片无法解码或转换，请选择有效的静态图片'); }
            await this.ensureDirectory();
            let previous;
            try { previous = await this.current(); } catch (_) { previous = null; }
            const hash = digest(output), filename = `${hash}.png`, finalPath = path.join(this.directory, filename);
            const token = crypto.randomUUID(), imageTemp = path.join(this.directory, `.avatar-image-${token}.tmp`), manifestTemp = path.join(this.directory, `.avatar-manifest-${token}.tmp`);
            const owned = new Set(); let committed = false;
            try {
                await this.writeExclusive(imageTemp, output, owned);
                try {
                    // wx先占用最终路径，rename只替换本次拥有的空文件，避免覆盖同名外来文件。
                    await this.writeExclusive(finalPath, Buffer.alloc(0), owned);
                    await fs.rename(imageTemp, finalPath); owned.delete(imageTemp);
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    const existing = await readBounded(finalPath, MAX_BYTES);
                    if (digest(existing) !== hash) throw new Error('existing_avatar_mismatch');
                    await this.unlinkOwned(imageTemp, owned);
                }
                const manifest = Buffer.from(JSON.stringify({ version: 1, filename, sha256: hash }), 'utf8');
                await this.writeExclusive(manifestTemp, manifest, owned);
                await fs.rename(manifestTemp, this.manifestPath); owned.delete(manifestTemp); committed = true;
                this.warned = false;
                if (previous && previous.manifest.filename !== filename) await this.removeUnreferenced(previous.manifest.filename);
                return { custom: true, dataUrl: `data:image/png;base64,${output.toString('base64')}` };
            } catch (_) { throw new Error('本地头像保存失败，原头像已保留，请稍后重试'); }
            finally {
                await this.unlinkOwned(imageTemp, owned); await this.unlinkOwned(manifestTemp, owned);
                if (!committed && owned.has(finalPath)) await this.removeUnreferenced(filename);
            }
        });
    }
    reset() {
        return this.mutation(async () => {
            try { if (!await this.validDirectory()) return DEFAULT(); }
            catch (_) { throw new Error('本地头像目录无效，已保留原文件，请检查后重试'); }
            let previous;
            try { previous = await this.current(); } catch (_) { previous = null; }
            try { await fs.unlink(this.manifestPath); } catch (error) { if (!missing(error)) throw new Error('恢复默认头像失败，原头像已保留，请稍后重试'); }
            if (previous) await this.removeUnreferenced(previous.manifest.filename);
            this.warned = false;
            return DEFAULT();
        });
    }
}

module.exports = { AccountAvatarStore };
