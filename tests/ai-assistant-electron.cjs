const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = process.env.AI_ASSISTANT_TEST_ROOT;
if (!root) throw new Error('需要父进程提供临时用户目录');
app.setPath('userData', path.join(root, 'userData'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    let window;
    try {
        window = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: {
            preload: path.join(__dirname, 'ai-assistant-electron-preload.cjs'), nodeIntegration: true, contextIsolation: false
        } });
        window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
        const errors = [];
        window.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text); });
        await window.loadFile(path.join(process.env.AI_ASSISTANT_PLUGIN_DIR || path.resolve(__dirname, '../app/software/sanrenjz.tools-ai'), 'index.html'));
        const result = await window.webContents.executeJavaScript(`(async () => {
            const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); if (!predicate()) throw new Error('等待助手界面超时'); };
            const current = document.getElementById('currentModel');
            await until(() => !!current.__aiSearchPicker);
            await current.__aiSearchPicker.ready;
            const hasSearch = ['currentModel', 'defaultModel', 'qcModel'].every(id => !!document.getElementById(id).__aiSearchPicker);
            document.getElementById('loadOpenAIModelsButton').click();
            await until(() => !!__assistantTest.settings.openaiModels);
            await updateModelSelectors();
            const alphabetic = __assistantTest.settings.openaiModels.map(model => model.label).join(',') === 'Alpha,GPT-6 Luna,Zebra'
                && Array.from(current.querySelectorAll('optgroup')).every(group => {
                    const labels = Array.from(group.children).map(option => option.textContent);
                    return labels.join(',') === [...labels].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })).join(',');
                });
            const wrapper = current.previousElementSibling, trigger = wrapper.querySelector('.ai-model-trigger');
            trigger.click();
            const panel = document.getElementById(trigger.getAttribute('aria-controls')).closest('.ai-model-popup');
            const search = panel.querySelector('input'); search.value = 'openai luna'; search.dispatchEvent(new Event('input'));
            const results = panel.querySelectorAll('[role="option"]');
            const searched = results.length === 1 && results[0].textContent.includes('GPT-6 Luna');
            results[0].click();
            await until(() => panel.hidden);
            const directChosen = current.selectedOptions[0].dataset.provider === 'openai' && __assistantTest.settings.defaultModelProvider === 'openai';
            await updateModelSelectors();
            const stayedDirect = current.selectedOptions[0].dataset.provider === 'openai' && __assistantTest.shared.providerId === 'shared-provider';
            selectModelByPair(current, 'gpt-6-luna', 'shared:shared-provider');
            await current.__aiSearchPicker.refresh();
            const programmaticSynced = wrapper.querySelector('.ai-model-trigger').title.includes('共享供应商');
            const defaultSelect = document.getElementById('defaultModel');
            selectModelByPair(defaultSelect, 'gpt-6-luna', 'openai');
            document.getElementById('openaiKey').value = 'fixture-ui-key'; __assistantTest.failKey = true;
            await saveSettings();
            const keyRetained = document.getElementById('openaiKey').value === 'fixture-ui-key';
            __assistantTest.failKey = false;
            await saveSettings();
            const secureSaved = __assistantTest.savedKey === 'fixture-ui-key' && document.getElementById('openaiKey').value === ''
                && !JSON.stringify(__assistantTest.settings).includes('fixture-ui-key');
            const openaiCustom = !!document.querySelector('#modelProvider option[value="openai"]');
            return { hasSearch, alphabetic, searched, directChosen, stayedDirect, programmaticSynced, keyRetained, secureSaved, openaiCustom };
        })()`);
        assert(Object.values(result).every(Boolean), JSON.stringify(result));
        assert.deepEqual(errors, []);
        console.log('AI 助手 OpenAI 直连、排序和模型搜索验收通过');
    } finally { if (window && !window.isDestroyed()) window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
