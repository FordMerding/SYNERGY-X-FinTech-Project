const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DB_PATH = path.join(__dirname, 'db.json');
const FRONT_DIR = path.join(__dirname, '../front');

// Set to true only if you want noisy simulation logs in terminal (for debugging)
const SHOW_CONSOLE_LOGS = false;

let db = null;
let activeTokens = {}; // token -> {userId, createdAt}
const pendingExecutions = {}; // convKey -> setTimeout id for delayed contract execution

const delays = { 'SEPA': 5000, 'SWIFT': 10000, 'CARD': 20000 };

function initDB() {
  if (fs.existsSync(DB_PATH)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      if (!db.predictors) {
        db.predictors = {};
      }
      if (!db.logs) db.logs = [];
      if (!db.contracts) db.contracts = [];
      if (!db.externalDb) db.externalDb = [];
      if (!db.requests) db.requests = [];
      if (!db.conversations) db.conversations = {};
      // migrate old global predictor if exists
      if (db.predictor && Object.keys(db.predictors).length === 0) {
        // will be rebuilt per user on first step
        delete db.predictor;
      }
      console.log('DB loaded from file');
      return;
    } catch (e) {
      console.error('DB parse error, reinitializing');
    }
  }

  db = {
    users: [
      { id: 'u_admin', login: 'admin', pass: '123', name: 'Администратор', company: 'AbusaFin Corp', isAdmin: true, autoApproveAI: false },
      { id: 'u_1', login: 'user1', pass: '123', name: 'Абуса-Карим', company: 'Tech Logistics', isAdmin: false, autoApproveAI: false },
      { id: 'u_2', login: 'user2', pass: '123', name: 'Абуса-Нурис', company: 'Fast Liquidity Ltd', isAdmin: false, autoApproveAI: false }
    ],
    accounts: [
      { id: 'acc_1', userId: 'u_admin', name: 'Основной счет', balance: 50000, reserve: 10000, type: 'SEPA' },
      { id: 'acc_2', userId: 'u_admin', name: 'Резервный счет', balance: 45000, reserve: 5000, type: 'SWIFT' },
      { id: 'acc_3', userId: 'u_1', name: 'Основной (Медленный)', balance: 5000, reserve: 1000, type: 'SEPA' },
      { id: 'acc_4', userId: 'u_1', name: 'Резервный Валютный', balance: 45000, reserve: 5000, type: 'SWIFT' },
      { id: 'acc_5', userId: 'u_2', name: 'Экспресс-Шлюз Скоростной', balance: 30000, reserve: 0, type: 'SEPA' },
      { id: 'acc_5', userId: 'u_2', name: 'Резервный Валютный', balance: 30000, reserve: 0, type: 'SWIFT' }
    ],
    contracts: [],
    externalDb: [],
    logs: [],
    requests: [],
    conversations: {},
    predictors: {}
  };
  saveDB();
  console.log('DB initialized with demo data');
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function addLog(msg, affectedUsers = [], meta = null) {
  const entry = { time: new Date().toISOString(), msg, affectedUsers: affectedUsers || [], meta: meta || null };
  db.logs.push(entry);
  if (db.logs.length > 80) db.logs.shift();
  saveDB();
  if (SHOW_CONSOLE_LOGS) {
    console.log('[LOG]', msg);
  }
}

// Execute a pending contract after the review timer
function executePendingContract(convKey) {
  const conv = db.conversations[convKey];
  if (!conv || conv.status !== 'SIGNED_PENDING') return;

  const draft = conv.draftContract || {};
  const seekerPayments = draft.seekerPayments || (draft.seekerPayment ? [draft.seekerPayment] : []);
  const providerReceives = draft.providerReceives || (draft.providerReceive ? [draft.providerReceive] : []);

  if (seekerPayments.length === 0 || providerReceives.length === 0) {
    conv.status = 'CANCELLED';
    saveDB();
    return;
  }

  // Calculate total to pay
  const totalPayment = seekerPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Find first seeker account with enough balance (simplified for demo)
  let remaining = totalPayment;
  for (const p of seekerPayments) {
    const acc = db.accounts.find(a => a.id === p.accountId);
    if (!acc || acc.balance < p.amount) {
      addLog(`⚠️ Ошибка исполнения: недостаточно средств на счёте ${p.accountId}`, [conv.seekerId]);
      conv.status = 'CANCELLED';
      saveDB();
      return;
    }
    acc.balance -= p.amount;
    remaining -= p.amount;
  }

  // Credit provider receives (distribute)
  for (const r of providerReceives) {
    const acc = db.accounts.find(a => a.id === r.accountId);
    if (acc) {
      acc.balance += r.amount;
    }
  }

  // Create temporary gateway for seeker (only spendable)
  const tempAcc = {
    id: 'acc_temp_' + Math.random().toString(36).slice(2, 10),
    userId: conv.seekerId,
    name: `⏳ Арендованный шлюз ${draft.gatewayType} (лимит $${draft.spendLimit})`,
    balance: draft.spendLimit,
    reserve: 0,
    type: draft.gatewayType,
    isTemporary: true,
    spendLimit: draft.spendLimit,
    createdAt: new Date().toISOString()
  };
  db.accounts.push(tempAcc);

  // Finalize
  conv.status = 'EXECUTED';
  conv.executedAt = new Date().toISOString();

  const request = db.requests.find(r => r.id === conv.requestId);
  if (request) request.status = 'CLOSED';

  saveDB();

  const totalPaid = seekerPayments.reduce((s, p) => s + p.amount, 0);
  addLog(`🔐 КОНТРАКТ ИСПОЛНЕН (с задержкой). ${conv.seekerId} получил шлюз $${draft.spendLimit}. Всего переведено $${totalPaid}.`, [conv.seekerId, conv.providerId]);
}

