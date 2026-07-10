// ────────────────────────────────────────────────────────────────────────────
// 공공데이터 → 무료·저가주차 GeoJSON 변환 (순수 로직, 테스트 가능)
//   입력: 전국주차장정보표준데이터(data.go.kr 15012896) CSV/JSON 행
//   출력: 무료(legal_free) + 저가(low_cost, 1시간 요금 ≤ 임계) 필터 +
//         free_rules 정규화(특기사항 시간조건 파싱 포함)한 GeoJSON Feature
//   컬럼 순서/인코딩에 견고하도록 헤더명 매칭.
// ────────────────────────────────────────────────────────────────────────────

// 논리 컬럼 → 표준데이터 헤더 후보(정확일치 우선, 없으면 startsWith 매칭)
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
  unitTime: ['추가단위시간'],
  unitFee: ['추가단위요금'],
  dailyFee: ['1일주차권요금'],
  monthlyFee: ['월정기권요금'],
  remark: ['특기사항'],
  org: ['관리기관명'],
  tel: ['전화번호'],
  lat: ['위도'],
  lng: ['경도'],
  asof: ['데이터기준일자'],
  wdS: ['평일운영시작시각'], wdE: ['평일운영종료시각'],
  satS: ['토요일운영시작시각'], satE: ['토요일운영종료시각'],
  holS: ['공휴일운영시작시각'], holE: ['공휴일운영종료시각'],
};

// "저가주차" 임계: 1시간 예상 요금이 이 값(원) 이하이면 low_cost 로 포함.
// (도심 유료는 보통 시간당 2,000~6,000원 — 확실히 저렴한 1,000원 이하만. 엄격 기준.)
export const LOW_COST_MAX_WON = 1000;

