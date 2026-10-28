// ==========================================
// TelSync Frontend - Incremental DOM Update
// ==========================================

async function apiRequest(url, options) {
    const response = await fetch(url, options);
    let result;
    try {
        result = await response.json();
    } catch (_) {
        throw new Error(`服务器返回无效响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
        throw new Error(result.message || `请求失败（HTTP ${response.status}）`);
    }
    return result;
}

const API = {
    getConfig: () => apiRequest('/api/config'),
    saveConfig: (data) => apiRequest('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    testConnection: () => apiRequest('/api/test-connection', { method: 'POST' }),
    getTrees: () => apiRequest('/api/trees'),
    initialTrees: () => apiRequest('/api/trees/initial', { method: 'POST' }),
    refreshTrees: () => apiRequest('/api/trees/refresh', { method: 'POST' }),
    refreshLocalTrees: () => apiRequest('/api/trees/local', { method: 'POST' }),
    enqueueDownload: (path) => apiRequest('/api/download/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }),
    deleteLocalFile: (path) => apiRequest('/api/download/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }),
    downloadStatus: () => apiRequest('/api/download/status'),
    cancelDownload: (taskId) => apiRequest('/api/download/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) }),
    removeDownload: (taskId) => apiRequest('/api/download/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) }),
    retryDownload: (taskId) => apiRequest('/api/download/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId }) }),
    pauseAll: () => apiRequest('/api/download/pause-all', { method: 'POST' }),
    resumeAll: () => apiRequest('/api/download/resume-all', { method: 'POST' }),
    clearFailed: () => apiRequest('/api/download/clear-failed', { method: 'POST' }),
    clearAll: () => apiRequest('/api/download/clear-all', { method: 'POST' }),
    getInitStatus: () => apiRequest('/api/system/init-status'),
    getUpdateInfo: () => apiRequest('/api/system/update-info'),
    applyUpdate: () => apiRequest('/api/system/apply-update', { method: 'POST' }),
    getInstallProgress: () => apiRequest('/api/system/install-progress'),
    installAria2: (arch) => apiRequest('/api/system/install-aria2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arch }) }),
    uploadAria2: (formData) => apiRequest('/api/system/upload-aria2', { method: 'POST', body: formData })
};

// ===== 状态 =====
let expandedDirs = new Set();
try {
    const savedDirs = JSON.parse(localStorage.getItem('telsync_expandedDirs') || '[]');
    if (Array.isArray(savedDirs)) expandedDirs = new Set(savedDirs.filter(path => typeof path === 'string'));
} catch (_) { /* 损坏或不可访问的浏览器缓存不应阻止启动。 */ }
let downloadPollTimer = null;
let isRefreshing = false;
let currentDownloadTasks = [];
let currentDlFilter = 'all';
let currentUpdateInfo = null;

let cachedRemoteNodes = [];
let cachedLocalNodes = [];
let treeRendered = false; 
let lastSavedConfig = {};
let treeEvents = null;
let configSaveQueue = Promise.resolve();
let mainAppInitialized = false;

// ===== 初始化 =====
let appStatus = {};

document.addEventListener('DOMContentLoaded', async () => {
    initTooltips();
    // 基础鉴权状态
    try {
        const check = await API.getInitStatus();
        if (!check.success || !check.data) throw new Error(check.message || '初始化检查失败');
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
    } catch(e) {
        console.error('出厂检查出错', e);
        showToast('error', '初始化检查失败，可在设置中重试: ' + e.message);
    }

    document.getElementById('setupWizardModal').style.display = 'none';
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
            document.getElementById('maxConcurrent').value = data.max_concurrent_downloads || 2;
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
    }).catch(error => {
        setWizardStep(1);
        showToast('error', '加载配置失败: ' + error.message);
    });

    // 安装的是服务端核心，不能用浏览器所在电脑的架构判断。
    const archSelect = document.getElementById('wAria2ArchSelect');
    if (archSelect && status.aria2_arch) archSelect.value = status.aria2_arch;

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
                        appStatus.aria2_installed = true;
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
                } finally {
                    e.target.value = '';
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
            appStatus.aria2_installed = true;
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
    const maxConcurrent = Number(document.getElementById('maxConcurrent').value);
    const proxyUrl = document.getElementById('proxyUrl').value.trim();
    const proxyUser = document.getElementById('proxyUser').value.trim();
    const proxyPasswd = document.getElementById('proxyPasswd').value.trim();
    
    if (!localPath) {
        showToast('warn', '请填写本地下载保存路径');
        return;
    }
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 5) {
        showToast('warn', '最大并发下载数应为 1 至 5 的整数');
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
    if (mainAppInitialized) return;
    mainAppInitialized = true;
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => switchPage(btn.dataset.page));
    });
    document.getElementById('btnRefresh').addEventListener('click', refreshTrees);
    
    // 代理测试按钮
    document.getElementById('btnTestProxy')?.addEventListener('click', async () => {
        if (await autoSaveConfig()) showToast('info', '代理配置已保存，可通过下载任务检查代理连接。');
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

    document.getElementById('btnCheckUpdate')?.addEventListener('click', async () => {
        await loadUpdateInfo(true);
    });
    document.getElementById('btnInstallUpdate')?.addEventListener('click', applyUpdate);
    
    // 顶部操作栏事件
    document.getElementById('btnResumeAll')?.addEventListener('click', () => runDownloadAction(API.resumeAll, '已恢复全部下载'));
    document.getElementById('btnPauseAll')?.addEventListener('click', () => runDownloadAction(API.pauseAll, '已暂停全部下载'));
    document.getElementById('btnClearFailed')?.addEventListener('click', () => runDownloadAction(API.clearFailed, '已清理失败任务'));
    document.getElementById('btnForceClearAll')?.addEventListener('click', async () => { 
        if (await showConfirm('危险操作', '确定要强行中断并清空所有下载任务吗？', '强杀清空')) {
            await runDownloadAction(API.clearAll, '已清空任务队列');
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

    startDownloadPolling();
    connectTreeEvents();
    await loadConfig();
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

            await loadTreesOnStartup();
            loadUpdateInfo(false);
        }
    } catch (e) { console.error('加载配置失败:', e); }
}

async function loadUpdateInfo(showToastWhenNoUpdate) {
    const checkBtn = document.getElementById('btnCheckUpdate');
    if (checkBtn) {
        checkBtn.disabled = true;
        checkBtn.classList.add('loading');
    }

    try {
        const resp = await API.getUpdateInfo();
        if (!resp.success || !resp.data) {
            throw new Error(resp.message || '获取更新信息失败');
        }

        renderUpdateInfo(resp.data);
        if (showToastWhenNoUpdate) {
            showToast(
                resp.data.has_update ? 'success' : 'info',
                resp.data.has_update
                    ? `发现新版本 ${resp.data.latest_version}`
                    : '当前已是最新版本'
            );
        }
    } catch (e) {
        renderUpdateError(e.message);
        if (showToastWhenNoUpdate) {
            showToast('error', '检查更新失败：' + e.message);
        }
    } finally {
        if (checkBtn) {
            checkBtn.disabled = false;
            checkBtn.classList.remove('loading');
        }
    }
}

function localizeReleaseNotes(notes) {
    if (!notes) return '暂无发布说明。';
    return notes
        .replace(/\*\*Full Changelog\*\*/gi, '**完整更新日志**')
        .replace(/\bFull Changelog\b/gi, '完整更新日志')
        .replace(/\bWhat's Changed\b/gi, '更新内容')
        .replace(/\bBug Fixes\b/gi, '问题修复')
        .replace(/\bFeatures\b/gi, '新增功能')
        .replace(/\bNew Contributors\b/gi, '新增贡献者');
}

function renderUpdateInfo(info) {
    currentUpdateInfo = info;
    const statusBadge = document.getElementById('updateStatusBadge');
    const installBtn = document.getElementById('btnInstallUpdate');
    const publishedAt = info.published_at ? new Date(info.published_at).toLocaleString() : '--';

    document.getElementById('updateCurrentVersion').textContent = info.current_version || '--';
    document.getElementById('updateLatestVersion').textContent = info.latest_version || '--';
    document.getElementById('updatePublishedAt').textContent = publishedAt;
    document.getElementById('updateNotes').textContent = localizeReleaseNotes(info.release_notes);

    if (statusBadge) {
        if (info.has_update) {
            statusBadge.className = 'wizard-status-badge success';
            statusBadge.textContent = '有可用更新';
        } else {
            statusBadge.className = 'wizard-status-badge info';
            statusBadge.textContent = '已是最新版本';
        }
    }

    if (installBtn) {
        installBtn.style.display = info.has_update ? 'inline-flex' : 'none';
        installBtn.textContent = info.latest_version ? `安装 ${info.latest_version}` : '立即更新';
        installBtn.disabled = false;
    }
}

function renderUpdateError(message) {
    currentUpdateInfo = null;
    document.getElementById('updateCurrentVersion').textContent = '--';
    document.getElementById('updateLatestVersion').textContent = '--';
    document.getElementById('updatePublishedAt').textContent = '--';
    document.getElementById('updateNotes').textContent = message || '获取更新信息失败。';

    const statusBadge = document.getElementById('updateStatusBadge');
    if (statusBadge) {
        statusBadge.className = 'wizard-status-badge error';
        statusBadge.textContent = '检查失败';
    }

    const installBtn = document.getElementById('btnInstallUpdate');
    if (installBtn) {
        installBtn.style.display = 'none';
    }
}

async function applyUpdate() {
    const installBtn = document.getElementById('btnInstallUpdate');
    const statusBadge = document.getElementById('updateStatusBadge');
    if (!currentUpdateInfo?.has_update) {
        showToast('info', '当前已是最新版本');
        return;
    }

    try {
        if (installBtn) {
            installBtn.disabled = true;
            installBtn.classList.add('loading');
            installBtn.textContent = '正在更新...';
        }
        if (statusBadge) {
            statusBadge.className = 'wizard-status-badge info';
            statusBadge.textContent = '正在更新';
        }

        const resp = await API.applyUpdate();
        if (!resp.success) {
            throw new Error(resp.message || '自动更新失败');
        }

        showToast('success', resp.data || '更新已安装，服务正在重启');
        if (statusBadge) {
            statusBadge.className = 'wizard-status-badge success';
            statusBadge.textContent = '正在重启';
        }
    } catch (e) {
        showToast('error', '自动更新失败：' + e.message);
        if (installBtn) {
            installBtn.disabled = false;
            installBtn.classList.remove('loading');
            installBtn.textContent = currentUpdateInfo?.latest_version ? `安装 ${currentUpdateInfo.latest_version}` : '立即更新';
        }
        if (statusBadge) {
            statusBadge.className = 'wizard-status-badge success';
            statusBadge.textContent = '有可用更新';
        }
    }
}

async function loadTreesOnStartup() {
    try {
        const resp = await API.initialTrees();
        if (!resp.success || !resp.data) throw new Error(resp.message || '文件树加载失败');
        applyTreeResponse(resp.data);
        if (resp.message) showToast('warn', resp.message);
    } catch (e) {
        console.error('首次加载文件树失败:', e);
        showToast('error', '文件树加载失败：' + e.message);
        try {
            const resp = await API.getTrees();
            if (resp.success && resp.data) applyTreeResponse(resp.data);
        } catch (error) { console.error('读取文件树缓存失败:', error); }
    }
}

async function autoSaveConfig(el) {
    const values = {
        teldrive_url: document.getElementById('inputTeldriveUrl').value.trim(),
        access_token: document.getElementById('inputAccessToken').value.trim(),
        local_path: document.getElementById('inputLocalPath').value.trim(),
        max_concurrent_downloads: Number(document.getElementById('inputMaxConcurrent').value),
        proxy_url: document.getElementById('inputProxyUrl').value.trim(),
        proxy_user: document.getElementById('inputProxyUser').value.trim(),
        proxy_passwd: document.getElementById('inputProxyPasswd').value.trim(),
        rpc_allow_remote: document.getElementById('inputRpcListenAll').checked,
        rpc_secret: document.getElementById('inputRpcSecret').value.trim(),
    };
    const fieldNames = {
        inputTeldriveUrl: 'teldrive_url', inputAccessToken: 'access_token', inputLocalPath: 'local_path',
        inputMaxConcurrent: 'max_concurrent_downloads', inputProxyUrl: 'proxy_url', inputProxyUser: 'proxy_user',
        inputProxyPasswd: 'proxy_passwd', inputRpcListenAll: 'rpc_allow_remote', inputRpcSecret: 'rpc_secret',
    };
    const field = el && fieldNames[el.id];
    const data = field ? { [field]: values[field] } : values;
    if ('max_concurrent_downloads' in data && (!Number.isInteger(data.max_concurrent_downloads)
        || data.max_concurrent_downloads < 1 || data.max_concurrent_downloads > 5)) {
        showToast('warn', '最大并发下载数应为 1 至 5 的整数');
        return false;
    }

    // 逐项保存并串行应用，避免旧请求覆盖新输入或把尚未保存的 RPC 密码写回旧值。
    const pending = configSaveQueue.then(async () => {
        try {
            if (!Object.keys(data).some(key => data[key] !== lastSavedConfig[key])) return true;
            const resp = await API.saveConfig(data);
            if (!resp.success) throw new Error(resp.message || '自动保存失败');
            lastSavedConfig = { ...lastSavedConfig, ...data };

            const icon = el?.parentElement?.querySelector('.save-icon');
            if (icon) {
                icon.classList.add('show');
                setTimeout(() => icon.classList.remove('show'), 2000);
            }
            if (!lastSavedConfig.teldrive_url || !lastSavedConfig.access_token) setConnectionStatus(false);
            if (el && (el.id === 'inputRpcListenAll' || el.id === 'inputRpcSecret') && resp.data) {
                showToast('success', resp.data);
            }
            return true;
        } catch (e) {
            showToast('error', '自动保存失败: ' + e.message);
            return false;
        }
    });
    configSaveQueue = pending.then(() => undefined, () => undefined);
    return pending;
}

async function testConnection() {
    const btn = document.getElementById('btnTestConnection');
    const result = document.getElementById('testResult');
    btn.classList.add('loading'); btn.disabled = true;
    result.className = 'test-result'; result.style.display = 'none';
    try {
        // 先确保是最新的保存状态
        if (!await autoSaveConfig()) {
            result.className = 'test-result error';
            result.textContent = '配置保存失败，请修正后再测试连接';
            return;
        }
        
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
        setConnectionStatus(false);
    } finally { btn.classList.remove('loading'); btn.disabled = false; }
}

function setConnectionStatus(connected) {
    const el = document.getElementById('connectionIndicator');
    el.className = 'connection-indicator' + (connected ? ' connected' : '');
    setTooltip(el, connected ? '已连接' : '未连接');
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
            applyTreeResponse(resp.data);
            showToast('success', '文件树已刷新');
        } else { showToast('error', resp.message || '刷新失败'); }
    } catch (e) { showToast('error', '刷新失败: ' + e.message); }
    finally { btn.classList.remove('loading'); isRefreshing = false; }
}

function applyTreeResponse(data) {
    if ([...fileSelections.values()].some(state => state.gesture)) {
        pendingTreeResponse = data;
        return;
    }
    cachedRemoteNodes = data.remote || [];
    cachedLocalNodes = data.local || [];
    updateTreeRefreshTime(data.refreshed_at);
    renderRemoteTree(cachedRemoteNodes);
    renderLocalTree(cachedLocalNodes);
    treeRendered = true;
}

function updateTreeRefreshTime(refreshedAt) {
    const el = document.getElementById('treeRefreshTime');
    if (!el) return;
    if (!refreshedAt) {
        el.textContent = '上次刷新：--';
        return;
    }
    const date = new Date(refreshedAt);
    if (Number.isNaN(date.getTime())) {
        el.textContent = '上次刷新：--';
        return;
    }
    el.textContent = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    setTooltip(el, `上次刷新：${formatLocalDateTime(date)}`);
}

function formatLocalDateTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function connectTreeEvents() {
    if (treeEvents) {
        treeEvents.close();
    }
    treeEvents = new EventSource('/api/trees/events');
    treeEvents.addEventListener('trees_refreshed', async () => {
        try {
            await silentRefreshTrees();
        } catch (e) {
            console.error('Error refreshing trees on event:', e);
        }
    });
    treeEvents.onerror = (e) => {
        console.warn('文件树同步通道已断开，等待自动重连', e);
    };
}

// 页面卸载时清理资源
window.addEventListener('beforeunload', () => {
    if (treeEvents) {
        treeEvents.close();
        treeEvents = null;
    }
    if (downloadPollTimer) {
        clearInterval(downloadPollTimer);
        downloadPollTimer = null;
    }
});

// Selection belongs to each panel and survives progress updates and tree redraws.
const fileSelections = new Map();
let pendingTreeResponse = null;
let fileContextMenu = null;

function closeFileContextMenu(restoreFocus = false) {
    if (!fileContextMenu) return;
    const { element, state } = fileContextMenu;
    element.remove();
    fileContextMenu = null;
    if (restoreFocus) state.container.focus({ preventScroll: true });
}

function fileMenuPaths(state, action) {
    const nodes = new Map();
    const collect = entries => entries.forEach(node => { nodes.set(node.path, node); collect(node.children || []); });
    collect(state.container.id === 'remoteTree' ? cachedRemoteNodes : cachedLocalNodes);
    const downloads = buildDownloadMap();
    const needsDownload = node => node.is_dir
        ? (node.children || []).some(needsDownload)
        : !node.exists_locally && !['Queued', 'Downloading', 'Retrying', 'Paused'].includes(getStatusKey(downloads[node.path]?.status));
    return [...state.paths].filter(path => {
        const node = nodes.get(path);
        return node && (action === 'download' ? needsDownload(node) : state.container.id === 'localTree' || node.exists_locally);
    });
}

function openFileContextMenu(state, x, y) {
    closeFileContextMenu();
    hideTooltip();
    const menu = document.createElement('div');
    menu.className = 'file-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '文件操作');
    const header = document.createElement('div');
    header.className = 'file-context-header';
    header.textContent = state.paths.size === 1 ? [...state.paths][0].split('/').pop() : state.paths.size ? `已选 ${state.paths.size} 项` : '文件操作';
    menu.appendChild(header);
    const items = [];
    function item(label, action, { danger = false, disabled = false, shortcut = '' } = {}) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-context-item' + (danger ? ' danger' : '');
        button.setAttribute('role', 'menuitem');
        button.disabled = disabled;
        const text = document.createElement('span');
        text.textContent = label;
        button.appendChild(text);
        if (shortcut) {
            const hint = document.createElement('span');
            hint.className = 'context-shortcut';
            hint.textContent = shortcut;
            hint.setAttribute('aria-hidden', 'true');
            button.appendChild(hint);
        }
        button.addEventListener('click', () => { closeFileContextMenu(); action(); });
        menu.appendChild(button);
        items.push(button);
    }
    if (state.container.id === 'remoteTree') {
        const paths = fileMenuPaths(state, 'download');
        item('下载所选文件', () => runSelectedFileAction(state, 'download', paths), { disabled: state.busy || !paths.length });
    }
    const localPaths = fileMenuPaths(state, 'delete');
    if (state.container.id === 'localTree' || localPaths.length) {
        item('从本地删除', () => runSelectedFileAction(state, 'delete', localPaths), { danger: true, disabled: state.busy || !localPaths.length });
    }
    const divider = document.createElement('div');
    divider.className = 'file-context-divider';
    divider.setAttribute('role', 'separator');
    menu.appendChild(divider);
    item('全选', () => {
        state.paths = new Set(visibleFileRows(state.container).map(row => row.dataset.path));
        updateFileSelection(state);
        state.container.focus({ preventScroll: true });
    }, { disabled: state.busy, shortcut: 'Ctrl+A' });
    item('取消选择', () => {
        state.paths.clear();
        updateFileSelection(state);
        state.container.focus({ preventScroll: true });
    }, { disabled: state.busy || !state.paths.size, shortcut: 'Esc' });
    menu.addEventListener('contextmenu', event => event.preventDefault());
    menu.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            closeFileContextMenu();
            state.paths = new Set(visibleFileRows(state.container).map(row => row.dataset.path));
            updateFileSelection(state);
            state.container.focus({ preventScroll: true });
        } else if (event.key === 'Escape' || event.key === 'Tab') {
            if (event.key === 'Escape') event.preventDefault();
            event.stopPropagation();
            closeFileContextMenu(true);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const enabled = items.filter(button => !button.disabled);
            const current = enabled.indexOf(document.activeElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
                : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
            enabled[index]?.focus({ preventScroll: true });
        }
    });
    document.body.appendChild(menu);
    fileContextMenu = { element: menu, state };
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) + 'px';
    items.find(button => !button.disabled)?.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', event => {
    if (fileContextMenu && !fileContextMenu.element.contains(event.target)) closeFileContextMenu();
}, true);
document.addEventListener('scroll', () => closeFileContextMenu(), true);
window.addEventListener('resize', () => closeFileContextMenu());
window.addEventListener('blur', () => closeFileContextMenu());

function visibleFileRows(container) {
    return [...container.querySelectorAll('.tree-node-row')].filter(row => row.getClientRects().length > 0);
}

function updateFileSelection(state) {
    for (const row of state.container.querySelectorAll('.tree-node-row')) {
        const selected = state.paths.has(row.dataset.path);
        row.classList.toggle('is-selected', selected);
        row.setAttribute('aria-selected', String(selected));
    }
}

function restoreFileSelection(state) {
    const available = new Set([...state.container.querySelectorAll('.tree-node-row')].map(row => row.dataset.path));
    if (fileContextMenu?.state === state && [...state.paths].some(path => !available.has(path))) closeFileContextMenu();
    state.paths = new Set([...state.paths].filter(path => available.has(path)));
    updateFileSelection(state);
}

function selectFileRow(state, row, modifiers) {
    if (!modifiers.ctrlKey && !modifiers.metaKey) state.paths.clear();
    if (!row) return updateFileSelection(state);
    const path = row.dataset.path;
    const rows = visibleFileRows(state.container);
    const anchorIndex = rows.findIndex(item => item.dataset.path === state.anchor);
    const index = rows.indexOf(row);
    if (modifiers.shiftKey && anchorIndex >= 0) {
        rows.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1)
            .forEach(item => state.paths.add(item.dataset.path));
    } else {
        if (state.paths.has(path)) state.paths.delete(path);
        else state.paths.add(path);
        state.anchor = path;
    }
    updateFileSelection(state);
}

function ensureFileSelection(container) {
    if (fileSelections.has(container.id)) return fileSelections.get(container.id);
    container.tabIndex = 0;
    container.setAttribute('role', 'listbox');
    container.setAttribute('aria-label', container.id === 'remoteTree' ? '远程文件' : '本地文件');
    container.setAttribute('aria-multiselectable', 'true');
    const state = { container, paths: new Set(), anchor: null, busy: false, gesture: null };
    fileSelections.set(container.id, state);
    container.addEventListener('selectstart', event => event.preventDefault());
    container.addEventListener('dragstart', event => event.preventDefault());
    container.addEventListener('click', event => {
        if (state.suppressClick) { state.suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    container.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const row = visibleFileRows(container).find(row => state.paths.has(row.dataset.path));
            const bounds = (row || container).getBoundingClientRect();
            openFileContextMenu(state, bounds.left + 24, bounds.top + Math.min(bounds.height, 30));
            return;
        }
        if (event.key === 'Escape') { closeFileContextMenu(); state.paths.clear(); }
        else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            state.paths = new Set(visibleFileRows(container).map(row => row.dataset.path));
        } else return;
        updateFileSelection(state);
    });

    function moveSelection() {
        const g = state.gesture;
        if (!g?.dragging) return;
        const bounds = container.getBoundingClientRect();
        const x = Math.max(bounds.left, Math.min(g.x, bounds.right));
        const y = Math.max(bounds.top, Math.min(g.y, bounds.bottom));
        const startY = bounds.top + g.startContentY - container.scrollTop;
        const rect = { left: Math.min(g.startX, x), right: Math.max(g.startX, x), top: Math.min(startY, y), bottom: Math.max(startY, y) };
        g.box.style.left = rect.left + 'px';
        g.box.style.top = Math.max(bounds.top, rect.top) + 'px';
        g.box.style.width = (rect.right - rect.left) + 'px';
        g.box.style.height = (Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top)) + 'px';
        state.paths = new Set(g.basePaths);
        for (const row of visibleFileRows(container)) {
            const r = row.getBoundingClientRect();
            if (r.right >= rect.left && r.left <= rect.right && r.bottom >= rect.top && r.top <= rect.bottom) state.paths.add(row.dataset.path);
        }
        updateFileSelection(state);
    }
    function autoScroll() {
        const g = state.gesture;
        if (!g?.dragging) return;
        const bounds = container.getBoundingClientRect();
        const delta = g.y < bounds.top + 28 ? -12 : g.y > bounds.bottom - 28 ? 12 : 0;
        if (delta) { container.scrollTop += delta; moveSelection(); }
        g.frame = requestAnimationFrame(autoScroll);
    }
    function startDrag(g) {
        if (state.gesture !== g || g.dragging) return;
        g.dragging = true;
        container.setPointerCapture(g.id);
        g.box = document.createElement('div');
        g.box.className = 'file-selection-box';
        document.body.appendChild(g.box);
        container.classList.add('is-selecting');
        window.getSelection()?.removeAllRanges();
        moveSelection();
        g.frame = requestAnimationFrame(autoScroll);
    }
    container.addEventListener('pointerdown', event => {
        state.suppressClick = false;
        closeFileContextMenu();
        if (event.button !== 0 || !event.isPrimary || event.target.closest('button, .tree-toggle:not(.spacer)')) return;
        const row = event.target.closest('.tree-node-row');
        const bounds = container.getBoundingClientRect();
        // Leave the native scrollbar available.
        if (event.clientX >= bounds.left + container.clientWidth) return;
        const g = state.gesture = {
            id: event.pointerId, startX: event.clientX, startY: event.clientY,
            startContentY: event.clientY - bounds.top + container.scrollTop,
            x: event.clientX, y: event.clientY, row, modifiers: event,
            basePaths: event.ctrlKey || event.metaKey ? [...state.paths] : [], dragging: false, touch: event.pointerType === 'touch'
        };
        if (event.pointerType === 'touch') g.hold = setTimeout(() => startDrag(g), 350);
        else { event.preventDefault(); container.focus({ preventScroll: true }); }
    });
    container.addEventListener('pointermove', event => {
        const g = state.gesture;
        if (!g || g.id !== event.pointerId) return;
        g.x = event.clientX; g.y = event.clientY;
        if (!g.dragging && Math.hypot(g.x - g.startX, g.y - g.startY) > 5) {
            if (event.pointerType === 'touch') { clearTimeout(g.hold); return; }
            startDrag(g);
        }
        if (g.dragging) { event.preventDefault(); moveSelection(); }
    });
    container.addEventListener('touchmove', event => {
        if (state.gesture?.dragging && event.cancelable) event.preventDefault();
    }, { passive: false });
    function finishSelection(event) {
        const g = state.gesture;
        if (!g || g.id !== event.pointerId) return;
        clearTimeout(g.hold);
        cancelAnimationFrame(g.frame);
        if (event.type === 'pointerup' && !g.dragging) selectFileRow(state, g.row, g.modifiers);
        state.suppressClick = g.dragging;
        g.box?.remove();
        container.classList.remove('is-selecting');
        state.gesture = null;
        if (container.hasPointerCapture(g.id)) container.releasePointerCapture(g.id);
        if (pendingTreeResponse) { const data = pendingTreeResponse; pendingTreeResponse = null; applyTreeResponse(data); }
        if (event.type === 'pointerup' && g.touch && g.dragging) openFileContextMenu(state, g.x, g.y);
    }
    window.addEventListener('pointerup', finishSelection);
    window.addEventListener('pointercancel', finishSelection);
    container.addEventListener('lostpointercapture', finishSelection);
    container.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (state.gesture?.dragging) return;
        const row = event.target.closest('.tree-node-row');
        if (row && !state.paths.has(row.dataset.path)) {
            state.paths = new Set([row.dataset.path]);
            state.anchor = row.dataset.path;
            updateFileSelection(state);
        }
        openFileContextMenu(state, event.clientX, event.clientY);
    });
    updateFileSelection(state);
    return state;
}

async function runSelectedFileAction(state, action = state.container.id === 'localTree' ? 'delete' : 'download', requestedPaths = [...state.paths]) {
    if (state.busy) return;
    // A selected folder already includes its descendants.
    const paths = requestedPaths.filter(path => !requestedPaths.some(parent => path.startsWith(parent + '/')));
    if (!paths.length) return;
    const deleting = action === 'delete';
    if (deleting && !await showConfirm('删除本地文件', `确定永久删除所选的 ${paths.length} 项及文件夹内容吗？这不会影响云端。`, '确定删除')) return;
    state.busy = true;
    updateFileSelection(state);
    let succeeded = 0, added = 0;
    const errors = [];
    try {
        for (const path of paths) {
            try {
                const response = await (deleting ? API.deleteLocalFile(path) : API.enqueueDownload(path));
                if (!response.success) throw new Error(response.message || '操作失败');
                succeeded++;
                added += response.data?.added_count || 0;
                for (const selected of [...state.paths]) if (selected === path || selected.startsWith(path + '/')) state.paths.delete(selected);
            } catch (error) { errors.push(`${path}: ${error.message}`); }
        }
        if (succeeded) showToast('success', deleting ? `已删除 ${succeeded} 项` : `已加入 ${added} 个下载任务`);
        if (errors.length) showToast('error', `${errors.length} 项操作失败：${errors[0]}`);
        await pollDownloadStatus();
        await silentRefreshTrees();
    } finally { state.busy = false; updateFileSelection(state); }
}

function renderRemoteTree(nodes) {
    const container = document.getElementById('remoteTree');
    const selection = ensureFileSelection(container);
    container.innerHTML = '';
    if (!nodes || nodes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>远程目录为空</p></div>';
        document.getElementById('remoteStats').textContent = '--';
        restoreFileSelection(selection);
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
    restoreFileSelection(selection);
}

function renderLocalTree(nodes) {
    const container = document.getElementById('localTree');
    const selection = ensureFileSelection(container);
    container.innerHTML = '';
    
    // 合并下载队列中的虚拟节点，实现“排队中的文件在右侧以半透明显示”
    const dlMap = buildDownloadMap();
    const mergedNodes = mergeQueuedIntoLocal(nodes, dlMap);
    
    if (!mergedNodes || mergedNodes.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>本地目录为空</p></div>';
        document.getElementById('localStats').textContent = '--';
        restoreFileSelection(selection);
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
    restoreFileSelection(selection);
}

function mergeQueuedIntoLocal(localNodes, dlMap) {
    // 使用结构化克隆而不是JSON序列化
    const cloned = typeof structuredClone === 'function' ? structuredClone(localNodes || []) : JSON.parse(JSON.stringify(localNodes || []));
    for (const path in dlMap) {
        const task = dlMap[path];
        const statusKey = getStatusKey(task.status);
        if (statusKey === 'Completed' || statusKey === 'Failed' || statusKey === 'Cancelled') continue;

        if (!task.remote_path || task.remote_path === '/') continue; // 防止空路径
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
    row.setAttribute('role', 'option');
    row.dataset.path = node.path;
    if (node.is_dir) row.classList.add('is-dir');

    const dlTask = dlMap[node.path];
    const statusKey = dlTask ? getStatusKey(dlTask.status) : null;
    const isInQueue = statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying' || statusKey === 'Paused';
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
    setTooltip(name, node.path);
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
        setTooltip(delBtn, '从本地删除');
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteLocalItem(node.path, delBtn); });
        action.appendChild(delBtn);

        // 如果是文件夹依然可以附带加号，因为可能有新文件需要下载
        if (node.is_dir) {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn-action add';
            addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
            setTooltip(addBtn, '下载新增文件');
            addBtn.addEventListener('click', (e) => { e.stopPropagation(); enqueueDownload(node.path, addBtn); });
            action.appendChild(addBtn);
        }
    } else {
        // 未下载，显示加号
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-action add';
        addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
        setTooltip(addBtn, node.is_dir ? '下载整个目录' : '添加到下载队列');
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
        row.addEventListener('dblclick', (event) => { if (!event.target.closest('button, .tree-toggle')) clickHandler(); });
    }

    return div;
}

function buildLocalNode(node, dlMap) {
    const div = document.createElement('div');
    div.className = 'tree-node' + (node.is_dir ? ' folder-node' : '');

    const row = document.createElement('div');
    row.className = 'tree-node-row';
    row.setAttribute('role', 'option');
    row.dataset.path = node.path;
    if (node.is_dir) row.classList.add('is-dir');

    const dlTask = dlMap[node.path];
    const statusKey = dlTask ? getStatusKey(dlTask.status) : null;
    if (statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying' || statusKey === 'Paused') {
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
    setTooltip(name, node.path);
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

    if (statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying' || statusKey === 'Paused') {
        const pctEl = document.createElement('span');
        pctEl.className = 'tree-dl-percent';
        if (statusKey === 'Downloading' && dlTask && dlTask.total_size > 0) {
            pctEl.textContent = Math.round((dlTask.downloaded / dlTask.total_size) * 100) + '%';
        } else {
            pctEl.textContent = statusKey === 'Paused' ? '已暂停' : '队列中';
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
        row.addEventListener('dblclick', (event) => { if (!event.target.closest('button, .tree-toggle')) clickHandler(); });
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
        const isInQueue = statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying' || statusKey === 'Paused';

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
                    pctEl.textContent = statusKey === 'Paused' ? '已暂停' : '队列中';
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
        const isSyncing = statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying' || statusKey === 'Paused';
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
                pctEl.textContent = (isDownloading && dlTask.total_size > 0) ? Math.round((dlTask.downloaded / dlTask.total_size) * 100) + '%' : (statusKey === 'Paused' ? '已暂停' : '队列中');
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
            const localRow = [...document.querySelectorAll('#localTree .tree-node-row')].find(row => row.dataset.path === path);
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
            const remoteRow = [...document.querySelectorAll('#remoteTree .tree-node-row')].find(row => row.dataset.path === path);
            if (remoteRow) {
                const actionDiv = remoteRow.querySelector('.tree-action');
                if (actionDiv) {
                    actionDiv.innerHTML = '';
                    const addBtn = document.createElement('button');
                    addBtn.className = 'btn-action add';
                    addBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
                    setTooltip(addBtn, '添加到下载队列');
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
    if (childrenEl._anim) {
        childrenEl._anim.cancel();
        childrenEl.style.maxHeight = ''; // 清除内联样式
    }

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
            childrenEl.style.maxHeight = '';
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
            childrenEl.style.maxHeight = '';
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
let isPolling = false; // 防止重复轮询

async function pollDownloadStatus() {
    if (isPolling) return; // 防止并发轮询
    isPolling = true;

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
            if (statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Retrying' || statusKey === 'Paused') {
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
            try {
                const trees = await API.refreshLocalTrees();
                if (!trees.success || !trees.data) throw new Error(trees.message || '本地文件树刷新失败');
                applyTreeResponse(trees.data);
                activeTaskIds = currentActiveIds;
            } catch (error) { console.warn('本地文件树刷新失败，稍后重试', error); }
        } else {
            activeTaskIds = currentActiveIds;
        }

        // 增量更新进度相关的 UI 数据（百分比字，条，按钮），杜绝调用全量重绘防止闪屏
        if (treeRendered) {
            updateRemoteTreeProgress(dlMap);
            updateLocalTreeSyncState(dlMap);
        }

        // 更新导航角标
        updateNavBadge(tasks);

        // 更新下载队列页面
        renderDownloadPage(tasks);
    } catch (e) {
        console.error('Poll download status error:', e);
    } finally {
        isPolling = false;
    }
}



// 静默刷新文件树（不显示 toast，不影响 UI）
async function silentRefreshTrees() {
    try {
        const resp = await API.getTrees();
        if (resp.success && resp.data) {
            applyTreeResponse(resp.data);
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
        return s === 'Queued' || s === 'Downloading' || s === 'Retrying' || s === 'Paused';
    }).length;
    const badge = document.getElementById('navDownloadBadge');
    if (activeCount > 0) { badge.textContent = activeCount; badge.classList.add('visible'); }
    else { badge.classList.remove('visible'); }
}

function renderDownloadPage(tasks) {
    const counts = { downloading: 0, queued: 0, paused: 0, completed: 0, failed: 0 };
    for (const t of tasks) {
        const s = getStatusKey(t.status);
        if (s === 'Downloading') counts.downloading++;
        else if (s === 'Queued' || s === 'Retrying') counts.queued++;
        else if (s === 'Paused') counts.paused++;
        else if (s === 'Completed') counts.completed++;
        else if (s === 'Failed' || s === 'Cancelled') counts.failed++;
    }
    document.getElementById('statAll').textContent = tasks.length;
    document.getElementById('statDownloading').textContent = counts.downloading;
    document.getElementById('statQueued').textContent = counts.queued;
    document.getElementById('statPaused').textContent = counts.paused;
    document.getElementById('statFailed').textContent = counts.failed;

    // 按筛选条件过滤
    let filtered = [...tasks];
    if (currentDlFilter !== 'all') {
        const filterMap = {
            'downloading': ['Downloading'],
            'queued': ['Queued', 'Retrying'],
            'paused': ['Paused'],
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

    const order = { 'Downloading': 0, 'Queued': 1, 'Retrying': 2, 'Paused': 3, 'Failed': 4, 'Cancelled': 5, 'Completed': 6 };
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

function buildDownloadActionsHtml(taskId, statusKey) {
    const actions = [];
    const taskAttr = `data-task-id="${escapeHtml(taskId)}"`;
    if (statusKey === 'Queued' || statusKey === 'Downloading' || statusKey === 'Paused' || statusKey === 'Retrying') {
        actions.push(`<button class="btn-action cancel" ${taskAttr} onclick="cancelTask(this.dataset.taskId)" data-tooltip="取消任务">取消</button>`);
    } else {
        if (statusKey === 'Failed' || statusKey === 'Cancelled') {
            actions.push(`<button class="btn-action retry" ${taskAttr} onclick="retryTask(this.dataset.taskId)" data-tooltip="重试任务">重试</button>`);
        }
        if (statusKey === 'Completed' || statusKey === 'Failed' || statusKey === 'Cancelled') {
            actions.push(`<button class="btn-action remove" ${taskAttr} onclick="removeTask(this.dataset.taskId)" data-tooltip="移除记录">移除</button>`);
        }
    }

    return actions.join('');
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
        case 'Paused': statusLabel = '已暂停'; statusClass = 'status-paused'; break;
        case 'Downloading': statusLabel = `${percent}%`; statusClass = 'status-downloading'; break;
        case 'Completed': statusLabel = '已完成'; statusClass = 'status-completed'; break;
        case 'Failed': statusLabel = '失败'; statusClass = 'status-failed'; break;
        case 'Cancelled': statusLabel = '已取消'; statusClass = 'status-cancelled'; break;
        case 'Retrying': statusLabel = `重试 ${task.retry_count}/${task.max_retries}`; statusClass = 'status-retrying'; break;
        default: statusLabel = statusKey; statusClass = 'status-queued';
    }

    let speedText = statusKey === 'Downloading' && task.speed > 0 ? ` · ${formatSpeed(task.speed)}` : '';
    const actionsHtml = buildDownloadActionsHtml(task.id, statusKey);

    item.innerHTML = `
        <span class="download-item-icon">${getFileIcon({ name: task.file_name, is_dir: false })}</span>
        <div class="download-item-info">
            <div class="download-item-name">${escapeHtml(task.file_name)}</div>
            <div class="download-item-path" data-tooltip="${escapeHtml(task.remote_path)}">${escapeHtml(task.remote_path)}</div>
            <div class="download-item-meta">
                <span class="dl-meta-size">${formatSize(task.downloaded)} / ${formatSize(task.total_size)}${speedText}</span>
            </div>
            <div class="download-progress">
                <div class="download-progress-bar ${progressClass}" style="width: ${percent}%"></div>
            </div>
        </div>
        <span class="download-item-status ${statusClass}">${escapeHtml(statusLabel)}</span>
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
            case 'Paused': statusLabel = '已暂停'; statusClass = 'status-paused'; break;
            case 'Downloading': statusLabel = `${percent}%`; statusClass = 'status-downloading'; break;
            case 'Completed': statusLabel = '已完成'; statusClass = 'status-completed'; break;
            case 'Failed': statusLabel = '失败'; statusClass = 'status-failed'; break;
            case 'Cancelled': statusLabel = '已取消'; statusClass = 'status-cancelled'; break;
            case 'Retrying': statusLabel = `重试 ${task.retry_count}/${task.max_retries}`; statusClass = 'status-retrying'; break;
        }
        statusEl.className = 'download-item-status ' + statusClass;
        statusEl.textContent = statusLabel;
    }

    const actionsEl = el.querySelector('.download-item-actions');
    if (actionsEl) {
        actionsEl.innerHTML = buildDownloadActionsHtml(task.id, statusKey);
    }
}

