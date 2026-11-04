const { ipcRenderer } = require('electron');
const crypto = require('crypto');

// 插件名称，用于存储
const PLUGIN_NAME = 'password-manager';

/**
 * 应用层存储管理类
 */
class AppStorage {
    constructor() {
        this.pluginName = PLUGIN_NAME;
    }

    // 设置数据
    set(key, value) {
        try {
            return ipcRenderer.sendSync('plugin-storage-set', this.pluginName, key, value);
        } catch (error) {
            console.error('存储数据失败:', error);
            return false;
        }
    }

    // 获取数据
    get(key) {
        try {
            return ipcRenderer.sendSync('plugin-storage-get', this.pluginName, key);
        } catch (error) {
            console.error('读取数据失败:', error);
            return null;
        }
    }

    // 删除数据
    remove(key) {
        try {
            return ipcRenderer.sendSync('plugin-storage-remove', this.pluginName, key);
        } catch (error) {
            console.error('删除数据失败:', error);
            return false;
        }
    }

    // 删除账号或整库清理时使用异步 IPC，避免同步磁盘写入阻塞插件窗口。
    setAsync(key, value) {
        return ipcRenderer.invoke('plugin-storage-set-async', this.pluginName, key, value);
    }

    removeAsync(key) {
        return ipcRenderer.invoke('plugin-storage-remove-async', this.pluginName, key);
    }

    // 获取分类数据
    getCategoryData(category) {
        const data = this.get(`category_${category}`);
        return data ? JSON.parse(data) : [];
    }

    // 设置分类数据
    setCategoryData(category, data) {
        return this.set(`category_${category}`, JSON.stringify(data));
    }

    // 设置开屏密码
    setLockPassword(hashedPassword) {
        return this.set('lockPassword', hashedPassword);
    }

    // 获取开屏密码
    getLockPassword() {
        return this.get('lockPassword');
    }

    // 删除开屏密码
    removeLockPassword() {
        return this.remove('lockPassword');
    }

    // 获取自定义分类列表
    getCustomCategories() {
        const data = this.get('customCategories');
        return data ? JSON.parse(data) : [];
    }

    // 设置自定义分类列表
    setCustomCategories(categories) {
        return this.set('customCategories', JSON.stringify(categories));
    }

    async clearAllDataAsync() {
        const allCategories = [...new Set([...defaultCategories, ...this.getCustomCategories()])];
        const keys = [
            ...allCategories.map(category => `category_${category}`),
            'customCategories',
            'defaultCategories',
            'categoryOrder',
            'uiState',
            // 最后删除开屏密码；中途失败时用户仍能重新进入并备份尚未清除的数据。
            'lockPassword'
        ];

        for (const key of keys) {
            const success = await this.removeAsync(key);
            if (!success) {
                throw new Error(`删除存储项失败：${key}`);
            }
        }
        return true;
    }

    // 覆盖导入只清理账号记录，不删除当前开屏密码和派生密钥。
    async clearPasswordData() {
        const allCategories = [...new Set([...defaultCategories, ...this.getCustomCategories()])];
        const keys = [
            ...allCategories.map(category => `category_${category}`),
            'customCategories',
            'categoryOrder',
            'uiState'
        ];
        for (const key of keys) {
            const success = await this.removeAsync(key);
            if (!success) {
                throw new Error(`删除存储项失败：${key}`);
            }
        }
        return true;
    }
}

// 全局存储实例
const appStorage = new AppStorage();

// 应用状态
let currentCategory = '重要';
let currentPassword = null;
let passwords = [];
let categories = [];
let searchMode = false;
let isLocked = true;

// 加密相关运行时状态
// 函数级注释：
// - encryptionKey：运行时解锁后基于用户开屏密码派生的密钥（不持久化存储）
// - 我们使用 PBKDF2(sha256) + 随机盐，密钥长度 32 字节；加密算法采用 AES‑256‑GCM
// - 为兼容历史数据，保留对旧格式（无GCM标签、使用固定密钥aes256）的解密支持
let encryptionKey = null;

/**
 * 基于用户输入的开屏密码派生运行时加密密钥
 * 函数级注释：
 * - 读取或生成随机盐(encryptionSalt)并持久化；使用 PBKDF2(sha256, 100000迭代)
 * - 仅在解锁后派生并保存在内存变量 encryptionKey 中；应用锁定或退出后不保留
 */
function deriveEncryptionKeyFromPassword(plainPassword) {
    try {
        let saltHex = appStorage.get('encryptionSalt');
        if (!saltHex) {
            const salt = crypto.randomBytes(16);
            saltHex = salt.toString('hex');
            appStorage.set('encryptionSalt', saltHex);
        }
        const saltBuf = Buffer.from(saltHex, 'hex');
        encryptionKey = crypto.pbkdf2Sync(plainPassword, saltBuf, 100000, 32, 'sha256');
        return true;
    } catch (e) {
        console.error('派生加密密钥失败:', e);
        encryptionKey = null;
        return false;
    }
}

// 自动锁定相关变量
let autoLockTimer = null;
let autoLockDelay = 2 * 60 * 1000; // 2分钟 = 120秒
let lastActivityTime = Date.now();
let warningTimer = null;
let countdownTimer = null;

// 默认分类
const defaultCategories = [
    '重要', '编程', '服务器', '公司', '金融', 
    '邮箱', 'AI', 'API', '社交', '购物'
];

/**
 * 应用已保存的分类顺序
 */
function applySavedCategoryOrder() {
    try {
        const saved = appStorage.get('categoryOrder');
        if (!saved) return;
        const order = JSON.parse(saved);
        const set = new Set(order);
        const ordered = [];
        order.forEach(name => {
            if (defaultCategories.includes(name) || appStorage.getCustomCategories().includes(name)) {
                ordered.push(name);
            }
        });
        const all = [...defaultCategories, ...appStorage.getCustomCategories()];
        all.forEach(name => {
            if (!set.has(name)) {
                ordered.push(name);
            }
        });
        categories = ordered;
    } catch (e) {
        console.error('应用分类顺序失败:', e);
    }
}

/**
 * 数据库操作类
 */
class PasswordDatabase {
    constructor() {
        this.initDatabase();
    }

    // 初始化数据库
    initDatabase() {
        try {
            // 获取已保存的默认分类列表
            const savedDefaultCategories = appStorage.get('defaultCategories');
            if (savedDefaultCategories) {
                // 如果已保存，从存储中加载
                const parsedCategories = JSON.parse(savedDefaultCategories);
                // 更新全局默认分类列表
                defaultCategories.length = 0;
                defaultCategories.push(...parsedCategories);
            } else {
                // 首次使用，保存默认分类列表
                appStorage.set('defaultCategories', JSON.stringify(defaultCategories));
            }
            
            // 确保所有分类的数据存储存在
            const allCategories = [...defaultCategories, ...appStorage.getCustomCategories()];
            allCategories.forEach(category => {
                const existingData = appStorage.getCategoryData(category);
                if (!existingData || existingData.length === 0) {
                    appStorage.setCategoryData(category, []);
                }
            });
            
            console.log('数据库初始化完成');
        } catch (error) {
            console.error('数据库初始化失败:', error);
        }
    }