/** 'H:MM'/'HH:MM' 정규화. 빈 값 → null */
const hm = (v) => {
  const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

/** 요일별 운영시각 → 사람이 읽는 요약 ('24시간' / '매일 09:00~18:00' / '평일 09:00~18:00 · 주말·공휴일 …') */
export function hoursText(get) {
  const span = (s, e) => {
    const a = hm(get(s)), b = hm(get(e));
    if (!a || !b) return null;
    if ((a === '00:00' && (b === '23:59' || b === '24:00')) ) return '24시간';
    return `${a}~${b}`;
  };
  const wd = span('wdS', 'wdE'), sat = span('satS', 'satE'), hol = span('holS', 'holE');
  if (!wd && !sat && !hol) return undefined;
  if (wd && wd === sat && sat === hol) return wd === '24시간' ? '24시간' : `매일 ${wd}`;
  const parts = [];
  if (wd) parts.push(`평일 ${wd}`);
  if (sat && hol && sat === hol) parts.push(`주말·공휴일 ${sat}`);
  else { if (sat) parts.push(`토 ${sat}`); if (hol) parts.push(`공휴일 ${hol}`); }
  return parts.join(' · ') || undefined;
}

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

/** 헤더에서 논리 컬럼의 실제 헤더명을 찾아 접근자 반환 (정확일치 우선) */
export function makeGetter(headers, row) {
  const idx = {};
  for (const [key, cands] of Object.entries(COLS)) {
    idx[key] = headers.find((h) => cands.includes(h))
      || headers.find((h) => cands.some((c) => h.startsWith(c)))
      || null;
  }
  return (key) => (idx[key] ? (row[idx[key]] ?? '') : '');
}

const num = (v) => { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : NaN; };

/** 요금 구조 추출(숫자 필드만). 빈 값/없는 컬럼 → undefined(Number('')===0 오염 방지). 전부 비면 undefined. */
export function feeStructure(get) {
  const g = (k) => {
    const raw = String(get(k) ?? '').trim();
    if (raw === '') return undefined;
    const n = num(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const fs = {
    base_time: g('baseTime'), base_fee: g('baseFee'),
    unit_time: g('unitTime'), unit_fee: g('unitFee'),
    daily_fee: g('dailyFee'), monthly_fee: g('monthlyFee'),
  };
  return Object.values(fs).some((v) => v !== undefined) ? fs : undefined;
}

/** 1시간 예상 요금(원). 계산 불가(기본시간·요금 미상) 시 null. */
export function firstHourWon(fs) {
  if (!fs) return null;
  const bt = fs.base_time, bf = fs.base_fee;
  if (!(bt > 0) || !(bf > 0)) return null;
  // 기본요금은 기본시간 '창' 전체의 최소요금 — 기본시간이 1시간 이상이면 1시간(<기본시간)도 기본요금 전액.
  if (bt >= 60) return Math.round(bf);
  const ut = fs.unit_time, uf = fs.unit_fee;
  if (ut > 0 && uf >= 0) return bf + Math.ceil((60 - bt) / ut) * uf; // 기본 + 추가단위 누적
  return Math.round(bf * (60 / bt));                          // 추가단위 정보 없음 → 기본요금 비례 추정
}

/** 유료 요금을 사람이 읽는 짧은 문구 ('30분 500원 · 이후 30분당 500원') */
function feeInfoText(fs) {
  if (!fs) return undefined;
  const parts = [];
  if (fs.base_time > 0 && fs.base_fee >= 0) parts.push(`${fs.base_time}분 ${fs.base_fee.toLocaleString('ko-KR')}원`);
  if (fs.unit_time > 0 && fs.unit_fee >= 0) parts.push(`이후 ${fs.unit_time}분당 ${fs.unit_fee.toLocaleString('ko-KR')}원`);
  return parts.join(' · ') || undefined;
}

const ruleKey = (r) => `${r.day_type}|${r.fee_type}|${r.start || ''}|${r.end || ''}`;
/** 규칙 병합(중복 제거, 순서 유지) — 무료 창(specific)이 유료 베이스보다 앞서야 엔진이 무료를 우선 판정 */
function mergeRules(...lists) {
  const out = [], seen = new Set();
  for (const list of lists) for (const r of (list || [])) {
    const k = ruleKey(r);
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

// 특기사항 무료문구 뒤 부정어(무료(주차) 아님/없음/불가/안됨…) 배제 — 오파싱 방지.
// '무료' 직후뿐 아니라 명사(무료주차/무료개방 등) 뒤에 오는 부정어까지 잡도록 최대 6자 창을 본다.
const NEG = '(?![^,·]{0,6}(?:아님|아닙|없음|없이|불가|제외|안\\s*[됨함돼되]))';
const freeAfter = (kw) => new RegExp(`${kw}[^,·]{0,6}무료${NEG}`);

/**
 * 특기사항 자유텍스트 → 명확한 시간조건 무료 규칙만 보수적으로 추출.
 * 애매하면 규칙을 만들지 않는다(오파싱 < 미검출). 반환: free_rules 배열(빈 배열 가능).
 * 각 규칙에 source_text:'특기사항' 표기(신뢰도 하향·"추정" 표기 근거).
 */
export function parseRemarkRules(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const rules = [];
  const push = (r) => { if (!rules.some((x) => ruleKey(x) === ruleKey(r))) rules.push({ ...r, source_text: '특기사항' }); };

  // 공휴일·명절·주말·일요일 무료 개방 → 해당 요일 상시무료
  if (freeAfter('(?:공휴일|명절|설날?|추석)').test(t)) push({ day_type: '공휴일', fee_type: '상시무료' });
  if (freeAfter('(?:주말|토[·,]?일)').test(t)) push({ day_type: '주말', fee_type: '상시무료' });
  else if (freeAfter('일요일').test(t)) push({ day_type: '일요일', fee_type: '상시무료' });

  // (평일)? (오후)? N시 이후/부터 무료 → 야간 시간대무료 N:00~24:00
  const m = t.match(new RegExp(`(평일)?\\s*(오후\\s*)?(\\d{1,2})\\s*시\\s*(?:이후|부터)\\s*무료${NEG}`));
  if (m) {
    let h = Number(m[3]); if (m[2] && h < 12) h += 12;
    if (h >= 0 && h <= 23) push({ day_type: m[1] ? '평일' : '전일', fee_type: '시간대무료', start: `${String(h).padStart(2, '0')}:00`, end: '24:00' });
  } else if (freeAfter('야간').test(t)) {
    push({ day_type: '전일', fee_type: '시간대무료', start: '20:00', end: '08:00' }); // 시각 불명 시 관례
  }

  // 최초 N분/시간 무료
  const fm = t.match(/최초\s*(\d{1,3})\s*(분|시간)\s*무료/);
  if (fm) {
    const n = Number(fm[1]) * (fm[2] === '시간' ? 60 : 1);
    if (n > 0 && n <= 24 * 60) push({ day_type: '전일', fee_type: '최초N분무료', first_free_minutes: n });
  }
  return rules;
}

/**
 * 한 행을 무료/저가로 분류.
 * @returns {{category:('legal_free'|'low_cost'|null), free_rules:(object[]|null), fee_structure, first_hour_won:(number|null)}}
 */
export function classifySpot(get) {
  const fee = String(get('fee') || '').trim();
  const baseFee = num(get('baseFee'));
  const baseTime = num(get('baseTime'));
  const fs = feeStructure(get);
  const remarkRules = parseRemarkRules(get('remark'));

  // 1) 명시적 무료(또는 유료/혼합이 아니면서 기본요금 0)
  if (fee === '무료' || (fee !== '유료' && fee !== '혼합' && baseFee === 0)) {
    return { category: 'legal_free', free_rules: [{ day_type: '전일', fee_type: '상시무료' }], fee_structure: fs, first_hour_won: 0 };
  }
  // 2) 혼합 + 기본요금 0 + 기본시간>0 → 최초 N분 무료(+특기 무료창 병합)
  if (fee === '혼합' && baseFee === 0 && baseTime > 0) {
    return {
      category: 'legal_free',
      free_rules: mergeRules(remarkRules, [{ day_type: '전일', fee_type: '최초N분무료', first_free_minutes: baseTime }]),
      fee_structure: fs, first_hour_won: 0,
    };
  }
  // 3) 유료/혼합 — 1시간 요금이 저가 임계 이하면 low_cost(특기 무료창 + 유료 베이스)
  if (fee === '유료' || fee === '혼합') {
    const fhw = firstHourWon(fs);
    if (fhw != null && fhw <= LOW_COST_MAX_WON) {
      const base = [{ day_type: '전일', fee_type: '유료', fee_info: feeInfoText(fs) }];
      return { category: 'low_cost', free_rules: mergeRules(remarkRules, base), fee_structure: fs, first_hour_won: fhw };
    }
    return { category: null, free_rules: null, fee_structure: fs, first_hour_won: fhw };
  }
  return { category: null, free_rules: null, fee_structure: fs, first_hour_won: firstHourWon(fs) };
}

/** (하위호환) 무료 판정 + free_rules 파생. 무료(legal_free) 아니면 null. */
export function deriveFreeRules(get) {
  const cls = classifySpot(get);
  return cls.category === 'legal_free' ? cls.free_rules : null;
}

const KR = { minLat: 33, maxLat: 39.6, minLng: 124, maxLng: 132 };

/** 표준데이터 행 → GeoJSON Feature (무료·저가·유효좌표만). 아니면 null. */
export function rowToFeature(headers, row) {
  const get = makeGetter(headers, row);
  const cls = classifySpot(get);
  if (!cls.category) return null;
  const lat = num(get('lat')), lng = num(get('lng'));
  if (!(lat > KR.minLat && lat < KR.maxLat && lng > KR.minLng && lng < KR.maxLng)) return null;

  const gubun = String(get('gubun') || ''), type = String(get('type') || '');
  const kind = gubun.includes('공영') ? '공영' : gubun.includes('민영') ? '민영' : (type.includes('부설') ? '부설' : '공영');
  const isLow = cls.category === 'low_cost';
  const freeType = isLow ? undefined : (cls.free_rules.some((r) => r.fee_type === '최초N분무료') ? '시간제무료' : '상시무료');
  const spaces = num(get('spaces'));
  const mgmt = String(get('mgmtNo') || '').trim();

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      id: `dg-${mgmt || `${lat.toFixed(6)},${lng.toFixed(6)}`}`,
      category: cls.category,
      kind,
      free_type: freeType,
      first_hour_won: isLow ? cls.first_hour_won : undefined,
      fee_structure: isLow ? cls.fee_structure : undefined,
      name: String(get('name') || (isLow ? '저가주차장' : '무료주차장')).trim(),
      address: String(get('addrRoad') || get('addrJibun') || '').trim(),
      num_spaces: Number.isFinite(spaces) && spaces > 0 ? spaces : undefined,
      managing_org: String(get('org') || '').trim(),
      tel: (/\d/.test(String(get('tel') || '')) ? String(get('tel')).trim() : undefined),
      hours: hoursText(get),
      source: 'official',
      source_dataset: '15012896',
      parking_mgmt_no: mgmt || undefined,
      verify: { status: 'verified', check_date: String(get('asof') || '').trim() || null, confidence: isLow ? 0.7 : 0.8 },
      free_rules: cls.free_rules,
    },
  };
}

/** 표준데이터 행 배열(객체) → { features, stats } */
export function rowsToFeatures(headers, rows) {
  const seen = new Set();
  const features = [];
  let free = 0, lowCost = 0, badCoord = 0;
  for (const row of rows) {
    const get = makeGetter(headers, row);
    const cls = classifySpot(get);
    if (!cls.category) continue;
    if (cls.category === 'legal_free') free++; else lowCost++;
    const f = rowToFeature(headers, row);
    if (!f) { badCoord++; continue; }
    if (seen.has(f.properties.id)) continue;
    seen.add(f.properties.id);
    features.push(f);
  }
  return { features, stats: { total: rows.length, free, lowCost, badCoord, kept: features.length } };
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
