// ==========================================
// TelSync Frontend - Incremental DOM Update
// ==========================================

const API = {
    getConfig: () => fetch('/api/config').then(r => r.json()),
    saveConfig: (data) => fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json()),
    testConnection: () => fetch('/api/test-connection', { method: 'POST' }).then(r => r.json()),
    getTrees: () => fetch('/api/trees').then(r => r.json()),
    refreshTrees: () => fetch('/api/trees/refresh', { method: 'POST' }).then(r => r.json()),
    enqueueDownload: (path) => fetch('/api/download/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json()),
    deleteLocalFile: (path) => fetch('/api/download/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json()),
    downloadStatus: () => fetch('/api/download/status').then(r => r.json()),
    cancelDownload: (taskId) => fetch('/api/download/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) }).then(r => r.json()),
    retryDownload: (taskId) => fetch('/api/download/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) }).then(r => r.json()),
    pauseAll: () => fetch('/api/download/pause-all', { method: 'POST' }).then(r => r.json()),
    resumeAll: () => fetch('/api/download/resume-all', { method: 'POST' }).then(r => r.json()),
    clearFailed: () => fetch('/api/download/clear-failed', { method: 'POST' }).then(r => r.json()),
    clearAll: () => fetch('/api/download/clear-all', { method: 'POST' }).then(r => r.json()),
    getInitStatus: () => fetch('/api/system/init-status').then(r => r.json()),
    getInstallProgress: () => fetch('/api/system/install-progress').then(r => r.json()),
    installAria2: (arch) => fetch('/api/system/install-aria2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arch }) }).then(r => r.json()),
    uploadAria2: (formData) => fetch('/api/system/upload-aria2', { method: 'POST', body: formData }).then(r => r.json()),
    
    // config 侧接口用于保存向导配置
    getConfig: () => fetch('/api/config').then(r => r.json()),
    saveConfig: (cfg) => fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).then(r => r.json())
};

// ===== 状态 =====
let expandedDirs = new Set(JSON.parse(localStorage.getItem('telsync_expandedDirs') || '[]'));
let downloadPollTimer = null;
let isRefreshing = false;
let currentDownloadTasks = [];
let currentDlFilter = 'all';

let cachedRemoteNodes = [];
let cachedLocalNodes = [];
let treeRendered = false; 
let lastSavedConfig = {};

// ===== 初始化 =====
let appStatus = {};

document.addEventListener('DOMContentLoaded', async () => {
    // 基础鉴权状态
    try {
        const check = await API.getInitStatus();
        if (check.success) {
            appStatus = check.data;
            if (!appStatus.aria2_installed || !appStatus.app_configured) {
                document.getElementById('setupWizardModal').style.display = 'flex';
                initSetupEvents(appStatus);
                return; // 终止后续流程，等待配置完成后由 initSetupEvents 闭环
            } else {
                // 已全部配置，隐藏向导直接进入主应用
                document.getElementById('setupWizardModal').style.display = 'none';
            }
        }
    } catch(e) { console.error('出厂检查出错', e); }

    initMainApp();
});

function initSetupEvents(status) {
    // 加载已有配置到表单
    API.getConfig().then(cfgRes => {
        if (cfgRes.success && cfgRes.data) {
            const data = cfgRes.data;
            document.getElementById('teldriveUrl').value = data.teldrive_url || '';
            document.getElementById('teldriveToken').value = data.access_token || '';
            document.getElementById('localPath').value = data.local_path || '';
            document.getElementById('maxConcurrent').value = data.max_concurrent_downloads || 3;
            document.getElementById('proxyUrl').value = data.proxy_url || '';
            document.getElementById('proxyUser').value = data.proxy_user || '';
            document.getElementById('proxyPasswd').value = data.proxy_passwd || '';
            
            // 判断跳转到哪一步
            let stepToJump = 1;
            const hasStep1 = !!(data.teldrive_url && data.access_token);
            const hasStep2 = status.aria2_installed;
            const hasStep3 = !!(data.local_path);
            
            if (!hasStep1) {
                stepToJump = 1;
            } else if (!hasStep2) {
                stepToJump = 2;
            } else if (!hasStep3 || !status.app_configured) {
                stepToJump = 3;
            } else {
                stepToJump = 3;
            }
            
            setWizardStep(stepToJump);
            
            // 渲染已经安装好 Aria2 的 UI
            if (status.aria2_installed) {
                const badge = document.getElementById('wAria2InstallBadge');
                const text = document.getElementById('wAria2InstallText');
                const progress = document.getElementById('wAria2InstallProgress');
                const percent = document.getElementById('wAria2InstallPercent');
                const btnNext = document.getElementById('wAria2NextBtn');
                const btnAuto = document.getElementById('wAria2AutoBtn');
                const btnUpload = document.getElementById('wAria2UploadBtn');
                const archSelect = document.getElementById('wAria2ArchSelect');
                
                if (badge) {
                    badge.className = 'wizard-status-badge success';
                    badge.innerHTML = '<i class="ph ph-check-circle"></i> 已安装';
                }
                if (text) text.textContent = '检测到本地已有 Aria2 核心，已自动跳过下载';
                if (progress) progress.style.width = '100%';
                if (percent) percent.textContent = '100%';
                if (btnNext) btnNext.disabled = false;
                if (btnAuto) btnAuto.style.display = 'none';
                if (btnUpload) btnUpload.style.display = 'none';
                if (archSelect && archSelect.parentElement) archSelect.parentElement.style.display = 'none';
            }
        } else {
            setWizardStep(1);
        }
    });

    // 自动检测架构并设置默认选项
    const archSelect = document.getElementById('wAria2ArchSelect');
    if (archSelect) {
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('win')) {
            archSelect.value = 'win-x64';
        } else if (ua.includes('linux')) {
            if (ua.includes('aarch64') || ua.includes('arm')) {
                archSelect.value = 'linux-arm64';
            } else {
                archSelect.value = 'linux-x64';
            }
        }
    }

    const inputUpload = document.getElementById('uploadAria2Input');
    if(inputUpload) {
        inputUpload.addEventListener('change', async (e) => {
            if(e.target.files.length > 0) {
                const formData = new FormData();
                formData.append('file', e.target.files[0]);
                
                const badge = document.getElementById('wAria2InstallBadge');
                const text = document.getElementById('wAria2InstallText');
                const btnAuto = document.getElementById('wAria2AutoBtn');
                const btnUpload = document.getElementById('wAria2UploadBtn');
                
                btnAuto.disabled = true;
                btnUpload.disabled = true;
                badge.className = 'wizard-status-badge warning';
                badge.innerHTML = '<i class="ph ph-spinner ph-spin"></i> 上传中';
                text.textContent = '正在上传核心文件...';

                try {
                    const res = await API.uploadAria2(formData);
                    if(res.success) {
                        badge.className = 'wizard-status-badge success';
                        badge.innerHTML = '<i class="ph ph-check-circle"></i> 安装成功';
                        text.textContent = '离线核心部署完毕';
                        btnAuto.style.display = 'none';
                        btnUpload.style.display = 'none';
                        document.getElementById('wAria2NextBtn').disabled = false;
                        showToast('success', '本地核心上传完毕，子进程已自动启动');
                    } else {
                        badge.className = 'wizard-status-badge error';
                        badge.innerHTML = '<i class="ph ph-warning-circle"></i> 上传失败';
                        text.textContent = res.message;
                        btnAuto.disabled = false;
                        btnUpload.disabled = false;
                        showToast('error', '上传失败: ' + res.message);
                    }
                } catch(err) {
                    badge.className = 'wizard-status-badge error';
                    badge.innerHTML = '<i class="ph ph-warning-circle"></i> 上传异常';
                    text.textContent = err.message;
                    btnAuto.disabled = false;
                    btnUpload.disabled = false;
                    showToast('error', '上传错误: ' + err.message);
                }
            }
        });
    }
}

// ===== 向导逻辑 =====
window.setWizardStep = function(step) {
    document.querySelectorAll('.wizard-step').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.wizard-dot').forEach(el => el.classList.remove('active'));
    
    const stepEl = document.getElementById('wStep' + step);
    if (stepEl) stepEl.classList.add('active');
    
    for (let i = 1; i <= step; i++) {
        const dot = document.getElementById('dot' + i);
        if (dot) dot.classList.add('active');
    }
};

window.testTeldriveConfig = async function(btn) {
    const url = document.getElementById('teldriveUrl').value.trim();
    const token = document.getElementById('teldriveToken').value.trim();
    
    if (!url || !token) {
        showToast('warn', '请填写完整 TelDrive 地址和 Access Token');
        return;
    }
    
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> 验证中...';
    btn.disabled = true;
    
    try {
        const resp = await API.saveConfig({ teldrive_url: url, access_token: token });
        if (resp.success) {
            const testResp = await API.testConnection();
            if (testResp.success) {
                showToast('success', 'TelDrive 连接成功');
                if (appStatus.aria2_installed) {
                    setWizardStep(3);
                } else {
                    setWizardStep(2);
                }
            } else {
                showToast('error', '连接失败: ' + (testResp.message || '未知错误'));
            }
        } else {
            showToast('error', '保存配置失败: ' + (resp.message || '未知错误'));
        }
    } catch (e) {
        showToast('error', '验证异常: ' + e.message);
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
};

window.installAria2Core = async function() {
    const btnAuto = document.getElementById('wAria2AutoBtn');
    const btnUpload = document.getElementById('wAria2UploadBtn');
    const badge = document.getElementById('wAria2InstallBadge');
    const text = document.getElementById('wAria2InstallText');
    const progress = document.getElementById('wAria2InstallProgress');
    const percent = document.getElementById('wAria2InstallPercent');
    const btnNext = document.getElementById('wAria2NextBtn');

    btnAuto.disabled = true;
    btnUpload.disabled = true;
    
    badge.className = 'wizard-status-badge warning';
    badge.innerHTML = '<i class="ph ph-spinner ph-spin"></i> 下载中';
    text.textContent = '正在获取最新版核心...';
    
    let timer = setInterval(async () => {
        try {
            const pr = await API.getInstallProgress();
            if (pr.success && pr.data) {
                text.textContent = pr.data.message || '下载中...';
                if (pr.data.total > 0) {
                    const p = Math.round((pr.data.downloaded / pr.data.total) * 100);
                    progress.style.width = p + '%';
                    percent.textContent = p + '%';
                }
            }
        } catch(e) {}
    }, 1000);

    try {
        const archSelect = document.getElementById('wAria2ArchSelect');
        const arch = archSelect ? archSelect.value : 'win-x64';
        const resp = await API.installAria2(arch);
        clearInterval(timer);
        
        if (resp.success) {
            badge.className = 'wizard-status-badge success';
            badge.innerHTML = '<i class="ph ph-check-circle"></i> 安装成功';
            text.textContent = 'Aria2 核心已就绪';
            progress.style.width = '100%';
            percent.textContent = '100%';
            btnNext.disabled = false;
            btnAuto.style.display = 'none';
            btnUpload.style.display = 'none';
        } else {
            badge.className = 'wizard-status-badge error';
            badge.innerHTML = '<i class="ph ph-warning-circle"></i> 下载失败';
            text.textContent = resp.message || '未知错误';
            btnAuto.disabled = false;
            btnUpload.disabled = false;
        }
    } catch (e) {
        clearInterval(timer);
        badge.className = 'wizard-status-badge error';
        badge.innerHTML = '<i class="ph ph-warning-circle"></i> 异常';
        text.textContent = e.message;
        btnAuto.disabled = false;
        btnUpload.disabled = false;
    }
};

window.saveConfigAndStart = async function(btn) {
    const localPath = document.getElementById('localPath').value.trim();
    const maxConcurrent = parseInt(document.getElementById('maxConcurrent').value) || 3;
    const proxyUrl = document.getElementById('proxyUrl').value.trim();
    const proxyUser = document.getElementById('proxyUser').value.trim();
    const proxyPasswd = document.getElementById('proxyPasswd').value.trim();
    
    if (!localPath) {
        showToast('warn', '请填写本地下载保存路径');
        return;
    }
    
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-spinner ph-spin"></i> 保存中...';
    btn.disabled = true;
    
    try {
        const url = document.getElementById('teldriveUrl').value.trim();
        const token = document.getElementById('teldriveToken').value.trim();
        const resp = await API.saveConfig({ 
            teldrive_url: url, 
            access_token: token,
            local_path: localPath,
            max_concurrent_downloads: maxConcurrent,
            proxy_url: proxyUrl,
            proxy_user: proxyUser,
            proxy_passwd: proxyPasswd
        });
        
        if (resp.success) {
            showToast('success', '配置保存成功，系统启动');
            document.getElementById('setupWizardModal').style.display = 'none';
            initMainApp(); // 启动主程序
        } else {
            showToast('error', '保存配置失败: ' + (resp.message || '未知错误'));
        }
    } catch (e) {
        showToast('error', '保存异常: ' + e.message);
    } finally {
        btn.innerHTML = origHtml;
        btn.disabled = false;
    }
};

async function initMainApp() {
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => switchPage(btn.dataset.page));
    });
    document.getElementById('btnRefresh').addEventListener('click', refreshTrees);
    
    // 代理测试按钮
    document.getElementById('btnTestProxy')?.addEventListener('click', async () => {
        // 由于后端暂时没有专用的 test_proxy 接口，这里可以通过触发一次下载或者简单提示（这里以提示代替或调一个可用的测试口）
        showToast('info', '代理配置已保存。如需测试代理请尝试新建一个下载任务。');
    });

    document.getElementById('btnTestConnection').addEventListener('click', testConnection);
    
    // 输入框自动保存绑定
    const settingInputs = [
        'inputTeldriveUrl', 'inputAccessToken', 'inputLocalPath', 
        'inputMaxConcurrent', 'inputProxyUrl', 'inputProxyUser', 'inputProxyPasswd'
    ];
    settingInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            let debounceTimer = null;
            el.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => autoSaveConfig(el), 1000); // 防抖 1 秒
            });
            el.addEventListener('change', () => {
                clearTimeout(debounceTimer);
                autoSaveConfig(el);
            });
        }
    });

    const rpcListenAll = document.getElementById('inputRpcListenAll');
    if (rpcListenAll) {
        rpcListenAll.addEventListener('change', () => autoSaveConfig(rpcListenAll));
    }

    const rpcSecret = document.getElementById('inputRpcSecret');
    if (rpcSecret) {
        rpcSecret.addEventListener('change', () => autoSaveConfig(rpcSecret));
        rpcSecret.addEventListener('blur', () => autoSaveConfig(rpcSecret));
    }
    
    // 顶部操作栏事件
    document.getElementById('btnResumeAll')?.addEventListener('click', async () => { await API.resumeAll(); showToast('success', '已发送全部恢复请求'); pollDownloadStatus(); });
    document.getElementById('btnPauseAll')?.addEventListener('click', async () => { await API.pauseAll(); showToast('info', '已发送全部暂停请求'); pollDownloadStatus(); });
    document.getElementById('btnClearFailed')?.addEventListener('click', async () => { await API.clearFailed(); showToast('success', '已清理失败任务'); pollDownloadStatus(); });
    document.getElementById('btnForceClearAll')?.addEventListener('click', async () => { 
        if (await showConfirm('危险操作', '确定要强行中断并清空所有下载任务吗？', '强杀清空')) {
            await API.clearAll(); 
            showToast('success', '已清空任务队列'); 
            pollDownloadStatus();
        }
    });

    // 下载筛选按钮
    document.querySelectorAll('.dl-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.dl-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentDlFilter = btn.dataset.filter;
            renderDownloadPage(currentDownloadTasks);
        });
    });

    await loadConfig();
    startDownloadPolling();
    setInterval(silentRefreshTrees, 5 * 60 * 1000); // 每5分钟静默刷新对齐后端
}