    // 加密密码
    encryptPassword(password) {
        try {
            if (!encryptionKey) {
                // 兼容：如果尚未解锁（无运行时密钥），退回旧格式加密，避免保存失败
                const legacyKey = crypto.createHash('sha256').update(PLUGIN_NAME + '_encryption_key').digest();
                const cipher = crypto.createCipher('aes256', legacyKey);
                let encrypted = cipher.update(password, 'utf8', 'hex');
                encrypted += cipher.final('hex');
                return `v1:${encrypted}`; // 显式标注旧格式
            }
            // 使用 AES‑256‑GCM 加密，随机 12 字节 IV
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
            const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
            const authTag = cipher.getAuthTag();
            return `v2:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
        } catch (error) {
            console.error('密码加密失败:', error);
            throw error;
        }
    }

    // 解密密码
    decryptPassword(encryptedPassword) {
        try {
            if (!encryptedPassword) return '';
            // 新格式：v2:iv:tag:cipher
            if (typeof encryptedPassword === 'string' && encryptedPassword.startsWith('v2:')) {
                const parts = encryptedPassword.split(':');
                if (parts.length === 4) {
                    const [, ivHex, tagHex, dataHex] = parts;
                    if (!encryptionKey) {
                        // 未解锁时无法解密新格式，返回掩码文本
                        return '***';
                    }
                    const iv = Buffer.from(ivHex, 'hex');
                    const tag = Buffer.from(tagHex, 'hex');
                    const data = Buffer.from(dataHex, 'hex');
                    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
                    decipher.setAuthTag(tag);
                    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
                    return decrypted;
                }
            }
            // 旧格式：v1:cipher 或 iv:cipher（历史代码拼接的占位iv）
            let legacyCipherHex = encryptedPassword;
            if (typeof encryptedPassword === 'string' && encryptedPassword.includes(':') && !encryptedPassword.startsWith('v2:')) {
                const parts = encryptedPassword.split(':');
                legacyCipherHex = parts[parts.length - 1];
            }
            const legacyKey = crypto.createHash('sha256').update(PLUGIN_NAME + '_encryption_key').digest();
            const decipher = crypto.createDecipher('aes256', legacyKey);
            let decrypted = decipher.update(legacyCipherHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (error) {
            console.error('密码解密失败:', error);
            if (typeof encryptedPassword === 'string') return encryptedPassword;
            return '';
        }
    }

    // 添加密码
    addPassword(password) {
        try {
            const existingData = appStorage.getCategoryData(password.category) || [];
            const plainItem = {
                ...password,
                id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            const storedItem = { ...plainItem };
            
            // 加密密码和API密钥
            storedItem.password = this.encryptPassword(plainItem.password);
            if (plainItem.apiKey) {
                storedItem.apiKey = this.encryptPassword(plainItem.apiKey);
            }
            
            existingData.push(storedItem);
            appStorage.setCategoryData(plainItem.category, existingData);
            return plainItem;
        } catch (error) {
            console.error('添加密码失败:', error);
            throw error;
        }
    }

    // 更新密码
    updatePassword(passwordId, updatedPassword, originalCategory) {
        try {
            const sourceCategory = originalCategory || updatedPassword.category;
            let sourceData = appStorage.getCategoryData(sourceCategory) || [];
            let index = sourceData.findIndex(p => p.id === passwordId);

            // 如果在原分类中未找到，尝试在目标分类中查找（兼容历史数据）
            if (index === -1 && sourceCategory !== updatedPassword.category) {
                sourceData = appStorage.getCategoryData(updatedPassword.category) || [];
                index = sourceData.findIndex(p => p.id === passwordId);
            }

            if (index === -1) {
                throw new Error('密码项不存在');
            }

            const existingItem = sourceData[index];
            const now = new Date().toISOString();

            // 构造更新后的条目（保持创建时间等元数据）
            const updatedItem = {
                ...existingItem,
                ...updatedPassword,
                id: passwordId,
                updatedAt: now,
                category: updatedPassword.category
            };

            // 始终使用最新明文重新加密密码和 API 密钥
            if (typeof updatedPassword.password === 'string') {
                updatedItem.password = this.encryptPassword(updatedPassword.password);
            }
            if (typeof updatedPassword.apiKey !== 'undefined') {
                updatedItem.apiKey = updatedPassword.apiKey
                    ? this.encryptPassword(updatedPassword.apiKey)
                    : '';
            }

            // 如果分类未改变，在原分类内更新
            if (sourceCategory === updatedItem.category) {
                sourceData[index] = updatedItem;
                appStorage.setCategoryData(sourceCategory, sourceData);
                return {
                    ...updatedItem,
                    password: updatedPassword.password,
                    apiKey: updatedPassword.apiKey || ''
                };
            }

            // 分类已改变：从原分类删除并追加到新分类
            sourceData.splice(index, 1);
            appStorage.setCategoryData(sourceCategory, sourceData);

            const targetData = appStorage.getCategoryData(updatedItem.category) || [];
            targetData.push(updatedItem);
            appStorage.setCategoryData(updatedItem.category, targetData);

            return {
                ...updatedItem,
                password: updatedPassword.password,
                apiKey: updatedPassword.apiKey || ''
            };
        } catch (error) {
            console.error('更新密码失败:', error);
            throw error;
        }
    }

    // 移动密码到其他分类（不修改内容，仅变更分类）
    movePasswordToCategory(passwordId, fromCategory, toCategory) {
        try {
            if (!passwordId || !fromCategory || !toCategory || fromCategory === toCategory) return null;

            const sourceData = appStorage.getCategoryData(fromCategory) || [];
            const index = sourceData.findIndex(p => p.id === passwordId);
            if (index === -1) {
                throw new Error('密码项不存在');
            }

            const [item] = sourceData.splice(index, 1);
            item.category = toCategory;

            appStorage.setCategoryData(fromCategory, sourceData);

            const targetData = appStorage.getCategoryData(toCategory) || [];
            targetData.push(item);
            appStorage.setCategoryData(toCategory, targetData);

            return item;
        } catch (error) {
            console.error('移动密码分类失败:', error);
            throw error;
        }
    }

    // 删除密码
    async deletePassword(passwordId, category) {
        try {
            const existingData = appStorage.getCategoryData(category) || [];
            const filteredData = existingData.filter(p => p.id !== passwordId);
            if (filteredData.length === existingData.length) {
                throw new Error('密码项不存在或已被删除');
            }
            const success = await appStorage.setAsync(`category_${category}`, JSON.stringify(filteredData));
            if (!success) {
                throw new Error('保存删除结果失败');
            }
            return true;
        } catch (error) {
            console.error('删除密码失败:', error);
            throw error;
        }
    }

    // 获取分类密码列表
    getPasswordsByCategory(category) {
        try {
            const data = appStorage.getCategoryData(category) || [];
            // 解密密码
            return data.map(password => ({
                ...password,
                password: this.decryptPassword(password.password),
                apiKey: password.apiKey ? this.decryptPassword(password.apiKey) : ''
            }));
        } catch (error) {
            console.error('获取密码列表失败:', error);
            return [];
        }
    }

    // 获取所有密码（用于搜索）
    getAllPasswords() {
        const allPasswords = [];
        const allCategories = [...defaultCategories, ...appStorage.getCustomCategories()];
        allCategories.forEach(category => {
            const categoryPasswords = this.getPasswordsByCategory(category);
            allPasswords.push(...categoryPasswords);
        });
        return allPasswords;
    }
}

// 全局数据库实例
const db = new PasswordDatabase();

/**
 * 保存界面状态
 */
function saveUIState() {
    try {
        const searchInput = document.getElementById('searchInput');
        const searchKeyword = searchInput ? searchInput.value : '';
        const state = {
            searchMode,
            searchKeyword,
            currentCategory,
            currentPasswordId: currentPassword ? currentPassword.id : null,
            currentSearchCategory
        };
        appStorage.set('uiState', JSON.stringify(state));
    } catch (error) {
        console.error('保存界面状态失败:', error);
    }
}

/**
 * 恢复界面状态
 */
function restoreUIState() {
    try {
        const raw = appStorage.get('uiState');
        if (!raw) {
            document.getElementById('currentCategory').textContent = currentCategory;
            loadPasswords(currentCategory);
            renderCategories();
            return;
        }
        const state = JSON.parse(raw);
        const searchInput = document.getElementById('searchInput');
        if (searchInput && typeof state.searchKeyword === 'string') {
            searchInput.value = state.searchKeyword;
        }

        if (state.currentCategory && categories.includes(state.currentCategory)) {
            currentCategory = state.currentCategory;
        }

        if (state.searchMode && state.searchKeyword) {
            searchPasswords(state.searchKeyword);
            if (state.currentSearchCategory && categories.includes(state.currentSearchCategory)) {
                currentSearchCategory = state.currentSearchCategory;
                updateSearchHeader();
                renderCategories();
                renderCurrentPasswords();
            }
        } else {
            searchMode = false;
            currentSearchCategory = null;
            document.getElementById('currentCategory').textContent = currentCategory;
            loadPasswords(currentCategory);
            renderCategories();
        }

        if (state.currentPasswordId) {
            const list = getVisiblePasswords();
            const found = list.find(item => item.id === state.currentPasswordId);
            if (found) {
                showPasswordDetail(found);
            }
        }
    } catch (error) {
        console.error('恢复界面状态失败:', error);
        document.getElementById('currentCategory').textContent = currentCategory;
        loadPasswords(currentCategory);
        renderCategories();
    }
}

/**
 * 初始化应用
 */
function initApp() {
    runInternalTests();
    // 检查是否设置了开屏密码
    checkLockPassword();
    
    // 初始化事件监听
    initEventListeners();
    initPasswordGenerator();
    console.log('密码管理器初始化完成');
}

/**
 * 检查开屏密码
 */
function checkLockPassword() {
    const savedPassword = appStorage.getLockPassword();
    
    if (savedPassword) {
        // 已设置密码，显示解锁界面
        isLocked = true;
        showLockScreen();
    } else {
        // 未设置密码，显示设置密码界面
        isLocked = true;
        showSetupScreen();
    }
}

/**
 * 显示锁屏界面
 */
function showLockScreen() {
    document.getElementById('lockScreen').style.display = 'flex';
    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'none';
    
    // 停止自动锁定功能
    removeActivityListeners();
    stopAutoLockTimer();
    
    // 清空输入框
    document.getElementById('unlockPassword').value = '';
    document.getElementById('unlockPassword').focus();
}

/**
 * 显示设置密码界面
 */
function showSetupScreen() {
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('setupScreen').style.display = 'flex';
    document.getElementById('mainApp').style.display = 'none';
    
    // 停止自动锁定功能
    removeActivityListeners();
    stopAutoLockTimer();
    
    // 清空输入框
    document.getElementById('setupPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('setupPassword').focus();
}

/**
 * 显示主应用界面
 */
function showMainApp() {
    document.getElementById('lockScreen').style.display = 'none';
    document.getElementById('setupScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';
    
    loadData();
    
    if (!categories.includes(currentCategory) && categories.length > 0) {
        currentCategory = categories[0];
        document.getElementById('currentCategory').textContent = currentCategory;
    }

    try {
        restoreUIState();
    } catch (e) {
        console.error('恢复界面状态失败:', e);
    }
    
    // 启动自动锁定功能
    initActivityListeners();
    startAutoLockTimer();
    
    // 自动聚焦到搜索输入框
    setTimeout(() => {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.focus();
        }
    }, 100);
}

/**
 * 解锁应用
 */
function unlockApp() {
    const inputPassword = document.getElementById('unlockPassword').value;
    const savedPassword = appStorage.getLockPassword();
    
    if (!inputPassword) {
        showError('unlockError', '请输入密码');
        return;
    }
    
    const hashedInput = crypto.createHash('sha256').update(inputPassword).digest('hex');
    
    if (hashedInput === savedPassword) {
        // 派生运行时加密密钥（函数级注释：基于开屏密码与随机盐使用PBKDF2派生32字节密钥）
        deriveEncryptionKeyFromPassword(inputPassword);
        isLocked = false;
        hideError('unlockError');
        showMainApp();
        // 解锁后尝试迁移旧格式数据到新格式（AES‑GCM），提升安全性
        migrateLegacyEncryption();
    } else {
        showError('unlockError', '密码错误，请重试');
        document.getElementById('unlockPassword').value = '';
        document.getElementById('unlockPassword').focus();
    }
}

/**
 * 设置开屏密码
 */
function setupLockPassword() {
    const password = document.getElementById('setupPassword').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    
    if (!password || !confirmPassword) {
        showError('setupError', '请填写完整的密码信息');
        return;
    }
    
    if (password !== confirmPassword) {
        showError('setupError', '两次输入的密码不一致');
        return;
    }
    
    if (password.length < 4) {
        showError('setupError', '密码长度至少4位');
        return;
    }
    
    try {
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        appStorage.setLockPassword(hashedPassword);
        // 设置/生成盐并派生运行时密钥
        deriveEncryptionKeyFromPassword(password);
        
        hideError('setupError');
        isLocked = false;
        showMainApp();
        showNotification('密码设置成功');
    } catch (error) {
        showError('setupError', '密码设置失败，请重试');
    }
}

/**
 * 迁移旧格式加密的数据到新格式
 * 函数级注释：
 * - 遍历所有分类下的密码记录；对旧格式(v1 或 iv:cipher)条目进行解密并使用 v2 重新加密
 * - 仅在成功解锁且已派生 encryptionKey 后执行；失败不会影响原有数据
 */
function migrateLegacyEncryption() {
    try {
        if (!encryptionKey) return;
        const allCategories = [...defaultCategories, ...appStorage.getCustomCategories()];
        allCategories.forEach(category => {
            const existingData = appStorage.getCategoryData(category) || [];
            let changed = false;
            const updated = existingData.map(item => {
                const pwd = item.password;
                if (typeof pwd === 'string' && !pwd.startsWith('v2:')) {
                    // 旧格式：尝试解密并重加密
                    try {
                        const plain = db.decryptPassword(pwd);
                        const reenc = db.encryptPassword(plain);
                        if (reenc.startsWith('v2:')) {
                            changed = true;
                            return { ...item, password: reenc };
                        }
                    } catch (e) {
                        // 解密失败则保持原样
                        return item;
                    }
                }
                return item;
            });
            if (changed) {
                appStorage.setCategoryData(category, updated);
            }
        });
    } catch (e) {
        console.warn('迁移旧格式加密数据失败:', e);
    }
}

/**
 * 锁定应用
 */
function lockApp() {
    try {
        saveUIState();
    } catch (e) {
        console.error('保存界面状态失败:', e);
    }
    isLocked = true;
    clearPasswordDetail();
    stopAutoLockTimer();
    showLockScreen();
}

/**
 * 开始自动锁定计时器
 */
function startAutoLockTimer() {
    // 清除现有计时器
    stopAutoLockTimer();
    
    lastActivityTime = Date.now();
    
    // 设置警告计时器（1分30秒后警告，即锁定前30秒）
    warningTimer = setTimeout(() => {
        if (!isLocked) {
            showAutoLockWarning();
        }
    }, autoLockDelay - 30000); // 提前30秒警告
    
    // 设置自动锁定计时器
    autoLockTimer = setTimeout(() => {
        if (!isLocked) {
            console.log('自动锁定：2分钟无活动');
            lockApp();
            showNotification('应用已自动锁定（2分钟无活动）', 'info');
        }
    }, autoLockDelay);
}

/**
 * 停止自动锁定计时器
 */
function stopAutoLockTimer() {
    if (autoLockTimer) {
        clearTimeout(autoLockTimer);
        autoLockTimer = null;
    }
    if (warningTimer) {
        clearTimeout(warningTimer);
        warningTimer = null;
    }
    stopCountdownTimer();
}

/**
 * 显示自动锁定警告
 */
function showAutoLockWarning() {
    if (isLocked) return;
    
    let countdown = 30;
    showNotification(`应用将在 ${countdown} 秒后自动锁定`, 'warning');
    
    countdownTimer = setInterval(() => {
        countdown--;
        if (countdown > 0 && !isLocked) {
            showNotification(`应用将在 ${countdown} 秒后自动锁定`, 'warning');
        } else {
            stopCountdownTimer();
        }
    }, 1000);
}

/**
 * 停止倒计时计时器
 */
function stopCountdownTimer() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
}

/**
 * 重置自动锁定计时器
 */
function resetAutoLockTimer() {
    if (!isLocked) {
        lastActivityTime = Date.now();
        stopCountdownTimer(); // 停止倒计时
        startAutoLockTimer();
    }
}

/**
 * 监听用户活动
 */
function initActivityListeners() {
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    events.forEach(event => {
        document.addEventListener(event, resetAutoLockTimer, true);
    });
}

/**
 * 移除用户活动监听
 */
function removeActivityListeners() {
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    events.forEach(event => {
        document.removeEventListener(event, resetAutoLockTimer, true);
    });
}

/**
 * 重置开屏密码
 */
let isResettingVault = false;

async function resetLockPassword() {
    if (isResettingVault) return;
    if (confirm('⚠️ 确定要重置开屏密码吗？\n\n警告：这将删除所有保存的密码数据，且无法恢复！\n\n请确认您已经备份了重要的密码信息。')) {
        const button = document.getElementById('resetLockPasswordButton');
        isResettingVault = true;
        if (button) {
            button.disabled = true;
            button.textContent = '正在清空…';
        }
        try {
            await appStorage.clearAllDataAsync();
            encryptionKey = null;
            passwords = [];
            categories = [];
            currentPassword = null;
            searchResults = [];
            currentSearchCategory = null;
            searchMode = false;
            showSetupScreen();
            showNotification('密码已重置，所有数据已清空，请设置新密码');
        } catch (error) {
            console.error('重置密码失败:', error);
            showNotification(`重置失败：${error.message}`, 'error');
        } finally {
            isResettingVault = false;
            if (button) {
                button.disabled = false;
                button.textContent = '重置密码';
            }
        }
    }
}

/**
 * 加载数据
 */
function loadData() {
    loadCategories();
    loadPasswords(currentCategory);
    updateCategorySelect();
}

/**
 * 加载分类列表
 */
function loadCategories() {
    // 重新获取最新的默认分类列表
    const savedDefaultCategories = appStorage.get('defaultCategories');
    if (savedDefaultCategories) {
        const parsedCategories = JSON.parse(savedDefaultCategories);
        defaultCategories.length = 0;
        defaultCategories.push(...parsedCategories);
    }
    
    const customCategories = appStorage.getCustomCategories();
    categories = [...defaultCategories, ...customCategories];
    applySavedCategoryOrder();
    renderCategories();
}

/**
 * 保存当前分类顺序
 */
function saveCategoryOrder() {
    try {
        appStorage.set('categoryOrder', JSON.stringify(categories));
    } catch (e) {
        console.error('保存分类顺序失败:', e);
    }
}

/**
 * 重新排序分类（拖拽排序）
 */
function reorderCategories(sourceCategory, targetCategory) {
    const sourceIndex = categories.indexOf(sourceCategory);
    const targetIndex = categories.indexOf(targetCategory);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const updated = categories.slice();
    updated.splice(sourceIndex, 1);
    const newTargetIndex = updated.indexOf(targetCategory);
    updated.splice(newTargetIndex, 0, sourceCategory);
    categories = updated;
    saveCategoryOrder();
    renderCategories();
    renderCurrentPasswords();
}

/**
 * 添加新分类
 */
function addCategory() {
    // 显示添加分类的模态框
    const modal = document.getElementById('addCategoryModal');
    const input = document.getElementById('newCategoryName');
    if (modal && input) {
        input.value = '';
        hideError('categoryNameError');
        modal.classList.add('show');
        setTimeout(() => input.focus(), 100);
    }
}

/**
 * 确认添加分类
 */
function confirmAddCategory() {
    const input = document.getElementById('newCategoryName');
    if (!input) return;
    
    const categoryName = input.value;
    if (!categoryName) {
        showError('categoryNameError', '分类名称不能为空');
        return;
    }
    
    const trimmedName = categoryName.trim();
    if (!trimmedName) {
        showError('categoryNameError', '分类名称不能为空');
        return;
    }
    
    // 检查是否已存在
    if (categories.includes(trimmedName)) {
        showError('categoryNameError', '分类已存在');
        return;
    }
    
    // 检查长度限制
    if (trimmedName.length > 10) {
        showError('categoryNameError', '分类名称不能超过10个字符');
        return;
    }
    
    try {
        const customCategories = appStorage.getCustomCategories();
        customCategories.push(trimmedName);
        appStorage.setCustomCategories(customCategories);
        
        // 重新加载分类
        loadCategories();
        updateCategorySelect();

        // 如果分类管理界面是打开的，刷新它
        const categoryModal = document.getElementById('categoryModal');
        if (categoryModal && categoryModal.classList.contains('show')) {
            renderCategoryManager();
        }
        
        // 关闭添加分类模态框
        closeModal('addCategoryModal');
        
        showNotification(`分类"${trimmedName}"添加成功`);
    } catch (error) {
        console.error('添加分类失败:', error);
        showError('categoryNameError', '添加分类失败');
    }
}

/**
 * 删除分类
 */
function deleteCategory(categoryName) {
    // 确保至少保留一个分类
    if (categories.length <= 1) {
        showNotification('至少需要保留一个分类', 'error');
        return;
    }
    
    // 检查该分类是否有密码
    const categoryPasswords = db.getPasswordsByCategory(categoryName);
    if (categoryPasswords.length > 0) {
        const confirmed = confirm(`分类"${categoryName}"中有${categoryPasswords.length}个密码记录。\n\n删除分类将同时删除其中的所有密码，此操作无法撤销。\n\n确定要删除吗？`);
        if (!confirmed) return;
    } else {
        const confirmed = confirm(`确定要删除分类"${categoryName}"吗？`);
        if (!confirmed) return;
    }
    
    try {
        // 删除分类数据
        appStorage.remove(`category_${categoryName}`);
        
        // 从对应的分类列表中移除
        if (defaultCategories.includes(categoryName)) {
            // 如果是默认分类，从默认分类列表中移除
            const index = defaultCategories.indexOf(categoryName);
            if (index > -1) {
                defaultCategories.splice(index, 1);
                // 保存更新后的默认分类列表
                appStorage.set('defaultCategories', JSON.stringify(defaultCategories));
            }
        } else {
            // 如果是自定义分类，从自定义分类列表中移除
            const customCategories = appStorage.getCustomCategories();
            const updatedCategories = customCategories.filter(cat => cat !== categoryName);
            appStorage.setCustomCategories(updatedCategories);
        }

        categories = [...defaultCategories, ...appStorage.getCustomCategories()];
        saveCategoryOrder();

        // 删除分类会连带删除其中账号，必须同步清理搜索派生数据。
        if (searchMode) {
            searchResults = searchResults.filter(item => item.category !== categoryName);
            if (currentSearchCategory === categoryName) {
                currentSearchCategory = null;
            }
            updateSearchHeader();
            renderCurrentPasswords();
        }
        
        // 如果当前分类被删除，切换到第一个可用分类
        if (currentCategory === categoryName) {
            const remainingCategories = [...defaultCategories, ...appStorage.getCustomCategories()];
            if (remainingCategories.length > 0) {
                switchCategory(remainingCategories[0]);
            }
        }
        
        // 重新加载分类
        loadCategories();
        updateCategorySelect();
        
        // 如果分类管理界面是打开的，刷新它
        const categoryModal = document.getElementById('categoryModal');
        if (categoryModal && categoryModal.classList.contains('show')) {
            renderCategoryManager();
        }
        
        showNotification(`分类"${categoryName}"删除成功`);
    } catch (error) {
        console.error('删除分类失败:', error);
        showNotification('删除分类失败', 'error');
    }
}

/**
 * 显示分类管理弹窗
 */
function showCategoryManager() {
    const modal = document.getElementById('categoryModal');
    if (modal) {
        renderCategoryManager();
        modal.classList.add('show');
    }
}

/**
 * 渲染分类管理界面
 */
function renderCategoryManager() {
    const categoryManagerList = document.getElementById('categoryManagerList');
    if (!categoryManagerList) return;
    
    categoryManagerList.innerHTML = '';
    
    categories.forEach(category => {
        const isDefault = defaultCategories.includes(category);
        const categoryPasswords = db.getPasswordsByCategory(category);
        const count = categoryPasswords.length;
        const canDelete = categories.length > 1; // 至少保留一个分类
        
        const categoryElement = document.createElement('div');
        categoryElement.className = 'category-manager-item';
        const info = document.createElement('div');
        info.className = 'category-manager-info';
        const name = document.createElement('div');
        name.className = 'category-manager-name';
        name.append(document.createTextNode(category));
        const badge = document.createElement('span');
        badge.className = isDefault ? 'default-badge' : 'custom-badge';
        badge.textContent = isDefault ? '默认' : '自定义';
        name.appendChild(badge);
        const countElement = document.createElement('div');
        countElement.className = 'category-manager-count';
        countElement.textContent = `${count} 个密码`;
        info.append(name, countElement);

        const actions = document.createElement('div');
        actions.className = 'category-manager-actions';
        const deleteButton = document.createElement('button');
        deleteButton.className = 'btn btn-danger btn-small';
        deleteButton.textContent = '删除';
        deleteButton.disabled = !canDelete;
        if (canDelete) {
            deleteButton.addEventListener('click', () => deleteCategory(category));
        } else {
            deleteButton.title = '至少需要保留一个分类';
        }
        actions.appendChild(deleteButton);
        categoryElement.append(info, actions);
        
        categoryManagerList.appendChild(categoryElement);
    });
}

/**
 * 渲染分类列表
 */
function renderCategories() {
    const categoryList = document.getElementById('categoryList');
    categoryList.innerHTML = '';
    
    let categoriesToRender = categories.slice();
    if (searchMode) {
        const matched = new Set(searchResults.map(item => item.category));
        categoriesToRender = categoriesToRender.filter(category => matched.has(category));
    }

    categoriesToRender.forEach(category => {
        const categoryPasswords = searchMode
            ? searchResults.filter(item => item.category === category)
            : db.getPasswordsByCategory(category);
        const count = categoryPasswords.length;

        if (searchMode && count === 0) {
            return;
        }
        
        const isActive = searchMode
            ? currentSearchCategory === category
            : currentCategory === category;

        const categoryElement = document.createElement('div');
        categoryElement.className = `category-item ${isActive ? 'active' : ''}`;
        const categoryName = document.createElement('span');
        categoryName.className = 'category-name';
        categoryName.textContent = category;
        const categoryCount = document.createElement('span');
        categoryCount.className = 'category-count';
        categoryCount.textContent = String(count);
        categoryElement.append(categoryName, categoryCount);
        categoryElement.setAttribute('draggable', 'true');
        categoryElement.dataset.category = category;
        
        categoryElement.addEventListener('dragstart', (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', category);
            categoryElement.classList.add('dragging');
        });
        
        categoryElement.addEventListener('dragend', () => {
            categoryElement.classList.remove('dragging');
            categoryElement.classList.remove('drag-over');
        });
        
        categoryElement.addEventListener('dragover', (e) => {
            e.preventDefault();
            categoryElement.classList.add('drag-over');
        });
        
        categoryElement.addEventListener('dragleave', () => {
            categoryElement.classList.remove('drag-over');
        });
        
        categoryElement.addEventListener('drop', (e) => {
            e.preventDefault();
            categoryElement.classList.remove('drag-over');

            // 优先处理密码条目拖拽到分类以变更分类
            const passwordId = e.dataTransfer.getData('text/password-id');
            const fromCategory = e.dataTransfer.getData('text/password-category');
            if (passwordId && fromCategory && fromCategory !== category) {
                try {
                    db.movePasswordToCategory(passwordId, fromCategory, category);

                    // 更新当前视图和计数
                    if (!searchMode) {
                        if (currentCategory === fromCategory || currentCategory === category) {
                            loadPasswords(currentCategory);
                        }
                        renderCategories();
                    } else {
                        // 搜索模式下只需刷新可见列表和分类计数
                        const item = searchResults.find(p => p.id === passwordId);
                        if (item) {
                            item.category = category;
                        }
                        updateSearchHeader();
                        renderCategories();
                        renderCurrentPasswords();
                    }

                    // 如果正在查看该条目，保持详情中的分类一致
                    if (currentPassword && currentPassword.id === passwordId) {
                        currentPassword.category = category;
                        const categorySelect = document.getElementById('passwordCategory');
                        if (categorySelect) {
                            categorySelect.value = category;
                        }
                    }

                    showNotification(`已移动到分类 "${category}"`);
                } catch (error) {
                    showNotification('移动分类失败：' + error.message, 'error');
                }

                return;
            }

            // 默认行为：分类之间拖拽以重新排序
            const sourceCategory = e.dataTransfer.getData('text/plain');
            if (sourceCategory && sourceCategory !== category) {
                reorderCategories(sourceCategory, category);
            }
        });
        
        categoryElement.addEventListener('click', () => {
            if (searchMode) {
                if (currentSearchCategory === category) {
                    currentSearchCategory = null;
                } else {
                    currentSearchCategory = category;
                }
                updateSearchHeader();
                renderCategories();
                renderCurrentPasswords();
            } else {
                switchCategory(category);
            }
        });
        
        categoryList.appendChild(categoryElement);
    });
}

/**
 * 更新分类选择下拉框
 */
function updateCategorySelect() {
    const categorySelect = document.getElementById('passwordCategory');
    if (categorySelect) {
        categorySelect.innerHTML = '';
        
        categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category;
            option.textContent = category;
            categorySelect.appendChild(option);
        });
    }
}

/**
 * 切换分类
 */
function switchCategory(category) {
    currentCategory = category;
    document.getElementById('currentCategory').textContent = category;
    loadPasswords(category);
    renderCategories();
    
    // 清空当前选中的密码
    clearPasswordDetail();
    
    // 退出搜索模式
    if (searchMode) {
        exitSearchMode();
    }
}

/**
 * 加载密码列表
 */
function loadPasswords(category) {
    passwords = db.getPasswordsByCategory(category);
    renderPasswords(passwords);
}

/**
 * 渲染密码列表
 */
function renderPasswords(passwordList) {
    const passwordListElement = document.getElementById('passwordList');
    passwordListElement.innerHTML = '';
    
    if (passwordList.length === 0) {
        passwordListElement.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🔐</div>
                <div class="empty-text">暂无密码记录</div>
                <div class="empty-hint">点击右上角"添加"按钮开始使用</div>
            </div>
        `;
        return;
    }
    
    passwordList.forEach(password => {
        const passwordElement = document.createElement('div');
        passwordElement.className = `password-item ${currentPassword && currentPassword.id === password.id ? 'active' : ''}`;
        const icon = document.createElement('div');
        icon.className = 'password-icon';
        icon.textContent = String(password.title || '?').charAt(0).toUpperCase();
        const info = document.createElement('div');
        info.className = 'password-info';
        const title = document.createElement('div');
        title.className = 'password-title';
        title.textContent = password.title || '未命名条目';
        const username = document.createElement('div');
        username.className = 'password-username';
        username.textContent = password.username || '无用户名';
        info.append(title, username);
        const actions = document.createElement('div');
        actions.className = 'password-actions';
        const copyButton = document.createElement('button');
        copyButton.className = 'action-btn copy-btn';
        copyButton.type = 'button';
        copyButton.title = '复制密码';
        copyButton.textContent = '📋';
        copyButton.addEventListener('click', () => copyPasswordToClipboard(password.password));
        actions.appendChild(copyButton);
        passwordElement.append(icon, info, actions);

        // 启用密码条目拖拽到左侧分类以变更分类
        passwordElement.setAttribute('draggable', 'true');
        passwordElement.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/password-id', password.id);
            e.dataTransfer.setData('text/password-category', password.category || currentCategory);
            e.dataTransfer.effectAllowed = 'move';
            passwordElement.classList.add('dragging');
        });

        passwordElement.addEventListener('dragend', () => {
            passwordElement.classList.remove('dragging');
        });
        
        passwordElement.addEventListener('click', (e) => {
            if (!e.target.closest('.password-actions')) {
                showPasswordDetail(password);
            }
        });
        
        passwordListElement.appendChild(passwordElement);
    });
}

