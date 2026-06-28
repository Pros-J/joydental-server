require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const https = require('https');
const { Pool }   = require('pg');
const path       = require('path');
const _csdk      = require('coolsms-node-sdk');
const coolsms    = _csdk.default || _csdk;

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET  = process.env.JWT_SECRET  || 'change-this-secret-in-production';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'showtimej36@gmail.com';

// ── Resend 메일 발송 ─────────────────────────────────────────
const resetCodes = new Map();

function sendResetEmail(code) {
  if (!process.env.RESEND_API_KEY) return Promise.reject(new Error('메일 설정이 없습니다.'));

  const body = JSON.stringify({
    from: 'onboarding@resend.dev',
    to: ADMIN_EMAIL,
    subject: '[조이치과] 비밀번호 재설정 인증코드',
    html: `
      <div style="font-family:sans-serif;max-width:400px;margin:0 auto">
        <h2 style="color:#2563eb">조이치과 관리 시스템</h2>
        <p>비밀번호 재설정 인증코드입니다.</p>
        <div style="font-size:32px;font-weight:bold;letter-spacing:8px;
                    background:#f3f4f6;padding:20px;text-align:center;
                    border-radius:8px;margin:20px 0">${code}</div>
        <p style="color:#6b7280;font-size:13px">이 코드는 30분간 유효합니다.<br>
        본인이 요청하지 않은 경우 무시하세요.</p>
      </div>`
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (res.statusCode >= 400) reject(new Error(json.message || '발송 실패'));
        else resolve(json);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('요청 시간 초과')); });
    req.write(body);
    req.end();
  });
}

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

// ── 로그인 실패 횟수 추적 ────────────────────────────────────
const loginAttempts = new Map(); // role → { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 30;

function getAttempts(role) {
  return loginAttempts.get(role) || { count: 0, lockedUntil: null };
}
function recordFailure(role) {
  const a = getAttempts(role);
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) a.lockedUntil = Date.now() + LOCK_MINUTES * 60 * 1000;
  loginAttempts.set(role, a);
}
function resetAttempts(role) {
  loginAttempts.delete(role);
}

// ── 로그인 API ───────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { role, password } = req.body;
  if (!role || !['admin', 'staff'].includes(role)) {
    return res.status(400).json({ ok: false, error: '역할을 선택하세요.' });
  }

  // 잠금 확인
  const attempts = getAttempts(role);
  if (attempts.lockedUntil) {
    if (Date.now() < attempts.lockedUntil) {
      const remaining = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({
        ok: false,
        error: `비밀번호 5회 오류로 ${remaining}분간 잠금됐습니다. "비밀번호를 잊으셨나요?"를 이용하세요.`,
        locked: true
      });
    } else {
      resetAttempts(role); // 잠금 시간 지나면 자동 해제
    }
  }

  // 비밀번호는 DB settings에서 읽기
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

  // 비밀번호 확인
  let pwOk = false;
  if (role === 'admin') pwOk = (password === adminPw);
  else pwOk = (!staffPw || password === staffPw);

  if (!pwOk) {
    recordFailure(role);
    const a = getAttempts(role);
    const remaining = MAX_ATTEMPTS - a.count;
    if (a.lockedUntil) {
      return res.status(423).json({
        ok: false,
        error: `비밀번호 5회 오류로 ${LOCK_MINUTES}분간 잠금됐습니다. "비밀번호를 잊으셨나요?"를 이용하세요.`,
        locked: true
      });
    }
    return res.status(401).json({
      ok: false,
      error: `비밀번호가 틀렸습니다. (${remaining}회 남음)`
    });
  }

  resetAttempts(role);
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

// ── 비밀번호 찾기 ────────────────────────────────────────────

// 1단계: 인증코드 발송
app.post('/api/forgot-password', async (req, res) => {
  if (!process.env.RESEND_API_KEY) return res.status(503).json({ ok: false, error: '메일 서비스가 설정되지 않았습니다.' });

  // 6자리 숫자 코드 생성
  const code = String(Math.floor(100000 + Math.random() * 900000));
  resetCodes.set(ADMIN_EMAIL, { code, expiresAt: Date.now() + 30 * 60 * 1000 });

  try {
    await sendResetEmail(code);
    res.json({ ok: true, message: `${ADMIN_EMAIL}로 인증코드를 발송했습니다.` });
  } catch (err) {
    console.error('메일 발송 실패:', err.message);
    res.status(500).json({ ok: false, error: '메일 발송 실패: ' + err.message });
  }
});

// 2단계: 코드 확인 후 비밀번호 변경
app.post('/api/reset-password', async (req, res) => {
  const { code, newPassword, role } = req.body;
  if (!code || !newPassword || !role) {
    return res.status(400).json({ ok: false, error: '필수 항목이 누락됐습니다.' });
  }

  const saved = resetCodes.get(ADMIN_EMAIL);
  if (!saved) return res.status(400).json({ ok: false, error: '인증코드를 먼저 요청하세요.' });
  if (Date.now() > saved.expiresAt) {
    resetCodes.delete(ADMIN_EMAIL);
    return res.status(400).json({ ok: false, error: '인증코드가 만료됐습니다. 다시 요청하세요.' });
  }
  if (saved.code !== code.trim()) {
    return res.status(400).json({ ok: false, error: '인증코드가 틀렸습니다.' });
  }

  // 비밀번호 변경 — DB settings 업데이트 (기존 데이터 보존)
  if (pool) {
    try {
      const result = await pool.query("SELECT value FROM kv_store WHERE key = 'dc_settings'");
      // 기존 settings 전체를 읽어서 credentials만 업데이트 (labs 등 다른 데이터 보존)
      let settings = (result.rows.length > 0 && result.rows[0].value) ? result.rows[0].value : {};
      if (!settings.credentials) settings.credentials = {};
      if (role === 'admin') settings.credentials.adminPassword = newPassword;
      else settings.credentials.staffPassword = newPassword;
      await pool.query(`
        INSERT INTO kv_store (key, value, updated_at) VALUES ('dc_settings', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify(settings)]);
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'DB 저장 실패: ' + err.message });
    }
  }

  resetCodes.delete(ADMIN_EMAIL);
  resetAttempts(role); // 비밀번호 재설정 시 잠금 해제
  res.json({ ok: true, message: '비밀번호가 변경됐습니다.' });
});

// ── SMS 발송 ─────────────────────────────────────────────────
app.post('/api/sms', requireAuth, async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: '수신번호와 내용이 필요합니다.' });

  const apiKey    = process.env.COOLSMS_API_KEY;
  const apiSecret = process.env.COOLSMS_API_SECRET;
  const from      = process.env.COOLSMS_SENDER;

  if (!apiKey || !apiSecret || !from) {
    return res.status(503).json({ ok: false, error: 'SMS 설정이 없습니다.' });
  }

  try {
    const messageService = new coolsms(apiKey, apiSecret);
    await messageService.sendOne({
      to: to.replace(/[^0-9]/g, ''),
      from,
      text,
      type: text.length > 90 ? 'LMS' : 'SMS'
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('SMS 발송 실패:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 헬스 체크
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── 서버 시작 ────────────────────────────────────────────────
// DB 초기화 실패해도 서버는 계속 실행 (헬스체크 통과용)
initDB().catch(err => {
  console.error('⚠️ DB 초기화 실패 (서버는 계속 실행):', err.message);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 서버 실행 중: http://0.0.0.0:${PORT}`);
});
