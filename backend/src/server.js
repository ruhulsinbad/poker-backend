// server.js — Production Ready

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { Pool }   = require('pg');
const Redis      = require('ioredis');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');

const { PokerTable }    = require('./game/PokerEngine');
const { BotManager }    = require('./game/BotManager');
const { HandEvaluator } = require('./game/HandEvaluator');

// ─── Init ─────────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const redis       = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
const activeTables = new Map();
const botManager  = new BotManager(db, io, activeTables);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60000, max: 200 }));

// ─── Auth ─────────────────────────────────────────────────────────────────────

function validateTelegramData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash   = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(process.env.BOT_TOKEN || '').digest();
        const computedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString).digest('hex');
        return computedHash === hash;
    } catch { return false; }
}

async function authMiddleware(req, res, next) {
    if (process.env.NODE_ENV === 'development') {
        const adminTelegramId = parseInt(process.env.ADMIN_TELEGRAM_ID) || 999999999;
        const user = await getOrCreateUser({ id: adminTelegramId, username: 'devadmin', first_name: 'Dev' });
        req.user     = { userId: user.id, telegramId: user.telegram_id };
        req.newToken = jwt.sign(
            { userId: user.id, telegramId: user.telegram_id },
            process.env.JWT_SECRET || 'devsecret',
            { expiresIn: '7d' }
        );
        return next();
    }

    const token = req.headers['authorization']?.split(' ')[1];
    if (token) {
        try {
            req.user = jwt.verify(token, process.env.JWT_SECRET);
            return next();
        } catch {}
    }

    const initData = req.headers['x-telegram-init-data'];
    if (initData && validateTelegramData(initData)) {
        const params  = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (userStr) {
            const tgUser = JSON.parse(userStr);
            const user   = await getOrCreateUser(tgUser, params.get('start_param'));
            req.user     = { userId: user.id, telegramId: user.telegram_id };
            req.newToken = jwt.sign(
                { userId: user.id, telegramId: user.telegram_id },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );
            return next();
        }
    }

    return res.status(401).json({ error: 'Unauthorized' });
}

// ─── User Helpers ─────────────────────────────────────────────────────────────

