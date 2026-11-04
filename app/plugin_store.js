const fs = require('fs');
const path = require('path');

function normalizePluginIdentity(value) {
    return String(value || '').trim().toLowerCase();
}

function parsePluginVersion(value) {
    const match = String(value || '').trim().match(/^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) return null;
    return {
        core: match[1].split('.').map(part => Number(part)),
        prerelease: match[2] ? match[2].split('.') : []
    };
}

function comparePluginVersions(left, right) {
    const leftVersion = parsePluginVersion(left);
    const rightVersion = parsePluginVersion(right);
    if (!leftVersion || !rightVersion) return null;

    const coreLength = Math.max(leftVersion.core.length, rightVersion.core.length);
    for (let index = 0; index < coreLength; index += 1) {
        const difference = (leftVersion.core[index] || 0) - (rightVersion.core[index] || 0);
        if (difference !== 0) return Math.sign(difference);
    }

    if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) return 0;
    if (leftVersion.prerelease.length === 0) return 1;
    if (rightVersion.prerelease.length === 0) return -1;

    const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
    for (let index = 0; index < prereleaseLength; index += 1) {
        const leftPart = leftVersion.prerelease[index];
        const rightPart = rightVersion.prerelease[index];
        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;
        if (leftPart === rightPart) continue;

        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) return Math.sign(Number(leftPart) - Number(rightPart));
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftPart.localeCompare(rightPart) < 0 ? -1 : 1;
    }
    return 0;
}

function parsePluginDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1e12 ? value * 1000 : value;
    }
    const timestamp = Date.parse(String(value).trim());
    return Number.isFinite(timestamp) ? timestamp : null;
}

function getExplicitPluginDate(config) {
    for (const field of ['updatedAt', 'updateDate', 'publishDate', 'modifiedAt', 'modified']) {
        const timestamp = parsePluginDate(config?.[field]);
        if (timestamp !== null) return timestamp;
    }
    return null;
}

function readPluginEntry(rootDir, entry) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) return null;
    const sourcePath = path.join(rootDir, entry.name);
    const configPath = path.join(sourcePath, 'plugin.json');
    if (!fs.existsSync(configPath)) return null;

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        throw new Error(`插件配置无效，无法安全迁移：${configPath} (${error.message})`);
    }

    const pluginName = String(config.pluginName || entry.name).trim();
    return {
        folderName: entry.name,
        pluginName,
        identity: normalizePluginIdentity(pluginName),
        sourcePath,
        configPath,
        config,
        version: String(config.version || '').trim(),
        explicitUpdateTime: getExplicitPluginDate(config),
        manifestMtime: fs.statSync(configPath).mtimeMs
    };
}

function listPluginEntries(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) return [];
    return fs.readdirSync(rootDir, { withFileTypes: true })
        .map(entry => readPluginEntry(rootDir, entry))
        .filter(Boolean);
}

function uniqueDirectoryPath(rootDir, folderName) {
    const initialPath = path.join(rootDir, folderName);
    if (!fs.existsSync(initialPath)) return initialPath;

    let counter = 1;
    while (true) {
        const candidate = path.join(rootDir, `${folderName}_${counter}`);
        if (!fs.existsSync(candidate)) return candidate;
        counter += 1;
    }
}

function shouldReplacePlugin(sourcePlugin, targetPlugin) {
    const versionComparison = comparePluginVersions(sourcePlugin.version, targetPlugin.version);
    if (versionComparison !== null && versionComparison !== 0) {
        return versionComparison > 0;
    }

    if (sourcePlugin.explicitUpdateTime !== null || targetPlugin.explicitUpdateTime !== null) {
        if (sourcePlugin.explicitUpdateTime === null) return false;
        if (targetPlugin.explicitUpdateTime === null) return true;
        return sourcePlugin.explicitUpdateTime > targetPlugin.explicitUpdateTime;
    }

    // 旧插件没有日期字段时，使用清单文件时间作为兼容回退。
    return sourcePlugin.manifestMtime > targetPlugin.manifestMtime + 1000;
}

