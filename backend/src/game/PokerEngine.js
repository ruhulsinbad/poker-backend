// PokerEngine.js — Production Ready Texas Hold'em Engine
// Cross-checked with PokerStars/GGPoker rules

const { Deck } = require('./Deck');
const { HandEvaluator } = require('./HandEvaluator');
const EventEmitter = require('events');

const GAME_STATES = {
    WAITING:  'waiting',
    STARTING: 'starting',
    PREFLOP:  'preflop',
    FLOP:     'flop',
    TURN:     'turn',
    RIVER:    'river',
    SHOWDOWN: 'showdown',
    FINISHED: 'finished'
};

const PLAYER_ACTIONS = {
    FOLD:  'fold',
    CHECK: 'check',
    CALL:  'call',
    RAISE: 'raise',
    ALLIN: 'allin'
};

class PokerPlayer {
    constructor(userId, username, chips, seatNumber, isBot = false) {
        this.userId     = userId;
        this.username   = username;
        this.chips      = chips;
        this.seatNumber = seatNumber;
        this.isBot      = isBot;

        // Per-hand state
        this.holeCards         = [];
        this.currentBet        = 0;
        this.totalBetThisHand  = 0;
        this.isFolded          = false;
        this.isAllIn           = false;
        this.isActive          = true;
        this.isDealer          = false;
        this.isSmallBlind      = false;
        this.isBigBlind        = false;
        this.lastAction        = null;
        this.hasActedThisRound = false;
        this.isWaiting         = false; // joined mid-hand
        this.hasSeenCards      = false; // for play blind feature
        this.avatarUrl         = null;
        this.disconnectedAt    = null;
    }

    canAct() {
        return this.isActive
            && !this.isFolded
            && !this.isAllIn
            && !this.isWaiting
            && this.chips >= 0;
    }

    resetForNewHand() {
        this.holeCards         = [];
        this.currentBet        = 0;
        this.totalBetThisHand  = 0;
        this.isFolded          = false;
        this.isAllIn           = false;
        this.lastAction        = null;
        this.isDealer          = false;
        this.isSmallBlind      = false;
        this.isBigBlind        = false;
        this.hasActedThisRound = false;
        this.hasSeenCards      = false;
        this.isWaiting         = false;
    }

    toPublicJSON() {
        return {
            userId:            this.userId,
            username:          this.username,
            chips:             this.chips,
            seatNumber:        this.seatNumber,
            currentBet:        this.currentBet,
            totalBetThisHand:  this.totalBetThisHand,
            isFolded:          this.isFolded,
            isAllIn:           this.isAllIn,
            isDealer:          this.isDealer,
            isSmallBlind:      this.isSmallBlind,
            isBigBlind:        this.isBigBlind,
            lastAction:        this.lastAction,
            avatarUrl:         this.avatarUrl,
            cardCount:         this.holeCards.length,
            isBot:             this.isBot,
            isWaiting:         this.isWaiting,
            hasSeenCards:      this.hasSeenCards,
        };
    }

    toPrivateJSON(requestingUserId) {
        const data = this.toPublicJSON();
        if (this.userId === requestingUserId) {
            data.holeCards = this.holeCards.map(c => c.toJSON ? c.toJSON() : c);
        }
        return data;
    }
}

// ─── Side Pot Calculator ──────────────────────────────────────────────────────
function calculateSidePots(players) {
    const active = players.filter(p => p.totalBetThisHand > 0);
    if (!active.length) return [{ amount: 0, eligible: [] }];

    const pots   = [];
    const bets   = active.map(p => ({
        userId:   p.userId,
        username: p.username,
        bet:      p.totalBetThisHand,
        folded:   p.isFolded,
    })).sort((a, b) => a.bet - b.bet);

    let prevLevel = 0;
    for (let i = 0; i < bets.length; i++) {
        const level = bets[i].bet;
        if (level <= prevLevel) continue;

        const diff    = level - prevLevel;
        const potAmt  = diff * bets.slice(i).length;
        const eligible = bets.slice(i)
            .filter(b => !b.folded)
            .map(b => b.userId);

        if (potAmt > 0 && eligible.length > 0) {
            pots.push({ amount: potAmt, eligible });
        }
        prevLevel = level;
    }

    return pots.length ? pots : [{ amount: 0, eligible: [] }];
}

