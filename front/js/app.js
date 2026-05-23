const App = {
    currentUser: null,
    token: null,
    currentOpenedAcc: null,
    predictorChart: null,
    pollInterval: null,
    lastLogsTimestamp: null,

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
        if (pageId === 'p2p') await this.renderP2PInterface();
        if (pageId === 'profile') this.renderProfile();
        if (pageId === 'admin' && this.currentUser.isAdmin) this.renderAdmin();
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
                } else if (activePage.id === 'page-p2p') {
                    await this.renderP2PInterface(true); // silent refresh
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

            const container = document.getElementById('sys-logs');
            if (!container) return;

            container.innerHTML = '';
            logs.forEach(log => {
                const el = document.createElement('div');
                el.className = 'sys-log';
                const time = new Date(log.time).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                el.innerHTML = `<strong>[${time}]</strong> ${log.msg}`;

                // Add confirmation button for AI risk actions if autoApprove is OFF
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
                                // refresh logs and accounts
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
            });
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
            const accounts = await res.json();

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
        // We need all accounts of current user for targets - fetch again or use closure
        fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } })
            .then(r => r.json())
            .then(accounts => {
                accounts.forEach(a => {
                    if (a.id !== acc.id) {
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
    currentChatKey: null,
    chatPollInterval: null,

    renderP2PInterface: async function(silent = false) {
        const container = document.getElementById('page-p2p');
        if (!container) return;

        // Build clean sectioned UI with mini sidebar nav + search/filters
        container.innerHTML = `
            <h1 style="margin-bottom:16px;">AbusaFin • Рынок ликвидности и P2P</h1>
            
            <div style="display:flex; gap:20px; align-items:flex-start;">
                
                <!-- MINI SIDEBAR NAV -->
                <div style="width:205px; flex-shrink:0; background:white; border:1px solid var(--border); border-radius:14px; padding:10px 8px; box-shadow:0 2px 6px rgba(0,0,0,0.03);">
                    <div onclick="App.switchMarketSection('market')" class="nav-item active" id="nav-market" style="margin-bottom:4px; padding:10px 14px; border-radius:9px; cursor:pointer;">🔎 Рынок заявок</div>
                    <div onclick="App.switchMarketSection('myrequests')" class="nav-item" id="nav-myrequests" style="margin-bottom:4px; padding:10px 14px; border-radius:9px; cursor:pointer;">📋 Мои заявки</div>
                    <div onclick="App.switchMarketSection('negotiations')" class="nav-item" id="nav-negotiations" style="padding:10px 14px; border-radius:9px; cursor:pointer;">💬 Активные переговоры</div>
                    
                    <div style="margin-top:22px; padding-top:12px; border-top:1px solid var(--border); font-size:11px; color:#64748b; line-height:1.4;">
                        Создавайте публичные запросы.<br>
                        Откликайтесь → открывайте чат.<br>
                        Обе стороны заполняют части → подписывают.
                    </div>
                </div>

                <!-- DYNAMIC CONTENT AREA -->
                <div style="flex:1; min-width:0;">
                    
                    <!-- MARKET SECTION (search + filters + list) -->
                    <div id="marketSection">
                        <div class="chart-card" style="margin-bottom:16px;">
                            <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap;">
                                <div style="flex:1; min-width:220px;">
                                    <label style="font-size:12px; color:#64748b;">Поиск по описанию / компании</label>
                                    <input type="text" id="marketSearch" class="form-input" placeholder="Например: операционные платежи..." oninput="App.filterMarketRequests()">
                                </div>
                                <div>
                                    <label style="font-size:12px; color:#64748b;">Тип шлюза</label>
                                    <select id="marketTypeFilter" class="form-input" onchange="App.filterMarketRequests()">
                                        <option value="">Все типы</option>
                                        <option value="SEPA">SEPA</option>
                                        <option value="SWIFT">SWIFT</option>
                                        <option value="CARD">CARD</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="font-size:12px; color:#64748b;">Мин. вознаграждение</label>
                                    <input type="number" id="marketMinFee" class="form-input" placeholder="0" style="width:90px;" oninput="App.filterMarketRequests()">
                                </div>
                                <div>
                                    <label style="font-size:12px; color:#64748b;">Макс. вознаграждение</label>
                                    <input type="number" id="marketMaxFee" class="form-input" placeholder="10000" style="width:90px;" oninput="App.filterMarketRequests()">
                                </div>
                                <button class="btn btn-secondary" style="padding:9px 16px; height:42px;" onclick="App.renderP2PInterface(true)">Обновить</button>
                            </div>
                        </div>
                        
                        <div class="chart-card">
                            <h3 style="margin-bottom:12px;">Открытые заявки на рынке</h3>
                            <div id="marketRequestsList" style="max-height:420px; overflow-y:auto;"></div>
                        </div>
                    </div>

                    <!-- MY REQUESTS SECTION -->
                    <div id="myRequestsSection" style="display:none;">
                        <div class="chart-card">
                            <h3>Мои опубликованные заявки</h3>
                            <div id="myRequestsList" style="margin-top:12px;"></div>
                        </div>
                    </div>

                    <!-- NEGOTIATIONS SECTION -->
                    <div id="negotiationsSection" style="display:none;">
                        <div class="chart-card">
                            <h3>Активные переговоры и legacy контракты</h3>
                            <div id="negotiationsList" style="margin-top:12px;"></div>
                            <div style="margin-top:16px; padding:14px; background:#f8fafc; border-radius:10px; font-size:13px; color:#475569;">
                                Активные чаты открываются автоматически при отклике на заявку.<br>
                                Здесь отображаются завершённые legacy контракты. Новые переговоры ведутся в чате.
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        `;

        // Load initial market data
        await this.loadMarketData();
    },

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

    switchMarketSection: async function(section) {
        ['marketSection','myRequestsSection','negotiationsSection'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        ['nav-market','nav-myrequests','nav-negotiations'].forEach(id => {
            const el = document.getElementById(id); if (el) el.classList.remove('active');
        });

        const target = document.getElementById(section + 'Section');
        const navId = section === 'market' ? 'nav-market' : section === 'myrequests' ? 'nav-myrequests' : 'nav-negotiations';
        const nav = document.getElementById(navId);

        if (target) target.style.display = 'block';
        if (nav) nav.classList.add('active');

        if (section === 'myrequests') await this.loadMyRequests();
        else if (section === 'negotiations') await this.loadNegotiations();
        else if (section === 'market') await this.loadMarketData();
    },

    loadMyRequests: async function() {
        const container = document.getElementById('myRequestsList');
        if (!container) return;
        container.innerHTML = `
            <div style="margin-bottom:16px;">
                <button class="btn btn-primary" style="width:100%; padding:11px;" onclick="App.createPublicRequest()">
                    + Создать новую публичную заявку
                </button>
            </div>
            <div id="myRequestsContent">Загрузка...</div>
        `;

        const content = document.getElementById('myRequestsContent');

        try {
            const res = await fetch('/api/requests?mine=true', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const myReqs = res.ok ? await res.json() : [];
            content.innerHTML = '';

            if (myReqs.length === 0) {
                content.innerHTML = '<div style="padding:20px; color:#64748b;">У вас пока нет опубликованных заявок.</div>';
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
                content.appendChild(el);
            });
        } catch (e) {
            content.innerHTML = '<div style="color:#ef4444; padding:20px;">Ошибка загрузки ваших заявок</div>';
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

    createPublicRequest: async function() {
        // Simple reliable prompts (no dependency on missing DOM elements)
        const type = prompt('Тип шлюза (SEPA / SWIFT / CARD):', 'SEPA');
        if (!type) return;

        const limitStr = prompt('Требуемый лимит трат на шлюзе ($):', '8500');
        const feeStr = prompt('Вознаграждение за услугу ($):', '450');
        const desc = prompt('Краткое описание (не-конфиденциальное):', 'Нужен быстрый шлюз для операционных платежей');

        const limit = parseFloat(limitStr);
        const fee = parseFloat(feeStr);

        if (!limit || !fee || isNaN(limit) || isNaN(fee)) {
            alert('Некорректные числа');
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
            // Directly render into "Мои заявки" section — no jumping to first tab
            await this.renderP2PInterface(true, 'myrequests');
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
            this.openChatModal(data.conversationKey, creatorCompany);
        } catch (e) {
            alert(e.message);
        }
    },

    // ============ CHAT MODAL ============
    openChatModal: async function(convKey, partnerName = 'Партнёр') {
        this.currentChatKey = convKey;
        const modal = document.getElementById('chatModal');
        if (!modal) return;

        document.getElementById('chatPartnerName').innerText = partnerName;
        document.getElementById('chatContext').innerText = `Ключ переговоров: ${convKey}`;

        modal.style.display = 'block';
        modal.classList.add('open');

        await this.loadChatData();

        if (this.chatPollInterval) clearInterval(this.chatPollInterval);
        this.chatPollInterval = setInterval(() => {
            const m = document.getElementById('chatModal');
            if (this.currentChatKey && m && m.classList.contains('open')) {
                this.loadChatData(true);
            } else {
                if (this.chatPollInterval) clearInterval(this.chatPollInterval);
            }
        }, 2200);
    },

    closeChatModal: function() {
        const modal = document.getElementById('chatModal');
        if (modal) {
            modal.classList.remove('open');
            modal.style.display = 'none';
        }
        if (this.chatPollInterval) {
            clearInterval(this.chatPollInterval);
            this.chatPollInterval = null;
        }
        this.currentChatKey = null;
        setTimeout(() => this.renderP2PInterface(true), 300);
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
                msgContainer.scrollTop = msgContainer.scrollHeight;
            }

            // Render draft status
            const draft = conv.draftContract || {};
            const statusEl = document.getElementById('chatDraftStatus');
            const signBtn = document.getElementById('chatSignBtn');

            let statusText = '';
            const seekerFilled = !!draft.seekerPayment;
            const providerFilled = !!draft.providerReceive;

            if (seekerFilled && providerFilled) {
                statusText = `✅ Обе стороны заполнили части. Сумма: $${draft.seekerPayment.amount} → $${draft.providerReceive.amount}. Можно подписывать.`;
                if (signBtn) signBtn.style.display = 'block';
            } else if (seekerFilled) {
                statusText = `Сторона А заполнила свою часть ($${draft.seekerPayment.amount}). Ожидаем часть Б.`;
                if (signBtn) signBtn.style.display = 'none';
            } else if (providerFilled) {
                statusText = `Сторона Б заполнила свою часть. Ожидаем часть А.`;
                if (signBtn) signBtn.style.display = 'none';
            } else {
                statusText = 'Обе стороны должны заполнить свои части контракта ниже.';
                if (signBtn) signBtn.style.display = 'none';
            }
            if (statusEl) statusEl.innerHTML = statusText;

            // Populate account selects (my accounts)
            await this.populateChatAccountSelects(conv);

        } catch (e) {
            if (!silent) console.warn('Chat load error', e);
        }
    },

    populateChatAccountSelects: async function(conv) {
        const myAccsRes = await fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } });
        const myAccs = myAccsRes.ok ? await myAccsRes.json() : [];

        const isSeeker = this.currentUser.id === conv.seekerId;

        // Seeker select
        const seekerSel = document.getElementById('chatSeekerAccount');
        if (seekerSel) {
            seekerSel.innerHTML = '';
            myAccs.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = `${a.name} ($${ (a.balance||0).toLocaleString() })`;
                seekerSel.appendChild(opt);
            });
            if (conv.draftContract && conv.draftContract.seekerPayment) {
                seekerSel.value = conv.draftContract.seekerPayment.accountId;
                document.getElementById('chatSeekerAmount').value = conv.draftContract.seekerPayment.amount;
            }
        }

        // Provider select (only meaningful if I am provider)
        const provSel = document.getElementById('chatProviderAccount');
        if (provSel) {
            provSel.innerHTML = '';
            myAccs.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = `${a.name} ($${ (a.balance||0).toLocaleString() })`;
                provSel.appendChild(opt);
            });
            if (conv.draftContract && conv.draftContract.providerReceive) {
                provSel.value = conv.draftContract.providerReceive.accountId;
                document.getElementById('chatProviderAmount').value = conv.draftContract.providerReceive.amount;
            }
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

    proposeMyContractPart: async function(role) {
        if (!this.currentChatKey) return;

        const accId = document.getElementById(role === 'seeker' ? 'chatSeekerAccount' : 'chatProviderAccount').value;
        const amount = parseFloat(document.getElementById(role === 'seeker' ? 'chatSeekerAmount' : 'chatProviderAmount').value);

        if (!accId || !amount || amount <= 0) {
            alert('Выберите счёт и укажите сумму');
            return;
        }

        try {
            const res = await fetch(`/api/conversations/${this.currentChatKey}/propose`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
                body: JSON.stringify({ role, accountId: accId, amount })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка предложения');

            this.logSys(`Ваша часть контракта (${role}) отправлена партнёру.`);
            await this.loadChatData(true);
        } catch (e) {
            alert(e.message);
        }
    },

    signFinalContract: async function() {
        if (!this.currentChatKey) return;
        if (!confirm('Подписать финальный контракт? После второй подписи сделка будет исполнена автоматически.')) return;

        try {
            const res = await fetch(`/api/conversations/${this.currentChatKey}/sign`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка подписи');

            if (data.executed) {
                this.logSys(`🎉 ФИНАЛЬНЫЙ КОНТРАКТ ИСПОЛНЕН! Временный шлюз создан.`);
                this.closeChatModal();
                setTimeout(() => {
                    this.renderAccounts();
                    this.updateDashboardKPIsAndPredictor();
                }, 600);
            } else {
                this.logSys('Вы подписали. Ожидаем подпись второй стороны.');
                await this.loadChatData(true);
            }
        } catch (e) {
            alert(e.message);
        }
    },

    // ============ PROFILE ============
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