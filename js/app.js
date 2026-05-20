const App = {
    currentUser: null,
    currentOpenedAcc: null,
    predictorChart: null,
    predictorInterval: null,
    timelineData: [],
    timelineIndex: 0,

    delays: { 'SEPA': 5000, 'SWIFT': 10000, 'CARD': 20000 },

    login: function() {
        const l = document.getElementById('auth-login').value;
        const p = document.getElementById('auth-pass').value;
        const user = DB.login(l, p);
        
        if(user) {
            this.currentUser = user;
            document.getElementById('login-screen').classList.remove('active');
            document.getElementById('app-screen').classList.add('active');
            
            document.getElementById('sidebar-username').innerText = user.name;
            document.getElementById('nav-admin').style.display = user.isAdmin ? 'block' : 'none';
            
            document.getElementById('profile-name').innerText = user.name;
            document.getElementById('profile-company').innerText = user.company;
            document.getElementById('profile-id').innerText = user.id;
            document.getElementById('profile-role').innerText = user.isAdmin ? 'Администратор' : 'Пользователь';

            this.logSys(`Успешный вход: ${user.name}`);
            this.navigate('dashboard');
            this.initPredictor();
        } else {
            alert('Неверный логин или пароль');
        }
    },

    logout: function() {
        this.currentUser = null;
        clearInterval(this.predictorInterval);
        document.getElementById('app-screen').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');
    },

    navigate: function(pageId) {
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        if(event) event.target.classList.add('active');
        document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
        document.getElementById(`page-${pageId}`).classList.add('active');
        this.closeAccountPanel();

        if(pageId === 'accounts') this.renderAccounts();
        if(pageId === 'dashboard') this.updateDashboard();
        if(pageId === 'p2p') this.renderP2PContractInterface();
        
        if (this.chartData && this.chartData.length > 0) {
        const lastValue = this.chartData[this.chartData.length - 1];
        this.updateGlobalKPIs(lastValue);
        }
    },

    logSys: function(msg) {
        const logsDiv = document.getElementById('sys-logs');
        const el = document.createElement('div');
        el.className = 'sys-log';
        el.innerHTML = `<strong>[${new Date().toLocaleTimeString()}]</strong> ${msg}`;
        logsDiv.prepend(el);
    },

    renderAccounts: function() {
        const list = document.getElementById('accountsList');
        list.innerHTML = '';
        const accounts = DB.getUserAccounts(this.currentUser.id);

        accounts.forEach(acc => {
            const el = document.createElement('div');
            el.className = `account-card ${acc.isTemporary ? 'temporary-acc' : ''}`;
            el.onclick = () => this.openAccountPanel(acc);
            el.innerHTML = `
                <div style="display:flex; justify-content:space-between;">
                    <strong>${acc.name}</strong> <span class="badge">${acc.type}</span>
                </div>
                <h3 style="margin: 10px 0;">$${acc.balance.toLocaleString()}</h3>
                <small style="color: var(--text-muted)">${acc.isTemporary ? 'Ограничение трат: $' + acc.spendLimit : 'НЗ: $' + acc.reserve.toLocaleString()}</small>
            `;
            list.appendChild(el);
        });

        const addBtn = document.createElement('div');
        addBtn.className = 'account-card';
        addBtn.style.border = '2px dashed var(--primary)';
        addBtn.style.textAlign = 'center';
        addBtn.innerHTML = `<strong>+ Добавить счет</strong><br><small>Ввести API Ключ</small>`;
        addBtn.onclick = () => {
            const key = prompt("Введите API Ключ счета:");
            if(key && DB.bindAccount(this.currentUser.id, key)) {
                this.logSys(`Счет ${key} успешно привязан!`);
                this.renderAccounts();
            } else {
                alert("Ключ не найден или уже использован.");
            }
        };
        list.appendChild(addBtn);
    },

    openAccountPanel: function(acc) {
        this.currentOpenedAcc = acc;
        document.getElementById('panelAccName').innerText = acc.name;
        document.getElementById('panelAccBalance').innerText = `$${acc.balance.toLocaleString()}`;
        document.getElementById('panelAccType').innerText = `Система: ${acc.type}`;
        document.getElementById('panelReserve').value = acc.reserve;

        if(acc.isTemporary) {
            document.getElementById('panelReserve').disabled = true;
            document.getElementById('panelReserve').placeholder = "Недоступно для арендованных счетов";
        } else {
            document.getElementById('panelReserve').disabled = false;
        }

        const select = document.getElementById('transferTarget');
        select.innerHTML = '';
        DB.getUserAccounts(this.currentUser.id).forEach(a => {
            if(a.id !== acc.id) select.innerHTML += `<option value="${a.id}">${a.name}</option>`;
        });

        document.getElementById('accountPanel').classList.add('open');
    },

    closeAccountPanel: function() {
        document.getElementById('accountPanel').classList.remove('open');
        this.currentOpenedAcc = null;
    },

    updateGlobalKPIs: function(simulatedValue) {
        const currentSimulatedCapital = Math.floor(simulatedValue);
        const currentSimulatedAvailable = Math.floor(simulatedValue * 0.85);

        const totalEl = document.getElementById('kpi-total');
        const availableEl = document.getElementById('kpi-available');
        if (totalEl) totalEl.innerText = `$${currentSimulatedCapital.toLocaleString()}`;
        if (availableEl) availableEl.innerText = `$${currentSimulatedAvailable.toLocaleString()}`;

        const mainAccountCardHeader = document.querySelector('.account-card:not(.temporary-acc) h3');
        if (mainAccountCardHeader) {
            mainAccountCardHeader.innerText = `$${currentSimulatedCapital.toLocaleString()}`;
        }

        const extraInfoCapital = document.getElementById('info-extra-capital');
        const extraInfoCash = document.getElementById('info-extra-cash');
        if (extraInfoCapital) extraInfoCapital.innerText = `$${currentSimulatedCapital.toLocaleString()}`;
        if (extraInfoCash) extraInfoCash.innerText = `$${currentSimulatedAvailable.toLocaleString()}`;
    },

    saveReserve: function() {
        if(!this.currentOpenedAcc) return;
        const val = parseFloat(document.getElementById('panelReserve').value) || 0;
        this.currentOpenedAcc.reserve = val;
        DB.updateAccount(this.currentOpenedAcc);
        this.logSys(`Резерв для счета обновлен: $${val}`);
        this.renderAccounts();
    },

    executeTransfer: function(fromAcc = null, targetId = null, amount = null) {
        const isManual = !fromAcc; 
        const sender = isManual ? this.currentOpenedAcc : fromAcc;
        const target = isManual ? document.getElementById('transferTarget').value : targetId;
        const amt = isManual ? parseFloat(document.getElementById('transferAmount').value) : amount;

        if(!sender || !target || isNaN(amt) || amt <= 0) return;

        const available = sender.balance - sender.reserve;
        if(amt > available) {
            this.logSys(`❌ Ошибка: На счете ${sender.name} недостаточно средств (с учетом НЗ).`);
            return;
        }

        const targetAcc = DB.getData().accounts.find(a => a.id === target);
        const delay = this.delays[sender.type] || 5000;

        sender.balance -= amt;
        DB.updateAccount(sender);
        
        this.logSys(`🔄 Инициирован перевод $${amt} со счета ${sender.name} -> ${targetAcc ? targetAcc.name : target}. Ожидание (${sender.type}): ${delay/1000} сек.`);
        
        if(isManual) { this.closeAccountPanel(); this.renderAccounts(); this.updateDashboard(); }

        const senderSnapshot = sender;
        const targetSnapshot = targetAcc;

        setTimeout(() => {
            if(targetSnapshot) {
                targetSnapshot.balance += amt;
                DB.updateAccount(targetSnapshot);
            }
            this.logSys(`✅ Перевод $${amt} успешно доставлен!`);
            if(document.getElementById(`page-accounts`).classList.contains('active')) this.renderAccounts();
            this.updateDashboard();
        }, delay);
    },

    initPredictor: function() {
        this.timelineIndex = 30;
        
        this.chartLabels = Array.from({length: 30}, (_, i) => `День ${i+1}`);
        this.chartData = Array.from({length: 30}, () => 40000 + Math.floor(Math.random() * 8000));

        if(!this.predictorChart) {
            const ctx = document.getElementById('predictorChart').getContext('2d');
            this.predictorChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: this.chartLabels,
                    datasets: [{ label: 'Доступный ликвид', data: this.chartData, borderColor: '#1e50ff', fill: false, tension: 0.3 }]
                },
                options: { animation: false, responsive: true, maintainAspectRatio: false }
            });
        }

        if(this.predictorInterval) clearInterval(this.predictorInterval);
        
        this.predictorInterval = setInterval(() => {
            this.timelineIndex++;
            let nextValue = this.chartData[this.chartData.length - 1] + (Math.random() - 0.5) * 4000;
            if(this.timelineIndex === 40) {
                document.getElementById('ai-status').innerText = "⚠️ Риск кассового разрыва!";
                document.getElementById('ai-status').style.color = "var(--warning)";
                this.logSys("🤖 [AI ПРЕДИКТОР]: Внимание! Через 5 циклов на основном счете ожидается падение ликвидности ниже критической отметки.");
                
                if (this.currentUser.autoApproveAI) {
                    this.logSys("🤖 [AI]: Авто-подтверждение включено. Перераспределяю средства...");
                    this.autoDistribute();
                } else {
                    this.logSys(`🤖 [AI ЗАПРОС]: Требуется одобрение переброски $15,000. <button class="btn btn-primary" style="padding:2px 5px; font-size:11px;" onclick="App.autoDistribute()">Одобрить</button>`);
                }
            }
            
            if (this.timelineIndex === 46) nextValue -= 25000;
            
            this.chartLabels.push(`День ${this.timelineIndex}`);
            this.chartData.push(Math.max(0, nextValue));

            if(this.chartData.length > 25) {
                this.chartLabels.shift();
                this.chartData.shift();
            }

            this.predictorChart.update();

            const data = DB.getData();
            const mainAcc = data.accounts.find(a => a.userId === this.currentUser.id && !a.isTemporary);
            if (mainAcc) {
                mainAcc.balance = Math.floor(nextValue);
                DB.saveData(data); 
            }

            this.updateGlobalKPIs(nextValue);
        }, 2000);
    },
    autoDistribute: function() {
        this.logSys("🤖 [AI АВТО-БАЛАНСИРОВКА]: Ищу свободные средства (исключая НЗ) на других счетах...");
        const accounts = DB.getUserAccounts(this.currentUser.id);
        if(accounts.length < 2) {
            this.logSys("🤖 Ошибка: Нет других счетов для переброса средств."); return;
        }
        
        const mainAcc = accounts[0]; 
        let needed = 15000; 
        
        accounts.forEach(acc => {
            if(acc.id === mainAcc.id || needed <= 0) return;
            const available = acc.balance - acc.reserve;
            if(available > 0) {
                const take = Math.min(available, needed);
                this.logSys(`🤖 Забираю $${take} со счета "${acc.name}" на основной...`);
                this.executeTransfer(acc, mainAcc.id, take);
                needed -= take;
            }
        });
    },

    updateDashboard: function() {
        if(!this.currentUser) return;
        const accs = DB.getUserAccounts(this.currentUser.id);
        let total = 0, avail = 0;
        accs.forEach(a => { total += a.balance; avail += (a.balance - a.reserve); });
        
        document.getElementById('kpi-total').innerText = `$${total.toLocaleString()}`;
        document.getElementById('kpi-available').innerText = `$${avail.toLocaleString()}`;
    },

    toggleAssistant: function() {
        const panel = document.getElementById('assistantPanel');
        panel.classList.toggle('open');
        if(panel.classList.contains('open') && document.getElementById('assistant-history').children.length === 0) {
            this.addChatMsg('assistant-history', 'AI', 'Привет! Я ассистент AbusaFin. Могу проанализировать расходы или связать вас с другим аккаунтом. Напишите "найти аккаунт [ID]".');
        }
    },

    sendAssistantMsg: function() {
        const input = document.getElementById('assistant-input');
        const text = input.value.trim();
        if(!text) return;
        
        this.addChatMsg('assistant-history', 'Вы', text);
        input.value = '';

        setTimeout(() => {
            if(text.toLowerCase().includes('найти аккаунт')) {
                const idMatch = text.match(/u_\w+/);
                if(idMatch) {
                    this.addChatMsg('assistant-history', 'AI', `Ищу пользователя ${idMatch[0]}... Соединяю! Перейдите во вкладку "Сделки (Чат)".`);
                    this.openP2PChat(idMatch[0]);
                } else {
                    this.addChatMsg('assistant-history', 'AI', `Укажите точный ID (например, u_1).`);
                }
            } else {
                this.addChatMsg('assistant-history', 'AI', 'Я пока прототип. Попросите меня "найти аккаунт u_1".');
            }
        }, 1000);
    },

    openP2PChat: function(targetUserId) {
        document.getElementById('p2p-history').innerHTML = `<div class="msg sys">Чат начат с ${targetUserId}</div>`;
        document.getElementById('p2p-input').disabled = false;
        document.getElementById('p2p-input').nextElementSibling.disabled = false;
        
        setTimeout(() => {
            this.addChatMsg('p2p-history', 'Партнер', 'Здравствуйте! Готов обсудить детали транзакции.');
        }, 2000);
    },

    toggleAISafety: function(isChecked) {
        const data = DB.getData();
        const user = data.users.find(u => u.id === this.currentUser.id);
        user.autoApproveAI = isChecked;
        this.currentUser.autoApproveAI = isChecked;
        DB.saveData(data);
        this.logSys(`⚙️ Настройки изменены: Автоматическое управление ИИ — ${isChecked ? 'ВКЛ' : 'ВЫКЛ'}`);
    },

    addChatMsg: function(containerId, sender, text) {
        const c = document.getElementById(containerId);
        const el = document.createElement('div');
        el.className = `msg ${sender === 'Вы' ? 'user' : 'ai'}`;
        el.innerHTML = `<strong>${sender}:</strong> ${text}`;
        c.appendChild(el);
        c.scrollTop = c.scrollHeight;
    },

    generateExternalAccount: function() {
        const name = document.getElementById('adminAccName').value;
        const balance = parseFloat(document.getElementById('adminAccBalance').value);
        const type = document.getElementById('adminAccType').value;
        
        const key = DB.createExternalAccount(name || "New Bank", balance || 0, type);
        this.logSys(`Успех! Передайте этот API Ключ пользователю: ${key}`);
        alert(`Счет создан.\nAPI Ключ: ${key}\n(Скопируйте его и введите во вкладке "Счета" на аккаунте юзера)`);
    },
    
    renderP2PContractInterface: function() {
    const p2pPage = document.getElementById('page-p2p');
    const accounts = DB.getUserAccounts(this.currentUser.id);
    
    const isUser1 = this.currentUser.id === 'u_1';
    const partnerId = isUser1 ? 'u_2' : 'u_1';
    
    let accountsOptions = '';
    accounts.forEach(a => { accountsOptions += `<option value="${a.id}">${a.name} ($${a.balance})</option>`; });

    p2pPage.innerHTML = `
        <h1>Контрактная P2P Платформа Взаимопомощи</h1>
        <div class="charts-grid" style="grid-template-columns: 1fr 1fr; gap:20px;">
            
            <div class="chart-card">
                <h3>Шаг 1: Конфигурация сделки</h3>
                <p style="font-size:12px; color:var(--text-muted); margin-bottom:15px;">Вы отправляете обеспечение со своих счетов, партнер открывает вам шлюз.</p>
                
                <div class="form-group">
                    <label>Мой счет-донор (откуда спишутся деньги):</label>
                    <select id="contractSourceAcc" class="form-input">${accountsOptions}</select>
                </div>
                <div class="form-group">
                    <label>Сумма обеспечения обеспечения партнеру ($):</label>
                    <input type="number" id="contractAmount" value="10000" class="form-input">
                </div>
                <div class="form-group">
                    <label>Лимит трат на арендуемом счете ($):</label>
                    <input type="number" id="contractLimit" value="8000" class="form-input">
                </div>
                <div class="form-group">
                    <label>Комиссия за операцию (цена услуги $):</label>
                    <input type="number" id="contractFee" value="500" class="form-input">
                </div>
                
                <button class="btn btn-primary" style="width:100%" onclick="App.createP2PContract('${partnerId}')">Сформировать смарт-контракт</button>
            </div>

            <div class="chart-card" style="display:flex; flex-direction:column;">
                <h3>Чат-Контракты с контрагентом [${partnerId}]</h3>
                <div class="chat-history" id="p2p-contract-history" style="flex:1; min-height:300px; margin:15px 0; background:#f1f5f9;">
                    </div>
            </div>
        </div>
    `;
    this.updateContractListDisplay();
},