// ─── Main Table ───────────────────────────────────────────────────────────────
class PokerTable extends EventEmitter {
    constructor(cfg) {
        super();
        this.id          = cfg.id;
        this.name        = cfg.name;
        this.smallBlind  = cfg.small_blind;
        this.bigBlind    = cfg.big_blind;
        this.minBuyIn    = cfg.min_buy_in;
        this.maxBuyIn    = cfg.max_buy_in;
        this.maxPlayers  = cfg.max_players || 6;
        this.chipsType   = cfg.chips_type || 'chips';

        this.players          = new Map();   // seat → PokerPlayer
        this.deck             = new Deck();
        this.boardCards       = [];
        this.pot              = 0;
        this.sidePots         = [];
        this.currentBet       = 0;
        this.lastRaiseSize    = 0;
        this.gameState        = GAME_STATES.WAITING;
        this.currentPlayerSeat = null;
        this.dealerSeat       = null;
        this.handNumber       = 0;
        this.actionTimer      = null;
        this.actionTimeout    = 30000;
        this.rake             = 0.02;
        this._lock            = false;
        this.lastAggressorSeat = null; // for showdown order
        this.bbHasOption      = false; // BB check option preflop
        this.handStartTime    = null;
    }

    // ─── Player Management ─────────────────────────────────────────────────

    addPlayer(userId, username, chips, avatarUrl = null, isBot = false) {
        if (this.players.size >= this.maxPlayers) throw new Error('Table is full');
        const seat = this.getAvailableSeat();
        if (!seat) throw new Error('No seats available');

        const p = new PokerPlayer(userId, username, chips, seat, isBot);
        p.avatarUrl = avatarUrl;

        // Mid-hand join → wait for next hand
        const gameRunning = this.gameState !== GAME_STATES.WAITING
            && this.gameState !== GAME_STATES.FINISHED;
        if (gameRunning) {
            p.isWaiting = true;
            this.emit('player_waiting', {
                userId,
                username,
                message: `${username} joined — waiting for next hand`
            });
        }

        this.players.set(seat, p);
        this.emit('player_joined', { player: p.toPublicJSON(), tableId: this.id });

        const eligible = this.getEligiblePlayers();
        if (eligible.length >= 2 && this.gameState === GAME_STATES.WAITING) {
            setTimeout(() => this.startHand(), 3000);
        }
        return seat;
    }

    removePlayer(userId) {
        for (const [seat, p] of this.players) {
            if (p.userId !== userId) continue;
            const chips = p.chips;
            this.players.delete(seat);
            this.emit('player_left', { userId, chips, tableId: this.id });

            const eligible = this.getEligiblePlayers();
            if (eligible.length < 2 && this.gameState !== GAME_STATES.WAITING) {
                this.endHandEarly();
            }
            return chips;
        }
        return 0;
    }

    markPlayerSeen(userId) {
        const p = this.getPlayerByUserId(userId);
        if (p) p.hasSeenCards = true;
    }

    handleReconnect(userId) {
        const p = this.getPlayerByUserId(userId);
        if (!p) return null;
        p.disconnectedAt = null;
        return this.getTableState(userId);
    }

    getAvailableSeat() {
        for (let i = 1; i <= this.maxPlayers; i++) {
            if (!this.players.has(i)) return i;
        }
        return null;
    }

    getPlayerByUserId(userId) {
        for (const [, p] of this.players) {
            if (p.userId === userId) return p;
        }
        return null;
    }

