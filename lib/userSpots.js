// ────────────────────────────────────────────────────────────────────────────
// 사용자 제보(크라우드소싱) — 순수 로직 (검증 · 안전가드 · 규칙 정규화 · 저장)
// UI/localStorage 와 분리해 테스트 가능하게 유지한다.
// ────────────────────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'pfree.userSpots.v1';
export const KR_BBOX = { minLat: 33, maxLat: 39, minLng: 124, maxLng: 132 };
export const CATEGORIES = ['legal_free', 'gray_zone', 'no_parking'];

function isoDate(now) {
  const d = now != null ? new Date(now) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 유효 규칙만 남기고 시간/숫자를 정리 */
export function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const r of rules) {
    if (!r || !r.fee_type) continue;
    const rule = { day_type: r.day_type || '전일', fee_type: r.fee_type };
    if (r.fee_type === '최초N분무료') {
      rule.first_free_minutes = Number(r.first_free_minutes) || 30;
      if (r.fee_info) rule.fee_info = String(r.fee_info).trim();
    } else if (r.fee_type === '상시무료') {
      // 시간창 없음
    } else {
      // 시간대무료 / 유료
      if (r.start) rule.start = String(r.start).trim();
      if (r.end) rule.end = String(r.end).trim();
      if (r.fee_type === '유료' && r.fee_info) rule.fee_info = String(r.fee_info).trim();
    }
    out.push(rule);
  }
  return out;
}

/** 폼 유효성 검증 → 오류 메시지 배열(빈 배열이면 통과) */
export function validateSpotForm(form) {
  const e = [];
  if (!form || !form.name || !String(form.name).trim()) e.push('이름을 입력하세요.');
  const lat = Number(form.lat), lng = Number(form.lng);
  if (!(lat > KR_BBOX.minLat && lat < KR_BBOX.maxLat && lng > KR_BBOX.minLng && lng < KR_BBOX.maxLng)) {
    e.push('한국 내 좌표가 아닙니다. 지도를 클릭해 위치를 지정하세요.');
  }
  if (!CATEGORIES.includes(form.category)) e.push('분류를 선택하세요.');
  if (form.category === 'legal_free') {
    if (!normalizeRules(form.free_rules).length) e.push('무료 규칙을 최소 1개 추가하세요.');
  }
  if (form.category === 'gray_zone' && !form.not_safety_critical) {
    e.push('안전 치명 구역(소화전·스쿨존·횡단보도·버스정류소·교차로)이 아님을 확인해야 등록됩니다.');
  }
  return e;
}

/** 폼 → GeoJSON Feature. { errors, feature } 반환. 결정적 테스트를 위해 opts 로 id/시각 주입 가능. */
export function buildFeature(form, opts = {}) {
  const errors = validateSpotForm(form);
  if (errors.length) return { errors, feature: null };

  const lat = Number(form.lat), lng = Number(form.lng);
  const id = form.id || opts.id || `u-${opts.now || Date.now()}-${Math.floor((opts.rand != null ? opts.rand : Math.random()) * 1e6)}`;
  const props = {
    id,
    category: form.category,
    name: String(form.name).trim(),
    note: String(form.note || '').trim(),
    source: 'crowd',
    editable: true,
    verify: { status: 'user', check_date: opts.date || isoDate(opts.now), confidence: 0.4 },
  };

  if (form.category === 'legal_free') {
    props.kind = form.kind || '기타';
    props.free_type = form.free_type || '시간제무료';
    const n = Number(form.num_spaces);
    if (n > 0) props.num_spaces = n;
    props.free_rules = normalizeRules(form.free_rules);
  } else {
    props.kind = form.category === 'no_parking' ? '금지구역' : '회색지대';
    props.risk = {
      zone_type: String(form.risk_zone_type || '').trim() || '주정차금지 구역',
      fine: String(form.risk_fine || '').trim() || '과태료 부과 대상',
      citizen_report: true,
      safety_critical: form.category === 'no_parking',
    };
  }
  return { errors: [], feature: { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props } };
}

/** Feature → 폼 초기값(편집용) */
export function featureToForm(feature) {
  const p = feature.properties || {};
  const [lng, lat] = feature.geometry.coordinates;
  return {
    id: p.id,
    name: p.name || '',
    category: p.category || 'legal_free',
    kind: p.kind || '',
    free_type: p.free_type || '시간제무료',
    num_spaces: p.num_spaces || '',
    note: p.note || '',
    free_rules: (p.free_rules || []).map((r) => ({ ...r })),
    risk_zone_type: p.risk ? p.risk.zone_type : '',
    risk_fine: p.risk ? p.risk.fine : '',
    not_safety_critical: p.category === 'gray_zone', // 이미 등록된 회색지대는 확인된 것으로 간주
    lat, lng,
  };
}

/** id 기준 upsert (불변) */
export function upsertFeature(list, feature) {
  const id = feature.properties.id;
  const next = list.filter((f) => f.properties.id !== id);
  next.push(feature);
  return next;
}

/** id 기준 삭제 (불변) */
export function removeFeature(list, id) {
  return list.filter((f) => f.properties.id !== id);
}

// ── localStorage (브라우저) ─────────────────────────────────────────────────
export function loadUserSpots(storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveUserSpots(features, storage) {
  const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return;
  s.setItem(STORAGE_KEY, JSON.stringify(features));
}
