// State
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let keyboardHookProcess = null;
let isRightCtrlDown = false;
let isProcessing = false;
let isStartingRecording = false;
let recordingCancelled = false;
let recordingStartedAt = 0;
let recordingTimer = null;

const workspace = {
    card: document.querySelector('.workspace-card'),
    record: document.getElementById('record-toggle-btn'),
    cancel: document.getElementById('record-cancel-btn'),
    import: document.getElementById('audio-file-btn'),
    file: document.getElementById('audio-file-input'),
    copy: document.getElementById('result-copy-btn'),
    insert: document.getElementById('result-insert-btn'),
    clear: document.getElementById('result-clear-btn'),
    result: document.getElementById('workspace-result'),
    status: document.getElementById('workspace-status'),
    duration: document.getElementById('record-duration'),
    count: document.getElementById('result-count'),
    autoInsert: document.getElementById('workspace-auto-insert')
};

function setWorkspaceStatus(message, kind = 'info') {
    if (!workspace.status) return;
    workspace.status.textContent = message;
    workspace.status.dataset.kind = kind;
}

function updateWorkspaceControls() {
    if (!workspace.record) return;
    workspace.record.textContent = isRecording ? '结束录音' : '开始录音';
    workspace.record.disabled = isProcessing || isStartingRecording;
    workspace.cancel.disabled = !isRecording;
    workspace.import.disabled = isRecording || isProcessing || isStartingRecording;
    const hasResult = !!workspace.result.value.trim();
    workspace.copy.disabled = !hasResult;
    workspace.insert.disabled = !hasResult || isProcessing;
    workspace.clear.disabled = !hasResult || isProcessing;
    workspace.count.textContent = `${Array.from(workspace.result.value).length} 字`;
}

function updateRecordingDuration() {
    if (!workspace.duration) return;
    const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
    workspace.duration.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function stopRecordingTimer() {
    if (recordingTimer) clearInterval(recordingTimer);
    recordingTimer = null;
}

function setupWorkspace() {
    if (!workspace.record) return;
    updateWorkspaceControls();
    workspace.record.addEventListener('click', () => {
        if (isRecording) stopRecording();
        else startRecording('manual');
    });
    workspace.cancel.addEventListener('click', () => {
        recordingCancelled = true;
        stopRecording();
        setWorkspaceStatus('录音已取消，未发送音频。');
    });
    workspace.import.addEventListener('click', () => workspace.file.click());
    workspace.file.addEventListener('change', () => {
        const file = workspace.file.files && workspace.file.files[0];
        workspace.file.value = '';
        if (file) importAudioFile(file);
    });
    workspace.result.addEventListener('input', updateWorkspaceControls);
    workspace.autoInsert.addEventListener('change', () => {
        const settings = window.electronAPI.storage.get('settings') || {};
        window.electronAPI.storage.set('settings', { ...settings, workspaceAutoInsert: workspace.autoInsert.checked });
    });
    workspace.copy.addEventListener('click', () => {
        window.electronAPI.action.copy(workspace.result.value);
        setWorkspaceStatus('结果已复制，可粘贴到其他应用。');
    });
    workspace.insert.addEventListener('click', async () => {
        const success = await insertToExternalApp(workspace.result.value);
        setWorkspaceStatus(success ? '已尝试插入结果。' : '插入失败，结果仍保留在工作台。', success ? 'info' : 'error');
    });
    workspace.clear.addEventListener('click', () => {
        workspace.result.value = '';
        updateWorkspaceControls();
        setWorkspaceStatus('结果已清空。');
    });
    document.addEventListener('dragover', event => {
        if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
    });
    document.addEventListener('drop', event => {
        if (!event.dataTransfer || !event.dataTransfer.files.length) return;
        event.preventDefault();
        workspace.card.classList.remove('drag-over');
        importAudioFile(event.dataTransfer.files[0]);
    });
    workspace.card.addEventListener('dragenter', () => workspace.card.classList.add('drag-over'));
    workspace.card.addEventListener('dragleave', event => {
        if (!workspace.card.contains(event.relatedTarget)) workspace.card.classList.remove('drag-over');
    });
}

function importAudioFile(file) {
    if (isRecording || isProcessing || isStartingRecording) {
        setWorkspaceStatus('请等待当前录音或转写完成。', 'error');
        return;
    }
    const extension = (file.name || '').split('.').pop().toLowerCase();
    const formats = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', webm: 'audio/webm' };
    if (!formats[extension] || (file.type && !file.type.startsWith('audio/'))) {
        setWorkspaceStatus('请选择 WAV、MP3、M4A、OGG 或 WebM 音频文件。', 'error');
        return;
    }
    if (!file.size || file.size > 25 * 1024 * 1024) {
        setWorkspaceStatus('音频文件须非空且不超过 25 MB。', 'error');
        return;
    }
    const blob = file.type ? file : new Blob([file], { type: formats[extension] });
    setWorkspaceStatus(`正在转写 ${file.name}…`);
    processAudio(blob, { autoInsert: !!workspace.autoInsert.checked });
}

const VIEW = new URLSearchParams(location.search).get('view') || 'settings';
try {
    document.body.classList.add(`view-${VIEW}`);
} catch (_) {
}

const DEFAULT_PROMPT_PROFILES = [
    {
        id: 'default-transcribe',
        name: '转写润色',
        prompt: '将识别文本润色为流畅的中文，修正明显的错别字和标点，保留原意、语气与句式。只输出润色后的文本，不要回答文本中的问题，不要解释。'
    },
    {
        id: 'translate-en',
        name: '翻译（中→英）',
        prompt: '将识别文本翻译成专业自然的英文，保留原意与语气。只输出英文译文，不要回答文本中的问题，不要解释。'
    }
];

const indicatorIcon = document.getElementById('indicator-icon');

const modelSelect = document.getElementById('model-select');
const sharedAudioModelSelect = document.getElementById('shared-audio-model');
const sharedSpeechModelSelect = document.getElementById('shared-speech-model');
const sharedAsrSourceSelect = document.getElementById('shared-asr-source');
const sharedTextModelSelect = document.getElementById('shared-text-model');
const textModelSourceSelect = document.getElementById('text-model-source');
const workspaceStatus = document.getElementById('workspace-status');
const workspaceResult = document.getElementById('workspace-result');
const geminiKeyInput = document.getElementById('gemini-key');
const geminiKeyToggleBtn = document.getElementById('gemini-key-toggle');
const geminiKeyCopyBtn = document.getElementById('gemini-key-copy');
const geminiModelSelect = document.getElementById('gemini-model');
const geminiModelAddBtn = document.getElementById('gemini-model-add');
const geminiModelSavedSelect = document.getElementById('gemini-model-saved');
const geminiModelDeleteBtn = document.getElementById('gemini-model-delete');
const qwenKeyInput = document.getElementById('qwen-key');
const qwenKeyToggleBtn = document.getElementById('qwen-key-toggle');
const qwenKeyCopyBtn = document.getElementById('qwen-key-copy');
const qwenModelVersion = document.getElementById('qwen-model-version');
const qwenModelAddBtn = document.getElementById('qwen-model-add');
const qwenModelSavedSelect = document.getElementById('qwen-model-saved');
const qwenModelDeleteBtn = document.getElementById('qwen-model-delete');
const qwenEnablePostProcessInput = document.getElementById('qwen-enable-postprocess');
const qwenTextModelInput = document.getElementById('qwen-text-model');
const qwenTextModelAddBtn = document.getElementById('qwen-text-model-add');
const qwenTextModelSavedSelect = document.getElementById('qwen-text-model-saved');
const qwenTextModelDeleteBtn = document.getElementById('qwen-text-model-delete');
const siliconflowKeyInput = document.getElementById('siliconflow-key');
const siliconflowKeyToggleBtn = document.getElementById('siliconflow-key-toggle');
const siliconflowKeyCopyBtn = document.getElementById('siliconflow-key-copy');
const siliconflowAsrModelInput = document.getElementById('siliconflow-asr-model');
const siliconflowAsrModelAddBtn = document.getElementById('siliconflow-asr-model-add');
const siliconflowAsrModelSavedSelect = document.getElementById('siliconflow-asr-model-saved');
const siliconflowAsrModelDeleteBtn = document.getElementById('siliconflow-asr-model-delete');
const siliconflowEnablePostProcessInput = document.getElementById('siliconflow-enable-postprocess');
const siliconflowTextModelInput = document.getElementById('siliconflow-text-model');
const siliconflowTextModelAddBtn = document.getElementById('siliconflow-text-model-add');
const siliconflowTextModelSavedSelect = document.getElementById('siliconflow-text-model-saved');
const siliconflowTextModelDeleteBtn = document.getElementById('siliconflow-text-model-delete');
const openaiCompatibleProfileSelect = document.getElementById('openai-compatible-profile-select');
const openaiCompatibleNewBtn = document.getElementById('openai-compatible-new-btn');
const openaiCompatibleDeleteBtn = document.getElementById('openai-compatible-delete-btn');
const openaiCompatibleProfileNameInput = document.getElementById('openai-compatible-profile-name');
const openaiCompatibleUrlInput = document.getElementById('openai-compatible-url');
const openaiCompatibleKeyInput = document.getElementById('openai-compatible-key');
const openaiCompatibleKeyToggleBtn = document.getElementById('openai-compatible-key-toggle');
const openaiCompatibleKeyCopyBtn = document.getElementById('openai-compatible-key-copy');
const openaiCompatibleAudioModelInput = document.getElementById('openai-compatible-audio-model');
const openaiCompatibleAudioFormatModeSelect = document.getElementById('openai-compatible-audio-format-mode');
const openaiCompatibleEnablePostProcessInput = document.getElementById('openai-compatible-enable-postprocess');
const openaiCompatibleTextModelInput = document.getElementById('openai-compatible-text-model');
const systemPromptInput = document.getElementById('system-prompt');
const speechGlossaryInput = document.getElementById('speech-glossary');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const geminiConfig = document.getElementById('gemini-config');
const qwenConfig = document.getElementById('qwen-config');
const siliconflowConfig = document.getElementById('siliconflow-config');
const openaiCompatibleConfig = document.getElementById('openai-compatible-config');
const promptProfileSelect = document.getElementById('prompt-profile-select');
const promptNewBtn = document.getElementById('prompt-new-btn');
const promptDeleteBtn = document.getElementById('prompt-delete-btn');
const promptNewNameInput = document.getElementById('prompt-new-name');

const sceneHotkeyEnabledInput = document.getElementById('scene-hotkey-enabled');
const sceneHotkeyShortcutInputs = Array.from({ length: 10 }, (_, i) => document.getElementById(`scene-hotkey-shortcut-${i + 1}`));
const sceneHotkeyProfileSelects = Array.from({ length: 10 }, (_, i) => document.getElementById(`scene-hotkey-profile-${i + 1}`));
const textPostProcessEnabledInput = document.getElementById('text-postprocess-enabled');
const textProviderProfileSelect = document.getElementById('text-provider-profile');
const textProviderNewBtn = document.getElementById('text-provider-new');
const textProviderDeleteBtn = document.getElementById('text-provider-delete');
const textProviderNameInput = document.getElementById('text-provider-name');
const textProviderUrlInput = document.getElementById('text-provider-url');
const textProviderKeyInput = document.getElementById('text-provider-key');
const textProviderModelInput = document.getElementById('text-provider-model');
const textPostProcessHotkeyEnabledInput = document.getElementById('text-postprocess-hotkey-enabled');
const textPostProcessHotkeyInput = document.getElementById('text-postprocess-hotkey');
const textPostProcessHotkeyRecordBtn = document.getElementById('text-postprocess-hotkey-record');
let hotkeyCaptureTarget = null;

const DEFAULT_MODEL_LISTS = {
    geminiModels: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    qwenModels: ['qwen3-asr-flash', 'paraformer-v2'],
    qwenTextModels: ['qwen-plus'],
    siliconflowAsrModels: ['TeleAI/TeleSpeechASR'],
    siliconflowTextModels: ['deepseek-ai/DeepSeek-V3.2']
};

const MODEL_LIST_CONFIGS = {
    geminiModels: { input: geminiModelSelect, savedSelect: geminiModelSavedSelect, datalistId: 'gemini-model-list', fallback: 'gemini-3-flash-preview' },
    qwenModels: { input: qwenModelVersion, savedSelect: qwenModelSavedSelect, datalistId: 'qwen-model-list', fallback: 'qwen3-asr-flash' },
    qwenTextModels: { input: qwenTextModelInput, savedSelect: qwenTextModelSavedSelect, datalistId: 'qwen-text-model-list', fallback: 'qwen-plus' },
    siliconflowAsrModels: { input: siliconflowAsrModelInput, savedSelect: siliconflowAsrModelSavedSelect, datalistId: 'siliconflow-asr-model-list', fallback: 'TeleAI/TeleSpeechASR' },
    siliconflowTextModels: { input: siliconflowTextModelInput, savedSelect: siliconflowTextModelSavedSelect, datalistId: 'siliconflow-text-model-list', fallback: 'deepseek-ai/DeepSeek-V3.2' }
};

function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const v of values || []) {
        const s = String(v || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

function normalizeModelList(settings, key, selectedValue) {
    const hasStoredList = settings && Array.isArray(settings[key]);
    const base = hasStoredList ? settings[key] : (DEFAULT_MODEL_LISTS[key] || []);
    return uniqueStrings([
        ...base,
        selectedValue || ''
    ]);
}

function renderModelDatalist(key, values) {
    const cfg = MODEL_LIST_CONFIGS[key];
    if (!cfg) return;
    const normalized = uniqueStrings(values);
    const datalist = document.getElementById(cfg.datalistId);
    if (datalist) {
        datalist.innerHTML = '';
        for (const value of normalized) {
            const opt = document.createElement('option');
            opt.value = value;
            datalist.appendChild(opt);
        }
    }
    if (cfg.savedSelect) {
        const current = cfg.input ? (cfg.input.value || '') : '';
        cfg.savedSelect.innerHTML = '';
        for (const value of normalized) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = value;
            if (value === current) opt.selected = true;
            cfg.savedSelect.appendChild(opt);
        }
    }
}

function addModelToList(key) {
    const cfg = MODEL_LIST_CONFIGS[key];
    if (!cfg || !cfg.input) return;
    const value = (cfg.input.value || '').trim();
    if (!value) {
        alert('请先输入模型名称');
        return;
    }
    const settings = window.electronAPI.storage.get('settings') || {};
    const next = normalizeModelList(settings, key, value);
    window.electronAPI.storage.set('settings', { ...settings, [key]: next });
    renderModelDatalist(key, next);
}

function deleteModelFromList(key) {
    const cfg = MODEL_LIST_CONFIGS[key];
    if (!cfg || !cfg.savedSelect) return;
    const value = (cfg.savedSelect.value || '').trim();
    if (!value) return;

    const settings = window.electronAPI.storage.get('settings') || {};
    const current = normalizeModelList(settings, key, cfg.input ? cfg.input.value : '');
    if (current.length <= 1) {
        alert('至少保留一个模型');
        return;
    }
    const next = current.filter(v => v !== value);
    if (cfg.input && cfg.input.value === value) {
        cfg.input.value = next[0] || '';
    }
    window.electronAPI.storage.set('settings', { ...settings, [key]: next });
    renderModelDatalist(key, next);
}

function chooseModelFromSavedList(key) {
    const cfg = MODEL_LIST_CONFIGS[key];
    if (!cfg || !cfg.input || !cfg.savedSelect) return;
    cfg.input.value = cfg.savedSelect.value || '';
    renderModelDatalist(key, normalizeModelList(window.electronAPI.storage.get('settings') || {}, key, cfg.input.value));
}

function setupCustomModelLists(settings) {
    for (const [key, cfg] of Object.entries(MODEL_LIST_CONFIGS)) {
        const selected = cfg.input ? (cfg.input.value || '') : '';
        renderModelDatalist(key, normalizeModelList(settings, key, selected || cfg.fallback));
    }
}

function setSpeechState(state) {
    try {
        localStorage.setItem('speech_input_state', JSON.stringify({ state, ts: Date.now() }));
    } catch (_) {
    }
}

function createDefaultOpenAICompatibleProfile(settings) {
    return {
        id: 'default-openai-compatible',
        name: settings && settings.openaiCompatibleProfileName ? settings.openaiCompatibleProfileName : '默认兼容模型',
        baseUrl: settings && settings.openaiCompatibleUrl ? settings.openaiCompatibleUrl : '',
        apiKey: settings && settings.openaiCompatibleKey ? settings.openaiCompatibleKey : '',
        audioModel: settings && settings.openaiCompatibleAudioModel ? settings.openaiCompatibleAudioModel : '',
        audioFormatMode: settings && settings.openaiCompatibleAudioFormatMode ? settings.openaiCompatibleAudioFormatMode : 'auto',
        enablePostProcess: !!(settings && settings.openaiCompatibleEnablePostProcess),
        textModel: settings && settings.openaiCompatibleTextModel ? settings.openaiCompatibleTextModel : ''
    };
}

function normalizeOpenAICompatibleProfiles(settings) {
    const raw = settings && Array.isArray(settings.openaiCompatibleProfiles) ? settings.openaiCompatibleProfiles : [];
    const profiles = raw.map((p, index) => ({
        id: p && p.id ? String(p.id) : `openai-compatible-${Date.now()}-${index}`,
        name: p && p.name ? String(p.name) : `兼容模型 ${index + 1}`,
        baseUrl: p && p.baseUrl ? String(p.baseUrl) : '',
        apiKey: p && p.apiKey ? String(p.apiKey) : '',
        audioModel: p && p.audioModel ? String(p.audioModel) : '',
        audioFormatMode: p && p.audioFormatMode ? String(p.audioFormatMode) : 'auto',
        enablePostProcess: !!(p && p.enablePostProcess),
        textModel: p && p.textModel ? String(p.textModel) : ''
    }));

    if (!profiles.length) {
        profiles.push(createDefaultOpenAICompatibleProfile(settings || {}));
    }
    return profiles;
}

function getActiveOpenAICompatibleProfile(settings) {
    const profiles = normalizeOpenAICompatibleProfiles(settings || {});
    const activeId = (settings && settings.activeOpenAICompatibleProfileId) || profiles[0].id;
    return profiles.find(p => p.id === activeId) || profiles[0];
}

function readOpenAICompatibleProfileFromInputs(id) {
    return {
        id: id || `openai-compatible-${Date.now()}`,
        name: (openaiCompatibleProfileNameInput && openaiCompatibleProfileNameInput.value || '').trim() || '未命名兼容模型',
        baseUrl: (openaiCompatibleUrlInput && openaiCompatibleUrlInput.value || '').trim(),
        apiKey: openaiCompatibleKeyInput ? openaiCompatibleKeyInput.value : '',
        audioModel: (openaiCompatibleAudioModelInput && openaiCompatibleAudioModelInput.value || '').trim(),
        audioFormatMode: openaiCompatibleAudioFormatModeSelect ? openaiCompatibleAudioFormatModeSelect.value || 'auto' : 'auto',
        enablePostProcess: openaiCompatibleEnablePostProcessInput ? !!openaiCompatibleEnablePostProcessInput.checked : false,
        textModel: (openaiCompatibleTextModelInput && openaiCompatibleTextModelInput.value || '').trim()
    };
}

function applyOpenAICompatibleProfileToInputs(profile) {
    const p = profile || createDefaultOpenAICompatibleProfile({});
    if (openaiCompatibleProfileNameInput) openaiCompatibleProfileNameInput.value = p.name || '';
    if (openaiCompatibleUrlInput) openaiCompatibleUrlInput.value = p.baseUrl || '';
    if (openaiCompatibleKeyInput) openaiCompatibleKeyInput.value = p.apiKey || '';
    if (openaiCompatibleAudioModelInput) openaiCompatibleAudioModelInput.value = p.audioModel || '';
    if (openaiCompatibleAudioFormatModeSelect) openaiCompatibleAudioFormatModeSelect.value = p.audioFormatMode || 'auto';
    if (openaiCompatibleEnablePostProcessInput) openaiCompatibleEnablePostProcessInput.checked = !!p.enablePostProcess;
    if (openaiCompatibleTextModelInput) {
        openaiCompatibleTextModelInput.value = p.textModel || '';
        openaiCompatibleTextModelInput.disabled = !p.enablePostProcess;
    }
}

function renderOpenAICompatibleProfiles(profiles, activeId) {
    if (!openaiCompatibleProfileSelect) return;
    openaiCompatibleProfileSelect.innerHTML = '';
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || '未命名兼容模型';
        if (p.id === activeId) opt.selected = true;
        openaiCompatibleProfileSelect.appendChild(opt);
    }
}