    getEligiblePlayers() {
        return Array.from(this.players.values()).filter(p => !p.isWaiting);
    }

    getActivePlayers() {
        return Array.from(this.players.values())
            .filter(p => !p.isFolded && p.isActive && !p.isWaiting);
    }

    // ─── Hand Flow ──────────────────────────────────────────────────────────

    startHand() {
        const eligible = this.getEligiblePlayers();
        if (eligible.length < 2) return;
        if (this.gameState !== GAME_STATES.WAITING) return;
        if (this._lock) return;

        this.gameState    = GAME_STATES.STARTING;
        this.handNumber++;
        this.boardCards   = [];
        this.sidePots     = [];
        this.pot          = 0;
        this.currentBet   = 0;
        this.lastRaiseSize = this.bigBlind;
        this.lastAggressorSeat = null;
        this.bbHasOption  = true;
        this._lock        = false;
        this.handStartTime = Date.now();

        // Reset all players
        for (const [, p] of this.players) {
            p.resetForNewHand();
        }

        this.assignDealer();

        // Step 1: Announce new hand (countdown)
        this.emit('new_hand_starting', {
            tableId:    this.id,
            handNumber: this.handNumber,
            countdown:  3,
            players:    this.getPlayersPublicData(),
        });

        // Step 2: Collect blinds (1.5s later)
        setTimeout(() => {
            this.deck.reset();
            this.deck.shuffle();
            this.postBlinds();

            this.emit('blinds_collected', {
                tableId:    this.id,
                pot:        this.pot,
                smallBlind: this.smallBlind,
                bigBlind:   this.bigBlind,
                players:    this.getPlayersPublicData(),
            });

            // Step 3: Deal cards (1s later)
            setTimeout(() => {
                this.dealHoleCards();

                // Step 4: Start betting (1s later - after deal animation)
                setTimeout(() => {
                    this.gameState = GAME_STATES.PREFLOP;

                    this.emit('hand_started', {
                        tableId:     this.id,
                        handNumber:  this.handNumber,
                        pot:         this.pot,
                        currentBet:  this.currentBet,
                        players:     this.getPlayersPublicData(),
                        // Do NOT include cards here — already sent privately
                    });

                    // Pre-flop: first to act is UTG (left of BB)
                    const bbSeat  = this.getBigBlindSeat();
                    const utg     = this.getNextActivePlayer(bbSeat);
                    this.setCurrentPlayer(utg);
                    this.startActionTimer();
                }, 1000);
            }, 1000);
        }, 1500);
    }

    dealHoleCards() {
        const seats = this.getSortedSeats();
        // Deal 2 cards one at a time, starting from SB
        for (let round = 0; round < 2; round++) {
            for (const seat of seats) {
                const p = this.players.get(seat);
                if (p && !p.isWaiting) {
                    p.holeCards.push(...this.deck.deal(1));
                }
            }
        }
        // Send private cards to each player
        for (const [, p] of this.players) {
            if (p.holeCards.length > 0) {
                this.emit('deal_cards', {
                    userId:    p.userId,
                    holeCards: p.holeCards.map(c => c.toJSON ? c.toJSON() : c),
                });
            }
        }
    }

    postBlinds() {
        const seats  = this.getSortedSeats();
        const dIdx   = seats.indexOf(this.dealerSeat);
        const sbSeat = seats[(dIdx + 1) % seats.length];
        const bbSeat = seats[(dIdx + 2) % seats.length];

        const sb = this.players.get(sbSeat);
        const bb = this.players.get(bbSeat);

        if (sb) {
            sb.isSmallBlind = true;
            const amt = Math.min(this.smallBlind, sb.chips);
            sb.chips             -= amt;
            sb.currentBet         = amt;
            sb.totalBetThisHand  += amt;
            sb.hasActedThisRound  = false;
            this.pot             += amt;
            if (sb.chips === 0) sb.isAllIn = true;
        }
        if (bb) {
            bb.isBigBlind = true;
            const amt = Math.min(this.bigBlind, bb.chips);
            bb.chips             -= amt;
            bb.currentBet         = amt;
            bb.totalBetThisHand  += amt;
            bb.hasActedThisRound  = false; // BB still has option
            this.pot             += amt;
            if (bb.chips === 0) bb.isAllIn = true;
        }

        this.currentBet    = this.bigBlind;
        this.lastRaiseSize = this.bigBlind;
    }

