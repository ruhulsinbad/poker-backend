// HandEvaluator.js — Texas Hold'em hand evaluation

const HAND_RANKINGS = {
    ROYAL_FLUSH:    9,
    STRAIGHT_FLUSH: 8,
    FOUR_OF_A_KIND: 7,
    FULL_HOUSE:     6,
    FLUSH:          5,
    STRAIGHT:       4,
    THREE_OF_A_KIND:3,
    TWO_PAIR:       2,
    ONE_PAIR:       1,
    HIGH_CARD:      0
};

const HAND_NAMES = {
    9: 'Royal Flush',
    8: 'Straight Flush',
    7: 'Four of a Kind',
    6: 'Full House',
    5: 'Flush',
    4: 'Straight',
    3: 'Three of a Kind',
    2: 'Two Pair',
    1: 'One Pair',
    0: 'High Card'
};

class HandEvaluator {
    // Get best 5-card hand from 7 cards (2 hole + 5 board)
    static evaluate(cards) {
        const combinations = this.getCombinations(cards, 5);
        let bestHand = null;
        let bestScore = -1;

        for (const combo of combinations) {
            const result = this.evaluateFive(combo);
            if (result.score > bestScore) {
                bestScore = result.score;
                bestHand = { ...result, cards: combo };
            }
        }

        return bestHand;
    }

    // Evaluate exactly 5 cards
    static evaluateFive(cards) {
        const values = cards.map(c => c.value).sort((a, b) => b - a);
        const suits = cards.map(c => c.suit);
        const isFlush = new Set(suits).size === 1;
        const isStraight = this.checkStraight(values);

        const valueCounts = {};
        for (const v of values) {
            valueCounts[v] = (valueCounts[v] || 0) + 1;
        }
        const counts = Object.values(valueCounts).sort((a, b) => b - a);

        if (isFlush && isStraight) {
            const isRoyal = values[0] === 14 && values[1] === 13;
            return {
                rank: isRoyal ? HAND_RANKINGS.ROYAL_FLUSH : HAND_RANKINGS.STRAIGHT_FLUSH,
                name: isRoyal ? 'Royal Flush' : 'Straight Flush',
                score: (isRoyal ? HAND_RANKINGS.ROYAL_FLUSH : HAND_RANKINGS.STRAIGHT_FLUSH) * 1e10 + values[0]
            };
        }

        if (counts[0] === 4) {
            const fourVal = parseInt(Object.keys(valueCounts).find(k => valueCounts[k] === 4));
            return {
                rank: HAND_RANKINGS.FOUR_OF_A_KIND,
                name: 'Four of a Kind',
                score: HAND_RANKINGS.FOUR_OF_A_KIND * 1e10 + fourVal * 1e6
            };
        }

        if (counts[0] === 3 && counts[1] === 2) {
            const threeVal = parseInt(Object.keys(valueCounts).find(k => valueCounts[k] === 3));
            return {
                rank: HAND_RANKINGS.FULL_HOUSE,
                name: 'Full House',
                score: HAND_RANKINGS.FULL_HOUSE * 1e10 + threeVal * 1e6
            };
        }

        if (isFlush) {
            return {
                rank: HAND_RANKINGS.FLUSH,
                name: 'Flush',
                score: HAND_RANKINGS.FLUSH * 1e10 + this.kicker(values)
            };
        }

        if (isStraight) {
            return {
                rank: HAND_RANKINGS.STRAIGHT,
                name: 'Straight',
                score: HAND_RANKINGS.STRAIGHT * 1e10 + values[0]
            };
        }

        if (counts[0] === 3) {
            const threeVal = parseInt(Object.keys(valueCounts).find(k => valueCounts[k] === 3));
            return {
                rank: HAND_RANKINGS.THREE_OF_A_KIND,
                name: 'Three of a Kind',
                score: HAND_RANKINGS.THREE_OF_A_KIND * 1e10 + threeVal * 1e6
            };
        }

        if (counts[0] === 2 && counts[1] === 2) {
            const pairs = Object.keys(valueCounts)
                .filter(k => valueCounts[k] === 2)
                .map(Number)
                .sort((a, b) => b - a);
            return {
                rank: HAND_RANKINGS.TWO_PAIR,
                name: 'Two Pair',
                score: HAND_RANKINGS.TWO_PAIR * 1e10 + pairs[0] * 1e6 + pairs[1] * 1e3
            };
        }

        if (counts[0] === 2) {
            const pairVal = parseInt(Object.keys(valueCounts).find(k => valueCounts[k] === 2));
            return {
                rank: HAND_RANKINGS.ONE_PAIR,
                name: 'One Pair',
                score: HAND_RANKINGS.ONE_PAIR * 1e10 + pairVal * 1e6 + this.kicker(values.filter(v => v !== pairVal))
            };
        }

        return {
            rank: HAND_RANKINGS.HIGH_CARD,
            name: 'High Card',
            score: HAND_RANKINGS.HIGH_CARD * 1e10 + this.kicker(values)
        };
    }