// ===== 页面切换 =====
function switchPage(pageName) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('page' + capitalize(pageName)).classList.add('active');
    document.querySelector(`.nav-item[data-page="${pageName}"]`).classList.add('active');
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ===== 配置 =====
async function loadConfig() {
    try {
        const resp = await API.getConfig();
        if (resp.success && resp.data) {
            const c = resp.data;
            lastSavedConfig = { ...c };
            document.getElementById('inputTeldriveUrl').value = c.teldrive_url || '';
            document.getElementById('inputAccessToken').value = c.access_token || '';
            document.getElementById('inputLocalPath').value = c.local_path || '';
            document.getElementById('inputMaxConcurrent').value = c.max_concurrent_downloads || 2;
            document.getElementById('inputProxyUrl').value = c.proxy_url || '';
            document.getElementById('inputProxyUser').value = c.proxy_user || '';
            document.getElementById('inputProxyPasswd').value = c.proxy_passwd || '';
            document.getElementById('inputRpcListenAll').checked = !!c.rpc_allow_remote;
            document.getElementById('inputRpcSecret').value = c.rpc_secret || '';
            if (c.teldrive_url && c.access_token) setConnectionStatus(true);

            const treesResp = await API.getTrees();
            if (treesResp.success && treesResp.data) {
                cachedRemoteNodes = treesResp.data.remote || [];
                cachedLocalNodes = treesResp.data.local || [];
                if (cachedRemoteNodes.length > 0) {
                    renderRemoteTree(cachedRemoteNodes);
                    renderLocalTree(cachedLocalNodes);
                    treeRendered = true;
                }
            }
        }
    } catch (e) { console.error('加载配置失败:', e); }
}

