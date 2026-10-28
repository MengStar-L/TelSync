const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');

function makeElement() {
    const classes = new Set();
    return {
        id: '', value: '', checked: false, disabled: false, innerHTML: '', textContent: '', title: '', className: '',
        style: {}, dataset: {}, children: [], parentElement: null, attributes: {}, listeners: new Map(),
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
            toggle(name, value) { value ??= !classes.has(name); value ? classes.add(name) : classes.delete(name); },
        },
        addEventListener(name, handler, options) { this.listeners.set(name, { handler, options }); }, removeEventListener() {},
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name] ?? null; },
        removeAttribute(name) { delete this.attributes[name]; },
        append(...children) { children.forEach(child => this.appendChild(child)); },
        appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
        contains(target) { return this === target || this.children.some(child => child.contains(target)); },
        closest(selector) {
            if (selector.startsWith('.') && (this.className.split(/\s+/).includes(selector.slice(1)) || classes.has(selector.slice(1)))) return this;
            return this.parentElement?.closest(selector) || null;
        },
        focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; },
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 240, bottom: 300, width: 240, height: 300 }),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

function loadApp(options = {}) {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, Object.assign(makeElement(), { id, ownerDocument: document }));
        return elements.get(id);
    };
    const documentEvents = new Map();
    const document = {
        addEventListener(name, handler) {
            if (!documentEvents.has(name)) documentEvents.set(name, []);
            documentEvents.get(name).push(handler);
        },
        getElementById: element,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => Object.assign(makeElement(), { ownerDocument: document }),
        createDocumentFragment: () => Object.assign(makeElement(), { ownerDocument: document }),
    };
    document.body = Object.assign(makeElement(), { ownerDocument: document });
    element('inputMaxConcurrent').value = '2';
    const context = vm.createContext({
        document, console,
        localStorage: { getItem: () => options.savedDirs || null, setItem() {} },
        navigator: { userAgent: 'Windows' },
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, cancelAnimationFrame() {},
        fetch: options.fetch || (async () => { throw new Error('Unexpected network request'); }),
        structuredClone, innerWidth: 1024, innerHeight: 768,
    });
    context.window = context;
    context.windowEvents = new Map();
    context.addEventListener = (name, handler) => context.windowEvents.set(name, handler);
    vm.runInContext(source, context);
    return { context, element, document, documentEvents, evaluate: code => vm.runInContext(code, context) };
}

test('invalid persisted expansion state does not prevent the app loading', () => {
    const app = loadApp({ savedDirs: '{broken' });
    assert.equal(app.evaluate('expandedDirs.size'), 0);
    assert.equal(app.evaluate('typeof cancelTask'), 'function');
});

test('HTTP failures retain the server error instead of appearing successful', async () => {
    const app = loadApp({ fetch: async () => ({ ok: false, status: 400, json: async () => ({ message: '连接失败' }) }) });
    await assert.rejects(app.evaluate("API.testConnection()"), /连接失败/);
});

test('download actions report API failures and do not show success', async () => {
    const app = loadApp();
    const toasts = [];
    app.context.recordToast = (...args) => toasts.push(args);
    app.evaluate("showToast = recordToast; API.cancelDownload = async () => ({ success: false, message: '任务取消失败' });");
    assert.equal(await app.evaluate("cancelTask('a')"), false);
    assert.deepEqual(toasts, [['error', '任务取消失败']]);
});

test('autosave serializes changed fields and never overwrites a saved RPC password', async () => {
    const app = loadApp();
    const calls = [];
    let completeFirst;
    app.context.saveImpl = data => {
        calls.push(JSON.parse(JSON.stringify(data)));
        if (calls.length === 1) return new Promise(resolve => { completeFirst = resolve; });
        return Promise.resolve({ success: true });
    };
    app.evaluate("API.saveConfig = saveImpl;");
    app.element('inputRpcSecret').value = 'new-secret';
    const first = app.evaluate("autoSaveConfig(document.getElementById('inputRpcSecret'))");
    await Promise.resolve();
    app.element('inputAccessToken').value = 'new-token';
    const second = app.evaluate("autoSaveConfig(document.getElementById('inputAccessToken'))");
    await Promise.resolve();
    assert.equal(calls.length, 1);
    completeFirst({ success: true });
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(calls, [{ rpc_secret: 'new-secret' }, { access_token: 'new-token' }]);
    assert.equal(app.evaluate('lastSavedConfig.rpc_secret'), 'new-secret');
});