    // ─── Player Actions ─────────────────────────────────────────────────────

    handleAction(userId, action, amount = 0) {
        if (this._lock) return;

        const player = this.getPlayerByUserId(userId);
        if (!player)                                    throw new Error('Player not found');
        if (player.seatNumber !== this.currentPlayerSeat) throw new Error('Not your turn');
        if (!player.canAct())                           throw new Error('Cannot act');

        this._lock = true;
        this.clearActionTimer();

        let actionLabel  = '';
        let actionAmount = 0;

        try {
            switch (action) {
                case PLAYER_ACTIONS.FOLD:
                    this.doFold(player);
                    actionLabel = 'Fold';
                    break;
                case PLAYER_ACTIONS.CHECK:
                    this.doCheck(player);
                    actionLabel = 'Check';
                    break;
                case PLAYER_ACTIONS.CALL:
                    actionAmount = Math.min(this.currentBet - player.currentBet, player.chips);
                    this.doCall(player);
                    actionLabel = 'Call';
                    break;
                case PLAYER_ACTIONS.RAISE:
                    this.doRaise(player, amount);
                    actionLabel  = 'Raise';
                    actionAmount = player.currentBet;
                    break;
                case PLAYER_ACTIONS.ALLIN:
                    actionAmount = player.chips;
                    this.doAllIn(player);
                    actionLabel = 'All-In';
                    break;
                default:
                    throw new Error('Invalid action');
            }

            player.hasActedThisRound = true;

            // BB option: if BB acts voluntarily, option is used
            if (player.isBigBlind && this.gameState === GAME_STATES.PREFLOP) {
                this.bbHasOption = false;
            }

            this.emit('player_action', {
                tableId:      this.id,
                userId,
                username:     player.username,
                action,
                actionLabel,
                amount:       actionAmount,
                pot:          this.pot,
                currentBet:   this.currentBet,
                seatNumber:   player.seatNumber,
                animationType: action,
                players:      this.getPlayersPublicData(),
            });

        } finally {
            this._lock = false;
        }

        this.advanceAction();
    }

    doFold(player) {
        player.isFolded  = true;
        player.lastAction = 'Fold';
        const alive = this.getActivePlayers();
        if (alive.length === 1) {
            this.awardPot(alive);
        }
    }

    doCheck(player) {
        const toCall = this.currentBet - player.currentBet;
        if (toCall > 0) throw new Error(`Must call ${toCall} or fold`);
        player.lastAction = 'Check';
    }

    doCall(player) {
        const toCall = Math.min(this.currentBet - player.currentBet, player.chips);
        if (toCall <= 0) { player.lastAction = 'Check'; return; }
        player.chips            -= toCall;
        player.currentBet       += toCall;
        player.totalBetThisHand += toCall;
        this.pot                += toCall;
        player.lastAction        = 'Call';
        if (player.chips === 0) player.isAllIn = true;
    }

    doRaise(player, raiseTo) {
        const minRaiseTo   = this.currentBet + this.lastRaiseSize;
        const effectiveRaise = Math.min(
            Math.max(raiseTo, minRaiseTo),
            player.chips + player.currentBet
        );
        const additional = effectiveRaise - player.currentBet;
        if (additional <= 0 || additional > player.chips) throw new Error('Invalid raise');

        this.lastRaiseSize     = effectiveRaise - this.currentBet;
        this.currentBet        = effectiveRaise;
        this.lastAggressorSeat = player.seatNumber;

        player.chips            -= additional;
        player.currentBet        = effectiveRaise;
        player.totalBetThisHand += additional;
        this.pot                += additional;
        player.lastAction        = `Raise`;
        if (player.chips === 0) player.isAllIn = true;

        this.resetActionsAfterAggression(player.seatNumber);
        // BB option is now gone since someone raised
        this.bbHasOption = false;
    }