async function autoSaveConfig(el) {
    const rpcSecretInput = document.getElementById('inputRpcSecret');
    const shouldUseLiveRpcSecret = el && (el.id === 'inputRpcSecret' || el.id === 'inputRpcListenAll');
    const rpcSecret = shouldUseLiveRpcSecret
        ? (rpcSecretInput?.value.trim() || '')
        : (lastSavedConfig.rpc_secret || '');

    const data = {
        teldrive_url: document.getElementById('inputTeldriveUrl').value.trim(),
        access_token: document.getElementById('inputAccessToken').value.trim(),
        local_path: document.getElementById('inputLocalPath').value.trim(),
        max_concurrent_downloads: parseInt(document.getElementById('inputMaxConcurrent').value) || 2,
        proxy_url: document.getElementById('inputProxyUrl').value.trim(),
        proxy_user: document.getElementById('inputProxyUser').value.trim(),
        proxy_passwd: document.getElementById('inputProxyPasswd').value.trim(),
        rpc_allow_remote: document.getElementById('inputRpcListenAll').checked,
        rpc_secret: rpcSecret,
    };
    
    try {
        const resp = await API.saveConfig(data);
        if (resp.success) {
            lastSavedConfig = { ...lastSavedConfig, ...data };

            if (el && el.parentElement) {
                const icon = el.parentElement.querySelector('.save-icon');
                if (icon) {
                    icon.classList.add('show');
                    setTimeout(() => icon.classList.remove('show'), 2000);
                }
            }
            if (data.teldrive_url && data.access_token) {
                setConnectionStatus(true);
            }
            if (el && (el.id === 'inputRpcListenAll' || el.id === 'inputRpcSecret') && resp.data) {
                showToast('success', resp.data);
            }
        } else {
            showToast('error', resp.message || '自动保存失败');
        }
    } catch (e) {
        showToast('error', '自动保存失败: ' + e.message);
    }
}

