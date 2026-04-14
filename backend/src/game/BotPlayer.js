// BotPlayer.js — Professional poker AI with correct strategy

const { PLAYER_ACTIONS } = require('./PokerEngine');

const BOT_PROFILES = [
    { name:"IronMike",    style:"aggressive", aggression:0.80, tightness:0.30 },
    { name:"CoolJack",    style:"tight",      aggression:0.30, tightness:0.70 },
    { name:"LuckyAce",    style:"loose",      aggression:0.50, tightness:0.20 },
    { name:"StoneFace",   style:"aggressive", aggression:0.85, tightness:0.25 },
    { name:"QuietKing",   style:"tight",      aggression:0.25, tightness:0.75 },
    { name:"WildQueen",   style:"loose",      aggression:0.60, tightness:0.15 },
    { name:"GoldRush",    style:"aggressive", aggression:0.75, tightness:0.30 },
    { name:"IcePick",     style:"tight",      aggression:0.30, tightness:0.70 },
    { name:"FireAnt",     style:"loose",      aggression:0.55, tightness:0.20 },
    { name:"DarkHorse",   style:"aggressive", aggression:0.80, tightness:0.25 },
    { name:"SlowBurn",    style:"tight",      aggression:0.20, tightness:0.80 },
    { name:"NightOwl",    style:"loose",      aggression:0.60, tightness:0.20 },
    { name:"BullRun",     style:"aggressive", aggression:0.75, tightness:0.30 },
    { name:"FoxTrot",     style:"tight",      aggression:0.35, tightness:0.65 },
    { name:"StarDust",    style:"loose",      aggression:0.50, tightness:0.25 },
    { name:"RapidFire",   style:"aggressive", aggression:0.90, tightness:0.20 },
    { name:"ZenMaster",   style:"tight",      aggression:0.20, tightness:0.85 },
    { name:"HighRoller",  style:"loose",      aggression:0.65, tightness:0.20 },
    { name:"ThunderBolt", style:"aggressive", aggression:0.80, tightness:0.30 },
    { name:"SilkRoad",    style:"tight",      aggression:0.30, tightness:0.70 },
    { name:"CryptoKing",  style:"loose",      aggression:0.55, tightness:0.25 },
    { name:"DiamondHand", style:"aggressive", aggression:0.85, tightness:0.25 },
    { name:"ShadowPlay",  style:"tight",      aggression:0.25, tightness:0.75 },
    { name:"BlazePath",   style:"loose",      aggression:0.50, tightness:0.20 },
    { name:"IronWill",    style:"aggressive", aggression:0.75, tightness:0.35 },
    { name:"ColdBlood",   style:"tight",      aggression:0.20, tightness:0.80 },
    { name:"HotStreak",   style:"loose",      aggression:0.60, tightness:0.20 },
    { name:"TigerClaw",   style:"aggressive", aggression:0.85, tightness:0.20 },
    { name:"GhostRider",  style:"tight",      aggression:0.30, tightness:0.70 },
    { name:"SunDown",     style:"loose",      aggression:0.45, tightness:0.30 },
    { name:"NeonLight",   style:"aggressive", aggression:0.70, tightness:0.30 },
    { name:"StormBreak",  style:"tight",      aggression:0.25, tightness:0.75 },
    { name:"GoldDigger",  style:"loose",      aggression:0.55, tightness:0.20 },
    { name:"DeepWater",   style:"aggressive", aggression:0.75, tightness:0.30 },
    { name:"SwiftHand",   style:"tight",      aggression:0.30, tightness:0.65 },
    { name:"LavaFlow",    style:"loose",      aggression:0.50, tightness:0.25 },
    { name:"ViperStrike", style:"aggressive", aggression:0.80, tightness:0.25 },
    { name:"FrostBite",   style:"tight",      aggression:0.25, tightness:0.75 },
    { name:"SolarFlare",  style:"loose",      aggression:0.55, tightness:0.20 },
    { name:"BlackPearl",  style:"aggressive", aggression:0.90, tightness:0.20 },
];

const RANK = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