    doAllIn(player) {
        const chips  = player.chips;
        if (chips <= 0) return;
        const newBet = player.currentBet + chips;

        if (newBet > this.currentBet) {
            this.lastRaiseSize     = Math.max(newBet - this.currentBet, this.lastRaiseSize);
            this.currentBet        = newBet;
            this.lastAggressorSeat = player.seatNumber;
            this.resetActionsAfterAggression(player.seatNumber);
            this.bbHasOption = false;
        }

        player.totalBetThisHand += chips;
        this.pot                += chips;
        player.currentBet        = newBet;
        player.chips             = 0;
        player.isAllIn           = true;
        player.lastAction        = 'All-In';
    }

    // ─── Betting Round Logic ────────────────────────────────────────────────

    advanceAction() {

        if (this.gameState === 'finished' || this.gameState === 'showdown') return;
        
        const alive = this.getActivePlayers();
        if (alive.length <= 1) return; // awardPot called inside fold

        if (this.isBettingRoundOver()) {
            this.nextStreet();
            return;
        }

        const nextSeat = this.getNextPlayerToAct(this.currentPlayerSeat);
        if (nextSeat !== null) {
            this.setCurrentPlayer(nextSeat);
            this.startActionTimer();
        } else {
            this.nextStreet();
        }
    }

    isBettingRoundOver() {
        const active = this.getActivePlayers();

        // Special case: preflop BB option
        // If BB hasn't acted voluntarily and no one raised, BB still gets to act
        if (this.gameState === GAME_STATES.PREFLOP && this.bbHasOption) {
            const bb = Array.from(this.players.values()).find(p => p.isBigBlind);
            if (bb && bb.canAct() && !bb.hasActedThisRound) {
                return false;
            }
        }

        return active.every(p =>
            (p.hasActedThisRound && p.currentBet === this.currentBet) || p.isAllIn
        );
    }

    getNextPlayerToAct(fromSeat) {
        const seats = this.getSortedSeats();
        const idx   = seats.indexOf(fromSeat);
        for (let i = 1; i <= seats.length; i++) {
            const s = seats[(idx + i) % seats.length];
            const p = this.players.get(s);
            if (!p || p.isFolded || p.isAllIn || !p.isActive || p.isWaiting) continue;
            if (!p.hasActedThisRound || p.currentBet < this.currentBet) return s;
        }
        return null;
    }

    nextStreet() {
        // Reset bets and action flags
        for (const [, p] of this.players) {
            p.currentBet        = 0;
            p.hasActedThisRound = false;
        }
        this.currentBet       = 0;
        this.lastRaiseSize    = this.bigBlind;
        this.lastAggressorSeat = null;

        switch (this.gameState) {
            case GAME_STATES.PREFLOP: this.dealFlop();  break;
            case GAME_STATES.FLOP:   this.dealTurn();  break;
            case GAME_STATES.TURN:   this.dealRiver(); break;
            case GAME_STATES.RIVER:  this.showdown();  break;
        }
    }

    dealFlop() {
        this.deck.deal(1); // burn
        this.boardCards.push(...this.deck.deal(3));
        this.gameState = GAME_STATES.FLOP;
        this.emit('board_updated', {
            tableId:    this.id,
            boardCards: this._boardJSON(),
            street:     'flop',
            pot:        this.pot,
        });
        this.setPostFlopFirstToAct();
    }

    dealTurn() {
        this.deck.deal(1);
        this.boardCards.push(...this.deck.deal(1));
        this.gameState = GAME_STATES.TURN;
        this.emit('board_updated', {
            tableId:    this.id,
            boardCards: this._boardJSON(),
            street:     'turn',
            pot:        this.pot,
        });
        this.setPostFlopFirstToAct();
    }