/**
 * 添加新密码
 */
function addNewPassword() {
    currentPassword = null;
    document.getElementById('detailTitle').textContent = '添加新密码';
    
    // 清空表单
    document.getElementById('passwordTitle').value = '';
    document.getElementById('passwordUsername').value = '';
    document.getElementById('passwordValue').value = '';
    const apiKeyInput = document.getElementById('apiKeyValue');
    if (apiKeyInput) {
        apiKeyInput.value = '';
        updateApiKeyStrengthIndicator();
    }
    document.getElementById('passwordUrl').value = '';
    document.getElementById('passwordNotes').value = '';
    document.getElementById('passwordCategory').value = currentCategory;
    
    // 显示表单，隐藏空状态
    document.getElementById('emptyDetail').classList.add('hidden');
    document.getElementById('passwordForm').classList.remove('hidden');
    
    // 生成一个随机密码
    generatePassword();
    useGeneratedPassword();
}

/**
 * 显示密码详情
 */
function showPasswordDetail(password) {
    currentPassword = password;
    
    document.getElementById('detailTitle').textContent = password.title;
    document.getElementById('passwordTitle').value = password.title;
    document.getElementById('passwordUsername').value = password.username || '';
    document.getElementById('passwordValue').value = password.password;
    const apiKeyInput = document.getElementById('apiKeyValue');
    if (apiKeyInput) {
        apiKeyInput.value = password.apiKey || '';
    }
    document.getElementById('passwordUrl').value = password.url || '';
    document.getElementById('passwordNotes').value = password.notes || '';
    document.getElementById('passwordCategory').value = password.category;
    
    document.getElementById('emptyDetail').classList.add('hidden');
    document.getElementById('passwordForm').classList.remove('hidden');
    
    renderCurrentPasswords();
}