test('failed config saves stop the connection test', async () => {
    const app = loadApp();
    app.element('inputTeldriveUrl').value = 'https://example.test';
    let tested = false;
    app.context.markTested = () => { tested = true; };
    app.evaluate("API.saveConfig = async () => ({ success: false, message: '无法保存' }); API.testConnection = async () => { markTested(); return { success: true }; };");
    await app.evaluate('testConnection()');
    assert.equal(tested, false);
    assert.match(app.element('testResult').textContent, /保存失败/);
    assert.equal(app.element('btnTestConnection').disabled, false);
});

test('rendering keeps task order intact and active downloads win over old failed records', () => {
    const app = loadApp();
    app.evaluate("currentDownloadTasks = [{ id: 'old', remote_path: '/same', status: 'Failed' }, { id: 'new', remote_path: '/same', status: 'Downloading' }]; renderDownloadPage(currentDownloadTasks);");
    assert.equal(app.evaluate("currentDownloadTasks.map(task => task.id).join(',')"), 'old,new');
    app.evaluate('currentDownloadTasks.reverse()');
    assert.equal(app.evaluate("buildDownloadMap()['/same'].id"), 'new');
});

test('file names, paths and toast messages are rendered as text', () => {
    const app = loadApp();
    const item = app.evaluate("createDownloadItem({ id: 'a', status: 'Queued', file_name: '<img src=x onerror=alert(1)>', remote_path: '/a\"<b>', downloaded: 0, total_size: 1 })");
    assert.equal(item.innerHTML.includes('<img'), false);
    assert.match(item.innerHTML, /&lt;img/);
    assert.match(item.innerHTML, /&quot;&lt;b&gt;/);
    app.evaluate("showToast('error', '<script>bad()</script>')");
    assert.equal(app.element('toastContainer').children[0].innerHTML.includes('<script>'), false);
});

test('paused downloads have their own filter and remain cancellable', () => {
    const app = loadApp();
    app.evaluate("renderDownloadPage([{ id: 'p', status: 'Paused' }, { id: 'q', status: 'Queued' }]);");
    assert.equal(app.element('statPaused').textContent, 1);
    assert.equal(app.element('statQueued').textContent, 1);
    assert.match(app.evaluate("buildDownloadActionsHtml('p', 'Paused')"), /取消/);
    const paused = app.evaluate("createDownloadItem({ id: 'p', status: 'Paused', file_name: 'p', remote_path: '/p' })");
    assert.match(paused.innerHTML, /已暂停/);
});

test('setup selects the server architecture even from a Windows browser', async () => {
    const app = loadApp();
    app.evaluate("API.getConfig = async () => ({ success: false }); initSetupEvents({ aria2_installed: false, aria2_arch: 'linux-arm64' });");
    assert.equal(app.element('wAria2ArchSelect').value, 'linux-arm64');
    await Promise.resolve();
});

function selectionState(app, paths, containerId = 'remoteTree') {
    const container = app.element(containerId);
    const rows = paths.map(path => {
        const row = makeElement();
        row.className = 'tree-node-row';
        row.dataset.path = path;
        row.getClientRects = () => [{}];
        return row;
    });
    container.querySelectorAll = () => rows;
    const state = app.evaluate(`ensureFileSelection(document.getElementById(${JSON.stringify(containerId)}))`);
    app.context.selectionState = state;
    app.context.selectionRows = rows;
    return { state, rows };
}

function menuButton(app, label) {
    const menu = app.evaluate('fileContextMenu.element');
    return menu.children.find(child => child.attributes.role === 'menuitem' && child.children[0].textContent === label);
}

const flushActions = () => new Promise(resolve => setImmediate(resolve));

test('file selection supports Ctrl toggles and Shift ranges across visible files', () => {
    const app = loadApp();
    const { state, rows } = selectionState(app, ['/a', '/b', '/hidden', '/c']);
    rows[2].getClientRects = () => [];
    app.evaluate('selectFileRow(selectionState, selectionRows[0], {})');
    assert.deepEqual([...state.paths], ['/a']);
    app.evaluate('selectFileRow(selectionState, selectionRows[1], { ctrlKey: true })');
    assert.deepEqual([...state.paths], ['/a', '/b']);
    app.evaluate('selectFileRow(selectionState, selectionRows[0], { ctrlKey: true })');
    assert.deepEqual([...state.paths], ['/b']);
    app.evaluate('selectFileRow(selectionState, selectionRows[3], { shiftKey: true })');
    assert.deepEqual([...state.paths], ['/a', '/b', '/c']);
    assert.equal(rows[2].attributes['aria-selected'], 'false');
});