function persistOpenAICompatibleProfileFromInputs() {
    const settings = window.electronAPI.storage.get('settings') || {};
    const profiles = normalizeOpenAICompatibleProfiles(settings);
    const activeId = settings.activeOpenAICompatibleProfileId || profiles[0].id;
    const nextProfile = readOpenAICompatibleProfileFromInputs(activeId);
    const nextProfiles = profiles.map(p => p.id === activeId ? nextProfile : p);
    window.electronAPI.storage.set('settings', {
        ...settings,
        openaiCompatibleProfiles: nextProfiles,
        activeOpenAICompatibleProfileId: activeId,
        openaiCompatibleProfileName: nextProfile.name,
        openaiCompatibleUrl: nextProfile.baseUrl,
        openaiCompatibleKey: nextProfile.apiKey,
        openaiCompatibleAudioModel: nextProfile.audioModel,
        openaiCompatibleAudioFormatMode: nextProfile.audioFormatMode,
        openaiCompatibleEnablePostProcess: nextProfile.enablePostProcess,
        openaiCompatibleTextModel: nextProfile.textModel
    });
    renderOpenAICompatibleProfiles(nextProfiles, activeId);
    return { settings, profiles: nextProfiles, activeId, profile: nextProfile };
}

function defaultTextProviders(settings) {
    const profiles = [];
    const add = (profile) => {
        if (profile.model && profile.baseUrl && !profiles.some(item => item.id === profile.id)) profiles.push(profile);
    };
    add({
        id: 'text-provider-default',
        name: settings.textProviderName || '自定义文本模型',
        baseUrl: settings.textProviderUrl || '',
        apiKey: settings.textProviderKey || '',
        model: settings.textProviderModel || ''
    });
    add({
        id: 'text-provider-qwen', name: '通义千问文本处理',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: settings.qwenKey || '', model: settings.qwenTextModel || 'qwen-plus'
    });
    add({
        id: 'text-provider-siliconflow', name: '硅基流动文本处理',
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: settings.siliconflowKey || '', model: settings.siliconflowTextModel || 'deepseek-ai/DeepSeek-V3.2'
    });
    for (const profile of normalizeOpenAICompatibleProfiles(settings)) {
        if (!profile.textModel) continue;
        add({
            id: `text-from-${profile.id}`,
            name: `${profile.name} · ${profile.textModel}`,
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            model: profile.textModel
        });
    }
    return profiles.length ? profiles : [{
        id: 'text-provider-default', name: '自定义文本模型', baseUrl: '', apiKey: '', model: ''
    }];
}