createP2PContract: function(targetUserId) {
    const srcAccId = document.getElementById('contractSourceAcc').value;
    const amount = parseFloat(document.getElementById('contractAmount').value);
    const limit = parseFloat(document.getElementById('contractLimit').value);
    const fee = parseFloat(document.getElementById('contractFee').value);

    const data = DB.getData();
    
    if (!data.contracts) data.contracts = [];

    const newContract = {
        id: 'cnt_' + Math.random().toString(36).substr(2, 9),
        senderId: this.currentUser.id,
        receiverId: targetUserId,
        sourceAccount: srcAccId,
        amount: amount,
        spendLimit: limit,
        fee: fee,
        status: 'PENDING'
    };

    data.contracts.push(newContract);
    DB.saveData(data);
    this.logSys(`📄 Сформирован контракт ${newContract.id}. Ожидание подписи партнера.`);
    this.updateContractListDisplay();
},

updateContractListDisplay: function() {
    const historyBox = document.getElementById('p2p-contract-history');
    if(!historyBox) return;
    historyBox.innerHTML = '';

    const data = DB.getData();
    
    if (!data.contracts) data.contracts = [];

    const myContracts = data.contracts.filter(c => c.senderId === this.currentUser.id || c.receiverId === this.currentUser.id);

    if(myContracts.length === 0) {
        historyBox.innerHTML = '<div class="msg sys">Нет активных или предложенных контрактов.</div>';
        return;
    }
    myContracts.forEach(c => {
        const isCreator = c.senderId === this.currentUser.id;
        const box = document.createElement('div');
        box.className = 'contract-box';
        
        let actionButton = '';
        if(c.status === 'PENDING') {
            actionButton = isCreator 
                ? `<span style="color:var(--warning); font-size:12px;">⏳ Ожидание подписи партнера</span>`
                : `<button class="btn btn-primary" style="width:100%; padding:5px; margin-top:10px;" onclick="App.signContract('${c.id}')">✍️ Подписать контракт и выполнить обмен</button>`;
        } else {
            actionButton = `<span style="color:var(--success); font-size:12px;">✅ Контракт исполнен</span>`;
        }

        box.innerHTML = `
            <strong>Договор #${c.id}</strong><br>
            <small>Инициатор: ${c.senderId}</small><br>
            💸 Обеспечение: <b>$${c.amount}</b><br>
            ⚡ Лимит аренды счета: <b>$${c.spendLimit}</b><br>
            💰 Стоимость услуги: <b>$${c.fee}</b>
            <div style="margin-top:10px; border-top:1px dashed var(--border); padding-top:5px;">
                ${actionButton}
            </div>
        `;
        historyBox.appendChild(box);
    });
},