// ─── Pre-flop hand strength (Chen formula approximation) ─────────────────────
function preFlopStrength(c1, c2) {
    const v1 = RANK[c1.rank] || 7;
    const v2 = RANK[c2.rank] || 7;
    const hi = Math.max(v1, v2);
    const lo = Math.min(v1, v2);
    const isPair   = v1 === v2;
    const isSuited = c1.suit === c2.suit;
    const gap      = hi - lo;

    if (isPair) {
        if (hi >= 14) return 1.00; // AA
        if (hi >= 13) return 0.95; // KK
        if (hi >= 12) return 0.90; // QQ
        if (hi >= 11) return 0.85; // JJ
        if (hi >= 10) return 0.78; // TT
        if (hi >= 8)  return 0.68; // 88-99
        if (hi >= 6)  return 0.58; // 66-77
        return 0.50;
    }
    if (hi === 14 && lo >= 13) return isSuited ? 0.88 : 0.82; // AK
    if (hi === 14 && lo >= 12) return isSuited ? 0.80 : 0.73; // AQ
    if (hi === 14 && lo >= 11) return isSuited ? 0.75 : 0.67; // AJ
    if (hi === 14 && lo >= 10) return isSuited ? 0.70 : 0.62; // AT
    if (hi === 13 && lo >= 12) return isSuited ? 0.72 : 0.64; // KQ

    let score = (hi + lo) / 28;
    if (isSuited) score += 0.06;
    if (gap <= 1)  score += 0.05;
    if (gap <= 2)  score += 0.02;
    if (gap >= 4)  score -= 0.06;
    if (hi >= 12)  score += 0.05;

    return Math.min(Math.max(score, 0.05), 0.90);
}

// ─── Pot odds ─────────────────────────────────────────────────────────────────
function potOdds(callAmt, pot) {
    if (callAmt <= 0) return 1;
    return pot / (pot + callAmt);
}

// ─── Board danger assessment ──────────────────────────────────────────────────
function boardDanger(boardCards) {
    if (!boardCards || boardCards.length < 3) return 0;
    const suits  = boardCards.map(c => c.suit);
    const values = boardCards.map(c => RANK[c.rank] || 7).sort((a, b) => b - a);

    const suitMax = Math.max(...Object.values(
        suits.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {})
    ));

    const uniq = [...new Set(values)].sort((a, b) => a - b);
    let consecutive = 1, maxConsec = 1;
    for (let i = 1; i < uniq.length; i++) {
        if (uniq[i] - uniq[i-1] === 1) { consecutive++; maxConsec = Math.max(maxConsec, consecutive); }
        else consecutive = 1;
    }

    let danger = 0;
    if (suitMax >= 3)   danger += 0.30;
    if (maxConsec >= 3) danger += 0.20;
    if (values[0] >= 12) danger += 0.10;
    return Math.min(danger, 0.60);
}

// ─── Bot Player ───────────────────────────────────────────────────────────────
class BotPlayer {
    constructor(profile, tableId) {
        this.profile = profile;
        this.tableId = tableId;
    }

    think(isObvious = false) {
        const base = isObvious ? 600 : 1500;
        return base + Math.random() * 2500;
    }

