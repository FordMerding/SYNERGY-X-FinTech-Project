// ========================================================
// NEW CONTRACT MODAL LOGIC - Add these methods to your App object
// Paste inside the App = { ... } definition, for example after the existing chat methods
// ========================================================

    // ========== NEW MODAL-BASED CONTRACT FLOW ==========
    currentChatConvCache: null,   // cache last loaded conv for modal

    openContractModal: async function() {
        if (!this.currentChatKey) {
            alert('Нет активного чата');
            return;
        }

        const modal = document.getElementById('contractModal');
        if (!modal) {
            alert('Модальное окно контракта не найдено в HTML. Добавьте snippet.');
            return;
        }

        try {
            const res = await fetch(`/api/conversations/${this.currentChatKey}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error('Не удалось загрузить переговоры');
            const data = await res.json();
            const conv = data.conversation;
            this.currentChatConvCache = conv;

            const isSeeker = this.currentUser.id === conv.seekerId;
            const draft = conv.draftContract || {};
            const request = (await this.getRequestById(conv.requestId)) || {};

            // Meta header
            const metaEl = document.getElementById('modalContractMeta');
            if (metaEl) {
                metaEl.innerHTML = `${conv.draftContract?.gatewayType || request.type || 'Шлюз'} • Лимит $${conv.draftContract?.spendLimit || request.limitWanted || '?'} • Вознаграждение $${conv.draftContract?.fee || request.feeOffered || '?'}`;
            }

            // Show correct form
            const formSeeker = document.getElementById('contractFormSeeker');
            const formProvider = document.getElementById('contractFormProvider');
            const previewPane = document.getElementById('contractPreviewPane');

            if (formSeeker) formSeeker.style.display = isSeeker ? 'block' : 'none';
            if (formProvider) formProvider.style.display = isSeeker ? 'none' : 'block';
            if (previewPane) previewPane.style.display = 'none';

            // Populate my form
            if (isSeeker) {
                await this.populateModalSeekerForm(draft);
            } else {
                await this.populateModalProviderForm(draft);
            }

            // Show/hide sign button based on readiness
            const signBtn = document.getElementById('modalSignBtn');
            if (signBtn) {
                const seekerPayments = draft.seekerPayments || (draft.seekerPayment ? [draft.seekerPayment] : []);
                const providerReceives = draft.providerReceives || (draft.providerReceive ? [draft.providerReceive] : []);
                signBtn.style.display = (seekerPayments.length > 0 && providerReceives.length > 0) ? 'inline-block' : 'none';
            }

            modal.style.display = 'flex';

        } catch (e) {
            alert(e.message || 'Ошибка загрузки контракта');
        }
    },

    closeContractModal: function() {
        const modal = document.getElementById('contractModal');
        if (modal) modal.style.display = 'none';
        // Optionally refresh chat data
        if (this.currentChatKey) {
            setTimeout(() => this.loadChatData(true), 300);
        }
    },

    getRequestById: async function(requestId) {
        try {
            const res = await fetch('/api/requests?mine=true', { headers: { 'Authorization': `Bearer ${this.token}` } });
            const all = res.ok ? await res.json() : [];
            return all.find(r => r.id === requestId) || null;
        } catch (_) { return null; }
    },

    populateModalSeekerForm: async function(draft) {
        const sel = document.getElementById('modalSeekerAccount');
        const amt = document.getElementById('modalSeekerAmount');
        if (!sel || !amt) return;

        // Load my accounts
        const myAccsRes = await fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } });
        const myAccs = myAccsRes.ok ? await myAccsRes.json() : [];

        sel.innerHTML = '';
        myAccs.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = `${a.name} ($${ (a.balance||0).toLocaleString() })`;
            sel.appendChild(opt);
        });

        // Pre-fill if already proposed
        const seekerPayments = draft.seekerPayments || (draft.seekerPayment ? [draft.seekerPayment] : []);
        if (seekerPayments.length > 0) {
            const first = seekerPayments[0];
            sel.value = first.accountId;
            amt.value = first.amount;
        } else if (draft.fee) {
            amt.value = draft.fee; // default to fee from request
        }
    },

    populateModalProviderForm: async function(draft) {
        const sel = document.getElementById('modalProviderAccount');
        const amt = document.getElementById('modalProviderAmount');
        if (!sel || !amt) return;

        const myAccsRes = await fetch('/api/accounts', { headers: { 'Authorization': `Bearer ${this.token}` } });
        const myAccs = myAccsRes.ok ? await myAccsRes.json() : [];

        sel.innerHTML = '';
        myAccs.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = `${a.name} ($${ (a.balance||0).toLocaleString() })`;
            sel.appendChild(opt);
        });

        const providerReceives = draft.providerReceives || (draft.providerReceive ? [draft.providerReceive] : []);
        if (providerReceives.length > 0) {
            const first = providerReceives[0];
            sel.value = first.accountId;
            amt.value = first.amount;
        } else if (draft.fee) {
            amt.value = draft.fee;
        }
    },

    submitModalContractPart: async function(role) {
        if (!this.currentChatKey) return;

        const isSeekerRole = role === 'seeker';
        const accIdEl = document.getElementById(isSeekerRole ? 'modalSeekerAccount' : 'modalProviderAccount');
        const amountEl = document.getElementById(isSeekerRole ? 'modalSeekerAmount' : 'modalProviderAmount');

        const accountId = accIdEl ? accIdEl.value : null;
        const amount = parseFloat(amountEl ? amountEl.value : 0);

        if (!accountId || !amount || amount <= 0) {
            alert('Выберите счёт и укажите корректную сумму');
            return;
        }

        try {
            const res = await fetch(`/api/conversations/${this.currentChatKey}/propose`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
                body: JSON.stringify({ role, accountId, amount })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка отправки части контракта');

            this.logSys(`Часть контракта (${role}) отправлена.`);

            // Refresh modal with new data
            await this.openContractModal(); // re-open to refresh state
            // Also refresh main chat in background
            this.loadChatData(true);

        } catch (e) {
            alert(e.message);
        }
    },

    showContractPreview: async function() {
        if (!this.currentChatKey || !this.currentChatConvCache) {
            // reload if needed
            const res = await fetch(`/api/conversations/${this.currentChatKey}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) return;
            const d = await res.json();
            this.currentChatConvCache = d.conversation;
        }

        const conv = this.currentChatConvCache;
        const draft = conv.draftContract || {};

        const seekerPayments = draft.seekerPayments || (draft.seekerPayment ? [draft.seekerPayment] : []);
        const providerReceives = draft.providerReceives || (draft.providerReceive ? [draft.providerReceive] : []);

        // Hide forms, show preview
        const formSeeker = document.getElementById('contractFormSeeker');
        const formProvider = document.getElementById('contractFormProvider');
        const previewPane = document.getElementById('contractPreviewPane');

        if (formSeeker) formSeeker.style.display = 'none';
        if (formProvider) formProvider.style.display = 'none';
        if (previewPane) previewPane.style.display = 'block';

        // Populate preview content
        const seekerContent = document.getElementById('previewSeekerContent');
        const providerContent = document.getElementById('previewProviderContent');

        if (seekerContent) {
            if (seekerPayments.length > 0) {
                let html = '';
                seekerPayments.forEach(p => {
                    html += `• $${p.amount} со счёта <b>${this.getAccountNameSync(p.accountId)}</b><br>`;
                });
                seekerContent.innerHTML = html;
            } else {
                seekerContent.innerHTML = '<span style="color:#94a3b8;">Пока не заполнено</span>';
            }
        }

        if (providerContent) {
            if (providerReceives.length > 0) {
                let html = '';
                providerReceives.forEach(p => {
                    html += `• $${p.amount} на счёт <b>${this.getAccountNameSync(p.accountId)}</b><br>`;
                });
                providerContent.innerHTML = html;
            } else {
                providerContent.innerHTML = '<span style="color:#94a3b8;">Пока не заполнено</span>';
            }
        }
    },

    // Helper to show nice account name (sync version, best effort)
    getAccountNameSync: function(accountId) {
        // This is a simple cache-less version. For production you can keep a small map.
        // For now we return short id or you can enhance by caching accounts.
        return accountId ? accountId.slice(0, 8) + '...' : '—';
    },

    signFinalContractFromModal: async function() {
        if (!this.currentChatKey) return;
        if (!confirm('Подписать финальный контракт?\nПосле второй подписи сделка исполнится автоматически.')) return;

        try {
            const res = await fetch(`/api/conversations/${this.currentChatKey}/sign`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Ошибка подписи');

            if (data.pendingExecution || data.waitingForOther) {
                this.logSys('Вы подписали. Ожидаем подпись второй стороны или исполнение.');
                this.closeContractModal();
                await this.loadChatData(true);
            } else {
                this.logSys('🎉 Контракт полностью подписан и будет исполнен!');
                this.closeContractModal();
                setTimeout(() => {
                    this.navigate('p2p-negotiations');
                    this.renderAccounts();
                    this.updateDashboardKPIsAndPredictor();
                }, 800);
            }
        } catch (e) {
            alert(e.message);
        }
    },

    // Optional: enhance existing loadChatData to show contract status badge
    // (you can call this after rendering messages)
    updateChatContractStatusBadge: function(conv) {
        // You can add a small status pill near the header if you want
        // For example document.getElementById('chatContractStatus').innerText = ...
    }