async function getOrCreateUser(telegramUser, referralCode = null) {
    const { id, username, first_name, last_name, photo_url } = telegramUser;
    let result = await db.query('SELECT * FROM users WHERE telegram_id = $1', [id]);

    if (result.rows.length > 0) {
        await db.query(
            `UPDATE users SET username=$1, first_name=$2, last_name=$3, photo_url=$4, updated_at=NOW()
             WHERE telegram_id=$5`,
            [username, first_name, last_name, photo_url, id]
        );
        return result.rows[0];
    }

    let referrerId = null;
    if (referralCode) {
        const ref = await db.query('SELECT id FROM users WHERE referral_code=$1', [referralCode]);
        if (ref.rows.length > 0) referrerId = ref.rows[0].id;
    }

    const newUser = await db.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, referred_by, chips, is_early_access)
         VALUES ($1,$2,$3,$4,$5,$6,10000,true) RETURNING *`,
        [id, username, first_name, last_name, photo_url, referrerId]
    );

    const user = newUser.rows[0];
    if (referrerId) {
        await creditReferralBonus(referrerId, user.id, 10000);
        await db.query('UPDATE users SET total_referrals=total_referrals+1 WHERE id=$1', [referrerId]);
    }
    return user;
}

async function creditReferralBonus(referrerId, referredId, chipsEarned) {
    const ref = await db.query('SELECT * FROM users WHERE id=$1', [referrerId]);
    if (!ref.rows.length) return;
    const pct   = ref.rows[0].is_influencer ? 5 : 3;
    const bonus = Math.floor(chipsEarned * pct / 100);
    if (bonus <= 0) return;
    await db.query('UPDATE users SET chips=chips+$1 WHERE id=$2', [bonus, referrerId]);
    await db.query(
        `INSERT INTO chip_transactions (user_id, amount, transaction_type, reference_id, description)
         VALUES ($1,$2,'referral_bonus',$3,$4)`,
        [referrerId, bonus, referredId, `Referral ${pct}% bonus`]
    );
}

async function addXPAndCheckLevel(userId, xpAmount) {
    const result = await db.query(
        'UPDATE users SET xp=xp+$1 WHERE id=$2 RETURNING xp, level', [xpAmount, userId]
    );
    const user      = result.rows[0];
    const nextLevel = await db.query(
        'SELECT * FROM level_config WHERE level>$1 AND xp_required<=$2 ORDER BY level DESC LIMIT 1',
        [user.level, user.xp]
    );
    if (nextLevel.rows.length > 0) {
        const nl = nextLevel.rows[0];
        await db.query(
            'UPDATE users SET level=$1, chips=chips+$2 WHERE id=$3',
            [nl.level, nl.chips_reward, userId]
        );
        return { leveledUp: true, newLevel: nl.level, reward: nl.chips_reward };
    }
    return { leveledUp: false };
}

// ─── REST API ─────────────────────────────────────────────────────────────────

app.post('/api/auth', authMiddleware, async (req, res) => {
    const user = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    res.json({ user: user.rows[0], token: req.newToken });
});

app.get('/api/profile', authMiddleware, async (req, res) => {
    const user      = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const nextLevel = await db.query('SELECT * FROM level_config WHERE level=$1', [user.rows[0].level + 1]);
    res.json({ user: user.rows[0], nextLevel: nextLevel.rows[0] || null });
});

app.post('/api/profile/wallet', authMiddleware, async (req, res) => {
    const { wallet } = req.body;
    if (!wallet) return res.status(400).json({ error: 'No wallet provided' });
    await db.query('UPDATE users SET ton_wallet=$1, updated_at=NOW() WHERE id=$2', [wallet, req.user.userId]);
    const user = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    res.json({ success: true, user: user.rows[0] });
});

app.post('/api/profile/photo', authMiddleware, async (req, res) => {
    const { photoUrl } = req.body;
    const user = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    if (!user.rows[0].ton_wallet) return res.status(400).json({ error: 'Connect TON wallet first' });
    await db.query('UPDATE users SET photo_url=$1, updated_at=NOW() WHERE id=$2', [photoUrl, req.user.userId]);
    await db.query(
        `INSERT INTO chip_transactions (user_id, amount, transaction_type, description)
         VALUES ($1,0,'photo_update','Profile photo updated (1 TON paid)')`,
        [req.user.userId]
    );
    res.json({ success: true });
});

app.get('/api/tables', authMiddleware, async (req, res) => {
    const tables = await db.query("SELECT * FROM poker_tables WHERE status!='closed' ORDER BY big_blind ASC");
    const withPlayers = tables.rows.map(t => ({
        ...t,
        live_players: Array.from((activeTables.get(t.id)?.players || new Map()).values())
            .filter(p => !botManager.isBotId(p.userId)).length
    }));
    res.json(withPlayers);
});

app.get('/api/tasks', authMiddleware, async (req, res) => {
    const tasks = await db.query(
        `SELECT t.*, ut.status, ut.completed_at, ut.claimed_at
         FROM tasks t
         LEFT JOIN user_tasks ut ON ut.task_id=t.id AND ut.user_id=$1
         WHERE t.is_active=true ORDER BY t.sort_order`,
        [req.user.userId]
    );
    res.json(tasks.rows);
});

app.post('/api/tasks/:taskId/complete', authMiddleware, async (req, res) => {
    const { taskId } = req.params;
    const task = await db.query('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (!task.rows.length) return res.status(404).json({ error: 'Task not found' });
    const t = task.rows[0];

    const existing = await db.query(
        'SELECT * FROM user_tasks WHERE user_id=$1 AND task_id=$2', [req.user.userId, taskId]
    );
    if (existing.rows.length && existing.rows[0].status === 'claimed')
        return res.status(400).json({ error: 'Already claimed' });
    if (t.task_type === 'daily' && existing.rows.length) {
        const last = new Date(existing.rows[0].completed_at);
        if (last.toDateString() === new Date().toDateString())
            return res.status(400).json({ error: 'Already done today' });
    }

    await db.query(
        `INSERT INTO user_tasks (user_id, task_id, status, completed_at)
         VALUES ($1,$2,'completed',NOW())
         ON CONFLICT (user_id, task_id) DO UPDATE SET status='completed', completed_at=NOW()`,
        [req.user.userId, taskId]
    );
    await db.query('UPDATE users SET chips=chips+$1 WHERE id=$2', [t.chips_reward, req.user.userId]);
    await db.query(
        `INSERT INTO chip_transactions (user_id, amount, transaction_type, reference_id, description)
         VALUES ($1,$2,'task_reward',$3,$4)`,
        [req.user.userId, t.chips_reward, taskId, `Task: ${t.title}`]
    );
    const levelResult = await addXPAndCheckLevel(req.user.userId, t.xp_reward);
    const user = await db.query('SELECT referred_by FROM users WHERE id=$1', [req.user.userId]);
    if (user.rows[0]?.referred_by) {
        await creditReferralBonus(user.rows[0].referred_by, req.user.userId, t.chips_reward);
    }
    await db.query(
        "UPDATE user_tasks SET status='claimed', claimed_at=NOW() WHERE user_id=$1 AND task_id=$2",
        [req.user.userId, taskId]
    );
    res.json({ success: true, chipsEarned: t.chips_reward, xpEarned: t.xp_reward, ...levelResult });
});

app.get('/api/leaderboard', authMiddleware, async (req, res) => {
    const data = await db.query('SELECT * FROM leaderboard_weekly LIMIT 50');
    res.json(data.rows);
});

app.get('/api/referral', authMiddleware, async (req, res) => {
    const user = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u    = user.rows[0];
    const earnings = await db.query(
        'SELECT COALESCE(SUM(chips_earned),0) as total FROM referral_earnings WHERE referrer_id=$1',
        [req.user.userId]
    );
    res.json({
        referralCode:   u.referral_code,
        referralLink:   `https://t.me/${process.env.BOT_USERNAME}?start=${u.referral_code}`,
        totalReferrals: u.total_referrals,
        totalEarnings:  earnings.rows[0].total || 0,
        isInfluencer:   u.is_influencer,
        bonusPercent:   u.is_influencer ? 5 : 3
    });
});