test('right-clicking a selected file preserves the group and an unselected file replaces it', () => {
    const app = loadApp();
    const { state, rows } = selectionState(app, ['/a', '/b', '/c']);
    state.paths = new Set(['/a', '/b']);
    let prevented = 0;
    const rightClick = state.container.listeners.get('contextmenu').handler;
    rightClick({ target: rows[1], clientX: 50, clientY: 60, preventDefault() { prevented++; } });
    assert.deepEqual([...state.paths], ['/a', '/b']);
    assert.equal(app.evaluate('fileContextMenu.element.children[0].textContent'), '已选 2 项');
    rightClick({ target: rows[2], clientX: 70, clientY: 80, preventDefault() { prevented++; } });
    assert.deepEqual([...state.paths], ['/c']);
    assert.equal(rows[0].attributes['aria-selected'], 'false');
    assert.equal(rows[2].attributes['aria-selected'], 'true');
    assert.equal(prevented, 2);
});

test('the download menu excludes existing files and active tasks including nested folders', () => {
    const app = loadApp();
    const paths = ['/missing', '/existing', '/queued', '/active', '/paused', '/retrying', '/failed', '/ready-folder', '/blocked-folder'];
    const { state } = selectionState(app, paths);
    state.paths = new Set(paths);
    app.evaluate(`
        cachedRemoteNodes = [
            { path: '/missing' }, { path: '/existing', exists_locally: true },
            { path: '/queued' }, { path: '/active' }, { path: '/paused' }, { path: '/retrying' }, { path: '/failed' },
            { path: '/ready-folder', is_dir: true, children: [{ path: '/ready-folder/new' }] },
            { path: '/blocked-folder', is_dir: true, children: [{ path: '/blocked-folder/done', exists_locally: true }] }
        ];
        currentDownloadTasks = [
            { remote_path: '/queued', status: 'Queued' }, { remote_path: '/active', status: 'Downloading' },
            { remote_path: '/paused', status: 'Paused' }, { remote_path: '/retrying', status: 'Retrying' },
            { remote_path: '/failed', status: 'Failed' }
        ];
    `);
    assert.deepEqual(Array.from(app.evaluate("fileMenuPaths(selectionState, 'download')")), ['/missing', '/failed', '/ready-folder']);
    state.paths = new Set(['/existing', '/queued', '/blocked-folder']);
    app.evaluate('openFileContextMenu(selectionState, 20, 20)');
    assert.equal(menuButton(app, '下载所选文件').disabled, true);
});

test('delete menu paths include actual local files and exclude virtual download rows', () => {
    const app = loadApp();
    const { state } = selectionState(app, ['/real', '/folder', '/virtual', '/gone'], 'localTree');
    state.paths = new Set(['/real', '/folder', '/virtual', '/gone']);
    app.evaluate("cachedLocalNodes = [{ path: '/real' }, { path: '/folder', is_dir: true, children: [{ path: '/folder/file' }] }]; currentDownloadTasks = [{ remote_path: '/virtual', status: 'Queued' }];");
    assert.deepEqual(Array.from(app.evaluate("fileMenuPaths(selectionState, 'delete')")), ['/real', '/folder']);
    state.paths = new Set(['/virtual']);
    app.evaluate('openFileContextMenu(selectionState, 20, 20)');
    assert.equal(menuButton(app, '从本地删除').disabled, true);
});

test('clicking the download menu calls the API only for eligible selected files', async () => {
    const app = loadApp();
    const { state } = selectionState(app, ['/new', '/done', '/queued']);
    state.paths = new Set(['/new', '/done', '/queued']);
    const calls = [];
    app.context.recordEnqueue = async path => { calls.push(path); return { success: true, data: { added_count: 1 } }; };
    app.evaluate(`
        cachedRemoteNodes = [{ path: '/new' }, { path: '/done', exists_locally: true }, { path: '/queued' }];
        currentDownloadTasks = [{ remote_path: '/queued', status: 'Queued' }];
        API.enqueueDownload = recordEnqueue;
        pollDownloadStatus = async () => {}; silentRefreshTrees = async () => {};
        openFileContextMenu(selectionState, 20, 20);
    `);
    menuButton(app, '下载所选文件').listeners.get('click').handler();
    await flushActions();
    assert.deepEqual(calls, ['/new']);
    assert.deepEqual([...state.paths], ['/done', '/queued']);
    assert.equal(app.evaluate('fileContextMenu'), null);
    assert.equal(state.busy, false);
});

