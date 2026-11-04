const assert = require('assert');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
    let window;
    try {
        const plugin = process.env.SPEECH_INPUT_PLUGIN_DIR || path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-speech_input');
        window = new BrowserWindow({
            show: false, width: 800, height: 720,
            webPreferences: { preload: path.join(__dirname, 'speech-input-electron-preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false }
        });
        const errors = [];
        window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
        await window.loadFile(path.join(plugin, 'index.html'));
        const result = await window.webContents.executeJavaScript(`(async () => {
            callGemini = async () => '测试转写文本';
            Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
            window.MediaRecorder = class {
                constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
                start() { this.state = 'recording'; }
                stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio']) }); this.onstop(); }
            };
            const click = id => document.getElementById(id).click();
            click('record-toggle-btn');
            for (let i = 0; i < 30 && !isRecording; i++) await new Promise(resolve => setTimeout(resolve, 10));
            const started = isRecording && document.getElementById('record-cancel-btn').disabled === false;
            click('record-cancel-btn');
            const cancelled = !isRecording && __speechTest.inserts.length === 0;
            click('record-toggle-btn');
            for (let i = 0; i < 30 && !isRecording; i++) await new Promise(resolve => setTimeout(resolve, 10));
            click('record-toggle-btn');
            for (let i = 0; i < 30 && isProcessing; i++) await new Promise(resolve => setTimeout(resolve, 10));
            const manual = document.getElementById('workspace-result').value;
            const noAutoInsert = __speechTest.inserts.length === 0;
            document.getElementById('workspace-result').value = '校对后内容';
            document.getElementById('workspace-result').dispatchEvent(new Event('input'));
            click('result-copy-btn');
            click('result-insert-btn');
            await new Promise(resolve => setTimeout(resolve, 10));
            const edited = __speechTest.copies[0] === '校对后内容' && __speechTest.inserts[0] === '校对后内容';
            click('result-clear-btn');
            const file = new File(['audio'], 'recording.webm', { type: 'audio/webm' });
            const drop = new Event('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
            document.dispatchEvent(drop);
            for (let i = 0; i < 30 && !document.getElementById('workspace-result').value; i++) await new Promise(resolve => setTimeout(resolve, 10));
            const imported = document.getElementById('workspace-result').value;
            click('result-clear-btn');
            const cleared = document.getElementById('workspace-result').value === '';
            const autoInsertOption = document.getElementById('workspace-auto-insert');
            autoInsertOption.checked = true;
            autoInsertOption.dispatchEvent(new Event('change'));
            const optionSaved = __speechTest.storage.get('settings').workspaceAutoInsert === true;
            onRightCtrlDown();
            for (let i = 0; i < 30 && !isRecording; i++) await new Promise(resolve => setTimeout(resolve, 10));
            onRightCtrlUp();
            for (let i = 0; i < 30 && __speechTest.inserts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
            const hotkeyInserted = __speechTest.inserts[1] === '测试转写文本';
            const sharedModels = await window.electronAPI.sharedAi.listModels();
            await refreshSharedModels();
            const sharedChoice = document.getElementById('shared-speech-model');
            const sharedVisible = sharedChoice.options.length === 1 && sharedChoice.options[0].textContent.includes('GPT-6 Sol');
            document.getElementById('model-select').value = 'shared-model';
            document.getElementById('shared-asr-source').value = 'gemini';
            updateModelVisibility();
            const sharedPanelVisible = getComputedStyle(document.getElementById('shared-model-config')).display !== 'none';
            window.alert = () => {};
            click('save-settings-btn');
            const savedShared = __speechTest.storage.get('settings');
            const sharedSaved = savedShared.model === 'shared-model' && savedShared.sharedAsrSource === 'gemini'
                && savedShared.sharedSpeechSelection?.modelId === 'gpt-6-sol';
            await processAudio(new Blob(['audio'], { type: 'audio/webm' }), { autoInsert: false });
            const sharedResult = document.getElementById('workspace-result').value;
            const sharedTextOnly = __speechTest.sharedCalls.length === 1 && __speechTest.sharedCalls[0].text === '测试转写文本';
            const obsolete = { ...__speechTest.storage.get('settings'), model: 'shared-audio' };
            __speechTest.storage.set('settings', obsolete);
            await refreshSharedModels(obsolete);
            const migrated = __speechTest.storage.get('settings').model === 'shared-model'
                && __speechTest.storage.get('settings').sharedSpeechSelection.modelId === 'gpt-6-sol';
            const beforeOverflowCalls = __speechTest.sharedCalls.length;
            onRightCtrlDown();
            for (let i = 0; i < 30 && !isRecording; i++) await new Promise(resolve => setTimeout(resolve, 10));
            __speechTest.hook.stdout.emit('data', 'HOOK_OUTPUT_OVERFLOW\\n');
            const overflowCancelled = !isRecording && !isRightCtrlDown && recordingCancelled
                && __speechTest.sharedCalls.length === beforeOverflowCalls;
            const oldHook = __speechTest.hook;
            keyboardHookProcess = null;
            startRightCtrlHook();
            const newHook = __speechTest.hook;
            oldHook.emit('exit', 0);
            const staleExitSafe = keyboardHookProcess === newHook;
            const bg = getComputedStyle(document.body).backgroundColor;
            return { started, cancelled, manual, noAutoInsert, edited, imported, cleared, optionSaved, hotkeyInserted,
                sharedVisible, sharedPanelVisible, sharedSaved, sharedResult, sharedTextOnly, migrated, overflowCancelled, staleExitSafe,
                sharedCount: sharedModels.length, bg };
        })()`);
        assert(result.started && result.cancelled && result.noAutoInsert && result.edited && result.cleared && result.optionSaved && result.hotkeyInserted
            && result.sharedVisible && result.sharedPanelVisible && result.sharedSaved && result.sharedTextOnly && result.migrated
            && result.overflowCancelled && result.staleExitSafe, JSON.stringify(result));
        assert.strictEqual(result.manual, '测试转写文本');
        assert.strictEqual(result.imported, '测试转写文本');
        assert.strictEqual(result.sharedResult, '共享处理：测试转写文本');
        assert.strictEqual(result.bg, 'rgb(255, 255, 255)');
        for (const width of [800, 620]) {
            window.setSize(width, 720);
            await new Promise(resolve => setTimeout(resolve, 50));
            const overflow = await window.webContents.executeJavaScript('document.documentElement.scrollWidth - document.documentElement.clientWidth');
            assert.ok(overflow <= 1, `${width}px 窗口横向溢出 ${overflow}px`);
        }
        assert.deepStrictEqual(errors, []);
        console.log('AI 语音输入法 Electron 工作台交互测试通过');
    } finally {
        if (window && !window.isDestroyed()) window.destroy();
        app.quit();
    }
}).catch(error => { console.error(error); app.exit(1); });