async function testConnection() {
    const btn = document.getElementById('btnTestConnection');
    const result = document.getElementById('testResult');
    btn.classList.add('loading'); btn.disabled = true;
    result.className = 'test-result'; result.style.display = 'none';
    try {
        // 先确保是最新的保存状态
        await autoSaveConfig(document.getElementById('inputTeldriveUrl'));
        
        const resp = await API.testConnection();
        if (resp.success) {
            result.className = 'test-result success';
            result.textContent = '✅ ' + (resp.data || '连接成功');
            setConnectionStatus(true);
        } else {
            result.className = 'test-result error';
            result.textContent = '❌ ' + (resp.message || '连接失败');
            setConnectionStatus(false);
        }
    } catch (e) {
        result.className = 'test-result error';
        result.textContent = '❌ 网络错误: ' + e.message;
    } finally { btn.classList.remove('loading'); btn.disabled = false; }
}

function setConnectionStatus(connected) {
    const el = document.getElementById('connectionIndicator');
    el.className = 'connection-indicator' + (connected ? ' connected' : '');
    el.title = connected ? '已连接' : '未连接';
}

// ===== 文件树 =====
async function refreshTrees() {
    if (isRefreshing) return;
    isRefreshing = true;
    const btn = document.getElementById('btnRefresh');
    btn.classList.add('loading');
    try {
        const resp = await API.refreshTrees();
        if (resp.success && resp.data) {
            cachedRemoteNodes = resp.data.remote || [];
            cachedLocalNodes = resp.data.local || [];
            renderRemoteTree(cachedRemoteNodes);
            renderLocalTree(cachedLocalNodes);
            treeRendered = true;
            showToast('success', '文件树已刷新');
        } else { showToast('error', resp.message || '刷新失败'); }
    } catch (e) { showToast('error', '刷新失败: ' + e.message); }
    finally { btn.classList.remove('loading'); isRefreshing = false; }
}

function renderRemoteTree(nodes) {
    const container = document.getElementById('remoteTree');
    container.innerHTML = '';
    if (!nodes || nodes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>远程目录为空</p></div>';
        document.getElementById('remoteStats').textContent = '--';
        return;
    }
    const stats = countNodes(nodes);
    document.getElementById('remoteStats').innerHTML = `
        <span class="stat-tag folder-tag">${getFileIcon({is_dir:true})} 文件夹 ${stats.folders}</span>
        <span class="stat-tag file-tag">${getFileIcon({name:'a.txt'})} 文件 ${stats.files}</span>
    `;
    const dlMap = buildDownloadMap();
    const frag = document.createDocumentFragment();
    nodes.forEach(n => frag.appendChild(buildRemoteNode(n, dlMap)));
    container.appendChild(frag);
}

function renderLocalTree(nodes) {
    const container = document.getElementById('localTree');
    container.innerHTML = '';
    
    // 合并下载队列中的虚拟节点，实现“排队中的文件在右侧以半透明显示”
    const dlMap = buildDownloadMap();
    const mergedNodes = mergeQueuedIntoLocal(nodes, dlMap);
    
    if (!mergedNodes || mergedNodes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>本地目录为空</p></div>';
        document.getElementById('localStats').textContent = '--';
        return;
    }
    const stats = countNodes(mergedNodes);
    document.getElementById('localStats').innerHTML = `
        <span class="stat-tag folder-tag">${getFileIcon({is_dir:true})} 文件夹 ${stats.folders}</span>
        <span class="stat-tag file-tag">${getFileIcon({name:'a.txt'})} 文件 ${stats.files}</span>
    `;
    const frag = document.createDocumentFragment();
    mergedNodes.forEach(n => frag.appendChild(buildLocalNode(n, dlMap)));
    container.appendChild(frag);
}

function mergeQueuedIntoLocal(localNodes, dlMap) {
    const cloned = JSON.parse(JSON.stringify(localNodes || []));
    for (const path in dlMap) {
        const task = dlMap[path];
        const statusKey = getStatusKey(task.status);
        if (statusKey === 'Completed' || statusKey === 'Failed' || statusKey === 'Cancelled') continue;
        
        const parts = task.remote_path.split('/').filter(p => p.length > 0);
        if (parts.length === 0) continue;
        
        const name = parts.pop();
        let currentNodes = cloned;
        let currentPath = '';
        
        // Ensure folders exist
        for (const p of parts) {
            currentPath += '/' + p;
            let dir = currentNodes.find(n => n.path === currentPath);
            if (!dir) {
                dir = { name: p, path: currentPath, is_dir: true, size: 0, children: [] };
                currentNodes.push(dir);
            }
            if (!dir.children) dir.children = [];
            currentNodes = dir.children;
        }
        
        // Ensure file exists
        if (!currentNodes.find(n => n.path === task.remote_path)) {
            currentNodes.push({
                name: name,
                path: task.remote_path,
                is_dir: false,
                size: task.total_size || 0,
                children: []
            });
        }
    }
    // Sort directories first, then alphabetically
    function sortTree(nodes) {
        nodes.sort((a, b) => {
            if (a.is_dir === b.is_dir) return a.name.localeCompare(b.name);
            return a.is_dir ? -1 : 1;
        });
        for (const n of nodes) {
            if (n.children) sortTree(n.children);
        }
    }
    sortTree(cloned);
    return cloned;
}