async function runDownloadAction(action, successMessage) {
    try {
        const response = await action();
        if (!response.success) throw new Error(response.message || '操作失败');
        showToast('success', successMessage);
        await pollDownloadStatus();
        return true;
    } catch (error) {
        showToast('error', error.message || '操作失败');
        return false;
    }
}

async function cancelTask(taskId) {
    return runDownloadAction(() => API.cancelDownload(taskId), '已取消任务');
}

async function retryTask(taskId) {
    return runDownloadAction(() => API.retryDownload(taskId), '已重新加入队列');
}

async function removeTask(taskId) {
    return runDownloadAction(() => API.removeDownload(taskId), '已移除下载记录');
}

window.cancelTask = cancelTask;
window.retryTask = retryTask;
window.removeTask = removeTask;

// ===== 工具 =====
function buildDownloadMap() {
    const map = Object.create(null);
    const activeStates = ['Downloading', 'Queued', 'Retrying', 'Paused'];
    for (const task of currentDownloadTasks) {
        const previous = map[task.remote_path];
        if (!previous || activeStates.includes(getStatusKey(task.status))
            || !activeStates.includes(getStatusKey(previous.status))) {
            map[task.remote_path] = task;
        }
    }
    return map;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
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
    t.innerHTML = `<span class="toast-icon">${iconSvg}</span><span>${escapeHtml(message)}</span>`;
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

// A delegated tooltip also covers file rows and task buttons created after startup.
let tooltipElement = null;
let tooltipTarget = null;
let tooltipTimer = null;
let tooltipsInitialized = false;
let tooltipTouchInput = false;

function setTooltip(element, text) {
    element.dataset.tooltip = String(text ?? '');
    if (element.hasAttribute?.('title')) element.removeAttribute('title');
    if (element.tagName === 'BUTTON' && !element.getAttribute('aria-label')) {
        element.setAttribute('aria-label', element.dataset.tooltip);
    }
    if (tooltipTarget === element) hideTooltip();
}

function hideTooltip() {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
    if (tooltipTarget) {
        const descriptions = (tooltipTarget.getAttribute('aria-describedby') || '').split(/\s+/)
            .filter(id => id && id !== 'appTooltip');
        if (descriptions.length) tooltipTarget.setAttribute('aria-describedby', descriptions.join(' '));
        else tooltipTarget.removeAttribute('aria-describedby');
    }
    tooltipTarget = null;
    if (tooltipElement) {
        tooltipElement.classList.remove('is-visible');
        tooltipElement.setAttribute('aria-hidden', 'true');
    }
}

function initTooltips() {
    if (tooltipsInitialized) return;
    tooltipsInitialized = true;
    tooltipElement = document.createElement('div');
    tooltipElement.id = 'appTooltip';
    tooltipElement.className = 'app-tooltip';
    tooltipElement.setAttribute('role', 'tooltip');
    tooltipElement.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tooltipElement);

    function schedule(target) {
        if (!target || !target.dataset.tooltip || target === tooltipTarget) return;
        hideTooltip();
        tooltipTarget = target;
        tooltipTimer = setTimeout(() => {
            if (tooltipTarget !== target || !target.isConnected) return hideTooltip();
            const bounds = target.getBoundingClientRect();
            if (!bounds.width && !bounds.height) return hideTooltip();
            tooltipElement.textContent = target.dataset.tooltip;
            tooltipElement.setAttribute('aria-hidden', 'false');
            const box = tooltipElement.getBoundingClientRect();
            const width = document.documentElement.clientWidth;
            const height = document.documentElement.clientHeight;
            const left = Math.min(Math.max(10, bounds.left + (bounds.width - box.width) / 2), Math.max(10, width - box.width - 10));
            const top = bounds.bottom + box.height + 18 <= height ? bounds.bottom + 8 : Math.max(10, bounds.top - box.height - 8);
            tooltipElement.style.left = left + 'px';
            tooltipElement.style.top = top + 'px';
            const descriptions = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
            if (!descriptions.includes('appTooltip')) descriptions.push('appTooltip');
            target.setAttribute('aria-describedby', descriptions.join(' '));
            tooltipElement.classList.add('is-visible');
        }, 300);
    }
    document.addEventListener('pointerover', event => {
        if (event.pointerType === 'touch') return hideTooltip();
        tooltipTouchInput = false;
        schedule(event.target.closest?.('[data-tooltip]'));
    });
    document.addEventListener('pointerout', event => {
        if (tooltipTarget?.contains(event.target) && !tooltipTarget.contains(event.relatedTarget)) hideTooltip();
    });
    document.addEventListener('focusin', event => {
        if (!tooltipTouchInput) schedule(event.target.closest?.('[data-tooltip]'));
    });
    document.addEventListener('focusout', event => {
        if (tooltipTarget?.contains(event.target) && !tooltipTarget.contains(event.relatedTarget)) hideTooltip();
    });
    document.addEventListener('pointerdown', event => { tooltipTouchInput = event.pointerType === 'touch'; hideTooltip(); }, true);
    document.addEventListener('keydown', event => {
        tooltipTouchInput = false;
        if (event.key === 'Escape') hideTooltip();
    }, true);
    document.addEventListener('scroll', hideTooltip, true);
    document.addEventListener('contextmenu', hideTooltip, true);
    window.addEventListener('resize', hideTooltip);
}
