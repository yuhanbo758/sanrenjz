(function (global) {
  const STYLE_ID = 'ai-provider-manager-style';
  let pickerCounter = 0;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .ai-model-picker{display:flex;align-items:center;gap:7px;white-space:nowrap}
      .ai-model-picker select[hidden]{display:none}
      .ai-model-picker-native{width:100%;min-width:0}.ai-model-picker-native .ai-model-trigger{width:100%;min-width:0}
      .ai-model-trigger{width:min(230px,25vw);min-width:150px;display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--bd,#dbe2ea);border-radius:8px;background:var(--sf,#fff);color:var(--ink,#172033);padding:7px 10px;font:12px var(--sans,-apple-system,"Segoe UI",sans-serif);cursor:pointer}
      .ai-model-trigger:focus-visible{outline:2px solid var(--al,#8b5cf6);outline-offset:2px}
      .ai-model-trigger:disabled{opacity:.65;cursor:default}.ai-model-trigger-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ai-model-popup{position:fixed;z-index:9999;display:flex;flex-direction:column;border:1px solid var(--bd,#dbe2ea);border-radius:10px;background:var(--sf,#fff);color:var(--ink,#172033);box-shadow:0 8px 28px #0003;padding:8px;box-sizing:border-box;font:12px var(--sans,-apple-system,"Segoe UI",sans-serif)}
      .ai-model-popup[hidden]{display:none}.ai-model-search{width:100%;min-height:34px;box-sizing:border-box;border:1px solid var(--bd,#dbe2ea);border-radius:7px;background:var(--s2,#f7f8fa);color:inherit;padding:7px 9px;font:inherit}
      .ai-model-search:focus{outline:2px solid var(--al,#8b5cf6);outline-offset:-1px}.ai-model-results{overflow:auto;min-height:0;margin-top:5px;overscroll-behavior:contain}
      .ai-model-group{padding:6px;color:var(--mt,#667085);font-size:11px;font-weight:600}.ai-model-option{padding:8px;border-radius:6px;cursor:pointer;overflow-wrap:anywhere}
      .ai-model-option.active{background:var(--s2,#f0f2f5)}.ai-model-option[aria-selected="true"]{color:var(--a,#4f46e5);font-weight:600}
      .ai-model-option small{display:block;color:var(--mt,#667085);font:10px/1.5 var(--mono,Consolas,monospace);font-weight:400}.ai-model-search-status{padding:6px;color:var(--mt,#667085);font-size:11px}
      .ai-provider-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding-right:28px}
      .ai-provider-head h2{margin:0!important}
      .ai-provider-head-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .ai-provider-add,.ai-provider-import,.ai-provider-save,.ai-provider-secondary{border:1px solid var(--bd,#dbe2ea);border-radius:8px;background:var(--sf,#fff);color:var(--ink,#172033);padding:8px 13px;font:12px var(--sans,-apple-system,"Segoe UI",sans-serif);cursor:pointer}
      .ai-provider-add,.ai-provider-save{background:var(--a,#4f46e5);border-color:var(--a,#4f46e5);color:#fff;font-weight:600}
      .ai-provider-import{color:var(--a,#4f46e5);font-weight:600}
      .ai-provider-list{display:flex;flex-direction:column;gap:9px;margin-bottom:18px}
      .ai-provider-card{border:1px solid var(--bd,#dbe2ea);border-radius:10px;padding:11px 12px;background:var(--s2,#f7f8fa)}
      .ai-provider-card-top{display:flex;align-items:flex-start;gap:9px}
      .ai-provider-card-main{min-width:0;flex:1}
      .ai-provider-card-name{font-weight:700;color:var(--ink,#172033)}
      .ai-provider-card-url{font:10px/1.5 var(--mono,Consolas,monospace);color:var(--mt,#667085);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ai-provider-status{font-size:10px;color:#16a34a;white-space:nowrap}
      .ai-provider-status.missing{color:#d97706}
      .ai-provider-models{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
      .ai-provider-model{border-radius:999px;padding:3px 8px;background:color-mix(in srgb,var(--a,#4f46e5) 10%,transparent);color:var(--a,#4f46e5);font:10px var(--mono,Consolas,monospace)}
      .ai-provider-actions{display:flex;gap:5px;margin-top:9px}
      .ai-provider-actions button{border:0;background:transparent;color:var(--a,#4f46e5);font-size:11px;cursor:pointer;padding:2px 0;margin-right:8px}
      .ai-provider-actions button.danger{color:#dc2626}
      .ai-provider-form{border-top:1px solid var(--bd,#dbe2ea);padding-top:16px}
      .ai-provider-form h3{margin:0 0 12px;font-size:14px}
      .ai-provider-field{margin-bottom:12px}
      .ai-provider-field label{display:block;margin-bottom:5px;font-size:11px;font-weight:600;color:var(--mt,#667085)}
      .ai-provider-field input,.ai-provider-field textarea,.ai-provider-field select{width:100%;border:1px solid var(--bd,#dbe2ea);border-radius:8px;background:var(--s2,#f7f8fa);color:var(--ink,#172033);padding:8px 10px;font:12px var(--sans,-apple-system,"Segoe UI",sans-serif);outline:none;resize:vertical}
      .ai-provider-field textarea{min-height:86px;font-family:var(--mono,Consolas,monospace);line-height:1.6}
      .ai-provider-field input:focus,.ai-provider-field textarea:focus,.ai-provider-field select:focus{border-color:var(--al,#8b5cf6)}
      .ai-provider-help{font-size:10px;color:var(--mt,#667085);margin-top:4px;line-height:1.5}
      .ai-provider-form-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .ai-provider-empty{padding:16px;text-align:center;color:var(--mt,#667085);font-size:12px;border:1px dashed var(--bd,#dbe2ea);border-radius:9px}
      @media(max-width:1000px){.ai-model-picker label{display:none}.ai-model-trigger{width:170px;min-width:120px}}
    `;
    document.head.appendChild(style);
  }

  function providerId() {
    return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  const API_STYLES = ['openai', 'anthropic', 'responses'];

  const PRESET_PROVIDERS = [
    {
      name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
      models: [
        { id: 'gpt-4o', label: 'GPT-4o', capabilities: ['text', 'vision'] },
        { id: 'gpt-4o-mini', label: 'GPT-4o mini', capabilities: ['text', 'vision'] },
        { id: 'gpt-4.1', label: 'GPT-4.1', capabilities: ['text', 'vision'] },
        { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', capabilities: ['text', 'vision'] },
        { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', capabilities: ['text'] },
        { id: 'o3', label: 'o3', capabilities: ['text'] },
        { id: 'o4-mini', label: 'o4-mini', capabilities: ['text', 'vision'] }
      ]
    },
    {
      name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat', capabilities: ['text'] },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', capabilities: ['text'] }
      ]
    },
    {
      name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [
        { id: 'glm-4-flash', label: 'GLM-4 Flash', capabilities: ['text'] },
        { id: 'glm-4-air', label: 'GLM-4 Air', capabilities: ['text'] },
        { id: 'glm-4-plus', label: 'GLM-4 Plus', capabilities: ['text'] },
        { id: 'glm-4.5', label: 'GLM-4.5', capabilities: ['text'] },
        { id: 'glm-4v-flash', label: 'GLM-4V Flash', capabilities: ['text', 'vision'] },
        { id: 'glm-4v-plus', label: 'GLM-4V Plus', capabilities: ['text', 'vision'] }
      ]
    },
    {
      name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1',
      models: [
        { id: 'kimi-latest', label: 'Kimi Latest', capabilities: ['text'] },
        { id: 'moonshot-v1-8k', label: 'Moonshot v1 8K', capabilities: ['text'] },
        { id: 'moonshot-v1-32k', label: 'Moonshot v1 32K', capabilities: ['text'] },
        { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K', capabilities: ['text'] },
        { id: 'moonshot-v1-8k-vision-preview', label: 'Moonshot v1 Vision', capabilities: ['text', 'vision'] }
      ]
    },
    {
      name: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [
        { id: 'qwen-turbo', label: 'Qwen Turbo', capabilities: ['text'] },
        { id: 'qwen-plus', label: 'Qwen Plus', capabilities: ['text'] },
        { id: 'qwen-max', label: 'Qwen Max', capabilities: ['text'] },
        { id: 'qwen-long', label: 'Qwen Long', capabilities: ['text'] },
        { id: 'qwen-vl-plus', label: 'Qwen VL Plus', capabilities: ['text', 'vision'] },
        { id: 'qwen-vl-max', label: 'Qwen VL Max', capabilities: ['text', 'vision'] }
      ]
    },
    {
      name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1',
      models: [
        { id: 'MiniMax-Text-01', label: 'MiniMax Text 01', capabilities: ['text'] },
        { id: 'abab6.5s-chat', label: 'ABAB 6.5s', capabilities: ['text'] },
        { id: 'MiniMax-M3', label: 'MiniMax M3 视觉', capabilities: ['text', 'vision'] }
      ]
    },
    {
      name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1',
      models: [
        { id: 'grok-4.5', label: 'Grok 4.5', capabilities: ['text'], api: 'responses' },
        { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', capabilities: ['text'], api: 'responses' },
        { id: 'glm-5.3', label: 'GLM-5.3', capabilities: ['text'] },
        { id: 'glm-5.2', label: 'GLM-5.2', capabilities: ['text'] },
        { id: 'glm-5.1', label: 'GLM-5.1', capabilities: ['text'] },
        { id: 'kimi-k3', label: 'Kimi K3', capabilities: ['text'] },
        { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', capabilities: ['text'] },
        { id: 'kimi-k2.6', label: 'Kimi K2.6', capabilities: ['text'] },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', capabilities: ['text'] },
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', capabilities: ['text'] },
        { id: 'mimo-v2.5', label: 'MiMo-V2.5', capabilities: ['text'] },
        { id: 'mimo-v2.5-pro', label: 'MiMo-V2.5-Pro', capabilities: ['text'] },
        { id: 'minimax-m3', label: 'MiniMax M3', capabilities: ['text'], api: 'anthropic' },
        { id: 'minimax-m2.7', label: 'MiniMax M2.7', capabilities: ['text'], api: 'anthropic' },
        { id: 'qwen3.8-max', label: 'Qwen3.8 Max', capabilities: ['text'], api: 'anthropic' },
        { id: 'qwen3.7-max', label: 'Qwen3.7 Max', capabilities: ['text'], api: 'anthropic' },
        { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', capabilities: ['text'], api: 'anthropic' },
       { id: 'qwen3.6-plus', label: 'Qwen3.6 Plus', capabilities: ['text'], api: 'anthropic' },
        { id: 'hy3', label: 'Hy3', capabilities: ['text'] }
     ]
    },
    {
      name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1',
      models: [
        { id: 'mimo-v2.5', label: 'MiMo V2.5 多模态', capabilities: ['text', 'vision', 'audio'] },
        { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', capabilities: ['text'] }
      ]
    },
    {
      name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
      models: [
        { id: 'Qwen/Qwen2.5-VL-72B-Instruct', label: 'Qwen2.5 VL 72B', capabilities: ['text', 'vision'] },
        { id: 'Qwen/Qwen2-VL-72B-Instruct', label: 'Qwen2 VL 72B', capabilities: ['text', 'vision'] },
        { id: 'OpenGVLab/InternVL2-Llama3-76B', label: 'InternVL2 76B', capabilities: ['text', 'vision'] },
        { id: 'OpenGVLab/InternVL2_5-78B', label: 'InternVL2.5 78B', capabilities: ['text', 'vision'] },
        { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3', capabilities: ['text'] },
        { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1', capabilities: ['text'] }
      ]
    }
  ];

  function parseModels(text) {
    return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const [id, label, capabilityText, apiText] = line.split('|').map(value => value.trim());
      const capabilities = (capabilityText || 'text').split(',').map(value => value.trim()).filter(value => value === 'text' || value === 'vision' || value === 'audio');
      const model = { id, label: label || id, capabilities: capabilities.length ? [...new Set(capabilities)] : ['text'] };
      if (apiText && API_STYLES.includes(apiText)) model.api = apiText;
      return model;
    }).filter(model => model.id);
  }

  function serializeModels(models) {
    return sortModels(models).map(model => {
      const line = `${model.id} | ${model.label || model.id} | ${(model.capabilities || ['text']).join(',')}`;
      return model.api && API_STYLES.includes(model.api) ? `${line} | ${model.api}` : line;
    }).join('\n');
  }

  function sortModels(models) {
    const compare = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { sensitivity: 'base', numeric: true });
    return [...(models || [])].sort((a, b) => compare(a.label || a.id || a.value, b.label || b.id || b.value)
      || compare(a.id || a.value, b.id || b.value));
  }

  function mergeCatalogModels(existing, fetched) {
    const saved = new Map((existing || []).map(model => [model.id, model]));
    return (fetched || []).map(model => saved.has(model.id) ? { ...model, ...saved.get(model.id) } : model);
  }

  function filterModelEntries(entries, query) {
    const words = [...new Set(String(query || '').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean))];
    return entries.filter(entry => {
      const text = `${entry.label} ${entry.modelId} ${entry.providerName} ${entry.providerId}`.toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
  }

  function isOpenCodeProvider(provider) {
    return provider?.transport === 'opencode'
      || provider?.source === 'opencode'
      || /^opencode:\/\//i.test(String(provider?.baseUrl || '').trim());
  }

  function mergeOpenCodeProviders(existing, imported) {
    const manual = (existing || []).filter(provider => !isOpenCodeProvider(provider));
    const managed = (imported || []).map(provider => ({
      ...provider,
      id: `opencode:${provider.id}`,
      sourceProviderId: provider.id,
      source: 'opencode',
      transport: 'opencode',
      managed: true,
      models: sortModels(provider.models).map(model => ({ ...model, sourceModelId: model.id }))
    }));
    return { providers: [...manual, ...managed], managed };
  }

  function create(api, options = {}) {
    injectStyles();
    const capability = options.capability === 'vision' ? 'vision' : 'text';
    const drawer = document.querySelector(options.drawer || '#drawer');
    const overlay = document.querySelector(options.overlay || '#overlay');
    const before = options.beforeElement || document.querySelector(options.before || '.gear');
    let config = null;
    let selection = null;
    let editingId = '';
    let modelSelect = null;
    let editRevision = 0;
    let pickerEntries = [], filteredEntries = [], activeIndex = -1;
    let pickerTrigger, pickerLabel, pickerPopup, pickerSearch, pickerResults, pickerStatus;
    let selectingModel = false, composingSearch = false;

    const notify = message => {
      if (typeof options.notify === 'function') options.notify(message);
      else if (typeof global.toast === 'function') global.toast(message);
    };

    function closeDrawer() {
      drawer?.classList.remove('open');
      overlay?.classList.remove('show');
    }

    function renderShell() {
      if (!drawer) return;
      drawer.innerHTML = `
        <button class="close" type="button" data-ai-close>×</button>
        <div class="ai-provider-head"><h2>供应商目录</h2><div class="ai-provider-head-actions"><button class="ai-provider-import" type="button" data-ai-opencode>导入 OpenCode</button><button class="ai-provider-add" type="button" data-ai-add>新增供应商</button></div></div>
        <div class="ai-provider-list" data-ai-list></div>
        <form class="ai-provider-form" data-ai-form>
          <h3 data-ai-form-title>新增供应商</h3>
          <div class="ai-provider-field"><label>预设供应商</label><select data-ai-preset><option value="">自定义（手动填写）</option>${PRESET_PROVIDERS.map((preset, index) => `<option value="${index}">${preset.name}</option>`).join('')}</select><div class="ai-provider-help">选择预设供应商会自动填充 Base URL 与模型列表，只需填写 API Key。</div></div>
          <div class="ai-provider-field"><label>供应商名称</label><input data-ai-name placeholder="例如 GLM、DeepSeek"></div>
          <div class="ai-provider-field"><label>Base URL</label><input data-ai-url placeholder="https://api.example.com/v1"></div>
          <div class="ai-provider-field"><label>模型列表</label><textarea data-ai-models placeholder="glm-4-flash | GLM-4 Flash | text\ndeepseek-chat | DeepSeek Chat | text"></textarea><div class="ai-provider-help">每行格式：模型 ID | 显示名称 | 能力。能力支持 text、vision、audio，多模态可组合（如 text,vision 或 text,vision,audio）；可选第四列接口类型 openai / anthropic / responses。</div></div>
          <div class="ai-provider-field"><label>API Key</label><input data-ai-key type="password" placeholder="留空则保留已有密钥"></div>
          <div class="ai-provider-form-actions"><button class="ai-provider-save" type="submit">保存供应商</button><button class="ai-provider-secondary" type="button" data-ai-test>测试</button><button class="ai-provider-secondary" type="button" data-ai-update-models>更新模型</button><button class="ai-provider-secondary" type="button" data-ai-cancel>取消编辑</button><button class="ai-provider-secondary" type="button" data-ai-remove-key style="display:none">清除密钥</button></div>
          <div class="ai-provider-help" data-ai-update-status role="status" aria-live="polite">更新模型会获取供应商当前返回的目录，核对后点击“保存供应商”生效。</div>
        </form>`;
      drawer.querySelector('[data-ai-close]').onclick = closeDrawer;
      drawer.querySelector('[data-ai-add]').onclick = () => editProvider('');
      drawer.querySelector('[data-ai-opencode]').onclick = syncOpenCode;
      drawer.querySelector('[data-ai-cancel]').onclick = () => editProvider('');
      drawer.querySelector('[data-ai-remove-key]').onclick = removeKey;
      drawer.querySelector('[data-ai-preset]').onchange = applyPreset;
      drawer.querySelector('[data-ai-test]').onclick = testConnection;
      drawer.querySelector('[data-ai-update-models]').onclick = updateModels;
      drawer.querySelector('[data-ai-form]').onsubmit = saveProvider;
    }

    function mountSelector() {
      if (!before?.parentNode) return;
      const wrap = document.createElement('div');
      wrap.className = 'ai-model-picker';
      if (options.nativeSelect) wrap.classList.add('ai-model-picker-native');
      const label = document.createElement('label');
      label.textContent = capability === 'vision' ? '视觉模型' : '当前模型';
      if (options.nativeSelect) label.hidden = true;
      modelSelect = document.createElement('select');
      modelSelect.setAttribute('aria-label', label.textContent);
      modelSelect.hidden = true;
      modelSelect.onchange = selectModel;
      const id = `ai-model-picker-${++pickerCounter}`;
      pickerTrigger = document.createElement('button');
      pickerTrigger.type = 'button';
      pickerTrigger.className = 'ai-model-trigger';
      pickerTrigger.setAttribute('aria-haspopup', 'listbox');
      pickerTrigger.setAttribute('aria-expanded', 'false');
      pickerTrigger.setAttribute('aria-controls', `${id}-results`);
      pickerLabel = document.createElement('span');
      pickerLabel.className = 'ai-model-trigger-name';
      const arrow = document.createElement('span'); arrow.textContent = '▾'; arrow.setAttribute('aria-hidden', 'true');
      pickerTrigger.append(pickerLabel, arrow);
      pickerPopup = document.createElement('div');
      pickerPopup.className = 'ai-model-popup'; pickerPopup.hidden = true;
      pickerSearch = document.createElement('input');
      pickerSearch.type = 'search'; pickerSearch.className = 'ai-model-search';
      pickerSearch.placeholder = '搜索模型名称、ID 或供应商';
      pickerSearch.setAttribute('aria-label', '搜索模型');
      pickerSearch.setAttribute('role', 'combobox');
      pickerSearch.setAttribute('aria-autocomplete', 'list');
      pickerSearch.setAttribute('aria-expanded', 'false');
      pickerSearch.setAttribute('aria-controls', `${id}-results`);
      pickerResults = document.createElement('div'); pickerResults.id = `${id}-results`;
      pickerResults.className = 'ai-model-results'; pickerResults.setAttribute('role', 'listbox');
      pickerResults.setAttribute('aria-label', label.textContent);
      pickerStatus = document.createElement('div'); pickerStatus.className = 'ai-model-search-status';
      pickerStatus.setAttribute('role', 'status');
      pickerPopup.append(pickerSearch, pickerResults, pickerStatus);
      document.body.appendChild(pickerPopup);
      pickerTrigger.onclick = () => pickerPopup.hidden ? openPicker() : closePicker();
      pickerTrigger.onkeydown = event => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); if (!event.repeat) openPicker();
        }
      };
      pickerSearch.oninput = () => { if (!composingSearch) renderSearchResults(); };
      pickerSearch.addEventListener('compositionstart', () => { composingSearch = true; });
      pickerSearch.addEventListener('compositionend', () => { composingSearch = false; renderSearchResults(); });
      pickerSearch.onkeydown = event => {
        event.stopPropagation();
        if (event.isComposing || composingSearch || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); closePicker(true); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (filteredEntries.length) {
            activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filteredEntries.length) % filteredEntries.length;
            updateActiveOption(true);
          }
        } else if (event.key === 'Enter' && !event.repeat) {
          event.preventDefault(); chooseEntry(filteredEntries[activeIndex]);
        } else if (event.key === 'Tab') closePicker();
      };
      pickerSearch.addEventListener('keyup', event => event.stopPropagation());
      document.addEventListener('pointerdown', event => {
        if (!wrap.contains(event.target) && !pickerPopup.contains(event.target)) closePicker();
      });
      global.addEventListener('resize', positionPicker);
      document.addEventListener('scroll', event => { if (!pickerPopup.contains(event.target)) positionPicker(); }, true);
      wrap.append(label, pickerTrigger, modelSelect);
      before.parentNode.insertBefore(wrap, before);
    }

    function positionPicker() {
      if (!pickerPopup || pickerPopup.hidden) return;
      const rect = pickerTrigger.getBoundingClientRect();
      const width = Math.min(420, Math.max(300, rect.width), global.innerWidth - 16);
      pickerPopup.style.width = `${width}px`;
      pickerPopup.style.left = `${Math.max(8, Math.min(rect.left, global.innerWidth - width - 8))}px`;
      const below = global.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const upwards = below < 260 && above > below;
      const height = Math.max(80, Math.min(420, upwards ? above : below, global.innerHeight - 16));
      pickerPopup.style.maxHeight = `${height}px`;
      pickerPopup.style.top = `${upwards ? Math.max(8, rect.top - pickerPopup.getBoundingClientRect().height - 6) : rect.bottom + 6}px`;
    }

    function openPicker() {
      if (selectingModel || !selection) return;
      pickerPopup.hidden = false; pickerSearch.value = ''; composingSearch = false;
      pickerTrigger.setAttribute('aria-expanded', 'true'); pickerSearch.setAttribute('aria-expanded', 'true');
      renderSearchResults(); positionPicker(); pickerSearch.focus();
    }

    function closePicker(restoreFocus = false) {
      if (!pickerPopup || pickerPopup.hidden) return;
      pickerPopup.hidden = true;
      pickerTrigger.setAttribute('aria-expanded', 'false'); pickerSearch.setAttribute('aria-expanded', 'false');
      if (restoreFocus) pickerTrigger.focus();
    }

    function updateActiveOption(scroll = false) {
      const options = pickerResults.querySelectorAll('[role="option"]');
      options.forEach((option, index) => option.classList.toggle('active', index === activeIndex));
      const active = options[activeIndex];
      if (active) {
        pickerSearch.setAttribute('aria-activedescendant', active.id);
        if (scroll) active.scrollIntoView({ block: 'nearest' });
      } else pickerSearch.removeAttribute('aria-activedescendant');
    }

    function renderSearchResults() {
      if (!pickerResults) return;
      filteredEntries = filterModelEntries(pickerEntries, pickerSearch.value);
      activeIndex = Math.max(0, filteredEntries.findIndex(entry => entry.providerId === selection?.providerId && entry.modelId === selection?.modelId));
      pickerResults.replaceChildren();
      let provider = '';
      filteredEntries.forEach((entry, index) => {
        if (provider !== entry.providerId) {
          const heading = document.createElement('div'); heading.className = 'ai-model-group'; heading.textContent = entry.providerName;
          pickerResults.appendChild(heading); provider = entry.providerId;
        }
        const option = document.createElement('div'); option.className = 'ai-model-option';
        option.id = `${pickerResults.id}-${index}`; option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(entry.providerId === selection?.providerId && entry.modelId === selection?.modelId));
        const name = document.createElement('span'); name.textContent = entry.label;
        const detail = document.createElement('small'); detail.textContent = entry.modelId;
        option.append(name, detail);
        option.onclick = () => chooseEntry(entry);
        option.onpointermove = () => { activeIndex = index; updateActiveOption(); };
        pickerResults.appendChild(option);
      });
      pickerStatus.textContent = filteredEntries.length ? `${filteredEntries.length} 个匹配模型 · ↑↓ 选择，回车确认，Esc 取消` : '没有匹配的模型，请更换关键词';
      updateActiveOption();
    }

    function updatePickerLabel() {
      if (!pickerTrigger) return;
      const entry = pickerEntries.find(item => item.providerId === selection?.providerId && item.modelId === selection?.modelId);
      pickerLabel.textContent = selectingModel ? '切换中…' : entry?.label || (capability === 'vision' ? '无可用视觉模型' : '无可用文本模型');
      pickerTrigger.disabled = selectingModel || !entry;
      pickerTrigger.title = entry ? `${entry.providerName} / ${entry.label} (${entry.modelId})` : pickerLabel.textContent;
      pickerTrigger.setAttribute('aria-label', `${capability === 'vision' ? '视觉模型' : '当前模型'}：${pickerTrigger.title}`);
      pickerPopup.setAttribute('aria-busy', String(selectingModel));
    }

    function chooseEntry(entry) {
      if (!entry || selectingModel) return;
      modelSelect.value = JSON.stringify({ providerId: entry.providerId, modelId: entry.modelId });
      return selectModel();
    }

    async function loadConfig() {
      config = await api.getConfig();
      config.providers = Array.isArray(config.providers) ? config.providers.filter(provider => provider && provider.id) : [];
      config.selections = config.selections || {};
      await renderProviders();
      await renderModels();
    }

    async function renderProviders() {
      const list = drawer?.querySelector('[data-ai-list]');
      if (!list) return;
      if (!config.providers.length) {
        list.innerHTML = '<div class="ai-provider-empty">还没有供应商，请先新增。</div>';
        return;
      }
      const secretStates = await Promise.all(config.providers.map(provider => isOpenCodeProvider(provider) ? true : api.hasProviderSecret(provider.id)));
      list.innerHTML = config.providers.map((provider, index) => `
        <div class="ai-provider-card" data-provider-id="${provider.id}">
          <div class="ai-provider-card-top"><div class="ai-provider-card-main"><div class="ai-provider-card-name"></div><div class="ai-provider-card-url"></div></div><span class="ai-provider-status ${secretStates[index] ? '' : 'missing'}">${isOpenCodeProvider(provider) ? '使用 OpenCode 认证' : (secretStates[index] ? '密钥已保存' : '未保存密钥')}</span></div>
          <div class="ai-provider-models"></div>
          <div class="ai-provider-actions">${isOpenCodeProvider(provider) ? '<button type="button" data-sync>同步模型</button>' : '<button type="button" data-edit>编辑</button>'}<button type="button" class="danger" data-delete>删除</button></div>
        </div>`).join('');
      config.providers.forEach(provider => {
        const card = list.querySelector(`[data-provider-id="${CSS.escape(provider.id)}"]`);
        card.querySelector('.ai-provider-card-name').textContent = provider.name || provider.id;
        card.querySelector('.ai-provider-card-url').textContent = provider.baseUrl || '';
        const models = card.querySelector('.ai-provider-models');
        sortModels(provider.models).forEach(model => {
          const chip = document.createElement('span');
          chip.className = 'ai-provider-model';
          chip.textContent = model.label || model.id;
          models.appendChild(chip);
        });
        const edit = card.querySelector('[data-edit]');
        const sync = card.querySelector('[data-sync]');
        if (edit) edit.onclick = () => editProvider(provider.id);
        if (sync) sync.onclick = syncOpenCode;
        card.querySelector('[data-delete]').onclick = () => deleteProvider(provider.id);
      });
    }

    async function syncOpenCode() {
      if (typeof api.listOpenCodeModels !== 'function') {
        notify('当前主程序不支持 OpenCode 模型同步，请先更新程序');
        return;
      }
      const button = drawer.querySelector('[data-ai-opencode]');
      button.disabled = true;
      button.textContent = '同步中…';
      try {
        const imported = await api.listOpenCodeModels();
        if (!Array.isArray(imported) || !imported.length) {
          notify('OpenCode 中没有已连接且包含模型的供应商，请先运行 opencode auth login');
          return;
        }
        const oldSelection = { ...(config.selections || {}) };
        const merged = mergeOpenCodeProviders(config.providers, imported);
        const managed = merged.managed;
        config.providers = merged.providers;
        config.selections = oldSelection;
        await api.saveConfig(config);
        await loadConfig();
        const modelCount = managed.reduce((sum, provider) => sum + provider.models.length, 0);
        notify(`已同步 ${managed.length} 个 OpenCode 供应商、${modelCount} 个模型`);
      } catch (error) {
        notify(`OpenCode 同步失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        button.disabled = false;
        button.textContent = '导入 OpenCode';
      }
    }

    async function renderModels() {
      if (!modelSelect) return;
      modelSelect.innerHTML = '';
      pickerEntries = [];
      const available = [];
      config.providers.forEach(provider => {
        const models = sortModels(provider.models).filter(model => (model.capabilities || []).includes(capability));
        if (!models.length) return;
        const group = document.createElement('optgroup');
        group.label = provider.name || provider.id;
        models.forEach(model => {
          const option = document.createElement('option');
          option.value = JSON.stringify({ providerId: provider.id, modelId: model.id });
          option.textContent = model.label || model.id;
          group.appendChild(option);
          available.push({ providerId: provider.id, modelId: model.id });
          pickerEntries.push({ providerId: provider.id, providerName: provider.name || provider.id, modelId: model.id, label: model.label || model.id });
        });
        modelSelect.appendChild(group);
      });
      const stored = config.selections[capability];
      selection = available.find(item => item.providerId === stored?.providerId && item.modelId === stored?.modelId) || available[0] || null;
      modelSelect.disabled = !selection;
      updatePickerLabel();
      if (pickerPopup && !pickerPopup.hidden) renderSearchResults();
      if (!selection) {
        const option = document.createElement('option');
        option.textContent = capability === 'vision' ? '无可用视觉模型' : '无可用文本模型';
        modelSelect.appendChild(option);
        return;
      }
      modelSelect.value = JSON.stringify(selection);
      if (!stored || stored.providerId !== selection.providerId || stored.modelId !== selection.modelId) {
        config.selections[capability] = { ...selection };
        await api.saveConfig(config);
      }
    }

    async function selectModel() {
      if (!modelSelect.value || selectingModel) return;
      const next = JSON.parse(modelSelect.value);
      const candidate = { ...config, selections: { ...config.selections, [capability]: next } };
      selectingModel = true; updatePickerLabel();
      try {
        // 搜索只筛选候选；明确选择且保存成功后才改变当前模型。
        if (await api.saveConfig(candidate) === false) throw new Error('设置保存失败');
        config = candidate; selection = next;
        closePicker(true); notify('已切换模型');
      } catch (error) {
        modelSelect.value = JSON.stringify(selection);
        notify(`模型切换失败：${error instanceof Error ? error.message : String(error)}`);
      } finally { selectingModel = false; updatePickerLabel(); renderSearchResults(); }
    }

    function applyPreset(event) {
      editRevision++;
      const index = Number(event.target.value);
      const preset = PRESET_PROVIDERS[index];
      if (!preset) return;
      drawer.querySelector('[data-ai-name]').value = preset.name;
      drawer.querySelector('[data-ai-url]').value = preset.baseUrl;
      drawer.querySelector('[data-ai-models]').value = serializeModels(preset.models);
    }

    async function updateModels() {
      const button = drawer.querySelector('[data-ai-update-models]');
      if (button.disabled) return;
      const field = name => drawer.querySelector(`[data-ai-${name}]`);
      const snapshot = { revision: editRevision, id: editingId, url: field('url').value, key: field('key').value,
        models: field('models').value, name: field('name').value };
      const unchanged = () => snapshot.revision === editRevision && snapshot.id === editingId
        && snapshot.url === field('url').value && snapshot.key === field('key').value
        && snapshot.models === field('models').value && snapshot.name === field('name').value;
      const status = drawer.querySelector('[data-ai-update-status]');
      button.disabled = true; button.textContent = '更新中…';
      try {
        if (typeof api.listProviderModels !== 'function') throw new Error('当前共享运行时不支持模型更新，请重新打开插件或更新程序');
        if (!snapshot.url.trim()) throw new Error('请先选择供应商预设或填写 Base URL');
        const result = await api.listProviderModels({ providerId: editingId || undefined, baseUrl: snapshot.url.trim(),
          key: snapshot.key.trim(), models: parseModels(snapshot.models) });
        if (!unchanged()) { notify('编辑内容已变化，获取结果未覆盖当前输入，请重新更新模型'); return; }
        if (!Array.isArray(result?.models) || !result.models.length) throw new Error('供应商未返回可用模型');
        const models = mergeCatalogModels(parseModels(snapshot.models), result.models);
        field('models').value = serializeModels(models);
        status.textContent = `已获取 ${models.length} 个模型，待保存。相同 ID 的自定义名称、能力和接口类型已保留；新模型未声明能力时按文本处理，请核对后保存。目录可见不代表所有模型均可调用，可使用“测试”检查。`;
        notify(`已获取 ${models.length} 个模型，请核对后保存供应商`);
      } catch (error) {
        if (unchanged()) { status.textContent = `更新模型失败：${error instanceof Error ? error.message : String(error)}。原列表已保留。`; notify(status.textContent); }
      } finally { button.disabled = false; button.textContent = '更新模型'; }
    }

    async function testConnection() {
      const name = drawer.querySelector('[data-ai-name]').value.trim();
      const baseUrl = drawer.querySelector('[data-ai-url]').value.trim().replace(/\/+$/, '');
      const models = parseModels(drawer.querySelector('[data-ai-models]').value);
      let key = drawer.querySelector('[data-ai-key]').value.trim();
      if (!name || !baseUrl || !models.length) { notify('请先选择预设供应商或填写名称、Base URL 与模型'); return; }
      if (!key && editingId && typeof api.getProviderSecret === 'function') key = await api.getProviderSecret(editingId);
      if (!key) { notify('请先填写 API Key'); return; }
      const button = drawer.querySelector('[data-ai-test]');
      button.disabled = true; button.textContent = '测试中…';
      try {
        const result = await api.testProvider({ baseUrl, models, key });
        if (result.ok) notify(`连接成功：${result.okCount}/${result.total} 个模型可用`);
        else {
          const failed = result.results.filter(item => !item.ok);
          const shown = failed.slice(0, 3).map(item => `${item.modelId}：${item.error}`).join('；');
          const rest = failed.length > 3 ? `；另有 ${failed.length - 3} 个模型失败` : '';
          notify(`测试未全部通过（${result.okCount}/${result.total} 个模型可用）：${shown}${rest}`);
        }
      } catch (error) {
        notify(`测试失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        button.disabled = false; button.textContent = '测试';
      }
    }

    function editProvider(id) {
      if (!drawer) return;
      editRevision++;
      editingId = id;
      const provider = config?.providers.find(item => item.id === id);
      if (isOpenCodeProvider(provider)) {
        notify('OpenCode 供应商由本机 OpenCode 托管，请使用“同步模型”更新');
        return;
      }
      drawer.querySelector('[data-ai-form-title]').textContent = provider ? '编辑供应商' : '新增供应商';
      drawer.querySelector('[data-ai-preset]').value = '';
      drawer.querySelector('[data-ai-name]').value = provider?.name || '';
      drawer.querySelector('[data-ai-url]').value = provider?.baseUrl || '';
      drawer.querySelector('[data-ai-models]').value = serializeModels(provider?.models || []);
      drawer.querySelector('[data-ai-key]').value = '';
      drawer.querySelector('[data-ai-update-status]').textContent = '更新模型会获取供应商当前返回的目录，核对后点击“保存供应商”生效。';
      drawer.querySelector('[data-ai-remove-key]').style.display = provider ? '' : 'none';
      drawer.querySelector('[data-ai-name]').focus();
    }

    async function saveProvider(event) {
      event.preventDefault();
      const name = drawer.querySelector('[data-ai-name]').value.trim();
      const baseUrl = drawer.querySelector('[data-ai-url]').value.trim().replace(/\/+$/, '');
      const models = parseModels(drawer.querySelector('[data-ai-models]').value);
      const key = drawer.querySelector('[data-ai-key]').value;
      if (!name || !baseUrl || !models.length) {
        notify('请填写供应商名称、Base URL 和至少一个模型');
        return;
      }
      const id = editingId || providerId();
      const next = { id, name, baseUrl, models };
      const index = config.providers.findIndex(provider => provider.id === id);
      if (index >= 0) config.providers[index] = next;
      else config.providers.push(next);
      await api.saveConfig(config);
      if (key) await api.saveProviderSecret(id, key);
      editingId = id;
      drawer.querySelector('[data-ai-key]').value = '';
      await loadConfig();
      editProvider(id);
      notify('供应商已保存');
    }

    async function deleteProvider(id) {
      if (config.providers.length <= 1) {
        notify('至少保留一个供应商');
        return;
      }
      const provider = config.providers.find(item => item.id === id);
      if (!global.confirm(`确认删除供应商“${provider?.name || id}”？`)) return;
      config.providers = config.providers.filter(item => item.id !== id);
      if (!isOpenCodeProvider(provider)) await api.removeProviderSecret(id);
      await api.saveConfig(config);
      editingId = '';
      await loadConfig();
      editProvider('');
      notify('供应商已删除');
    }

    async function removeKey() {
      if (!editingId) return;
      await api.removeProviderSecret(editingId);
      await renderProviders();
      notify('密钥已清除');
    }

    renderShell();
    mountSelector();
    const ready = loadConfig().then(() => editProvider(''));

    return {
      ready,
      async getSelection() {
        await ready;
        if (!selection) throw new Error(capability === 'vision' ? '请先添加支持视觉能力的供应商模型' : '请先添加文本供应商模型');
        return { ...selection };
      },
      refresh: loadConfig
    };
  }

  function enhanceSelect(select, options = {}) {
    if (select.__aiSearchPicker) return select.__aiSearchPicker;
    const manager = create({
      getConfig: async () => {
        const providers = new Map();
        for (const option of select.options) {
          const providerId = option.dataset.provider || option.parentElement.label || 'local';
          const directNames = { openai: 'OpenAI', openrouter: 'OpenRouter', gemini: 'Gemini', deepseek: 'DeepSeek' };
          const groupLabel = option.parentElement.label;
          const name = providerId.startsWith('shared:') ? groupLabel || '共享供应商'
            : groupLabel ? `${groupLabel} · ${directNames[providerId] || providerId}` : directNames[providerId] || providerId;
          if (!providers.has(providerId)) providers.set(providerId, { id: providerId, name, models: [] });
          providers.get(providerId).models.push({ id: option.value, label: option.textContent, capabilities: ['text'] });
        }
        const selected = select.options[select.selectedIndex];
        return { providers: [...providers.values()], selections: { text: selected ? {
          providerId: selected.dataset.provider || selected.parentElement.label || 'local', modelId: selected.value
        } : null } };
      },
      saveConfig: async config => {
        const selected = config.selections.text;
        const index = Array.from(select.options).findIndex(option => option.value === selected.modelId
          && (option.dataset.provider || option.parentElement.label || 'local') === selected.providerId);
        if (index < 0) throw new Error('模型已变化，请刷新后重新选择');
        const previous = select.selectedIndex;
        select.selectedIndex = index;
        try {
          if (options.onSelect) await options.onSelect(select.options[index]);
          else select.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (error) { select.selectedIndex = previous; throw error; }
        return config;
      }
    }, { beforeElement: select, nativeSelect: true, drawer: '#ai-native-picker-no-drawer', notify: options.notify });
    select.hidden = true; select.style.display = 'none';
    select.__aiSearchPicker = manager;
    return manager;
  }

  global.AIProviderManager = { create, enhanceSelect, sortModels, parseModels, mergeOpenCodeProviders, mergeCatalogModels, filterModelEntries, isOpenCodeProvider };
})(window);