function buildRemoteNode(node, dlMap) {
    const div = document.createElement('div');
    div.className = 'tree-node' + (node.is_dir ? ' folder-node' : '');

    const row = document.createElement('div');
    row.className = 'tree-node-row';
    row.dataset.path = node.path;
    if (node.is_dir) row.classList.add('is-dir');

    const dlTask = dlMap[node.path];
    const statusKey = dlTask ? getStatusKey(dlTask.status) : null;
    const isInQueue = statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying';
    const isDownloading = statusKey === 'Downloading';

    // 内联进度条
    if (isDownloading && dlTask.total_size > 0) {
        const pct = Math.round((dlTask.downloaded / dlTask.total_size) * 100);
        const bg = document.createElement('div');
        bg.className = 'inline-progress-bg';
        bg.style.width = pct + '%';
        row.appendChild(bg);
    }

    // 展开/折叠
    const chevronSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="chevron"><polyline points="9 18 15 12 9 6"/></svg>`;
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    if (node.is_dir && node.children && node.children.length > 0) {
        toggle.innerHTML = chevronSvg;
        if (expandedDirs.has(node.path)) toggle.classList.add('expanded');
    } else { toggle.classList.add('spacer'); }
    row.appendChild(toggle);

    row.appendChild(makeIcon(node));

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    name.title = node.path;
    row.appendChild(name);

    if (!node.is_dir && node.size > 0) {
        const sz = document.createElement('span');
        sz.className = 'tree-size';
        sz.textContent = formatSize(node.size);
        row.appendChild(sz);
    }

    // 常驻操作按钮
    const action = document.createElement('div');
    action.className = 'tree-action';
    
    if (node.exists_locally) {
        // 已完成或本地存在，显示垃圾桶/减号
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-action delete';
        delBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
        delBtn.title = '从本地删除';
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteLocalItem(node.path, delBtn); });
        action.appendChild(delBtn);

        // 如果是文件夹依然可以附带加号，因为可能有新文件需要下载
        if (node.is_dir) {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn-action add';
            addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
            addBtn.title = '下载新增文件';
            addBtn.addEventListener('click', (e) => { e.stopPropagation(); enqueueDownload(node.path, addBtn); });
            action.appendChild(addBtn);
        }
    } else {
        // 未下载，显示加号
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-action add';
        addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
        addBtn.title = node.is_dir ? '下载整个目录' : '添加到下载队列';
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); enqueueDownload(node.path, addBtn); });
        action.appendChild(addBtn);
    }
    
    row.appendChild(action);

    div.appendChild(row);

    if (node.is_dir && node.children && node.children.length > 0) {
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'tree-children';
        if (!expandedDirs.has(node.path)) childrenDiv.classList.add('collapsed');
        node.children.forEach(child => childrenDiv.appendChild(buildRemoteNode(child, dlMap)));
        div.appendChild(childrenDiv);

        const clickHandler = () => toggleDir(node.path, toggle, childrenDiv);
        toggle.addEventListener('click', (e) => { e.stopPropagation(); clickHandler(); });
        row.addEventListener('click', clickHandler);
    }

    return div;
}

function buildLocalNode(node, dlMap) {
    const div = document.createElement('div');
    div.className = 'tree-node' + (node.is_dir ? ' folder-node' : '');

    const row = document.createElement('div');
    row.className = 'tree-node-row';
    row.dataset.path = node.path;
    if (node.is_dir) row.classList.add('is-dir');

    const dlTask = dlMap[node.path];
    const statusKey = dlTask ? getStatusKey(dlTask.status) : null;
    if (statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying') {
        row.classList.add('is-syncing');
    }

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    const chevronSvg = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="chevron"><polyline points="9 18 15 12 9 6"/></svg>`;
    const key = 'L:' + node.path;
    if (node.is_dir && node.children && node.children.length > 0) {
        toggle.innerHTML = chevronSvg;
        if (expandedDirs.has(key)) toggle.classList.add('expanded');
    } else { toggle.classList.add('spacer'); }
    row.appendChild(toggle);

    row.appendChild(makeIcon(node));

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.name;
    row.appendChild(name);

    if (!node.is_dir && node.size > 0) {
        const sz = document.createElement('span');
        sz.className = 'tree-size';
        sz.textContent = formatSize(node.size);
        row.appendChild(sz);
    }

    const action = document.createElement('div');
    action.className = 'tree-action';
    row.appendChild(action);

    if (statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying') {
        const pctEl = document.createElement('span');
        pctEl.className = 'tree-dl-percent';
        if (statusKey === 'Downloading' && dlTask && dlTask.total_size > 0) {
            pctEl.textContent = Math.round((dlTask.downloaded / dlTask.total_size) * 100) + '%';
        } else {
            pctEl.textContent = '队列中';
        }
        action.appendChild(pctEl);
        
        if (statusKey === 'Downloading' && dlTask && dlTask.total_size > 0) {
            const bg = document.createElement('div');
            bg.className = 'inline-progress-bg';
            bg.style.width = Math.round((dlTask.downloaded / dlTask.total_size) * 100) + '%';
            row.insertBefore(bg, row.firstChild);
        }
    }

    div.appendChild(row);

    if (node.is_dir && node.children && node.children.length > 0) {
        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'tree-children';
        if (!expandedDirs.has(key)) childrenDiv.classList.add('collapsed');
        node.children.forEach(child => childrenDiv.appendChild(buildLocalNode(child, dlMap)));
        div.appendChild(childrenDiv);

        const clickHandler = () => toggleDir(key, toggle, childrenDiv);
        toggle.addEventListener('click', (e) => { e.stopPropagation(); clickHandler(); });
        row.addEventListener('click', clickHandler);
    }

    return div;
}

function makeIcon(node) {
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = getFileIcon(node);
    return icon;
}

// ===== 增量更新：仅更新进度相关的 DOM 元素，不重建整棵树 =====
function updateRemoteTreeProgress(dlMap) {
    const rows = document.querySelectorAll('#remoteTree .tree-node-row[data-path]');
    for (const row of rows) {
        const path = row.dataset.path;
        const dlTask = dlMap[path];
        const statusKey = dlTask ? getStatusKey(dlTask.status) : null;
        const isDownloading = statusKey === 'Downloading';
        const isInQueue = statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying';

        // 更新或创建内联进度条背景
        let bg = row.querySelector('.inline-progress-bg');
        if (isDownloading && dlTask.total_size > 0) {
            const pct = Math.round((dlTask.downloaded / dlTask.total_size) * 100);
            if (!bg) {
                bg = document.createElement('div');
                bg.className = 'inline-progress-bg';
                row.insertBefore(bg, row.firstChild);
            }
            bg.style.width = pct + '%';
        } else if (bg) {
            bg.remove();
        }

        let actionDiv = row.querySelector('.tree-action');
        if (actionDiv) {
            let pctEl = actionDiv.querySelector('.tree-dl-percent');
            if (isInQueue || isDownloading) {
                actionDiv.querySelectorAll('.btn-action').forEach(b => b.style.display = 'none');
                if (!pctEl) {
                    pctEl = document.createElement('span');
                    pctEl.className = 'tree-dl-percent';
                    actionDiv.appendChild(pctEl);
                }
                if (isDownloading && dlTask.total_size > 0) {
                    pctEl.textContent = Math.round((dlTask.downloaded / dlTask.total_size) * 100) + '%';
                } else if (isInQueue) {
                    pctEl.textContent = '队列中';
                }
            } else {
                if (pctEl) pctEl.remove();
                actionDiv.querySelectorAll('.btn-action').forEach(b => b.style.display = '');
            }
        }
    }
}