function replacePluginDirectory(sourceDir, targetDir) {
    const parentDir = path.dirname(targetDir);
    const folderName = path.basename(targetDir);
    const stagingDir = uniqueDirectoryPath(parentDir, `.plugin-update-${folderName}`);
    const backupDir = uniqueDirectoryPath(parentDir, `.plugin-backup-${folderName}`);
    let backupCreated = false;

    try {
        fs.cpSync(sourceDir, stagingDir, {
            recursive: true,
            force: false,
            errorOnExist: true,
            preserveTimestamps: true
        });
        fs.renameSync(targetDir, backupDir);
        backupCreated = true;
        fs.renameSync(stagingDir, targetDir);
        fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        if (backupCreated && fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
            fs.renameSync(backupDir, targetDir);
        }
        throw error;
    }
}

function copyMissingPlugins(sourceDir, targetDir, { updateExisting = false } = {}) {
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPlugins = new Map(listPluginEntries(targetDir).map(plugin => [plugin.identity, plugin]));
    const result = { copied: [], updated: [], skipped: [] };

    for (const plugin of listPluginEntries(sourceDir)) {
        // 以 pluginName 判重，避免同一插件因文件夹名称不同被远端版本重复补入。
        const existingPlugin = targetPlugins.get(plugin.identity);
        if (existingPlugin) {
            if (updateExisting && shouldReplacePlugin(plugin, existingPlugin)) {
                replacePluginDirectory(plugin.sourcePath, existingPlugin.sourcePath);
                result.updated.push(plugin.pluginName);
                targetPlugins.set(plugin.identity, readPluginEntry(
                    path.dirname(existingPlugin.sourcePath),
                    { name: path.basename(existingPlugin.sourcePath), isDirectory: () => true }
                ));
                continue;
            }
            result.skipped.push(plugin.pluginName);
            continue;
        }

        const targetPath = uniqueDirectoryPath(targetDir, plugin.folderName);
        fs.cpSync(plugin.sourcePath, targetPath, {
            recursive: true,
            force: false,
            errorOnExist: true,
            preserveTimestamps: true
        });
        targetPlugins.set(plugin.identity, plugin);
        result.copied.push(plugin.pluginName);
    }

    return result;
}

function initializePluginStore({ bundledDir, persistentDir, migrationDirs = [], migrationMarkerPath = '' }) {
    fs.mkdirSync(persistentDir, { recursive: true });
    const migrated = [];

    for (const migrationDir of migrationDirs) {
        if (!migrationDir || !fs.existsSync(migrationDir)) continue;
        const result = copyMissingPlugins(migrationDir, persistentDir);
        migrated.push(...result.copied);
        // 复制过程抛错时不会执行到这里，备份会保留以便修复后重试。
        fs.rmSync(migrationDir, { recursive: true, force: true });
    }

    const seeded = copyMissingPlugins(bundledDir, persistentDir, { updateExisting: true });
    if (migrationMarkerPath) {
        fs.mkdirSync(path.dirname(migrationMarkerPath), { recursive: true });
        fs.writeFileSync(migrationMarkerPath, 'completed\n', 'utf8');
    }

    return {
        persistentDir,
        migrated,
        added: seeded.copied,
        updated: seeded.updated,
        preserved: seeded.skipped
    };
}

function syncBundledPluginRuntime(sourceDir, targetDir) {
    if (!sourceDir || !fs.existsSync(sourceDir)) {
        throw new Error(`内置插件运行时不存在: ${sourceDir || '(empty)'}`);
    }
    if (!targetDir) throw new Error('插件运行时目标目录为空');
    fs.mkdirSync(targetDir, { recursive: true });
    // 共享运行时属于主程序版本的一部分，随程序升级覆盖；用户插件目录仍保持本地优先。
    fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
    return targetDir;
}

module.exports = {
    comparePluginVersions,
    copyMissingPlugins,
    getExplicitPluginDate,
    initializePluginStore,
    listPluginEntries,
    normalizePluginIdentity,
    shouldReplacePlugin,
    syncBundledPluginRuntime
};
