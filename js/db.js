const DB = {
    init: function() {
            if (!localStorage.getItem('abusafin_db')) {
            const emptyStructure = {
                users: [
                    { id: 'u_admin', login: 'admin', pass: '123', name: 'Администратор', company: 'AbusaFin Corp', isAdmin: true, autoApproveAI: false },
                    { id: 'u_1', login: 'user1', pass: '123', name: 'Иван (User 1)', company: 'Tech Logistics', isAdmin: false, autoApproveAI: false },
                    { id: 'u_2', login: 'user2', pass: '123', name: 'Олег (User 2)', company: 'Fast Liquidity Ltd', isAdmin: false, autoApproveAI: false }
                ],
                accounts: [
                    { id: 'acc_1', userId: 'u_admin', name: 'Основной счет', balance: 50000, reserve: 10000, type: 'SEPA' },
                    { id: 'acc_2', userId: 'u_admin', name: 'Резервный счет', balance: 45000, reserve: 5000, type: 'SWIFT' },
                    { id: 'acc_3', userId: 'u_1', name: 'Основной (Медленный)', balance: 5000, reserve: 1000, type: 'SWIFT' },
                    { id: 'acc_4', userId: 'u_1', name: 'Резервный Валютный', balance: 45000, reserve: 5000, type: 'SWIFT' },
                    { id: 'acc_5', userId: 'u_2', name: 'Экспресс-Шлюз Скоростной', balance: 30000, reserve: 0, type: 'SEPA' }
                ],
                contracts: [],
                externalDb: [] 
            };
            localStorage.setItem('abusafin_db', JSON.stringify(emptyStructure));
        }
    },

    getData: () => JSON.parse(localStorage.getItem('abusafin_db')),
    saveData: (data) => localStorage.setItem('abusafin_db', JSON.stringify(data)),

    login: function(login, pass) {
        const data = this.getData();
        const user = data.users.find(u => u.login === login && u.pass === pass);
        return user || null;
    },

    getUserAccounts: function(userId) {
        return this.getData().accounts.filter(a => a.userId === userId);
    },

    updateAccount: function(accData) {
        const data = this.getData();
        const idx = data.accounts.findIndex(a => a.id === accData.id);
        if(idx > -1) {
            data.accounts[idx] = accData;
            this.saveData(data);
        }
    },

    createExternalAccount: function(name, balance, type) {
        const data = this.getData();
        const newAcc = {
            id: 'acc_' + Math.random().toString(36).substr(2, 9),
            name: name, balance: balance, reserve: 0, type: type,
            isExternalKey: true
        };
        data.externalDb.push(newAcc);
        this.saveData(data);
        return newAcc.id; 
    },

    bindAccount: function(userId, keyId) {
        const data = this.getData();
        const extIdx = data.externalDb.findIndex(a => a.id === keyId);
        if(extIdx > -1) {
            let acc = data.externalDb[extIdx];
            acc.userId = userId;
            delete acc.isExternalKey;
            data.accounts.push(acc);
            data.externalDb.splice(extIdx, 1);
            this.saveData(data);
            return true;
        }
        return false;
    }
};

DB.init();