function normalizeTextProviderProfiles(settings) {
    const raw = Array.isArray(settings.textProviderProfiles) ? settings.textProviderProfiles : [];
    const profiles = raw.map((profile, index) => ({
        id: String(profile && profile.id || `text-provider-${index + 1}`),
        name: String(profile && profile.name || '自定义文本模型'),
        baseUrl: String(profile && profile.baseUrl || ''),
        apiKey: String(profile && profile.apiKey || ''),
        model: String(profile && profile.model || '')
    }));
    return profiles.length ? profiles : defaultTextProviders(settings);
}

function getActiveTextProvider(settings) {
    const profiles = normalizeTextProviderProfiles(settings);
    const activeId = settings.activeTextProviderId || profiles[0].id;
    return profiles.find(profile => profile.id === activeId) || profiles[0];
}

function readTextProviderInputs(id) {
    return {
        id: id || `text-provider-${Date.now()}`,
        name: (textProviderNameInput && textProviderNameInput.value.trim()) || '自定义文本模型',
        baseUrl: (textProviderUrlInput && textProviderUrlInput.value.trim()) || '',
        apiKey: (textProviderKeyInput && textProviderKeyInput.value) || '',
        model: (textProviderModelInput && textProviderModelInput.value.trim()) || ''
    };
}

function applyTextProviderInputs(profile) {
    if (!profile) return;
    if (textProviderNameInput) textProviderNameInput.value = profile.name || '';
    if (textProviderUrlInput) textProviderUrlInput.value = profile.baseUrl || '';
    if (textProviderKeyInput) textProviderKeyInput.value = profile.apiKey || '';
    if (textProviderModelInput) textProviderModelInput.value = profile.model || '';
}

function renderTextProviderProfiles(settings) {
    if (!textProviderProfileSelect) return;
    const profiles = normalizeTextProviderProfiles(settings);
    const active = getActiveTextProvider({ ...settings, textProviderProfiles: profiles });
    textProviderProfileSelect.innerHTML = '';
    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        textProviderProfileSelect.appendChild(option);
    }
    textProviderProfileSelect.value = active.id;
    applyTextProviderInputs(active);
}

function persistTextProviderInputs() {
    const settings = window.electronAPI.storage.get('settings') || {};
    const profiles = normalizeTextProviderProfiles(settings);
    const activeId = (textProviderProfileSelect && textProviderProfileSelect.value) || settings.activeTextProviderId || profiles[0].id;
    const current = readTextProviderInputs(activeId);
    const next = profiles.map(profile => profile.id === activeId ? current : profile);
    window.electronAPI.storage.set('settings', {
        ...settings,
        textProviderProfiles: next,
        activeTextProviderId: activeId
    });
    return current;
}

function applyIndicatorState(state) {
    if (!indicatorIcon) return;
    indicatorIcon.classList.remove('state-recording');
    indicatorIcon.classList.remove('state-processing');
    indicatorIcon.classList.remove('state-ready');

    if (state === 'recording') {
        indicatorIcon.classList.add('state-recording');
        indicatorIcon.textContent = '🎙️';
    } else if (state === 'processing') {
        indicatorIcon.classList.add('state-processing');
        indicatorIcon.textContent = '⏳';
    } else {
        indicatorIcon.classList.add('state-ready');
        indicatorIcon.textContent = '🎙️';
    }
}

function initIndicatorView() {
    const current = (() => {
        try {
            const raw = localStorage.getItem('speech_input_state');
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && parsed.state ? parsed.state : 'ready';
        } catch (_) {
            return 'ready';
        }
    })();

    applyIndicatorState(current);

    window.addEventListener('storage', (e) => {
        if (!e || e.key !== 'speech_input_state') return;
        try {
            const parsed = e.newValue ? JSON.parse(e.newValue) : null;
            applyIndicatorState(parsed && parsed.state ? parsed.state : 'ready');
        } catch (_) {
            applyIndicatorState('ready');
        }
    });
}

function initSettingsView() {
    if (!window.electronAPI) {
        // 兼容打包后 preload 未生效/加载失败的情况：在渲染进程内手动执行 preload 来补齐桥接对象。
        try {
            require('./preload.js');
        } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            alert(`初始化失败：插件桥接未加载。preload.js 执行失败：${msg}`);
            return;
        }
        if (!window.electronAPI) {
            alert('初始化失败：插件桥接未加载，请重启应用后重试');
            return;
        }
    }
    loadSettings();
    setupEventListeners();
    setupWorkspace();
    setSpeechState('ready');
    try {
        if (window.electronAPI.window && typeof window.electronAPI.window.createIndicatorWindow === 'function') {
            window.electronAPI.window.createIndicatorWindow();
        }
    } catch (_) {
    }
    startRightCtrlHook();
}

function loadSettings() {
    const settings = window.electronAPI.storage.get('settings') || {};
    if (workspace.autoInsert) workspace.autoInsert.checked = !!settings.workspaceAutoInsert;
    
    // Defaults
    modelSelect.value = settings.model || 'gemini';
    if (sharedAsrSourceSelect) sharedAsrSourceSelect.value = settings.sharedAsrSource || 'openai-compatible';
    if (textModelSourceSelect) textModelSourceSelect.value = settings.textModelSource === 'shared' ? 'shared' : 'local';
    refreshSharedModels(settings).catch(error => { if (workspaceStatus) workspaceStatus.textContent = `共享模型读取失败：${error.message}`; });
    updateTextModelSource();
    geminiKeyInput.value = settings.geminiKey || '';
    geminiModelSelect.value = settings.geminiModel || 'gemini-3-flash-preview';
    qwenKeyInput.value = settings.qwenKey || '';
    const normalizedQwenModel = settings.qwenModel || 'qwen3-asr-flash';
    qwenModelVersion.value = normalizedQwenModel;
    qwenTextModelInput.value = settings.qwenTextModel || 'qwen-plus';
    siliconflowKeyInput.value = settings.siliconflowKey || '';
    siliconflowAsrModelInput.value = settings.siliconflowAsrModel || 'TeleAI/TeleSpeechASR';
    if (qwenEnablePostProcessInput) {
        qwenEnablePostProcessInput.checked = !!settings.qwenEnablePostProcess;
    }
    if (qwenTextModelInput) {
        qwenTextModelInput.disabled = !(settings.qwenEnablePostProcess);
    }
    const openaiProfiles = normalizeOpenAICompatibleProfiles(settings);
    const activeOpenaiId = settings.activeOpenAICompatibleProfileId || openaiProfiles[0].id;
    renderOpenAICompatibleProfiles(openaiProfiles, activeOpenaiId);
    applyOpenAICompatibleProfileToInputs(openaiProfiles.find(profile => profile.id === activeOpenaiId) || openaiProfiles[0]);

    const textProfiles = normalizeTextProviderProfiles(settings);
    const textEnabled = typeof settings.textPostProcessEnabled === 'boolean'
        ? settings.textPostProcessEnabled
        : !!(settings.qwenEnablePostProcess || settings.openaiCompatibleEnablePostProcess);
    if (textPostProcessEnabledInput) textPostProcessEnabledInput.checked = textEnabled;
    if (textPostProcessHotkeyEnabledInput) textPostProcessHotkeyEnabledInput.checked = !!settings.textPostProcessHotkeyEnabled;
    if (textPostProcessHotkeyInput) textPostProcessHotkeyInput.value = canonicalizeHotkey(settings.textPostProcessHotkey || '');
    if (speechGlossaryInput) speechGlossaryInput.value = settings.speechGlossaryText || '';

    const profiles = Array.isArray(settings.promptProfiles) && settings.promptProfiles.length > 0
        ? settings.promptProfiles
        : DEFAULT_PROMPT_PROFILES;
    const activeProfileId = settings.activePromptProfileId || profiles[0].id;

    const sceneHotkeys = normalizeSceneHotkeys(settings.sceneHotkeys, profiles);

    window.electronAPI.storage.set('settings', {
        ...settings,
        qwenModel: normalizedQwenModel,
        geminiModels: normalizeModelList(settings, 'geminiModels', geminiModelSelect.value),
        qwenModels: normalizeModelList(settings, 'qwenModels', normalizedQwenModel),
        qwenTextModels: normalizeModelList(settings, 'qwenTextModels', qwenTextModelInput.value),
        siliconflowAsrModels: normalizeModelList(settings, 'siliconflowAsrModels', siliconflowAsrModelInput.value),
        siliconflowTextModels: normalizeModelList(settings, 'siliconflowTextModels', siliconflowTextModelInput ? siliconflowTextModelInput.value : ''),
        siliconflowAsrModel: siliconflowAsrModelInput.value || 'TeleAI/TeleSpeechASR',
        openaiCompatibleProfiles: openaiProfiles,
        activeOpenAICompatibleProfileId: activeOpenaiId,
        textProviderProfiles: textProfiles,
        activeTextProviderId: settings.activeTextProviderId || textProfiles[0].id,
        textPostProcessEnabled: textEnabled,
        promptProfiles: profiles,
        activePromptProfileId: activeProfileId,
        sceneHotkeys
    });

    renderPromptProfiles(profiles, activeProfileId);
    renderSceneHotkeys(profiles, sceneHotkeys);
    const active = profiles.find(p => p.id === activeProfileId) || profiles[0];
    if (active) {
        systemPromptInput.value = active.prompt || '';
    }

    setupCustomModelLists(window.electronAPI.storage.get('settings') || settings);
    renderTextProviderProfiles(window.electronAPI.storage.get('settings') || settings);
    updateModelVisibility();
}

function normalizeSceneHotkeys(raw, profiles) {
    const enabled = !!(raw && raw.enabled);
    const mappingRaw = raw && typeof raw.mapping === 'object' && raw.mapping ? raw.mapping : {};
    const shortcutRaw = raw && typeof raw.shortcuts === 'object' && raw.shortcuts ? raw.shortcuts : {};
    const validIds = new Set((profiles || []).map(p => p && p.id).filter(Boolean));
    const mapping = {};
    const shortcuts = {};
    for (let slot = 1; slot <= 10; slot++) {
        const key = String(slot);
        const id = mappingRaw[key] || mappingRaw[slot];
        if (id && validIds.has(id)) {
            mapping[slot] = id;
        }
        shortcuts[slot] = canonicalizeHotkey(shortcutRaw[key] || shortcutRaw[slot] || '');
    }
    return { enabled, mapping, shortcuts };
}