signContract: function(contractId) {
    const data = DB.getData();
    const contract = data.contracts.find(c => c.id === contractId);
    
    if(!contract || contract.status !== 'PENDING') return;

    const senderAcc = data.accounts.find(a => a.id === contract.sourceAccount);
    const totalDeduction = contract.amount + contract.fee;

    if(senderAcc.balance < totalDeduction) {
        alert("Недостаточно средств на исходном счете для выполнения условий контракта!");
        return;
    }

    senderAcc.balance -= totalDeduction;

    const receiverFastAcc = data.accounts.find(a => a.userId === contract.receiverId && a.type === 'SEPA');
    
    if(!receiverFastAcc) {
        alert("У принимающей стороны нет подходящего скоростного счета для аренды.");
        return;
    }

    receiverFastAcc.balance += totalDeduction;

    const tempAccountForUser1 = {
        id: 'acc_temp_' + Math.random().toString(36).substr(2, 9),
        userId: contract.senderId,
        name: `⏳ Шлюз: ${receiverFastAcc.name} (Аренда)`,
        balance: contract.spendLimit,
        reserve: 0,
        type: receiverFastAcc.type,
        isTemporary: true,
        spendLimit: contract.spendLimit
    };
    
    data.accounts.push(tempAccountForUser1);
    contract.status = 'EXECUTED';
    
    DB.saveData(data);
    
    this.logSys(`🔐 Контракт подписан! Юзеру 1 предоставлен временный скоростной шлюз с лимитом $${contract.spendLimit}.`);
    
    this.updateContractListDisplay();
}
};