app.post('/api/nft/mint', authMiddleware, async (req, res) => {
    const { chipsAmount } = req.body;
    const user = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    const u    = user.rows[0];
    if (u.level < 30)              return res.status(403).json({ error: 'Level 30 required' });
    if (u.premium_chips < chipsAmount) return res.status(400).json({ error: 'Insufficient premium chips' });
    await db.query('UPDATE users SET premium_chips=premium_chips-$1 WHERE id=$2', [chipsAmount, req.user.userId]);
    const nft = await db.query(
        "INSERT INTO nft_records (user_id, chips_amount, status) VALUES ($1,$2,'minted') RETURNING *",
        [req.user.userId, chipsAmount]
    );
    res.json({ success: true, nft: nft.rows[0] });
});

// ─── Card Strength Indicator ──────────────────────────────────────────────────

const INDICATOR_COST = 500;

app.post('/api/game/indicator/activate', authMiddleware, async (req, res) => {
    const user = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    if (user.rows[0].chips < INDICATOR_COST)
        return res.status(400).json({ error: `Need ${INDICATOR_COST} chips` });
    await db.query('UPDATE users SET chips=chips-$1 WHERE id=$2', [INDICATOR_COST, req.user.userId]);
    await redis.setex(`indicator:${req.user.userId}`, 300, '1');
    res.json({ success: true, cost: INDICATOR_COST });
});

// ─── Tips ─────────────────────────────────────────────────────────────────────

app.post('/api/game/tip', authMiddleware, async (req, res) => {
    const { tableId, recipientId, amount } = req.body;
    if (!amount || amount < 100)          return res.status(400).json({ error: 'Minimum tip is 100 chips' });
    if (recipientId === req.user.userId)  return res.status(400).json({ error: 'Cannot tip yourself' });

    const tipper = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    if (tipper.rows[0].chips < amount)    return res.status(400).json({ error: 'Insufficient chips' });

    const table = activeTables.get(tableId);
    if (!table) return res.status(400).json({ error: 'Table not found' });
    const atTable = Array.from(table.players.values()).some(p => p.userId === recipientId);
    if (!atTable) return res.status(400).json({ error: 'Recipient not at this table' });

    await db.query('UPDATE users SET chips=chips-$1 WHERE id=$2', [amount, req.user.userId]);
    await db.query('UPDATE users SET chips=chips+$1 WHERE id=$2', [amount, recipientId]);
    await db.query(
        `INSERT INTO chip_transactions (user_id, amount, transaction_type, reference_id, description)
         VALUES ($1,$2,'tip_sent',$3,'Tip sent')`,
        [req.user.userId, -amount, recipientId]
    );
    await db.query(
        `INSERT INTO chip_transactions (user_id, amount, transaction_type, reference_id, description)
         VALUES ($1,$2,'tip_received',$3,'Tip received')`,
        [recipientId, amount, req.user.userId]
    );

    const tipperInfo = tipper.rows[0];
    io.to(`table:${tableId}`).emit('tip_sent', {
        from:     tipperInfo.username || tipperInfo.first_name,
        toUserId: recipientId,
        amount,
        message:  `🎁 ${tipperInfo.username || tipperInfo.first_name} tipped ${amount.toLocaleString()} chips!`
    });
    res.json({ success: true, amount });
});

