(() => {
    'use strict';
    const api = window.builtinBrowser;
    const toolbar = document.getElementById('browser-toolbar');
    const title = document.getElementById('browser-title');
    const host = document.getElementById('browser-host');
    const status = document.getElementById('browser-status');
    const buttons = [...document.querySelectorAll('[data-action]')];
    let stateRevision = 0, actionRevision = 0, unsubscribe;
    const text = (value, maximum) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum) : '';
    function normalize(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            typeof value.canGoBack !== 'boolean' || typeof value.canGoForward !== 'boolean' || typeof value.loading !== 'boolean') return null;
        const hostname = text(value.host, 255);
        return { canGoBack: value.canGoBack, canGoForward: value.canGoForward, loading: value.loading,
            title: text(value.title, 300) || '程序小店', host: /^[a-z0-9.:[\]-]+$/i.test(hostname) ? hostname : '', error: text(value.error, 240) };
    }
    function render(state) {
        document.title = state.title;
        title.textContent = state.title; title.title = state.title;
        host.textContent = state.host; host.hidden = !state.host;
        status.textContent = state.error || (state.loading ? '正在加载…' : '');
        status.title = status.textContent;
        toolbar.classList.toggle('is-loading', state.loading);
        toolbar.classList.toggle('has-error', Boolean(state.error));
        document.getElementById('browser-back').disabled = !state.canGoBack;
        document.getElementById('browser-forward').disabled = !state.canGoForward;
    }
    function accept(value) {
        const state = normalize(value);
        if (!state) return false;
        stateRevision++; render(state); return true;
    }
    function showFailure() {
        status.textContent = '导航暂时不可用，请重试或重新打开窗口';
        status.title = status.textContent;
        toolbar.classList.add('has-error');
    }
    if (!api || typeof api.getState !== 'function' || typeof api.act !== 'function' || typeof api.onState !== 'function') {
        showFailure(); return;
    }
    try { unsubscribe = api.onState(accept); } catch (_) { showFailure(); }
    // 先订阅再读取；较晚返回的初始快照不能覆盖已收到的新导航状态。
    const initialRevision = stateRevision;
    Promise.resolve().then(() => api.getState()).then(value => {
        if (stateRevision === initialRevision && !accept(value)) showFailure();
    }).catch(() => { if (stateRevision === initialRevision) showFailure(); });
    for (const button of buttons) button.addEventListener('click', async () => {
        if (button.disabled) return;
        const request = ++actionRevision, revision = stateRevision;
        try {
            const value = await api.act(button.dataset.action);
            if (request === actionRevision && revision === stateRevision && value !== undefined) {
                if (!accept(value)) showFailure();
            }
        } catch (_) { if (request === actionRevision && revision === stateRevision) showFailure(); }
    });
    window.addEventListener('unload', () => { if (typeof unsubscribe === 'function') unsubscribe(); }, { once: true });
})();
