const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const temporary = process.env.AI_CATALOG_TEST_ROOT;
if (!temporary) throw new Error('请通过 ai-provider-catalog-electron.test.cjs 启动');
app.setPath('userData', path.join(temporary, 'userData'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
    let window;
    try {
        window = new BrowserWindow({ show: false, width: 700, height: 800,
            webPreferences: { nodeIntegration: false, contextIsolation: true } });
        const errors = [];
        window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
        await window.loadFile(path.join(temporary, 'catalog.html'));
        const results = await window.webContents.executeJavaScript(`(async () => {
            const clone = value => JSON.parse(JSON.stringify(value));
            const saved = [], notices = [], calls = [];
            let config = { schemaVersion: 1, providers: [{ id: 'saved', name: 'Saved', baseUrl: 'https://fixture.example/v1', models: [
                { id: 'kept', label: '自定义名称', capabilities: ['text', 'vision'], api: 'responses' },
                { id: 'retired', label: 'Old', capabilities: ['text'] }
            ] }], selections: { text: { providerId: 'saved', modelId: 'kept' } } };
            let resolveCatalog, rejectCatalog;
            const api = {
                getConfig: async () => clone(config), hasProviderSecret: async () => true,
                saveConfig: async next => { config = clone(next); saved.push(clone(next)); return clone(next); },
                listProviderModels: request => { calls.push(request); return new Promise((resolve, reject) => { resolveCatalog = resolve; rejectCatalog = reject; }); }
            };
            const manager = AIProviderManager.create(api, { notify: message => notices.push(message) });
            await manager.ready;
            const drawer = document.getElementById('drawer');
            const field = name => drawer.querySelector('[data-ai-' + name + ']');
            const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); if (!predicate()) throw new Error('等待界面状态超时'); };
            drawer.querySelector('[data-edit]').click();
            const placed = field('update-models').previousElementSibling === field('test');
            const original = field('models').value;
            field('update-models').click();
            field('update-models').click();
            const pending = field('update-models').disabled && calls.length === 1 && field('models').value === original;
            const reusedSavedSecret = calls[0].providerId === 'saved' && calls[0].key === '';
            resolveCatalog({ models: [{ id: 'kept', label: 'Remote', capabilities: ['text'] }, { id: 'latest', label: 'Latest', capabilities: ['text'] }] });
            await until(() => !field('update-models').disabled);
            const preview = field('models').value;
            const preserved = preview.includes('自定义名称 | text,vision | responses') && preview.includes('latest') && !preview.includes('retired');
            const notSaved = saved.length === 0 && field('update-status').textContent.includes('待保存');
            field('form').requestSubmit();
            await until(() => saved.length === 1 && notices.includes('供应商已保存'));
            const savedModels = config.providers[0].models;
            const kept = savedModels.find(model => model.id === 'kept');
            const savedOk = savedModels.length === 2 && kept.label === '自定义名称'
                && kept.api === 'responses' && config.selections.text.modelId === 'kept';
            field('update-models').click();
            rejectCatalog(new Error('fixture failure'));
            await until(() => !field('update-models').disabled);
            const failedSafe = field('models').value === preview && saved.length === 1 && field('update-status').textContent.includes('原列表已保留');
            field('update-models').click();
            field('add').click();
            resolveCatalog({ models: [{ id: 'stale', capabilities: ['text'] }] });
            await until(() => !field('update-models').disabled);
            const switchedSafe = field('models').value === '' && field('name').value === '';
            field('name').value = 'New'; field('url').value = 'https://new.example/v1'; field('key').value = 'fixture-draft-key';
            field('update-models').click();
            const draftKey = calls.at(-1).key === 'fixture-draft-key' && calls.at(-1).providerId === undefined;
            field('models').value = 'manual | Manual | text';
            resolveCatalog({ models: [{ id: 'late', capabilities: ['text'] }] });
            await until(() => !field('update-models').disabled);
            const editedSafe = field('models').value === 'manual | Manual | text' && saved.length === 1 && field('key').value === 'fixture-draft-key';
            return { placed, pending, reusedSavedSecret, preserved, notSaved, savedOk, failedSafe, switchedSafe, draftKey, editedSafe };
        })()`);
        assert(Object.values(results).every(Boolean), JSON.stringify(results));
        const searchResults = await window.webContents.executeJavaScript(`(async () => {
            document.body.innerHTML = '<header style="display:flex;justify-content:flex-end;gap:10px;padding:10px"><button class="gear">供应商设置</button></header><button id="outside">其他操作</button><div id="overlay"></div><div id="drawer"></div>';
            const clone = value => JSON.parse(JSON.stringify(value));
            const notices = [], saves = [];
            let propagatedKeys = 0;
            document.addEventListener('keydown', () => { propagatedKeys++; });
            let failSave = false, slowSave = null;
            let config = { schemaVersion: 1, providers: [
                { id: 'openai', name: 'OpenAI', models: [{ id: 'same', label: 'GPT-6 Luna', capabilities: ['text', 'vision'] },
                    { id: 'only-text', label: '文本专用', capabilities: ['text'] }] },
                { id: 'gateway', name: '自定义网关', models: [{ id: 'same', label: 'GPT-6 Luna', capabilities: ['text', 'vision'] },
                    ...Array.from({ length: 150 }, (_, i) => ({ id: 'deepseek-' + i, label: '深度模型 ' + i, capabilities: ['text'] }))] }
            ], selections: { text: { providerId: 'openai', modelId: 'same' }, vision: { providerId: 'openai', modelId: 'same' } } };
            const manager = AIProviderManager.create({
                getConfig: async () => clone(config), hasProviderSecret: async () => true,
                saveConfig: async next => {
                    if (failSave) throw new Error('fixture save failure');
                    if (slowSave) await new Promise(resolve => { slowSave.resolve = resolve; });
                    config = clone(next); saves.push(clone(next)); return clone(next);
                }
            }, { notify: message => notices.push(message) });
            await manager.ready;
            const trigger = document.querySelector('.ai-model-trigger');
            const list = document.getElementById(trigger.getAttribute('aria-controls'));
            const panel = list.closest('.ai-model-popup'), input = panel.querySelector('input');
            const options = () => list.querySelectorAll('[role="option"]');
            const key = (name, extra = {}) => input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...extra }));
            const search = text => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
            const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); if (!predicate()) throw new Error('等待搜索交互超时'); };
            trigger.click();
            const opened = !panel.hidden && document.activeElement === input && options().length === 153;
            search('不存在的模型');
            key('Enter');
            const noResultSafe = options().length === 0 && panel.textContent.includes('没有匹配')
                && saves.length === 0 && (await manager.getSelection()).providerId === 'openai';
            search('网关 luna');
            const providerSearch = options().length === 1 && options()[0].textContent.includes('GPT-6 Luna');
            key('Enter', { isComposing: true });
            const imeSafe = saves.length === 0 && !panel.hidden;
            key('Escape');
            const cancelled = panel.hidden && document.activeElement === trigger && saves.length === 0;
            trigger.click(); search('DEEPSEEK-149');
            const idSearch = options().length === 1 && options()[0].textContent.includes('深度模型 149');
            document.getElementById('outside').dispatchEvent(new Event('pointerdown', { bubbles: true }));
            const outsideSafe = panel.hidden && saves.length === 0;
            trigger.click(); search('网关 luna'); options()[0].click();
            await until(() => panel.hidden && saves.length === 1);
            const mouseSelected = (await manager.getSelection()).providerId === 'gateway' && config.selections.text.modelId === 'same';
            trigger.click(); search('深度模型 14');
            key('ArrowDown');
            const active = document.getElementById(input.getAttribute('aria-activedescendant'));
            const expectedId = active.querySelector('small').textContent;
            key('Enter');
            await until(() => panel.hidden && saves.length === 2);
            const keyboardSelected = (await manager.getSelection()).modelId === expectedId;
            trigger.click(); search('OpenAI Luna'); failSave = true; options()[0].click();
            await until(() => !trigger.disabled);
            const failedSafe = !panel.hidden && (await manager.getSelection()).providerId === 'gateway'
                && (await manager.getSelection()).modelId === expectedId && saves.length === 2 && notices.at(-1).includes('切换失败');
            failSave = false; slowSave = {}; options()[0].click(); options()[0].click();
            await until(() => !!slowSave.resolve);
            const oldUntilSaved = trigger.disabled && (await manager.getSelection()).providerId === 'gateway';
            slowSave.resolve();
            await until(() => panel.hidden && saves.length === 3);
            slowSave = null;
            const singleCommit = saves.length === 3 && (await manager.getSelection()).providerId === 'openai';
            const before = document.createElement('button'); before.id = 'vision-gear'; document.querySelector('header').appendChild(before);
            const visionDrawer = document.createElement('div'); visionDrawer.id = 'vision-drawer'; document.body.appendChild(visionDrawer);
            const vision = AIProviderManager.create({ getConfig: async () => clone(config), hasProviderSecret: async () => true, saveConfig: async () => { throw new Error('unexpected save'); } },
                { before: '#vision-gear', drawer: '#vision-drawer', capability: 'vision' });
            await vision.ready;
            const visionTrigger = before.previousElementSibling.querySelector('.ai-model-trigger'); visionTrigger.click();
            const visionList = document.getElementById(visionTrigger.getAttribute('aria-controls'));
            const visionFiltered = visionList.querySelectorAll('[role="option"]').length === 2 && !visionList.textContent.includes('文本专用');
            visionList.closest('.ai-model-popup').querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { opened, noResultSafe, providerSearch, imeSafe, cancelled, idSearch, outsideSafe, mouseSelected, keyboardSelected, failedSafe, oldUntilSaved, singleCommit, visionFiltered, keyboardIsolated: propagatedKeys === 0 };
        })()`);
        assert(Object.values(searchResults).every(Boolean), JSON.stringify(searchResults));
        for (const width of [480, 700]) {
            window.setSize(width, 800);
            // 隐藏窗口在并发测试时尺寸通知可能延迟，等待渲染视口完成同步。
            let resized = false;
            for (let attempt = 0; attempt < 100; attempt++) {
                const [expectedWidth, expectedHeight] = window.getContentSize();
                const viewport = await window.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })');
                if (viewport.width === expectedWidth && viewport.height === expectedHeight) { resized = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert(resized, `${width}px 窗口的渲染视口未完成同步`);
            const overflow = await window.webContents.executeJavaScript('document.documentElement.scrollWidth - document.documentElement.clientWidth');
            assert(overflow <= 1, `${width}px 窗口溢出 ${overflow}px`);
            const panelFits = await window.webContents.executeJavaScript(`(() => {
                const trigger = document.querySelector('.ai-model-trigger'); trigger.click();
                const panel = document.getElementById(trigger.getAttribute('aria-controls')).closest('.ai-model-popup');
                const rect = panel.getBoundingClientRect();
                const fits = rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
                panel.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                return { fits, rect: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight }, trigger: trigger.getBoundingClientRect().toJSON() };
            })()`);
            assert(panelFits.fits, `${width}px 搜索浮层超出窗口：${JSON.stringify(panelFits)}`);
        }
        assert.deepEqual(errors, []);
        console.log('AI 供应商更新模型 Electron 交互验证通过；模型搜索、键盘操作与保存失败保护通过');
    } finally {
        if (window && !window.isDestroyed()) window.destroy();
        app.quit();
    }
}).catch(error => { console.error(error); app.exit(1); });
