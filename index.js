require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

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

// 프론트엔드 정적 파일 제공 (HTML 파일을 /public 에 복사하면 됨)
app.use(express.static(path.join(__dirname, 'public')));

// ── DB 초기화 ────────────────────────────────────────────────
async function initDB() {
  if (!pool) {
    console.warn('⚠️ DATABASE_URL 없음 — DB 없이 실행 (데이터 저장 안 됨)');
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

// ── API 라우트 ───────────────────────────────────────────────

// 전체 데이터 한 번에 가져오기 (앱 시작 시 1회 호출)
app.get('/api/data', async (req, res) => {
  if (!pool) return res.json({ ok: true, data: {} });
  try {
    const result = await pool.query('SELECT key, value FROM kv_store');
    const data = {};
    result.rows.forEach(row => { data[row.key] = row.value; });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('GET /api/data error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 단일 키 저장 (DB._set 호출 시)
app.post('/api/data/:key', async (req, res) => {
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
    console.error(`POST /api/data/${key} error:`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 단일 키 삭제
app.delete('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  if (!key.startsWith('dc_')) return res.status(400).json({ ok: false, error: '허용되지 않는 키입니다.' });
  if (!pool) return res.json({ ok: true, warn: 'DB 없음' });
  try {
    await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
    res.json({ ok: true });
  } catch (err) {
    console.error(`DELETE /api/data/${key} error:`, err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 전체 초기화
app.delete('/api/data', async (req, res) => {
  if (!pool) return res.json({ ok: true, warn: 'DB 없음' });
  try {
    await pool.query("DELETE FROM kv_store WHERE key LIKE 'dc_%'");
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/data error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 헬스 체크 (Railway 배포 확인용)
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