    async decideAction(actionData, holeCards, boardCards) {
        const { callAmount, pot, currentBet, playerChips, canCheck } = actionData;
        const { aggression, tightness, style } = this.profile;

        if (!holeCards || holeCards.length < 2) {
            await new Promise(r => setTimeout(r, 800));
            return { action: canCheck ? PLAYER_ACTIONS.CHECK : PLAYER_ACTIONS.FOLD };
        }

        const [c1, c2] = holeCards;
        const isPreFlop = !boardCards || boardCards.length === 0;
        const street = !boardCards?.length ? 'preflop'
            : boardCards.length <= 3 ? 'flop'
            : boardCards.length === 4 ? 'turn' : 'river';

        let strength = preFlopStrength(c1, c2);

        if (!isPreFlop) {
            const danger = boardDanger(boardCards);
            strength = strength * (1 - danger * tightness * 0.5);
        }

        const variance = (Math.random() - 0.5) * 0.12;
        strength = Math.min(Math.max(strength + variance, 0.05), 0.98);

        const odds     = potOdds(callAmount, pot || 100);
        const hasOdds  = strength > odds * 0.75;
        const willBluff = Math.random() < aggression * 0.20 && street !== 'preflop';

        await new Promise(r => setTimeout(r, this.think(strength > 0.80 || strength < 0.25)));

        // ── Pre-flop ──────────────────────────────────────────────────────────
        if (isPreFlop) {
            if (strength >= 0.85) {
                // Premium: always raise
                return { action: PLAYER_ACTIONS.RAISE, amount: currentBet * (2 + Math.floor(aggression * 3)) };
            }
            if (strength >= 0.65) {
                if (callAmount === 0) {
                    if (Math.random() < aggression * 0.6)
                        return { action: PLAYER_ACTIONS.RAISE, amount: currentBet * 3 };
                    return { action: PLAYER_ACTIONS.CHECK };
                }
                if (callAmount <= currentBet * 3) return { action: PLAYER_ACTIONS.CALL };
                if (Math.random() < tightness)    return { action: PLAYER_ACTIONS.FOLD };
                return { action: PLAYER_ACTIONS.CALL };
            }
            if (strength >= 0.45) {
                if (callAmount === 0) return { action: PLAYER_ACTIONS.CHECK };
                if (callAmount <= currentBet * 2) return { action: PLAYER_ACTIONS.CALL };
                return { action: PLAYER_ACTIONS.FOLD };
            }
            // Weak
            if (callAmount === 0) return { action: PLAYER_ACTIONS.CHECK };
            return { action: PLAYER_ACTIONS.FOLD };
        }

        // ── Post-flop ─────────────────────────────────────────────────────────
        const stackToPot = (playerChips || 0) / Math.max(pot, 1);

        if (strength >= 0.80) {
            if (callAmount === 0) {
                const bet = Math.floor(pot * (0.5 + aggression * 0.5));
                if (bet > 0 && bet <= playerChips)
                    return { action: PLAYER_ACTIONS.RAISE, amount: currentBet + bet };
                return { action: PLAYER_ACTIONS.CHECK };
            }
            if (Math.random() < aggression * 0.5) {
                const raise = callAmount * (2 + Math.floor(aggression * 2));
                if (raise <= playerChips)
                    return { action: PLAYER_ACTIONS.RAISE, amount: currentBet + raise };
            }
            return { action: PLAYER_ACTIONS.CALL };
        }

        if (strength >= 0.60) {
            if (callAmount === 0) {
                if (Math.random() < aggression * 0.4)
                    return { action: PLAYER_ACTIONS.RAISE, amount: currentBet + Math.floor(pot * 0.4) };
                return { action: PLAYER_ACTIONS.CHECK };
            }
            if (hasOdds) return { action: PLAYER_ACTIONS.CALL };
            if (Math.random() < tightness * 0.4) return { action: PLAYER_ACTIONS.FOLD };
            return { action: PLAYER_ACTIONS.CALL };
        }

        if (strength >= 0.40) {
            if (callAmount === 0) {
                if (willBluff)
                    return { action: PLAYER_ACTIONS.RAISE, amount: currentBet + Math.floor(pot * 0.6) };
                return { action: PLAYER_ACTIONS.CHECK };
            }
            if (callAmount <= pot * 0.25 && hasOdds) return { action: PLAYER_ACTIONS.CALL };
            if (Math.random() < tightness) return { action: PLAYER_ACTIONS.FOLD };
            return { action: PLAYER_ACTIONS.CALL };
        }

        // Weak hand
        if (callAmount === 0) {
            if (willBluff)
                return { action: PLAYER_ACTIONS.RAISE, amount: currentBet + Math.floor(pot * 0.65) };
            return { action: PLAYER_ACTIONS.CHECK };
        }
        // River hero call
        if (street === 'river' && callAmount <= pot * 0.08 && Math.random() < 0.15)
            return { action: PLAYER_ACTIONS.CALL };

        return { action: PLAYER_ACTIONS.FOLD };
    }
}

module.exports = { BotPlayer, BOT_PROFILES };
