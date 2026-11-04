(() => {
    const $ = (id) => document.getElementById(id);
    const view = $('pageView');
    const address = $('addressBar');
    const defaults = { homePage: 'https://www.baidu.com/', searchEngine: 'https://www.baidu.com/s?wd=' };
    const engines = {
        baidu: ['百度', 'https://www.baidu.com/s?wd='],
        bing: ['必应', 'https://www.bing.com/search?q='],
        google: ['Google', 'https://www.google.com/search?q=']
    };
    let settings = { ...defaults };
    let bookmarks = [];
    let visits = [];
    let currentUrl = '';
    let currentTitle = '';
    let drawerMode = '';
    let zoom = 1;
    let trail = [];
    let trailIndex = -1;
    let targetIndex = -1;
    let initialized = false;
    let pendingLaunchInput = null;

    const webUrl = (value) => {
        try {
            const parsed = new URL(value);
            return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
        } catch (_) { return null; }
    };

    function resolveInput(raw) {
        const input = String(raw || '').trim();
        if (!input) return null;
        if (/^https?:\/\//i.test(input)) return webUrl(input);
        if (/^[a-z][a-z\d+.-]*:/i.test(input)) return null;
        if (/^(localhost|[^\s.]+\.[^\s.]+)(:\d+)?(\/[^\s]*)?$/i.test(input)) return webUrl(`https://${input}`);
        return webUrl(`${settings.searchEngine}${encodeURIComponent(input)}`);
    }

    function delegatedInput(raw) {
        const text = String(raw || '').trim();
        // 总指挥传来整句指令时，只剥离明确的浏览器命令前缀，保留冒号后的搜索词或网址。
        const command = text.match(/^(?:请\s*)?(?:打开|启动|调用|使用)?\s*(?:网页浏览|浏览器)\s*(?:[：:]\s*([\s\S]*))?$/);
        return command ? String(command[1] || '').trim() : text;
    }

    function navigate(raw) {
        const url = resolveInput(raw);
        if (!url) {
            showError('仅支持 HTTP 和 HTTPS 网址，请检查输入内容。');
            return;
        }
        $('pageError').classList.add('hidden');
        closeDrawer();
        view.src = url;
        address.value = url;
    }

    function showError(message) {
        $('errorDetail').textContent = message;
        $('pageError').classList.remove('hidden');
        $('siteState').textContent = '!';
        $('siteState').classList.remove('secure');
    }

    function updateNavigation() {
        const ready = typeof view.canGoBack === 'function';
        $('backBtn').disabled = !(ready && view.canGoBack()) && trailIndex <= 0;
        $('forwardBtn').disabled = !(ready && view.canGoForward()) && trailIndex >= trail.length - 1;
        $('bookmarkBtn').textContent = bookmarks.some((item) => item.url === currentUrl) ? '★' : '☆';
        $('externalBtn').disabled = !webUrl(currentUrl);
        $('copyBtn').disabled = !webUrl(currentUrl);
    }

    async function save(key, value) {
        try { await window.browserAPI.set(key, value); }
        catch (error) { showError(`保存失败：${error.message}`); }
    }

    function renderBookmarks() {
        const bar = $('bookmarkBar');
        bar.replaceChildren();
        for (const item of bookmarks) {
            const button = document.createElement('button');
            button.className = 'bookmark-chip';
            button.textContent = item.title || item.url;
            button.title = item.url;
            button.addEventListener('click', () => navigate(item.url));
            bar.appendChild(button);
        }
        updateNavigation();
        if (drawerMode === 'bookmarks') renderDrawer();
    }

    function addVisit(url) {
        if (!webUrl(url)) return;
        const latest = visits[0];
        if (latest && latest.url === url) {
            latest.time = Date.now();
        } else {
            visits.unshift({ url, title: currentTitle || url, time: Date.now() });
            visits = visits.slice(0, 200);
        }
        save('history', visits);
        if (drawerMode === 'history') renderDrawer();
    }

    function onNavigate(url) {
        if (!webUrl(url)) return;
        // Electron 25 的 webview 在部分导航后仍报告不可后退，保留会话轨迹供工具栏后备。
        if (targetIndex >= 0 && trail[targetIndex] === url) {
            trailIndex = targetIndex;
        } else if (trail[trailIndex] !== url) {
            trail = trail.slice(0, trailIndex + 1);
            trail.push(url);
            if (trail.length > 100) trail.shift();
            trailIndex = trail.length - 1;
        }
        targetIndex = -1;
        currentUrl = url;
        currentTitle = url;
        address.value = url;
        $('siteState').textContent = url.startsWith('https:') ? '●' : '○';
        $('siteState').classList.toggle('secure', url.startsWith('https:'));
        $('siteState').title = url.startsWith('https:') ? 'HTTPS 连接' : 'HTTP 连接';
        $('pageError').classList.add('hidden');
        updateNavigation();
        addVisit(url);
    }

    function row(item, index, mode) {
        const wrapper = document.createElement('div');
        wrapper.className = 'row';
        const open = document.createElement('button');
        open.className = 'row-main row-btn';
        const title = document.createElement('span');
        title.className = 'row-title';
        title.textContent = item.title || item.url;
        const url = document.createElement('span');
        url.className = 'row-url';
        url.textContent = item.url;
        open.append(title, url);
        open.addEventListener('click', () => navigate(item.url));
        const remove = document.createElement('button');
        remove.className = 'row-btn row-remove';
        remove.textContent = '删除';
        remove.title = `删除${item.title || item.url}`;
        remove.addEventListener('click', () => {
            const list = mode === 'bookmarks' ? bookmarks : visits;
            list.splice(index, 1);
            save(mode, list);
            if (mode === 'bookmarks') renderBookmarks();
            else renderDrawer();
        });
        wrapper.append(open, remove);
        return wrapper;
    }

    function section(title) {
        const element = document.createElement('section');
        element.className = 'drawer-section';
        const heading = document.createElement('h3');
        heading.textContent = title;
        element.appendChild(heading);
        return element;
    }

    function renderDrawer() {
        const content = $('drawerContent');
        content.replaceChildren();
        $('drawerTitle').textContent = { menu: '更多', bookmarks: '书签', history: '访问记录', settings: '设置' }[drawerMode] || '';
        if (drawerMode === 'menu') {
            const groups = section('浏览');
            for (const [label, mode] of [['书签', 'bookmarks'], ['访问记录', 'history'], ['设置', 'settings']]) {
                const button = document.createElement('button');
                button.className = 'row row-btn';
                button.textContent = label;
                button.addEventListener('click', () => openDrawer(mode));
                groups.appendChild(button);
            }
            const tools = section('缩放');
            for (const [label, amount] of [['缩小', -.1], ['重置为 100%', 0], ['放大', .1]]) {
                const button = document.createElement('button');
                button.className = 'row row-btn';
                button.textContent = label;
                button.addEventListener('click', () => changeZoom(amount));
                tools.appendChild(button);
            }
            content.append(groups, tools);
        } else if (drawerMode === 'settings') {
            const home = document.createElement('div');
            home.className = 'setting';
            const label = document.createElement('label');
            label.textContent = '主页网址';
            label.htmlFor = 'homeSetting';
            const input = document.createElement('input');
            input.id = 'homeSetting';
            input.value = settings.homePage;
            home.append(label, input);
            const engine = document.createElement('div');
            engine.className = 'setting';
            const engineLabel = document.createElement('label');
            engineLabel.textContent = '搜索引擎';
            engineLabel.htmlFor = 'engineSetting';
            const select = document.createElement('select');
            select.id = 'engineSetting';
            for (const [key, [name, url]] of Object.entries(engines)) {
                const option = new Option(name, key);
                option.selected = settings.searchEngine === url;
                select.add(option);
            }
            engine.append(engineLabel, select);
            const actions = document.createElement('div');
            actions.className = 'setting-actions';
            const saveButton = document.createElement('button');
            saveButton.className = 'primary-btn';
            saveButton.textContent = '保存设置';
            saveButton.addEventListener('click', () => {
                const homeUrl = webUrl(input.value.trim());
                if (!homeUrl) { input.setCustomValidity('请输入 HTTP 或 HTTPS 网址'); input.reportValidity(); return; }
                settings = { homePage: homeUrl, searchEngine: engines[select.value][1] };
                save('browser-settings', settings);
                closeDrawer();
            });
            const clear = document.createElement('button');
            clear.textContent = '清空访问记录';
            clear.addEventListener('click', () => {
                if (!confirm('清空插件保存的访问记录？')) return;
                visits = [];
                save('history', visits);
            });
            actions.append(clear, saveButton);
            content.append(home, engine, actions);
        } else {
            const list = drawerMode === 'bookmarks' ? bookmarks : visits;
            const group = section(list.length ? `${list.length} 条` : '暂无记录');
            list.forEach((item, index) => group.appendChild(row(item, index, drawerMode)));
            content.appendChild(group);
        }
    }

    function openDrawer(mode) {
        drawerMode = mode;
        renderDrawer();
        $('drawer').classList.remove('hidden');
    }
    function closeDrawer() {
        drawerMode = '';
        $('drawer').classList.add('hidden');
    }

    function changeZoom(amount) {
        zoom = amount === 0 ? 1 : Math.max(.5, Math.min(2, Math.round((zoom + amount) * 10) / 10));
        if (typeof view.setZoomFactor === 'function') view.setZoomFactor(zoom);
        $('zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
    }

    function toggleFind(show) {
        $('findBar').classList.toggle('hidden', !show);
        if (show) $('findInput').focus();
        else { view.stopFindInPage('clearSelection'); $('findCount').textContent = '0/0'; }
    }

    $('addressForm').addEventListener('submit', (event) => { event.preventDefault(); navigate(address.value); });
    address.addEventListener('focus', () => address.select());
    $('backBtn').addEventListener('click', () => {
        if (view.canGoBack()) view.goBack();
        else if (trailIndex > 0) { targetIndex = trailIndex - 1; view.src = trail[targetIndex]; }
    });
    $('forwardBtn').addEventListener('click', () => {
        if (view.canGoForward()) view.goForward();
        else if (trailIndex < trail.length - 1) { targetIndex = trailIndex + 1; view.src = trail[targetIndex]; }
    });
    $('reloadBtn').addEventListener('click', () => view.isLoading() ? view.stop() : view.reload());
    $('homeBtn').addEventListener('click', () => navigate(settings.homePage));
    $('bookmarkBtn').addEventListener('click', () => {
        if (!webUrl(currentUrl)) return;
        const index = bookmarks.findIndex((item) => item.url === currentUrl);
        if (index < 0) bookmarks.push({ url: currentUrl, title: currentTitle || currentUrl });
        else bookmarks.splice(index, 1);
        save('bookmarks', bookmarks);
        renderBookmarks();
    });
    $('findBtn').addEventListener('click', () => toggleFind(true));
    $('findClose').addEventListener('click', () => toggleFind(false));
    $('findInput').addEventListener('input', () => {
        const text = $('findInput').value;
        if (text) view.findInPage(text);
        else view.stopFindInPage('clearSelection');
    });
    $('findInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); view.findInPage(event.target.value, { forward: !event.shiftKey, findNext: true }); }
    });
    $('findPrev').addEventListener('click', () => view.findInPage($('findInput').value, { forward: false, findNext: true }));
    $('findNext').addEventListener('click', () => view.findInPage($('findInput').value, { forward: true, findNext: true }));
    $('copyBtn').addEventListener('click', () => window.browserAPI.copy(currentUrl));
    $('externalBtn').addEventListener('click', () => { if (webUrl(currentUrl)) window.browserAPI.openExternal(currentUrl); });
    $('menuBtn').addEventListener('click', () => openDrawer('menu'));
    $('drawerClose').addEventListener('click', closeDrawer);
    $('retryBtn').addEventListener('click', () => { if (webUrl(currentUrl)) view.reload(); else navigate(address.value); });
    $('errorExternalBtn').addEventListener('click', () => { if (webUrl(currentUrl)) window.browserAPI.openExternal(currentUrl); });
    window.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); address.focus(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); toggleFind(true); }
        if (event.key === 'Escape') { closeDrawer(); if (!$('findBar').classList.contains('hidden')) toggleFind(false); }
    });
    window.addEventListener('browser-open', (event) => {
        pendingLaunchInput = delegatedInput(event.detail);
        if (initialized) navigate(pendingLaunchInput || settings.homePage);
    });

    view.addEventListener('did-start-loading', () => {
        $('reloadBtn').textContent = '×';
        $('reloadBtn').title = '停止加载';
        $('pageError').classList.add('hidden');
    });
    view.addEventListener('did-stop-loading', () => {
        $('reloadBtn').textContent = '↻';
        $('reloadBtn').title = '刷新';
        updateNavigation();
    });
    view.addEventListener('did-navigate', (event) => onNavigate(event.url));
    view.addEventListener('did-navigate-in-page', (event) => onNavigate(event.url));
    view.addEventListener('page-title-updated', (event) => {
        currentTitle = event.title || currentUrl;
        $('pageTitle').textContent = currentTitle;
        if (visits[0] && visits[0].url === currentUrl) {
            visits[0].title = currentTitle;
            save('history', visits);
        }
    });
    view.addEventListener('did-fail-load', (event) => {
        if (event.errorCode === -3 || !event.isMainFrame) return;
        showError(`${event.errorDescription || '连接失败'} (${event.errorCode})`);
    });
    view.addEventListener('found-in-page', (event) => {
        $('findCount').textContent = `${event.result.activeMatchOrdinal}/${event.result.matches}`;
    });
    view.addEventListener('dom-ready', updateNavigation);

    async function initialize() {
        try {
            const [savedSettings, savedBookmarks, savedHistory, legacyConfig] = await Promise.all([
                window.browserAPI.get('browser-settings'), window.browserAPI.get('bookmarks'),
                window.browserAPI.get('history'), window.browserAPI.get('config')
            ]);
            const oldSettings = legacyConfig && legacyConfig.settings || {};
            settings = {
                homePage: webUrl(savedSettings && savedSettings.homePage) || webUrl(oldSettings.homePage) || defaults.homePage,
                searchEngine: Object.values(engines).some((item) => item[1] === (savedSettings && savedSettings.searchEngine))
                    ? savedSettings.searchEngine : Object.values(engines).some((item) => item[1] === oldSettings.searchEngine)
                        ? oldSettings.searchEngine : defaults.searchEngine
            };
            bookmarks = Array.isArray(savedBookmarks) ? savedBookmarks.filter((item) => item && webUrl(item.url)).slice(0, 200) : [];
            visits = Array.isArray(savedHistory) ? savedHistory.filter((item) => item && webUrl(item.url)).slice(0, 200) : [];
        } catch (error) { showError(`读取浏览数据失败：${error.message}`); }
        renderBookmarks();
        initialized = true;
        navigate(pendingLaunchInput || settings.homePage);
    }
    initialize();
})();
