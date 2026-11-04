(() => {
  const api = window.pluginAPI;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const newId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let bookmarks = [];
  let projects = [];
  let activeId = '';
  let bookmarkEdit = -1;
  let projectEdit = '';
  let projectDirectory = '';
  let busy = false;

  function toast(message) {
    const element = $('#toast');
    element.textContent = String(message || '操作失败');
    element.classList.add('show');
    clearTimeout(element._timer);
    element._timer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  async function action(task) {
    if (busy) return;
    busy = true;
    try { await task(); } catch (error) { toast(error?.message || error); }
    finally { busy = false; }
  }

  function switchTab(tool) {
    $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tool === tool));
    $$('.panel').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tool));
    if (tool === 'project-launcher') renderProjects();
  }
  $$('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tool)));

  function normalizeUrl(raw) {
    // 书签只允许网页协议，避免旧数据或手工输入触发本地文件与脚本协议。
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw) && !/^localhost:\d+/i.test(raw)) throw new Error('仅支持 HTTP/HTTPS 网址');
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/i.test(raw);
    const candidate = /^https?:\/\//i.test(raw) ? raw : `${local ? 'http' : 'https'}://${raw}`;
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('请输入有效的 HTTP/HTTPS 网址');
    return url.href;
  }

  function renderBookmarks() {
    const query = $('#bmSearch').value.trim().toLocaleLowerCase();
    const visible = bookmarks.map((item, index) => ({ item, index })).filter(({ item }) =>
      [item.title, item.url, item.group].some(value => String(value || '').toLocaleLowerCase().includes(query)));
    $('#bmCount').textContent = `显示 ${visible.length} / ${bookmarks.length}`;
    $('#bmGrid').innerHTML = visible.length ? visible.map(({ item, index }) => `
      <div class="bm-card" data-index="${index}" title="${escapeHtml(item.url)}">
        <div class="bm-icon">${escapeHtml(String(item.title || '?').charAt(0).toUpperCase())}</div>
        <div class="bm-title">${escapeHtml(item.title)}</div>
        <div class="bm-url">${escapeHtml(item.url)}</div>
        ${item.group ? `<div class="bm-meta">${escapeHtml(item.group)}</div>` : ''}
        <div class="bm-actions"><button class="mini" data-action="open">打开</button><button class="mini" data-action="edit">编辑</button><button class="mini danger" data-action="delete">删除</button></div>
      </div>`).join('') : `<div class="empty"><strong>${query ? '没有匹配的书签' : '还没有书签'}</strong>${query ? '调整搜索词试试' : '在上方填写名称和网址，然后添加'}</div>`;
  }

  function resetBookmarkForm() {
    bookmarkEdit = -1;
    $('#bmTitle').value = '';
    $('#bmUrl').value = '';
    $('#bmGroup').value = '';
    $('#bmAdd').textContent = '添加书签';
    $('#bmCancel').hidden = true;
  }

  $('#bmGrid').addEventListener('click', event => action(async () => {
    const card = event.target.closest('.bm-card');
    if (!card) return;
    const index = Number(card.dataset.index);
    const item = bookmarks[index];
    if (!item) return;
    const operation = event.target.closest('[data-action]')?.dataset.action || 'open';
    if (operation === 'open') {
      await api.openExternal(normalizeUrl(item.url));
    } else if (operation === 'edit') {
      bookmarkEdit = index;
      $('#bmTitle').value = item.title;
      $('#bmUrl').value = item.url;
      $('#bmGroup').value = item.group || '';
      $('#bmAdd').textContent = '保存修改';
      $('#bmCancel').hidden = false;
      $('#bmTitle').focus();
    } else if (operation === 'delete' && confirm(`删除书签“${item.title}”？`)) {
      bookmarks.splice(index, 1);
      await api.storage.set('bookmarks', bookmarks);
      if (bookmarkEdit === index) resetBookmarkForm();
      renderBookmarks();
    }
  }));
  $('#bmAdd').addEventListener('click', () => action(async () => {
    const title = $('#bmTitle').value.trim();
    const group = $('#bmGroup').value.trim();
    if (!title) throw new Error('请填写书签名称');
    const url = normalizeUrl($('#bmUrl').value.trim());
    if (bookmarks.some((item, index) => index !== bookmarkEdit && item.url === url)) throw new Error('此网址已存在');
    const item = { title, url, group };
    if (bookmarkEdit < 0) bookmarks.unshift(item);
    else bookmarks[bookmarkEdit] = item;
    await api.storage.set('bookmarks', bookmarks);
    resetBookmarkForm();
    renderBookmarks();
  }));
  $('#bmCancel').addEventListener('click', resetBookmarkForm);
  $('#bmSearch').addEventListener('input', renderBookmarks);
  $('#bmUrl').addEventListener('keydown', event => { if (event.key === 'Enter') $('#bmAdd').click(); });

  function selectedProject() { return projects.find(project => project.id === activeId); }

  function renderProjects() {
    const query = $('#pjSearch').value.trim().toLocaleLowerCase();
    const visible = projects.filter(project => [project.name, project.command, project.directory]
      .some(value => String(value || '').toLocaleLowerCase().includes(query)));
    $('#pjCount').textContent = `显示 ${visible.length} / ${projects.length}`;
    $('#projList').innerHTML = visible.length ? visible.map(project => {
      const running = api.project.status(project.id).running;
      return `<div class="proj-item${project.id === activeId ? ' active' : ''}" data-id="${escapeHtml(project.id)}">
        <div class="info"><span class="pn${running ? ' running' : ''}">${escapeHtml(project.name)}</span><span class="pc">${escapeHtml(project.command)}</span><span class="pd" title="${escapeHtml(project.directory)}">${escapeHtml(project.directory)}</span></div>
      </div>`;
    }).join('') : `<div class="empty"><strong>${query ? '没有匹配的项目' : '还没有项目'}</strong>${query ? '调整搜索词试试' : '选择目录并填写启动命令，然后保存'}</div>`;
    renderProjectDetails();
  }

  function renderProjectDetails() {
    const project = selectedProject();
    const status = project ? api.project.status(project.id) : { running: false, pid: null, exitCode: null, logs: [] };
    $('#pjRun').disabled = !project || status.running;
    $('#pjStop').disabled = !project || !status.running;
    for (const id of ['pjOpenDir', 'pjEdit', 'pjDelete', 'pjClearLog']) $(`#${id}`).disabled = !project;
    const bar = $('#pjStatus');
    bar.classList.toggle('running', status.running);
    bar.querySelector('span:last-child').textContent = !project ? '未选择项目' : status.running ? `运行中 · PID ${status.pid}` : status.exitCode == null ? '未运行' : `已退出 · 代码 ${status.exitCode}`;
    const terminal = $('#pjTerminal');
    const stickToBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 32;
    const previousScroll = terminal.scrollTop;
    terminal.innerHTML = status.logs.length ? status.logs.map(line => `<div class="log-line ${line.kind === 'error' ? 'log-err' : line.kind === 'command' ? 'log-info' : ''}"><span class="note">${escapeHtml(line.time)} </span>${escapeHtml(line.text)}</div>`).join('') : '<div class="log-line log-info">暂无运行日志</div>';
    terminal.scrollTop = stickToBottom ? terminal.scrollHeight : previousScroll;
  }

  function resetProjectForm() {
    projectEdit = '';
    projectDirectory = '';
    $('#pjName').value = '';
    $('#pjCmd').value = '';
    $('#pjDir').textContent = '未选择';
    $('#pjAdd').textContent = '保存项目';
    $('#pjCancel').hidden = true;
  }

  $('#pjPickDir').addEventListener('click', () => {
    const directory = api.selectDirectory('选择项目目录');
    if (directory) { projectDirectory = directory; $('#pjDir').textContent = directory; }
  });
  $('#pjAdd').addEventListener('click', () => action(async () => {
    const name = $('#pjName').value.trim();
    const command = $('#pjCmd').value.trim();
    if (!name || !command || !projectDirectory) throw new Error('请填写名称、启动命令并选择目录');
    if (projectEdit && api.project.status(projectEdit).running) throw new Error('请先停止运行中的项目再修改');
    const item = { id: projectEdit || newId(), name, command, directory: projectDirectory };
    if (projectEdit) projects[projects.findIndex(project => project.id === projectEdit)] = item;
    else projects.unshift(item);
    activeId = item.id;
    await api.storage.set('projects', projects);
    resetProjectForm();
    renderProjects();
  }));
  $('#pjCancel').addEventListener('click', resetProjectForm);
  $('#pjSearch').addEventListener('input', renderProjects);
  $('#projList').addEventListener('click', event => {
    const row = event.target.closest('[data-id]');
    if (row) { activeId = row.dataset.id; renderProjects(); }
  });
  $('#pjRun').addEventListener('click', () => action(() => {
    const project = selectedProject();
    if (!project) throw new Error('请先选择项目');
    api.project.start(project);
    renderProjects();
    toast('已启动项目');
  }));
  $('#pjStop').addEventListener('click', () => action(() => {
    if (!activeId) return;
    api.project.stop(activeId);
    renderProjects();
    toast('已停止项目');
  }));
  $('#pjOpenDir').addEventListener('click', () => action(async () => {
    const error = await api.project.openDirectory(selectedProject().directory);
    if (error) throw new Error(error);
  }));
  $('#pjEdit').addEventListener('click', () => {
    const project = selectedProject();
    if (!project) return;
    projectEdit = project.id;
    projectDirectory = project.directory;
    $('#pjName').value = project.name;
    $('#pjCmd').value = project.command;
    $('#pjDir').textContent = project.directory;
    $('#pjAdd').textContent = '保存修改';
    $('#pjCancel').hidden = false;
    $('#pjName').focus();
  });
  $('#pjDelete').addEventListener('click', () => action(async () => {
    const project = selectedProject();
    if (!project) return;
    if (api.project.status(project.id).running) throw new Error('请先停止项目再删除');
    if (!confirm(`删除项目“${project.name}”？`)) return;
    projects = projects.filter(item => item.id !== project.id);
    activeId = projects[0]?.id || '';
    await api.storage.set('projects', projects);
    if (projectEdit === project.id) resetProjectForm();
    renderProjects();
  }));
  $('#pjClearLog').addEventListener('click', () => { if (activeId) { api.project.clearLogs(activeId); renderProjectDetails(); } });
  setInterval(() => {
    if (!$('[data-panel="project-launcher"]').classList.contains('active')) return;
    if (activeId) renderProjectDetails();
    $$('#projList [data-id]').forEach(row => row.querySelector('.pn')?.classList.toggle('running', api.project.status(row.dataset.id).running));
  }, 700);

  window.addEventListener('plugin-enter', event => {
    const detail = event.detail || {};
    const raw = detail.action?.payload || detail.action?.clipboardText || detail.payload || detail.clipboardText || '';
    const value = String(raw).trim();
    if (detail.toolId === 'project-launcher') switchTab('project-launcher');
    if (!value) return;
    if (/^https?:\/\//i.test(value)) { switchTab('bookmark-launcher'); $('#bmUrl').value = value; }
    else { switchTab('project-launcher'); $('#pjCmd').value = value; }
  });

  async function initialize() {
    try {
      const [savedBookmarks, savedProjects] = await Promise.all([api.storage.get('bookmarks'), api.storage.get('projects')]);
      bookmarks = Array.isArray(savedBookmarks) ? savedBookmarks.filter(item => item && typeof item.title === 'string' && typeof item.url === 'string') : [];
      projects = Array.isArray(savedProjects) ? savedProjects.filter(item => item && typeof item.name === 'string' && typeof item.command === 'string' && typeof item.directory === 'string') : [];
      if (projects.some(item => !item.id)) {
        // 旧版项目没有 ID；补齐后才能准确关联多项目的进程和日志。
        projects = projects.map(item => ({ ...item, id: item.id || newId() }));
        await api.storage.set('projects', projects);
      }
      activeId = projects[0]?.id || '';
      renderBookmarks();
      renderProjects();
    } catch (error) { toast(`读取数据失败：${error.message}`); }
  }
  initialize();
})();
