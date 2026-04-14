// routes/admin.js — v2 with Task Push via Socket.io

const express = require('express');
const router = express.Router();

function adminOnly(req, res, next) {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (process.env.NODE_ENV === 'development') return next(); // dev bypass
    if (!adminId || req.user.telegramId.toString() !== adminId.toString()) {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
}

module.exports = function(db, activeTables, io) {

    // ─── Dashboard ────────────────────────────────────────────────────────────

    router.get('/stats', adminOnly, async (req, res) => {
        const [users, active, chips, topRef] = await Promise.all([
            db.query('SELECT COUNT(*) as count FROM users WHERE is_bot IS NOT TRUE'),
            db.query("SELECT COUNT(*) as count FROM users WHERE updated_at > NOW() - INTERVAL '24 hours' AND is_bot IS NOT TRUE"),
            db.query('SELECT SUM(chips) as total, SUM(premium_chips) as premium FROM users WHERE is_bot IS NOT TRUE'),
            db.query('SELECT username, first_name, total_referrals FROM users WHERE is_bot IS NOT TRUE ORDER BY total_referrals DESC LIMIT 1'),
        ]);
        res.json({
            totalUsers: parseInt(users.rows[0].count),
            activeToday: parseInt(active.rows[0].count),
            totalChips: parseInt(chips.rows[0].total || 0),
            totalPremiumChips: parseInt(chips.rows[0].premium || 0),
            topReferrer: topRef.rows[0] || null,
            activeTables: activeTables.size,
        });
    });

    // ─── Users ────────────────────────────────────────────────────────────────

    router.get('/users', adminOnly, async (req, res) => {
        const { search = '', page = 1, limit = 20, filter = 'all' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let where = 'WHERE (is_bot IS NOT TRUE)';
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            where += ` AND (username ILIKE $${params.length} OR first_name ILIKE $${params.length} OR telegram_id::text LIKE $${params.length})`;
        }
        if (filter === 'influencer') where += ' AND is_influencer = true';
        if (filter === 'early') where += ' AND is_early_access = true';
        if (filter === 'banned') where += ' AND is_banned = true';

        params.push(limit, offset);
        const users = await db.query(
            `SELECT id, telegram_id, username, first_name, chips, premium_chips, level, xp,
                    total_referrals, total_hands, total_wins, is_early_access, is_influencer,
                    is_banned, ton_wallet, referral_code, created_at
             FROM users ${where}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        const total = await db.query(`SELECT COUNT(*) FROM users ${where}`, params.slice(0, -2));
        res.json({ users: users.rows, total: parseInt(total.rows[0].count) });
    });

    router.get('/users/:id', adminOnly, async (req, res) => {
        const user = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
        if (!user.rows.length) return res.status(404).json({ error: 'Not found' });
        const txns = await db.query(
            'SELECT * FROM chip_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [req.params.id]
        );
        res.json({ user: user.rows[0], transactions: txns.rows });
    });

    router.patch('/users/:id', adminOnly, async (req, res) => {
        const { chips, premium_chips, level, xp, is_early_access, is_influencer, is_banned } = req.body;
        const fields = [], values = [];
        if (chips !== undefined) { fields.push(`chips=$${fields.length+1}`); values.push(chips); }
        if (premium_chips !== undefined) { fields.push(`premium_chips=$${fields.length+1}`); values.push(premium_chips); }
        if (level !== undefined) { fields.push(`level=$${fields.length+1}`); values.push(level); }
        if (xp !== undefined) { fields.push(`xp=$${fields.length+1}`); values.push(xp); }
        if (is_early_access !== undefined) { fields.push(`is_early_access=$${fields.length+1}`); values.push(is_early_access); }
        if (is_influencer !== undefined) { fields.push(`is_influencer=$${fields.length+1}`); values.push(is_influencer); }
        if (is_banned !== undefined) { fields.push(`is_banned=$${fields.length+1}`); values.push(is_banned); }
        if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
        values.push(req.params.id);
        const r = await db.query(
            `UPDATE users SET ${fields.join(',')}, updated_at=NOW() WHERE id=$${values.length} RETURNING *`, values
        );
        res.json(r.rows[0]);
    });

    router.delete('/users/:id', adminOnly, async (req, res) => {
        await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    });

    router.post('/users/:id/ban', adminOnly, async (req, res) => {
        const { banned } = req.body;
        await db.query('UPDATE users SET is_banned = $1 WHERE id = $2', [banned, req.params.id]);
        res.json({ success: true });
    });

    router.post('/users/:id/chips', adminOnly, async (req, res) => {
        const { amount, chips_type = 'chips', reason = 'Admin grant' } = req.body;
        const field = chips_type === 'premium_chips' ? 'premium_chips' : 'chips';
        await db.query(`UPDATE users SET ${field} = ${field} + $1 WHERE id = $2`, [amount, req.params.id]);
        await db.query(
            `INSERT INTO chip_transactions (user_id, amount, chips_type, transaction_type, description)
             VALUES ($1,$2,$3,'admin_adjust',$4)`,
            [req.params.id, amount, chips_type, reason]
        );
        res.json({ success: true });
    });

    // Airdrop to all real users
    router.post('/users/chips/all', adminOnly, async (req, res) => {
        const { amount, chips_type = 'chips', reason = 'Airdrop' } = req.body;
        const field = chips_type === 'premium_chips' ? 'premium_chips' : 'chips';
        const users = await db.query('SELECT id FROM users WHERE (is_banned IS NOT TRUE) AND (is_bot IS NOT TRUE)');
        for (const u of users.rows) {
            await db.query(`UPDATE users SET ${field} = ${field} + $1 WHERE id = $2`, [amount, u.id]);
            await db.query(
                `INSERT INTO chip_transactions (user_id, amount, chips_type, transaction_type, description)
                 VALUES ($1,$2,$3,'admin_adjust',$4)`,
                [u.id, amount, chips_type, reason]
            );
        }
        res.json({ success: true, usersAffected: users.rows.length });
    });

    // ─── Tasks ────────────────────────────────────────────────────────────────

    router.get('/tasks', adminOnly, async (req, res) => {
        const tasks = await db.query('SELECT * FROM tasks ORDER BY sort_order, created_at');
        res.json(tasks.rows);
    });

    // Create task AND push to all connected users
    router.post('/tasks', adminOnly, async (req, res) => {
        const { title, description, task_type, chips_reward, xp_reward,
                action_type, action_value, action_url, sort_order } = req.body;

        const task = await db.query(
            `INSERT INTO tasks (title, description, task_type, chips_reward, xp_reward,
                                action_type, action_value, action_url, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [title, description, task_type, chips_reward, xp_reward,
             action_type, action_value, action_url, sort_order || 99]
        );

        // 🔴 PUSH to all connected users instantly
        io.to('task_updates').emit('new_task', {
            task: task.rows[0],
            message: `🆕 New Task: ${title} — Earn ${chips_reward?.toLocaleString()} chips!`
        });

        res.json(task.rows[0]);
    });

    router.patch('/tasks/:id', adminOnly, async (req, res) => {
        const { title, description, chips_reward, xp_reward, is_active, sort_order, action_value } = req.body;
        const fields = [], values = [];
        if (title !== undefined) { fields.push(`title=$${fields.length+1}`); values.push(title); }
        if (description !== undefined) { fields.push(`description=$${fields.length+1}`); values.push(description); }
        if (chips_reward !== undefined) { fields.push(`chips_reward=$${fields.length+1}`); values.push(chips_reward); }
        if (xp_reward !== undefined) { fields.push(`xp_reward=$${fields.length+1}`); values.push(xp_reward); }
        if (is_active !== undefined) { fields.push(`is_active=$${fields.length+1}`); values.push(is_active); }
        if (sort_order !== undefined) { fields.push(`sort_order=$${fields.length+1}`); values.push(sort_order); }
        if (action_value !== undefined) { fields.push(`action_value=$${fields.length+1}`); values.push(action_value); }
        if (!fields.length) return res.status(400).json({ error: 'Nothing' });
        values.push(req.params.id);
        const r = await db.query(
            `UPDATE tasks SET ${fields.join(',')} WHERE id=$${values.length} RETURNING *`, values
        );
        res.json(r.rows[0]);
    });

    router.delete('/tasks/:id', adminOnly, async (req, res) => {
        await db.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    });

    // ─── Tables ───────────────────────────────────────────────────────────────

    router.get('/tables', adminOnly, async (req, res) => {
        const tables = await db.query('SELECT * FROM poker_tables ORDER BY big_blind');
        res.json(tables.rows.map(t => ({ ...t, live_players: activeTables.get(t.id)?.players?.size || 0 })));
    });

    router.post('/tables', adminOnly, async (req, res) => {
        const { name, min_buy_in, max_buy_in, small_blind, big_blind, max_players, chips_type } = req.body;
        const table = await db.query(
            `INSERT INTO poker_tables (name, min_buy_in, max_buy_in, small_blind, big_blind, max_players, chips_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [name, min_buy_in, max_buy_in, small_blind, big_blind, max_players || 6, chips_type || 'chips']
        );
        res.json(table.rows[0]);
    });

    router.patch('/tables/:id', adminOnly, async (req, res) => {
        const { name, status, min_buy_in, max_buy_in } = req.body;
        const fields = [], values = [];
        if (name !== undefined) { fields.push(`name=$${fields.length+1}`); values.push(name); }
        if (status !== undefined) { fields.push(`status=$${fields.length+1}`); values.push(status); }
        if (min_buy_in !== undefined) { fields.push(`min_buy_in=$${fields.length+1}`); values.push(min_buy_in); }
        if (max_buy_in !== undefined) { fields.push(`max_buy_in=$${fields.length+1}`); values.push(max_buy_in); }
        values.push(req.params.id);
        const r = await db.query(`UPDATE poker_tables SET ${fields.join(',')} WHERE id=$${values.length} RETURNING *`, values);
        res.json(r.rows[0]);
    });

    router.delete('/tables/:id', adminOnly, async (req, res) => {
        await db.query('DELETE FROM poker_tables WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    });

    // ─── Broadcast ────────────────────────────────────────────────────────────

    router.post('/broadcast', adminOnly, async (req, res) => {
        const { title, message, target = 'all' } = req.body;
        await db.query(
            'INSERT INTO broadcasts (title, message, target, admin_id) VALUES ($1,$2,$3,$4)',
            [title, message, target, req.user.telegramId]
        );
        let q = 'SELECT id FROM users WHERE is_banned IS NOT TRUE AND is_bot IS NOT TRUE';
        if (target === 'level_10_plus') q += ' AND level >= 10';
        if (target === 'influencers') q += ' AND is_influencer = true';
        if (target === 'early_access') q += ' AND is_early_access = true';
        const users = await db.query(q);
        for (const u of users.rows) {
            await db.query(
                "INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'system')",
                [u.id, title, message]
            );
        }
        // Push via socket
        io.to('task_updates').emit('broadcast', { title, message });
        res.json({ success: true, sent: users.rows.length });
    });

    return router;
};
