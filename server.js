const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
        ? false : { rejectUnauthorized: false }
});

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.set('trust proxy', 1);
app.use(session({
    store: new PgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'sixseven-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: false
    }
}));

// Serve uploads and static files
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('uploads/avatars')) fs.mkdirSync('uploads/avatars');
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const PANIC_KEY_SNIPPET = `<script>(function(){
var CLOAKS={schoology:{title:'Home | Schoology',icon:'https://asset-cdn.schoology.com/sites/all/themes/schoology_theme/favicon.ico'},iready:{title:'i-Ready',icon:'https://www.curriculumassociates.com/favicon.ico'},ixl:{title:'IXL | Math, Language Arts, Science, Social Studies, and Spanish',icon:'https://www.ixl.com/favicon.ico'},clever:{title:'Clever | Log in',icon:'https://www.google.com/s2/favicons?domain=clever.com&sz=64'}};
function setFavicon(u){var l=document.querySelector("link[rel~='icon']");if(!l){l=document.createElement('link');l.rel='icon';(document.head||document.body).appendChild(l);}l.href=u;}
function applyCloak(){var t=localStorage.getItem('cloakType');if(t==='custom'){var ct=localStorage.getItem('customCloakTitle');var ci=localStorage.getItem('customCloakIcon');if(ct)document.title=ct;if(ci)setFavicon(ci);}else if(t&&CLOAKS[t]){document.title=CLOAKS[t].title;setFavicon(CLOAKS[t].icon);}}
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',applyCloak);}else{applyCloak();}
document.addEventListener('keydown',function(e){var k=localStorage.getItem('panicKey');var u=localStorage.getItem('panicUrl');if(!k||!u)return;var a=document.activeElement;var t=a?a.tagName:'';if(t==='INPUT'||t==='TEXTAREA'||(a&&a.isContentEditable))return;if(e.key===k){e.preventDefault();window.location.href=u;}});
})();<\/script>`;

app.use('/games', function(req, res, next) {
    if (!req.path.endsWith('.html')) return next();
    const filePath = path.join(__dirname, 'games', req.path);
    fs.readFile(filePath, 'utf8', function(err, data) {
        if (err) return next();
        const injected = data.includes('</body>')
            ? data.replace('</body>', PANIC_KEY_SNIPPET + '</body>')
            : data + PANIC_KEY_SNIPPET;
        res.setHeader('Content-Type', 'text/html');
        res.send(injected);
    });
});

app.get('/admin.html', async (req, res) => {
    if (!req.session.username) return res.status(401).send('Sign in through Chat to open the developer admin panel.');
    if (!(await checkIsStaff(req.session.username))) return res.status(403).send('Developer admin access required.');
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(path.join(__dirname)));

// ─── File Upload Setup ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, uuidv4() + ext);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowed = /image\/(jpeg|jpg|png|gif|webp)|video\/(mp4|webm|ogg)/;
        if (allowed.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only images and videos allowed.'));
    }
});

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/avatars/'),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, uuidv4() + ext);
    }
});
const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (/image\/(jpeg|jpg|png|gif|webp)/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files allowed for avatars.'));
    }
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (req.session.username) return next();
    res.status(401).json({ error: 'Not logged in.' });
}

async function requireStaff(req, res, next) {
    if (!req.session.username) return res.status(401).json({ error: 'Not logged in.' });
    if (!(await checkIsStaff(req.session.username))) {
        return res.status(403).json({ error: 'Staff only.' });
    }
    next();
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    if (username.length < 2 || username.length > 30) return res.status(400).json({ error: 'Username must be 2-30 characters.' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores.' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

    try {
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hash]);
        req.session.username = username;
        res.json({ success: true, username });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Username already taken.' });
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid username or password.' });
        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid username or password.' });
        req.session.username = user.username;
        res.json({ success: true, username: user.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
    if (!req.session.username) return res.status(401).json({ error: 'Not logged in.' });
    const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [req.session.username]).catch(() => ({ rows: [] }));
    res.json({ username: req.session.username, isStaff: staffRes.rows.length > 0 });
});

// ─── Change Username ───────────────────────────────────────────────────────────
app.post('/api/change-username', requireAuth, async (req, res) => {
    const { newUsername } = req.body;
    const current = req.session.username;
    if (!newUsername || typeof newUsername !== 'string') return res.status(400).json({ error: 'New username required.' });
    const clean = newUsername.trim();
    if (clean.length < 3 || clean.length > 30) return res.status(400).json({ error: 'Username must be 3–30 characters.' });
    if (!/^[a-zA-Z0-9_]+$/.test(clean)) return res.status(400).json({ error: 'Only letters, numbers, and underscores allowed.' });

    try {
        const userRes = await pool.query('SELECT last_credential_change FROM users WHERE LOWER(username) = LOWER($1)', [current]);
        if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });
        const lastChange = userRes.rows[0].last_credential_change;
        if (lastChange) {
            const daysSince = (Date.now() - new Date(lastChange).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince < 7) {
                const daysLeft = Math.ceil(7 - daysSince);
                return res.status(429).json({ error: `You can only change your credentials once a week. Try again in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.` });
            }
        }
        // Check not taken
        const taken = await pool.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [clean]);
        if (taken.rows.length) return res.status(409).json({ error: 'That username is already taken.' });

        await pool.query('UPDATE users SET username = $1, last_credential_change = NOW() WHERE LOWER(username) = LOWER($2)', [clean, current]);
        // Keep staff row in sync (case-insensitive match)
        await pool.query('UPDATE staff SET username = $1 WHERE LOWER(username) = LOWER($2)', [clean, current]);
        await pool.query('UPDATE room_owners SET owner_username = $1 WHERE LOWER(owner_username) = LOWER($2)', [clean, current]);

        req.session.username = clean;
        req.session.save();
        res.json({ success: true, newUsername: clean });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
        res.status(500).json({ error: 'Server error.' });
    }
});