/**
 * 清空密码详情
 */
function clearPasswordDetail() {
    currentPassword = null;
    
    document.getElementById('emptyDetail').classList.remove('hidden');
    document.getElementById('passwordForm').classList.add('hidden');
    const apiKeyInput = document.getElementById('apiKeyValue');
    if (apiKeyInput) {
        apiKeyInput.value = '';
    }
    
    renderCurrentPasswords();
}

/**
 * 保存当前密码
 */
function saveCurrentPassword() {
    const formData = {
        title: document.getElementById('passwordTitle').value,
        username: document.getElementById('passwordUsername').value,
        password: document.getElementById('passwordValue').value,
        apiKey: document.getElementById('apiKeyValue') ? document.getElementById('apiKeyValue').value : '',
        url: document.getElementById('passwordUrl').value,
        notes: document.getElementById('passwordNotes').value,
        category: document.getElementById('passwordCategory').value
    };

    formData.title = formData.title.trim();
    if (!formData.title && !currentPassword) {
        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        formData.title = `未命名条目 ${timestamp}`;
        const titleInput = document.getElementById('passwordTitle');
        if (titleInput) {
            titleInput.value = formData.title;
        }
    }
    
    if (!formData.title) {
        showNotification('标题不能为空', 'error');
        return;
    }
    
    if (!formData.password) {
        showNotification('密码不能为空', 'error');
        return;
    }
    
    try {
        let savedItem;
        if (currentPassword) {
            // 更新现有密码（支持修改分类）
            savedItem = db.updatePassword(currentPassword.id, formData, currentPassword.category);
            currentPassword = savedItem;
        } else {
            // 添加新密码
            savedItem = db.addPassword(formData);
            currentPassword = savedItem;
        }
        
        // 修复：在搜索模式下修改内容导致的刷新问题
        if (searchMode) {
            // 更新搜索结果列表中的对应项
            const searchIndex = searchResults.findIndex(p => p.id === savedItem.id);
            if (searchIndex !== -1) {
                searchResults[searchIndex] = savedItem;
            }
            
            // 如果当前选中的分类正好是该条目的分类，更新后台数据
            if (currentCategory === savedItem.category) {
                passwords = db.getPasswordsByCategory(currentCategory);
            }
            
            // 刷新视图
            updateSearchHeader();
            renderCategories();
            renderCurrentPasswords();
        } else {
            // 如果分类已更改，需要切换到新分类
            if (formData.category !== currentCategory) {
                switchCategory(formData.category);
            } else {
                // 否则只需刷新当前分类的密码列表
                loadPasswords(currentCategory);
                renderCategories(); // 更新分类计数
            }
        }
        
        showNotification('保存成功');
    } catch (error) {
        showNotification('保存失败：' + error.message, 'error');
    }
}