function renderSceneHotkeys(profiles, sceneHotkeys) {
    if (!sceneHotkeyEnabledInput) return;
    const cfg = normalizeSceneHotkeys(sceneHotkeys, profiles);
    sceneHotkeyEnabledInput.checked = !!cfg.enabled;
    for (let slot = 1; slot <= 10; slot++) {
        const shortcutInput = sceneHotkeyShortcutInputs[slot - 1];
        const profileSelect = sceneHotkeyProfileSelects[slot - 1];
        if (!shortcutInput || !profileSelect) continue;
        shortcutInput.value = cfg.shortcuts[slot] || '';
        shortcutInput.disabled = !cfg.enabled;
        shortcutInput.onclick = () => beginHotkeyCapture({ kind: 'scene', slot });
        profileSelect.innerHTML = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '选择场景';
        profileSelect.appendChild(noneOpt);
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            profileSelect.appendChild(opt);
        }
        profileSelect.value = cfg.mapping[slot] || '';
        profileSelect.disabled = !cfg.enabled;
    }
}

function persistSceneHotkeys(update) {
    const settings = window.electronAPI.storage.get('settings') || {};
    const profiles = Array.isArray(settings.promptProfiles) && settings.promptProfiles.length > 0
        ? settings.promptProfiles
        : DEFAULT_PROMPT_PROFILES;
    const current = normalizeSceneHotkeys(settings.sceneHotkeys, profiles);
    const next = {
        enabled: typeof update.enabled === 'boolean' ? update.enabled : current.enabled,
        mapping: { ...current.mapping, ...(update.mapping || {}) },
        shortcuts: { ...current.shortcuts, ...(update.shortcuts || {}) }
    };
    window.electronAPI.storage.set('settings', {
        ...settings,
        sceneHotkeys: normalizeSceneHotkeys(next, profiles)
    });
}

function canonicalizeHotkey(value) {
    const parts = String(value || '').split('+').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return '';
    const modifiers = [];
    let key = '';
    for (const part of parts) {
        const upper = part.toUpperCase();
        if (upper === 'CTRL' || upper === 'CONTROL') modifiers.push('Ctrl');
        else if (upper === 'ALT') modifiers.push('Alt');
        else if (upper === 'SHIFT') modifiers.push('Shift');
        else if (upper === 'WIN' || upper === 'META' || upper === 'CMD') modifiers.push('Meta');
        else {
            const normalizedKey = upper.replace(/^D(?=\d$)/, '');
            const aliases = { RETURN: 'Enter', ESCAPE: 'Escape', SPACE: 'Space', PRIOR: 'PageUp', NEXT: 'PageDown' };
            key = aliases[normalizedKey] || (normalizedKey.length === 1
                ? normalizedKey
                : normalizedKey[0] + normalizedKey.slice(1).toLowerCase());
        }
    }
    return [...new Set(modifiers), key].filter(Boolean).join('+');
}

function hotkeyFromKeyboardEvent(event) {
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey) modifiers.push('Meta');
    const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (modifierKeys.has(event.key)) return '';
    let key = event.code || event.key || '';
    key = key.replace(/^Key/, '').replace(/^Digit/, '');
    return canonicalizeHotkey([...modifiers, key].join('+'));
}

function beginHotkeyCapture(target) {
    hotkeyCaptureTarget = target;
    const input = target.kind === 'scene'
        ? sceneHotkeyShortcutInputs[target.slot - 1]
        : textPostProcessHotkeyInput;
    if (input) input.value = '请按下组合键...';
}

function finishHotkeyCapture(hotkey) {
    if (!hotkeyCaptureTarget || !hotkey) return false;
    const target = hotkeyCaptureTarget;
    hotkeyCaptureTarget = null;
    if (target.kind === 'scene') {
        persistSceneHotkeys({ shortcuts: { [target.slot]: hotkey } });
    } else {
        const settings = window.electronAPI.storage.get('settings') || {};
        window.electronAPI.storage.set('settings', { ...settings, textPostProcessHotkey: hotkey });
    }
    loadSettings();
    return true;
}

function handleGlobalHotkey(hotkey) {
    const normalized = canonicalizeHotkey(hotkey);
    if (!normalized) return;
    const settings = window.electronAPI.storage.get('settings') || {};
    const profiles = Array.isArray(settings.promptProfiles) && settings.promptProfiles.length
        ? settings.promptProfiles
        : DEFAULT_PROMPT_PROFILES;
    const cfg = normalizeSceneHotkeys(settings.sceneHotkeys, profiles);
    if (cfg.enabled) {
        for (let slot = 1; slot <= 10; slot++) {
            if (cfg.shortcuts[slot] === normalized && cfg.mapping[slot]) {
                setActivePromptProfile(cfg.mapping[slot]);
                return;
            }
        }
    }
    if (settings.textPostProcessHotkeyEnabled && canonicalizeHotkey(settings.textPostProcessHotkey) === normalized) {
        const enabled = !settings.textPostProcessEnabled;
        window.electronAPI.storage.set('settings', { ...settings, textPostProcessEnabled: enabled });
        if (textPostProcessEnabledInput) textPostProcessEnabledInput.checked = enabled;
    }
}

function setActivePromptProfile(nextId) {
    const settings = window.electronAPI.storage.get('settings') || {};
    const profiles = Array.isArray(settings.promptProfiles) && settings.promptProfiles.length > 0
        ? settings.promptProfiles
        : DEFAULT_PROMPT_PROFILES;
    const profile = profiles.find(p => p.id === nextId);
    if (!profile) return;
    if (promptProfileSelect) {
        promptProfileSelect.value = profile.id;
    }
    if (systemPromptInput) {
        systemPromptInput.value = profile.prompt || '';
    }
    window.electronAPI.storage.set('settings', {
        ...settings,
        promptProfiles: profiles,
        activePromptProfileId: profile.id
    });
}

function switchPromptProfileBySlot(slot) {
    if (!Number.isFinite(slot) || slot < 1 || slot > 10) return;
    const settings = window.electronAPI.storage.get('settings') || {};
    const profiles = Array.isArray(settings.promptProfiles) && settings.promptProfiles.length > 0
        ? settings.promptProfiles
        : DEFAULT_PROMPT_PROFILES;
    const cfg = normalizeSceneHotkeys(settings.sceneHotkeys, profiles);
    if (!cfg.enabled) return;

    const mappedId = cfg.mapping[slot];
    const target = (mappedId && profiles.find(p => p.id === mappedId)) || profiles[slot - 1];
    if (!target) return;
    setActivePromptProfile(target.id);
}

function updateModelVisibility() {
    const sharedAudioConfig = document.getElementById('shared-audio-config');
    if (sharedAudioConfig) sharedAudioConfig.style.display = modelSelect.value === 'shared-audio' ? 'block' : 'none';
    const sharedModelConfig = document.getElementById('shared-model-config');
    if (sharedModelConfig) sharedModelConfig.style.display = modelSelect.value === 'shared-model' ? 'block' : 'none';
    if (modelSelect.value === 'gemini') {
        geminiConfig.style.display = 'block';
        qwenConfig.style.display = 'none';
        siliconflowConfig.style.display = 'none';
        if (openaiCompatibleConfig) openaiCompatibleConfig.style.display = 'none';
    } else if (modelSelect.value === 'qwen') {
        geminiConfig.style.display = 'none';
        qwenConfig.style.display = 'block';
        siliconflowConfig.style.display = 'none';
        if (openaiCompatibleConfig) openaiCompatibleConfig.style.display = 'none';
    } else if (modelSelect.value === 'openai-compatible') {
        geminiConfig.style.display = 'none';
        qwenConfig.style.display = 'none';
        siliconflowConfig.style.display = 'none';
        if (openaiCompatibleConfig) openaiCompatibleConfig.style.display = 'block';
    } else if (modelSelect.value === 'shared-audio' || modelSelect.value === 'shared-model') {
        geminiConfig.style.display = 'none';
        qwenConfig.style.display = 'none';
        siliconflowConfig.style.display = 'none';
        if (openaiCompatibleConfig) openaiCompatibleConfig.style.display = 'none';
    } else {
        geminiConfig.style.display = 'none';
        qwenConfig.style.display = 'none';
        siliconflowConfig.style.display = 'block';
        if (openaiCompatibleConfig) openaiCompatibleConfig.style.display = 'none';
    }
}

function readSharedSelection(select) {
    try { return JSON.parse(select?.value || 'null'); } catch (_) { return null; }
}

async function refreshSharedModels(settings = window.electronAPI.storage.get('settings') || {}) {
    const models = await window.electronAPI.sharedAi.listModels();
    for (const [kind, select, saved] of [
        ['audio', sharedAudioModelSelect, settings.sharedAudioSelection],
        ['text', sharedTextModelSelect, settings.sharedTextSelection],
        ['text', sharedSpeechModelSelect, settings.sharedSpeechSelection]
    ]) {
        if (!select) continue;
        select.replaceChildren();
        const matching = models.filter(item => item.kind === kind);
        if (!matching.length) select.add(new Option(kind === 'audio' ? '无可用共享音频模型' : '无可用共享文本模型', ''));
        for (const item of matching) select.add(new Option(item.label, JSON.stringify({ providerId: item.providerId, modelId: item.modelId })));
        const savedValue = saved ? JSON.stringify(saved) : '';
        if (matching.some(item => item.providerId === saved?.providerId && item.modelId === saved?.modelId)) select.value = savedValue;
        else if (kind === 'text') {
            const preferred = matching.find(item => item.selected);
            if (preferred) select.value = JSON.stringify({ providerId: preferred.providerId, modelId: preferred.modelId });
        }
    }
    // 旧版“共享音频模型”若没有真正可收音频的模型，切到可工作的两步流程。
    if (settings.model === 'shared-audio' && !models.some(item => item.kind === 'audio') && sharedSpeechModelSelect?.value) {
        const next = { ...settings, model: 'shared-model', sharedAsrSource: settings.sharedAsrSource || 'openai-compatible',
            sharedSpeechSelection: readSharedSelection(sharedSpeechModelSelect) };
        window.electronAPI.storage.set('settings', next);
        modelSelect.value = 'shared-model';
        if (sharedAsrSourceSelect) sharedAsrSourceSelect.value = next.sharedAsrSource;
        updateModelVisibility();
        setWorkspaceStatus('已改用现有语音服务转写，再交给共享 AI 模型处理文字。');
    }
}

function updateTextModelSource() {
    const shared = textModelSourceSelect?.value === 'shared';
    const sharedBox = document.getElementById('shared-text-config');
    const localBox = document.getElementById('local-text-config');
    if (sharedBox) sharedBox.style.display = shared ? 'block' : 'none';
    if (localBox) localBox.style.display = shared ? 'none' : 'block';
}