// ─── Change Password ───────────────────────────────────────────────────────────
app.post('/api/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const username = req.session.username;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

    try {
        const userRes = await pool.query('SELECT password_hash, last_credential_change FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });

        const lastChange = userRes.rows[0].last_credential_change;
        if (lastChange) {
            const daysSince = (Date.now() - new Date(lastChange).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince < 7) {
                const daysLeft = Math.ceil(7 - daysSince);
                return res.status(429).json({ error: `You can only change your credentials once a week. Try again in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.` });
            }
        }

        const match = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
        if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

        const hash = await bcrypt.hash(newPassword, 12);
        await pool.query('UPDATE users SET password_hash = $1, last_credential_change = NOW() WHERE LOWER(username) = LOWER($2)', [hash, username]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// ─── Online Count ─────────────────────────────────────────────────────────────
app.get('/api/online-count', (req, res) => {
    res.json({ count: onlineUsers.size });
});

// ─── Room History ─────────────────────────────────────────────────────────────
app.get('/api/room-history', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT room_code, last_joined FROM room_history
             WHERE username = $1
             ORDER BY last_joined DESC LIMIT 8`,
            [req.session.username]
        );
        res.json({ rooms: result.rows });
    } catch (err) { res.status(500).json({ rooms: [] }); }
});

app.get('/api/chat-info', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT key, value FROM site_settings WHERE key IN ('chat_motd', 'chat_rules')"
        );
        const info = { motd: '', rules: '' };
        result.rows.forEach(row => {
            if (row.key === 'chat_motd') info.motd = row.value;
            if (row.key === 'chat_rules') info.rules = row.value;
        });
        res.json(info);
    } catch (err) {
        res.json({ motd: '', rules: '' });
    }
});

// ─── Staff Admin Settings ────────────────────────────────────────────────────
const ADMIN_SETTING_KEYS = new Set([
    'announcement',
    'notice',
    'notice_id',
    'chat_motd',
    'chat_rules'
]);

app.get('/api/admin/settings', requireStaff, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT key, value, updated_at FROM site_settings WHERE key = ANY($1::text[])',
            [Array.from(ADMIN_SETTING_KEYS)]
        );
        const settings = {};
        result.rows.forEach(row => {
            settings[row.key] = { value: row.value, updatedAt: row.updated_at };
        });
        res.json({
            username: req.session.username,
            settings
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load admin settings.' });
    }
});

app.put('/api/admin/settings/:key', requireStaff, async (req, res) => {
    const key = req.params.key;
    if (!ADMIN_SETTING_KEYS.has(key)) {
        return res.status(400).json({ error: 'That setting cannot be changed here.' });
    }

    const value = typeof req.body.value === 'string' ? req.body.value.trim() : '';
    const limit = key === 'notice' ? 500 : key === 'chat_rules' ? 5000 : 300;
    if (value.length > limit) {
        return res.status(400).json({ error: `This setting is limited to ${limit} characters.` });
    }

    try {
        if (!value && (key === 'notice' || key === 'notice_id')) {
            await pool.query('DELETE FROM site_settings WHERE key = $1', [key]);
            return res.json({ success: true, key, value: '' });
        }

        await pool.query(
            `INSERT INTO site_settings (key, value)
             VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, value]
        );
        res.json({ success: true, key, value });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save setting.' });
    }
});

