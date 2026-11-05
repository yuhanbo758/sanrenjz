(() => {
    const ipc = require('electron').ipcRenderer;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    async function call(channel, ...args) {
        const result = await ipc.invoke(channel, ...args);
        if (result?.success === false) { const error = new Error(result.error || '操作失败'); error.code = result.code; throw error; }
        return result;
    }
    function modal(id, title, body) {
        const dialog = document.createElement('dialog');
        dialog.id = id; dialog.className = 'merge-dialog';
        dialog.innerHTML = `<div class="dialog-top"><h2>${escape(title)}</h2><button type="button" aria-label="关闭">×</button></div>${body}`;
        dialog.querySelector('.dialog-top button').onclick = () => dialog.close();
        dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
        document.body.appendChild(dialog); return dialog;
    }
    function errorMessage(error) { showNotification('操作提示', error.message || String(error), 'error'); }
    async function busy(button, task) {
        button.disabled = true;
        try { return await task(); } catch (error) { errorMessage(error); } finally { button.disabled = false; }
    }
    function refresh() { return loadPlugins(true); }
    const open = modal('open-plugin-dialog', '打开插件', `<p>添加后不会自动运行。带其他模块或资源的 Python 程序请选择插件文件夹。</p><div class="merge-import-options"><button type="button" data-kind="python-file"><strong>python文件</strong><small>添加单个 .py 文件</small></button><button type="button" data-kind="python-folder"><strong>python插件文件夹</strong><small>添加 settings.json 插件及配套资源</small></button><button type="button" data-kind="tools-folder"><strong>效率插件</strong><small>选择包含 plugin.json 的文件夹</small></button><button type="button" data-kind="tools-zip">从 ZIP 打开效率插件或 Python 插件</button></div>`);
    document.getElementById('local-file-btn').onclick = () => open.showModal();
    open.querySelectorAll('[data-kind]').forEach(button => button.onclick = () => busy(button, async () => {
        const result = await ipc.invoke('unified:import', button.dataset.kind);
        if (result.canceled) return;
        if (result.error || result.errors?.length) throw new Error(result.error || result.errors.join('\n'));
        open.close(); await refresh(); showNotification('插件已添加', '可以双击插件运行。', 'success');
    }));
    document.querySelectorAll('.engine-tab').forEach(button => button.onclick = () => {
        currentEngine = button.dataset.engine;
        document.querySelectorAll('.engine-tab').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
        document.getElementById('python-quick-settings').hidden = currentEngine !== 'python';
        document.getElementById('engine-status').textContent = currentEngine === 'python' ? '双击或点击运行；解释器在设置中选择' : '双击打开工具';
        document.getElementById('search-box').placeholder = currentEngine === 'python' ? '搜索 py程序…' : '搜索效率工具…';
        applySearch();
    });
    const store = modal('unified-store-dialog', '插件商店', `<p>使用同一个程序小店账号，效率工具与 Python 的会员权限分别保留。</p><div id="store-membership" class="merge-status">未登录</div><div class="merge-actions"><button type="button" data-store="tools">效率工具</button><button type="button" data-store="python">py程序</button></div>`);
    window.showUnifiedStore = async () => {
        store.showModal();
        try {
            const account = await call('account:me');
            document.getElementById('store-membership').textContent = account.authenticated ? ['tools', 'python'].map((kind, i) => `${['效率工具', 'Python'][i]}：${!account.access?.[kind]?.available ? '查询失败' : account.access[kind].member ? '会员' : '普通用户'}`).join('　') : '未登录，可在商店中登录';
        } catch { document.getElementById('store-membership').textContent = '账号状态暂时无法读取'; }
    };
    store.querySelectorAll('[data-store]').forEach(button => button.onclick = () => busy(button, async () => { await call(`shop:open-${button.dataset.store}-store`); store.close(); }));

    const sidebar = document.querySelector('.settings-sidebar');
    const pythonTab = document.createElement('button'); pythonTab.type = 'button'; pythonTab.id = 'python-settings-tab'; pythonTab.className = 'sidebar-item'; pythonTab.dataset.target = 'merge-python'; pythonTab.textContent = 'Python 环境'; pythonTab.setAttribute('role', 'tab'); pythonTab.setAttribute('aria-controls', 'merge-python'); pythonTab.setAttribute('aria-selected', 'false'); sidebar.appendChild(pythonTab);
    const pane = document.createElement('div'); pane.className = 'settings-tab-content'; pane.id = 'merge-python';
    pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', pythonTab.id);
    pane.innerHTML = `
        <header class="settings-page-header"><h2>Python 环境</h2><p class="card-description">为 py程序选择运行环境。默认不安装，效率工具可直接使用。</p></header>
        <section id="python-environment-status" class="settings-card python-current-summary" aria-label="当前 Python 环境">
            <div class="card-heading"><h3>当前解释器</h3><span id="python-current-state" class="status-badge neutral">未配置</span></div>
            <div id="python-current-details"></div><div id="python-current-badges" class="candidate-badges"></div>
            <div class="settings-secondary-actions"><button type="button" id="python-diagnose">环境诊断</button><button type="button" id="python-clear">取消选择</button></div>
        </section>
        <section class="settings-card" aria-labelledby="python-add-heading">
            <div class="card-heading"><h3 id="python-add-heading">添加运行环境</h3></div>
            <p class="card-description">已有 Python 可直接添加，或检查电脑后选择；Windows 支持安装到程序目录。</p>
            <div class="python-primary-actions"><button type="button" id="python-select">添加解释器</button><button type="button" id="python-discover">一键检查</button><button type="button" id="python-install">一键安装</button><button type="button" id="python-cancel" hidden>取消安装</button></div>
            <p id="python-install-note" class="card-description"></p>
            <div id="python-install-feedback" hidden><p id="python-progress" class="python-feedback" role="status" aria-live="polite"></p><progress id="python-install-progress" max="100" aria-label="Python 安装进度"></progress></div>
            <p id="python-operation-feedback" class="python-feedback" role="status" aria-live="polite" hidden></p>
        </section>
        <section class="settings-card" aria-labelledby="python-candidates-heading">
            <div class="card-heading"><h3 id="python-candidates-heading">电脑中的 Python</h3></div>
            <p id="python-discovery-status" class="card-description" role="status" aria-live="polite">点击“一键检查”查找已安装的环境，不会自动安装或切换。</p>
            <div id="python-candidates"></div>
        </section>
        <section id="python-diagnostic-section" class="settings-card" aria-labelledby="python-diagnostic-heading" hidden>
            <div class="card-heading"><h3 id="python-diagnostic-heading">环境诊断结果</h3></div><pre id="python-diagnostic" hidden></pre>
        </section>
        <section class="settings-card" aria-labelledby="python-maintenance-heading">
            <div class="card-heading"><h3 id="python-maintenance-heading">插件与维护</h3></div>
            <p class="card-description">插件显示、自启动和移除在“插件管理”中设置；用户配置目录在“常规设置”中管理。</p>
            <div class="settings-secondary-actions"><button type="button" id="python-manage-plugins">管理 py程序插件</button><button type="button" id="python-all-logs">运行日志</button><button type="button" id="migration-open">导入旧应用数据</button></div>
        </section>`;
    document.querySelector('.settings-main').appendChild(pane);
    let environmentStatus = { configured: false, supportedInstall: process.platform === 'win32', installing: false };
    let environmentOperation = '';
    let cancelPending = false;
    let discoveredCandidates = [];
    let discoveryState = 'idle';
    let environmentLoadVersion = 0;
    let verifiedRuntime;
    let diagnosticError;
    const comparablePath = value => {
        const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    const isCurrentRuntime = value => Boolean(environmentStatus.configured && comparablePath(value) && comparablePath(value) === comparablePath(environmentStatus.executable));
    const runtimeBadges = runtime => `<span class="status-badge ${runtime.pip ? 'good' : 'warning'}">pip ${runtime.pip ? '可用' : '缺少'}</span><span class="status-badge ${runtime.tk ? 'good' : 'warning'}">Tk ${runtime.tk ? '可用' : '缺少'}</span>`;
    function environmentFeedback(message, state = 'neutral') {
        const output = document.getElementById('python-operation-feedback');
        output.textContent = message;
        output.hidden = !message;
        output.dataset.state = state;
        output.classList.toggle('merge-error', state === 'error');
    }
    function renderEnvironmentControls() {
        const locked = Boolean(environmentOperation || environmentStatus.installing);
        for (const id of ['python-select', 'python-discover', 'python-clear', 'python-diagnose']) {
            document.getElementById(id).disabled = locked || (!environmentStatus.configured && ['python-clear', 'python-diagnose'].includes(id));
        }
        document.getElementById('python-install').disabled = locked || !environmentStatus.supportedInstall;
        const installing = environmentStatus.installing || environmentOperation === 'install';
        document.getElementById('python-cancel').hidden = !installing;
        document.getElementById('python-cancel').disabled = cancelPending;
        document.getElementById('python-cancel').textContent = cancelPending ? '正在取消…' : '取消安装';
        document.getElementById('python-install-feedback').hidden = !installing && !document.getElementById('python-progress').textContent;
        document.getElementById('python-discover').textContent = environmentOperation === 'discover' ? '检查中…' : '一键检查';
        document.getElementById('python-install').textContent = installing ? '安装中…' : '一键安装';
        document.getElementById('python-diagnose').textContent = environmentOperation === 'diagnose' ? '诊断中…' : '环境诊断';
        document.querySelectorAll('#python-candidates button').forEach(button => { button.disabled = locked || button.dataset.current === 'true'; });
        pane.setAttribute('aria-busy', String(locked));
    }
    function renderEnvironmentSummary() {
        const state = document.getElementById('python-current-state');
        const details = document.getElementById('python-current-details');
        const badges = document.getElementById('python-current-badges');
        const verified = verifiedRuntime && isCurrentRuntime(verifiedRuntime.executable);
        const failed = diagnosticError && isCurrentRuntime(diagnosticError.executable);
        state.textContent = failed ? '诊断失败' : verified ? '本次已验证' : environmentStatus.configured ? '已选择 · 待诊断' : '未配置';
        state.className = `status-badge ${failed ? 'warning' : verified ? 'good' : 'neutral'}`;
        if (!environmentStatus.configured) {
            details.innerHTML = '<p class="card-description">尚未选择 Python。浏览插件和使用效率工具不受影响。</p>';
            badges.innerHTML = '';
        } else {
            const title = environmentStatus.mode === 'managed' ? '程序专用 Python' : '自定义 Python';
            details.innerHTML = `<p class="python-current-title">${escape(title)}${verified ? ` · Python ${escape(verifiedRuntime.version)}` : ''}</p><p class="python-path">${escape(environmentStatus.executable || '路径为空，请重新添加解释器')}</p><p class="card-description">${failed ? escape(diagnosticError.message) : verified ? '本次操作已验证此环境，运行程序时仍会再次检查。' : '此处显示已保存的选择；点击“环境诊断”验证版本、pip 和 Tk。'}</p>`;
            badges.innerHTML = verified ? `<span class="status-badge neutral">${escape(verifiedRuntime.architecture || (verifiedRuntime.bitness ? `${verifiedRuntime.bitness} 位` : '架构未知'))}</span>${runtimeBadges(verifiedRuntime)}` : '';
        }
        document.getElementById('python-install-note').textContent = environmentStatus.supportedInstall ? '安装包含 pip 和 Tk 的独立环境，不修改系统 PATH。' : '当前平台请添加已有解释器；一键安装仅支持 Windows x64。';
    }
    function renderCandidates() {
        const container = document.getElementById('python-candidates');
        const status = document.getElementById('python-discovery-status');
        container.innerHTML = '';
        container.setAttribute('aria-busy', String(discoveryState === 'loading'));
        if (discoveryState === 'idle') return;
        if (discoveryState === 'loading') { status.textContent = '正在检查已安装的 Python，请稍候…'; return; }
        if (discoveryState === 'error') { status.textContent = '检查未完成，可点击“一键检查”重试。'; return; }
        status.textContent = discoveredCandidates.length ? `找到 ${discoveredCandidates.length} 个可用环境，选择后立即保存。` : '未找到可用环境。可以手动添加解释器，或在 Windows 上一键安装。';
        for (const candidate of discoveredCandidates) {
            const executable = candidate.executable || candidate.path;
            const current = isCurrentRuntime(executable);
            const row = document.createElement('div'); row.className = 'python-candidate-card';
            row.classList.toggle('current', current);
            row.innerHTML = `<div class="candidate-meta"><div class="card-heading"><strong>Python ${escape(candidate.version || '未知版本')}</strong>${current ? '<span class="status-badge good">当前使用</span>' : ''}</div><p class="python-path">${escape(executable)}</p><div class="candidate-badges"><span class="status-badge neutral">${escape(candidate.architecture || (candidate.bitness ? `${candidate.bitness} 位` : '架构未知'))}</span>${runtimeBadges(candidate)}</div></div><button type="button" data-current="${current}">${current ? '当前使用' : '使用此环境'}</button>`;
            row.querySelector('button').onclick = () => environmentAction('select', '正在验证所选解释器…', async () => {
                verifiedRuntime = await call('python:select-path', executable);
                diagnosticError = undefined;
                environmentFeedback('已切换到所选 Python 环境。', 'success');
            });
            container.appendChild(row);
        }
        renderEnvironmentControls();
    }
    async function loadPythonSettings() {
        const requestVersion = ++environmentLoadVersion;
        const status = await call('python:status');
        if (requestVersion !== environmentLoadVersion) return;
        environmentStatus = status;
        if (status.installing && status.progress) renderInstallProgress(status.progress);
        renderEnvironmentSummary();
        renderCandidates();
        renderEnvironmentControls();
    }
    async function environmentAction(operation, message, task) {
        // 环境选择、检查、诊断与安装串行，避免较晚返回的请求覆盖用户刚选择的环境。
        if (environmentOperation || environmentStatus.installing) return;
        environmentOperation = operation;
        environmentFeedback(message);
        renderEnvironmentControls();
        try { await task(); }
        catch (error) {
            if (operation === 'discover') { discoveryState = 'error'; discoveredCandidates = []; renderCandidates(); }
            if (error.code === 'PYTHON_INSTALL_CANCELLED') environmentFeedback('已取消安装，原有环境与选择保留。');
            else { environmentFeedback(error.message || String(error), 'error'); errorMessage(error); }
        } finally {
            environmentOperation = ''; cancelPending = false;
            try { await loadPythonSettings(); }
            catch (error) { environmentFeedback(`无法刷新环境状态：${error.message}，请重新打开 Python 环境页。`, 'error'); renderEnvironmentControls(); }
        }
    }
    async function openPythonSettings() {
        const settingsModal = document.getElementById('settings-modal');
        const wasOpen = settingsModal.classList.contains('show');
        settingsModal.classList.add('show');
        if (!wasOpen && await loadSettings() !== true) return;
        if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('merge-python');
        else {
            document.querySelectorAll('.sidebar-item').forEach(item => item.classList.toggle('active', item === pythonTab));
            document.querySelectorAll('.settings-tab-content').forEach(item => item.classList.toggle('active', item === pane));
            window.syncSettingsFooter?.();
        }
        loadPythonSettings().catch(errorMessage);
    }
    pythonTab.onclick = openPythonSettings; document.getElementById('python-quick-settings').onclick = openPythonSettings;
    document.getElementById('python-manage-plugins').onclick = () => window.openPluginManagement('python');
    document.getElementById('python-select').onclick = () => environmentAction('select', '请选择 Python 解释器，选择后会验证版本和组件。', async () => {
        const result = await call('python:select');
        if (result.canceled) { environmentFeedback('已取消添加，原有选择保留。'); return; }
        verifiedRuntime = result; diagnosticError = undefined;
        environmentFeedback('解释器已验证并保存。', 'success');
    });
    document.getElementById('python-discover').onclick = () => environmentAction('discover', '正在查找电脑中已安装的 Python…', async () => {
        discoveryState = 'loading'; discoveredCandidates = []; renderCandidates();
        discoveredCandidates = await call('python:discover'); discoveryState = 'ready';
        const current = discoveredCandidates.find(candidate => isCurrentRuntime(candidate.executable || candidate.path));
        if (current) { verifiedRuntime = { ...current, executable: current.executable || current.path }; diagnosticError = undefined; }
        renderCandidates();
        environmentFeedback(discoveredCandidates.length ? '检查完成。当前使用的环境已标记，可选择其他环境。' : '检查完成，未发现可用环境。');
    });
    document.getElementById('python-install').onclick = () => environmentAction('install', '正在准备程序专用 Python 环境…', async () => {
        document.getElementById('python-progress').textContent = '正在准备安装…';
        document.getElementById('python-install-progress').removeAttribute('value');
        document.getElementById('python-install-progress').hidden = false;
        verifiedRuntime = await call('python:install'); diagnosticError = undefined;
        environmentFeedback('安装完成，已选择程序专用 Python 环境。', 'success');
    });
    document.getElementById('python-cancel').onclick = async () => {
        if (cancelPending) return;
        cancelPending = true; renderEnvironmentControls();
        try { await call('python:cancel'); environmentFeedback('已请求取消，正在等待当前步骤结束…'); }
        catch (error) { cancelPending = false; renderEnvironmentControls(); environmentFeedback(error.message, 'error'); }
    };
    document.getElementById('python-clear').onclick = () => environmentAction('clear', '正在取消选择…', async () => {
        await call('python:clear'); verifiedRuntime = undefined; diagnosticError = undefined;
        document.getElementById('python-diagnostic-section').hidden = true;
        environmentFeedback('已取消选择。Python 环境文件保留，效率工具可继续使用。');
    });
    document.getElementById('python-diagnose').onclick = () => environmentAction('diagnose', '正在诊断当前环境…', async () => {
        document.getElementById('python-diagnostic-section').hidden = false;
        const output = document.getElementById('python-diagnostic'); output.hidden = false;
        output.textContent = '正在检查版本、pip 和 Tk…';
        try {
            const result = await call('python:diagnose'); verifiedRuntime = result; diagnosticError = undefined;
            output.textContent = `Python ${result.version}\n路径：${result.executable}\n架构：${result.architecture || result.bitness || '未知'}\npip：${result.pip ? '可用' : '缺少'}\nTk：${result.tk ? '可用' : '缺少'}`;
            environmentFeedback(result.pip && result.tk ? '诊断完成，pip 和 Tk 均可用。' : '诊断完成，部分组件缺少；请根据插件要求选择合适的环境。', result.pip && result.tk ? 'success' : 'warning');
        } catch (error) { verifiedRuntime = undefined; diagnosticError = { executable: environmentStatus.executable, message: error.message }; output.textContent = error.message; throw error; }
    });
    function renderInstallProgress(progress) {
        if (['discovering', 'discovered'].includes(progress.phase)) return;
        document.getElementById('python-progress').textContent = `${progress.message || progress.phase || ''}${Number.isFinite(progress.percent) ? ` ${Math.round(progress.percent)}%` : ''}`;
        const bar = document.getElementById('python-install-progress');
        bar.hidden = ['error', 'cancelled'].includes(progress.phase);
        if (Number.isFinite(progress.percent)) bar.value = Math.max(0, Math.min(100, progress.percent));
        else bar.removeAttribute('value');
        document.getElementById('python-install-feedback').hidden = false;
    }
    ipc.on('python:progress', (_event, progress) => {
        renderInstallProgress(progress);
        if (['complete', 'error', 'cancelled'].includes(progress.phase) && !environmentOperation) {
            cancelPending = false;
            setTimeout(() => loadPythonSettings().catch(errorMessage), 0);
        }
    });
    let logFilter = { engine: 'all', id: '' };
    let logRecords = new Map(), logSources = new Map();
    let logLimit = 4000, logMaxChars = 2 * 1024 * 1024, logChars = 0, logLoadVersion = 0, logLoading = false;
    let logRenderTimer, logRefreshTimer, selectedLogPluginName = '';
    const logs = modal('python-logs-dialog', '运行日志', `<p>查看本次启动后的近期运行记录。日志可能包含程序输出，分享前请检查内容。</p><div class="runtime-log-filters"><label>类型<select id="runtime-log-engine"><option value="all">全部类型</option><option value="tools">效率工具</option><option value="python">py程序</option></select></label><label>插件<select id="runtime-log-plugin"><option value="">全部插件</option></select></label></div><p id="runtime-log-status" role="status" aria-live="polite">正在读取日志…</p><pre id="python-log-output"></pre><div class="merge-actions"><button type="button" id="runtime-log-refresh">刷新</button><button type="button" id="python-export-logs">导出当前筛选</button></div>`);
    logs.classList.add('runtime-logs-dialog');
    const logEngineInput = document.getElementById('runtime-log-engine');
    const logPluginInput = document.getElementById('runtime-log-plugin');
    const logOutput = document.getElementById('python-log-output');
    const logStatus = document.getElementById('runtime-log-status');
    const engineName = engine => engine === 'tools' ? '效率工具' : 'py程序';
    const logRecordSize = record => ['id', 'engine', 'name', 'timestamp', 'stream', 'message'].reduce((total, key) => total + String(record[key] || '').length, 0);
    function addLogRecord(record) {
        if (!Number.isFinite(record?.sequence) || logRecords.has(record.sequence)) return;
        logRecords.set(record.sequence, record); logChars += logRecordSize(record);
        while (logRecords.size > logLimit || logChars > logMaxChars) {
            const first = logRecords.keys().next().value;
            logChars -= logRecordSize(logRecords.get(first)); logRecords.delete(first);
        }
        if (!logSources.has(record.id)) logSources.set(record.id, { id: record.id, engine: record.engine, name: record.name || record.id });
    }
    function renderLogSources() {
        const retainedIds = new Set([...logRecords.values()].map(record => record.id));
        for (const [id, source] of logSources) if (!source.installed && !retainedIds.has(id)) logSources.delete(id);
        const sources = [...logSources.values()].filter(source => logFilter.engine === 'all' || source.engine === logFilter.engine)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
        logPluginInput.replaceChildren(new Option('全部插件', ''));
        for (const source of sources) logPluginInput.add(new Option(`${source.name} · ${engineName(source.engine)}${source.installed === false ? '（历史日志）' : ''}`, source.id));
        const selectedSource = sources.find(source => source.id === logFilter.id);
        if (selectedSource) selectedLogPluginName = selectedSource.name;
        // 来源被移除或旧记录淘汰后，仍保留用户的筛选，不能悄悄扩大成“全部插件”。
        if (logFilter.id && !selectedSource) logPluginInput.add(new Option(`${selectedLogPluginName || '指定插件'}（${logLoading ? '读取中' : '暂无日志'}）`, logFilter.id));
        logPluginInput.value = logFilter.id;
    }
    function renderRuntimeLogs(followTail = true) {
        const previousScroll = logOutput.scrollTop;
        const matching = [...logRecords.values()].filter(record => (logFilter.engine === 'all' || record.engine === logFilter.engine) && (!logFilter.id || record.id === logFilter.id));
        const lines = []; let characters = 0;
        for (let index = matching.length - 1; index >= 0; index--) {
            const record = matching[index];
            const line = `[${record.timestamp}] [${engineName(record.engine)}] [${record.name || record.id}] ${record.stream}: ${record.message}`;
            if (characters + line.length > 200000 && lines.length) break;
            lines.unshift(line); characters += line.length;
        }
        logOutput.textContent = lines.join('\n') || (logRecords.size ? '当前筛选暂无日志。' : '暂无运行日志');
        logStatus.dataset.state = '';
        logStatus.textContent = `当前筛选 ${matching.length} 条 · 本次会话最多保留 ${logLimit} 条${lines.length < matching.length ? ` · 界面显示最近 ${lines.length} 条，导出包含完整筛选` : ''}`;
        document.getElementById('python-export-logs').disabled = matching.length === 0;
        logOutput.scrollTop = followTail ? logOutput.scrollHeight : previousScroll;
    }
    async function reloadRuntimeLogs() {
        const request = ++logLoadVersion;
        logLoading = true;
        logStatus.textContent = '正在读取日志…';
        try {
            const state = await call('runtime:logs');
            if (request !== logLoadVersion) return;
            // 快照请求期间的新记录仍保留，并用序号去重，避免刷新漏掉或重复实时日志。
            const newer = [...logRecords.values()].filter(record => record.sequence > state.sequence);
            logRecords = new Map(); logChars = 0;
            logLimit = state.limit || 4000; logMaxChars = state.maxChars || 2 * 1024 * 1024;
            logSources = new Map((state.plugins || []).map(source => [source.id, source]));
            for (const record of [...(state.records || []), ...newer].sort((a, b) => a.sequence - b.sequence)) addLogRecord(record);
            logLoading = false;
            renderLogSources(); renderRuntimeLogs();
        } catch (error) {
            if (request === logLoadVersion) { logLoading = false; logStatus.dataset.state = 'error'; logStatus.textContent = `读取日志失败：${error.message}`; }
            throw error;
        }
    }
    async function showLogs(options = {}) {
        logFilter = typeof options === 'string' ? { engine: 'python', id: options } : { engine: options.engine || 'all', id: options.id || '' };
        selectedLogPluginName = logSources.get(logFilter.id)?.name || '';
        logEngineInput.value = logFilter.engine;
        if (!logs.open) logs.showModal();
        await reloadRuntimeLogs();
    }
    logEngineInput.onchange = () => {
        logFilter.engine = logEngineInput.value;
        if (logFilter.engine !== 'all' && !logFilter.id.startsWith(`${logFilter.engine}:`)) { logFilter.id = ''; selectedLogPluginName = ''; }
        renderLogSources(); renderRuntimeLogs();
    };
    logPluginInput.onchange = () => { logFilter.id = logPluginInput.value; selectedLogPluginName = logSources.get(logFilter.id)?.name || ''; renderRuntimeLogs(); };
    ipc.on('runtime:log', (_event, record) => {
        addLogRecord(record);
        if (!logs.open || logRenderTimer) return;
        logRenderTimer = setTimeout(() => {
            logRenderTimer = undefined;
            if (!logs.open) return;
            const follow = logOutput.scrollTop + logOutput.clientHeight >= logOutput.scrollHeight - 24;
            renderLogSources(); renderRuntimeLogs(follow);
        }, 50);
    });
    const refreshLogSources = () => {
        if (!logs.open) return;
        clearTimeout(logRefreshTimer);
        logRefreshTimer = setTimeout(() => { logRefreshTimer = undefined; reloadRuntimeLogs().catch(errorMessage); }, 150);
    };
    ipc.on('plugins:changed', refreshLogSources); ipc.on('python:changed', refreshLogSources);
    logs.addEventListener('close', () => { clearTimeout(logRenderTimer); clearTimeout(logRefreshTimer); logRenderTimer = logRefreshTimer = undefined; });
    window.showPythonLogs = id => showLogs({ engine: 'python', id }).catch(errorMessage);
    window.showRuntimeLogs = options => showLogs(options).catch(errorMessage);
    document.getElementById('python-all-logs').onclick = () => showLogs({ engine: 'python' }).catch(errorMessage);
    document.getElementById('python-quick-logs').onclick = () => showLogs().catch(errorMessage);
    document.getElementById('runtime-log-refresh').onclick = event => busy(event.target, reloadRuntimeLogs);
    document.getElementById('python-export-logs').onclick = event => busy(event.target, async () => {
        const result = await call('runtime:export-logs', { ...logFilter });
        if (!result.canceled) showNotification('日志已导出', `已导出 ${result.count} 条当前筛选日志。`, 'success');
    }).finally(() => renderRuntimeLogs(false));
    window.runUnifiedPlugin = async p => {
        try {
            let result = await call('unified:run', p.id, { features: p.features || [] });
            if (result?.requiresDependencies) {
                if (!confirm(`“${p.name}”需要安装以下依赖到当前选择的 Python：\n\n${(result.packages || []).join('\n')}\n\n安装并运行？`)) return;
                showLogs(p.id).catch(errorMessage);
                result = await call('unified:run', p.id, { installDependencies: true });
            }
            await refresh(); return result;
        } catch (error) { if (['PYTHON_UNCONFIGURED', 'PYTHON_INVALID'].includes(error.code)) openPythonSettings(); errorMessage(error); }
    };
    const details = modal('python-details-dialog', '程序详情', '<div id="python-details-content"></div>');
    window.showPythonDetails = p => {
        let text = '';
        if (p.detailFilePath) try { text = require('fs').readFileSync(p.detailFilePath, 'utf8'); } catch { }
        document.getElementById('python-details-content').innerHTML = `<h3>${escape(p.name)}</h3><p>${escape(p.description)}</p><p>${escape(p.path)}</p><pre>${escape(text || '暂无说明文档。')}</pre>`; details.showModal();
    };
    document.getElementById('plugins-container').addEventListener('click', event => {
        const card = event.target.closest('.plugin-card'); if (!card) return;
        const p = cachedPlugins?.find(p => p.id === card.dataset.pluginId); if (!p || p.engine !== 'python') return;
        if (event.target.closest('.py-run')) window.runUnifiedPlugin(p);
        if (event.target.closest('.py-stop')) call('unified:stop', p.id).then(refresh).catch(errorMessage);
        if (event.target.closest('.py-logs')) showLogs(p.id).catch(errorMessage);
    });
    ipc.on('python:changed', () => { refresh(); if (pane.classList.contains('active')) loadPythonSettings().catch(errorMessage); });

    const migrationTab = document.createElement('button');
    migrationTab.type = 'button'; migrationTab.id = 'migration-settings-tab'; migrationTab.className = 'sidebar-item';
    migrationTab.dataset.target = 'merge-migration'; migrationTab.textContent = '数据导入';
    migrationTab.setAttribute('role', 'tab'); migrationTab.setAttribute('aria-controls', 'merge-migration'); migrationTab.setAttribute('aria-selected', 'false');
    sidebar.appendChild(migrationTab);
    const migrationPane = document.createElement('div');
    migrationPane.id = 'merge-migration'; migrationPane.className = 'settings-tab-content';
    migrationPane.setAttribute('role', 'tabpanel'); migrationPane.setAttribute('aria-labelledby', migrationTab.id);
    migrationPane.innerHTML = `<header class="settings-page-header"><h2>数据导入</h2><p class="card-description">把两个旧应用的插件和使用配置带到“三人聚智”，减少重新配置。</p></header>
        <section class="settings-card migration-guidance"><div class="card-heading"><h3>先预览，再导入</h3><span class="status-badge neutral">手动确认后执行</span></div><p class="card-description">导入前先备份，只补充缺少的数据，同名插件和已有配置保留。旧应用和原文件不变；导入不会运行插件，旧自启动需要你另行启用。</p><p class="card-description">登录凭据、Cookie 和旧 Python 运行时不迁移。可选复用已安装的解释器路径，卸载旧应用后需重新确认路径。</p><div class="settings-secondary-actions"><button type="button" id="migration-detect">重新检测旧应用</button><button type="button" id="migration-settings-choose">手动选择目录</button></div><p id="migration-settings-status" class="card-description" role="status" aria-live="polite">打开此页后检测旧应用；不会自动导入。</p></section>
        <div id="migration-settings-sources" class="migration-product-grid"></div>
        <section id="migration-settings-result" class="settings-card migration-result" hidden aria-live="polite"></section>`;
    document.querySelector('.settings-main').appendChild(migrationPane);
    const migration = modal('migration-dialog', '预览并导入旧应用数据', `<p>先选择来源和需要的内容。执行前会备份，新应用已有的数据不会被覆盖。</p><label class="merge-field" for="migration-source-picker">导入来源<select id="migration-source-picker"></select></label><div id="migration-sources"></div><div class="merge-actions"><button type="button" id="migration-choose">手动选择其他目录</button><button type="button" id="migration-skip">稍后再导入</button></div><section id="migration-result" class="migration-result" hidden aria-live="polite"></section>`);
    const migrationSources = new Map(), migrationSelections = new Map();
    let migrationSelectedId = '', migrationOperation = '', migrationInspected = false, migrationResultSourceId = '';
    const migrationProductName = product => product === 'python' ? '原 Python 程序管理' : '原效率工具';
    const migrationAvailability = source => ({
        toolsPlugins: Number(source.importable?.toolsPlugins ?? source.toolsCount) > 0,
        pythonPlugins: Number(source.importable?.pythonPlugins ?? source.pythonCount) > 0,
        configs: Boolean(source.importable?.configs ?? source.hasConfigs),
        preferences: Boolean(source.importable?.preferences),
        interpreter: Boolean(source.importable?.interpreter ?? source.hasInterpreter)
    });
    function migrationStatus(message, failed = false) {
        const output = document.getElementById('migration-settings-status');
        output.textContent = message; output.classList.toggle('merge-error', failed);
    }
    function renderMigrationControls() {
        const locked = Boolean(migrationOperation);
        migrationPane.setAttribute('aria-busy', String(locked));
        migration.setAttribute('aria-busy', String(locked));
        migrationPane.querySelectorAll('button').forEach(button => { button.disabled = locked; });
        migration.querySelectorAll('button,select,input').forEach(input => {
            input.disabled = locked || input.dataset.unavailable === 'true';
        });
        const run = document.getElementById('migration-run');
        if (run) {
            run.disabled = locked || ![...migration.querySelectorAll('[data-option]')].some(input => !input.disabled && input.checked);
            run.textContent = migrationOperation === 'run' ? '正在备份并导入…' : '备份并导入所选内容';
        }
        document.getElementById('migration-detect').textContent = migrationOperation === 'inspect' ? '检测中…' : '重新检测旧应用';
    }
    const migrationSourcePaths = source => `<dl class="migration-path-list">${source.root ? `<dt>应用 / 便携目录</dt><dd>${escape(source.root)}</dd>` : ''}${source.profileRoot ? `<dt>用户数据目录</dt><dd>${escape(source.profileRoot)}</dd>` : ''}${(source.configLocations || []).map(location => `<dt>${location.kind === 'tools-data' ? '效率插件数据' : 'Python 插件配置'}${location.custom ? '（自定义）' : ''}</dt><dd>${escape(location.path)}</dd>`).join('')}</dl>`;
    function renderMigrationPreview() {
        const picker = document.getElementById('migration-source-picker');
        picker.innerHTML = [...migrationSources.values()].map(source => `<option value="${escape(source.id)}">${escape(source.label || migrationProductName(source.product))} · ${escape(source.root || source.profileRoot || '旧应用数据')}</option>`).join('');
        if (!migrationSources.has(migrationSelectedId)) migrationSelectedId = migrationSources.keys().next().value || '';
        picker.value = migrationSelectedId;
        document.getElementById('migration-result').hidden = !migrationResultSourceId || migrationResultSourceId !== migrationSelectedId;
        const source = migrationSources.get(migrationSelectedId), container = document.getElementById('migration-sources');
        if (!source) {
            container.innerHTML = '<p class="migration-empty">暂未发现可导入来源。请手动选择旧安装目录、便携目录、用户数据目录或插件目录，可一次选择多个目录。</p>';
            renderMigrationControls(); return;
        }
        const available = migrationAvailability(source);
        if (!migrationSelections.has(source.id)) migrationSelections.set(source.id, { ...available, interpreter: false });
        const selection = migrationSelections.get(source.id);
        const options = [
            ['toolsPlugins', `效率插件（${Number(source.importable?.toolsPlugins ?? source.toolsCount) || 0}）`, '复制缺少的效率插件，不运行插件。'],
            ['pythonPlugins', `Python 插件（${Number(source.importable?.pythonPlugins ?? source.pythonCount) || 0}）`, '保留 Python 插件协议和配套资源，不安装依赖。'],
            ['configs', '插件配置与数据', '包含检测到的自定义配置位置，只补充缺少文件。'],
            ['preferences', '插件显示与搜索关键词', '只补充缺项。窗口选项随插件配置迁入；不启用旧自启动，不更改当前快捷键。'],
            ['interpreter', '复用旧解释器路径（可选）', '先验证再记录；不复制 Python 环境，旧安装卸载后路径可能失效。']
        ];
        container.innerHTML = `<section class="migration-preview-source"><div class="card-heading"><h3>${escape(source.label || migrationProductName(source.product))}</h3><span class="status-badge neutral">${source.origin === 'profile' ? '旧用户数据' : source.origin === 'selection' ? '手动选择' : '旧应用目录'}</span></div>${migrationSourcePaths(source)}${(source.descriptions || []).map(text => `<p class="merge-help">${escape(text)}</p>`).join('')}<div class="migration-options">${options.map(([key, label, description]) => `<label class="migration-option"><input type="checkbox" data-option="${key}" data-unavailable="${!available[key]}" ${available[key] && selection[key] ? 'checked' : ''} ${available[key] ? '' : 'disabled'}><span><strong>${escape(label)}</strong><small>${escape(available[key] ? description : '此来源未检测到可导入内容。')}</small></span></label>`).join('')}</div><button type="button" id="migration-run" class="merge-primary">备份并导入所选内容</button></section>`;
        container.querySelectorAll('[data-option]').forEach(input => input.onchange = () => { selection[input.dataset.option] = input.checked; renderMigrationControls(); });
        document.getElementById('migration-run').onclick = () => runMigration(source.id).catch(errorMessage);
        renderMigrationControls();
    }
    function renderMigrationSourceCards() {
        const container = document.getElementById('migration-settings-sources'); container.innerHTML = '';
        for (const product of ['tools', 'python']) {
            const sources = [...migrationSources.values()].filter(source => source.product === product);
            const card = document.createElement('section'); card.className = 'settings-card migration-product-card';
            card.dataset.product = product;
            card.innerHTML = `<div class="card-heading"><h3>${migrationProductName(product)}</h3><span class="status-badge ${sources.length ? 'good' : 'neutral'}">${sources.length ? `发现 ${sources.length} 个来源` : '未检测到'}</span></div><p class="card-description">${product === 'tools' ? '导入效率插件、插件数据，以及显示、关键词和窗口偏好。' : '导入 Python 插件及配置，可选验证旧解释器路径；不会复制运行时。'}</p><div class="migration-product-sources">${sources.length ? sources.map(source => `<div class="migration-source-card"><strong>${escape(source.label || migrationProductName(product))}</strong><p class="python-path">${escape(source.root || source.profileRoot)}</p><p class="card-description">效率插件 ${Number(source.toolsCount) || 0} · Python 插件 ${Number(source.pythonCount) || 0}${source.hasConfigs ? ' · 有插件配置' : ''}</p><button type="button" data-migration-preview="${escape(source.id)}">预览并选择</button></div>`).join('') : '<p class="migration-empty">未找到时，选择旧应用安装位置或便携目录；也支持旧用户数据目录和插件目录。</p>'}</div><div class="settings-secondary-actions"><button type="button" data-migration-select="${product}">选择${product === 'tools' ? '效率工具' : 'Python 程序管理'}目录</button></div>`;
            card.querySelectorAll('[data-migration-preview]').forEach(button => button.onclick = () => showMigration(button.dataset.migrationPreview).catch(errorMessage));
            card.querySelector('[data-migration-select]').onclick = () => chooseMigration().catch(errorMessage);
            container.appendChild(card);
        }
        renderMigrationControls();
    }
    function renderSources(result, merge = false) {
        if (!merge) migrationSources.clear();
        for (const source of result.sources || []) if (source?.id) migrationSources.set(source.id, source);
        migrationInspected = true;
        renderMigrationSourceCards(); renderMigrationPreview();
        const problems = (result.errors || []).map(item => item.error || item.message || '某个来源未能读取');
        migrationStatus(problems.length ? `部分来源未能检查：${problems.join('；')}。可以手动选择目录后重试。` : migrationSources.size ? `找到 ${migrationSources.size} 个可预览来源，选择内容后再执行导入。` : '暂未发现旧应用。可手动选择安装目录、便携目录、旧用户数据目录或插件目录。', Boolean(problems.length));
    }
    async function migrationAction(operation, action) {
        if (migrationOperation) return;
        migrationOperation = operation; renderMigrationControls();
        try { return await action(); }
        catch (error) { migrationStatus(error.message || '操作失败，请重试或手动选择目录。', true); throw error; }
        finally { migrationOperation = ''; renderMigrationControls(); }
    }
    async function inspectMigration() {
        return migrationAction('inspect', async () => { migrationStatus('正在检查旧应用和用户数据目录，不会自动导入…'); renderSources(await call('migration:inspect')); });
    }
    async function chooseMigration() {
        return migrationAction('choose', async () => {
            const result = await call('migration:choose');
            if (result.canceled) { migrationStatus('已取消选择，检测结果和导入选项保持不变。'); return; }
            renderSources(result, true);
        });
    }
    function renderMigrationResult(result, sourceId) {
        migrationResultSourceId = sourceId;
        const source = migrationSources.get(sourceId);
        const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        const errors = Array.isArray(result.errors) ? result.errors : [];
        const title = result.success === false ? '导入未完成' : errors.length ? '导入完成，部分内容需检查' : '导入完成';
        const detailItems = list => list.map(entry => { const item = typeof entry === 'string' ? { error: entry } : entry || {}; return `<li><strong>${escape(item.id || item.type || item.engine || '导入项目')}</strong><span>${escape(item.reason || item.error || item.message || '目标已有数据，已保留')}</span>${item.target ? `<code>${escape(item.target)}</code>` : ''}</li>`; }).join('');
        const html = `<div class="card-heading"><h3>${title}</h3><span class="status-badge ${result.success === false || errors.length ? 'warning' : 'good'}">${result.success === false ? '请检查报告后重试' : '已有数据已保留'}</span></div>${source ? `<p class="merge-help">来源：${escape(source.label || migrationProductName(source.product))}</p><p class="python-path">${escape(source.root || source.profileRoot)}</p>` : ''}<p class="migration-result-summary">新增 ${Number(result.copied) || 0} 项 · 保留 / 跳过 ${Number(result.skipped) || 0} 项 · 补充偏好 ${Number(result.preferenceFields) || 0} 项</p>${result.error ? `<p class="merge-error">${escape(result.error)}</p>` : ''}${result.backupPath ? `<p class="merge-help">迁移前备份及报告保留在：</p><p class="python-path">${escape(result.backupPath)}</p>` : ''}${result.restartRequired ? '<p class="merge-help">部分新插件或偏好将在下次启动时完整应用。当前未保存的设置输入继续保留。</p>' : ''}${conflicts.length ? `<details class="migration-result-details" open><summary>同名冲突 ${conflicts.length} 项（保留新应用已有数据）</summary><ul>${detailItems(conflicts)}</ul></details>` : ''}${errors.length ? `<details class="migration-result-details" open><summary>需要检查 ${errors.length} 项</summary><ul>${detailItems(errors)}</ul></details>` : ''}<p class="merge-help">导入不会运行插件或启用旧自启动。需要时可在“插件管理”中启用；登录请在新应用中重新完成。</p>`;
        for (const id of ['migration-result', 'migration-settings-result']) { const output = document.getElementById(id); output.hidden = false; output.innerHTML = html; }
    }
    async function runMigration(sourceId) {
        return migrationAction('run', async () => {
            const options = { sourceId };
            migration.querySelectorAll('[data-option]').forEach(input => { options[input.dataset.option] = input.dataset.unavailable !== 'true' && input.checked; });
            if (!Object.values(options).some(value => value === true)) throw new Error('请选择需要导入的内容');
            const result = await ipc.invoke('migration:run', options);
            renderMigrationResult(result, sourceId);
            migrationStatus(result.success === false ? '导入未完成，原数据和备份保留。请查看下方结果后重试。' : '所选内容已处理。可继续选择另一旧应用，已有数据不会覆盖。', result.success === false);
            if (result.success === false) showNotification('导入未完成', result.error || '请查看导入结果中的说明和备份路径。', 'error');
            // 刷新目录不重载设置表单，避免丢失用户在其它设置页尚未保存的输入。
            try { await refresh(); } catch (_) { showNotification('刷新提示', '导入结果已保存，插件列表暂未刷新，请稍后重试。', 'info'); }
        });
    }
    async function showMigration(sourceId) {
        if (sourceId) migrationSelectedId = sourceId;
        if (!migration.open) migration.showModal();
        if (!migrationInspected) await inspectMigration();
        else renderMigrationPreview();
    }
    async function openMigrationSettings() {
        const settingsModal = document.getElementById('settings-modal'), wasOpen = settingsModal.classList.contains('show');
        settingsModal.classList.add('show');
        if (!wasOpen && await loadSettings() !== true) return;
        window.activateSettingsTab('merge-migration');
        if (!migrationInspected) await inspectMigration();
    }
    migrationTab.onclick = () => openMigrationSettings().catch(errorMessage);
    document.getElementById('migration-open').onclick = () => openMigrationSettings().catch(errorMessage);
    document.getElementById('migration-detect').onclick = () => inspectMigration().catch(errorMessage);
    document.getElementById('migration-settings-choose').onclick = () => chooseMigration().catch(errorMessage);
    document.getElementById('migration-choose').onclick = () => chooseMigration().catch(errorMessage);
    document.getElementById('migration-source-picker').onchange = event => { migrationSelectedId = event.target.value; renderMigrationPreview(); };
    document.getElementById('migration-skip').onclick = () => migration.close();
    migration.addEventListener('cancel', event => { if (migrationOperation) event.preventDefault(); });
    migration.addEventListener('click', event => { if (migrationOperation === 'run' && event.target === migration) event.stopImmediatePropagation(); }, true);
    renderMigrationSourceCards(); renderMigrationPreview();
    call('get-settings').then(settings => {
        if (!settings.migrationPrompted) {
            // 只记录向导已展示，不读取或复制旧登录状态。
            call('save-settings', { migrationPrompted: true }).catch(() => {});
            showMigration().catch(errorMessage);
        }
    }).catch(errorMessage);
})();
