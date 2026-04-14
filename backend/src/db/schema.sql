-- PokerMiniApp — Complete Database Schema
-- Run this fresh on a new database

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Users ──────────────────────────────────────────────────────────────────

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    photo_url TEXT,
    chips BIGINT DEFAULT 0,
    premium_chips BIGINT DEFAULT 0,
    level INTEGER DEFAULT 1,
    xp BIGINT DEFAULT 0,
    referral_code VARCHAR(20) UNIQUE NOT NULL DEFAULT '',
    referred_by UUID REFERENCES users(id),
    is_early_access BOOLEAN DEFAULT false,
    is_influencer BOOLEAN DEFAULT false,
    is_banned BOOLEAN DEFAULT false,
    is_bot BOOLEAN DEFAULT false,
    ban_reason TEXT,
    total_referrals INTEGER DEFAULT 0,
    total_hands INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_chips_won BIGINT DEFAULT 0,
    ton_wallet VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_referral_code ON users(referral_code);
CREATE INDEX idx_users_level ON users(level);
CREATE INDEX idx_users_is_bot ON users(is_bot);

-- ─── Level Config ────────────────────────────────────────────────────────────

CREATE TABLE level_config (
    level INTEGER PRIMARY KEY,
    xp_required BIGINT NOT NULL,
    chips_reward BIGINT DEFAULT 0,
    unlock_feature VARCHAR(100),
    description TEXT
);

INSERT INTO level_config (level, xp_required, chips_reward, unlock_feature, description) VALUES
(1,  0,        1000,   null,            'Starting level'),
(2,  500,      1500,   null,            'Beginner'),
(3,  1500,     2000,   null,            'Rookie'),
(4,  3000,     2500,   null,            'Amateur'),
(5,  6000,     3000,   null,            'Regular'),
(6,  10000,    4000,   null,            'Semi-Pro'),
(7,  15000,    5000,   null,            'Advanced'),
(8,  22000,    6000,   null,            'Expert'),
(9,  30000,    8000,   null,            'Master'),
(10, 40000,    10000,  'revenue_share', 'Revenue sharing unlocked!'),
(15, 80000,    15000,  'influencer',    'Influencer pool eligible'),
(20, 150000,   25000,  null,            'High Roller'),
(25, 250000,   40000,  null,            'Shark'),
(30, 400000,   60000,  'nft_sell',      'NFT Marketplace unlocked!'),
(40, 700000,   100000, null,            'Legend'),
(50, 1000000,  200000, null,            'God Mode');

-- ─── Tasks ───────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL,
    chips_reward BIGINT DEFAULT 0,
    xp_reward INTEGER DEFAULT 0,
    action_url TEXT,
    action_type VARCHAR(50),
    action_value VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO tasks (title, description, task_type, chips_reward, xp_reward, action_type, action_value, sort_order) VALUES
('Daily Login',           'Login every day for chips',     'daily',    500,   50,  'daily_login',    null,          1),
('Join Telegram Channel', 'Join our official channel',     'one_time', 2000,  200, 'join_channel',   '@yourchannel',2),
('Invite 1 Friend',       'Invite your first friend',      'one_time', 1000,  100, 'invite',         '1',           3),
('Invite 5 Friends',      'Invite 5 friends',              'one_time', 5000,  500, 'invite',         '5',           4),
('Invite 10 Friends',     'Invite 10 friends',             'one_time', 12000, 1000,'invite',         '10',          5),
('Play 10 Hands',         'Play 10 poker hands',           'game',     1000,  100, 'play_hands',     '10',          6),
('Play 50 Hands',         'Play 50 poker hands',           'game',     5000,  500, 'play_hands',     '50',          7),
('Win Your First Hand',   'Win a poker hand',              'game',     2000,  200, 'win_hands',      '1',           8),
('Follow on Twitter',     'Follow us on Twitter/X',        'one_time', 1500,  150, 'follow_twitter', '@yourtwitter',9),
('Connect TON Wallet',    'Connect your TON wallet',       'one_time', 3000,  300, 'connect_wallet', null,          10);

-- ─── User Tasks ──────────────────────────────────────────────────────────────

CREATE TABLE user_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id),
    status VARCHAR(20) DEFAULT 'pending',
    completed_at TIMESTAMP,
    claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, task_id)
);
CREATE INDEX idx_user_tasks_user_id ON user_tasks(user_id);

-- ─── Poker Tables ────────────────────────────────────────────────────────────

CREATE TABLE poker_tables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    table_type VARCHAR(50) DEFAULT 'cash',
    min_buy_in BIGINT NOT NULL,
    max_buy_in BIGINT NOT NULL,
    small_blind BIGINT NOT NULL,
    big_blind BIGINT NOT NULL,
    max_players INTEGER DEFAULT 6,
    current_players INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    chips_type VARCHAR(20) DEFAULT 'chips',
    private_code VARCHAR(10),
    created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO poker_tables (name, min_buy_in, max_buy_in, small_blind, big_blind, chips_type) VALUES