function updateLocalTreeSyncState(dlMap) {
    const rows = document.querySelectorAll('#localTree .tree-node-row[data-path]');
    for (const row of rows) {
        const path = row.dataset.path;
        const dlTask = dlMap[path];
        const statusKey = dlTask ? getStatusKey(dlTask.status) : null;
        const isDownloading = statusKey === 'Downloading';
        const isSyncing = statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying';
        row.classList.toggle('is-syncing', isSyncing);
        
        let bg = row.querySelector('.inline-progress-bg');
        if (isDownloading && dlTask.total_size > 0) {
            const pct = Math.round((dlTask.downloaded / dlTask.total_size) * 100);
            if (!bg) {
                bg = document.createElement('div');
                bg.className = 'inline-progress-bg';
                row.insertBefore(bg, row.firstChild);
            }
            bg.style.width = pct + '%';
        } else if (bg) {
            bg.remove();
        }

        let actionDiv = row.querySelector('.tree-action');
        if (actionDiv) {
            let pctEl = actionDiv.querySelector('.tree-dl-percent');
            if (isSyncing) {
                if (!pctEl) {
                    pctEl = document.createElement('span');
                    pctEl.className = 'tree-dl-percent';
                    actionDiv.appendChild(pctEl);
                }
                pctEl.textContent = (isDownloading && dlTask.total_size > 0) ? Math.round((dlTask.downloaded / dlTask.total_size) * 100) + '%' : '队列中';
            } else {
                if (pctEl) pctEl.remove();
            }
        }
    }
}

// ===== 操作方法 =====
async function enqueueDownload(path, btn) {
    btn.classList.add('loading'); btn.disabled = true;
    try {
        const resp = await API.enqueueDownload(path);
        if (resp.success) {
            showToast('success', `已加入 ${resp.data.added_count} 个下载任务`);
            await pollDownloadStatus();
            // 只重建本地树以合并新加入队列的虚拟节点，不碰远程树以避免闪烁
            renderLocalTree(cachedLocalNodes);
        } else {
            showToast('error', resp.message || '添加失败');
        }
    } catch (e) {
        showToast('error', '添加失败: ' + e.message);
    } finally {
        btn.classList.remove('loading'); btn.disabled = false;
    }
}

function showConfirm(title, desc, okText = '确定', isDanger = true) {
    return new Promise(resolve => {
        const overlay = document.getElementById('confirmOverlay');
        if (!overlay) return resolve(window.confirm(title + '\n' + desc)); // 容错处理

        const titleEl = document.getElementById('confirmTitle');
        const descEl = document.getElementById('confirmDesc');
        const btnCancel = document.getElementById('btnConfirmCancel');
        const btnOk = document.getElementById('btnConfirmOk');

        titleEl.textContent = title;
        descEl.textContent = desc;
        btnOk.textContent = okText;
        
        btnOk.className = isDanger ? 'btn btn-primary btn-danger' : 'btn btn-primary';

        const close = (result) => {
            overlay.classList.remove('active');
            btnCancel.onclick = null;
            btnOk.onclick = null;
            resolve(result);
        };

        btnCancel.onclick = () => close(false);
        btnOk.onclick = () => close(true);

        overlay.classList.add('active');
    });
}

async function deleteLocalItem(path, btn) {
    const isConfirmed = await showConfirm('删除本地文件', '确定要从本地永久删除该项吗？这不会影响云端。', '确定删除');
    if (!isConfirmed) return;
    btn.classList.add('loading'); btn.disabled = true;
    try {
        const resp = await API.deleteLocalFile(path);
        if (resp.success) {
            showToast('success', resp.data || '已删除本地文件');
            
            // 本地文件树：擦除对应的节点，如果父级夹空了，一路向上清空
            const localRow = document.querySelector(`#localTree .tree-node-row[data-path="${path}"]`);
            if (localRow) {
                let current = localRow.parentElement;
                while (current && current.classList.contains('tree-node')) {
                    let container = current.parentElement;
                    current.remove();
                    if (container && container.classList.contains('tree-children') && container.childElementCount === 0) {
                        current = container.parentElement;
                    } else {
                        break;
                    }
                }
            }

            // 乐观更新：立即把远程树中该行的垃圾桶换成加号
            const remoteRow = document.querySelector(`#remoteTree .tree-node-row[data-path="${CSS.escape(path)}"]`);
            if (remoteRow) {
                const actionDiv = remoteRow.querySelector('.tree-action');
                if (actionDiv) {
                    actionDiv.innerHTML = '';
                    const addBtn = document.createElement('button');
                    addBtn.className = 'btn-action add';
                    addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
                    addBtn.title = '添加到下载队列';
                    addBtn.addEventListener('click', (e) => { e.stopPropagation(); enqueueDownload(path, addBtn); });
                    actionDiv.appendChild(addBtn);
                }
            }

            // 后台异步扫描兜底（不阻塞 UI）
            silentRefreshTrees();
        } else {
            showToast('error', resp.message || '删除失败');
        }
    } catch (e) {
        showToast('error', '删除失败: ' + e.message);
    } finally {
        btn.classList.remove('loading'); btn.disabled = false;
    }
}