app.post('/api/game/tip-dealer', authMiddleware, async (req, res) => {
    const { tableId, amount } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum 100 chips' });

    // Query user FIRST before using
    const user = await db.query('SELECT * FROM users WHERE id=$1', [req.user.userId]);
    if (user.rows[0].chips < amount) return res.status(400).json({ error: 'Insufficient chips' });

    await db.query('UPDATE users SET chips=chips-$1 WHERE id=$2', [amount, req.user.userId]);
    await db.query(
        `INSERT INTO chip_transactions (user_id, amount, transaction_type, description)
         VALUES ($1,$2,'dealer_tip','Dealer tip')`,
        [req.user.userId, -amount]
    );

    // Use botManager for random response
    const tipMessage = botManager.getDealerTipResponse();
    io.to(`table:${tableId}`).emit('dealer_tip', {
        fromUser: user.rows[0].username || user.rows[0].first_name,
        amount,
        message:  tipMessage,
    });

    res.json({ success: true });
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

const adminRoutes = require('./routes/admin')(db, activeTables, io);
app.use('/api/admin', authMiddleware, adminRoutes);

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    try {
        const decoded    = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
        socket.userId    = decoded.userId;
        socket.telegramId = decoded.telegramId;
        next();
    } catch { next(new Error('Invalid token')); }
});