('Beginner Table',  1000,   5000,   25,   50,   'chips'),
('Regular Table',   5000,   20000,  100,  200,  'chips'),
('High Roller',     20000,  100000, 500,  1000, 'chips'),
('Premium Table',   5000,   50000,  100,  200,  'premium_chips'),
('VIP Table',       50000,  500000, 1000, 2000, 'premium_chips');

-- ─── Game Sessions ───────────────────────────────────────────────────────────

CREATE TABLE game_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id UUID REFERENCES poker_tables(id),
    hand_number INTEGER NOT NULL,
    pot BIGINT DEFAULT 0,
    rake BIGINT DEFAULT 0,
    board_cards JSONB,
    winner_id UUID REFERENCES users(id),
    winning_hand VARCHAR(50),
    started_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP
);

-- ─── Chip Transactions ───────────────────────────────────────────────────────

CREATE TABLE chip_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    amount BIGINT NOT NULL,
    chips_type VARCHAR(20) DEFAULT 'chips',
    transaction_type VARCHAR(50) NOT NULL,
    reference_id UUID,
    description TEXT,
    ton_amount NUMERIC(18,9),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_transactions_user_id ON chip_transactions(user_id);
CREATE INDEX idx_transactions_type ON chip_transactions(transaction_type);

-- ─── House Rake Tracking ─────────────────────────────────────────────────────

CREATE TABLE house_rake (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id UUID REFERENCES poker_tables(id),
    hand_pot BIGINT NOT NULL,
    rake_amount BIGINT NOT NULL,
    rake_percent NUMERIC(4,2) DEFAULT 3.00,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ─── NFT Records ─────────────────────────────────────────────────────────────

CREATE TABLE nft_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    nft_index BIGINT,
    nft_address VARCHAR(255),
    chips_amount BIGINT NOT NULL,
    status VARCHAR(20) DEFAULT 'minted',
    minted_at TIMESTAMP DEFAULT NOW(),
    redeemed_at TIMESTAMP,
    sold_ton_amount NUMERIC(18,9),
    royalty_paid NUMERIC(18,9)
);

-- ─── Referral Earnings ───────────────────────────────────────────────────────

CREATE TABLE referral_earnings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    referrer_id UUID REFERENCES users(id),
    referred_id UUID REFERENCES users(id),
    chips_earned BIGINT NOT NULL,
    source_transaction UUID REFERENCES chip_transactions(id),
    earned_at TIMESTAMP DEFAULT NOW()
);

-- ─── Tips ────────────────────────────────────────────────────────────────────

CREATE TABLE tips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_user_id UUID REFERENCES users(id),
    to_user_id UUID REFERENCES users(id),
    amount BIGINT NOT NULL,
    table_id UUID REFERENCES poker_tables(id),
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_tips_from ON tips(from_user_id);
CREATE INDEX idx_tips_to ON tips(to_user_id);

-- ─── Card Indicator Purchases ────────────────────────────────────────────────

CREATE TABLE indicator_purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    chips_spent INTEGER DEFAULT 500,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Notifications ───────────────────────────────────────────────────────────

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    title VARCHAR(255),
    message TEXT,
    type VARCHAR(50),
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Broadcasts ──────────────────────────────────────────────────────────────

CREATE TABLE broadcasts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255),
    message TEXT,
    target VARCHAR(50) DEFAULT 'all',
    sent_at TIMESTAMP DEFAULT NOW(),
    admin_id VARCHAR(255)
);

-- ─── Revenue Pool ────────────────────────────────────────────────────────────

CREATE TABLE revenue_pool (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    period_start TIMESTAMP,
    period_end TIMESTAMP,
    total_amount BIGINT,
    distributed BOOLEAN DEFAULT false,
    distributed_at TIMESTAMP
);

-- ─── Leaderboard View ────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW leaderboard_weekly AS
SELECT
    u.id, u.telegram_id, u.username, u.first_name, u.photo_url, u.level,
    COALESCE(SUM(ct.amount), 0) as weekly_chips,
    u.total_wins, u.total_hands,
    CASE WHEN u.total_hands > 0
         THEN ROUND(u.total_wins::numeric / u.total_hands * 100, 1)
         ELSE 0 END as win_rate
FROM users u
LEFT JOIN chip_transactions ct ON ct.user_id = u.id
    AND ct.transaction_type = 'game_win'
    AND ct.created_at >= NOW() - INTERVAL '7 days'
WHERE u.is_bot IS NOT TRUE
GROUP BY u.id, u.telegram_id, u.username, u.first_name, u.photo_url,
         u.level, u.total_wins, u.total_hands
ORDER BY weekly_chips DESC;

-- ─── Functions & Triggers ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS TRIGGER AS $$
BEGIN
    NEW.referral_code := UPPER(SUBSTRING(MD5(NEW.telegram_id::TEXT || NOW()::TEXT || random()::TEXT) FROM 1 FOR 8));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_referral_code
    BEFORE INSERT ON users
    FOR EACH ROW
    EXECUTE FUNCTION generate_referral_code();

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION check_influencer_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.total_referrals >= 50 AND NEW.level >= 15 THEN
        NEW.is_influencer := true;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_influencer
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION check_influencer_status();