    dealRiver() {
        this.deck.deal(1);
        this.boardCards.push(...this.deck.deal(1));
        this.gameState = GAME_STATES.RIVER;
        this.emit('board_updated', {
            tableId:    this.id,
            boardCards: this._boardJSON(),
            street:     'river',
            pot:        this.pot,
        });
        this.setPostFlopFirstToAct();
    }

    // Post-flop: first active player LEFT of dealer
    setPostFlopFirstToAct() {
        const seats = this.getSortedSeats();
        const dIdx  = seats.indexOf(this.dealerSeat);
        for (let i = 1; i <= seats.length; i++) {
            const s = seats[(dIdx + i) % seats.length];
            const p = this.players.get(s);
            if (p && !p.isFolded && !p.isAllIn && p.isActive && !p.isWaiting) {
                this.setCurrentPlayer(s);
                this.startActionTimer();
                return;
            }
        }
        // Everyone all-in → showdown
        this.showdown();
    }

    // ─── Showdown ───────────────────────────────────────────────────────────

    showdown() {
        this.gameState = GAME_STATES.SHOWDOWN;
        this.clearActionTimer();

        const active = this.getActivePlayers();
        if (active.length === 0) return;

        // Evaluate all active hands
        const results = active.map(p => {
            const allCards = [...p.holeCards, ...this.boardCards];
            const hand     = HandEvaluator.evaluate(allCards);
            // Find which 5 cards made the best hand
            const winningCards = hand?.cards?.map(c => c.toJSON ? c.toJSON() : c) || [];
            return { player: p, hand, winningCards };
        });

        results.sort((a, b) => HandEvaluator.compare(b.hand, a.hand));

        // Find winners
        const winners = [results[0]];
        for (let i = 1; i < results.length; i++) {
            if (HandEvaluator.compare(results[i].hand, results[0].hand) === 0) {
                winners.push(results[i]);
            }
        }

        // Showdown order: last aggressor first, then clockwise
        // If no aggressor (all checked), left of dealer first
        const showdownOrder = this.getShowdownOrder(results.map(r => r.player));

        this.emit('showdown', {
            tableId:     this.id,
            handResults: showdownOrder.map(p => {
                const r = results.find(r => r.player.userId === p.userId);
                return {
                    userId:       p.userId,
                    username:     p.username,
                    holeCards:    p.holeCards.map(c => c.toJSON ? c.toJSON() : c),
                    handName:     r?.hand?.name || 'High Card',
                    handRank:     r?.hand?.rank || 0,
                    winningCards: r?.winningCards || [],
                    isWinner:     winners.some(w => w.player.userId === p.userId),
                };
            }),
        });

        this.awardSidePots(winners, results);
    }

    getShowdownOrder(players) {
        const seats = this.getSortedSeats();
        // Last aggressor shows first
        if (this.lastAggressorSeat) {
            const agIdx  = seats.indexOf(this.lastAggressorSeat);
            const ordered = [];
            for (let i = 0; i < seats.length; i++) {
                const s = seats[(agIdx + i) % seats.length];
                const p = players.find(p => p.seatNumber === s);
                if (p) ordered.push(p);
            }
            return ordered;
        }
        // All checked → left of dealer
        const dIdx = seats.indexOf(this.dealerSeat);
        const ordered = [];
        for (let i = 1; i <= seats.length; i++) {
            const s = seats[(dIdx + i) % seats.length];
            const p = players.find(p => p.seatNumber === s);
            if (p) ordered.push(p);
        }
        return ordered;
    }

    // ─── Side Pot Award ─────────────────────────────────────────────────────

