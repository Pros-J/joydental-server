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

// ── 레코드 단위 저장 엔티티 목록 (kv_store 통짜 저장 → 이 엔티티들만 개별 레코드로 이전) ──
const MIGRATED_ENTITIES = [
  'dc_fixtures', 'dc_implant_mats', 'dc_fixture_usage', 'dc_mat_usage',
  'dc_implant_orders', 'dc_general_orders', 'dc_lab_work', 'dc_direct', 'dc_vendors'
];
const MIGRATED_ENTITY_SET = new Set(MIGRATED_ENTITIES);
function validEntity(entity) { return MIGRATED_ENTITY_SET.has(entity); }

// kv_store의 기존 배열 blob을 records 테이블로 1회 이전 (멱등: 이미 이전된 엔티티는 건너뜀)
// 구버전의 id 중복 발급 버그로 같은 id를 가진 레코드가 이미 섞여 있을 수 있으므로,
// 충돌하는 레코드는 버리지 않고 새 id를 배정해 데이터 유실 없이 전부 보존한다.
async function migrateKvToRecords(client) {
  for (const entity of MIGRATED_ENTITIES) {
    const { rows: cnt } = await client.query('SELECT COUNT(*)::int AS c FROM records WHERE entity = $1', [entity]);
    if (cnt[0].c > 0) continue; // 이미 이전됨 — 재시작마다 매번 재실행되어도 완전히 no-op

    const { rows: kv } = await client.query('SELECT value FROM kv_store WHERE key = $1', [entity]);
    if (!kv.length || !Array.isArray(kv[0].value)) continue; // 이전할 데이터 없음

    const arr = kv[0].value;
    let maxId = 0;
    for (const rec of arr) { if (rec && typeof rec.id === 'number') maxId = Math.max(maxId, rec.id); }

    const usedIds = new Set();
    await client.query('BEGIN');
    try {
      let dupCount = 0;
      for (const rec of arr) {
        if (rec == null || typeof rec.id !== 'number') continue; // 방어: 손상된 레코드는 건너뜀
        const { id: origId, ...rest } = rec;
        let id = origId;
        if (usedIds.has(id)) {
          // 구버전 버그로 이미 같은 id가 중복 발급된 레코드 — 새 id로 재배정해 유실 방지
          maxId += 1;
          id = maxId;
          dupCount++;
        }
        usedIds.add(id);
        await client.query(
          `INSERT INTO records (entity, id, data, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (entity, id) DO NOTHING`,
          [entity, id, JSON.stringify(rest)]
        );
      }
      await client.query(
        `INSERT INTO record_seq (entity, next_id) VALUES ($1, $2)
         ON CONFLICT (entity) DO UPDATE
           SET next_id = GREATEST(record_seq.next_id, EXCLUDED.next_id)`,
        [entity, maxId + 1]
      );
      await client.query('COMMIT');
      console.log(`✅ ${entity} 레코드 이전 완료 (${arr.length}건, maxId=${maxId}, 중복id 재배정=${dupCount}건)`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err; // 부분 이전을 조용히 넘기지 않고 실패를 드러냄
    }
  }
}

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
    await client.query(`
      CREATE TABLE IF NOT EXISTS records (
        entity     TEXT        NOT NULL,
        id         BIGINT      NOT NULL,
        data       JSONB       NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (entity, id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_records_entity ON records (entity)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS record_seq (
        entity  TEXT PRIMARY KEY,
        next_id BIGINT NOT NULL DEFAULT 1
      )
    `);
    await migrateKvToRecords(client);
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

// ── 레코드 단위 데이터 API (인증 필요) ───────────────────────
// kv_store 통짜 배열 저장 방식의 후속 — 엔티티별로 서버가 id를 원자적으로 발급하고
// 레코드 단위 CRUD를 제공해, 동시 편집 시 다른 레코드끼리 덮어쓰는 문제를 없앤다.

// 엔티티 전체 조회
app.get('/api/records/:entity', requireAuth, async (req, res) => {
  const { entity } = req.params;
  if (!validEntity(entity)) return res.status(400).json({ ok: false, error: '허용되지 않는 엔티티입니다.' });
  if (!pool) return res.json({ ok: true, data: [] });
  try {
    const { rows } = await pool.query('SELECT id, data FROM records WHERE entity = $1 ORDER BY id', [entity]);
    res.json({ ok: true, data: rows.map(r => ({ id: Number(r.id), ...r.data })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 레코드 생성 (id는 서버가 원자적으로 발급)
app.post('/api/records/:entity', requireAuth, async (req, res) => {
  const { entity } = req.params;
  if (!validEntity(entity)) return res.status(400).json({ ok: false, error: '허용되지 않는 엔티티입니다.' });
  if (!pool) return res.status(503).json({ ok: false, error: 'DB 없음' });
  const { id: _ignored, ...payload } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 엔티티가 한 번도 seed되지 않은 경우(신규 설치 등)까지 한 문장으로 원자적으로 처리
    // (INSERT/UPDATE를 분리하면 그 사이에 동시 요청이 끼어들어 같은 id를 받을 수 있음)
    const { rows } = await client.query(
      `INSERT INTO record_seq (entity, next_id) VALUES ($1, 2)
       ON CONFLICT (entity) DO UPDATE SET next_id = record_seq.next_id + 1
       RETURNING next_id - 1 AS id`,
      [entity]
    );
    const newId = Number(rows[0].id);
    await client.query(
      `INSERT INTO records (entity, id, data, updated_at) VALUES ($1, $2, $3, NOW())`,
      [entity, newId, JSON.stringify(payload)]
    );
    await client.query('COMMIT');
    res.json({ ok: true, id: newId, data: { id: newId, ...payload } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// 레코드 수정 (id 기준 단건 UPDATE — 배열 전체를 덮어쓰지 않음)
app.put('/api/records/:entity/:id', requireAuth, async (req, res) => {
  const { entity, id } = req.params;
  if (!validEntity(entity)) return res.status(400).json({ ok: false, error: '허용되지 않는 엔티티입니다.' });
  const numId = Number(id);
  if (!Number.isInteger(numId)) return res.status(400).json({ ok: false, error: '잘못된 id입니다.' });
  if (!pool) return res.status(503).json({ ok: false, error: 'DB 없음' });
  const { id: _ignored, ...payload } = req.body || {};
  try {
    const result = await pool.query(
      `UPDATE records SET data = $3, updated_at = NOW() WHERE entity = $1 AND id = $2`,
      [entity, numId, JSON.stringify(payload)]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: '레코드를 찾을 수 없습니다.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 레코드 삭제 (id 기준 단건 DELETE)
app.delete('/api/records/:entity/:id', requireAuth, async (req, res) => {
  const { entity, id } = req.params;
  if (!validEntity(entity)) return res.status(400).json({ ok: false, error: '허용되지 않는 엔티티입니다.' });
  const numId = Number(id);
  if (!Number.isInteger(numId)) return res.status(400).json({ ok: false, error: '잘못된 id입니다.' });
  if (!pool) return res.status(503).json({ ok: false, error: 'DB 없음' });
  try {
    await pool.query('DELETE FROM records WHERE entity = $1 AND id = $2', [entity, numId]);
    res.json({ ok: true }); // 이미 없어도 성공 처리 (멱등)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 엔티티 통째 복원 (가져오기 기능 전용, 원장 전용) — 기존 id를 보존한 채로 전체 교체
app.post('/api/records/:entity/bulk-restore', requireAuth, requireAdmin, async (req, res) => {
  const { entity } = req.params;
  if (!validEntity(entity)) return res.status(400).json({ ok: false, error: '허용되지 않는 엔티티입니다.' });
  if (!pool) return res.status(503).json({ ok: false, error: 'DB 없음' });
  const records = Array.isArray(req.body?.records) ? req.body.records : null;
  if (!records) return res.status(400).json({ ok: false, error: 'records 배열이 필요합니다.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM records WHERE entity = $1', [entity]);
    // 복원할 데이터 안에 이미 중복된 id가 섞여 있어도(구버전 버그 잔재) 버리지 않고 새 id로 재배정
    let maxId = 0;
    for (const rec of records) { if (rec && typeof rec.id === 'number') maxId = Math.max(maxId, rec.id); }
    const usedIds = new Set();
    for (const rec of records) {
      if (rec == null || typeof rec.id !== 'number') continue;
      const { id: origId, ...rest } = rec;
      let id = origId;
      if (usedIds.has(id)) { maxId += 1; id = maxId; }
      usedIds.add(id);
      await client.query(
        `INSERT INTO records (entity, id, data, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (entity, id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [entity, id, JSON.stringify(rest)]
      );
    }
    // 이 엔티티의 기존 행은 위에서 이미 전부 삭제했으므로, 카운터는 복원된 데이터 기준으로
    // 그대로 재설정한다 (이전 카운터와 GREATEST 비교할 필요 없음 — 비교 대상 자체가 없음).
    await client.query(
      `INSERT INTO record_seq (entity, next_id) VALUES ($1, $2)
       ON CONFLICT (entity) DO UPDATE SET next_id = EXCLUDED.next_id`,
      [entity, maxId + 1]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// 레코드 엔티티 전체 초기화 (원장 전용) — 9개 마이그레이션 대상 엔티티만 삭제, record_seq도 리셋
app.delete('/api/records', requireAuth, requireAdmin, async (req, res) => {
  if (!pool) return res.json({ ok: true, warn: 'DB 없음' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM records WHERE entity = ANY($1::text[])', [MIGRATED_ENTITIES]);
    await client.query('DELETE FROM record_seq WHERE entity = ANY($1::text[])', [MIGRATED_ENTITIES]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// 로그인 직후 부트스트랩 — settings + 9개 엔티티를 한 번에 로드 (기존 GET /api/data 대체)
app.get('/api/bootstrap', requireAuth, async (req, res) => {
  if (!pool) return res.json({ ok: true, settings: null, records: {} });
  try {
    const client = await pool.connect();
    try {
      const [settingsResult, recordsResult] = await Promise.all([
        client.query("SELECT value FROM kv_store WHERE key = 'dc_settings'"),
        client.query(
          `SELECT entity, id, data FROM records WHERE entity = ANY($1::text[]) ORDER BY entity, id`,
          [MIGRATED_ENTITIES]
        )
      ]);
      const settings = settingsResult.rows.length ? settingsResult.rows[0].value : null;
      const records = {};
      MIGRATED_ENTITIES.forEach(entity => { records[entity] = []; });
      recordsResult.rows.forEach(r => { records[r.entity].push({ id: Number(r.id), ...r.data }); });
      res.json({ ok: true, settings, records });
    } finally {
      client.release();
    }
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
      type: 'LMS'
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
