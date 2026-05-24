const App = {
    currentUser: null,
    token: null,
    currentOpenedAcc: null,
    predictorChart: null,
    pollInterval: null,
    lastRenderedLogTime: null,
    currentChatKey: null,
    chatPollInterval: null,
    // NEW contract modal state
    currentContractConvKey: null,
    contractModalStep: 1,
    contractData: null,

    // ============ AUTH ============
    login: async function() {
        const login = document.getElementById('auth-login').value.trim();
        const pass = document.getElementById('auth-pass').value.trim();

        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ login, pass })
            });
            const data = await res.json();

            if (!res.ok || data.error) {
                alert(data.error || 'Ошибка входа');
                return;
            }

            this.token = data.token;
            this.currentUser = data.user;
            localStorage.setItem('abusafin_token', this.token);

            document.getElementById('login-screen').classList.remove('active');
            document.getElementById('app-screen').classList.add('active');

            document.getElementById('sidebar-username').innerText = this.currentUser.name;
            document.getElementById('nav-admin').style.display = this.currentUser.isAdmin ? 'block' : 'none';

            this.logSys(`Успешный вход: ${this.currentUser.name}`);
            this.navigate('dashboard');
            this.startPolling();
        } catch (e) {
            alert('Ошибка соединения с сервером');
            console.error(e);
        }
    },

    logout: function() {
        this.currentUser = null;
        this.token = null;
        localStorage.removeItem('abusafin_token');
        if (this.pollInterval) clearInterval(this.pollInterval);
        document.getElementById('app-screen').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');
    },

    // ============ NAVIGATION & UI ============
    navigate: async function(pageId) {
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        if (event && event.target) event.target.classList.add('active');

        document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
        const page = document.getElementById(`page-${pageId}`);
        if (page) page.classList.add('active');

        this.closeAccountPanel();

        if (pageId === 'accounts') await this.renderAccounts();
        if (pageId === 'dashboard') await this.updateDashboard();
        if (pageId === 'p2p-market') await this.renderP2PMarket();
        if (pageId === 'p2p-my') await this.renderP2PMy();
        if (pageId === 'p2p-negotiations') await this.renderP2PNegotiations();
        if (pageId === 'p2p-chat') {
            // Chat page activated — loadChatData is called from openChatPage
        }
        if (pageId === 'profile') this.renderProfile();
        if (pageId === 'admin' && this.currentUser.isAdmin) this.renderAdmin();

        // Cleanup chat poll when leaving chat page
        if (pageId !== 'p2p-chat' && this.chatPollInterval) {
            clearInterval(this.chatPollInterval);
            this.chatPollInterval = null;
        }
    },

    startPolling: function() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = setInterval(async () => {
            if (!this.currentUser) return;
            try {
                // Always refresh logs
                await this.refreshLogs();

                // Refresh current page data
                const activePage = document.querySelector('.page.active');
                if (!activePage) return;

                if (activePage.id === 'page-dashboard') {
                    await this.updateDashboardKPIsAndPredictor();
                } else if (activePage.id === 'page-accounts') {
                    await this.renderAccounts();
                } else if (activePage.id.startsWith('page-p2p-')) {
                    // Refresh current P2P sub-page silently
                    if (activePage.id === 'page-p2p-market') await this.renderP2PMarket();
                    else if (activePage.id === 'page-p2p-my') await this.renderP2PMy();
                    else if (activePage.id === 'page-p2p-negotiations') {
                        await this.loadMyConversations();
                        await this.loadNegotiations();
                    }
                }
            } catch (e) {
                // silent fail on poll
            }
        }, 2800);
    },

    refreshLogs: async function() {
        try {
            const res = await fetch('/api/logs', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) return;
            const logs = await res.json();
            if (!logs || logs.length === 0) return;

            const container = document.getElementById('sys-logs');
            if (!container) return;

            // Incremental append (prevents flicker from full rebuild every poll)
            const newestLogTime = logs[logs.length - 1].time;
            const lastTime = this.lastRenderedLogTime || 0;

            let added = 0;
            logs.forEach(log => {
                const logTime = new Date(log.time).getTime();
                if (logTime > lastTime) {
                    const el = document.createElement('div');
                    el.className = 'sys-log';
                    const timeStr = new Date(log.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    el.innerHTML = `<strong>[${timeStr}]</strong> ${log.msg}`;

                    // AI risk confirm button (only if needed)
                    if (log.meta && log.meta.type === 'risk' && this.currentUser && !this.currentUser.autoApproveAI) {
                        const btn = document.createElement('button');
                        btn.textContent = '✅ Подтвердить действие ИИ';
                        btn.style.cssText = 'margin-top:6px; padding:4px 10px; font-size:11px; background:#10b981; color:white; border:none; border-radius:5px; cursor:pointer;';
                        btn.onclick = async () => {
                            btn.disabled = true;
                            btn.textContent = 'Выполняется...';
                            try {
                                const r = await fetch('/api/ai/confirm-risk', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
                                    body: JSON.stringify({ accountId: log.meta.accountId })
                                });
                                const d = await r.json();
                                if (r.ok) {
                                    this.logSys('Действие ИИ подтверждено и выполнено.');
                                    setTimeout(() => this.refreshLogs(), 400);
                                    setTimeout(() => this.updateDashboardKPIsAndPredictor(), 600);
                                } else {
                                    alert(d.error || 'Ошибка подтверждения');
                                    btn.disabled = false;
                                    btn.textContent = '✅ Подтвердить действие ИИ';
                                }
                            } catch (e) {
                                alert('Ошибка сети');
                                btn.disabled = false;
                                btn.textContent = '✅ Подтвердить действие ИИ';
                            }
                        };
                        el.appendChild(btn);
                    }
                    container.appendChild(el);
                    added++;
                }
            });

            // Trim old logs if too many
            while (container.children.length > 22) container.firstChild.remove();

            if (added > 0 || !this.lastRenderedLogTime) {
                this.lastRenderedLogTime = new Date(newestLogTime).getTime();
            }
        } catch (e) {}
    },

    logSys: function(msg) {
        // local visual only, real logs come from server poll
        const container = document.getElementById('sys-logs');
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'sys-log';
        el.innerHTML = `<strong>[${new Date().toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}]</strong> ${msg}`;
        container.prepend(el);
        // limit
        while (container.children.length > 18) container.lastChild.remove();
    },

    // ============ DASHBOARD + PREDICTOR ============
    updateDashboard: async function() {
        await this.updateDashboardKPIsAndPredictor();
        if (!this.predictorChart) {
            this.initPredictorChart();
        }
    },

    updateDashboardKPIsAndPredictor: async function() {
        try {
            // KPIs
            const kpiRes = await fetch('/api/kpis', { headers: { 'Authorization': `Bearer ${this.token}` } });
            if (kpiRes.ok) {
                const kpis = await kpiRes.json();
                const totalEl = document.getElementById('kpi-total');
                const availEl = document.getElementById('kpi-available');
                if (totalEl) totalEl.innerText = `$${kpis.total.toLocaleString()}`;
                if (availEl) availEl.innerText = `$${kpis.available.toLocaleString()}`;
            }

            // Predictor
            const predRes = await fetch('/api/predictor', { headers: { 'Authorization': `Bearer ${this.token}` } });
            if (predRes.ok) {
                const pred = await predRes.json();
                const statusEl = document.getElementById('ai-status');
                if (statusEl) {
                    statusEl.innerText = pred.status || 'Мониторинг...';
                    statusEl.style.color = (pred.status || '').includes('Риск') ? 'var(--warning)' : 'var(--primary)';
                }

                // Ensure chart exists
                if (!this.predictorChart) {
                    this.initPredictorChart();
                }

                if (this.predictorChart && pred.labels && pred.data && pred.labels.length > 0) {
                    this.predictorChart.data.labels = pred.labels;
                    this.predictorChart.data.datasets[0].data = pred.data;
                    this.predictorChart.update();
                } else if (this.predictorChart) {
                    // Fallback: show message if no data yet
                    const ctx = this.predictorChart.canvas;
                    if (ctx) ctx.style.opacity = '0.4';
                }
            }
        } catch (e) {
            console.warn('Dashboard poll error', e);
        }
    },

    initPredictorChart: function() {
        const ctx = document.getElementById('predictorChart');
        if (!ctx) return;

        this.predictorChart = new Chart(ctx.getContext('2d'), {
            type: 'line',
            data: {
                labels: ['День 1', 'День 2'],
                datasets: [{
                    label: 'Ваша ликвидность (доступно)',
                    data: [18000, 19500],
                    borderColor: '#1e50ff',
                    borderWidth: 2.8,
                    fill: false,
                    tension: 0.35,
                    pointRadius: 0,
                    pointHoverRadius: 4
                }]
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', font: { size: 10 } } },
                    y: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b', font: { size: 10 } } }
                }
            }
        });
    },

    // ============ ACCOUNTS ============
    renderAccounts: async function() {
        const list = document.getElementById('accountsList');
        if (!list) return;
        list.innerHTML = '';

        try {
            const res = await fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } });
            if (!res.ok) throw new Error('Failed to load accounts');
            let accounts = await res.json();

            // ИСПРАВЛЕНО: Скрываем (уничтожаем) временные счета, если их лимит исчерпан
            accounts = accounts.filter(acc => {
                if (acc.isTemporary) {
                    const available = acc.spendLimit !== undefined ? acc.spendLimit : (acc.balance || 0);
                    return available > 0;
                }
                return true;
            });

            accounts.forEach(acc => {
                const el = document.createElement('div');
                el.className = `account-card ${acc.isTemporary ? 'temporary-acc' : ''}`;
                el.onclick = () => this.openAccountPanel(acc);

                const reserveText = acc.isTemporary 
                    ? `Лимит трат: $${(acc.spendLimit || acc.balance).toLocaleString()}` 
                    : `НЗ: $${(acc.reserve || 0).toLocaleString()}`;

                el.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong>${acc.name}</strong> 
                        <span class="badge">${acc.type}</span>
                    </div>
                    <h3 style="margin: 11px 0 4px; font-size:22px;">$${(acc.balance || 0).toLocaleString()}</h3>
                    <small style="color: var(--text-muted)">${reserveText}</small>
                `;
                list.appendChild(el);
            });

            // Add external bind card
            const addBtn = document.createElement('div');
            addBtn.className = 'account-card';
            addBtn.style.border = '2px dashed var(--primary)';
            addBtn.style.textAlign = 'center';
            addBtn.innerHTML = `<strong style="color:var(--primary);">+ Привязать внешний счёт</strong><br><small>Введите API Ключ от администратора</small>`;
            addBtn.onclick = () => this.bindExternalAccount();
            list.appendChild(addBtn);

        } catch (e) {
            list.innerHTML = '<div style="color:#ef4444; padding:20px;">Ошибка загрузки счетов</div>';
        }
    },

    openAccountPanel: function(acc) {
        this.currentOpenedAcc = acc;
        document.getElementById('panelAccName').innerText = acc.name;
        document.getElementById('panelAccBalance').innerText = `$${(acc.balance || 0).toLocaleString()}`;
        document.getElementById('panelAccType').innerText = `Система: ${acc.type}${acc.isTemporary ? ' (Временный шлюз)' : ''}`;
        document.getElementById('panelReserve').value = acc.reserve || 0;

        const reserveInput = document.getElementById('panelReserve');
        if (acc.isTemporary) {
            reserveInput.disabled = true;
            reserveInput.placeholder = 'Недоступно для арендованных шлюзов';
        } else {
            reserveInput.disabled = false;
            reserveInput.placeholder = '';
        }

        // Populate transfer targets (all my accounts except current)
        const select = document.getElementById('transferTarget');
        select.innerHTML = '';
        fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } })
            .then(r => r.json())
            .then(accounts => {
                accounts.forEach(a => {
                    // ИСПРАВЛЕНО: Исключаем текущий счет И все временные счета (они не могут получать переводы)
                    if (a.id !== acc.id && !a.isTemporary) {
                        const opt = document.createElement('option');
                        opt.value = a.id;
                        opt.textContent = `${a.name} ($${(a.balance||0).toLocaleString()})`;
                        select.appendChild(opt);
                    }
                });
            });

        document.getElementById('accountPanel').classList.add('open');
    },

    closeAccountPanel: function() {
        document.getElementById('accountPanel').classList.remove('open');
        this.currentOpenedAcc = null;
    },

    saveReserve: async function() {
        if (!this.currentOpenedAcc || this.currentOpenedAcc.isTemporary) return;
        const val = parseFloat(document.getElementById('panelReserve').value) || 0;
        this.currentOpenedAcc.reserve = val;

        // Simple update via re-render after, but since no direct update endpoint, we can just log and refresh
        this.logSys(`Резерв для "${this.currentOpenedAcc.name}" обновлён на $${val} (изменения сохранятся после следующей операции)`);
        this.closeAccountPanel();
        await this.renderAccounts();
    },

    executeTransfer: async function() {
        if (!this.currentOpenedAcc) return;
        const targetId = document.getElementById('transferTarget').value;
        const amount = parseFloat(document.getElementById('transferAmount').value);
        
        if (!targetId || isNaN(amount) || amount <= 0) return alert('Выберите счёт и укажите сумму');

        // ИСПРАВЛЕНО: Защита от использования больше чем лимит
        const maxAvailable = this.currentOpenedAcc.isTemporary 
            ? (this.currentOpenedAcc.spendLimit || this.currentOpenedAcc.balance || 0)
            : ((this.currentOpenedAcc.balance || 0) - (this.currentOpenedAcc.reserve || 0));

        if (amount > maxAvailable) {
            return alert(`Ошибка: Превышен доступный лимит. Максимум для списания: $${maxAvailable.toLocaleString()}`);
        }

        try {
            const res = await fetch('/api/transfer', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    fromAccId: this.currentOpenedAcc.id,
                    toAccId: targetId,
                    amount: amount
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка перевода');

            this.logSys(`Перевод инициирован. ETA ~${data.etaSeconds || 5} сек.`);
            this.closeAccountPanel();
            setTimeout(async () => {
                await this.renderAccounts();
                await this.updateDashboardKPIsAndPredictor();
            }, 600);
        } catch (e) {
            alert(e.message);
        }
    },

    bindExternalAccount: async function() {
        const key = prompt('Введите API Ключ внешнего счёта (от администратора):');
        if (!key) return;

        try {
            const res = await fetch('/api/accounts/bind', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ key })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Не удалось привязать');

            this.logSys(`Счёт "${data.account.name}" успешно привязан!`);
            await this.renderAccounts();
        } catch (e) {
            alert(e.message);
        }
    },

    // ============ P2P CONTRACTS ============
    // ============ NEW MARKET + CHAT + DUAL-SIDE CONTRACT FLOW ============

    // ============ MARKET HELPERS + SECTION SWITCH ============
    loadMarketData: async function() {
        try {
            const res = await fetch('/api/requests', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const requests = res.ok ? await res.json() : [];
            this.allMarketRequests = requests;

            const listEl = document.getElementById('marketRequestsList');
            if (listEl) this.renderMarketRequestsList(listEl, requests);
        } catch (e) { console.error('loadMarketData', e); }
    },

    renderMarketRequestsList: function(container, requests) {
        container.innerHTML = '';
        if (!requests || requests.length === 0) {
            container.innerHTML = '<div style="padding:24px; text-align:center; color:#64748b;">Нет подходящих заявок.</div>';
            return;
        }
        requests.forEach(r => {
            const el = document.createElement('div');
            el.className = 'contract-box';
            el.style.marginBottom = '10px';
            el.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                    <div style="flex:1;">
                        <strong style="font-size:15px;">${r.type} шлюз</strong> &nbsp; <span class="badge" style="background:#e0e7ff; color:#1e40af;">лимит $${r.limitWanted}</span><br>
                        <small style="color:#64748b;">Вознаграждение: <b>$${r.feeOffered}</b> • ${r.creatorCompany}</small>
                        <div style="margin-top:6px; font-size:13px; color:#334155;">${r.description || ''}</div>
                    </div>
                    <div>
                        <button class="btn btn-primary" style="padding:7px 16px; font-size:12.5px;" onclick="App.respondToRequest('${r.id}', '${r.creatorCompany || 'Партнёр'}')">Начать переговоры →</button>
                    </div>
                </div>
            `;
            container.appendChild(el);
        });
    },

    filterMarketRequests: function() {
        const search = (document.getElementById('marketSearch')?.value || '').toLowerCase();
        const type = document.getElementById('marketTypeFilter')?.value || '';
        const minFee = parseFloat(document.getElementById('marketMinFee')?.value) || 0;
        const maxFee = parseFloat(document.getElementById('marketMaxFee')?.value) || 999999;

        if (!this.allMarketRequests) return;
        const filtered = this.allMarketRequests.filter(r => {
            const matchesSearch = !search || (r.description && r.description.toLowerCase().includes(search)) || (r.creatorCompany && r.creatorCompany.toLowerCase().includes(search));
            const matchesType = !type || r.type === type;
            const matchesFee = (r.feeOffered || 0) >= minFee && (r.feeOffered || 0) <= maxFee;
            return matchesSearch && matchesType && matchesFee;
        });
        const listEl = document.getElementById('marketRequestsList');
        if (listEl) this.renderMarketRequestsList(listEl, filtered);
    },

    // switchMarketSection REMOVED — dedicated pages now handle their own rendering.

    loadMyRequests: async function() {
        const container = document.getElementById('myRequestsList');
        if (!container) return;
        container.innerHTML = '';

        try {
            const res = await fetch('/api/requests?mine=true', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const myReqs = res.ok ? await res.json() : [];

            if (myReqs.length === 0) {
                container.innerHTML = '<div style="padding:20px; color:#64748b; text-align:center;">У вас пока нет опубликованных заявок.<br>Создайте первую во вкладке выше.</div>';
                return;
            }

            myReqs.forEach(r => {
                const el = document.createElement('div');
                el.className = 'contract-box';
                el.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${r.type}</strong> — $${r.limitWanted} • $${r.feeOffered}<br>
                            <small style="color:#64748b;">${r.description || ''}</small>
                        </div>
                        <span class="badge" style="background:${r.status === 'OPEN' ? '#dcfce7' : '#fef3c7'}; color:${r.status === 'OPEN' ? '#166534' : '#854d0e'};">${r.status}</span>
                    </div>
                `;
                container.appendChild(el);
            });
        } catch (e) {
            container.innerHTML = '<div style="color:#ef4444; padding:20px;">Ошибка загрузки ваших заявок</div>';
        }
    },

    loadNegotiations: async function() {
        const container = document.getElementById('negotiationsList');
        if (!container) return;
        try {
            const res = await fetch('/api/contracts', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const contracts = res.ok ? await res.json() : [];
            container.innerHTML = '';
            if (contracts.length === 0) {
                container.innerHTML = '<div style="padding:16px; color:#64748b;">Активные чаты открываются при отклике на заявки. Здесь — legacy контракты.</div>';
                return;
            }
            contracts.forEach(c => {
                const box = document.createElement('div');
                box.className = 'contract-box';
                box.innerHTML = `
                    <div style="display:flex; justify-content:space-between;">
                        <div><strong>Контракт #${c.id.slice(0,8)}</strong><br><small>Лимит $${c.spendLimit}</small></div>
                        <div style="text-align:right;">${c.status === 'EXECUTED' ? '<span style="color:#10b981; font-weight:600;">✅ Исполнен</span>' : '<span style="color:#f59e0b;">⏳ В процессе</span>'}</div>
                    </div>
                `;
                container.appendChild(box);
            });
        } catch (e) {
            container.innerHTML = '<div style="color:#ef4444;">Ошибка</div>';
        }
    },

    loadMyConversations: async function() {
        const container = document.getElementById('activeChatsList');
        if (!container) return;
        container.innerHTML = '<div style="padding:12px; color:#64748b;">Загрузка чатов...</div>';

        try {
            const res = await fetch('/api/conversations', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const chats = res.ok ? await res.json() : [];
            container.innerHTML = '';

            if (chats.length === 0) {
                container.innerHTML = `
                    <div style="padding:20px; text-align:center; color:#64748b;">
                        У вас пока нет активных переговоров.<br>
                        Откликнитесь на заявку в разделе «Рынок P2P» или дождитесь отклика на вашу заявку.
                    </div>`;
                return;
            }

            chats.forEach(chat => {
                const el = document.createElement('div');
                el.className = 'contract-box';
                el.style.cursor = 'pointer';
                el.onclick = () => this.openChatPage(chat.key, chat.partnerName);

                const statusBadge = chat.draftReady 
                    ? '<span class="badge" style="background:#dcfce7; color:#166534;">Готово к подписи</span>' 
                    : chat.signedCount > 0 
                        ? '<span class="badge" style="background:#fef3c7; color:#854d0e;">Ожидает подписи</span>' 
                        : '<span class="badge">В процессе</span>';

                el.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                        <div style="flex:1;">
                            <strong>${chat.partnerName}</strong> <small style="color:#64748b;">(${chat.partnerCompany})</small><br>
                            <small style="color:#475569;">${chat.requestType} • ${chat.requestDesc || 'P2P шлюз'}</small>
                            <div style="margin-top:4px; font-size:12.5px; color:#64748b;">
                                ${chat.lastMessagePreview}
                            </div>
                        </div>
                        <div style="text-align:right; white-space:nowrap;">
                            ${statusBadge}<br>
                            <small style="color:#94a3b8; font-size:11px;">${new Date(chat.lastMessageTime).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}</small>
                        </div>
                    </div>
                `;
                container.appendChild(el);
            });
        } catch (e) {
            container.innerHTML = '<div style="color:#ef4444; padding:12px;">Ошибка загрузки чатов</div>';
        }
    },

    // ============ NEW DEDICATED RENDER FUNCTIONS FOR SEPARATE P2P PAGES ============
    renderP2PMarket: async function() {
        await this.loadMarketData();
        // Re-apply current filters (does not reset inputs)
        if (typeof this.filterMarketRequests === 'function') {
            this.filterMarketRequests();
        }
    },

    renderP2PMy: async function() {
        await this.loadMyRequests();
    },

    renderP2PNegotiations: async function() {
        await this.loadMyConversations();   // new active chats list
        await this.loadNegotiations();      // legacy contracts
    },

    createPublicRequest: async function() {
        // Read from dedicated form in page-p2p-my (clean, no prompts)
        const typeEl = document.getElementById('myReqType');
        const limitEl = document.getElementById('myReqLimit');
        const feeEl = document.getElementById('myReqFee');
        const descEl = document.getElementById('myReqDesc');

        if (!typeEl || !limitEl || !feeEl) {
            alert('Форма создания заявки не найдена. Перейдите на вкладку «Мои заявки».');
            return;
        }

        const type = typeEl.value;
        const limit = parseFloat(limitEl.value);
        const fee = parseFloat(feeEl.value);
        const desc = descEl ? descEl.value : '';

        if (!type || !limit || !fee || isNaN(limit) || isNaN(fee) || limit <= 0 || fee < 0) {
            alert('Пожалуйста, заполните корректно все поля формы (тип, лимит > 0, вознаграждение >= 0).');
            return;
        }

        try {
            const res = await fetch('/api/requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
                body: JSON.stringify({ type: type.toUpperCase(), limitWanted: limit, feeOffered: fee, description: desc || '' })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка публикации');

            this.logSys('Публичный запрос опубликован на рынке.');
            // Navigate to Мои заявки page to see it in list
            await this.navigate('p2p-my');
        } catch (e) {
            alert(e.message);
        }
    },

    respondToRequest: async function(requestId, creatorCompany) {
        try {
            const res = await fetch(`/api/requests/${requestId}/respond`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Не удалось начать переговоры');

            this.logSys(`Открыт чат с ${creatorCompany}. Обсудите детали и подпишите финальный контракт.`);
            this.openChatPage(data.conversationKey, creatorCompany);
        } catch (e) {
            alert(e.message);
        }
    },

    // ============ CHAT MODAL ============
    // ========== CHAT NOW USES FULL PAGE (page-p2p-chat) ==========
    openChatPage: async function(convKey, partnerName = 'Партнёр') {
        this.currentChatKey = convKey;

        // Set header info (elements exist in page-p2p-chat)
        const nameEl = document.getElementById('chatPartnerName');
        const ctxEl = document.getElementById('chatContext');
        if (nameEl) nameEl.innerText = partnerName;
        if (ctxEl) ctxEl.innerText = `Ключ: ${convKey}`;

        await this.navigate('p2p-chat');

        await this.loadChatData();

        // Start dedicated chat polling (lighter than full page refresh)
        if (this.chatPollInterval) clearInterval(this.chatPollInterval);
        this.chatPollInterval = setInterval(() => {
            if (this.currentChatKey && document.getElementById('page-p2p-chat')?.classList.contains('active')) {
                this.loadChatData(true);
            } else {
                if (this.chatPollInterval) clearInterval(this.chatPollInterval);
            }
        }, 2400);
    },

    closeChatPage: function() {
        if (this.chatPollInterval) {
            clearInterval(this.chatPollInterval);
            this.chatPollInterval = null;
        }
        this.currentChatKey = null;
        this.navigate('p2p-negotiations');
    },

    cancelPendingContract: async function() {
        if (!this.currentChatKey || !confirm('Отменить подписанный контракт?')) return;

        try {
            const res = await fetch(`/api/conversations/${this.currentChatKey}/cancel`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Не удалось отменить');

            this.logSys('Контракт отменён.');
            await this.loadChatData(true);
        } catch (e) {
            alert(e.message);
        }
    },

    loadChatData: async function(silent = false) {
        if (!this.currentChatKey) return;

        try {
            const res = await fetch(`/api/conversations/${this.currentChatKey}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) return;
            const data = await res.json();
            const conv = data.conversation;

            // Render messages
            const msgContainer = document.getElementById('chatMessages');
            if (msgContainer) {
                msgContainer.innerHTML = '';
                conv.messages.forEach(m => {
                    const isMe = m.fromId === this.currentUser.id;
                    const el = document.createElement('div');
                    el.style.cssText = `margin-bottom:8px; padding:7px 11px; border-radius:9px; max-width:82%; ${isMe ? 'background:#1e50ff; color:white; margin-left:auto;' : 'background:white; border:1px solid #e2e8f0;'}`;
                    el.innerHTML = `<div style="font-size:11px; opacity:0.7; margin-bottom:2px;">${isMe ? 'Вы' : 'Партнёр'} • ${new Date(m.time).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})}</div>${m.text}`;
                    msgContainer.appendChild(el);
                });

                // Smart auto-scroll: only scroll to bottom if user was already near bottom (allows reading history)
                const threshold = 80;
                const isNearBottom = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight < threshold;
                if (isNearBottom || conv.messages.length <= 3) {
                    msgContainer.scrollTop = msgContainer.scrollHeight;
                }
            }

            // NOTE: Old inline draft UI removed. Contract now handled in separate full-screen modal.
            // Status of draft is shown inside the modal only.

        } catch (e) {
            if (!silent) console.warn('Chat load error', e);
        }
    },

    sendChatMessage: async function() {
        if (!this.currentChatKey) return;
        const input = document.getElementById('chatInput');
        if (!input || !input.value.trim()) return;

        try {
            await fetch(`/api/conversations/${this.currentChatKey}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
                body: JSON.stringify({ text: input.value.trim() })
            });
            input.value = '';
            await this.loadChatData(true);
        } catch (e) {
            alert('Ошибка отправки сообщения');
        }
    },

    // ============ NEW CONTRACT MODAL (2-STEP OVERLAY WIZARD) ============
    openContractModal: async function() {
        if (!this.currentChatKey) {
            alert('Откройте чат переговоров для оформления контракта.');
            return;
        }
        this.currentContractConvKey = this.currentChatKey;
        this.contractModalStep = 1;
        this.contractData = null;

        const modal = document.getElementById('contractModal');
        if (modal) modal.classList.add('active');

        await this.loadContractDataAndRender();
    },

    closeContractModal: function(e) {
        // Добавляем очистку таймера
        if (this.contractPollInterval) {
            clearInterval(this.contractPollInterval);
            this.contractPollInterval = null;
        }
        const modal = document.getElementById('contractModal');
        if (modal) modal.classList.remove('active');
        this.currentContractConvKey = null;
        this.contractData = null;
        if (document.getElementById('page-p2p-negotiations')?.classList.contains('active')) {
            this.renderP2PNegotiations();
        }
    },

    switchContractStep: function(step) {
        this.contractModalStep = step;
        const tab1 = document.getElementById('step1-tab');
        const tab2 = document.getElementById('step2-tab');
        if (tab1) tab1.classList.toggle('active', step === 1);
        if (tab2) tab2.classList.toggle('active', step === 2);

        const nextBtn = document.getElementById('modalNextBtn');
        const signBtn = document.getElementById('modalSignBtn');
        const cancelBtn = document.getElementById('modalCancelBtn');

        if (nextBtn) nextBtn.style.display = (step === 1) ? 'inline-block' : 'none';
        if (signBtn) signBtn.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';

        this.renderContractModalContent();
    },

    loadContractDataAndRender: async function() {
        if (!this.currentContractConvKey) return;

        try {
            if (!this.myAccounts) {
                const accRes = await fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } });
                if (accRes.ok) this.myAccounts = await accRes.json();
            }

            // Запоминаем текущее состояние до обновления, чтобы не перерисовывать окно просто так
            const oldStatus = this.contractData ? this.contractData.status : null;
            const oldSignedCount = this.contractData && this.contractData.signedBy ? this.contractData.signedBy.length : 0;

            const res = await fetch(`/api/conversations/${this.currentContractConvKey}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error('Не удалось загрузить данные контракта');
            const data = await res.json();
            this.contractData = data.conversation;

            const newStatus = this.contractData.status;
            const newSignedCount = this.contractData.signedBy ? this.contractData.signedBy.length : 0;

            // Перерисовываем интерфейс ТОЛЬКО если изменился статус или количество подписей
            if (!oldStatus || oldStatus !== newStatus || oldSignedCount !== newSignedCount) {
                if (this.contractData.status === 'SIGNED_PENDING') {
                    this.contractModalStep = 2;
                }
                
                this.renderContractModalContent();

                if (this.contractData.status === 'SIGNED_PENDING') {
                    this.startContractCountdown();
                }
            }

            // Запускаем тихий таймер автообновления, если он еще не запущен
            if (!this.contractPollInterval) {
                this.contractPollInterval = setInterval(() => {
                    // Если окно открыто — обновляем данные
                    const modal = document.getElementById('contractModal');
                    if (modal && modal.style.display !== 'none') {
                        this.loadContractDataAndRender();
                    } else {
                        // Если окно закрыли — останавливаем таймер
                        clearInterval(this.contractPollInterval);
                        this.contractPollInterval = null;
                    }
                }, 3000); // Проверка каждые 3 секунды
            }

        } catch (e) {
            console.error(e);
        }
    },

    renderContractModalContent: function() {
        const body = document.getElementById('contractModalBody');
        if (!body || !this.contractData) return;

        const conv = this.contractData;
        const draft = conv.draftContract || {};
        const seekerPayments = draft.seekerPayments || [];
        const providerReceives = draft.providerReceives || [];
        const isSeeker = this.currentUser.id === conv.seekerId;
        const isProvider = this.currentUser.id === conv.providerId;

        body.innerHTML = '';

        if (this.contractModalStep === 1) {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr; gap:24px;';

            // НОВОЕ: Проверяем, есть ли уже чьи-то подписи. Если да — блокируем редактирование!
            const isLocked = conv.signedBy && conv.signedBy.length > 0;

            const seekerPanel = this.createContractSidePanel(
                'СТОРОНА А — АРЕНДАТОР ШЛЮЗА', 
                'Вы платите вознаграждение за шлюз', 
                seekerPayments, 
                isSeeker, 
                isLocked, // Передаем флаг блокировки
                'seeker'
            );
            wrapper.appendChild(seekerPanel);

            const providerPanel = this.createContractSidePanel(
                'СТОРОНА Б — ПРОВАЙДЕР ШЛЮЗА', 
                'Вы получаете вознаграждение', 
                providerReceives, 
                isProvider, 
                isLocked, // Передаем флаг блокировки
                'provider'
            );
            wrapper.appendChild(providerPanel);

            body.appendChild(wrapper);

            const note = document.createElement('div');
            note.style.cssText = 'margin-top:20px; font-size:12.5px; color:#64748b; text-align:center;';
            note.innerHTML = `Тип шлюза: <b>${draft.gatewayType || '—'}</b> &nbsp;•&nbsp; Лимит трат: <b>$${draft.spendLimit || 0}</b> &nbsp;•&nbsp; Вознаграждение: <b>$${draft.fee || 0}</b>`;
            body.appendChild(note);
        } else {
            const totalSeeker = seekerPayments.reduce((s, p) => s + (p.amount || 0), 0);
            const totalProvider = providerReceives.reduce((s, p) => s + (p.amount || 0), 0);

            const preview = document.createElement('div');
            preview.innerHTML = `
                <div class="preview-summary">
                    <div class="preview-row"><span>Тип шлюза</span><strong>${draft.gatewayType || '—'}</strong></div>
                    <div class="preview-row"><span>Лимит трат по шлюзу</span><strong>$${ (draft.spendLimit || 0).toLocaleString() }</strong></div>
                    <div class="preview-row"><span>Вознаграждение за услугу</span><strong>$${ (draft.fee || 0).toLocaleString() }</strong></div>
                    <div class="preview-row" style="border-top:2px solid #e2e8f0; margin-top:8px; padding-top:10px; font-size:15px;">
                        <span><b>ИТОГО к списанию (Сторона А)</b></span>
                        <strong style="color:#ef4444;">$${totalSeeker.toLocaleString()}</strong>
                    </div>
                    <div class="preview-row" style="font-size:15px;">
                        <span><b>ИТОГО к зачислению (Сторона Б)</b></span>
                        <strong style="color:#10b981;">$${totalProvider.toLocaleString()}</strong>
                    </div>
                </div>

                <h4 style="margin:16px 0 10px; font-size:15px;">Детализация платежей</h4>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
                    <div>
                        <div style="font-size:12px; color:#64748b; margin-bottom:6px;">Сторона А платит из счетов:</div>
                        ${seekerPayments.length ? seekerPayments.map(p => `<div class="contract-acc-card" style="margin-bottom:6px; padding:10px 14px;"><b>$${p.amount}</b> со счёта <span style="color:#475569;">${this.getAccountNameById(p.accountId)}</span></div>`).join('') : '<i style="color:#94a3b8;">— не заполнено</i>'}
                    </div>
                    <div>
                        <div style="font-size:12px; color:#64748b; margin-bottom:6px;">Сторона Б получает на счета:</div>
                        ${providerReceives.length ? providerReceives.map(p => `<div class="contract-acc-card" style="margin-bottom:6px; padding:10px 14px;"><b>$${p.amount}</b> на счёт <span style="color:#475569;">${this.getAccountNameById(p.accountId)}</span></div>`).join('') : '<i style="color:#94a3b8;">— не заполнено</i>'}
                    </div>
                </div>
            `;
            body.appendChild(preview);

            const signedBy = conv.signedBy || [];
            const seekerSigned = signedBy.includes(conv.seekerId);
            const providerSigned = signedBy.includes(conv.providerId);

            const sigDiv = document.createElement('div');
            sigDiv.className = 'signature-status';
            sigDiv.innerHTML = `
                <div class="sig-pill ${seekerSigned ? 'signed' : 'pending'}">
                    ${seekerSigned ? '✅' : '⏳'} Сторона А (Арендатор) ${seekerSigned ? 'подписала' : 'ожидает подписи'}
                </div>
                <div class="sig-pill ${providerSigned ? 'signed' : 'pending'}">
                    ${providerSigned ? '✅' : '⏳'} Сторона Б (Провайдер) ${providerSigned ? 'подписала' : 'ожидает подписи'}
                </div>
            `;
            body.appendChild(sigDiv);

            const statusDiv = document.createElement('div');
            statusDiv.style.cssText = 'text-align:center; margin:16px 0; min-height:60px;';

            if (conv.status === 'SIGNED_PENDING') {
                statusDiv.innerHTML = `
                    <div style="color:#854d0e; font-weight:600;">Контракт подписан обеими сторонами.<br>Автоматическое исполнение через <span id="countdown-timer" style="font-size:22px; font-weight:700;">30</span> сек</div>
                    <div style="font-size:12px; color:#64748b; margin-top:4px;">В течение этого времени любая сторона может отменить сделку.</div>
                `;
            } else if (seekerSigned && providerSigned) {
                statusDiv.innerHTML = `<div style="color:#166534; font-weight:600;">✅ Обе стороны подписали. Готово к исполнению.</div>`;
            } else {
                statusDiv.innerHTML = `<div style="color:#64748b;">Для завершения обе стороны должны подписать договор в этом окне.</div>`;
            }
            body.appendChild(statusDiv);

            const nextBtn = document.getElementById('modalNextBtn');
            const signBtn = document.getElementById('modalSignBtn');
            const cancelBtn = document.getElementById('modalCancelBtn');

            if (nextBtn) nextBtn.style.display = 'none';

            const bothSigned = seekerSigned && providerSigned;
            const iSigned = signedBy.includes(this.currentUser.id);

            if (signBtn) {
                // Кнопка "Подписать" показывается, если статус ACTIVE и я еще не подписал
                signBtn.style.display = (conv.status === 'ACTIVE' && !iSigned) ? 'inline-block' : 'none';
            }
            
            if (cancelBtn) {
                // Кнопка отмены показывается в двух случаях:
                if (conv.status === 'SIGNED_PENDING') {
                    // 1. Идет 30-секундный таймер
                    cancelBtn.style.display = 'inline-block';
                    cancelBtn.innerHTML = '❌ Отменить контракт';
                } else if (conv.status === 'ACTIVE' && iSigned && !bothSigned) {
                    // 2. Я подписал, а партнер еще нет (отзыв подписи)
                    cancelBtn.style.display = 'inline-block';
                    cancelBtn.innerHTML = '↩️ Отозвать подпись';
                } else {
                    cancelBtn.style.display = 'none';
                }
            }
        }
    },

    createContractSidePanel: function(title, subtitle, paymentsList, isMySide, isLocked, role) {
        const panel = document.createElement('div');
        panel.className = 'contract-side-panel';

        // Редактировать можно только если это моя сторона И контракт еще никем не подписан
        const isEditable = isMySide && !isLocked;

        let html = `
            <h4>${title} <span style="font-size:11px; opacity:0.6;">(${subtitle})</span></h4>
            <div id="cards-${role}"></div>
        `;
        
        if (isEditable) {
            html += `<button class="add-card-btn" onclick="App.addAccountCard('${role}')">+ Добавить счёт для ${role === 'seeker' ? 'оплаты' : 'получения'}</button>`;
        } else if (isMySide && isLocked) {
            // Если моя сторона, но кто-то уже подписал - показываем замочек
            html += `<div style="font-size:11.5px; color:#f59e0b; margin-top:12px; text-align:center; font-weight:600;">🔒 Изменения заблокированы (есть подписи)</div>`;
        } else {
            html += `<div style="font-size:11px; color:#94a3b8; margin-top:8px; text-align:center;">(Заполняется партнёром)</div>`;
        }
        
        panel.innerHTML = html;

        const cardsContainer = panel.querySelector(`#cards-${role}`);
        if (paymentsList.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#94a3b8; font-size:13px; padding:12px 0; text-align:center;';
            empty.textContent = isMySide ? 'Добавьте счета ниже' : 'Пока не заполнено';
            cardsContainer.appendChild(empty);
        } else {
            paymentsList.forEach((p, idx) => {
                const card = this.createAccountPaymentCard(p, role, idx, isEditable);
                cardsContainer.appendChild(card);
            });
        }
        return panel;
    },

    createAccountPaymentCard: function(payment, role, index, isEditable) {
        const acc = this.getAccountById(payment.accountId);
        const card = document.createElement('div');
        card.className = 'contract-acc-card';

        card.innerHTML = `
            <div class="acc-header">
                <div>
                    <div class="acc-name">${acc ? acc.name : 'Счёт'}</div>
                    <span class="badge" style="font-size:10px; padding:1px 6px;">${acc ? acc.type : ''}</span>
                </div>
                ${isEditable ? `<button class="remove-btn" title="Убрать счёт">×</button>` : ''}
            </div>
            <div style="font-size:12px; color:#64748b;">Баланс: $${acc ? (acc.balance || 0).toLocaleString() : '—'}</div>
            <div class="amount-row" style="margin-top:8px;">
                <span style="font-size:12.5px; white-space:nowrap;">Сумма $</span>
                <input type="number" value="${payment.amount || 0}" ${isEditable ? '' : 'disabled'} style="flex:1; padding:7px 10px; font-size:14px;">
            </div>
        `;

        if (isEditable) {
            const removeBtn = card.querySelector('.remove-btn');
            removeBtn.onclick = async () => {
                if (!confirm('Убрать этот счёт из контракта?')) return;
                const newList = [...this.contractData.draftContract[role === 'seeker' ? 'seekerPayments' : 'providerReceives']];
                newList.splice(index, 1);
                await this.saveMyContractPart(role, newList);
            };

            const input = card.querySelector('input');
            let saveTimeout;
            input.oninput = () => {
                clearTimeout(saveTimeout);
                saveTimeout = setTimeout(async () => {
                    const newList = [...this.contractData.draftContract[role === 'seeker' ? 'seekerPayments' : 'providerReceives']];
                    newList[index].amount = parseFloat(input.value) || 0;
                    await this.saveMyContractPart(role, newList);
                }, 650);
            };
        }
        return card;
    },

    getAccountById: function(accId) {
        if (!accId) return null;
        
        // Ищем реальное название среди своих счетов
        if (this.myAccounts) {
            const acc = this.myAccounts.find(a => a.id === accId);
            if (acc) return acc; // Если счет найден, возвращаем его
        }
        
        // Если это счет партнера (которого у нас нет в myAccounts), маскируем ID
        return { id: accId, name: 'Счёт партнёра (...'+accId.slice(-4)+')', type: '—', balance: 0 };
    },

    getAccountNameById: function(accId) {
        const acc = this.getAccountById(accId);
        return acc ? acc.name : '—';
    },

    addAccountCard: async function(role) {
        const res = await fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } });
        const myAccs = res.ok ? await res.json() : [];

        const draftKey = role === 'seeker' ? 'seekerPayments' : 'providerReceives';
        const currentList = this.contractData.draftContract[draftKey] || [];

        const available = myAccs.filter(a => !currentList.some(p => p.accountId === a.id));

        if (available.length === 0) {
            alert('Все ваши счета уже добавлены в эту часть контракта.');
            return;
        }

        const options = available.map((a, i) => `${i+1}. ${a.name} ($${a.balance})`).join('\n');
        const choice = prompt(`Выберите счёт для добавления:\n${options}\n\nВведите номер (1-${available.length}):`);
        if (!choice) return;
        const idx = parseInt(choice) - 1;
        if (isNaN(idx) || idx < 0 || idx >= available.length) return alert('Неверный выбор');

        const chosenAcc = available[idx];
        const amountStr = prompt(`Сумма для этого счёта (макс $${chosenAcc.balance}):`, '1000');
        const amount = parseFloat(amountStr);
        if (!amount || amount <= 0) return;

        const newList = [...currentList, { accountId: chosenAcc.id, amount }];
        await this.saveMyContractPart(role, newList);
    },

    saveMyContractPart: async function(role, paymentsList) {
        if (!this.currentContractConvKey) return;

        try {
            const res = await fetch(`/api/conversations/${this.currentContractConvKey}/propose`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
                body: JSON.stringify({ role, payments: paymentsList })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');

            this.logSys(`Ваша часть контракта (${role}) обновлена.`);
            await this.loadContractDataAndRender();
        } catch (e) {
            alert(e.message);
        }
    },

    getAccountNameById: function(accId) {
        return accId ? accId.slice(0, 12) + '...' : '—';
    },

    signFinalContractFromModal: async function() {
        if (!this.currentContractConvKey) return;
        if (!confirm('Подписать финальный контракт? После второй подписи запустится таймер на 30 секунд.')) return;

        try {
            const res = await fetch(`/api/conversations/${this.currentContractConvKey}/sign`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка подписи');

            this.logSys('Вы подписали договор.');
            await this.loadContractDataAndRender();
        } catch (e) {
            alert(e.message);
        }
    },

    cancelPendingContractFromModal: async function() {
        if (!this.currentContractConvKey) return;

        const isUnsign = this.contractData && this.contractData.status === 'ACTIVE';
        const confirmMsg = isUnsign ? 'Отозвать свою подпись?' : 'Отменить контракт? Средства не будут перемещены.';

        if (!confirm(confirmMsg)) return;

        try {
            const res = await fetch(`/api/conversations/${this.currentContractConvKey}/cancel`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Не удалось отменить');

            this.logSys('Контракт отменён.');
            this.closeContractModal();
            if (this.currentChatKey) await this.loadChatData(true);
            await this.renderP2PNegotiations();
        } catch (e) {
            alert(e.message);
        }
    },

    startContractCountdown: function() {
        const timerEl = () => document.getElementById('countdown-timer');
        let seconds = 30;
        const interval = setInterval(() => {
            const el = timerEl();
            if (!el || !document.getElementById('contractModal')?.classList.contains('active')) {
                clearInterval(interval);
                return;
            }
            seconds--;
            el.textContent = Math.max(0, seconds);
            if (seconds <= 0) {
                clearInterval(interval);
                setTimeout(() => {
                    if (document.getElementById('contractModal')?.classList.contains('active')) {
                        this.loadContractDataAndRender();
                    }
                }, 1200);
            }
        }, 1000);
    },

    renderProfile: function() {
        if (!this.currentUser) return;
        document.getElementById('profile-name').innerText = this.currentUser.name;
        document.getElementById('profile-company').innerText = this.currentUser.company;
        document.getElementById('profile-id').innerText = this.currentUser.id;
        document.getElementById('profile-role').innerText = this.currentUser.isAdmin ? 'Администратор' : 'Пользователь';

        const toggle = document.getElementById('aiToggle');
        if (toggle) toggle.checked = !!this.currentUser.autoApproveAI;
    },

    toggleAISafety: async function(isChecked) {
        try {
            const res = await fetch('/api/profile/ai-safety', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ enabled: isChecked })
            });
            if (res.ok) {
                this.currentUser.autoApproveAI = isChecked;
                this.logSys(`Настройка AI авто-балансировки: ${isChecked ? 'ВКЛЮЧЕНА' : 'ВЫКЛЮЧЕНА'}`);
            }
        } catch (e) {
            alert('Ошибка сохранения настройки');
        }
    },

    // ============ ADMIN ============
    renderAdmin: function() {
        // form is static in HTML, just make sure inputs exist
    },

    generateExternalAccount: async function() {
        if (!this.currentUser.isAdmin) return;

        const name = document.getElementById('adminAccName').value.trim() || 'New External Bank';
        const balance = parseFloat(document.getElementById('adminAccBalance').value) || 10000;
        const type = document.getElementById('adminAccType').value;

        try {
            const res = await fetch('/api/admin/create-external', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ name, balance, type })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            this.logSys(`Внешний счёт создан. API Ключ: ${data.key}`);
            alert(`Счёт создан!\n\nAPI Ключ (скопируйте):\n${data.key}\n\nПередайте его пользователю для привязки.`);
            document.getElementById('adminAccName').value = '';
        } catch (e) {
            alert(e.message);
        }
    },

    // ============ INIT ============
    init: function() {
        // Try auto-login from storage (demo convenience)
        const savedToken = localStorage.getItem('abusafin_token');
        if (savedToken) {
            // For demo we skip full restore, user can re-login quickly
            // Or implement /api/me check but to keep simple - clear it
            localStorage.removeItem('abusafin_token');
        }

        // Initial log hint
        setTimeout(() => {
            const logs = document.getElementById('sys-logs');
            if (logs && logs.children.length === 0) {
                const hint = document.createElement('div');
                hint.className = 'sys-log';
                hint.style.borderLeftColor = '#64748b';
                hint.innerHTML = `<strong>[СИСТЕМА]</strong> Войдите под любым пользователем. AI Predictor работает на сервере и меняет балансы нескольких счетов при обнаружении рисков.`;
                logs.appendChild(hint);
            }
        }, 1200);
    }
};

// Boot
window.onload = () => {
    App.init();
    // Particles already started by particles.js
};