function generateToken(userId) {
  const token = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  activeTokens[token] = { userId, createdAt: Date.now() };
  return token;
}

function getUserFromToken(token) {
  if (!token || !activeTokens[token]) return null;
  const session = activeTokens[token];
  // simple expiry 24h
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    delete activeTokens[token];
    return null;
  }
  return db.users.find(u => u.id === session.userId) || null;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  return mimes[ext] || 'application/octet-stream';
}

function sendJSON(res, data, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ============ PREDICTOR SIMULATION (COMPLEX, SERVER-SIDE, PER-USER) ============
let globalSimStep = 30;

function getOrInitUserPredictor(userId) {
  if (!db.predictors) db.predictors = {};
  if (!db.predictors[userId]) {
    db.predictors[userId] = {
      labels: Array.from({ length: 12 }, (_, i) => `День ${globalSimStep - 11 + i}`),
      data: Array.from({ length: 12 }, () => 18000 + Math.floor(Math.random() * 12000)),
      status: 'Мониторинг потоков...',
      timelineIndex: globalSimStep
    };
  }
  return db.predictors[userId];
}

function runPredictorStep() {
  globalSimStep += 1;

  // === Small random money flows (simulate real activity) - tag affected user ===
  if (Math.random() < 0.65) {
    const numFlows = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numFlows; i++) {
      const acc = db.accounts[Math.floor(Math.random() * db.accounts.length)];
      const delta = Math.floor((Math.random() - 0.5) * 4200);
      if (delta !== 0) {
        acc.balance = Math.max(0, acc.balance + delta);
        const affected = [acc.userId];
        if (delta < -800) {
          addLog(`📉 Симуляция движения: Счет "${acc.name}" — расход $${Math.abs(delta)}`, affected);
        } else if (delta > 1200) {
          addLog(`📈 Симуляция движения: Счет "${acc.name}" — поступление $${delta}`, affected);
        }
      }
    }
  }

  // === Per-user predictor update + risk detection ===
  if (!db.users) return;

  db.users.forEach(user => {
    const pred = getOrInitUserPredictor(user.id);

    pred.timelineIndex = globalSimStep;

    // Calculate THIS user's available liquidity for unique chart
    const myAccs = db.accounts.filter(a => a.userId === user.id);
    let myAvailable = 0;
    myAccs.forEach(acc => {
      myAvailable += Math.max(0, (acc.balance || 0) - (acc.reserve || 0));
    });

    // Unique fluctuation per user
    let nextValue = myAvailable + (Math.random() - 0.5) * 3800;
    if (Math.random() < 0.12) nextValue -= (8000 + Math.random() * 6000);

    pred.labels = pred.labels || [];
    pred.data = pred.data || [];
    pred.labels.push(`День ${pred.timelineIndex}`);
    pred.data.push(Math.max(6000, Math.floor(nextValue)));

    if (pred.data.length > 18) {
      pred.labels.shift();
      pred.data.shift();
    }

    // Risk check per user (every ~7 steps or key moments)
    const shouldCheckRiskForUser = (globalSimStep % 7 === 0) || (globalSimStep % 11 === 0);

    if (shouldCheckRiskForUser) {
      const potentialRisk = myAccs.filter(a => {
        const avail = (a.balance || 0) - (a.reserve || 0);
        return avail > 0 && avail < 16500;
      });

      if (potentialRisk.length > 0) {
        const riskAcc = potentialRisk[Math.floor(Math.random() * potentialRisk.length)];
        const needed = 6200 + Math.floor(Math.random() * 6800);
        const reasons = [
          'Крупный исходящий платеж по P2P контракту (SWIFT)',
          'Ожидаемый операционный расход / выплата поставщикам',
          'Симулированный кассовый разрыв из-за задержки входящих',
          'Плановый вывод средств на внешний счет'
        ];
        const reason = reasons[Math.floor(Math.random() * reasons.length)];

        // CLEAN log: no u_1, no username (user knows it's his)
        let logMsg = `🤖 [AI ПРЕДИКТОР]: ⚠️ РИСК ЛИКВИДНОСТИ на счете "${riskAcc.name}". Причина: ${reason}. Требуется покрытие ≈ $${needed}. `;

        const meta = { type: 'risk', accountId: riskAcc.id, needed, reason, userId: user.id };

        if (user.autoApproveAI) {
          logMsg += 'Автоматическая перебалансировка ВКЛЮЧЕНА. ';

          const myOtherAccounts = db.accounts.filter(a =>
            a.userId === user.id &&
            a.id !== riskAcc.id &&
            ((a.balance || 0) - (a.reserve || 0)) > 2500
          );

          let totalCovered = 0;
          const transfersDone = [];

          myOtherAccounts.sort((x, y) => ((y.balance || 0) - (y.reserve || 0)) - ((x.balance || 0) - (x.reserve || 0)));

          for (const other of myOtherAccounts) {
            if (totalCovered >= needed) break;
            const avail = (other.balance || 0) - (other.reserve || 0);
            const take = Math.min(avail, needed - totalCovered, Math.floor(avail * 0.55));
            if (take >= 800) {
              other.balance -= take;
              riskAcc.balance += take;
              totalCovered += take;
              transfersDone.push({ from: other.name, amount: take });
            }
          }

          if (totalCovered > 0) {
            logMsg += `Переброшено $${totalCovered} с ${transfersDone.length} других счетов.`;
            transfersDone.forEach(t => {
              addLog(`   ↳ $${t.amount} перемещено с "${t.from}" → "${riskAcc.name}" (авто)`, [user.id]);
            });
            saveDB();
          } else {
            logMsg += 'Недостаточно свободных средств на других счетах.';
          }
        } else {
          logMsg += 'Авто-балансировка ОТКЛЮЧЕНА. Требуется подтверждение в логах или P2P-аренда шлюза.';
        }

        addLog(logMsg, [user.id], meta);
        pred.status = `⚠️ Риск на "${riskAcc.name}" — ${reason.split(' ').slice(0, 3).join(' ')}...`;
        saveDB();
      } else {
        pred.status = 'Все счета в норме';
      }
    } else if (globalSimStep % 4 === 0) {
      pred.status = 'Мониторинг потоков...';
    }
  });

  saveDB();
}