io.on('connection', async (socket) => {
    console.log(`User connected: ${socket.userId}`);
    socket.join('task_updates');

    // ── join_table ────────────────────────────────────────────────────────────
    socket.on('join_table', async ({ tableId, buyIn }) => {
        try {
            const tableConfig = await db.query('SELECT * FROM poker_tables WHERE id=$1', [tableId]);
            if (!tableConfig.rows.length) return socket.emit('error', { message: 'Table not found' });

            const table = tableConfig.rows[0];
            if (buyIn < table.min_buy_in || buyIn > table.max_buy_in)
                return socket.emit('error', { message: 'Invalid buy-in' });

            const user       = await db.query('SELECT * FROM users WHERE id=$1', [socket.userId]);
            const u          = user.rows[0];
            const chipsField = table.chips_type === 'premium_chips' ? 'premium_chips' : 'chips';

            if (u[chipsField] < buyIn) return socket.emit('error', { message: 'Insufficient chips' });

            await db.query(
                `UPDATE users SET ${chipsField}=${chipsField}-$1 WHERE id=$2`, [buyIn, socket.userId]
            );

            let pokerTable = activeTables.get(tableId);
            if (!pokerTable) {
                pokerTable = new PokerTable(table);
                activeTables.set(tableId, pokerTable);
                setupTableEvents(pokerTable, tableId);
                const botBuyIn = Math.max(table.min_buy_in, table.big_blind * 100);
                await botManager.assignBotsToTable(tableId, pokerTable, botBuyIn);
            }

            pokerTable.addPlayer(socket.userId, u.username || u.first_name, buyIn, u.photo_url);
            socket.join(`table:${tableId}`);
            socket.tableId = tableId;

            await botManager.handleRealUserJoined(tableId, pokerTable);

            // Update live player count
            const realCount = Array.from(pokerTable.players.values())
                .filter(p => !botManager.isBotId(p.userId)).length;
            await db.query('UPDATE poker_tables SET live_players=$1 WHERE id=$2', [realCount, tableId])
                .catch(() => {});

            socket.emit('joined_table', {
                tableState: pokerTable.getTableState(socket.userId)
            });

        } catch (err) {
            socket.emit('error', { message: err.message });
        }
    });

    // ── peek_cards ────────────────────────────────────────────────────────────
    socket.on('peek_cards', () => {
        const pokerTable = activeTables.get(socket.tableId);
        if (!pokerTable) return;
        pokerTable.markPlayerSeen(socket.userId);
        io.to(`table:${socket.tableId}`).emit('player_peeked', { userId: socket.userId });
    });

    // ── reconnect_table ───────────────────────────────────────────────────────
    socket.on('reconnect_table', async ({ tableId }) => {
        try {
            const pokerTable = activeTables.get(tableId);
            if (!pokerTable) return socket.emit('error', { message: 'Table not found' });

            const state = pokerTable.handleReconnect(socket.userId);
            if (!state)  return socket.emit('error', { message: 'Not at this table' });

            socket.join(`table:${tableId}`);
            socket.tableId = tableId;
            socket.emit('reconnected', { tableState: state });

            // Re-send hole cards
            const player = pokerTable.getPlayerByUserId(socket.userId);
            if (player && player.holeCards.length > 0) {
                socket.emit(`cards_${socket.userId}`, {
                    userId:    socket.userId,
                    holeCards: player.holeCards.map(c => c.toJSON ? c.toJSON() : c),
                });
            }
        } catch (err) {
            socket.emit('error', { message: err.message });
        }
    });

    // ── player_action ─────────────────────────────────────────────────────────
    socket.on('player_action', async ({ action, amount }) => {
        try {
            const pokerTable = activeTables.get(socket.tableId);
            if (!pokerTable) return socket.emit('error', { message: 'Not in a table' });
            pokerTable.handleAction(socket.userId, action, amount);
        } catch (err) {
            socket.emit('error', { message: err.message });
        }
    });

    // ── leave & disconnect ────────────────────────────────────────────────────
    socket.on('leave_table', async () => { await handleLeaveTable(socket); });
    socket.on('disconnect',  async () => { await handleLeaveTable(socket); });

    // ── chat ──────────────────────────────────────────────────────────────────
    socket.on('chat_message', ({ message }) => {
        if (!socket.tableId || !message?.trim() || message.length > 100) return;
        io.to(`table:${socket.tableId}`).emit('chat_message', {
            userId:    socket.userId,
            message:   message.trim(),
            timestamp: Date.now()
        });
    });

    // ── indicator ─────────────────────────────────────────────────────────────
    socket.on('request_indicator', async ({ holeCards, boardCards }) => {
        const hasAccess = await redis.get(`indicator:${socket.userId}`);
        if (!hasAccess) return socket.emit('indicator_result', { error: 'Not activated' });
        const winProbability = HandEvaluator.calculateOdds(holeCards, boardCards || [], 300);
        let category;
        if (winProbability >= 75)      category = 'Monster 🔥';
        else if (winProbability >= 60) category = 'Strong 💪';
        else if (winProbability >= 45) category = 'Medium 🤔';
        else if (winProbability >= 30) category = 'Weak 😬';
        else                           category = 'Fold? 💀';
        socket.emit('indicator_result', { winProbability, category });
    });
});

// ─── Table Event Wiring ───────────────────────────────────────────────────────