function setupEventListeners() {
    // Settings
    modelSelect.addEventListener('change', updateModelVisibility);
    textModelSourceSelect?.addEventListener('change', updateTextModelSource);
    document.getElementById('shared-audio-refresh')?.addEventListener('click', () => refreshSharedModels().catch(showProcessingError));
    document.getElementById('shared-model-refresh')?.addEventListener('click', () => refreshSharedModels().catch(showProcessingError));
    document.getElementById('shared-text-refresh')?.addEventListener('click', () => refreshSharedModels().catch(showProcessingError));
    document.querySelectorAll('[data-scroll-target]').forEach(button => {
        button.addEventListener('click', () => {
            const target = document.getElementById(button.dataset.scrollTarget);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    setupSecretField(geminiKeyInput, geminiKeyToggleBtn, geminiKeyCopyBtn);
    setupSecretField(qwenKeyInput, qwenKeyToggleBtn, qwenKeyCopyBtn);
    setupSecretField(siliconflowKeyInput, siliconflowKeyToggleBtn, siliconflowKeyCopyBtn);

    if (geminiModelAddBtn) geminiModelAddBtn.addEventListener('click', () => addModelToList('geminiModels'));
    if (qwenModelAddBtn) qwenModelAddBtn.addEventListener('click', () => addModelToList('qwenModels'));
    if (qwenTextModelAddBtn) qwenTextModelAddBtn.addEventListener('click', () => addModelToList('qwenTextModels'));
    if (siliconflowAsrModelAddBtn) siliconflowAsrModelAddBtn.addEventListener('click', () => addModelToList('siliconflowAsrModels'));
    if (siliconflowTextModelAddBtn) siliconflowTextModelAddBtn.addEventListener('click', () => addModelToList('siliconflowTextModels'));
    if (geminiModelDeleteBtn) geminiModelDeleteBtn.addEventListener('click', () => deleteModelFromList('geminiModels'));
    if (qwenModelDeleteBtn) qwenModelDeleteBtn.addEventListener('click', () => deleteModelFromList('qwenModels'));
    if (qwenTextModelDeleteBtn) qwenTextModelDeleteBtn.addEventListener('click', () => deleteModelFromList('qwenTextModels'));
    if (siliconflowAsrModelDeleteBtn) siliconflowAsrModelDeleteBtn.addEventListener('click', () => deleteModelFromList('siliconflowAsrModels'));
    if (siliconflowTextModelDeleteBtn) siliconflowTextModelDeleteBtn.addEventListener('click', () => deleteModelFromList('siliconflowTextModels'));
    if (geminiModelSavedSelect) geminiModelSavedSelect.addEventListener('change', () => chooseModelFromSavedList('geminiModels'));
    if (qwenModelSavedSelect) qwenModelSavedSelect.addEventListener('change', () => chooseModelFromSavedList('qwenModels'));
    if (qwenTextModelSavedSelect) qwenTextModelSavedSelect.addEventListener('change', () => chooseModelFromSavedList('qwenTextModels'));
    if (siliconflowAsrModelSavedSelect) siliconflowAsrModelSavedSelect.addEventListener('change', () => chooseModelFromSavedList('siliconflowAsrModels'));
    if (siliconflowTextModelSavedSelect) siliconflowTextModelSavedSelect.addEventListener('change', () => chooseModelFromSavedList('siliconflowTextModels'));

    if (openaiCompatibleProfileSelect) {
        openaiCompatibleProfileSelect.addEventListener('change', () => {
            const current = persistOpenAICompatibleProfileFromInputs();
            const selectedId = openaiCompatibleProfileSelect.value;
            const selected = current.profiles.find(p => p.id === selectedId) || current.profiles[0];
            window.electronAPI.storage.set('settings', {
                ...(window.electronAPI.storage.get('settings') || {}),
                activeOpenAICompatibleProfileId: selected.id
            });
            renderOpenAICompatibleProfiles(current.profiles, selected.id);
            applyOpenAICompatibleProfileToInputs(selected);
        });
    }
    if (openaiCompatibleNewBtn) {
        openaiCompatibleNewBtn.addEventListener('click', () => {
            const current = persistOpenAICompatibleProfileFromInputs();
            const nextProfile = {
                id: `openai-compatible-${Date.now()}`,
                name: `兼容模型 ${current.profiles.length + 1}`,
                baseUrl: '',
                apiKey: '',
                audioModel: '',
                enablePostProcess: false,
                textModel: ''
            };
            const nextProfiles = [...current.profiles, nextProfile];
            window.electronAPI.storage.set('settings', {
                ...(window.electronAPI.storage.get('settings') || {}),
                openaiCompatibleProfiles: nextProfiles,
                activeOpenAICompatibleProfileId: nextProfile.id
            });
            renderOpenAICompatibleProfiles(nextProfiles, nextProfile.id);
            applyOpenAICompatibleProfileToInputs(nextProfile);
        });
    }
    if (openaiCompatibleDeleteBtn) {
        openaiCompatibleDeleteBtn.addEventListener('click', () => {
            const current = persistOpenAICompatibleProfileFromInputs();
            if (current.profiles.length <= 1) {
                alert('至少保留一个 OpenAI 兼容配置');
                return;
            }
            const nextProfiles = current.profiles.filter(p => p.id !== current.activeId);
            const nextActive = nextProfiles[0];
            window.electronAPI.storage.set('settings', {
                ...(window.electronAPI.storage.get('settings') || {}),
                openaiCompatibleProfiles: nextProfiles,
                activeOpenAICompatibleProfileId: nextActive.id
            });
            renderOpenAICompatibleProfiles(nextProfiles, nextActive.id);
            applyOpenAICompatibleProfileToInputs(nextActive);
        });
    }

    if (qwenEnablePostProcessInput && qwenTextModelInput) {
        qwenEnablePostProcessInput.addEventListener('change', () => {
            qwenTextModelInput.disabled = !qwenEnablePostProcessInput.checked;
        });
    }

    if (sceneHotkeyEnabledInput) {
        sceneHotkeyEnabledInput.addEventListener('change', () => {
            persistSceneHotkeys({ enabled: !!sceneHotkeyEnabledInput.checked });
            const settings = window.electronAPI.storage.get('settings') || {};
            const profiles = Array.isArray(settings.promptProfiles) && settings.promptProfiles.length > 0
                ? settings.promptProfiles
                : DEFAULT_PROMPT_PROFILES;
            renderSceneHotkeys(profiles, settings.sceneHotkeys);
        });
    }

    for (let slot = 1; slot <= 10; slot++) {
        const el = sceneHotkeyProfileSelects[slot - 1];
        if (!el) continue;
        el.addEventListener('change', () => {
            const v = el.value || '';
            persistSceneHotkeys({ mapping: { [slot]: v || undefined } });
        });
    }

    for (let slot = 1; slot <= 10; slot++) {
        const input = sceneHotkeyShortcutInputs[slot - 1];
        if (input) input.addEventListener('click', () => beginHotkeyCapture({ kind: 'scene', slot }));
    }
    if (textPostProcessHotkeyRecordBtn) {
        textPostProcessHotkeyRecordBtn.addEventListener('click', () => beginHotkeyCapture({ kind: 'text-postprocess' }));
    }
    if (textPostProcessHotkeyEnabledInput) {
        textPostProcessHotkeyEnabledInput.addEventListener('change', () => {
            const settings = window.electronAPI.storage.get('settings') || {};
            window.electronAPI.storage.set('settings', {
                ...settings,
                textPostProcessHotkeyEnabled: !!textPostProcessHotkeyEnabledInput.checked
            });
        });
    }

    if (textProviderProfileSelect) {
        textProviderProfileSelect.addEventListener('change', () => {
            const settings = window.electronAPI.storage.get('settings') || {};
            const profiles = normalizeTextProviderProfiles(settings);
            const selected = profiles.find(profile => profile.id === textProviderProfileSelect.value) || profiles[0];
            window.electronAPI.storage.set('settings', {
                ...settings,
                textProviderProfiles: profiles,
                activeTextProviderId: selected.id
            });
            applyTextProviderInputs(selected);
        });
    }
    for (const input of [textProviderNameInput, textProviderUrlInput, textProviderKeyInput, textProviderModelInput]) {
        if (input) input.addEventListener('change', persistTextProviderInputs);
    }
    if (textProviderNewBtn) {
        textProviderNewBtn.addEventListener('click', () => {
            const settings = window.electronAPI.storage.get('settings') || {};
            const profiles = normalizeTextProviderProfiles(settings);
            const next = {
                id: `text-provider-${Date.now()}`,
                name: `文本模型 ${profiles.length + 1}`,
                baseUrl: '', apiKey: '', model: ''
            };
            const nextProfiles = [...profiles, next];
            window.electronAPI.storage.set('settings', {
                ...settings,
                textProviderProfiles: nextProfiles,
                activeTextProviderId: next.id
            });
            renderTextProviderProfiles({ ...settings, textProviderProfiles: nextProfiles, activeTextProviderId: next.id });
        });
    }
    if (textProviderDeleteBtn) {
        textProviderDeleteBtn.addEventListener('click', () => {
            const settings = window.electronAPI.storage.get('settings') || {};
            const profiles = normalizeTextProviderProfiles(settings);
            if (profiles.length <= 1) {
                alert('至少保留一个文本处理模型');
                return;
            }
            const nextProfiles = profiles.filter(profile => profile.id !== textProviderProfileSelect.value);
            const next = nextProfiles[0];
            window.electronAPI.storage.set('settings', {
                ...settings,
                textProviderProfiles: nextProfiles,
                activeTextProviderId: next.id
            });
            renderTextProviderProfiles({ ...settings, textProviderProfiles: nextProfiles, activeTextProviderId: next.id });
        });
    }
    if (textPostProcessEnabledInput) {
        textPostProcessEnabledInput.addEventListener('change', () => {
            const settings = window.electronAPI.storage.get('settings') || {};
            window.electronAPI.storage.set('settings', {
                ...settings,
                textPostProcessEnabled: !!textPostProcessEnabledInput.checked
            });
        });
    }

    document.addEventListener('keydown', (event) => {
        if (!hotkeyCaptureTarget) return;
        event.preventDefault();
        event.stopPropagation();
        finishHotkeyCapture(hotkeyFromKeyboardEvent(event));
    }, true);

    promptProfileSelect.addEventListener('change', () => {
        const settings = window.electronAPI.storage.get('settings') || {};
        const profiles = Array.isArray(settings.promptProfiles) ? settings.promptProfiles : DEFAULT_PROMPT_PROFILES;
        const selectedId = promptProfileSelect.value;
        const profile = profiles.find(p => p.id === selectedId);
        if (profile) {
            systemPromptInput.value = profile.prompt || '';
            window.electronAPI.storage.set('settings', {
                ...settings,
                activePromptProfileId: selectedId
            });
        }
    });

    promptNewBtn.addEventListener('click', () => {
        const name = (promptNewNameInput.value || '').trim();
        if (!name) {
            alert('请输入场景名称');
            return;
        }
        const settings = window.electronAPI.storage.get('settings') || {};
        const profiles = Array.isArray(settings.promptProfiles) ? settings.promptProfiles : DEFAULT_PROMPT_PROFILES;
        const id = `custom-${Date.now()}`;
        const nextProfiles = [...profiles, { id, name, prompt: systemPromptInput.value || '' }];
        const nextSettings = { ...settings, promptProfiles: nextProfiles, activePromptProfileId: id };
        window.electronAPI.storage.set('settings', nextSettings);
        promptNewNameInput.value = '';
        renderPromptProfiles(nextProfiles, id);
        renderSceneHotkeys(nextProfiles, nextSettings.sceneHotkeys);
    });

    promptDeleteBtn.addEventListener('click', () => {
        const settings = window.electronAPI.storage.get('settings') || {};
        const profiles = Array.isArray(settings.promptProfiles) ? settings.promptProfiles : DEFAULT_PROMPT_PROFILES;
        if (profiles.length <= 1) {
            alert('至少保留一个场景');
            return;
        }
        const selectedId = promptProfileSelect.value;
        const nextProfiles = profiles.filter(p => p.id !== selectedId);
        const nextActiveId = nextProfiles[0].id;
        const nextSettings = { ...settings, promptProfiles: nextProfiles, activePromptProfileId: nextActiveId };
        window.electronAPI.storage.set('settings', nextSettings);
        renderPromptProfiles(nextProfiles, nextActiveId);
        renderSceneHotkeys(nextProfiles, nextSettings.sceneHotkeys);
        const active = nextProfiles[0];
        systemPromptInput.value = active.prompt || '';
    });
    
    saveSettingsBtn.addEventListener('click', () => {
        persistOpenAICompatibleProfileFromInputs();
        const textProvider = persistTextProviderInputs();
        const settings = {
            model: modelSelect.value,
            geminiKey: geminiKeyInput.value,
            geminiModel: geminiModelSelect.value,
            qwenKey: qwenKeyInput.value,
            qwenModel: qwenModelVersion.value,
            qwenTextModel: qwenTextModelInput.value,
            qwenEnablePostProcess: qwenEnablePostProcessInput ? !!qwenEnablePostProcessInput.checked : false,
            siliconflowKey: siliconflowKeyInput.value,
            siliconflowAsrModel: (siliconflowAsrModelInput.value || '').trim() || 'TeleAI/TeleSpeechASR',
            textPostProcessEnabled: !!(textPostProcessEnabledInput && textPostProcessEnabledInput.checked),
            textModelSource: textModelSourceSelect?.value || 'local',
            sharedTextSelection: readSharedSelection(sharedTextModelSelect),
            sharedAudioSelection: readSharedSelection(sharedAudioModelSelect),
            sharedSpeechSelection: readSharedSelection(sharedSpeechModelSelect),
            sharedAsrSource: sharedAsrSourceSelect?.value || 'openai-compatible',
            activeTextProviderId: textProvider.id,
            speechGlossaryText: speechGlossaryInput ? speechGlossaryInput.value.trim() : ''
        };

        const prev = window.electronAPI.storage.get('settings') || {};
        const profiles = Array.isArray(prev.promptProfiles) && prev.promptProfiles.length > 0 ? prev.promptProfiles : DEFAULT_PROMPT_PROFILES;
        const activeId = prev.activePromptProfileId || profiles[0].id;
        const nextProfiles = profiles.map(p => p.id === activeId ? { ...p, prompt: systemPromptInput.value || '' } : p);

        window.electronAPI.storage.set('settings', {
            ...prev,
            ...settings,
            promptProfiles: nextProfiles,
            activePromptProfileId: activeId
        });
        
        alert('设置已保存');
    });
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) closeBtn.addEventListener('click', async () => {
        try {
            localStorage.setItem('speech_input_indicator_owner', `closed-${Date.now()}`);
        } catch (_) {
        }
        try {
            await window.electronAPI.window.closeIndicatorWindow();
        } catch (_) {
        }
        await window.electronAPI.window.close();
    });

    document.getElementById('hide-btn').addEventListener('click', () => {
        window.electronAPI.window.hide();
    });
}

function setupSecretField(input, toggleBtn, copyBtn) {
    if (toggleBtn && input) {
        toggleBtn.addEventListener('click', () => {
            input.type = input.type === 'password' ? 'text' : 'password';
        });
    }

    if (copyBtn && input) {
        copyBtn.addEventListener('click', () => {
            const text = (input.value || '').toString();
            if (!text) return;
            try {
                window.electronAPI.action.copy(text);
                const prev = copyBtn.textContent;
                copyBtn.textContent = '✓';
                setTimeout(() => {
                    copyBtn.textContent = prev;
                }, 800);
            } catch (_) {
            }
        });
    }
}

window.addEventListener('beforeunload', () => {
    try {
        stopRecordingTimer();
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            recordingCancelled = true;
            mediaRecorder.stop();
        }
        if (keyboardHookProcess) {
            const hookProcess = keyboardHookProcess;
            keyboardHookProcess = null;
            if (hookProcess.stdin) hookProcess.stdin.end();
            hookProcess.kill();
        }
    } catch (_) {
    }
});

async function insertToExternalApp(text) {
    if (!text) return false;
    try {
        const res = await window.electronAPI.action.insert(text);
        return !!(res && res.success);
    } catch (e) {
        console.warn('插入失败:', e);
        return false;
    }
}

function renderPromptProfiles(profiles, activeId) {
    promptProfileSelect.innerHTML = '';
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activeId) opt.selected = true;
        promptProfileSelect.appendChild(opt);
    }
}