    awardSidePots(mainWinners, allResults) {
        this.clearActionTimer();

        const allPlayers  = Array.from(this.players.values());
        const pots        = calculateSidePots(allPlayers);
        const rake        = Math.floor(this.pot * this.rake);
        const awardable   = this.pot - rake;

        const winnersByPot = [];

        let distributed = 0;
        for (const pot of pots) {
            if (pot.amount <= 0) continue;

            // Find best hand among eligible players
            const eligible = allResults.filter(r => pot.eligible.includes(r.player.userId));
            if (!eligible.length) continue;

            eligible.sort((a, b) => HandEvaluator.compare(b.hand, a.hand));
            const potWinners = [eligible[0]];
            for (let i = 1; i < eligible.length; i++) {
                if (HandEvaluator.compare(eligible[i].hand, eligible[0].hand) === 0) {
                    potWinners.push(eligible[i]);
                }
            }

            // Proportional award from awardable
            const potRatio  = pot.amount / this.pot;
            const potAward  = Math.floor(awardable * potRatio);
            const share     = Math.floor(potAward / potWinners.length);
            const remainder = potAward - share * potWinners.length;

            potWinners.forEach((w, i) => {
                w.player.chips += share + (i === 0 ? remainder : 0);
                distributed    += share + (i === 0 ? remainder : 0);
            });

            winnersByPot.push({
                potAmount: pot.amount,
                winners:   potWinners.map(w => ({
                    userId:   w.player.userId,
                    username: w.player.username,
                    chipsWon: share,
                    holeCards: w.player.holeCards.map(c => c.toJSON ? c.toJSON() : c),
                    handName:  w.hand?.name,
                    winningCards: w.winningCards,
                })),
            });
        }

        this.emit('hand_finished', {
            tableId:     this.id,
            handNumber:  this.handNumber,
            pot:         this.pot,
            rake,
            boardCards:  this._boardJSON(),
            winners:     winnersByPot.flatMap(p => p.winners),
            winnersByPot,
            players:     this.getPlayersPublicData(),
        });

        this.gameState = GAME_STATES.FINISHED;

        setTimeout(() => {
            this.removeBrokePlayers();
            this.gameState = GAME_STATES.WAITING;
            if (this.getEligiblePlayers().length >= 2) this.startHand();
        }, 7000);
    }

