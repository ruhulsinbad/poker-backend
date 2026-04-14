// BotManager.js — Production bot management, no race conditions

const { BotPlayer, BOT_PROFILES } = require('./BotPlayer');
const { PLAYER_ACTIONS }          = require('./PokerEngine');

const BOT_CHIPS      = 100_000_000;
const BOTS_PER_TABLE = 3;

const TIP_RESPONSES = [
    "🎰 Thank you! The cards love generous players!",
    "🃏 Dealer appreciates it! May the flop be with you!",
    "💰 Much appreciated! Lucky cards ahead!",
    "🙏 Poker gods smile upon the generous!",
    "✨ Big tip, big wins tonight!",
    "👑 Royal tip for a royal player!",
    "🍀 Dealer is grateful! Lucky run incoming!",
    "🌟 Thank you! Next hand is blessed!",
    "🎉 You're a legend at this table!",
    "🎲 Fortune favors the bold — and the kind!",
];

class BotManager {
    constructor(db, io, activeTables) {
        this.db           = db;
        this.io           = io;
        this.activeTables = activeTables;
        this.bots         = new Map();       // botId → BotPlayer
        this.botAccounts  = new Map();       // botId → db row
        this.tableBotsMap = new Map();       // tableId → Set<botId>
        this.botListeners = new Map();       // botId → { table, handler }
        this.processing   = new Set();       // botIds currently processing action
    }

    async initializeBots() {
        console.log('🤖 Initializing bot accounts...');
        for (let i = 0; i < BOT_PROFILES.length; i++) {
            const profile     = BOT_PROFILES[i];
            const telegramId  = 9000000000 + i;

            let result = await this.db.query(
                'SELECT * FROM users WHERE telegram_id = $1', [telegramId]
            );
            if (!result.rows.length) {
                result = await this.db.query(
                    `INSERT INTO users (telegram_id, username, first_name, chips, is_bot)
                     VALUES ($1,$2,$3,$4,true) RETURNING *`,
                    [telegramId, profile.name.toLowerCase(), profile.name, BOT_CHIPS]
                );
                console.log(`✅ Created bot: ${profile.name}`);
            } else {
                await this.db.query(
                    'UPDATE users SET chips=$1 WHERE telegram_id=$2',
                    [BOT_CHIPS, telegramId]
                );
            }
            const u = result.rows[0];
            this.bots.set(u.id, new BotPlayer(profile, null));
            this.botAccounts.set(u.id, u);
        }
        console.log(`🤖 ${this.bots.size} bots ready`);
    }

    getAvailableBots(excludeIds = []) {
        const busy = new Set([...this.tableBotsMap.values()].flatMap(s => [...s]));
        return Array.from(this.bots.keys()).filter(id => !busy.has(id) && !excludeIds.includes(id));
    }

    async assignBotsToTable(tableId, tableInstance, buyIn) {
        if (!this.tableBotsMap.has(tableId)) this.tableBotsMap.set(tableId, new Set());
        const tableBots = this.tableBotsMap.get(tableId);

        if (tableBots.size >= BOTS_PER_TABLE) return;
        const needed    = BOTS_PER_TABLE - tableBots.size;
        const available = this.getAvailableBots([...tableBots]);

        let added = 0;
        for (let i = 0; i < available.length && added < needed; i++) {
            const botId  = available[i];
            const botAcc = this.botAccounts.get(botId);
            if (!botAcc) continue;
            if (tableInstance.players.size >= tableInstance.maxPlayers) break;

            try {
                tableInstance.addPlayer(botId, botAcc.first_name, buyIn, null, true);
                tableBots.add(botId);
                this.bots.get(botId).tableId = tableId;
                this.setupBotListener(tableInstance, botId);
                added++;
                console.log(`🤖 ${botAcc.first_name} → table`);
            } catch (err) {
                console.error(`Bot join error: ${err.message}`);
            }
        }
    }

    setupBotListener(tableInstance, botId) {
        // Remove old listener if any
        const old = this.botListeners.get(botId);
        if (old) {
            old.table.removeListener('action_required', old.handler);
        }

        const handler = async (data) => {
            if (data.userId !== botId)        return;
            if (this.processing.has(botId))   return;

            this.processing.add(botId);
            try {
                const bot       = this.bots.get(botId);
                if (!bot) return;

                const state     = tableInstance.getTableState(botId);
                const botPlayer = state.players?.find(p => p.userId === botId);
                if (!botPlayer || botPlayer.isFolded || botPlayer.isAllIn) return;

                const decision = await bot.decideAction(
                    { ...data, playerChips: botPlayer.chips },
                    botPlayer.holeCards || [],
                    state.boardCards || []
                );

                // Verify still bot's turn
                if (tableInstance.currentPlayerSeat !== botPlayer.seatNumber) return;
                if (['waiting','finished'].includes(tableInstance.gameState))  return;

                tableInstance.handleAction(botId, decision.action, decision.amount || 0);

            } catch (err) {
                console.error(`Bot ${botId} action error: ${err.message}`);
                // Safe fallback
                try {
                    if (tableInstance.currentPlayerSeat ===
                        tableInstance.getPlayerByUserId(botId)?.seatNumber) {
                        tableInstance.handleAction(botId, PLAYER_ACTIONS.FOLD);
                    }
                } catch {}
            } finally {
                this.processing.delete(botId);
            }
        };

        tableInstance.on('action_required', handler);
        this.botListeners.set(botId, { table: tableInstance, handler });

        // Replenish chips after hand
        tableInstance.on('hand_finished', () => {
            const p = tableInstance.getPlayerByUserId(botId);
            if (p && p.chips < tableInstance.minBuyIn) {
                p.chips = Math.min(tableInstance.maxBuyIn || BOT_CHIPS, BOT_CHIPS);
            }
        });
    }

    async handleRealUserJoined(tableId, tableInstance) {
        const realCount = Array.from(tableInstance.players.values())
            .filter(p => !this.isBotId(p.userId)).length;

        const tableBots = this.tableBotsMap.get(tableId) || new Set();
        if (realCount >= 4 && tableBots.size > 0) {
            const botId = tableBots.values().next().value;
            await this.removeBotFromTable(tableId, tableInstance, botId);
            setTimeout(() => this.refillOtherTables(tableId), 2000);
        }
    }

    async removeBotFromTable(tableId, tableInstance, botId) {
        const old = this.botListeners.get(botId);
        if (old) {
            old.table.removeListener('action_required', old.handler);
            this.botListeners.delete(botId);
        }
        tableInstance.removePlayer(botId);
        const set = this.tableBotsMap.get(tableId);
        if (set) set.delete(botId);
        const acc = this.botAccounts.get(botId);
        console.log(`🤖 ${acc?.first_name} left table (real players joined)`);
    }

    async refillOtherTables(skipTableId) {
        for (const [tid, ti] of this.activeTables) {
            if (tid === skipTableId) continue;
            const bots = this.tableBotsMap.get(tid) || new Set();
            if (bots.size < BOTS_PER_TABLE) {
                const buyIn = ti.minBuyIn || ti.bigBlind * 50;
                await this.assignBotsToTable(tid, ti, buyIn);
            }
        }
    }

    isBotId(userId)      { return this.bots.has(userId); }
    getDealerTipResponse() { return TIP_RESPONSES[Math.floor(Math.random() * TIP_RESPONSES.length)]; }
}

module.exports = { BotManager, BOT_CHIPS };