// ============ API ROUTES ============
async function handleAPI(req, res, pathname, method, body, currentUser) {
  // LOGIN (public)
  if (pathname === '/api/login' && method === 'POST') {
    const { login, pass } = body;
    const user = db.users.find(u => u.login === login && u.pass === pass);
    if (!user) return sendJSON(res, { error: 'Неверный логин или пароль' }, 401);
    const token = generateToken(user.id);
    const safeUser = { ...user };
    delete safeUser.pass;
    addLog(`Вход пользователя: ${user.name} (${user.id})`);
    return sendJSON(res, { token, user: safeUser });
  }

  if (!currentUser && !['/api/login', '/api/predictor', '/api/logs'].includes(pathname)) {
    return sendJSON(res, { error: 'Unauthorized' }, 401);
  }

  // ME
  if (pathname === '/api/me' && method === 'GET') {
    const safe = { ...currentUser };
    delete safe.pass;
    return sendJSON(res, safe);
  }

  // ACCOUNTS
  if (pathname === '/api/accounts' && method === 'GET') {
    const myAccounts = db.accounts.filter(a => a.userId === currentUser.id);
    return sendJSON(res, myAccounts);
  }

  // TRANSFER (with delay simulation)
  if (pathname === '/api/transfer' && method === 'POST') {
    const { fromAccId, toAccId, amount: rawAmount } = body;
    const amount = parseFloat(rawAmount);
    if (!fromAccId || !toAccId || isNaN(amount) || amount <= 0) {
      return sendJSON(res, { error: 'Некорректные данные' }, 400);
    }

    const fromAcc = db.accounts.find(a => a.id === fromAccId && a.userId === currentUser.id);
    const toAcc = db.accounts.find(a => a.id === toAccId); // can be any, even other user for demo

    if (!fromAcc || !toAcc) return sendJSON(res, { error: 'Счет не найден' }, 404);

    const available = (fromAcc.balance || 0) - (fromAcc.reserve || 0);
    if (amount > available) {
      return sendJSON(res, { error: 'Недостаточно средств с учетом НЗ' }, 400);
    }

    // TEMP ACCOUNT RULES: can only spend, enforce spendLimit, auto-remove when exhausted
    if (fromAcc.isTemporary) {
      if (!fromAcc.spent) fromAcc.spent = 0;
      const spendLimit = fromAcc.spendLimit || fromAcc.balance;
      if (fromAcc.spent + amount > spendLimit) {
        return sendJSON(res, { error: 'Превышен лимит трат временного шлюза. Система безопасности активирована.' }, 400);
      }
      fromAcc.spent += amount;
    }

    fromAcc.balance -= amount;
    const delayMs = delays[fromAcc.type] || 5000;

    addLog(`🔄 Инициирован перевод $${amount} со счета "${fromAcc.name}" → "${toAcc.name}". Ожидание ${fromAcc.type}: ${delayMs / 1000} сек.`);

    saveDB();

    setTimeout(() => {
      if (toAcc.isTemporary) {
        // SECURITY: refund immediately, temp cannot earn
        fromAcc.balance += amount;
        addLog(`⚠️ Перевод на временный шлюз "${toAcc.name}" отклонён — временные шлюзы не могут зарабатывать средства (только тратить). Возврат $${amount} отправителю.`, [fromAcc.userId]);
        saveDB();
        return;
      }
      toAcc.balance += amount;

      // Check if temp fromAcc is now exhausted (after spend)
      if (fromAcc.isTemporary && (fromAcc.balance <= 0 || fromAcc.spent >= (fromAcc.spendLimit || 0))) {
        db.accounts = db.accounts.filter(a => a.id !== fromAcc.id);
        addLog(`🗑️ Временный шлюз "${fromAcc.name}" полностью исчерпан и удалён из системы.`, [fromAcc.userId]);
      }

      addLog(`✅ Перевод $${amount} успешно доставлен на "${toAcc.name}"!`);
      saveDB();
    }, delayMs);

    // Immediate check for exhaustion on sender temp (in case no delay credit affects it)
    if (fromAcc.isTemporary && (fromAcc.balance <= 0 || fromAcc.spent >= (fromAcc.spendLimit || 0))) {
      db.accounts = db.accounts.filter(a => a.id !== fromAcc.id);
      addLog(`🗑️ Временный шлюз "${fromAcc.name}" полностью исчерпан и удалён.`);
      saveDB();
    }

    return sendJSON(res, { success: true, etaSeconds: delayMs / 1000 });
  }

  // BIND EXTERNAL ACCOUNT (by key = id)
  if (pathname === '/api/accounts/bind' && method === 'POST') {
    const { key } = body;
    if (!key) return sendJSON(res, { error: 'Ключ не указан' }, 400);

    const extIdx = db.externalDb.findIndex(e => e.id === key);
    if (extIdx === -1) return sendJSON(res, { error: 'Ключ не найден или уже использован' }, 404);

    const extAcc = db.externalDb[extIdx];
    extAcc.userId = currentUser.id;
    delete extAcc.isExternalKey;

    db.accounts.push(extAcc);
    db.externalDb.splice(extIdx, 1);
    saveDB();

    addLog(`Счет "${extAcc.name}" привязан к пользователю ${currentUser.name}`);
    return sendJSON(res, { success: true, account: extAcc });
  }

  // CONTRACTS
  if (pathname === '/api/contracts' && method === 'GET') {
    const myContracts = db.contracts.filter(c =>
      c.senderId === currentUser.id || c.receiverId === currentUser.id
    );
    return sendJSON(res, myContracts);
  }

  if (pathname === '/api/contracts' && method === 'POST') {
    const { partnerId, sourceAccount, amount, spendLimit, fee } = body;
    if (!partnerId || !sourceAccount || !amount || !spendLimit || !fee) {
      return sendJSON(res, { error: 'Заполните все поля контракта' }, 400);
    }
    if (partnerId === currentUser.id) {
      return sendJSON(res, { error: 'Нельзя создать контракт с самим собой' }, 400);
    }

    const srcAcc = db.accounts.find(a => a.id === sourceAccount && a.userId === currentUser.id);
    if (!srcAcc) return sendJSON(res, { error: 'Исходный счет не найден' }, 404);

    const newContract = {
      id: 'cnt_' + Math.random().toString(36).slice(2, 11),
      senderId: currentUser.id,
      receiverId: partnerId,
      sourceAccount,
      amount: parseFloat(amount),
      spendLimit: parseFloat(spendLimit),
      fee: parseFloat(fee),
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };

    db.contracts.push(newContract);
    saveDB();
    addLog(`📄 Создан P2P контракт ${newContract.id} между ${currentUser.id} и ${partnerId}. Ожидание подписи.`);
    return sendJSON(res, { success: true, contract: newContract });
  }

  // SIGN CONTRACT (receiver only)
  if (pathname.match(/^\/api\/contracts\/([^/]+)\/sign$/) && method === 'POST') {
    const contractId = pathname.split('/')[3];
    const contract = db.contracts.find(c => c.id === contractId && c.status === 'PENDING');
    if (!contract) return sendJSON(res, { error: 'Контракт не найден или уже исполнен' }, 404);
    if (contract.receiverId !== currentUser.id) {
      return sendJSON(res, { error: 'Только получатель может подписать контракт' }, 403);
    }

    const senderAcc = db.accounts.find(a => a.id === contract.sourceAccount);
    if (!senderAcc) return sendJSON(res, { error: 'Счет отправителя не найден' }, 404);

    const totalDeduction = contract.amount + contract.fee;
    if (senderAcc.balance < totalDeduction) {
      return sendJSON(res, { error: 'Недостаточно средств на счете отправителя' }, 400);
    }

    // Execute
    senderAcc.balance -= totalDeduction;

    // Find fast SEPA account of receiver to credit
    let receiverFastAcc = db.accounts.find(a => a.userId === contract.receiverId && a.type === 'SEPA');
    if (!receiverFastAcc) {
      // fallback to any account of receiver
      receiverFastAcc = db.accounts.find(a => a.userId === contract.receiverId);
    }
    if (receiverFastAcc) {
      receiverFastAcc.balance += totalDeduction;
    }

    // Create temporary rented gateway account for the SENDER (u1 in original)
    const tempAcc = {
      id: 'acc_temp_' + Math.random().toString(36).slice(2, 10),
      userId: contract.senderId,
      name: `⏳ Шлюз: ${receiverFastAcc ? receiverFastAcc.name : 'SEPA'} (Аренда)`,
      balance: contract.spendLimit,
      reserve: 0,
      type: receiverFastAcc ? receiverFastAcc.type : 'SEPA',
      isTemporary: true,
      spendLimit: contract.spendLimit,
      createdAt: new Date().toISOString()
    };
    db.accounts.push(tempAcc);

    contract.status = 'EXECUTED';
    contract.executedAt = new Date().toISOString();

    saveDB();

    addLog(`🔐 Контракт ${contractId} подписан и исполнен! Пользователю ${contract.senderId} предоставлен временный шлюз с лимитом $${contract.spendLimit}.`);
    return sendJSON(res, { success: true, tempAccountId: tempAcc.id });
  }

  // ============================================================
  // NEW FULL CONTRACTS LOGIC: Public Requests + Chat Negotiation + Dual-Side Contract
  // ============================================================

  // GET all open public requests (non-confidential info only)
  if (pathname === '/api/requests' && method === 'GET') {
    // Support ?mine=true to see own requests (any status)
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const showMine = urlObj.searchParams.get('mine') === 'true';

    let filtered = db.requests || [];
    if (!showMine) {
      filtered = filtered.filter(r => r.status === 'OPEN' && r.creatorId !== currentUser.id);
    } else {
      filtered = filtered.filter(r => r.creatorId === currentUser.id);
    }

    const result = filtered.map(r => ({
      id: r.id,
      type: r.type,
      limitWanted: r.limitWanted,
      feeOffered: r.feeOffered,
      description: r.description,
      createdAt: r.createdAt,
      status: r.status || 'OPEN',
      creatorCompany: (db.users.find(u => u.id === r.creatorId) || {}).company || 'Unknown',
      creatorId: r.creatorId
    }));
    return sendJSON(res, result);
  }

  // Create new public liquidity request (non-confidential)
  if (pathname === '/api/requests' && method === 'POST') {
    const { type, limitWanted, feeOffered, description } = body;
    if (!type || !limitWanted || !feeOffered) {
      return sendJSON(res, { error: 'Укажите тип шлюза, лимит и размер вознаграждения' }, 400);
    }
    const newReq = {
      id: 'req_' + Math.random().toString(36).slice(2, 10),
      creatorId: currentUser.id,
      type,
      limitWanted: parseFloat(limitWanted),
      feeOffered: parseFloat(feeOffered),
      description: description || 'Нужен быстрый шлюз для операционных платежей',
      status: 'OPEN',
      createdAt: new Date().toISOString()
    };
    db.requests.push(newReq);
    saveDB();
    addLog(`📢 Опубликован публичный запрос на шлюз ${type} (лимит $${newReq.limitWanted}, вознаграждение $${newReq.feeOffered})`, [currentUser.id]);
    return sendJSON(res, { success: true, request: newReq });
  }

  // Respond to request → create/get conversation (opens chat)
  if (pathname.match(/^\/api\/requests\/([^/]+)\/respond$/) && method === 'POST') {
    const reqId = pathname.split('/')[3];
    const request = db.requests.find(r => r.id === reqId && r.status === 'OPEN');
    if (!request) return sendJSON(res, { error: 'Запрос не найден или уже закрыт' }, 404);
    if (request.creatorId === currentUser.id) {
      return sendJSON(res, { error: 'Нельзя отвечать на свой запрос' }, 400);
    }

    // Use requestId as conversation key. Each public request gets its own dedicated chat/negotiation.
    // This fixes the problem where multiple contracts between the same two companies collapsed into one chat.
    const seekerId = request.creatorId;
    const providerId = currentUser.id;
    const convKey = reqId;

    if (!db.conversations[convKey]) {
      db.conversations[convKey] = {
        id: 'conv_' + Math.random().toString(36).slice(2, 10),
        seekerId,
        providerId,
        requestId: reqId,
        createdAt: new Date().toISOString(),
        messages: [],
        draftContract: {
          gatewayType: request.type,
          spendLimit: request.limitWanted,
          fee: request.feeOffered,
          seekerPayments: [],      // array of {accountId, amount} - multiple source accounts supported
          providerReceives: []     // array of {accountId, amount} - multiple destination accounts supported
        },
        signedBy: [],
        status: 'ACTIVE'
      };
      request.status = 'NEGOTIATING';
      saveDB();
    }

    addLog(`💬 Начаты переговоры по запросу ${reqId} между ${seekerId} и ${providerId}`, [seekerId, providerId]);
    return sendJSON(res, { success: true, conversationKey: convKey, conversation: db.conversations[convKey] });
  }

  // GET list of my conversations (for chat list UI)
  if (pathname === '/api/conversations' && method === 'GET') {
    const myConvs = Object.entries(db.conversations || {})
      .filter(([key, conv]) => conv.seekerId === currentUser.id || conv.providerId === currentUser.id)
      .map(([key, conv]) => {
        const isSeeker = conv.seekerId === currentUser.id;
        const partnerId = isSeeker ? conv.providerId : conv.seekerId;
        const partner = db.users.find(u => u.id === partnerId);
        const request = (db.requests || []).find(r => r.id === conv.requestId);
        const lastMsg = conv.messages && conv.messages.length > 0 
          ? conv.messages[conv.messages.length - 1] 
          : null;

        return {
          key,
          partnerId,
          partnerName: partner ? partner.name : 'Unknown',
          partnerCompany: partner ? partner.company : '',
          requestId: conv.requestId,
          requestType: request ? request.type : '',
          requestDesc: request ? (request.description || '') : '',
          status: conv.status || 'ACTIVE',
          draftReady: !!(conv.draftContract && conv.draftContract.seekerPayment && conv.draftContract.providerReceive),
          signedCount: (conv.signedBy || []).length,
          lastMessageTime: lastMsg ? lastMsg.time : (conv.createdAt || new Date().toISOString()),
          lastMessagePreview: lastMsg ? lastMsg.text.substring(0, 60) : 'Нет сообщений'
        };
      })
      // sort by last activity
      .sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

    return sendJSON(res, myConvs);
  }

  // Get conversation with partner (or by key)
  if (pathname.match(/^\/api\/conversations\/([^/]+)$/) && method === 'GET') {
    const partnerOrKey = pathname.split('/')[3];
    let convKey = partnerOrKey;
    if (!db.conversations[convKey]) {
      // try to find by partner
      const possibleKeys = Object.keys(db.conversations).filter(k => k.includes(partnerOrKey));
      if (possibleKeys.length > 0) convKey = possibleKeys[0];
    }
    const conv = db.conversations[convKey];
    if (!conv) return sendJSON(res, { error: 'Чат не найден' }, 404);

    // Security: only participants
    if (conv.seekerId !== currentUser.id && conv.providerId !== currentUser.id) {
      return sendJSON(res, { error: 'Нет доступа к этому чату' }, 403);
    }
    return sendJSON(res, { conversation: conv, key: convKey });
  }

  // Send message in conversation
  if (pathname.match(/^\/api\/conversations\/([^/]+)\/message$/) && method === 'POST') {
    const convKey = pathname.split('/')[3];
    const conv = db.conversations[convKey];
    if (!conv) return sendJSON(res, { error: 'Чат не найден' }, 404);
    if (conv.seekerId !== currentUser.id && conv.providerId !== currentUser.id) {
      return sendJSON(res, { error: 'Нет доступа' }, 403);
    }
    const { text } = body;
    if (!text || text.trim().length < 2) return sendJSON(res, { error: 'Сообщение слишком короткое' }, 400);

    conv.messages.push({
      fromId: currentUser.id,
      text: text.trim(),
      time: new Date().toISOString()
    });
    if (conv.messages.length > 50) conv.messages.shift();
    saveDB();
    return sendJSON(res, { success: true });
  }

  // Update my part of the draft contract (seeker or provider)
  if (pathname.match(/^\/api\/conversations\/([^/]+)\/propose$/) && method === 'POST') {
    const convKey = pathname.split('/')[3];
    const conv = db.conversations[convKey];
    if (!conv || conv.status !== 'ACTIVE') return sendJSON(res, { error: 'Чат не активен' }, 404);
    if (conv.seekerId !== currentUser.id && conv.providerId !== currentUser.id) {
      return sendJSON(res, { error: 'Нет доступа' }, 403);
    }

    const { role, payments } = body; // role = 'seeker' or 'provider', payments = [{accountId, amount}, ...]
    if (!role || !Array.isArray(payments)) return sendJSON(res, { error: 'Неполные данные: role и массив payments required' }, 400);

    const isSeeker = currentUser.id === conv.seekerId;
    if ((role === 'seeker' && !isSeeker) || (role === 'provider' && isSeeker)) {
      return sendJSON(res, { error: 'Вы не можете заполнять часть другой стороны' }, 403);
    }

    // Validate all accounts belong to current user and amounts positive
    for (const p of payments) {
      if (!p.accountId || typeof p.amount !== 'number' || p.amount <= 0) {
        return sendJSON(res, { error: 'Некорректная сумма или счёт в payments' }, 400);
      }
      const myAcc = db.accounts.find(a => a.id === p.accountId && a.userId === currentUser.id);
      if (!myAcc) return sendJSON(res, { error: `Счёт ${p.accountId} не найден или не ваш` }, 404);
    }

    // Replace the whole side array (allows edit amounts + add/remove in one go)
    if (role === 'seeker') {
      conv.draftContract.seekerPayments = payments.map(p => ({ accountId: p.accountId, amount: parseFloat(p.amount) }));
    } else {
      conv.draftContract.providerReceives = payments.map(p => ({ accountId: p.accountId, amount: parseFloat(p.amount) }));
    }
    saveDB();

    addLog(`📝 ${currentUser.name} обновил часть контракта (${role}) — ${payments.length} счёт(ов)`, [currentUser.id]);
    return sendJSON(res, { success: true, draft: conv.draftContract });
  }

  // Sign final contract (both sides must sign)
  if (pathname.match(/^\/api\/conversations\/([^/]+)\/sign$/) && method === 'POST') {
    const convKey = pathname.split('/')[3];
    const conv = db.conversations[convKey];
    if (!conv || conv.status !== 'ACTIVE') return sendJSON(res, { error: 'Чат не активен для подписи' }, 404);
    if (conv.seekerId !== currentUser.id && conv.providerId !== currentUser.id) {
      return sendJSON(res, { error: 'Нет доступа' }, 403);
    }

    const draft = conv.draftContract || {};

    // Support both old single format and new array format for backward compatibility
    const seekerPayments = draft.seekerPayments && draft.seekerPayments.length > 0 
      ? draft.seekerPayments 
      : (draft.seekerPayment ? [draft.seekerPayment] : []);
    
    const providerReceives = draft.providerReceives && draft.providerReceives.length > 0 
      ? draft.providerReceives 
      : (draft.providerReceive ? [draft.providerReceive] : []);

    if (seekerPayments.length === 0 || providerReceives.length === 0) {
      return sendJSON(res, { error: 'Обе стороны должны заполнить хотя бы по одному счёту в контракте' }, 400);
    }

    // Add signer
    if (!conv.signedBy.includes(currentUser.id)) {
      conv.signedBy.push(currentUser.id);
    }

    if (conv.signedBy.length < 2) {
      saveDB();
      addLog(`✍️ ${currentUser.name} подписал финальный контракт. Ожидаем вторую подпись.`, [conv.seekerId, conv.providerId]);
      return sendJSON(res, { success: true, waitingForOther: true });
    }

    // BOTH SIGNED → PENDING with timer (user can cancel during this period)
    conv.status = 'SIGNED_PENDING';
    conv.signedAt = new Date().toISOString();

    addLog(`✍️ Контракт подписан обеими сторонами. Автоматическое исполнение через 30 секунд. Можно отменить.`, [conv.seekerId, conv.providerId]);

    // Clear any previous pending timeout
    if (pendingExecutions[convKey]) {
      clearTimeout(pendingExecutions[convKey]);
    }

    // Delayed execution (gives time to review and cancel)
    pendingExecutions[convKey] = setTimeout(() => {
      try {
        executePendingContract(convKey);
      } catch (e) {
        console.error('Delayed contract execution error:', e);
      }
      delete pendingExecutions[convKey];
    }, 30000);

    saveDB();
    return sendJSON(res, { 
      success: true, 
      pendingExecution: true, 
      delaySeconds: 30,
      message: 'Контракт в статусе ожидания. У вас есть 30 секунд на отмену.' 
    });
  }

  // Cancel pending contract (during SIGNED_PENDING window)
  if (pathname.match(/^\/api\/conversations\/([^/]+)\/cancel$/) && method === 'POST') {
    const convKey = pathname.split('/')[3];
    const conv = db.conversations[convKey];
    if (!conv) return sendJSON(res, { error: 'Чат не найден' }, 404);
    if (conv.seekerId !== currentUser.id && conv.providerId !== currentUser.id) {
      return sendJSON(res, { error: 'Нет доступа' }, 403);
    }
    if (conv.status !== 'SIGNED_PENDING') {
      return sendJSON(res, { error: 'Можно отменить только контракт в статусе ожидания' }, 400);
    }

    if (pendingExecutions[convKey]) {
      clearTimeout(pendingExecutions[convKey]);
      delete pendingExecutions[convKey];
    }

    conv.status = 'CANCELLED';
    conv.cancelledAt = new Date().toISOString();
    conv.cancelledBy = currentUser.id;

    saveDB();
    addLog(`❌ Контракт отменён ${currentUser.name}.`, [conv.seekerId, conv.providerId]);
    return sendJSON(res, { success: true, cancelled: true });
  }

  // USERS (for P2P partner selection)
  if (pathname === '/api/users' && method === 'GET') {
    const others = db.users
      .filter(u => u.id !== currentUser.id)
      .map(u => ({ id: u.id, name: u.name, company: u.company }));
    return sendJSON(res, others);
  }

  // PROFILE AI SAFETY TOGGLE
  if (pathname === '/api/profile/ai-safety' && method === 'POST') {
    const { enabled } = body;
    const userInDb = db.users.find(u => u.id === currentUser.id);
    if (userInDb) {
      userInDb.autoApproveAI = !!enabled;
      currentUser.autoApproveAI = !!enabled; // update in memory too
      saveDB();
      addLog(`⚙️ ${currentUser.name} изменил настройку AI авто-балансировки: ${enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
    }
    return sendJSON(res, { success: true, autoApproveAI: !!enabled });
  }

  // CONFIRM / EXECUTE AI PREDICTOR RISK ACTION (manual approval from logs)
  if (pathname === '/api/ai/confirm-risk' && method === 'POST') {
    const { accountId } = body;
    if (!accountId) return sendJSON(res, { error: 'accountId required' }, 400);

    const riskAcc = db.accounts.find(a => a.id === accountId && a.userId === currentUser.id);
    if (!riskAcc) return sendJSON(res, { error: 'Account not found or not yours' }, 404);

    const needed = 6500 + Math.floor(Math.random() * 6000); // re-estimate current need
    const myOtherAccounts = db.accounts.filter(a =>
      a.userId === currentUser.id &&
      a.id !== riskAcc.id &&
      ((a.balance || 0) - (a.reserve || 0)) > 2500
    );

    let totalCovered = 0;
    const transfersDone = [];
    myOtherAccounts.sort((x, y) => ((y.balance || 0) - (y.reserve || 0)) - ((x.balance || 0) - (x.reserve || 0)));

    for (const other of myOtherAccounts) {
      if (totalCovered >= needed) break;
      const avail = (other.balance || 0) - (other.reserve || 0);
      const take = Math.min(avail, needed - totalCovered, Math.floor(avail * 0.5));
      if (take >= 700) {
        other.balance -= take;
        riskAcc.balance += take;
        totalCovered += take;
        transfersDone.push({ from: other.name, amount: take });
      }
    }

    let msg = `✅ Пользователь подтвердил действие ИИ для счета "${riskAcc.name}". `;
    if (totalCovered > 0) {
      msg += `Выполнена перебалансировка: $${totalCovered} переброшено.`;
      transfersDone.forEach(t => addLog(`   ↳ $${t.amount} перемещено с "${t.from}" → "${riskAcc.name}" (по подтверждению)`, [currentUser.id]));
    } else {
      msg += 'Недостаточно средств на других счетах для автоматической перебалансировки.';
    }
    addLog(msg, [currentUser.id], { type: 'risk-confirmed', accountId });
    saveDB();
    return sendJSON(res, { success: true, covered: totalCovered, msg });
  }

  // PREDICTOR DATA (for chart + status) - PER USER unique data
  if (pathname === '/api/predictor' && method === 'GET') {
    if (!currentUser) return sendJSON(res, { error: 'Unauthorized' }, 401);
    const pred = db.predictors && db.predictors[currentUser.id] ? db.predictors[currentUser.id] : { labels: [], data: [], status: 'Сбор данных...', timelineIndex: 30 };
    return sendJSON(res, {
      labels: pred.labels || [],
      data: pred.data || [],
      status: pred.status || 'Мониторинг...',
      timelineIndex: pred.timelineIndex || 30
    });
  }

  // KPIs for current user
  if (pathname === '/api/kpis' && method === 'GET') {
    const myAccs = db.accounts.filter(a => a.userId === currentUser.id);
    let total = 0, available = 0;
    myAccs.forEach(a => {
      total += (a.balance || 0);
      available += Math.max(0, (a.balance || 0) - (a.reserve || 0));
    });
    return sendJSON(res, { total, available });
  }

  // SYSTEM LOGS - only relevant to current user's accounts (filter by affectedUsers)
  if (pathname === '/api/logs' && method === 'GET') {
    if (!currentUser) {
      const recent = [...db.logs].reverse().slice(0, 15);
      return sendJSON(res, recent);
    }
    const filteredLogs = db.logs.filter(log => 
      !log.affectedUsers || log.affectedUsers.length === 0 || log.affectedUsers.includes(currentUser.id)
    );
    return sendJSON(res, [...filteredLogs].reverse().slice(0, 25));
  }

  // ADMIN ONLY ROUTES
  if (currentUser.isAdmin) {
    if (pathname === '/api/admin/external' && method === 'GET') {
      return sendJSON(res, db.externalDb);
    }

    if (pathname === '/api/admin/create-external' && method === 'POST') {
      const { name, balance, type } = body;
      if (!name) return sendJSON(res, { error: 'Название обязательно' }, 400);

      const newExt = {
        id: 'ext_' + Math.random().toString(36).slice(2, 10),
        name: name || 'New Bank Account',
        balance: parseFloat(balance) || 10000,
        reserve: 0,
        type: type || 'SEPA',
        isExternalKey: true
      };
      db.externalDb.push(newExt);
      saveDB();
      addLog(`Админ создал внешний счет "${newExt.name}". Ключ: ${newExt.id}`);
      return sendJSON(res, { success: true, key: newExt.id, account: newExt });
    }
  }

  // 404 for unknown API
  sendJSON(res, { error: 'Endpoint not found' }, 404);
}

// ============ MAIN SERVER ============
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = fullUrl.pathname;

  // Normalize
  if (pathname === '') pathname = '/';

  try {
    if (!pathname.startsWith('/api/')) {
      // STATIC FILES from front/
      let filePath;
      if (pathname === '/' || pathname === '/index.html') {
        filePath = path.join(FRONT_DIR, 'index.html');
      } else {
        // remove leading / 
        const relPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
        filePath = path.join(FRONT_DIR, relPath);
      }

      // Prevent path traversal
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(FRONT_DIR))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        sendFile(res, resolved);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
      return;
    }

    // API
    const method = req.method;
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      body = await parseBody(req);
    }

    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const currentUser = getUserFromToken(token);

    await handleAPI(req, res, pathname, method, body, currentUser);

  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      sendJSON(res, { error: 'Internal server error' }, 500);
    }
  }
});

function startServer() {
  initDB();

  // Start complex predictor simulation
  setInterval(() => {
    try {
      runPredictorStep();
    } catch (e) {
      console.error('Predictor step error:', e);
    }
  }, 2200);

  // Seed one initial log
  if (db.logs.length === 0) {
    addLog('Система AbusaFin запущена. AI Predictor активен.');
  }

  server.listen(PORT, () => {
    console.log(`\n✅ AbusaFin сервер запущен: http://localhost:${PORT}`);
    console.log(`   Frontend: http://localhost:${PORT}`);
    console.log(`   API:      http://localhost:${PORT}/api/*`);
    console.log(`   Demo users: admin/123 , user1/123 , user2/123\n`);
  });
}

startServer();