    static checkStraight(sortedValues) {
        // Check regular straight
        let isConsecutive = true;
        for (let i = 1; i < sortedValues.length; i++) {
            if (sortedValues[i - 1] - sortedValues[i] !== 1) {
                isConsecutive = false;
                break;
            }
        }
        if (isConsecutive) return true;

        // Check wheel (A-2-3-4-5)
        if (sortedValues[0] === 14) {
            const wheelValues = [5, 4, 3, 2, 1];
            const adjustedValues = [sortedValues[1], sortedValues[2], sortedValues[3], sortedValues[4], 1];
            return JSON.stringify(adjustedValues) === JSON.stringify(wheelValues);
        }

        return false;
    }

    static kicker(values) {
        let score = 0;
        for (let i = 0; i < Math.min(values.length, 5); i++) {
            score += values[i] * Math.pow(15, 4 - i);
        }
        return score;
    }

    // Get all combinations of k items from array
    static getCombinations(arr, k) {
        const result = [];
        const combo = [];

        function backtrack(start) {
            if (combo.length === k) {
                result.push([...combo]);
                return;
            }
            for (let i = start; i < arr.length; i++) {
                combo.push(arr[i]);
                backtrack(i + 1);
                combo.pop();
            }
        }

        backtrack(0);
        return result;
    }

    // Compare two hands, return 1 if hand1 wins, -1 if hand2 wins, 0 for tie
    static compare(hand1, hand2) {
        if (hand1.score > hand2.score) return 1;
        if (hand1.score < hand2.score) return -1;
        return 0;
    }

    static getHandName(rank) {
        return HAND_NAMES[rank] || 'Unknown';
    }

    // Calculate win probability (Monte Carlo simulation)
    static calculateOdds(holeCards, boardCards, numSimulations = 1000) {
        const { Deck } = require('./Deck');
        let wins = 0;

        for (let i = 0; i < numSimulations; i++) {
            const deck = new Deck();
            deck.shuffle();

            // Remove known cards
            const knownCards = [...holeCards, ...boardCards];
            deck.cards = deck.cards.filter(c =>
                !knownCards.some(k => k.rank === c.rank && k.suit === c.suit)
            );

            // Complete the board
            const remainingBoard = deck.deal(5 - boardCards.length);
            const fullBoard = [...boardCards, ...remainingBoard];

            // Deal opponent hand
            const opponentHole = deck.deal(2);

            const playerHand = this.evaluate([...holeCards, ...fullBoard]);
            const opponentHand = this.evaluate([...opponentHole, ...fullBoard]);

            if (this.compare(playerHand, opponentHand) === 1) wins++;
        }

        return Math.round((wins / numSimulations) * 100);
    }
}

module.exports = { HandEvaluator, HAND_RANKINGS, HAND_NAMES };