app.post('/api/admin/notice', requireStaff, async (req, res) => {
    const value = typeof req.body.value === 'string' ? req.body.value.trim().slice(0, 500) : '';
    try {
        if (!value) {
            await pool.query("DELETE FROM site_settings WHERE key IN ('notice', 'notice_id')");
            return res.json({ success: true, value: '', id: '' });
        }
        const id = Date.now().toString();
        await pool.query(
            `INSERT INTO site_settings (key, value) VALUES ('notice', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [value]
        );
        await pool.query(
            `INSERT INTO site_settings (key, value) VALUES ('notice_id', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [id]
        );
        res.json({ success: true, value, id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to save notice.' });
    }
});

// ─── Announcement ─────────────────────────────────────────────────────────────
const ANNOUNCE_DEFAULT = '📢 Welcome to 67 Unblocked Games!';

app.get('/api/announcement', async (req, res) => {
    try {
        const r = await pool.query("SELECT value FROM site_settings WHERE key='announcement'");
        res.json({ text: r.rows.length ? r.rows[0].value : ANNOUNCE_DEFAULT });
    } catch(err) { res.json({ text: ANNOUNCE_DEFAULT }); }
});

app.post('/api/announcement', requireStaff, async (req, res) => {
    const { text } = req.body;
    const safe = (text || '').trim().slice(0, 300);
    if (!safe) return res.status(400).json({ error: 'Text required.' });
    try {
        await pool.query(
            `INSERT INTO site_settings (key, value) VALUES ('announcement', $1)
             ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
            [safe]
        );
        res.json({ success: true, text: safe });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Critical Notice ──────────────────────────────────────────────────────────
app.get('/api/notice', async (req, res) => {
    try {
        const r  = await pool.query("SELECT value FROM site_settings WHERE key='notice'");
        const id = await pool.query("SELECT value FROM site_settings WHERE key='notice_id'");
        const text = r.rows.length ? r.rows[0].value : '';
        const nid  = id.rows.length ? id.rows[0].value : '';
        res.json({ text, id: nid });
    } catch(err) { res.json({ text: '', id: '' }); }
});

app.post('/api/notice', requireStaff, async (req, res) => {
    const { text } = req.body;
    const safe = (text || '').trim().slice(0, 500);
    try {
        if (!safe) {
            await pool.query("DELETE FROM site_settings WHERE key='notice'");
            await pool.query("DELETE FROM site_settings WHERE key='notice_id'");
            return res.json({ success: true, text: '', id: '' });
        }
        const nid = Date.now().toString();
        await pool.query(
            `INSERT INTO site_settings (key,value) VALUES ('notice',$1) ON CONFLICT (key) DO UPDATE SET value=$1,updated_at=NOW()`,
            [safe]
        );
        await pool.query(
            `INSERT INTO site_settings (key,value) VALUES ('notice_id',$1) ON CONFLICT (key) DO UPDATE SET value=$1,updated_at=NOW()`,
            [nid]
        );
        res.json({ success: true, text: safe, id: nid });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Staff List ───────────────────────────────────────────────────────────────
app.get('/api/staff', async (req, res) => {
    try {
        const result = await pool.query('SELECT username FROM staff ORDER BY created_at');
        res.json(result.rows.map(r => r.username));
    } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Assign Staff (staff only) ────────────────────────────────────────────────
app.post('/api/staff/assign', requireAuth, async (req, res) => {
    const caller = req.session.username;
    const target = (req.body.username || '').trim();
    if (!target) return res.status(400).json({ error: 'No username provided.' });
    try {
        const callerIsStaff = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!callerIsStaff.rows.length) return res.status(403).json({ error: 'Only staff can assign staff.' });
        const userExists = await pool.query('SELECT 1 FROM users WHERE username = $1', [target]);
        if (!userExists.rows.length) return res.status(404).json({ error: `User "${target}" does not exist.` });
        await pool.query('INSERT INTO staff (username, assigned_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [target, caller]);
        res.json({ success: true, message: `${target} is now staff.` });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── All Rooms (staff only) ───────────────────────────────────────────────────
app.get('/api/staff/rooms', requireAuth, async (req, res) => {
    const caller = req.session.username;
    try {
        const callerIsStaff = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!callerIsStaff.rows.length) return res.status(403).json({ error: 'Only staff can view all rooms.' });
        const result = await pool.query(`
            SELECT
                ro.room_code,
                ro.owner_username,
                ro.created_at,
                COALESCE(mc.message_count, 0)::int AS message_count,
                mc.last_message_at
            FROM room_owners ro
            LEFT JOIN (
                SELECT room_code,
                       COUNT(*)        AS message_count,
                       MAX(created_at) AS last_message_at
                FROM chat_messages
                GROUP BY room_code
            ) mc ON mc.room_code = ro.room_code
            ORDER BY ro.created_at DESC
        `);
        const liveCounts = {};
        rooms.forEach((room, code) => { liveCounts[code] = room.clients.size; });
        const out = result.rows.map(r => ({
            room_code:       r.room_code,
            owner:           r.owner_username,
            created_at:      r.created_at,
            message_count:   r.message_count,
            last_message_at: r.last_message_at,
            online_count:    liveCounts[r.room_code] || 0
        }));
        res.json(out);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Unassign Staff (staff only) ──────────────────────────────────────────────
app.post('/api/staff/unassign', requireAuth, async (req, res) => {
    const caller = req.session.username;
    const target = (req.body.username || '').trim();
    if (!target) return res.status(400).json({ error: 'No username provided.' });
    try {
        const callerIsStaff = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!callerIsStaff.rows.length) return res.status(403).json({ error: 'Only staff can remove staff.' });
        if (target.toLowerCase() === 'loafyen') return res.status(403).json({ error: 'Cannot remove the owner from staff.' });
        const result = await pool.query('DELETE FROM staff WHERE LOWER(username) = LOWER($1) RETURNING username', [target]);
        if (!result.rows.length) return res.status(404).json({ error: `"${target}" is not staff.` });
        res.json({ success: true, message: `${result.rows[0].username} is no longer staff.` });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── File Upload Route ────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    res.json({
        url: `/uploads/${req.file.filename}`,
        mediaType
    });
});

// ─── Chat Message History ─────────────────────────────────────────────────────
app.get('/api/messages/:roomCode', async (req, res) => {
    const roomCode = req.params.roomCode.toUpperCase();
    try {
        const result = await pool.query(
            `SELECT cm.id, cm.username, cm.message, cm.media_url, cm.media_type,
                    cm.reply_to_username, cm.reply_to_message, cm.created_at,
                    u.avatar_url
             FROM chat_messages cm
             LEFT JOIN users u ON LOWER(u.username)=LOWER(cm.username)
             WHERE cm.room_code = $1 
             ORDER BY cm.created_at DESC LIMIT 80`,
            [roomCode]
        );
        res.json(result.rows.reverse());
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load messages.' });
    }
});

// ─── Create Room (registers owner in DB before anyone joins) ──────────────────
app.post('/api/create-room', requireAuth, async (req, res) => {
    let roomCode = ((req.body.roomCode || '').trim().toUpperCase()) || null;
    if (!roomCode) {
        roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    }
    if (!/^[A-Z0-9]{2,20}$/.test(roomCode)) {
        return res.status(400).json({ error: 'Room code must be 2-20 letters/numbers.' });
    }
    try {
        const existing = await pool.query('SELECT owner_username FROM room_owners WHERE room_code = $1', [roomCode]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: `Room "${roomCode}" already exists. Choose a different code.` });
        }
        await pool.query('INSERT INTO room_owners (room_code, owner_username) VALUES ($1, $2)', [roomCode, req.session.username]);
        res.json({ roomCode, owner: req.session.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ─── Ban List (owner only) ────────────────────────────────────────────────────
app.get('/api/room/:roomCode/bans', requireAuth, async (req, res) => {
    const roomCode = req.params.roomCode.toUpperCase();
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code = $1', [roomCode]);
        if (!ownerRes.rows.length || ownerRes.rows[0].owner_username !== req.session.username) {
            return res.status(403).json({ error: 'Only the room owner can view the ban list.' });
        }
        const bans = await pool.query(
            'SELECT banned_username FROM room_bans WHERE room_code = $1 ORDER BY id DESC',
            [roomCode]
        );
        res.json(bans.rows.map(r => r.banned_username));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ─── Room Owner Check ─────────────────────────────────────────────────────────
app.get('/api/room/:roomCode/owner', async (req, res) => {
    const roomCode = req.params.roomCode.toUpperCase();
    try {
        const result = await pool.query('SELECT owner_username FROM room_owners WHERE room_code = $1', [roomCode]);
        res.json({ owner: result.rows[0]?.owner_username || null });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

// ─── DM Conversations List ────────────────────────────────────────────────────
app.get('/api/dm/conversations', requireAuth, async (req, res) => {
    const me = req.session.username;
    try {
        const result = await pool.query(`
            SELECT
                CASE WHEN from_username = $1 THEN to_username ELSE from_username END AS other_user,
                MAX(created_at) AS last_at,
                COALESCE(COUNT(*) FILTER (WHERE to_username = $1 AND NOT is_read), 0)::int AS unread
            FROM direct_messages
            WHERE from_username = $1 OR to_username = $1
            GROUP BY other_user
            ORDER BY last_at DESC
        `, [me]);
        res.json(result.rows);
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── DM History with a User ───────────────────────────────────────────────────
app.get('/api/dm/:username', requireAuth, async (req, res) => {
    const me    = req.session.username;
    const other = req.params.username;
    try {
        const blockRes = await pool.query(
            'SELECT blocker_username FROM user_blocks WHERE (blocker_username=$1 AND blocked_username=$2) OR (blocker_username=$2 AND blocked_username=$1)',
            [me, other]
        );
        if (blockRes.rows.length > 0) {
            return res.status(403).json({ error: 'blocked', blocker: blockRes.rows[0].blocker_username });
        }
        const msgs = await pool.query(`
            SELECT id, from_username, to_username, message, media_url, media_type, is_read, created_at
            FROM direct_messages
            WHERE (from_username=$1 AND to_username=$2) OR (from_username=$2 AND to_username=$1)
            ORDER BY created_at ASC LIMIT 200
        `, [me, other]);
        await pool.query(
            'UPDATE direct_messages SET is_read=TRUE WHERE to_username=$1 AND from_username=$2 AND NOT is_read',
            [me, other]
        );
        res.json(msgs.rows);
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Block a User ─────────────────────────────────────────────────────────────
app.post('/api/block/:username', requireAuth, async (req, res) => {
    const me = req.session.username, target = req.params.username;
    if (me === target) return res.status(400).json({ error: 'Cannot block yourself.' });
    try {
        await pool.query(
            'INSERT INTO user_blocks (blocker_username, blocked_username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [me, target]
        );
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Unblock a User ───────────────────────────────────────────────────────────
app.delete('/api/block/:username', requireAuth, async (req, res) => {
    const me = req.session.username, target = req.params.username;
    try {
        await pool.query(
            'DELETE FROM user_blocks WHERE blocker_username=$1 AND blocked_username=$2',
            [me, target]
        );
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── My Block List ────────────────────────────────────────────────────────────
app.get('/api/blocks', requireAuth, async (req, res) => {
    const me = req.session.username;
    try {
        const result = await pool.query('SELECT blocked_username FROM user_blocks WHERE blocker_username=$1', [me]);
        res.json(result.rows.map(r => r.blocked_username));
    } catch(err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Report a Room ────────────────────────────────────────────────────────────
app.post('/api/room/:roomCode/report', requireAuth, async (req, res) => {
    const reporter = req.session.username;
    const roomCode = req.params.roomCode.toUpperCase();
    const reason   = (req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Reason required.' });
    try {
        await pool.query(
            'INSERT INTO room_reports (room_code, reporter_username, reason) VALUES ($1, $2, $3)',
            [roomCode, reporter, reason]
        );
        res.json({ success: true });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Get Reports (staff only) ─────────────────────────────────────────────────
app.get('/api/reports', requireAuth, async (req, res) => {
    const caller = req.session.username;
    try {
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!staffRes.rows.length) return res.status(403).json({ error: 'Staff only.' });
        const result = await pool.query(
            `SELECT id, room_code, reporter_username, reason, resolved, created_at
             FROM room_reports ORDER BY resolved ASC, created_at DESC LIMIT 100`
        );
        res.json(result.rows);
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Resolve Report (staff only) ──────────────────────────────────────────────
app.post('/api/reports/:id/resolve', requireAuth, async (req, res) => {
    const caller = req.session.username;
    const id = parseInt(req.params.id, 10);
    try {
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!staffRes.rows.length) return res.status(403).json({ error: 'Staff only.' });
        await pool.query('UPDATE room_reports SET resolved=TRUE WHERE id=$1', [id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Delete a Room (owner or staff) ───────────────────────────────────────────
app.delete('/api/room/:roomCode', requireAuth, async (req, res) => {
    const caller   = req.session.username;
    const roomCode = req.params.roomCode.toUpperCase();
    try {
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code = $1', [roomCode]);
        const isOwner  = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const isStaff  = staffRes.rows.length > 0;
        if (!isOwner && !isStaff) return res.status(403).json({ error: 'Not authorised.' });

        await pool.query('DELETE FROM chat_messages WHERE room_code = $1', [roomCode]);
        await pool.query('DELETE FROM room_bans    WHERE room_code = $1', [roomCode]);
        await pool.query('DELETE FROM room_reports WHERE room_code = $1', [roomCode]);
        await pool.query('DELETE FROM room_owners  WHERE room_code = $1', [roomCode]);

        res.json({ success: true });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Report a User ────────────────────────────────────────────────────────────
app.post('/api/user/:username/report', requireAuth, async (req, res) => {
    const reporter  = req.session.username;
    const reported  = req.params.username.trim().slice(0, 30);
    const reason    = (req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ error: 'Reason required.' });
    if (reporter === reported) return res.status(400).json({ error: 'Cannot report yourself.' });
    try {
        const exists = await pool.query('SELECT 1 FROM users WHERE username=$1', [reported]);
        if (!exists.rows.length) return res.status(404).json({ error: 'User not found.' });
        await pool.query(
            'INSERT INTO user_reports (reported_username, reporter_username, reason) VALUES ($1, $2, $3)',
            [reported, reporter, reason]
        );
        res.json({ success: true });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Get User Reports (staff only) ────────────────────────────────────────────
app.get('/api/user-reports', requireAuth, async (req, res) => {
    const caller = req.session.username;
    try {
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!staffRes.rows.length) return res.status(403).json({ error: 'Staff only.' });
        const result = await pool.query(
            `SELECT id, reported_username, reporter_username, reason, resolved, created_at
             FROM user_reports ORDER BY resolved ASC, created_at DESC LIMIT 100`
        );
        res.json(result.rows);
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Resolve User Report (staff only) ─────────────────────────────────────────
app.post('/api/user-reports/:id/resolve', requireAuth, async (req, res) => {
    const caller = req.session.username;
    const id = parseInt(req.params.id, 10);
    try {
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!staffRes.rows.length) return res.status(403).json({ error: 'Staff only.' });
        await pool.query('UPDATE user_reports SET resolved=TRUE WHERE id=$1', [id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Delete Own Account ───────────────────────────────────────────────────────
app.post('/api/delete-own-account', requireAuth, async (req, res) => {
    const username = req.session.username;
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required.' });
    try {
        const userRes = await pool.query('SELECT password_hash FROM users WHERE username=$1', [username]);
        if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });
        const match = await bcrypt.compare(password, userRes.rows[0].password_hash);
        if (!match) return res.status(401).json({ error: 'Incorrect password.' });
        // Wipe all user data
        await pool.query('DELETE FROM chat_messages    WHERE username=$1', [username]);
        await pool.query('DELETE FROM direct_messages  WHERE from_username=$1 OR to_username=$1', [username]);
        await pool.query('DELETE FROM user_blocks      WHERE blocker_username=$1 OR blocked_username=$1', [username]);
        await pool.query('DELETE FROM room_bans        WHERE banned_username=$1', [username]);
        await pool.query('DELETE FROM room_owners      WHERE owner_username=$1', [username]);
        await pool.query('DELETE FROM user_reports     WHERE reported_username=$1 OR reporter_username=$1', [username]);
        await pool.query('DELETE FROM room_reports     WHERE reporter_username=$1', [username]);
        await pool.query('DELETE FROM room_history     WHERE username=$1', [username]);
        await pool.query('DELETE FROM staff            WHERE LOWER(username)=LOWER($1)', [username]);
        await pool.query('DELETE FROM users            WHERE username=$1', [username]);
        req.session.destroy(() => {});
        res.json({ success: true });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── User Profiles ────────────────────────────────────────────────────────────
app.get('/api/profile/:username', async (req, res) => {
    const target = req.params.username;
    try {
        const userRes  = await pool.query('SELECT username, avatar_url, created_at FROM users WHERE LOWER(username)=LOWER($1)', [target]);
        if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username)=LOWER($1)', [target]);
        const row = userRes.rows[0];
        res.json({
            username:  row.username,
            avatarUrl: row.avatar_url || null,
            createdAt: row.created_at,
            isStaff:   staffRes.rows.length > 0
        });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/profile/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const username  = req.session.username;
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    try {
        // Delete old avatar file if present
        const old = await pool.query('SELECT avatar_url FROM users WHERE username=$1', [username]);
        if (old.rows.length && old.rows[0].avatar_url) {
            const oldPath = path.join(__dirname, old.rows[0].avatar_url);
            fs.unlink(oldPath, () => {});
        }
        await pool.query('UPDATE users SET avatar_url=$1 WHERE username=$2', [avatarUrl, username]);
        res.json({ success: true, avatarUrl });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/profile/avatar', requireAuth, async (req, res) => {
    const username = req.session.username;
    try {
        const old = await pool.query('SELECT avatar_url FROM users WHERE username=$1', [username]);
        if (old.rows.length && old.rows[0].avatar_url) {
            const oldPath = path.join(__dirname, old.rows[0].avatar_url);
            fs.unlink(oldPath, () => {});
        }
        await pool.query('UPDATE users SET avatar_url=NULL WHERE username=$1', [username]);
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Delete a User Account (staff only) ───────────────────────────────────────
app.delete('/api/user/:username', requireAuth, async (req, res) => {
    const caller   = req.session.username;
    const target   = req.params.username.trim().slice(0, 30);
    try {
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        if (!staffRes.rows.length) return res.status(403).json({ error: 'Staff only.' });
        if (target === caller) return res.status(400).json({ error: 'Cannot delete your own account.' });
        const userRes = await pool.query('SELECT 1 FROM users WHERE username=$1', [target]);
        if (!userRes.rows.length) return res.status(404).json({ error: 'User not found.' });
        // Clean up all user data
        await pool.query('DELETE FROM chat_messages    WHERE username = $1', [target]);
        await pool.query('DELETE FROM direct_messages  WHERE from_username=$1 OR to_username=$1', [target]);
        await pool.query('DELETE FROM user_blocks      WHERE blocker_username=$1 OR blocked_username=$1', [target]);
        await pool.query('DELETE FROM room_bans        WHERE banned_username=$1', [target]);
        await pool.query('DELETE FROM room_owners      WHERE owner_username=$1', [target]);
        await pool.query('DELETE FROM user_reports     WHERE reported_username=$1 OR reporter_username=$1', [target]);
        await pool.query('DELETE FROM room_reports     WHERE reporter_username=$1', [target]);
        await pool.query('DELETE FROM users            WHERE username=$1', [target]);
        res.json({ success: true });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── Delete a Message (staff or message author) ───────────────────────────────
app.delete('/api/message/:messageId', requireAuth, async (req, res) => {
    const caller    = req.session.username;
    const messageId = parseInt(req.params.messageId, 10);
    try {
        const msgRes = await pool.query('SELECT username, room_code FROM chat_messages WHERE id = $1', [messageId]);
        if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found.' });
        const msg = msgRes.rows[0];

        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [caller]);
        const isStaff   = staffRes.rows.length > 0;
        const isAuthor  = msg.username === caller;
        const canDelRole = await hasRolePermission(caller, msg.room_code, 'can_delete');
        if (!isStaff && !isAuthor && !canDelRole) return res.status(403).json({ error: 'Not authorised.' });

        await pool.query('DELETE FROM chat_messages WHERE id = $1', [messageId]);
        res.json({ success: true, roomCode: msg.room_code, messageId });
    } catch(err) { console.error(err); res.status(500).json({ error: 'Server error.' }); }
});

// ─── HTML File Fallback ───────────────────────────────────────────────────────
app.get('/:file', (req, res) => {
    const filePath = path.join(__dirname, req.params.file);
    if (fs.existsSync(filePath) && filePath.endsWith('.html')) res.sendFile(filePath);
    else res.status(404).send('Not found');
});

// ─── Staff Helper ─────────────────────────────────────────────────────────────
async function checkIsStaff(username) {
    try {
        const res = await pool.query('SELECT 1 FROM staff WHERE LOWER(username) = LOWER($1)', [username]);
        return res.rows.length > 0;
    } catch { return false; }
}

// ─── DB Init ──────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            username      VARCHAR(30) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at    TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id                SERIAL PRIMARY KEY,
            room_code         VARCHAR(20) NOT NULL,
            username          VARCHAR(30) NOT NULL,
            message           TEXT,
            media_url         TEXT,
            media_type        VARCHAR(20),
            reply_to_username VARCHAR(30),
            reply_to_message  TEXT,
            created_at        TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_owners (
            room_code      VARCHAR(20) PRIMARY KEY,
            owner_username VARCHAR(30) NOT NULL,
            created_at     TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_bans (
            room_code VARCHAR(20) NOT NULL,
            username  VARCHAR(30) NOT NULL,
            PRIMARY KEY (room_code, username)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS staff (
            username    VARCHAR(30) PRIMARY KEY,
            assigned_by VARCHAR(30),
            created_at  TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        INSERT INTO staff (username, assigned_by)
        VALUES ('Loafyen', 'THATONETRASHGAMER7976offical')
        ON CONFLICT DO NOTHING
    `);
    // Add cooldown column to existing databases
    await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS last_credential_change TIMESTAMP
    `);
    await pool.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_history (
            username    VARCHAR(30) NOT NULL,
            room_code   VARCHAR(20) NOT NULL,
            last_joined TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (username, room_code)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS direct_messages (
            id SERIAL PRIMARY KEY,
            from_username VARCHAR(30) NOT NULL,
            to_username   VARCHAR(30) NOT NULL,
            message       TEXT,
            media_url     TEXT,
            media_type    VARCHAR(20),
            is_read       BOOLEAN DEFAULT FALSE,
            created_at    TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_blocks (
            blocker_username VARCHAR(30) NOT NULL,
            blocked_username VARCHAR(30) NOT NULL,
            created_at       TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (blocker_username, blocked_username)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_reports (
            id               SERIAL PRIMARY KEY,
            room_code        VARCHAR(20) NOT NULL,
            reporter_username VARCHAR(30) NOT NULL,
            reason           TEXT NOT NULL,
            resolved         BOOLEAN DEFAULT FALSE,
            created_at       TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS site_settings (
            key        VARCHAR(50) PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        INSERT INTO site_settings (key, value) VALUES
            ('chat_motd', 'Welcome to 67UG Chat.'),
            ('chat_rules', 'Be respectful. Do not spam, threaten people, or share personal information.')
        ON CONFLICT (key) DO NOTHING
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_reports (
            id                SERIAL PRIMARY KEY,
            reported_username VARCHAR(30) NOT NULL,
            reporter_username VARCHAR(30) NOT NULL,
            reason            TEXT NOT NULL,
            resolved          BOOLEAN DEFAULT FALSE,
            created_at        TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_roles (
            id                SERIAL PRIMARY KEY,
            room_code         VARCHAR(20) NOT NULL,
            role_name         VARCHAR(30) NOT NULL,
            color             VARCHAR(10) DEFAULT '#888888',
            use_color_for_name BOOLEAN DEFAULT TRUE,
            can_kick          BOOLEAN DEFAULT FALSE,
            can_ban           BOOLEAN DEFAULT FALSE,
            can_delete        BOOLEAN DEFAULT FALSE,
            can_pin           BOOLEAN DEFAULT FALSE,
            can_manage_roles  BOOLEAN DEFAULT FALSE,
            can_mute          BOOLEAN DEFAULT FALSE,
            created_at        TIMESTAMP DEFAULT NOW()
        )
    `);
    // Migrate existing room_roles tables
    await pool.query(`ALTER TABLE room_roles ADD COLUMN IF NOT EXISTS use_color_for_name BOOLEAN DEFAULT TRUE`);
    await pool.query(`ALTER TABLE room_roles ADD COLUMN IF NOT EXISTS can_pin          BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE room_roles ADD COLUMN IF NOT EXISTS can_manage_roles BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE room_roles ADD COLUMN IF NOT EXISTS can_mute         BOOLEAN DEFAULT FALSE`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_role_assignments (
            room_code VARCHAR(20) NOT NULL,
            username  VARCHAR(30) NOT NULL,
            role_id   INT NOT NULL REFERENCES room_roles(id) ON DELETE CASCADE,
            PRIMARY KEY (room_code, username)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pinned_messages (
            id           SERIAL PRIMARY KEY,
            room_code    VARCHAR(20) NOT NULL,
            message_id   INT,
            message_text TEXT,
            author       VARCHAR(30),
            pinned_by    VARCHAR(30),
            pinned_at    TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS room_mutes (
            room_code   VARCHAR(20) NOT NULL,
            username    VARCHAR(30) NOT NULL,
            muted_until TIMESTAMP NOT NULL,
            muted_by    VARCHAR(30),
            PRIMARY KEY (room_code, username)
        )
    `);
}
initDB().catch(console.error);

// ─── Role Permission Helper ───────────────────────────────────────────────────
async function hasRolePermission(username, roomCode, perm) {
    try {
        const r = await pool.query(
            `SELECT rr.${perm} FROM room_role_assignments rra
             JOIN room_roles rr ON rr.id = rra.role_id
             WHERE rra.room_code=$1 AND rra.username=$2`,
            [roomCode, username]
        );
        return r.rows.length > 0 && r.rows[0][perm] === true;
    } catch { return false; }
}

// ─── Room Roles REST Endpoints ────────────────────────────────────────────────
app.get('/api/room/:code/roles', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    try {
        const r = await pool.query('SELECT * FROM room_roles WHERE room_code=$1 ORDER BY id', [roomCode]);
        res.json(r.rows);
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/room/:code/assignments', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    try {
        const r = await pool.query(
            `SELECT rra.username, rra.role_id, rr.role_name, rr.color, rr.can_kick, rr.can_ban, rr.can_delete
             FROM room_role_assignments rra JOIN room_roles rr ON rr.id = rra.role_id
             WHERE rra.room_code=$1`,
            [roomCode]
        );
        res.json(r.rows);
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/room/:code/roles', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const caller = req.session.username;
    const { role_name, color, use_color_for_name, can_kick, can_ban, can_delete, can_pin, can_manage_roles, can_mute } = req.body;
    if (!role_name || !role_name.trim()) return res.status(400).json({ error: 'Role name required.' });
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        if (!ownerRes.rows.length || ownerRes.rows[0].owner_username !== caller)
            return res.status(403).json({ error: 'Only the room owner can manage roles.' });
        const r = await pool.query(
            `INSERT INTO room_roles (room_code, role_name, color, use_color_for_name, can_kick, can_ban, can_delete, can_pin, can_manage_roles, can_mute)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [roomCode, role_name.trim().slice(0, 30), color || '#888888',
             use_color_for_name !== false, !!can_kick, !!can_ban, !!can_delete, !!can_pin, !!can_manage_roles, !!can_mute]
        );
        broadcastRoom(roomCode, { type: 'roles_update' });
        res.json(r.rows[0]);
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.put('/api/room/:code/roles/:roleId', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const roleId   = parseInt(req.params.roleId, 10);
    const caller   = req.session.username;
    const { role_name, color, use_color_for_name, can_kick, can_ban, can_delete, can_pin, can_manage_roles, can_mute } = req.body;
    if (!role_name || !role_name.trim()) return res.status(400).json({ error: 'Role name required.' });
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        if (!ownerRes.rows.length || ownerRes.rows[0].owner_username !== caller)
            return res.status(403).json({ error: 'Only the room owner can manage roles.' });
        const r = await pool.query(
            `UPDATE room_roles SET role_name=$1, color=$2, use_color_for_name=$3,
             can_kick=$4, can_ban=$5, can_delete=$6, can_pin=$7, can_manage_roles=$8, can_mute=$9
             WHERE id=$10 AND room_code=$11 RETURNING *`,
            [role_name.trim().slice(0, 30), color || '#888888',
             use_color_for_name !== false, !!can_kick, !!can_ban, !!can_delete, !!can_pin, !!can_manage_roles, !!can_mute,
             roleId, roomCode]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Role not found.' });
        broadcastRoom(roomCode, { type: 'roles_update' });
        res.json(r.rows[0]);
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/room/:code/roles/:roleId', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const roleId   = parseInt(req.params.roleId, 10);
    const caller   = req.session.username;
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        if (!ownerRes.rows.length || ownerRes.rows[0].owner_username !== caller)
            return res.status(403).json({ error: 'Only the room owner can manage roles.' });
        await pool.query('DELETE FROM room_roles WHERE id=$1 AND room_code=$2', [roleId, roomCode]);
        broadcastRoom(roomCode, { type: 'roles_update' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/room/:code/roles/:roleId/assign/:target', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const roleId   = parseInt(req.params.roleId, 10);
    const target   = req.params.target;
    const caller   = req.session.username;
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        const isOwner = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const canManage = await hasRolePermission(caller, roomCode, 'can_manage_roles');
        if (!isOwner && !canManage) return res.status(403).json({ error: 'No permission to assign roles.' });
        await pool.query(
            `INSERT INTO room_role_assignments (room_code, username, role_id) VALUES ($1,$2,$3)
             ON CONFLICT (room_code, username) DO UPDATE SET role_id=$3`,
            [roomCode, target, roleId]
        );
        broadcastRoom(roomCode, { type: 'roles_update' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/room/:code/members/:target/role', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const target   = req.params.target;
    const caller   = req.session.username;
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        const isOwner = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const canManage = await hasRolePermission(caller, roomCode, 'can_manage_roles');
        if (!isOwner && !canManage) return res.status(403).json({ error: 'No permission to manage roles.' });
        await pool.query('DELETE FROM room_role_assignments WHERE room_code=$1 AND username=$2', [roomCode, target]);
        broadcastRoom(roomCode, { type: 'roles_update' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Pinned Messages ──────────────────────────────────────────────────────────
app.get('/api/room/:code/pins', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    try {
        const r = await pool.query('SELECT * FROM pinned_messages WHERE room_code=$1 ORDER BY pinned_at ASC', [roomCode]);
        res.json(r.rows);
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/room/:code/pin/:messageId', requireAuth, async (req, res) => {
    const roomCode  = req.params.code.toUpperCase();
    const messageId = parseInt(req.params.messageId, 10);
    const caller    = req.session.username;
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        const isOwner  = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username)=LOWER($1)', [caller]);
        const canPin   = await hasRolePermission(caller, roomCode, 'can_pin');
        if (!isOwner && !staffRes.rows.length && !canPin) return res.status(403).json({ error: 'No permission to pin.' });
        const msgRes   = await pool.query('SELECT username, message FROM chat_messages WHERE id=$1', [messageId]);
        if (!msgRes.rows.length) return res.status(404).json({ error: 'Message not found.' });
        const { username, message } = msgRes.rows[0];
        const r = await pool.query(
            'INSERT INTO pinned_messages (room_code, message_id, message_text, author, pinned_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [roomCode, messageId, message, username, caller]
        );
        broadcastRoom(roomCode, { type: 'pin_update' });
        res.json(r.rows[0]);
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/room/:code/pin/:pinId', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const pinId    = parseInt(req.params.pinId, 10);
    const caller   = req.session.username;
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        const isOwner  = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username)=LOWER($1)', [caller]);
        const canPin   = await hasRolePermission(caller, roomCode, 'can_pin');
        if (!isOwner && !staffRes.rows.length && !canPin) return res.status(403).json({ error: 'No permission to unpin.' });
        await pool.query('DELETE FROM pinned_messages WHERE id=$1 AND room_code=$2', [pinId, roomCode]);
        broadcastRoom(roomCode, { type: 'pin_update' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/room/:code/pins', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const caller   = req.session.username;
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        const isOwner  = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username)=LOWER($1)', [caller]);
        const canPin   = await hasRolePermission(caller, roomCode, 'can_pin');
        if (!isOwner && !staffRes.rows.length && !canPin) return res.status(403).json({ error: 'No permission.' });
        await pool.query('DELETE FROM pinned_messages WHERE room_code=$1', [roomCode]);
        broadcastRoom(roomCode, { type: 'pin_update' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

// ─── Room Mutes ───────────────────────────────────────────────────────────────
app.get('/api/room/:code/mutes', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const caller   = req.session.username;
    try {
        const isOwner  = await pool.query('SELECT 1 FROM room_owners WHERE LOWER(room_code)=LOWER($1) AND LOWER(username)=LOWER($2)', [roomCode, caller]);
        const isStaff  = await pool.query('SELECT 1 FROM staff WHERE LOWER(username)=LOWER($1)', [caller]);
        const canMute  = await hasRolePermission(caller, roomCode, 'can_mute');
        if (!isOwner.rows.length && !isStaff.rows.length && !canMute) return res.status(403).json({ error: 'No permission.' });
        const result = await pool.query(
            'SELECT username, muted_until FROM room_mutes WHERE room_code=$1 AND muted_until > NOW() ORDER BY muted_until ASC',
            [roomCode]
        );
        res.json(result.rows);
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/room/:code/mute/:target', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const target   = req.params.target;
    const caller   = req.session.username;
    const duration = Math.min(parseInt(req.body.duration, 10) || 300, 86400); // seconds, max 24h
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        const isOwner  = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username)=LOWER($1)', [caller]);
        const canMute  = await hasRolePermission(caller, roomCode, 'can_mute');
        if (!isOwner && !staffRes.rows.length && !canMute) return res.status(403).json({ error: 'No permission to mute.' });
        if (target === caller) return res.status(400).json({ error: 'Cannot mute yourself.' });
        const until = new Date(Date.now() + duration * 1000);
        await pool.query(
            `INSERT INTO room_mutes (room_code, username, muted_until, muted_by) VALUES ($1,$2,$3,$4)
             ON CONFLICT (room_code, username) DO UPDATE SET muted_until=$3, muted_by=$4`,
            [roomCode, target, until, caller]
        );
        const untilStr = until.toISOString();
        broadcastRoom(roomCode, { type: 'user_muted', username: target, until: untilStr, by: caller });
        res.json({ success: true, until: untilStr });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

app.delete('/api/room/:code/mute/:target', requireAuth, async (req, res) => {
    const roomCode = req.params.code.toUpperCase();
    const target   = req.params.target;
    const caller   = req.session.username;
    try {
        const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code=$1', [roomCode]);
        const isOwner  = ownerRes.rows.length && ownerRes.rows[0].owner_username === caller;
        const staffRes = await pool.query('SELECT 1 FROM staff WHERE LOWER(username)=LOWER($1)', [caller]);
        const canMute  = await hasRolePermission(caller, roomCode, 'can_mute');
        if (!isOwner && !staffRes.rows.length && !canMute) return res.status(403).json({ error: 'No permission.' });
        await pool.query('DELETE FROM room_mutes WHERE room_code=$1 AND username=$2', [roomCode, target]);
        broadcastRoom(roomCode, { type: 'user_unmuted', username: target });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error.' }); }
});

// ─── WebSocket Chat ───────────────────────────────────────────────────────────
// rooms: roomCode -> { clients: Map<ws, username>, owner: username }
const rooms = new Map();
// online users: username -> Set<ws>  (multiple tabs support)
const onlineUsers = new Map();

function getRoom(roomCode) {
    if (!rooms.has(roomCode)) rooms.set(roomCode, { clients: new Map(), owner: null });
    return rooms.get(roomCode);
}

function broadcastRoom(roomCode, data, excludeWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const msg = JSON.stringify(data);
    room.clients.forEach((uname, client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function getMemberList(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return [];
    return Array.from(room.clients.values());
}

wss.on('connection', (ws) => {
    let currentRoom = null;
    let currentUsername = null;
    let currentIsStaff = false;

    ws.on('message', async (rawData) => {
        let data;
        try { data = JSON.parse(rawData); } catch { return; }

        // ── Presence (lobby DM tracking) ─────────────────────────────────────
        if (data.type === 'presence') {
            const username = (data.username || '').trim().slice(0, 30);
            if (!username) return;
            currentUsername = username;
            if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
            onlineUsers.get(username).add(ws);
            ws.send(JSON.stringify({ type: 'presence_ack' }));
            return;

        // ── Join ──────────────────────────────────────────────────────────────
        } else if (data.type === 'join') {
            const roomCode = (data.roomCode || '').trim().toUpperCase();
            const username = (data.username || '').trim().slice(0, 30);
            if (!roomCode || !username) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid room or username.' }));
                return;
            }

            // Check ban
            try {
                const banCheck = await pool.query(
                    'SELECT 1 FROM room_bans WHERE room_code = $1 AND banned_username = $2',
                    [roomCode, username]
                );
                if (banCheck.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are banned from this room.' }));
                    return;
                }
            } catch (err) { console.error(err); }

            const room = getRoom(roomCode);

            // Always look up ownership from DB — never assign by join order
            try {
                const ownerRes = await pool.query('SELECT owner_username FROM room_owners WHERE room_code = $1', [roomCode]);
                room.owner = ownerRes.rows[0]?.owner_username || null;
            } catch (err) { console.error(err); }

            currentIsStaff = await checkIsStaff(username);
            room.clients.set(ws, username);
            currentRoom = roomCode;
            currentUsername = username;

            // Track online presence for DM delivery
            if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
            onlineUsers.get(username).add(ws);

            // Record join history
            pool.query(
                `INSERT INTO room_history (username, room_code, last_joined)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (username, room_code) DO UPDATE SET last_joined = NOW()`,
                [username, roomCode]
            ).catch(() => {});

            ws.send(JSON.stringify({
                type: 'joined',
                roomCode,
                username,
                isOwner: room.owner === username,
                isStaff: currentIsStaff,
                members: getMemberList(roomCode)
            }));

            broadcastRoom(roomCode, {
                type: 'system',
                message: `${username} joined the room.`,
                members: getMemberList(roomCode)
            }, ws);

        // ── Text / Media Message ──────────────────────────────────────────────
        } else if (data.type === 'message') {
            if (!currentRoom || !currentUsername) return;
            // Check mute
            try {
                const muteRes = await pool.query(
                    'SELECT muted_until FROM room_mutes WHERE room_code=$1 AND username=$2 AND muted_until > NOW()',
                    [currentRoom, currentUsername]
                );
                if (muteRes.rows.length) {
                    ws.send(JSON.stringify({ type: 'you_are_muted', until: muteRes.rows[0].muted_until }));
                    return;
                }
            } catch {}
            const message = (data.message || '').trim().slice(0, 500);
            const mediaUrl = data.mediaUrl || null;
            const mediaType = data.mediaType || null;
            const replyToUsername = (data.replyToUsername || '').trim().slice(0, 30) || null;
            const replyToMessage = (data.replyToMessage || '').trim().slice(0, 200) || null;
            if (!message && !mediaUrl) return;

            let messageId = null;
            try {
                const ins = await pool.query(
                    'INSERT INTO chat_messages (room_code, username, message, media_url, media_type, reply_to_username, reply_to_message) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
                    [currentRoom, currentUsername, message || '', mediaUrl, mediaType, replyToUsername, replyToMessage]
                );
                messageId = ins.rows[0].id;
            } catch (err) { console.error(err); }

            let senderAvatarUrl = null;
            try {
                const avRes = await pool.query('SELECT avatar_url FROM users WHERE username=$1', [currentUsername]);
                if (avRes.rows.length) senderAvatarUrl = avRes.rows[0].avatar_url || null;
            } catch {}

            const payload = {
                type: 'message',
                id: messageId,
                username: currentUsername,
                avatarUrl: senderAvatarUrl,
                message,
                mediaUrl,
                mediaType,
                replyToUsername,
                replyToMessage,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            ws.send(JSON.stringify(payload));
            broadcastRoom(currentRoom, payload, ws);

        // ── Kick ─────────────────────────────────────────────────────────────
        } else if (data.type === 'kick') {
            if (!currentRoom || !currentUsername) return;
            const room = rooms.get(currentRoom);
            const canKickRole = await hasRolePermission(currentUsername, currentRoom, 'can_kick');
            if (!room || (room.owner !== currentUsername && !currentIsStaff && !canKickRole)) return;

            const target = (data.target || '').trim();
            if (!target || target === currentUsername) return;

            room.clients.forEach((uname, client) => {
                if (uname === target) {
                    client.send(JSON.stringify({ type: 'kicked', message: 'You were kicked by the room owner.' }));
                    client.close();
                }
            });

        // ── Unban ─────────────────────────────────────────────────────────────
        } else if (data.type === 'unban') {
            if (!currentRoom || !currentUsername) return;
            const room = rooms.get(currentRoom);
            if (!room || (room.owner !== currentUsername && !currentIsStaff)) return;

            const target = (data.target || '').trim();
            if (!target) return;

            try {
                await pool.query(
                    'DELETE FROM room_bans WHERE room_code = $1 AND banned_username = $2',
                    [currentRoom, target]
                );
            } catch (err) { console.error(err); }

            ws.send(JSON.stringify({
                type: 'unban_success',
                target,
                message: `${target} has been unbanned.`
            }));

        // ── Ban ───────────────────────────────────────────────────────────────
        } else if (data.type === 'ban') {
            if (!currentRoom || !currentUsername) return;
            const room = rooms.get(currentRoom);
            const canBanRole = await hasRolePermission(currentUsername, currentRoom, 'can_ban');
            if (!room || (room.owner !== currentUsername && !currentIsStaff && !canBanRole)) return;

            const target = (data.target || '').trim();
            if (!target || target === currentUsername) return;

            try {
                await pool.query(
                    'INSERT INTO room_bans (room_code, banned_username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [currentRoom, target]
                );
            } catch (err) { console.error(err); }

            room.clients.forEach((uname, client) => {
                if (uname === target) {
                    client.send(JSON.stringify({ type: 'kicked', message: 'You were banned from this room.' }));
                    client.close();
                }
            });

            broadcastRoom(currentRoom, {
                type: 'system',
                message: `${target} was banned from the room.`,
                members: getMemberList(currentRoom)
            });

        // ── Direct Message ────────────────────────────────────────────────────
        } else if (data.type === 'dm') {
            if (!currentUsername) return;
            const dmTarget  = (data.target  || '').trim().slice(0, 30);
            const dmMessage = (data.message || '').trim().slice(0, 1000);
            if (!dmTarget || !dmMessage || dmTarget === currentUsername) return;

            try {
                const blockRes = await pool.query(
                    'SELECT 1 FROM user_blocks WHERE (blocker_username=$1 AND blocked_username=$2) OR (blocker_username=$2 AND blocked_username=$1)',
                    [currentUsername, dmTarget]
                );
                if (blockRes.rows.length > 0) {
                    ws.send(JSON.stringify({ type: 'dm_error', target: dmTarget, message: 'Cannot send — one of you has blocked the other.' }));
                    return;
                }

                const inserted = await pool.query(
                    'INSERT INTO direct_messages (from_username, to_username, message) VALUES ($1, $2, $3) RETURNING id, created_at',
                    [currentUsername, dmTarget, dmMessage]
                );
                const row = inserted.rows[0];

                const dmPayload = {
                    type: 'dm',
                    id: row.id,
                    from: currentUsername,
                    to: dmTarget,
                    message: dmMessage,
                    time: new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };

                ws.send(JSON.stringify(dmPayload));

                const targetSockets = onlineUsers.get(dmTarget);
                if (targetSockets) {
                    targetSockets.forEach(sock => {
                        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(dmPayload));
                    });
                }
            } catch(err) { console.error(err); }

        // ── Delete Message (staff or author via WS) ───────────────────────────
        } else if (data.type === 'delete_message') {
            if (!currentUsername) return;
            const msgId = parseInt(data.messageId, 10);
            if (!msgId) return;
            try {
                const msgRes = await pool.query('SELECT username, room_code FROM chat_messages WHERE id=$1', [msgId]);
                if (!msgRes.rows.length) return;
                const msg = msgRes.rows[0];
                const canDelRole = await hasRolePermission(currentUsername, msg.room_code, 'can_delete');
                if (msg.username !== currentUsername && !currentIsStaff && !canDelRole) return;
                await pool.query('DELETE FROM chat_messages WHERE id=$1', [msgId]);
                const delPayload = { type: 'message_deleted', messageId: msgId };
                ws.send(JSON.stringify(delPayload));
                if (msg.room_code) broadcastRoom(msg.room_code, delPayload, ws);
            } catch(err) { console.error(err); }
        }
    });

    ws.on('close', () => {
        // Remove from online presence
        if (currentUsername) {
            const socks = onlineUsers.get(currentUsername);
            if (socks) {
                socks.delete(ws);
                if (socks.size === 0) onlineUsers.delete(currentUsername);
            }
        }
        if (currentRoom) {
            const room = rooms.get(currentRoom);
            if (room) {
                room.clients.delete(ws);
                if (room.clients.size === 0) {
                    rooms.delete(currentRoom);
                } else {
                    broadcastRoom(currentRoom, {
                        type: 'system',
                        message: `${currentUsername} left the room.`,
                        members: getMemberList(currentRoom)
                    });
                }
            }
        }
    });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
});
