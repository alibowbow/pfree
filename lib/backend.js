// ────────────────────────────────────────────────────────────────────────────
// 프런트 데이터 계층 — 공유 서버 모드 ↔ 로컬(정적) 모드 자동 전환
//   서버가 있으면(GET /api/health) 모든 제보를 공유 서버에서 읽고 쓴다(멀티플레이).
//   서버가 없으면(python -m http.server 등) 기존처럼 시드 JSON + localStorage.
// ────────────────────────────────────────────────────────────────────────────
let SERVER = null; // true=공유 서버, false=로컬

export function isServer() { return SERVER === true; }

export async function detectServer() {
  try {
    const r = await fetch('./api/health', { cache: 'no-store' });
    SERVER = r.ok;
  } catch {
    SERVER = false;
  }
  return SERVER;
}

/** 뷰포트(bbox)로 스팟을 읽는다. 서버 모드 전용. bbox = [minLng,minLat,maxLng,maxLat] */
export async function apiLoad(bbox) {
  const q = bbox ? `?bbox=${bbox.join(',')}` : '';
  const fc = await fetch(`./api/spots${q}`, { cache: 'no-store' }).then((r) => r.json());
  return fc.features || [];
}

/** 제보 폼 → 서버 생성. { errors, feature } 반환(로컬 buildFeature와 동일 형태) */
export async function apiCreate(form) {
  const r = await fetch('./api/spots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
  const j = await r.json();
  return r.ok ? { errors: [], feature: j.feature } : { errors: j.errors || ['서버 오류'], feature: null };
}

export async function apiUpdate(id, form) {
  const r = await fetch(`./api/spots/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
  const j = await r.json();
  return r.ok ? { errors: [], feature: j.feature } : { errors: j.errors || ['서버 오류'], feature: null };
}

export async function apiDelete(id) {
  const r = await fetch(`./api/spots/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true } : { ok: false, errors: j.errors || ['서버 오류'] };
}
