const assert = require('assert');
const path = require('path');
const { app, BrowserWindow } = require('electron');

if (!process.env.SPEECH_INPUT_TEST_ROOT) throw new Error('请通过 speech-input-isolated.test.cjs 启动隔离测试');
app.setPath('userData', path.join(process.env.SPEECH_INPUT_TEST_ROOT, 'userData'));
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
            const sourcePanels = { openai: 'openai-config', 'openai-compatible': 'openai-compatible-config', gemini: 'gemini-config', qwen: 'qwen-config', siliconflow: 'siliconflow-config' };
            const sourcesVisible = Object.entries(sourcePanels).every(([source, panel]) => {
                document.getElementById('shared-asr-source').value = source;
                document.getElementById('shared-asr-source').dispatchEvent(new Event('change'));
                return Object.values(sourcePanels).every(id => (getComputedStyle(document.getElementById(id)).display !== 'none') === (id === panel));
            });
            document.getElementById('shared-asr-source').value = 'openai-compatible';
            document.getElementById('shared-asr-source').dispatchEvent(new Event('change'));
            const missingVisible = document.getElementById('shared-asr-status').textContent.includes('API 地址');
            click('save-settings-btn');
            let microphoneRequests = 0;
            const getUserMedia = navigator.mediaDevices.getUserMedia;
            navigator.mediaDevices.getUserMedia = async () => { microphoneRequests++; return getUserMedia(); };
            const beforeMissingCalls = __speechTest.sharedCalls.length;
            await startRecording('manual');
            await processAudio(new Blob(['audio'], { type: 'audio/webm' }), { autoInsert: false });
            const missingBlocked = !isRecording && microphoneRequests === 0 && __speechTest.sharedCalls.length === beforeMissingCalls
                && __speechTest.audioCalls.length === 0 && document.getElementById('workspace-status').textContent.includes('API 地址');
            navigator.mediaDevices.getUserMedia = getUserMedia;
            document.getElementById('openai-compatible-url').value = 'https://api.openai.com/v1';
            document.getElementById('openai-compatible-key').value = 'test-audio-key';
            document.getElementById('openai-compatible-audio-model').value = 'gpt-transcribe';
            document.getElementById('openai-compatible-audio-model').dispatchEvent(new Event('input'));
            const filledVisible = document.getElementById('shared-asr-status').textContent.includes('已填写');
            click('save-settings-btn');
            await processAudio(new Blob(['audio'], { type: 'audio/webm' }), { autoInsert: false });
            const compatibleFlow = __speechTest.audioCalls.length === 1 && __speechTest.audioCalls[0].model === 'gpt-transcribe'
                && __speechTest.sharedCalls.at(-1).text === 'OpenAI 转写文本'
                && document.getElementById('workspace-result').value === '共享处理：OpenAI 转写文本';
            document.getElementById('model-select').value = 'openai';
            document.getElementById('model-select').dispatchEvent(new Event('change'));
            const openaiVisible = getComputedStyle(document.getElementById('openai-config')).display !== 'none'
                && getComputedStyle(document.getElementById('openai-compatible-config')).display === 'none'
                && document.getElementById('openai-asr-model').value === 'gpt-transcribe';
            click('save-settings-btn');
            await processAudio(new Blob(['audio'], { type: 'audio/webm' }), { autoInsert: false });
            const nativeMissingBlocked = __speechTest.openaiCalls.length === 0
                && document.getElementById('workspace-status').textContent.includes('OpenAI API Key');
            document.getElementById('openai-api-key').value = 'fixture-native-key';
            __speechTest.failOpenAIKeySave = true;
            click('save-settings-btn');
            for (let i = 0; i < 30 && document.getElementById('save-settings-btn').disabled; i++) await new Promise(resolve => setTimeout(resolve, 10));
            const failedKeyRetained = document.getElementById('openai-api-key').value === 'fixture-native-key'
                && !__speechTest.savedOpenAIKey && !document.getElementById('save-settings-btn').disabled;
            __speechTest.failOpenAIKeySave = false;
            click('save-settings-btn');
            for (let i = 0; i < 30 && !__speechTest.savedOpenAIKey; i++) await new Promise(resolve => setTimeout(resolve, 10));
            for (let i = 0; i < 30 && document.getElementById('save-settings-btn').disabled; i++) await new Promise(resolve => setTimeout(resolve, 10));
            const nativeSaved = __speechTest.storage.get('settings').model === 'openai'
                && __speechTest.storage.get('settings').openaiAsrModel === 'gpt-transcribe'
                && document.getElementById('openai-api-key').value === ''
                && !JSON.stringify(Array.from(__speechTest.storage.values())).includes('fixture-native-key');
            await processAudio(new Blob(['audio'], { type: 'audio/webm' }), { autoInsert: false });
            const nativeFlow = __speechTest.openaiCalls.length === 1 && __speechTest.openaiCalls[0].model === 'gpt-transcribe'
                && !Object.hasOwn(__speechTest.openaiCalls[0], 'apiKey')
                && document.getElementById('workspace-result').value === 'OpenAI 官方转写文本';
            document.getElementById('model-select').value = 'shared-model';
            document.getElementById('shared-asr-source').value = 'openai';
            updateModelVisibility();
            click('save-settings-btn');
            await processAudio(new Blob(['audio'], { type: 'audio/webm' }), { autoInsert: false });
            const nativeSharedFlow = __speechTest.openaiCalls.length === 2 && __speechTest.savedOpenAIKey === 'fixture-native-key'
                && __speechTest.sharedCalls.at(-1).text === 'OpenAI 官方转写文本'
                && document.getElementById('workspace-result').value === '共享处理：OpenAI 官方转写文本';
            // 恢复后继续验证旧共享设置迁移及键盘钩子，避免配置用例影响后续测试。
            __speechTest.storage.set('settings', savedShared);
            document.getElementById('shared-asr-source').value = 'gemini';
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
                sharedVisible, sharedPanelVisible, sharedSaved, sharedResult, sharedTextOnly, sourcesVisible, missingVisible, missingBlocked, filledVisible, compatibleFlow, migrated, overflowCancelled, staleExitSafe,
                openaiVisible, nativeMissingBlocked, failedKeyRetained, nativeSaved, nativeFlow, nativeSharedFlow,
                sharedCount: sharedModels.length, bg };
        })()`);
        assert(result.started && result.cancelled && result.noAutoInsert && result.edited && result.cleared && result.optionSaved && result.hotkeyInserted
            && result.sharedVisible && result.sharedPanelVisible && result.sharedSaved && result.sharedTextOnly && result.migrated
            && result.sourcesVisible && result.missingVisible && result.missingBlocked && result.filledVisible && result.compatibleFlow
            && result.openaiVisible && result.nativeMissingBlocked && result.failedKeyRetained && result.nativeSaved && result.nativeFlow && result.nativeSharedFlow
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