/**
 * 删除当前密码
 */
let isDeletingPassword = false;

async function deleteCurrentPassword() {
    if (!currentPassword || isDeletingPassword) return;
    
    if (confirm('确定要删除这个密码记录吗？')) {
        const deleteButton = document.getElementById('deletePasswordButton');
        isDeletingPassword = true;
        if (deleteButton) {
            deleteButton.disabled = true;
            deleteButton.textContent = '删除中…';
        }
        try {
            // 先记录待删除条目的关键信息，clearPasswordDetail 会把 currentPassword 置空
            const deletedId = currentPassword.id;
            const deletedCategory = currentPassword.category;

            await db.deletePassword(deletedId, deletedCategory);

            if (searchMode) {
                // 修复：搜索模式下必须同步移除已删除条目，否则会出现“幽灵条目”，
                // 分类计数不更新、再次删除无效果，界面表现为卡住
                searchResults = searchResults.filter(p => p.id !== deletedId);

                // 若当前筛选的分类已无搜索结果，重置为显示全部搜索结果
                if (currentSearchCategory && !searchResults.some(p => p.category === currentSearchCategory)) {
                    currentSearchCategory = null;
                }

                // 同步后台分类数据，避免退出搜索模式后显示已删除的条目
                if (deletedCategory === currentCategory) {
                    passwords = db.getPasswordsByCategory(currentCategory);
                }

                updateSearchHeader();
                renderCategories();
                renderCurrentPasswords();
            } else {
                loadPasswords(currentCategory);
                renderCategories(); // 更新分类计数
            }
            clearPasswordDetail();
            showNotification('密码已删除');
        } catch (error) {
            showNotification('删除失败：' + error.message, 'error');
        } finally {
            isDeletingPassword = false;
            if (deleteButton) {
                deleteButton.disabled = false;
                deleteButton.textContent = '删除';
            }
        }
    }
}

// 搜索相关变量
let searchResults = [];
let currentSearchCategory = null;

/**
 * 获取当前应显示的密码列表
 */
function getVisiblePasswords() {
    if (!searchMode) {
        return passwords;
    }
    if (!currentSearchCategory) {
        return searchResults;
    }
    return searchResults.filter(item => item.category === currentSearchCategory);
}

/**
 * 更新搜索结果头部显示
 */
function updateSearchHeader() {
    const header = document.getElementById('currentCategory');
    if (!header) return;
    if (!searchMode) {
        header.textContent = currentCategory;
        return;
    }
    const baseText = `搜索结果 (${searchResults.length})`;
    if (currentSearchCategory) {
        const categoryCount = searchResults.filter(item => item.category === currentSearchCategory).length;
        header.textContent = `${baseText} - ${currentSearchCategory} (${categoryCount})`;
    } else {
        header.textContent = baseText;
    }
}

/**
 * 渲染当前可见密码列表
 */
function renderCurrentPasswords() {
    renderPasswords(getVisiblePasswords());
}

/**
 * 搜索密码（支持多关键词模糊匹配）
 */
function searchPasswords(keyword) {
    const trimmed = keyword.trim();
    if (!trimmed) {
        exitSearchMode();
        return;
    }
    const keywords = trimmed.split(/\s+/).filter(Boolean).map(k => k.toLowerCase());
    if (keywords.length === 0) {
        exitSearchMode();
        return;
    }

    searchMode = true;
    currentSearchCategory = null;
    const allPasswords = db.getAllPasswords();
    searchResults = allPasswords.filter(password => {
        const title = password.title || '';
        const username = password.username || '';
        const notes = password.notes || '';
        const url = password.url || '';
        const combined = `${title} ${username} ${notes} ${url}`.toLowerCase();
        return keywords.every(kw => combined.includes(kw));
    });

    updateSearchHeader();
    renderCategories();
    renderCurrentPasswords();
}

/**
 * 退出搜索模式
 */
function exitSearchMode() {
    searchMode = false;
    searchResults = [];
    currentSearchCategory = null;
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = '';
    }
    document.getElementById('currentCategory').textContent = currentCategory;
    renderCategories();
    renderPasswords(passwords);
}