function toggleDir(path, toggleEl, childrenEl) {
    const isExpanding = !expandedDirs.has(path);
    
    // 取消正在进行的动画以防连击
    if (childrenEl._anim) childrenEl._anim.cancel();

    if (isExpanding) {
        expandedDirs.add(path);
        toggleEl.classList.add('expanded');
        childrenEl.classList.remove('collapsed');
        const height = childrenEl.scrollHeight;
        
        childrenEl._anim = childrenEl.animate(
            [{ maxHeight: '0px', opacity: 0 }, { maxHeight: height + 'px', opacity: 1 }],
            { duration: 250, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
        );
        childrenEl._anim.onfinish = () => {
            childrenEl.style.maxHeight = 'none';
            delete childrenEl._anim;
        };
    } else {
        expandedDirs.delete(path);
        toggleEl.classList.remove('expanded');
        const height = childrenEl.scrollHeight;
        
        childrenEl._anim = childrenEl.animate(
            [{ maxHeight: height + 'px', opacity: 1 }, { maxHeight: '0px', opacity: 0 }],
            { duration: 200, easing: 'ease-out' }
        );
        childrenEl._anim.onfinish = () => {
            childrenEl.classList.add('collapsed');
            delete childrenEl._anim;
        };
    }
    localStorage.setItem('telsync_expandedDirs', JSON.stringify([...expandedDirs]));
}


function startDownloadPolling() {
    if (downloadPollTimer) clearInterval(downloadPollTimer);
    downloadPollTimer = setInterval(pollDownloadStatus, 2000);
}

let activeTaskIds = new Set();

async function pollDownloadStatus() {
    try {
        const resp = await API.downloadStatus();
        if (!resp.success || !resp.data) return;

        const tasks = resp.data;
        currentDownloadTasks = tasks;
        const dlMap = buildDownloadMap();

        // 检测是否有新完成的任务
        const currentActiveIds = new Set();
        for (const t of tasks) {
            const statusKey = getStatusKey(t.status);
            if (statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying') {
                currentActiveIds.add(t.id);
            }
        }
        
        let activeTasksChanged = currentActiveIds.size !== activeTaskIds.size;
        if (!activeTasksChanged) {
            for (const id of currentActiveIds) {
                if (!activeTaskIds.has(id)) { activeTasksChanged = true; break; }
            }
        }
        
        // 如果任务消失(比如下载完了)，或者有新的任务进入队列发生更替
        // 直接触发真实验证扫描，以替换原本依靠 DOM 伪造的按钮
        if (activeTasksChanged && treeRendered) {
            silentRefreshTrees();
        }

        activeTaskIds = currentActiveIds;

        // 增量更新进度相关的 UI 数据（百分比字，条，按钮），杜绝调用全量重绘防止闪屏
        if (treeRendered) {
            updateRemoteTreeProgress(dlMap);
            updateLocalTreeSyncState(dlMap);
        }

        // 更新导航角标
        updateNavBadge(tasks);

        // 更新下载队列页面
        renderDownloadPage(tasks);
    } catch (e) { /* silent */ }
}



// 静默刷新文件树（不显示 toast，不影响 UI）
async function silentRefreshTrees() {
    try {
        const resp = await API.refreshTrees();
        if (resp.success && resp.data) {
            cachedRemoteNodes = resp.data.remote || [];
            cachedLocalNodes = resp.data.local || [];
            renderRemoteTree(cachedRemoteNodes);
            renderLocalTree(cachedLocalNodes);
            // 重建 DOM 后立即补刷进度覆盖，防止按钮/百分比在两次轮询间跳动
            const dlMap = buildDownloadMap();
            updateRemoteTreeProgress(dlMap);
            updateLocalTreeSyncState(dlMap);
        }
    } catch (e) { /* silent */ }
}

function updateNavBadge(tasks) {
    const activeCount = tasks.filter(t => {
        const s = getStatusKey(t.status);
        return s === 'Queued' || s === 'Downloading' || s === 'Retrying';
    }).length;
    const badge = document.getElementById('navDownloadBadge');
    if (activeCount > 0) { badge.textContent = activeCount; badge.classList.add('visible'); }
    else { badge.classList.remove('visible'); }
}

function renderDownloadPage(tasks) {
    const counts = { downloading: 0, queued: 0, completed: 0, failed: 0 };
    for (const t of tasks) {
        const s = getStatusKey(t.status);
        if (s === 'Downloading') counts.downloading++;
        else if (s === 'Queued' || s === 'Retrying') counts.queued++;
        else if (s === 'Completed') counts.completed++;
        else if (s === 'Failed') counts.failed++;
    }
    document.getElementById('statAll').textContent = tasks.length;
    document.getElementById('statDownloading').textContent = counts.downloading;
    document.getElementById('statQueued').textContent = counts.queued;
    document.getElementById('statFailed').textContent = counts.failed;

    // 按筛选条件过滤
    let filtered = tasks;
    if (currentDlFilter !== 'all') {
        const filterMap = {
            'downloading': ['Downloading'],
            'queued': ['Queued', 'Retrying'],
            'completed': ['Completed'],
            'failed': ['Failed', 'Cancelled']
        };
        const allowedStatuses = filterMap[currentDlFilter] || [];
        filtered = tasks.filter(t => allowedStatuses.includes(getStatusKey(t.status)));
    }

    const container = document.getElementById('downloadListFull');
    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>暂无匹配的下载任务</p></div>';
        return;
    }

    const order = { 'Downloading': 0, 'Queued': 1, 'Retrying': 2, 'Failed': 3, 'Cancelled': 4, 'Completed': 5 };
    filtered.sort((a, b) => (order[getStatusKey(a.status)] ?? 9) - (order[getStatusKey(b.status)] ?? 9));

    // 增量更新下载列表
    const existingItems = container.querySelectorAll('.download-item');
    const existingMap = {};
    existingItems.forEach(el => { existingMap[el.dataset.taskId] = el; });

    const frag = document.createDocumentFragment();
    let needsRebuild = false;

    // 检查是否顺序或数量发生变化
    if (existingItems.length !== filtered.length) needsRebuild = true;
    if (!needsRebuild) {
        for (let i = 0; i < filtered.length; i++) {
            if (existingItems[i]?.dataset.taskId !== filtered[i].id) { needsRebuild = true; break; }
        }
    }

    if (needsRebuild) {
        container.innerHTML = '';
        for (const task of filtered) {
            container.appendChild(createDownloadItem(task));
        }
    } else {
        // 仅更新每个 item 的进度
        for (const task of filtered) {
            const el = existingMap[task.id];
            if (el) updateDownloadItem(el, task);
        }
    }
}

function createDownloadItem(task) {
    const statusKey = getStatusKey(task.status);
    const item = document.createElement('div');
    item.className = 'download-item';
    item.dataset.taskId = task.id;

    const percent = task.total_size > 0 ? Math.round((task.downloaded / task.total_size) * 100) : 0;
    const progressClass = statusKey === 'Completed' ? 'complete' : (statusKey === 'Failed' ? 'failed' : (statusKey === 'Retrying' ? 'retrying' : ''));

    let statusLabel = '', statusClass = '';
    switch (statusKey) {
        case 'Queued': statusLabel = '排队中'; statusClass = 'status-queued'; break;
        case 'Downloading': statusLabel = `${percent}%`; statusClass = 'status-downloading'; break;
        case 'Completed': statusLabel = '已完成'; statusClass = 'status-completed'; break;
        case 'Failed': statusLabel = '失败'; statusClass = 'status-failed'; break;
        case 'Cancelled': statusLabel = '已取消'; statusClass = 'status-cancelled'; break;
        case 'Retrying': statusLabel = `重试 ${task.retry_count}/${task.max_retries}`; statusClass = 'status-retrying'; break;
        default: statusLabel = statusKey; statusClass = 'status-queued';
    }

    let speedText = statusKey === 'Downloading' && task.speed > 0 ? ` · ${formatSpeed(task.speed)}` : '';
    let actionsHtml = '';
    if (statusKey === 'Failed' || statusKey === 'Cancelled')
        actionsHtml = `<button class="btn-action retry" onclick="retryTask('${task.id}')" title="重试">🔄</button>`;
    else if (statusKey === 'Queued' || statusKey === 'Downloading')
        actionsHtml = `<button class="btn-action cancel" onclick="cancelTask('${task.id}')" title="取消">✕</button>`;

    item.innerHTML = `
        <span class="download-item-icon">${getFileIcon({ name: task.file_name, is_dir: false })}</span>
        <div class="download-item-info">
            <div class="download-item-name">${task.file_name}</div>
            <div class="download-item-path" title="${task.remote_path}">${task.remote_path}</div>
            <div class="download-item-meta">
                <span class="dl-meta-size">${formatSize(task.downloaded)} / ${formatSize(task.total_size)}${speedText}</span>
            </div>
            <div class="download-progress">
                <div class="download-progress-bar ${progressClass}" style="width: ${percent}%"></div>
            </div>
        </div>
        <span class="download-item-status ${statusClass}">${statusLabel}</span>
        <div class="download-item-actions">${actionsHtml}</div>
    `;
    return item;
}

