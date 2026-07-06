// ────────────────────────────────────────────────────────────────────────────
// 공유 백엔드 (초사이어인 1단계) — Node 내장 SQLite + REST API + 정적 서빙
//   싱글플레이(localStorage) → 멀티플레이(공유 서버). 외부 계정/의존성 없음.
//   실행:  npm run server  → http://localhost:8000
//
//   API:
//     GET    /api/health
//     GET    /api/spots?bbox=minLng,minLat,maxLng,maxLat&cat=legal_free,gray_zone
//     POST   /api/spots            (본문 = 제보 폼, 서버가 buildFeature로 검증·안전가드 강제)
//     PATCH  /api/spots/:id        (editable 스팟만)
//     DELETE /api/spots/:id        (editable 스팟만)
//
//   프로덕션 경로는 이 스키마/엔드포인트를 Supabase(PostGIS+Auth)로 승격하면 됨(README).
// ────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFile, readFileSync as rfs, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildFeature } from '../lib/userSpots.js';

const ROOT = process.cwd();
const PORT = process.env.PORT || 8000;
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'spots.db');

// ── DB ──────────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS spots (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    lng REAL NOT NULL,
    lat REAL NOT NULL,
    source TEXT,
    editable INTEGER DEFAULT 0,
    updated_at INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spots_bbox ON spots(lng, lat);
  CREATE INDEX IF NOT EXISTS idx_spots_cat ON spots(category);
`);

const stmtUpsert = db.prepare(
  'INSERT OR REPLACE INTO spots(id,category,lng,lat,source,editable,updated_at,data) VALUES(?,?,?,?,?,?,?,?)'
);
const stmtGet = db.prepare('SELECT editable, data FROM spots WHERE id = ?');
const stmtDel = db.prepare('DELETE FROM spots WHERE id = ?');
const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM spots');

function saveFeature(f) {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  stmtUpsert.run(p.id, p.category, lng, lat, p.source || 'official', p.editable ? 1 : 0, Date.now(), JSON.stringify(f));
}

function querySpots(bbox, cats) {
  const where = [], args = [];
  if (bbox) { where.push('lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?'); args.push(bbox[0], bbox[2], bbox[1], bbox[3]); }
  if (cats && cats.length) { where.push(`category IN (${cats.map(() => '?').join(',')})`); args.push(...cats); }
  const sql = `SELECT data FROM spots${where.length ? ' WHERE ' + where.join(' AND ') : ''} LIMIT 5000`;
  return db.prepare(sql).all(...args).map((r) => JSON.parse(r.data));
}

// 최초 실행 시 초기 데이터를 DB로 이관.
// 합법무료는 실데이터(free-parking.json, ingest 산출물)가 있으면 그것을, 없으면 시드를 사용.
function migrateSeeds() {
  if (stmtCount.get().n > 0) return;
  const real = join(ROOT, 'data', 'free-parking.json');
  const legalFile = existsSync(real) ? real : join(ROOT, 'data', 'free-parking.seed.json');
  let n = 0;
  db.exec('BEGIN'); // 7천+ 건 대량 삽입은 단일 트랜잭션으로(개별 커밋 fsync 방지)
  for (const file of [legalFile, join(ROOT, 'data', 'gray-zones.seed.json'), join(ROOT, 'data', 'no-parking.seed.json')]) {
    try {
      const fc = JSON.parse(rfs(file, 'utf8'));
      for (const f of fc.features || []) { saveFeature(f); n++; }
    } catch (e) { console.warn('seed skip', file, e.message); }
  }
  db.exec('COMMIT');
  console.log(`▶ 초기 데이터 ${n}곳 DB 이관 (합법무료 소스: ${legalFile.endsWith('free-parking.json') ? '실데이터' : '시드'})`);
}
migrateSeeds();

// ── HTTP helpers ──────────────────────────────────────────────────────────────
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); req.on('error', () => resolve('')); });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ── API ───────────────────────────────────────────────────────────────────────
async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  if (url.pathname === '/api/health') return json(res, 200, { ok: true, mode: 'server', count: stmtCount.get().n });

  if (url.pathname === '/api/spots' && req.method === 'GET') {
    let bbox = null;
    const b = url.searchParams.get('bbox');
    if (b) { const p = b.split(',').map(Number); if (p.length === 4 && p.every((x) => Number.isFinite(x))) bbox = p; }
    const cats = (url.searchParams.get('cat') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return json(res, 200, { type: 'FeatureCollection', features: querySpots(bbox, cats) });
  }

  if (url.pathname === '/api/spots' && req.method === 'POST') {
    const form = parse(await readBody(req));
    if (!form) return json(res, 400, { errors: ['잘못된 요청 본문'] });
    delete form.id; // 신규 — 서버가 id 생성
    const { errors, feature } = buildFeature(form);
    if (errors.length) return json(res, 400, { errors });
    saveFeature(feature);
    return json(res, 201, { feature });
  }

  const m = url.pathname.match(/^\/api\/spots\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const row = stmtGet.get(id);
    if (!row) return json(res, 404, { errors: ['존재하지 않는 제보'] });
    if (!row.editable) return json(res, 403, { errors: ['공식 데이터는 수정할 수 없습니다'] });

    if (req.method === 'PATCH') {
      const form = parse(await readBody(req));
      if (!form) return json(res, 400, { errors: ['잘못된 요청 본문'] });
      form.id = id;
      const { errors, feature } = buildFeature(form);
      if (errors.length) return json(res, 400, { errors });
      saveFeature(feature);
      return json(res, 200, { feature });
    }
    if (req.method === 'DELETE') { stmtDel.run(id); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { errors: ['not found'] });
}
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ── 정적 서빙 ─────────────────────────────────────────────────────────────────
function serveStatic(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const full = normalize(join(ROOT, path));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url).catch((e) => json(res, 500, { errors: [String(e)] }));
  else serveStatic(req, res, url);
}).listen(PORT, () => console.log(`▶ 공유 무료주차맵 서버(멀티플레이): http://localhost:${PORT}  (DB: ${DB_PATH})`));