/**
 * 初始化事件监听
 */
function initEventListeners() {
    // 搜索功能
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchPasswords(e.target.value);
        });
    }
    
    // 解锁密码回车键
    const unlockPasswordInput = document.getElementById('unlockPassword');
    if (unlockPasswordInput) {
        unlockPasswordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                unlockApp();
            }
        });
    }
    
    // 设置密码回车键
    const setupPasswordInput = document.getElementById('setupPassword');
    const confirmPasswordInput = document.getElementById('confirmPassword');
    if (setupPasswordInput) {
        setupPasswordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('confirmPassword').focus();
            }
        });
    }
    if (confirmPasswordInput) {
        confirmPasswordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                setupLockPassword();
            }
        });
    }
    
    // 添加分类输入框回车键
    const newCategoryNameInput = document.getElementById('newCategoryName');
    if (newCategoryNameInput) {
        newCategoryNameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                confirmAddCategory();
            }
        });
    }
    
    // ESC键关闭模态框
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAllModals();
        }
    });
    
    // 同步密码长度滑块和输入框
    const lengthSlider = document.getElementById('passwordLength');
    const lengthInput = document.getElementById('lengthInput');
    
    if (lengthSlider && lengthInput) {
        lengthSlider.addEventListener('input', () => {
            lengthInput.value = lengthSlider.value;
            generatePassword();
        });
        
        lengthInput.addEventListener('input', () => {
            lengthSlider.value = lengthInput.value;
            generatePassword();
        });
    }
    
    // 监听选项变化
    ['includeNumbers', 'includeLowercase', 'includeUppercase', 'includeSymbols'].forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('change', generatePassword);
        }
    });
    
    // 自动保存功能 - 监听表单输入变化
    const formInputs = ['passwordTitle', 'passwordUsername', 'passwordValue', 'apiKeyValue', 'passwordUrl', 'passwordNotes', 'passwordCategory'];
    formInputs.forEach(inputId => {
        const element = document.getElementById(inputId);
        if (element) {
            // 使用防抖函数避免频繁保存
            let saveTimeout;
            const autoSave = () => {
                clearTimeout(saveTimeout);
                saveTimeout = setTimeout(() => {
                    // 只有在编辑现有密码时才自动保存
                    if (currentPassword && element.value.trim()) {
                        saveCurrentPassword();
                    }
                }, 1000); // 1秒后自动保存
            };
            
            element.addEventListener('input', autoSave);
            element.addEventListener('change', autoSave);
        }
    });

    const apiKeyInput = document.getElementById('apiKeyValue');
    if (apiKeyInput) {
        apiKeyInput.addEventListener('input', updateApiKeyStrengthIndicator);
        apiKeyInput.addEventListener('change', updateApiKeyStrengthIndicator);
    }
}

/**
 * 密码生成器相关功能
 */
function initPasswordGenerator() {
    generatePassword();
}

/**
 * 生成密码
 */
function generatePassword() {
    const lengthElement = document.getElementById('passwordLength');
    const length = lengthElement ? parseInt(lengthElement.value) : 12;
    
    const includeNumbers = document.getElementById('includeNumbers')?.checked ?? true;
    const includeLowercase = document.getElementById('includeLowercase')?.checked ?? true;
    const includeUppercase = document.getElementById('includeUppercase')?.checked ?? true;
    const includeSymbols = document.getElementById('includeSymbols')?.checked ?? true;
    
    let charset = '';
    if (includeNumbers) charset += '0123456789';
    if (includeLowercase) charset += 'abcdefghijklmnopqrstuvwxyz';
    if (includeUppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (includeSymbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
    
    if (!charset) {
        const generatedElement = document.getElementById('generatedPassword');
        if (generatedElement) {
            generatedElement.textContent = '请至少选择一种字符类型';
        }
        return;
    }
    
    let password = '';
    for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    
    const generatedElement = document.getElementById('generatedPassword');
    if (generatedElement) {
        generatedElement.textContent = password;
    }
}

/**
 * 将生成的密码应用到密码输入框
 */
function useGeneratedPassword() {
    const generatedElement = document.getElementById('generatedPassword');
    const passwordInput = document.getElementById('passwordValue');
    
    if (generatedElement && passwordInput) {
        passwordInput.value = generatedElement.textContent;
    }
}

/**
 * 显示密码生成器
 */
function showPasswordGenerator() {
    generatePassword();
    const modal = document.getElementById('generatorModal');
    if (modal) {
        modal.classList.add('show');
    }
}

/**
 * 复制到剪贴板（支持敏感文本自动清除）
 * 函数级注释：
 * - 当 isSensitive=true 时，在 30 秒后自动清空剪贴板，降低误泄露风险
 * - 仅在本地应用内生效，不向任何外部服务发送数据
 */
async function copyToClipboard(text, { isSensitive = false } = {}) {
    try {
        await navigator.clipboard.writeText(text);
        showNotification('已复制到剪贴板');
        if (isSensitive) {
            setTimeout(() => {
                try { navigator.clipboard.writeText(''); } catch (_) { /* 忽略 */ }
            }, 30000);
        }
    } catch (error) {
        console.error('复制失败:', error);
        showNotification('复制失败', 'error');
    }
}

// 专用于密码的复制，开启敏感文本自动清除
// 函数级注释：密码属于敏感内容，复制后将于 30 秒后自动清空剪贴板
function copyPasswordToClipboard(text) {
    return copyToClipboard(text, { isSensitive: true });
}

/**
 * 运行内部单元测试
 */
function runInternalTests() {
    try {
        console.group('密码管理器插件自检');
        const weak = evaluateApiKeyStrength('123456');
        const medium = evaluateApiKeyStrength('12345678Abcdefgh');
        const strong = evaluateApiKeyStrength('A1b2C3d4E5f6G7h8I9j0!@#$');
        console.assert(weak.level === 'weak', '弱密钥评估结果异常');
        console.assert(medium.level === 'medium' || medium.level === 'strong', '中等密钥评估结果异常');
        console.assert(strong.level === 'strong', '强密钥评估结果异常');
        console.groupEnd();
    } catch (e) {
        console.error('内部单元测试执行失败:', e);
    }
}

/**
 * 评估API密钥强度
 */
function evaluateApiKeyStrength(value) {
    if (!value) return { level: 'none', label: '' };
    let score = 0;
    if (value.length >= 16) score++;
    if (value.length >= 24) score++;
    if (/[0-9]/.test(value)) score++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
    if (/[^0-9a-zA-Z]/.test(value)) score++;

    if (score <= 2) return { level: 'weak', label: '强度：较弱，建议使用更长更复杂的密钥' };
    if (score === 3 || score === 4) return { level: 'medium', label: '强度：中等，建议适当增加长度或复杂度' };
    return { level: 'strong', label: '强度：强，安全性较高' };
}

/**
 * 更新API密钥强度提示
 */
function updateApiKeyStrengthIndicator() {
    const input = document.getElementById('apiKeyValue');
    const hint = document.getElementById('apiKeyStrength');
    if (!input || !hint) return;

    const result = evaluateApiKeyStrength(input.value.trim());
    hint.textContent = result.label;
    hint.classList.remove('weak', 'medium', 'strong');
    if (result.level && result.level !== 'none') {
        hint.classList.add(result.level);
    }
}

/**
 * 复制输入框的值到剪贴板
 */
async function copyInputValue(inputId) {
    const input = document.getElementById(inputId);
    if (!input) {
        showNotification('输入框不存在', 'error');
        return;
    }
    
    const value = input.value.trim();
    if (!value) {
        showNotification('内容为空，无法复制', 'warning');
        return;
    }
    
    try {
        await navigator.clipboard.writeText(value);
        
        // 根据输入框类型显示不同的提示消息
        let message = '已复制到剪贴板';
        switch (inputId) {
            case 'passwordTitle':
                message = '标题已复制到剪贴板';
                break;
            case 'passwordUsername':
                message = '用户名已复制到剪贴板';
                break;
            case 'passwordValue':
                message = '密码已复制到剪贴板';
                // 密码属于敏感内容，30 秒后自动清空剪贴板
                setTimeout(() => {
                    try { navigator.clipboard.writeText(''); } catch (_) { /* 忽略 */ }
                }, 30000);
                break;
            case 'apiKeyValue':
                message = 'API 密钥已复制到剪贴板';
                setTimeout(() => {
                    try { navigator.clipboard.writeText(''); } catch (_) { /* 忽略 */ }
                }, 30000);
                break;
            case 'passwordUrl':
                message = '网址已复制到剪贴板';
                break;
        }
        
        showNotification(message);
    } catch (error) {
        console.error('复制失败:', error);
        showNotification('复制失败', 'error');
    }
}

/**
 * 打开网址
 */
function openUrl(inputId) {
    const input = document.getElementById(inputId);
    if (!input) {
        showNotification('输入框不存在', 'error');
        return;
    }
    
    let url = input.value.trim();
    if (!url) {
        showNotification('网址为空', 'warning');
        return;
    }
    
    // 如果网址不包含协议，自动添加https://
    if (!url.match(/^https?:\/\//)) {
        url = 'https://' + url;
    }
    
    try {
        // 直接使用Electron的shell模块在系统默认浏览器中打开网址
        const { shell } = require('electron');
        shell.openExternal(url);
        showNotification('正在系统默认浏览器中打开网址...');
    } catch (error) {
        console.error('打开网址失败:', error);
        // 降级到window.open作为备选方案
        try {
            window.open(url, '_blank');
            showNotification('正在打开网址...');
        } catch (fallbackError) {
            console.error('备选方案也失败:', fallbackError);
            showNotification('打开网址失败，请检查网址是否正确', 'error');
        }
    }
}

/**
 * 切换密码可见性
 */
function togglePasswordVisibility() {
    const passwordInput = document.getElementById('passwordValue');
    if (passwordInput) {
        if (passwordInput.type === 'password') {
            passwordInput.type = 'text';
        } else {
            passwordInput.type = 'password';
        }
    }
}

/**
 * 切换API密钥可见性
 */
function toggleApiKeyVisibility() {
    const apiKeyInput = document.getElementById('apiKeyValue');
    if (apiKeyInput) {
        apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    }
}

/**
 * 显示通知
 */
function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

/**
 * 显示错误信息
 */
function showError(elementId, message) {
    const errorElement = document.getElementById(elementId);
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.classList.remove('hidden');
    }
}

/**
 * 隐藏错误信息
 */
function hideError(elementId) {
    const errorElement = document.getElementById(elementId);
    if (errorElement) {
        errorElement.classList.add('hidden');
    }
}

/**
 * 关闭模态框
 */
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

/**
 * 关闭所有模态框
 */
function closeAllModals() {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        modal.classList.remove('show');
    });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initApp);