function updateDownloadItem(el, task) {
    const statusKey = getStatusKey(task.status);
    const percent = task.total_size > 0 ? Math.round((task.downloaded / task.total_size) * 100) : 0;

    // 更新进度条
    const bar = el.querySelector('.download-progress-bar');
    if (bar) {
        bar.style.width = percent + '%';
        bar.className = 'download-progress-bar' + (statusKey === 'Completed' ? ' complete' : (statusKey === 'Failed' ? ' failed' : (statusKey === 'Retrying' ? ' retrying' : '')));
    }

    // 更新大小
    const meta = el.querySelector('.dl-meta-size');
    if (meta) {
        let speedText = statusKey === 'Downloading' && task.speed > 0 ? ` · ${formatSpeed(task.speed)}` : '';
        meta.textContent = `${formatSize(task.downloaded)} / ${formatSize(task.total_size)}${speedText}`;
    }

    // 更新状态标签
    const statusEl = el.querySelector('.download-item-status');
    if (statusEl) {
        let statusLabel = '', statusClass = '';
        switch (statusKey) {
            case 'Queued': statusLabel = '排队中'; statusClass = 'status-queued'; break;
            case 'Downloading': statusLabel = `${percent}%`; statusClass = 'status-downloading'; break;
            case 'Completed': statusLabel = '已完成'; statusClass = 'status-completed'; break;
            case 'Failed': statusLabel = '失败'; statusClass = 'status-failed'; break;
            case 'Cancelled': statusLabel = '已取消'; statusClass = 'status-cancelled'; break;
            case 'Retrying': statusLabel = `重试 ${task.retry_count}/${task.max_retries}`; statusClass = 'status-retrying'; break;
        }
        statusEl.className = 'download-item-status ' + statusClass;
        statusEl.textContent = statusLabel;
    }
}

async function cancelTask(taskId) {
    // 先从当前任务列表中找到该任务的 remote_path，以便同步清理 DOM
    const task = currentDownloadTasks.find(t => t.id === taskId);
    const remotePath = task ? task.remote_path : null;

    await API.cancelDownload(taskId);
    showToast('info', '任务已取消');

    if (remotePath) {
        // 清理本地树中对应的 DOM 节点，并级联删除空文件夹
        const localRow = document.querySelector(`#localTree .tree-node-row[data-path="${remotePath}"]`);
        if (localRow) {
            let current = localRow.parentElement;
            while (current && current.classList.contains('tree-node')) {
                let container = current.parentElement;
                current.remove();
                if (container && container.classList.contains('tree-children') && container.childElementCount === 0) {
                    current = container.parentElement;
                } else {
                    break;
                }
            }
        }

        // 重置远程树中对应节点的删除按钮为加号
        const remoteRows = document.querySelectorAll('#remoteTree .tree-node-row');
        remoteRows.forEach(row => {
            if (row.dataset.path === remotePath) {
                row.removeAttribute('data-completed');
                // 移除进度条
                const bg = row.querySelector('.inline-progress-bg');
                if (bg) bg.remove();
                // 重建操作按钮
                const actionDiv = row.querySelector('.tree-action');
                if (actionDiv) {
                    actionDiv.innerHTML = '';
                    const addBtn = document.createElement('button');
                    addBtn.className = 'btn-action add';
                    addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
                    addBtn.title = '加入下载队列';
                    addBtn.addEventListener('click', (e) => { e.stopPropagation(); enqueueDownload(row.dataset.path, addBtn); });
                    actionDiv.appendChild(addBtn);
                }
            }
        });
    }

    // 触发一次轮询以更新下载列表
    await pollDownloadStatus();
}
async function retryTask(taskId) { await API.retryDownload(taskId); showToast('info', '任务已重新入队'); }
window.cancelTask = cancelTask;
window.retryTask = retryTask;

// ===== 工具 =====
function buildDownloadMap() {
    const map = {};
    for (const t of currentDownloadTasks) map[t.remote_path] = t;
    return map;
}

function getStatusKey(status) {
    if (typeof status === 'string') return status;
    if (status && typeof status === 'object' && status.Failed !== undefined) return 'Failed';
    return 'Unknown';
}

function getFileIcon(node) {
    const svgBase = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
    if (node.is_dir) return `${svgBase} class="icon-folder" stroke="#10b981"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    
    const ext = (node.name || '').split('.').pop().toLowerCase();
    const color = 'stroke="#94a3b8"'; // 默认灰度
    if (['mp4','mkv','avi','mov','wmv','flv','webm','ts'].includes(ext)) 
        return `${svgBase} class="icon-video" ${color}><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`;
    if (['mp3','flac','wav','aac','ogg','m4a'].includes(ext)) 
        return `${svgBase} class="icon-audio" ${color}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    if (['jpg','jpeg','png','gif','bmp','webp','svg'].includes(ext)) 
        return `${svgBase} class="icon-image" ${color}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
    if (['zip','rar','7z','tar','gz','bz2','xz'].includes(ext)) 
        return `${svgBase} class="icon-archive" ${color}><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
    
    return `${svgBase} class="icon-document" ${color}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;
}

function countNodes(nodes) {
    let folders = 0, files = 0;
    for (const n of nodes) {
        if (n.is_dir) { folders++; const s = countNodes(n.children || []); folders += s.folders; files += s.files; }
        else files++;
    }
    return { folders, files };
}

const TOAST_ICONS = {
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    warn: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
};
function showToast(type, message) {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = 'toast';
    const iconSvg = TOAST_ICONS[type] || TOAST_ICONS.info;
    t.innerHTML = `<span class="toast-icon">${iconSvg}</span><span>${message}</span>`;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 250); }, 3000);
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bps) {
    if (bps < 1024) return Math.round(bps) + ' B/s';
    if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
    return (bps / 1048576).toFixed(1) + ' MB/s';
}
