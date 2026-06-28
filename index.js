require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const { Pool } = require('pg');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

// ── DB 연결 ──────────────────────────────────────────────────
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

// ── 미들웨어 ─────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DB 초기화 ────────────────────────────────────────────────
async function initDB() {
  if (!pool) {
    console.warn('⚠️ DATABASE_URL 없음 — DB 없이 실행');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ DB 초기화 완료');
  } finally {
    client.release();
  }
}

// ── JWT 인증 미들웨어 ────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: '세션이 만료됐습니다. 다시 로그인하세요.' });
  }
}

// 원장 전용 미들웨어
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: '원장 권한이 필요합니다.' });
  next();
}

// ── 로그인 API ───────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { role, password } = req.body;
  if (!role || !['admin', 'staff'].includes(role)) {
    return res.status(400).json({ ok: false, error: '역할을 선택하세요.' });
  }

  // 비밀번호는 DB settings에서 읽기 (없으면 환경변수 폴백)
  let adminPw = process.env.ADMIN_PASSWORD || '1234';
  let staffPw = process.env.STAFF_PASSWORD || '';

  if (pool) {
    try {
      const result = await pool.query("SELECT value FROM kv_store WHERE key = 'dc_settings'");
      if (result.rows.length > 0) {
        const settings = result.rows[0].value;
        if (settings?.credentials?.adminPassword) adminPw = settings.credentials.adminPassword;
        if (settings?.credentials?.staffPassword !== undefined) staffPw = settings.credentials.staffPassword;
      }
    } catch {}
  }

  if (role === 'admin') {
    if (password !== adminPw) return res.status(401).json({ ok: false, error: '비밀번호가 틀렸습니다.' });
  } else {
    if (staffPw && password !== staffPw) return res.status(401).json({ ok: false, error: '비밀번호가 틀렸습니다.' });
  }

  const token = jwt.sign({ role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ ok: true, token, role });
});

// ── 데이터 API (인증 필요) ───────────────────────────────────

// 전체 데이터 로드
app.get('/api/data', requireAuth, async (req, res) => {
  if (!pool) return res.json({ ok: true, data: {} });
  try {
    const result = await pool.query('SELECT key, value FROM kv_store');
    const data = {};
    result.rows.forEach(row => { data[row.key] = row.value; });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 단일 키 저장
app.post('/api/data/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  const value = req.body;
  if (!key.startsWith('dc_')) return res.status(400).json({ ok: false, error: '허용되지 않는 키입니다.' });
  if (!pool) return res.json({ ok: true, warn: 'DB 없음' });
  try {
    await pool.query(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, JSON.stringify(value)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 단일 키 삭제
app.delete('/api/data/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  if (!key.startsWith('dc_')) return res.status(400).json({ ok: false, error: '허용되지 않는 키입니다.' });
  if (!pool) return res.json({ ok: true, warn: 'DB 없음' });
  try {
    await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 전체 초기화 (원장 전용)
app.delete('/api/data', requireAuth, requireAdmin, async (req, res) => {
  if (!pool) return res.json({ ok: true, warn: 'DB 없음' });
  try {
    await pool.query("DELETE FROM kv_store WHERE key LIKE 'dc_%'");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── 서버 시작 ────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB 초기화 실패:', err);
  process.exit(1);
});