// 导出给HTML使用的函数
window.unlockApp = unlockApp;
window.setupLockPassword = setupLockPassword;
window.lockApp = lockApp;
window.resetLockPassword = resetLockPassword;
window.addNewPassword = addNewPassword;
window.saveCurrentPassword = saveCurrentPassword;
window.deleteCurrentPassword = deleteCurrentPassword;
window.generatePassword = generatePassword;
window.useGeneratedPassword = useGeneratedPassword;
window.copyToClipboard = copyToClipboard;
window.copyInputValue = copyInputValue;
window.togglePasswordVisibility = togglePasswordVisibility;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.closeModal = closeModal;
window.showPasswordGenerator = showPasswordGenerator;
window.addCategory = addCategory;
window.confirmAddCategory = confirmAddCategory;
window.deleteCategory = deleteCategory;
window.showCategoryManager = showCategoryManager;
window.renderCategoryManager = renderCategoryManager;
window.showImportExport = showImportExport;
window.exportData = exportData;
window.importData = importData;

/**
 * 显示导入导出界面
 */
function showImportExport() {
    const modal = document.getElementById('importExportModal');
    if (modal) {
        modal.classList.add('show');
        
        // 初始化文件选择监听
        const fileInput = document.getElementById('importFile');
        if (fileInput) {
            // 移除之前的监听器（如果存在）
            fileInput.removeEventListener('change', handleFileSelect);
            // 添加新的监听器
            fileInput.addEventListener('change', handleFileSelect);
        }
    }
}

/**
 * 处理文件选择
 */
function handleFileSelect(event) {
    const file = event.target.files[0];
    const fileName = document.getElementById('fileName');
    const importBtn = document.getElementById('importBtn');
    
    if (file) {
        fileName.textContent = file.name;
        importBtn.disabled = false;
    } else {
        fileName.textContent = '未选择文件';
        importBtn.disabled = true;
    }
}

/**
 * 导出数据
 */
function exportData(format) {
    try {
        const includePasswords = document.getElementById('includePasswords').checked;
        const exportAllCategories = document.getElementById('exportAllCategories').checked;
        
        // 获取要导出的数据
        const exportData = getExportData(includePasswords, exportAllCategories);
        
        if (exportData.length === 0) {
            showNotification('没有数据可导出', 'warning');
            return;
        }
        
        let content, filename, mimeType;
        
        switch (format) {
            case 'db':
                content = exportAsDatabase(exportData);
                filename = `passwords_backup_${getCurrentDateTime()}.json`;
                mimeType = 'application/json';
                break;
            case 'csv':
                content = exportAsCSV(exportData);
                filename = `passwords_backup_${getCurrentDateTime()}.csv`;
                mimeType = 'text/csv';
                break;
            case 'txt':
                content = exportAsTXT(exportData);
                filename = `passwords_backup_${getCurrentDateTime()}.txt`;
                mimeType = 'text/plain';
                break;
            default:
                showNotification('不支持的导出格式', 'error');
                return;
        }
        
        downloadFile(content, filename, mimeType);
        showNotification(`导出成功：${filename}`);
        
    } catch (error) {
        console.error('导出失败:', error);
        showNotification('导出失败', 'error');
    }
}

/**
 * 获取导出数据
 */
function getExportData(includePasswords, exportAllCategories) {
    const exportData = [];
    const categoriesToExport = exportAllCategories ? categories : [currentCategory];
    
    categoriesToExport.forEach(category => {
        const categoryPasswords = db.getPasswordsByCategory(category);
        categoryPasswords.forEach(password => {
            const exportItem = {
                id: password.id,
                title: password.title,
                username: password.username || '',
                url: password.url || '',
                category: password.category,
                notes: password.notes || '',
                createdAt: password.createdAt,
                updatedAt: password.updatedAt
            };
            
            if (includePasswords) {
                exportItem.password = password.password;
                exportItem.apiKey = password.apiKey || '';
            } else {
                exportItem.password = '[已隐藏]';
                exportItem.apiKey = password.apiKey ? '[已隐藏]' : '';
            }
            
            exportData.push(exportItem);
        });
    });
    
    return exportData;
}

/**
 * 导出为数据库格式
 */
function exportAsDatabase(data) {
    const exportObject = {
        version: '1.5.0',
        exportTime: new Date().toISOString(),
        categories: categories,
        defaultCategories: defaultCategories,
        customCategories: appStorage.getCustomCategories(),
        data: data
    };
    
    return JSON.stringify(exportObject, null, 2);
}

/**
 * 导出为CSV格式
 */
function exportAsCSV(data) {
    const headers = ['标题', '用户名', '密码', 'API密钥', '网址', '分类', '备注', '创建时间', '更新时间'];
    let csv = headers.join(',') + '\n';
    
    data.forEach(item => {
        const row = [
            escapeCSV(item.title),
            escapeCSV(item.username),
            escapeCSV(item.password),
            escapeCSV(item.apiKey || ''),
            escapeCSV(item.url),
            escapeCSV(item.category),
            escapeCSV(item.notes),
            escapeCSV(item.createdAt),
            escapeCSV(item.updatedAt)
        ];
        csv += row.join(',') + '\n';
    });
    
    return csv;
}

/**
 * 导出为TXT格式
 */
function exportAsTXT(data) {
    let txt = `密码管理器数据导出\n`;
    txt += `导出时间: ${new Date().toLocaleString()}\n`;
    txt += `总计: ${data.length} 条记录\n`;
    txt += `${'='.repeat(50)}\n\n`;
    
    data.forEach((item, index) => {
        txt += `记录 ${index + 1}:\n`;
        txt += `标题: ${item.title}\n`;
        txt += `用户名: ${item.username}\n`;
        txt += `密码: ${item.password}\n`;
        if (typeof item.apiKey !== 'undefined' && item.apiKey !== '') {
            txt += `API密钥: ${item.apiKey}\n`;
        }
        txt += `网址: ${item.url}\n`;
        txt += `分类: ${item.category}\n`;
        txt += `备注: ${item.notes}\n`;
        txt += `创建时间: ${item.createdAt}\n`;
        txt += `更新时间: ${item.updatedAt}\n`;
        txt += `${'-'.repeat(30)}\n\n`;
    });
    
    return txt;
}

/**
 * 导入数据
 */
function importData() {
    const fileInput = document.getElementById('importFile');
    const file = fileInput.files[0];
    
    if (!file) {
        showNotification('请先选择文件', 'error');
        return;
    }
    
    const mergeImport = document.getElementById('mergeImport').checked;
    const skipDuplicates = document.getElementById('skipDuplicates').checked;
    
    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const content = e.target.result;
            const extension = file.name.split('.').pop().toLowerCase();
            
            // 检测是否为SQLite数据库文件
            if (extension === 'db' && isSQLiteFile(content)) {
                showNotification('检测到SQLite数据库文件，当前不支持此格式。请使用JSON、CSV或TXT格式的导出文件。', 'error');
                return;
            }
            
            let importResult;
            switch (extension) {
                case 'json':
                    importResult = await importFromDatabase(content, mergeImport, skipDuplicates);
                    break;
                case 'db':
                    // 对于.db扩展名，尝试作为JSON解析（兼容本应用导出的格式）
                    try {
                        importResult = await importFromDatabase(content, mergeImport, skipDuplicates);
                    } catch (error) {
                        if (error.message.includes('Unexpected token')) {
                            showNotification('该.db文件似乎是SQLite数据库格式，当前不支持。请导出为JSON、CSV或TXT格式后重试。', 'error');
                            return;
                        }
                        throw error;
                    }
                    break;
                case 'csv':
                    importResult = await importFromCSV(content, mergeImport, skipDuplicates);
                    break;
                case 'txt':
                    importResult = await importFromTXT(content, mergeImport, skipDuplicates);
                    break;
                default:
                    showNotification('不支持的文件格式。支持格式：JSON、CSV、TXT', 'error');
                    return;
            }
            
            if (importResult && importResult.success) {
                // 刷新界面
                loadData();
                closeModal('importExportModal');
                showNotification(`导入成功：${importResult.imported} 条记录，跳过：${importResult.skipped} 条`);
            } else {
                const errorMsg = importResult ? importResult.error : '未知错误';
                showNotification(`导入失败：${errorMsg}`, 'error');
            }
            
        } catch (error) {
            console.error('导入失败:', error);
            
            // 更详细的错误信息
            let errorMessage = '导入失败：';
            if (error.message.includes('Unexpected token')) {
                errorMessage += '文件格式不正确，可能是SQLite数据库文件或损坏的JSON文件';
            } else if (error.message.includes('JSON')) {
                errorMessage += 'JSON格式错误';
            } else {
                errorMessage += error.message || '文件格式错误';
            }
            
            showNotification(errorMessage, 'error');
        }
    };
    
    // 对于可能的二进制文件，先读取少量字节检测
    if (file.name.toLowerCase().endsWith('.db')) {
        const headerReader = new FileReader();
        headerReader.onload = function(e) {
            const header = e.target.result;
            if (isSQLiteFile(header)) {
                showNotification('检测到SQLite数据库文件，当前不支持此格式。请使用本应用导出的JSON格式文件。', 'error');
                return;
            }
            // 如果不是SQLite，继续按文本读取
            reader.readAsText(file);
        };
        headerReader.readAsText(file.slice(0, 100)); // 读取前100字节检测
    } else {
        reader.readAsText(file);
    }
}

