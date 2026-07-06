import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const DB = new URL('../data/spots.test.db', import.meta.url).pathname;
let proc;

before(async () => {
  rmSync(DB, { force: true });
  proc = spawn('node', ['scripts/server.mjs'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB }, stdio: 'ignore' });
  // health가 뜰 때까지 대기
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('server did not start');
});

after(() => { proc?.kill(); rmSync(DB, { force: true }); });

const seoul = { lat: 37.5665, lng: 126.9769 };

test('health + 시드 마이그레이션', async () => {
  const j = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(j.ok, true);
  assert.ok(j.count >= 15, `시드 15곳 이상이어야 함, got ${j.count}`);
});

test('GET /api/spots bbox 필터', async () => {
  const all = await fetch(`${BASE}/api/spots`).then((r) => r.json());
  assert.ok(all.features.length >= 15);
  // 서울 좁은 bbox → 부산(129.x) 제외
  const seoulBox = await fetch(`${BASE}/api/spots?bbox=126.8,37.4,127.1,37.7`).then((r) => r.json());
  const lngs = seoulBox.features.map((f) => f.geometry.coordinates[0]);
  assert.ok(lngs.every((x) => x >= 126.8 && x <= 127.1), 'bbox 밖 좌표가 섞이면 안 됨');
  assert.ok(all.features.length > seoulBox.features.length, 'bbox가 전체보다 적어야 함');
});

test('POST → 공유 저장 후 다른 조회에서 보임(멀티플레이)', async () => {
  const r = await fetch(`${BASE}/api/spots`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '공유 테스트', category: 'legal_free', free_type: '상시무료', free_rules: [{ day_type: '전일', fee_type: '상시무료' }], ...seoul }),
  });
  assert.equal(r.status, 201);
  const { feature } = await r.json();
  assert.ok(feature.properties.id);
  assert.equal(feature.properties.source, 'crowd');
  // 다른 조회(좁은 bbox)에서 방금 올린 제보가 보여야 함 — 전체 개수는 서버 LIMIT 영향받으므로 존재 여부로 검증
  const box = await fetch(`${BASE}/api/spots?bbox=${seoul.lng - 0.01},${seoul.lat - 0.01},${seoul.lng + 0.01},${seoul.lat + 0.01}`).then((x) => x.json());
  assert.ok(box.features.some((f) => f.properties.id === feature.properties.id), '올린 제보가 bbox 조회에 나와야 함');
});

test('안전 가드 서버측 강제 — gray_zone 확인 없이 400', async () => {
  const r = await fetch(`${BASE}/api/spots`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '골목', category: 'gray_zone', ...seoul }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(j.errors.some((m) => /안전 치명 구역/.test(m)));
});

test('PATCH / DELETE 는 editable 스팟만', async () => {
  // 시드(공식, editable=false) 하나 집어 PATCH 시도 → 403
  const feats = (await fetch(`${BASE}/api/spots`).then((r) => r.json())).features;
  const seed = feats.find((f) => !f.properties.editable);
  assert.ok(seed, '공식 시드가 있어야 함');
  const forbidden = await fetch(`${BASE}/api/spots/${encodeURIComponent(seed.properties.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '해킹', category: 'legal_free', free_rules: [{ fee_type: '상시무료' }], ...seoul }),
  });
  assert.equal(forbidden.status, 403);

  // 사용자 제보 생성 → PATCH → DELETE
  const created = await fetch(`${BASE}/api/spots`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '수정대상', category: 'legal_free', free_rules: [{ day_type: '전일', fee_type: '상시무료' }], ...seoul }),
  }).then((r) => r.json());
  const id = created.feature.properties.id;

  const patched = await fetch(`${BASE}/api/spots/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name: '수정됨', category: 'legal_free', free_rules: [{ day_type: '전일', fee_type: '상시무료' }], ...seoul }),
  }).then((r) => r.json());
  assert.equal(patched.feature.properties.name, '수정됨');

  const del = await fetch(`${BASE}/api/spots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const gone = (await fetch(`${BASE}/api/spots`).then((r) => r.json())).features.find((f) => f.properties.id === id);
  assert.equal(gone, undefined);
});