function setupTableEvents(table, tableId) {
    const room = `table:${tableId}`;

    // New hand flow events
    table.on('new_hand_starting', d => io.to(room).emit('new_hand_starting', d));
    table.on('blinds_collected',  d => io.to(room).emit('blinds_collected', d));
    table.on('player_waiting',    d => io.to(room).emit('player_waiting', d));

    // Timeout → remove player from seat + return chips
    table.on('player_timeout', async d => {
        io.to(room).emit('player_timeout', d);
        const tableInst = activeTables.get(tableId);
        if (!tableInst) return;
        const chips = tableInst.removePlayer(d.userId);
        if (chips > 0) {
            try {
                const tbl = await db.query('SELECT chips_type FROM poker_tables WHERE id=$1', [tableId]);
                const fld = tbl.rows[0]?.chips_type === 'premium_chips' ? 'premium_chips' : 'chips';
                await db.query(`UPDATE users SET ${fld}=${fld}+$1 WHERE id=$2`, [chips, d.userId]);
            } catch (err) { console.error('Timeout chip return error:', err.message); }
        }
    });

    table.on('hand_started',   d => io.to(room).emit('hand_started', d));
    table.on('board_updated',  d => io.to(room).emit('board_updated', d));
    table.on('player_action',  d => io.to(room).emit('player_action', d));

    table.on('action_required', d => {
        io.to(room).emit('action_required', d);
    });

    table.on('showdown',     d => io.to(room).emit('showdown', d));
    table.on('player_joined',d => io.to(room).emit('player_joined', d));
    table.on('player_left',  d => io.to(room).emit('player_left', d));

    // Private card delivery
    table.on('deal_cards', d => io.to(room).emit(`cards_${d.userId}`, d));

    // Hand finished — update DB
    table.on('hand_finished', async (data) => {
        io.to(room).emit('hand_finished', data);

        // House rake
        if (data.rake > 0) {
            await db.query(
                `INSERT INTO chip_transactions (user_id, amount, transaction_type, description)
                 VALUES ((SELECT id FROM users WHERE telegram_id=$1 LIMIT 1), $2, 'house_rake', $3)`,
                [parseInt(process.env.ADMIN_TELEGRAM_ID) || 999999999, data.rake,
                 `House rake table ${tableId} pot ${data.pot}`]
            ).catch(() => {});
        }

        // Winners
        for (const winner of data.winners) {
            if (botManager.isBotId(winner.userId)) continue;
            await db.query(
                `UPDATE users SET total_wins=total_wins+1, total_hands=total_hands+1,
                 total_chips_won=total_chips_won+$1 WHERE id=$2`,
                [winner.chipsWon, winner.userId]
            ).catch(() => {});
            await db.query(
                `INSERT INTO chip_transactions (user_id, amount, transaction_type, description)
                 VALUES ($1,$2,'game_win','Poker win')`,
                [winner.userId, winner.chipsWon]
            ).catch(() => {});
            await addXPAndCheckLevel(winner.userId, 50).catch(() => {});
        }

        // Non-winners XP
        const tableInstance = activeTables.get(tableId);
        if (tableInstance) {
            for (const [, player] of tableInstance.players) {
                if (botManager.isBotId(player.userId)) continue;
                if (!data.winners.some(w => w.userId === player.userId)) {
                    await db.query(
                        'UPDATE users SET total_hands=total_hands+1 WHERE id=$1', [player.userId]
                    ).catch(() => {});
                    await addXPAndCheckLevel(player.userId, 10).catch(() => {});
                }
            }
        }
    });
}

// ─── Leave Table ──────────────────────────────────────────────────────────────

async function handleLeaveTable(socket) {
    const tableId = socket.tableId;
    if (!tableId) return;

    const pokerTable = activeTables.get(tableId);
    if (!pokerTable) {
        socket.tableId = null;
        return;
    }

    const chips = pokerTable.removePlayer(socket.userId);

    if (chips > 0) {
        try {
            const table = await db.query('SELECT chips_type FROM poker_tables WHERE id=$1', [tableId]);
            const field = table.rows[0]?.chips_type === 'premium_chips' ? 'premium_chips' : 'chips';
            await db.query(`UPDATE users SET ${field}=${field}+$1 WHERE id=$2`, [chips, socket.userId]);
        } catch (err) {
            console.error('Chip return error:', err.message);
        }
    }

    socket.leave(`table:${tableId}`);
    socket.tableId = null; // Clear AFTER all DB operations

    if (pokerTable.players.size === 0) {
        activeTables.delete(tableId);
        await db.query('UPDATE poker_tables SET live_players=0 WHERE id=$1', [tableId]).catch(() => {});
    } else {
        const realCount = Array.from(pokerTable.players.values())
            .filter(p => !botManager.isBotId(p.userId)).length;
        await db.query('UPDATE poker_tables SET live_players=$1 WHERE id=$2', [realCount, tableId])
            .catch(() => {});
    }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
    console.log(`🃏 Poker Server running on port ${PORT}`);
    try {
        await botManager.initializeBots();
        const tables = await db.query("SELECT * FROM poker_tables WHERE status!='closed'");
        for (const table of tables.rows) {
            const pokerTable = new PokerTable(table);
            activeTables.set(table.id, pokerTable);
            setupTableEvents(pokerTable, table.id);
            const botBuyIn = Math.max(table.min_buy_in, table.big_blind * 100);
            await botManager.assignBotsToTable(table.id, pokerTable, botBuyIn);
        }
        console.log(`✅ Bots deployed to ${tables.rows.length} tables`);
    } catch (err) {
        console.error('Bot init error:', err.message);
    }
});

module.exports = { app, io, db };