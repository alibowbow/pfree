// ────────────────────────────────────────────────────────────────────────────
// 공공데이터 → 무료주차 GeoJSON 변환 (순수 로직, 테스트 가능)
//   입력: 전국주차장정보표준데이터(data.go.kr 15012896) CSV/JSON 행
//   출력: 무료만 필터 + free_rules 정규화한 GeoJSON Feature
//   컬럼 순서/인코딩에 견고하도록 헤더명 매칭.
// ────────────────────────────────────────────────────────────────────────────

// 논리 컬럼 → 표준데이터 헤더 후보(startsWith 매칭)
const COLS = {
  mgmtNo: ['주차장관리번호'],
  name: ['주차장명'],
  gubun: ['주차장구분'],
  type: ['주차장유형'],
  addrRoad: ['소재지도로명주소'],
  addrJibun: ['소재지지번주소'],
  spaces: ['주차구획수'],
  fee: ['요금정보'],
  baseTime: ['주차기본시간'],
  baseFee: ['주차기본요금'],
  org: ['관리기관명'],
  tel: ['전화번호'],
  lat: ['위도'],
  lng: ['경도'],
  asof: ['데이터기준일자'],
};

/** RFC4180 CSV 파서 (따옴표·콤마·CRLF 처리) → { headers, rows(객체 배열) } */
export function parseCsv(text) {
  const t = text.replace(/^﻿/, ''); // BOM 제거
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const objs = rows.slice(1).filter((r) => r.some((v) => v !== '')).map((r) => {
    const o = {}; headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); }); return o;
  });
  return { headers, rows: objs };
}

/** 헤더에서 논리 컬럼의 실제 헤더명을 찾아 접근자 반환 */
export function makeGetter(headers, row) {
  const idx = {};
  for (const [key, cands] of Object.entries(COLS)) {
    idx[key] = headers.find((h) => cands.some((c) => h === c || h.startsWith(c))) || null;
  }
  return (key) => (idx[key] ? (row[idx[key]] ?? '') : '');
}

const num = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };

/** 무료 판정 + free_rules 파생. 무료 아니면 null. */
export function deriveFreeRules(get) {
  const fee = String(get('fee') || '').trim();
  const baseFee = num(get('baseFee'));
  const baseTime = num(get('baseTime'));
  if (fee === '무료' || (fee !== '유료' && fee !== '혼합' && baseFee === 0)) {
    return [{ day_type: '전일', fee_type: '상시무료' }];
  }
  if (fee === '혼합' && baseFee === 0 && baseTime > 0) {
    return [{ day_type: '전일', fee_type: '최초N분무료', first_free_minutes: baseTime }];
  }
  return null; // 유료/불명 → 제외
}

const KR = { minLat: 33, maxLat: 39.6, minLng: 124, maxLng: 132 };

/** 표준데이터 행 → GeoJSON Feature (무료·유효좌표만). 아니면 null. */
export function rowToFeature(headers, row) {
  const get = makeGetter(headers, row);
  const rules = deriveFreeRules(get);
  if (!rules) return null;
  const lat = num(get('lat')), lng = num(get('lng'));
  if (!(lat > KR.minLat && lat < KR.maxLat && lng > KR.minLng && lng < KR.maxLng)) return null;

  const gubun = String(get('gubun') || ''), type = String(get('type') || '');
  const kind = gubun.includes('공영') ? '공영' : gubun.includes('민영') ? '민영' : (type.includes('부설') ? '부설' : '공영');
  const freeType = rules.some((r) => r.fee_type === '최초N분무료') ? '시간제무료' : '상시무료';
  const spaces = num(get('spaces'));
  const mgmt = String(get('mgmtNo') || '').trim();

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      id: `dg-${mgmt || `${lat.toFixed(6)},${lng.toFixed(6)}`}`,
      category: 'legal_free',
      kind,
      free_type: freeType,
      name: String(get('name') || '무료주차장').trim(),
      address: String(get('addrRoad') || get('addrJibun') || '').trim(),
      num_spaces: Number.isFinite(spaces) && spaces > 0 ? spaces : undefined,
      managing_org: String(get('org') || '').trim(),
      source: 'official',
      source_dataset: '15012896',
      parking_mgmt_no: mgmt || undefined,
      verify: { status: 'verified', check_date: String(get('asof') || '').trim() || null, confidence: 0.8 },
      free_rules: rules,
    },
  };
}

/** 표준데이터 행 배열(객체) → { features, stats } */
export function rowsToFeatures(headers, rows) {
  const seen = new Set();
  const features = [];
  let free = 0, badCoord = 0;
  for (const row of rows) {
    const get = makeGetter(headers, row);
    if (!deriveFreeRules(get)) continue;
    free++;
    const f = rowToFeature(headers, row);
    if (!f) { badCoord++; continue; }
    if (seen.has(f.properties.id)) continue;
    seen.add(f.properties.id);
    features.push(f);
  }
  return { features, stats: { total: rows.length, free, badCoord, kept: features.length } };
}

/** CSV 텍스트 → { features, stats } */
export function csvToFeatures(text) {
  const { headers, rows } = parseCsv(text);
  return rowsToFeatures(headers, rows);
}

/** 헤더가 표준데이터로 보이는가(인코딩/포맷 점검용) */
export function looksLikeStandard(headers) {
  return headers.some((h) => h.startsWith('주차장명')) && headers.some((h) => h === '위도' || h.startsWith('위도'));
}
