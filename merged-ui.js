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

    const migration = modal('migration-dialog', '导入旧应用数据', `<p>选择旧应用后，先备份再复制缺少的插件和配置。旧应用继续保留，新应用已有数据不会被覆盖。</p><div id="migration-sources"></div><div class="merge-actions"><button type="button" id="migration-choose">选择旧应用目录</button><button type="button" id="migration-skip">暂时跳过</button></div><pre id="migration-result" hidden></pre>`);
    async function renderSources(result) {
        const container = document.getElementById('migration-sources'); container.innerHTML = '';
        if (!result.sources?.length) container.textContent = '暂未发现旧应用数据，也可以手动选择旧应用目录。';
        for (const source of result.sources || []) {
            const row = document.createElement('div'); row.className = 'merge-section';
            row.innerHTML = `<h3>${escape(source.label)}</h3><p>${escape(source.root || source.profileRoot)}</p><label class="merge-field"><input type="checkbox" data-option="toolsPlugins" ${source.toolsCount ? 'checked' : 'disabled'}> 效率插件（${source.toolsCount || 0}）</label><label class="merge-field"><input type="checkbox" data-option="pythonPlugins" ${source.pythonCount ? 'checked' : 'disabled'}> Python 插件（${source.pythonCount || 0}）</label><label class="merge-field"><input type="checkbox" data-option="configs" ${source.hasConfigs ? 'checked' : 'disabled'}> 插件配置</label><label class="merge-field"><input type="checkbox" data-option="interpreter" ${source.hasInterpreter ? '' : 'disabled'}> 复用旧解释器路径（卸载旧应用可能使其失效）</label><button type="button" class="merge-primary">导入所选数据</button>`;
            row.querySelector('button').onclick = event => busy(event.target, async () => {
                const options = { sourceId: source.id }; row.querySelectorAll('[data-option]').forEach(input => options[input.dataset.option] = input.checked);
                const result = await ipc.invoke('migration:run', options);
                const output = document.getElementById('migration-result'); output.hidden = false; output.textContent = JSON.stringify(result, null, 2);
                if (result.success === false) showNotification('迁移未完整完成', `${result.error || '请查看下方报告'}${result.backupPath ? `；备份：${result.backupPath}` : ''}`, 'error');
                await refresh();
            }); container.appendChild(row);
        }
    }
    async function showMigration() { migration.showModal(); await renderSources(await call('migration:inspect')); }
    document.getElementById('migration-open').onclick = () => showMigration().catch(errorMessage);
    document.getElementById('migration-choose').onclick = event => busy(event.target, async () => { const result = await call('migration:choose'); if (!result.canceled) await renderSources(result); });
    document.getElementById('migration-skip').onclick = () => migration.close();
    call('get-settings').then(settings => {
        if (!settings.migrationPrompted) {
            // 只记录向导已展示，不读取或复制旧登录状态。
            call('save-settings', { migrationPrompted: true }).catch(() => {});
            showMigration().catch(errorMessage);
        }
    }).catch(errorMessage);
})();