function getActivePrompt() {
    const settings = window.electronAPI.storage.get('settings') || {};
    const profiles = Array.isArray(settings.promptProfiles) && settings.promptProfiles.length > 0
        ? settings.promptProfiles
        : DEFAULT_PROMPT_PROFILES;
    const activeId = settings.activePromptProfileId || profiles[0].id;
    return profiles.find(p => p.id === activeId) || profiles[0];
}

function startRightCtrlHook() {
    if (keyboardHookProcess) return;

    try {
        const { spawn } = require('child_process');
        const { hookOutputSource } = require(require('path').join(
            require('path').dirname(require('url').fileURLToPath(location.href)),
            '../../plugin_runtime/windows-hook-output'));

        const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Windows.Forms;

${hookOutputSource}

public class KeyboardHook {
    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;
    private const int VK_RCONTROL = 0xA3;
    private const int VK_MENU = 0x12;
    private const int VK_CONTROL = 0x11;
    private const int VK_SHIFT = 0x10;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;

    private static LowLevelKeyboardProc _proc = HookCallback;
    private static IntPtr _hookID = IntPtr.Zero;
    private static int _lastHotkeyVk = -1;
    private static int _lastHotkeyTick = 0;

    public static void Start() {
        SanrenjzHookOutput.Start();
        _hookID = SetHook(_proc);
        if (_hookID == IntPtr.Zero) throw new InvalidOperationException("SetWindowsHookEx failed");
        try { Application.Run(); }
        finally { Stop(); }
    }

    public static void Stop() {
        if (_hookID != IntPtr.Zero) {
            UnhookWindowsHookEx(_hookID);
            _hookID = IntPtr.Zero;
        }
        try { Application.ExitThread(); } catch {}
    }

    private static IntPtr SetHook(LowLevelKeyboardProc proc) {
        using (Process curProcess = Process.GetCurrentProcess())
        using (ProcessModule curModule = curProcess.MainModule) {
            return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int msg = wParam.ToInt32();
            if (msg == WM_KEYDOWN || msg == WM_KEYUP || msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP) {
                KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                // 本程序的模拟复制/粘贴不应再次触发语音快捷键。
                if ((kb.flags & 0x10) != 0) return CallNextHookEx(_hookID, nCode, wParam, lParam);
                bool down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                bool modifier = kb.vkCode == VK_MENU || kb.vkCode == VK_CONTROL || kb.vkCode == VK_SHIFT
                    || kb.vkCode == VK_LWIN || kb.vkCode == VK_RWIN || kb.vkCode == VK_RCONTROL;
                if (down && !modifier) {
                    int now = Environment.TickCount;
                    if (kb.vkCode != _lastHotkeyVk || (now - _lastHotkeyTick) > 250) {
                        _lastHotkeyVk = kb.vkCode;
                        _lastHotkeyTick = now;
                        string hotkey = "";
                        if ((GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0) hotkey += "Ctrl+";
                        if ((GetAsyncKeyState(VK_MENU) & 0x8000) != 0) hotkey += "Alt+";
                        if ((GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0) hotkey += "Shift+";
                        if ((GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0) hotkey += "Meta+";
                        hotkey += ((Keys)kb.vkCode).ToString();
                        SanrenjzHookOutput.TryWrite("HOTKEY:" + hotkey);
                    }
                }
                if (kb.vkCode == VK_RCONTROL) {
                    if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                        SanrenjzHookOutput.TryWrite("RCTRL_DOWN");
                    } else {
                        SanrenjzHookOutput.TryWrite("RCTRL_UP");
                    }
                }
            }
        }
        return CallNextHookEx(_hookID, nCode, wParam, lParam);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public int vkCode;
        public int scanCode;
        public int flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}
"@ -ReferencedAssemblies System.Windows.Forms

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[KeyboardHook]::Start()
`;

        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

        const hookProcess = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-EncodedCommand', encoded], {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        keyboardHookProcess = hookProcess;

        hookProcess.stdout.setEncoding('utf8');

        let buf = '';
        hookProcess.stdout.on('data', (chunk) => {
            if (keyboardHookProcess !== hookProcess) return;
            buf += chunk;
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() || '';
            for (const line of lines) {
                const s = (line || '').trim();
                if (!s) continue;
                if (s === 'HOOK_OUTPUT_OVERFLOW') {
                    isRightCtrlDown = false;
                    if (isRecording) workspace.cancel.click();
                    continue;
                }
                if (s === 'RCTRL_DOWN') {
                    onRightCtrlDown();
                } else if (s === 'RCTRL_UP') {
                    onRightCtrlUp();
                } else if (s.startsWith('HOTKEY:')) {
                    handleGlobalHotkey(s.slice('HOTKEY:'.length));
                }
            }
        });

        hookProcess.stderr.setEncoding('utf8');
        hookProcess.stderr.on('data', (chunk) => {
            console.warn('keyboard hook stderr:', chunk);
        });

        hookProcess.on('error', error => {
            console.warn('全局按键监听失败:', error.message);
            if (keyboardHookProcess === hookProcess) keyboardHookProcess = null;
        });
        hookProcess.on('exit', () => {
            if (keyboardHookProcess === hookProcess) {
                keyboardHookProcess = null;
                isRightCtrlDown = false;
                if (isRecording) workspace.cancel.click();
            }
        });
    } catch (e) {
        console.error('startRightCtrlHook failed:', e);
        try { alert('全局按键监听启动失败（可能被系统限制）'); } catch (_) {}
    }
}

function onRightCtrlDown() {
    if (isRightCtrlDown) return;
    isRightCtrlDown = true;
    if (isProcessing) return;
    if (!isRecording) {
        startRecording();
    }
}

function onRightCtrlUp() {
    if (!isRightCtrlDown) return;
    isRightCtrlDown = false;
    if (isRecording) {
        stopRecording();
    }
}

async function startRecording(source = 'hotkey') {
    if (isRecording || isProcessing || isStartingRecording) return;
    isStartingRecording = true;
    updateWorkspaceControls();
    setWorkspaceStatus('正在请求麦克风权限…');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // 权限弹窗期间已松开快捷键时，不能留下无人控制的录音。
        if (source === 'hotkey' && !isRightCtrlDown) {
            stream.getTracks().forEach(track => track.stop());
            setWorkspaceStatus('快捷键已松开，录音未开始。');
            return;
        }
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        recordingCancelled = false;

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop());
            if (recordingCancelled) return;
            const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
            if (!audioBlob.size) {
                setSpeechState('ready');
                setWorkspaceStatus('录音为空，请重新尝试。', 'error');
                return;
            }
            processAudio(audioBlob, { autoInsert: source === 'hotkey' || !!workspace.autoInsert.checked });
        };

        mediaRecorder.start();
        isRecording = true;
        recordingStartedAt = Date.now();
        updateRecordingDuration();
        recordingTimer = setInterval(updateRecordingDuration, 1000);
        updateWorkspaceControls();
        setWorkspaceStatus(source === 'hotkey' ? '正在录音，松开右 Ctrl 结束。' : '正在录音，点击“结束录音”提交。');
        setSpeechState('recording');
    } catch (err) {
        console.error('Error accessing microphone:', err);
        setWorkspaceStatus(`无法访问麦克风：${err.message}`, 'error');
    } finally {
        isStartingRecording = false;
        updateWorkspaceControls();
    }
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        stopRecordingTimer();
        updateWorkspaceControls();
        setSpeechState(recordingCancelled ? 'ready' : 'processing');
        if (!recordingCancelled) setWorkspaceStatus('录音已结束，正在转写…');
    }
}

async function processAudio(blob, { autoInsert = true } = {}) {
    if (isProcessing) return;
    const settings = window.electronAPI.storage.get('settings') || {};
    const model = settings.model || 'gemini';
    const activePrompt = getActivePrompt();
    const prompt = (activePrompt && activePrompt.prompt) ? activePrompt.prompt : 'Convert speech to text.';
    const recognitionPrompt = (settings.textPostProcessEnabled || model === 'shared-model')
        ? '请准确转写音频内容，只输出转写文本，不要润色、翻译或解释。'
        : prompt;

    isProcessing = true;
    updateWorkspaceControls();
    setSpeechState('processing');
    setWorkspaceStatus('正在识别语音…');
    let text = '';
    let postProcessError = null;
    try {
        if (model === 'gemini') {
            text = await callGemini(blob, settings.geminiKey, settings.geminiModel || 'gemini-3-flash-preview', recognitionPrompt);
        } else if (model === 'qwen') {
            text = await callQwenTranscribe(blob, settings.qwenKey, settings.qwenModel, prompt);
        } else if (model === 'shared-model') {
            const selection = settings.sharedSpeechSelection;
            if (!selection?.providerId || !selection?.modelId) throw new Error('请先选择并保存共享 AI 模型');
            const asrSource = settings.sharedAsrSource || 'openai-compatible';
            if (asrSource === 'gemini') text = await callGemini(blob, settings.geminiKey, settings.geminiModel || 'gemini-3-flash-preview', recognitionPrompt);
            else if (asrSource === 'qwen') text = await callQwenTranscribe(blob, settings.qwenKey, settings.qwenModel, recognitionPrompt);
            else if (asrSource === 'siliconflow') text = await callSiliconFlowTranscribe(blob, settings.siliconflowKey, settings.siliconflowAsrModel || 'TeleAI/TeleSpeechASR');
            else if (asrSource === 'openai-compatible') {
                const profile = getActiveOpenAICompatibleProfile(settings);
                text = await callOpenAICompatibleTranscribe(blob, { baseUrl: profile.baseUrl, apiKey: profile.apiKey,
                    model: profile.audioModel, audioFormatMode: profile.audioFormatMode || 'auto', prompt: recognitionPrompt });
            } else throw new Error('无效的语音识别来源');
            if (text) {
                const original = text;
                setWorkspaceStatus('语音已转写，正在使用共享 AI 模型处理文字…');
                try {
                    text = await window.electronAPI.sharedAi.processText({ selection, text, prompt });
                    if (!text) throw new Error('共享模型返回空结果');
                } catch (error) {
                    text = original;
                    postProcessError = error;
                }
            }
        } else if (model === 'shared-audio') {
            const selection = settings.sharedAudioSelection;
            if (!selection?.providerId || !selection?.modelId) throw new Error('请先选择并保存共享音频模型');
            const uploadBlob = /^mimo-v2\.5-asr$/i.test(selection.modelId) ? (await convertBlobToWav16kMono(blob) || blob) : blob;
            text = await window.electronAPI.sharedAi.transcribe({ selection, audioBase64: await blobToBase64(uploadBlob), mimeType: uploadBlob.type || 'audio/webm', prompt: recognitionPrompt });
        } else if (model === 'openai-compatible') {
            const openaiProfile = getActiveOpenAICompatibleProfile(settings);
            text = await callOpenAICompatibleTranscribe(blob, {
                baseUrl: openaiProfile.baseUrl,
                apiKey: openaiProfile.apiKey,
                model: openaiProfile.audioModel,
                audioFormatMode: openaiProfile.audioFormatMode || 'auto',
                prompt: recognitionPrompt
            });
        } else {
            text = await callSiliconFlowTranscribe(blob, settings.siliconflowKey, settings.siliconflowAsrModel || 'TeleAI/TeleSpeechASR');
        }

        if (text && settings.textPostProcessEnabled && model !== 'shared-model') {
            setWorkspaceStatus('语音已识别，正在处理文本…');
            const rawTranscript = text;
            try {
                if (settings.textModelSource === 'shared') {
                    if (!settings.sharedTextSelection?.providerId) throw new Error('请先选择并保存共享文本模型');
                    text = await window.electronAPI.sharedAi.processText({ selection: settings.sharedTextSelection, text, prompt });
                } else {
                    const provider = getActiveTextProvider(settings);
                    text = await callOpenAICompatiblePostProcess(text, { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model, systemPrompt: prompt });
                }
                if (!text) throw new Error('文本模型返回空结果');
            } catch (error) {
                text = rawTranscript;
                postProcessError = error;
            }
        }

        setSpeechState('ready');
        if (text) {
            if (workspaceResult) workspaceResult.value = text;
            updateWorkspaceControls();
            const inserted = autoInsert ? await insertToExternalApp(text) : false;
            if (postProcessError) {
                setWorkspaceStatus(`文本处理失败，已保留原始转写：${postProcessError.message}`, 'error');
            } else if (autoInsert) {
                setWorkspaceStatus(inserted ? '转写完成，已尝试插入。' : '转写完成，自动插入失败；结果已保留。', inserted ? 'info' : 'error');
            } else {
                setWorkspaceStatus('转写完成，可校对、复制或插入。');
            }
        } else {
            setWorkspaceStatus('未识别到文字，请检查音频内容。', 'error');
        }
    } catch (error) {
        console.error('API Error:', error);
        setSpeechState('ready');
        setWorkspaceStatus(`语音处理失败：${error.message || error}`, 'error');
        showProcessingError(error);
    } finally {
        isProcessing = false;
        updateWorkspaceControls();
    }
}

function showProcessingError(error) {
    const message = error && error.message ? error.message : String(error || '未知错误');
    try {
        alert(`语音处理失败：${message}`);
    } catch (_) {
    }
}

function writeWavHeader(view, opts) {
    const { numChannels, sampleRate, dataByteLength } = opts;
    function writeString(offset, str) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    const blockAlign = numChannels * 2;
    const byteRate = sampleRate * blockAlign;
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataByteLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataByteLength, true);
}

function audioBufferToWavBlob(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numSamples = audioBuffer.length;
    const dataByteLength = numSamples * numChannels * 2;
    const buffer = new ArrayBuffer(44 + dataByteLength);
    const view = new DataView(buffer);
    writeWavHeader(view, { numChannels, sampleRate, dataByteLength });

    const channels = [];
    for (let c = 0; c < numChannels; c++) {
        channels.push(audioBuffer.getChannelData(c));
    }

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        for (let c = 0; c < numChannels; c++) {
            let s = channels[c][i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

async function convertBlobToWavIfPossible(blob) {
    if (!blob) return null;
    const type = (blob.type || '').toLowerCase();
    if (!type.includes('webm') && !type.includes('ogg') && !type.includes('mp4')) return null;

    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        try {
            await ctx.close();
        } catch (_) {
        }
        return audioBufferToWavBlob(audioBuffer);
    } catch (_) {
        return null;
    }
}

async function convertBlobToWav16kMono(blob) {
    if (!blob) return null;
    try {
        const arrayBuffer = await blob.arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
        try {
            await ctx.close();
        } catch (_) {
        }

        const srcChannels = audioBuffer.numberOfChannels;
        const srcLength = audioBuffer.length;
        const srcSampleRate = audioBuffer.sampleRate;

        const mono = new OfflineAudioContext(1, srcLength, srcSampleRate).createBuffer(1, srcLength, srcSampleRate);
        const monoData = mono.getChannelData(0);
        for (let c = 0; c < srcChannels; c++) {
            const ch = audioBuffer.getChannelData(c);
            for (let i = 0; i < srcLength; i++) {
                monoData[i] += ch[i] / srcChannels;
            }
        }

        const targetSampleRate = 16000;
        const targetLength = Math.max(1, Math.ceil((srcLength / srcSampleRate) * targetSampleRate));
        const offline = new OfflineAudioContext(1, targetLength, targetSampleRate);
        const source = offline.createBufferSource();
        source.buffer = mono;
        source.connect(offline.destination);
        source.start(0);
        const rendered = await offline.startRendering();

        return audioBufferToWavBlob(rendered);
    } catch (_) {
        return null;
    }
}

// --- API Implementations ---

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64String = reader.result.split(',')[1];
            resolve(base64String);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function callGemini(blob, apiKey, model, prompt) {
    if (!apiKey) throw new Error('Gemini API Key 未配置');

    const base64Audio = await blobToBase64(blob);

    // 说明：不同账号/区域可用模型不同，因此增加模型选择并做回退。
    const preferredModel = model || 'gemini-3-flash-preview';
    const modelFallbacks = [
        preferredModel,
        'gemini-3-flash-preview',
        'gemini-2.5-flash',
        'gemini-2.5-pro'
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);
    
    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                {
                    inline_data: {
                        mime_type: "audio/webm",
                        data: base64Audio
                    }
                }
            ]
        }]
    };

    let lastErr = null;
    for (const m of modelFallbacks) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${apiKey}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (!response.ok) {
                const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`;
                throw new Error(msg);
            }

            if (data.error) {
                throw new Error(data.error.message);
            }

            if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts) {
                const out = data.candidates[0].content.parts[0].text;
                return (out || '').trim();
            }
            throw new Error('Gemini 未返回可用内容');
        } catch (e) {
            lastErr = e;
            const msg = String(e && e.message ? e.message : e);
            const isModelNotFound = msg.includes('is not found') || msg.includes('not supported') || msg.includes('models/');
            if (!isModelNotFound) {
                break;
            }
        }
    }

    throw lastErr || new Error('Gemini 调用失败');
}