    // ─── Award Pot (single winner — all folded) ─────────────────────────────
    awardPot(winners) {
        this.clearActionTimer();
        const rake    = Math.floor(this.pot * this.rake);
        const award   = this.pot - rake;
        const share   = Math.floor(award / winners.length);
        const remainder = award - share * winners.length;

        winners.forEach((w, i) => { w.chips += share + (i === 0 ? remainder : 0); });

        this.emit('hand_finished', {
            tableId:    this.id,
            handNumber: this.handNumber,
            pot:        this.pot,
            rake,
            boardCards: this._boardJSON(),
            winners:    winners.map((w, i) => ({
                userId:   w.userId,
                username: w.username,
                chipsWon: share + (i === 0 ? remainder : 0),
                holeCards: [], // winner didn't have to show
                handName: null,
            })),
            players: this.getPlayersPublicData(),
        });

        this.gameState = GAME_STATES.FINISHED;

        setTimeout(() => {
            this.removeBrokePlayers();
            this.gameState = GAME_STATES.WAITING;
            if (this.getEligiblePlayers().length >= 2) this.startHand();
        }, 7000);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    assignDealer() {
        const seats = this.getSortedSeats();
        if (!this.dealerSeat || !seats.includes(this.dealerSeat)) {
            this.dealerSeat = seats[0];
        } else {
            const i = seats.indexOf(this.dealerSeat);
            this.dealerSeat = seats[(i + 1) % seats.length];
        }
        const d = this.players.get(this.dealerSeat);
        if (d) d.isDealer = true;
    }

    getSortedSeats() {
        return Array.from(this.players.keys()).sort((a, b) => a - b);
    }

    getBigBlindSeat() {
        for (const [seat, p] of this.players) {
            if (p.isBigBlind) return seat;
        }
        return null;
    }

    getNextActivePlayer(fromSeat) {
        const seats = this.getSortedSeats();
        const idx   = seats.indexOf(fromSeat);
        for (let i = 1; i <= seats.length; i++) {
            const s = seats[(idx + i) % seats.length];
            const p = this.players.get(s);
            if (p && p.canAct()) return s;
        }
        return null;
    }

    setCurrentPlayer(seat) {
        this.currentPlayerSeat = seat;
        const p = this.players.get(seat);
        if (!p) return;

        const callAmount = Math.max(0, this.currentBet - p.currentBet);
        const canCheck   = callAmount === 0;
        const timeStart  = Date.now();

        this.emit('action_required', {
            tableId:     this.id,
            userId:      p.userId,
            seat,
            timeLimit:   this.actionTimeout / 1000,
            timeStart,
            pot:         this.pot,
            currentBet:  this.currentBet,
            callAmount,
            canCheck,
            minRaise:    this.currentBet + this.lastRaiseSize,
            playerChips: p.chips,
            canBlind:    !p.hasSeenCards, // can play blind only if cards not seen
        });
    }

    resetActionsAfterAggression(aggressorSeat) {
        for (const [, p] of this.players) {
            if (p.seatNumber !== aggressorSeat && !p.isFolded && !p.isAllIn && !p.isWaiting) {
                p.hasActedThisRound = false;
            }
        }
    }

    removeBrokePlayers() {
        for (const [seat, p] of this.players) {
            if (p.chips < this.bigBlind && !p.isBot) {
                this.emit('player_removed', { userId: p.userId, chips: p.chips, reason: 'broke' });
                this.players.delete(seat);
            }
        }
    }

    startActionTimer() {
        this.clearActionTimer();
        this.actionTimer = setTimeout(() => {
            const p = this.players.get(this.currentPlayerSeat);
            if (!p || this._lock) return;
            try {
                const callAmt = this.currentBet - p.currentBet;
                // Auto-fold on timeout, then remove from seat
                this.handleAction(p.userId, callAmt > 0 ? PLAYER_ACTIONS.FOLD : PLAYER_ACTIONS.CHECK);
                // Emit timeout event so client can remove from seat
                this.emit('player_timeout', { userId: p.userId, seatNumber: p.seatNumber });
            } catch { this._lock = false; }
        }, this.actionTimeout);
    }

    clearActionTimer() {
        if (this.actionTimer) {
            clearTimeout(this.actionTimer);
            this.actionTimer = null;
        }
    }

    endHandEarly() {
        this.clearActionTimer();
        this._lock = false;
        const alive = this.getActivePlayers();
        if (alive.length === 1) this.awardPot(alive);
        else this.gameState = GAME_STATES.WAITING;
    }

    _boardJSON() {
        return this.boardCards.map(c => c.toJSON ? c.toJSON() : c);
    }

    getPlayersPublicData() {
        return Array.from(this.players.values()).map(p => p.toPublicJSON());
    }

    getTableState(requestingUserId = null) {
        const p = requestingUserId ? this.getPlayerByUserId(requestingUserId) : null;
        const callAmount = p ? Math.max(0, this.currentBet - p.currentBet) : 0;
        return {
            id:                this.id,
            name:              this.name,
            gameState:         this.gameState,
            pot:               this.pot,
            currentBet:        this.currentBet,
            boardCards:        this._boardJSON(),
            currentPlayerSeat: this.currentPlayerSeat,
            callAmount,
            canCheck:          callAmount === 0,
            minRaise:          this.currentBet + this.lastRaiseSize,
            players:           Array.from(this.players.values()).map(pl =>
                requestingUserId ? pl.toPrivateJSON(requestingUserId) : pl.toPublicJSON()
            ),
        };
    }
}

module.exports = { PokerTable, PokerPlayer, GAME_STATES, PLAYER_ACTIONS };