test('Escape and outside clicks close the menu without clearing file selection', () => {
    const app = loadApp();
    const { state } = selectionState(app, ['/a', '/b']);
    state.paths = new Set(['/a', '/b']);
    app.evaluate('openFileContextMenu(selectionState, 20, 20)');
    const menu = app.evaluate('fileContextMenu.element');
    let prevented = false, stopped = false;
    menu.listeners.get('keydown').handler({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(app.evaluate('fileContextMenu'), null);
    assert.deepEqual([...state.paths], ['/a', '/b']);
    assert.equal(app.document.activeElement, state.container);
    assert.equal(app.document.body.contains(menu), false);
    app.evaluate('openFileContextMenu(selectionState, 20, 20)');
    for (const handler of app.documentEvents.get('pointerdown')) handler({ target: app.document.body });
    assert.equal(app.evaluate('fileContextMenu'), null);
    assert.deepEqual([...state.paths], ['/a', '/b']);
});

test('the context menu stays inside the viewport near either edge', () => {
    const app = loadApp();
    selectionState(app, ['/a']);
    app.evaluate('selectionState.paths.add("/a"); openFileContextMenu(selectionState, 1020, 760)');
    let menu = app.evaluate('fileContextMenu.element');
    assert.equal(menu.style.left, '776px');
    assert.equal(menu.style.top, '460px');
    app.evaluate('openFileContextMenu(selectionState, -30, -40)');
    menu = app.evaluate('fileContextMenu.element');
    assert.equal(menu.style.left, '8px');
    assert.equal(menu.style.top, '8px');
    assert.equal(app.document.body.children.filter(child => child.attributes.role === 'menu').length, 1);
});

test('touch scrolling is prevented only during drag selection and resumes after cancellation', () => {
    const app = loadApp();
    const container = app.element('remoteTree');
    container.hasPointerCapture = () => false;
    const state = app.evaluate("ensureFileSelection(document.getElementById('remoteTree'))");
    const listener = container.listeners.get('touchmove');
    assert.equal(listener.options.passive, false);
    let prevented = 0;
    const move = { cancelable: true, preventDefault() { prevented++; } };

    listener.handler(move);
    state.gesture = { id: 1, dragging: false };
    listener.handler(move);
    assert.equal(prevented, 0);

    state.gesture.dragging = true;
    listener.handler(move);
    assert.equal(prevented, 1);
    listener.handler({ ...move, cancelable: false });
    assert.equal(prevented, 1);

    app.context.windowEvents.get('pointercancel')({ type: 'pointercancel', pointerId: 1 });
    assert.equal(state.gesture, null);
    listener.handler(move);
    assert.equal(prevented, 1);
});

test('tree redraw restores surviving selections and removes deleted paths', () => {
    const app = loadApp();
    const { state, rows } = selectionState(app, ['/keep', '/other']);
    state.paths = new Set(['/keep', '/gone']);
    app.evaluate('restoreFileSelection(selectionState)');
    assert.deepEqual([...state.paths], ['/keep']);
    assert.equal(rows[0].attributes['aria-selected'], 'true');
});

test('batch downloads process selected parents once and retain failed selections', async () => {
    const app = loadApp();
    const { state } = selectionState(app, ['/folder', '/folder/a', '/failed']);
    state.paths = new Set(['/folder', '/folder/a', '/failed']);
    const calls = [];
    app.context.enqueue = async path => {
        calls.push(path);
        return path === '/failed' ? { success: false, message: '无法添加' } : { success: true, data: { added_count: 2 } };
    };
    app.evaluate('API.enqueueDownload = enqueue; pollDownloadStatus = async () => {}; silentRefreshTrees = async () => {};');
    await app.evaluate('runSelectedFileAction(selectionState)');
    assert.deepEqual(calls, ['/folder', '/failed']);
    assert.deepEqual([...state.paths], ['/failed']);
    assert.equal(state.busy, false);
});

test('clicking the delete menu respects cancelled confirmation', async () => {
    const app = loadApp();
    const { state } = selectionState(app, ['/local'], 'localTree');
    state.paths.add('/local');
    let deleted = false;
    app.context.markDeleted = () => { deleted = true; };
    app.evaluate('cachedLocalNodes = [{ path: "/local" }]; showConfirm = async () => false; API.deleteLocalFile = async () => { markDeleted(); return { success: true }; }; openFileContextMenu(selectionState, 20, 20);');
    menuButton(app, '从本地删除').listeners.get('click').handler();
    await flushActions();
    assert.equal(deleted, false);
    assert.deepEqual([...state.paths], ['/local']);
    assert.equal(state.busy, false);
});

test('the delete menu sends confirmed local targets and retains protected failures', async () => {
    const app = loadApp();
    const { state } = selectionState(app, ['/real', '/protected', '/virtual'], 'localTree');
    state.paths = new Set(['/real', '/protected', '/virtual']);
    const calls = [], toasts = [];
    app.context.recordDeletion = async path => {
        calls.push(path);
        return path === '/protected' ? { success: false, message: '该目录中有未完成下载，请先取消相关任务' } : { success: true };
    };
    app.context.recordToast = (...args) => toasts.push(args);
    app.evaluate(`
        cachedLocalNodes = [{ path: '/real' }, { path: '/protected' }];
        showConfirm = async () => true; API.deleteLocalFile = recordDeletion;
        showToast = recordToast; pollDownloadStatus = async () => {}; silentRefreshTrees = async () => {};
        openFileContextMenu(selectionState, 20, 20);
    `);
    menuButton(app, '从本地删除').listeners.get('click').handler();
    await flushActions();
    assert.deepEqual(calls, ['/real', '/protected']);
    assert.deepEqual([...state.paths], ['/protected', '/virtual']);
    assert.match(toasts.find(([type]) => type === 'error')[1], /未完成下载/);
    assert.equal(state.busy, false);
});

test('tree updates wait for an active selection gesture', () => {
    const app = loadApp();
    const { state } = selectionState(app, ['/a']);
    state.gesture = {};
    app.evaluate("fileSelections.set('remoteTree', selectionState); applyTreeResponse({ remote: [], local: [], refreshed_at: 'test' });");
    assert.equal(app.evaluate('pendingTreeResponse.refreshed_at'), 'test');
    assert.equal(app.evaluate('treeRendered'), false);
});

test('download completion rescans local files without a remote scan', async () => {
    const app = loadApp();
    const scans = [];
    app.context.recordScan = data => scans.push(data);
    app.evaluate(`
        treeRendered = true;
        activeTaskIds = new Set(['finishing']);
        API.downloadStatus = async () => ({ success: true, data: [{ id: 'finishing', status: 'Completed' }] });
        API.refreshLocalTrees = async () => { recordScan('local'); return { success: true, data: { remote: [], local: [] } }; };
        API.refreshTrees = async () => { throw new Error('Should not scan remote files'); };
        applyTreeResponse = data => recordScan(data);
        updateRemoteTreeProgress = () => {};
        updateLocalTreeSyncState = () => {};
    `);
    await app.evaluate('pollDownloadStatus()');
    assert.equal(scans[0], 'local');
    assert.equal(scans.length, 2);
    assert.equal(app.evaluate('activeTaskIds.size'), 0);
    assert.equal(app.element('statAll').textContent, 1);
});

test('a failed local rescan keeps download status visible and retries next poll', async () => {
    const app = loadApp();
    app.context.console = { ...console, warn() {} };
    let attempts = 0;
    app.context.failedScan = () => { attempts++; throw new Error('Local scan unavailable'); };
    app.evaluate(`
        treeRendered = true;
        activeTaskIds = new Set(['finishing']);
        API.downloadStatus = async () => ({ success: true, data: [{ id: 'finishing', status: 'Completed' }] });
        API.refreshLocalTrees = failedScan;
        updateRemoteTreeProgress = () => {};
        updateLocalTreeSyncState = () => {};
    `);
    await app.evaluate('pollDownloadStatus()');
    await app.evaluate('pollDownloadStatus()');
    assert.equal(attempts, 2);
    assert.equal(app.element('statAll').textContent, 1);
    assert.equal(app.evaluate('isPolling'), false);
});