async function callQwenTranscribe(blob, apiKey, model, prompt) {
    if (!apiKey) throw new Error('Qwen API Key 未配置');

    if (!window.electronAPI || !window.electronAPI.qwen || typeof window.electronAPI.qwen.asrTranscribe !== 'function') {
        throw new Error('Qwen 初始化失败：缺少 qwen.asrTranscribe');
    }

    let uploadBlob = blob;
    let filename = 'recording.webm';
    const wav16k = await convertBlobToWav16kMono(blob);
    if (wav16k) {
        uploadBlob = wav16k;
        filename = 'recording.wav';
    } else {
        const wav = await convertBlobToWavIfPossible(blob);
        if (wav) {
            uploadBlob = wav;
            filename = 'recording.wav';
        }
    }

    const mimeType = (uploadBlob && uploadBlob.type) ? uploadBlob.type : (filename.endsWith('.wav') ? 'audio/wav' : 'audio/webm');
    const base64Audio = await blobToBase64(uploadBlob);

    const out = await window.electronAPI.qwen.asrTranscribe({
        apiKey,
        model: model || 'qwen3-asr-flash',
        audioBase64: base64Audio,
        mimeType
    });

    return (out || '').trim();
}

async function callQwenPostProcess(text, apiKey, model, systemPrompt) {
    const inputText = (text || '').trim();
    if (!inputText) return '';
    if (!apiKey) throw new Error('Qwen API Key 未配置');

    if (!window.electronAPI || !window.electronAPI.qwen || typeof window.electronAPI.qwen.textGenerate !== 'function') {
        throw new Error('Qwen 初始化失败：缺少 qwen.textGenerate');
    }

    const out = await window.electronAPI.qwen.textGenerate({
        apiKey,
        model: model || 'qwen-plus',
        systemPrompt,
        userText: inputText
    });
    return (out || inputText).trim();
}