/**
 * 从数据库格式导入
 */
async function importFromDatabase(content, mergeImport, skipDuplicates) {
    try {
        const importData = JSON.parse(content);
        
        if (!mergeImport) {
            await resetPasswordDataForImport();
        }
        
        let imported = 0;
        let skipped = 0;
        
        // 导入分类
        if (importData.customCategories) {
            importData.customCategories.forEach(category => {
                ensureCategoryExists(category);
            });
        }
        
        // 导入密码数据
        if (importData.data) {
            importData.data.forEach(item => {
                if (skipDuplicates && isDuplicate(item)) {
                    skipped++;
                    return;
                }
                
                try {
                    // 确保分类存在
                    item.category = ensureCategoryExists(item.category);
                    
                    db.addPassword(item);
                    imported++;
                } catch (error) {
                    skipped++;
                }
            });
        }
        
        return { success: true, imported, skipped };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 从CSV格式导入
 */
async function importFromCSV(content, mergeImport, skipDuplicates) {
    try {
        if (!mergeImport) {
            await resetPasswordDataForImport();
        }
        
        const lines = content.split('\n');
        let imported = 0;
        let skipped = 0;
        
        // 跳过标题行
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const fields = parseCSVLine(line);
            if (fields.length < 8) continue;
            
            // 兼容旧版 8 列 CSV；当前版本第 4 列为 API 密钥，共 9 列。
            const hasApiKeyColumn = fields.length >= 9;
            const item = {
                title: fields[0],
                username: fields[1],
                password: fields[2],
                apiKey: hasApiKeyColumn ? fields[3] : '',
                url: fields[hasApiKeyColumn ? 4 : 3],
                category: fields[hasApiKeyColumn ? 5 : 4],
                notes: fields[hasApiKeyColumn ? 6 : 5],
                createdAt: fields[hasApiKeyColumn ? 7 : 6] || new Date().toISOString(),
                updatedAt: fields[hasApiKeyColumn ? 8 : 7] || new Date().toISOString()
            };
            
            if (skipDuplicates && isDuplicate(item)) {
                skipped++;
                continue;
            }
            
            try {
                // 确保分类存在
                item.category = ensureCategoryExists(item.category);
                
                db.addPassword(item);
                imported++;
            } catch (error) {
                skipped++;
            }
        }
        
        return { success: true, imported, skipped };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 从TXT格式导入
 */
/**
 * 从TXT文件导入密码数据
 * 支持两种格式：
 * 1. 原有格式：记录分隔的格式
 * 2. 新格式：【标题】用户名：xxx 密码：xxx 说明：xxx
 */
async function importFromTXT(content, mergeImport, skipDuplicates) {
    try {
        if (!mergeImport) {
            await resetPasswordDataForImport();
        }
        
        let imported = 0;
        let skipped = 0;
        
        // 检测格式并解析
        if (content.includes('【') && content.includes('】')) {
            // 新格式解析
            const result = parseNewTxtFormat(content, skipDuplicates);
            imported = result.imported;
            skipped = result.skipped;
        } else {
            // 原有格式解析（假设是我们导出的格式）
            const records = content.split('记录').slice(1); // 跳过文件头
            
            records.forEach(record => {
                const lines = record.split('\n');
                const item = {};
                
                lines.forEach(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('标题: ')) item.title = trimmed.substring(3);
                    else if (trimmed.startsWith('用户名: ')) item.username = trimmed.substring(4);
                    else if (trimmed.startsWith('密码: ')) item.password = trimmed.substring(3);
                    else if (trimmed.startsWith('API密钥: ')) item.apiKey = trimmed.substring(7);
                    else if (trimmed.startsWith('网址: ')) item.url = trimmed.substring(3);
                    else if (trimmed.startsWith('分类: ')) item.category = trimmed.substring(3);
                    else if (trimmed.startsWith('备注: ')) item.notes = trimmed.substring(3);
                    else if (trimmed.startsWith('创建时间: ')) item.createdAt = trimmed.substring(5);
                    else if (trimmed.startsWith('更新时间: ')) item.updatedAt = trimmed.substring(5);
                });
                
                if (!item.title || !item.password) return;
                
                if (skipDuplicates && isDuplicate(item)) {
                    skipped++;
                    return;
                }
                
                try {
                    // 确保分类存在
                    item.category = ensureCategoryExists(item.category);
                    
                    db.addPassword(item);
                    imported++;
                } catch (error) {
                    skipped++;
                }
            });
        }
        
        return { success: true, imported, skipped };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 覆盖导入只替换账号记录，保留当前开屏密码和加密盐。
 */
async function resetPasswordDataForImport() {
    await appStorage.clearPasswordData();
    db.initDatabase();
    categories = [...defaultCategories, ...appStorage.getCustomCategories()];
}

/**
 * 确保导入记录的分类存在，并同步当前内存分类列表，避免重复添加或导入后不可见。
 */
function ensureCategoryExists(category) {
    const normalized = String(category || '').trim() || defaultCategories[0] || '重要';
    if (!defaultCategories.includes(normalized)) {
        const customCategories = appStorage.getCustomCategories();
        if (!customCategories.includes(normalized)) {
            customCategories.push(normalized);
            appStorage.setCustomCategories(customCategories);
        }
    }
    if (!categories.includes(normalized)) {
        categories.push(normalized);
    }
    return normalized;
}

/**
 * 解析新的TXT格式
 * 格式：【标题】用户名：xxx 密码：xxx 说明：xxx
 */
function parseNewTxtFormat(content, skipDuplicates) {
    let imported = 0;
    let skipped = 0;
    
    try {
        // 按【】分割获取每个记录
        const titleRegex = /【([^】]+)】/g;
        const matches = [...content.matchAll(titleRegex)];
        
        for (let i = 0; i < matches.length; i++) {
            const match = matches[i];
            const title = match[1].trim();
            const startIndex = match.index + match[0].length;
            const endIndex = i < matches.length - 1 ? matches[i + 1].index : content.length;
            
            // 获取该记录的内容
            const recordContent = content.substring(startIndex, endIndex).trim();
            
            const item = {
                title: title,
                username: '',
                password: '',
                url: '',
                category: '重要', // 默认分类
                notes: '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            // 解析记录内容
            const lines = recordContent.split('\n');
            let currentNotes = [];
            
            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;
                
                // 匹配用户名
                if (trimmed.startsWith('用户名：') || trimmed.startsWith('用户名:')) {
                    item.username = trimmed.replace(/^用户名[：:]/, '').trim();
                }
                // 匹配密码
                else if (trimmed.startsWith('密码：') || trimmed.startsWith('密码:')) {
                    item.password = trimmed.replace(/^密码[：:]/, '').trim();
                }
                // 匹配说明
                else if (trimmed.startsWith('说明：') || trimmed.startsWith('说明:')) {
                    const noteContent = trimmed.replace(/^说明[：:]/, '').trim();
                    if (noteContent) {
                        currentNotes.push(noteContent);
                    }
                }
                // 匹配网址
                else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                    if (!item.url) {
                        item.url = trimmed;
                    } else {
                        currentNotes.push(trimmed);
                    }
                }
                // 其他内容作为备注
                else if (trimmed && !trimmed.includes('：') && !trimmed.includes(':')) {
                    currentNotes.push(trimmed);
                }
                // 包含冒号的其他字段也作为备注
                else if (trimmed.includes('：') || trimmed.includes(':')) {
                    currentNotes.push(trimmed);
                }
            });
            
            // 合并备注
            item.notes = currentNotes.join('\n');
            
            // 验证必要字段
            if (!item.title || !item.password) {
                skipped++;
                continue;
            }
            
            // 检查重复
            if (skipDuplicates && isDuplicate(item)) {
                skipped++;
                continue;
            }
            
            try {
                // 确保分类存在
                item.category = ensureCategoryExists(item.category);
                
                db.addPassword(item);
                imported++;
            } catch (error) {
                console.error('添加密码失败:', error);
                skipped++;
            }
        }
        
    } catch (error) {
        console.error('解析新格式TXT失败:', error);
    }
    
    return { imported, skipped };
}

/**
 * 检查是否重复
 */
function isDuplicate(item) {
    const allPasswords = db.getAllPasswords();
    return allPasswords.some(existing => 
        existing.title === item.title && 
        existing.username === item.username &&
        existing.category === item.category
    );
}

/**
 * 辅助函数
 */
function getCurrentDateTime() {
    return new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
}

function escapeCSV(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    
    result.push(current);
    return result;
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 检测是否为SQLite数据库文件
 */
function isSQLiteFile(content) {
    // SQLite文件的魔数标识
    const sqliteSignatures = [
        'SQLite format 3',
        'SQLite',
        '** This file contains an SQLite'
    ];
    
    return sqliteSignatures.some(signature => 
        content.substring(0, 100).includes(signature)
    );
}