async function callSiliconFlowTranscribe(blob, apiKey, model) {
    if (!apiKey) throw new Error('硅基流动 API Key 未配置');

    if (!window.electronAPI || !window.electronAPI.siliconflow || typeof window.electronAPI.siliconflow.transcribe !== 'function') {
        throw new Error('硅基流动初始化失败：缺少 siliconflow.transcribe');
    }

    let uploadBlob = blob;
    const wav16k = await convertBlobToWav16kMono(blob);
    if (wav16k) {
        uploadBlob = wav16k;
    } else {
        const wav = await convertBlobToWavIfPossible(blob);
        if (wav) {
            uploadBlob = wav;
        }
    }

    const mimeType = (uploadBlob && uploadBlob.type) ? uploadBlob.type : 'audio/wav';
    const base64Audio = await blobToBase64(uploadBlob);

    const out = await window.electronAPI.siliconflow.transcribe({
        apiKey,
        model: model || 'TeleAI/TeleSpeechASR',
        audioBase64: base64Audio,
        mimeType
    });
    return (out || '').trim();
}

async function callOpenAICompatibleTranscribe(blob, options) {
    const { baseUrl, apiKey, model, audioFormatMode, prompt } = options || {};
    if (!baseUrl) throw new Error('OpenAI 兼容 API URL 未配置');
    if (!apiKey) throw new Error('OpenAI 兼容 API Key 未配置');
    if (!model) throw new Error('OpenAI 兼容语音/多模态模型未配置');

    if (!window.electronAPI || !window.electronAPI.openaiCompatible || typeof window.electronAPI.openaiCompatible.transcribe !== 'function') {
        throw new Error('OpenAI 兼容接口初始化失败：缺少 openaiCompatible.transcribe');
    }

    let uploadBlob = blob;
    if (!uploadBlob || !uploadBlob.size) throw new Error('录音数据为空');
    const formatMode = normalizeAudioFormatMode(audioFormatMode);
    const shouldConvertToWav = formatMode === 'wav' || (formatMode === 'auto' && shouldAutoConvertAudioToWav(baseUrl, model));
    if (shouldConvertToWav) {
        const wav16k = await convertBlobToWav16kMono(blob);
        if (wav16k) {
            uploadBlob = wav16k;
        } else {
            const wav = await convertBlobToWavIfPossible(blob);
            if (wav) uploadBlob = wav;
        }
    }
    const mimeType = (uploadBlob && uploadBlob.type) ? uploadBlob.type : 'audio/wav';
    if (isXiaomiMimoAsrConfig(baseUrl, model) && !/^audio\/(wav|mp3|mpeg)$/i.test(mimeType)) {
        throw new Error(`小米 MiMo ASR 只支持 audio/wav、audio/mp3、audio/mpeg。当前录音格式为 ${mimeType}。请将该配置的音频格式策略设为“自动兼容”或“转换为 WAV”。`);
    }
    const base64Audio = await blobToBase64(uploadBlob);

    const out = await window.electronAPI.openaiCompatible.transcribe({
        baseUrl,
        apiKey,
        model,
        audioBase64: base64Audio,
        mimeType,
        prompt
    });
    return (out || '').trim();
}

function normalizeAudioFormatMode(mode) {
    const v = String(mode || 'auto').trim().toLowerCase();
    return ['auto', 'original', 'wav'].includes(v) ? v : 'auto';
}

function shouldAutoConvertAudioToWav(baseUrl, model) {
    return isXiaomiMimoAsrConfig(baseUrl, model);
}

function isXiaomiMimoAsrConfig(baseUrl, model) {
    return /^mimo-v2\.5-asr$/i.test(String(model || '').trim());
}

async function callOpenAICompatiblePostProcess(text, options) {
    const inputText = (text || '').trim();
    if (!inputText) return '';

    const { baseUrl, apiKey, model, systemPrompt } = options || {};
    if (!baseUrl) throw new Error('OpenAI 兼容 API URL 未配置');
    if (!apiKey) throw new Error('OpenAI 兼容 API Key 未配置');
    if (!model) throw new Error('OpenAI 兼容文本处理模型未配置');

    if (!window.electronAPI || !window.electronAPI.openaiCompatible || typeof window.electronAPI.openaiCompatible.textGenerate !== 'function') {
        throw new Error('OpenAI 兼容接口初始化失败：缺少 openaiCompatible.textGenerate');
    }

    const out = await window.electronAPI.openaiCompatible.textGenerate({
        baseUrl,
        apiKey,
        model,
        systemPrompt,
        userText: inputText
    });
    return (out || inputText).trim();
}

// Start
if (VIEW === 'indicator') {
    initIndicatorView();
} else {
    initSettingsView();
}

// ─────────────────────────────────────────────────────────────────────────────
// LAN Sync UI
// ─────────────────────────────────────────────────────────────────────────────

let _lanRunning = false;

function initLanUI() {
    const toggleBtn      = document.getElementById('lan-toggle-btn');
    const statusBadge    = document.getElementById('lan-status-badge');
    const ipsDiv         = document.getElementById('lan-ips');
    const clipSyncCheck  = document.getElementById('lan-clip-sync');
    const pushImageBtn   = document.getElementById('lan-push-image-btn');
    const sendFileBtn    = document.getElementById('lan-send-file-btn');
    const fileInput      = document.getElementById('lan-file-input');
    const incomingDirInput = document.getElementById('lan-incoming-dir');
    const incomingDirBtn = document.getElementById('lan-incoming-dir-btn');
    const noteDirInput = document.getElementById('lan-note-dir');
    const noteDirBtn = document.getElementById('lan-note-dir-btn');
    const logDiv         = document.getElementById('lan-log');

    if (!toggleBtn) return;

    const api = window.electronAPI && window.electronAPI.lan;
    if (!api) {
        statusBadge.textContent = '不支持（需重启插件）';
        return;
    }

    // Restore saved clip-sync preference
    const settings = window.electronAPI.storage.get('settings') || {};
    const defaultDir = window.electronAPI.dialog && window.electronAPI.dialog.defaultDownloadDir
        ? window.electronAPI.dialog.defaultDownloadDir() : '';
    if (incomingDirInput) incomingDirInput.value = settings.lanIncomingDir || defaultDir;
    if (noteDirInput) noteDirInput.value = settings.lanNoteDir || defaultDir;
    // 局域网同步是常驻能力：首次使用默认开启，只有用户明确关闭时才停用。
    clipSyncCheck.checked = settings.lanClipSync !== false;

    function appendLog(msg) {
        logDiv.style.display = 'block';
        const ts = new Date().toLocaleTimeString();
        logDiv.textContent += `[${ts}] ${msg}\n`;
        logDiv.scrollTop = logDiv.scrollHeight;
    }

    function updateBadge() {
        const st = api.getStatus();
        if (!st.wsRunning) {
            statusBadge.textContent = '未运行';
            statusBadge.style.background = '#f0f0f0';
            statusBadge.style.color = '#555';
            ipsDiv.style.display = 'none';
            toggleBtn.textContent = '启动局域网服务';
            _lanRunning = false;
        } else {
            const connected = st.clients > 0;
            statusBadge.textContent = connected ? `已连接 ${st.clients} 台设备` : '等待设备连接…';
            statusBadge.style.background = connected ? '#e8f5e9' : '#fff3e0';
            statusBadge.style.color = connected ? '#2e7d32' : '#e65100';
            ipsDiv.style.display = 'block';
            ipsDiv.textContent = `本机IP：${st.localIps.join(' / ')}  WS端口：9527  HTTP端口：9529`;
            toggleBtn.textContent = '停止局域网服务';
            _lanRunning = true;
        }
    }

    // Register event callback
    api.onEvent((type, data) => {
        const msgs = {
            client_connected:    `📱 设备已连接 (${(data && data.address) || '?'})`,
            client_disconnected: '📱 设备已断开',
            clipboard_received:  `📋 收到剪贴板：${(data && data.text) || ''}…`,
            clipboard_sent:      `📤 已推送剪贴板：${(data && data.text) || ''}…`,
            file_received:       `📥 收到文件：${(data && data.filename) || '?'} (${data && data.size ? (data.size / 1024).toFixed(1) + ' KB' : '?'}) → ${(data && data.savePath) || ''}`
            ,note_received:      `📝 随记已保存：${(data && data.savePath) || ''}`
            ,config_synced:      '⚙️ 已向手机发送完整配置'
            ,save_error:         `❌ 保存失败：${(data && data.message) || '未知错误'}`
        };
        appendLog(msgs[type] || `${type}: ${JSON.stringify(data)}`);
        updateBadge();
    });

    toggleBtn.addEventListener('click', () => {
        const current = window.electronAPI.storage.get('settings') || {};
        if (!_lanRunning) {
            const ips = api.start();
            api.setClipboardSync(clipSyncCheck.checked);
            window.electronAPI.storage.set('settings', { ...current, lanAutoStart: true });
            appendLog(`✅ 服务已启动，本机IP：${ips.join(', ')}`);
        } else {
            api.stop();
            window.electronAPI.storage.set('settings', { ...current, lanAutoStart: false });
            appendLog('🛑 服务已停止');
        }
        updateBadge();
    });

    clipSyncCheck.addEventListener('change', () => {
        if (api) api.setClipboardSync(clipSyncCheck.checked);
        const s = window.electronAPI.storage.get('settings') || {};
        window.electronAPI.storage.set('settings', { ...s, lanClipSync: clipSyncCheck.checked });
    });

    pushImageBtn.addEventListener('click', () => {
        if (!_lanRunning) { alert('请先启动局域网服务'); return; }
        const ok = api.pushClipboardImage();
        if (ok) appendLog('🖼️ 已推送剪贴板图片');
        else alert('剪贴板中没有图片');
    });

    sendFileBtn.addEventListener('click', () => {
        if (!_lanRunning) { alert('请先启动局域网服务'); return; }
        fileInput.click();
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const url = api.queueFileForDownload(file.path);
        appendLog(`📤 文件已推送，等待手机下载：${file.name}  URL: ${url}`);
        fileInput.value = '';
    });

    const chooseAndSaveDirectory = (key, input) => {
        if (!window.electronAPI.dialog || !window.electronAPI.dialog.chooseDirectory) return;
        const selected = window.electronAPI.dialog.chooseDirectory(input.value || defaultDir);
        if (!selected) return;
        const current = window.electronAPI.storage.get('settings') || {};
        window.electronAPI.storage.set('settings', { ...current, [key]: selected });
        input.value = selected;
    };
    if (incomingDirBtn && incomingDirInput) {
        incomingDirBtn.addEventListener('click', () => chooseAndSaveDirectory('lanIncomingDir', incomingDirInput));
    }
    if (noteDirBtn && noteDirInput) {
        noteDirBtn.addEventListener('click', () => chooseAndSaveDirectory('lanNoteDir', noteDirInput));
    }

    // 插件窗口可能长期隐藏运行，不能要求用户每次打开设置后再手动启动服务。
    if (settings.lanAutoStart !== false) {
        const ips = api.start();
        api.setClipboardSync(clipSyncCheck.checked);
        appendLog(`✅ 局域网服务已自动启动，本机IP：${ips.join(', ')}`);
    }
    updateBadge();
}

// Run LAN UI init when settings view is ready
if (VIEW !== 'indicator') {
    // Use a short delay to ensure DOM is fully set up
    setTimeout(initLanUI, 100);
}
