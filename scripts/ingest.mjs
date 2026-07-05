// ────────────────────────────────────────────────────────────────────────────
// 공공데이터 → 무료주차 GeoJSON 인제스트 (Phase 1 ETL 스켈레톤)
//
// 소스: 전국주차장정보표준데이터 (data.go.kr 15012896)
//   - 무료 필터 → free_rules 정규화 → data/free-parking.json 출력
//
// 실행:  SERVICE_KEY=발급받은키 node scripts/ingest.mjs
//   (data.go.kr 무료 개발계정에서 서비스키 발급 후 사용)
//
// ⚠️ 필드명 확인 필요: 리서치 시 data.go.kr 이 봇 요청에 403 을 반환해
//    Open API 영문 태그명은 상세기능정보 페이지에서 1회 대조 후 확정할 것.
//    (아래 FIELD 매핑은 표준데이터 스키마 기준 추정치)
// ────────────────────────────────────────────────────────────────────────────
import { writeFile } from 'node:fs/promises';

const SERVICE_KEY = process.env.SERVICE_KEY;
const BASE = 'https://api.odcloud.kr/api/15012896/v1/uddi'; // ← 실제 엔드포인트는 상세페이지에서 확인
const OUT = new URL('../data/free-parking.json', import.meta.url);

// 표준데이터 컬럼 → 내부 스키마 (확정 전 추정 매핑)
const FIELD = {
  name: '주차장명',
  gubun: '주차장구분',      // 공영/민영
  type: '주차장유형',       // 노상/노외/부설
  addrRoad: '소재지도로명주소',
  addrJibun: '소재지지번주소',
  spaces: '주차구획수',
  fee: '요금정보',          // 무료/유료/혼합  ← 1차 필터
  baseTime: '주차기본시간(분 단위)',
  baseFee: '주차기본요금',
  wdStart: '평일운영시작시각', wdEnd: '평일운영종료시각',
  satStart: '토요일운영시작시각', satEnd: '토요일운영종료시각',
  holStart: '공휴일운영시작시각', holEnd: '공휴일운영종료시각',
  lat: '위도', lng: '경도',
  org: '관리기관명', tel: '전화번호', asof: '데이터기준일자',
  pk: '주차장관리번호',
};

const hm = (v) => (v == null || v === '' ? null : String(v).replace(/^(\d{1,2}):?(\d{2})$/, (_, h, m) => `${h.padStart(2, '0')}:${m}`));

// 요금 플래그 + 운영시간 → free_rules 파생
function deriveRules(row) {
  const fee = String(row[FIELD.fee] || '').trim();
  const baseFee = Number(row[FIELD.baseFee] || 0);
  const isFree = fee === '무료' || (fee !== '유료' && baseFee === 0);
  if (!isFree && fee !== '혼합') return null; // 무료/혼합만 통과

  const rules = [];
  const push = (day, s, e) => {
    if (fee === '무료') rules.push({ day_type: day, start: hm(s), end: hm(e), fee_type: (s || e) ? '시간대무료' : '상시무료' });
    else if (row[FIELD.baseTime] && baseFee === 0) rules.push({ day_type: day, fee_type: '최초N분무료', first_free_minutes: Number(row[FIELD.baseTime]) });
    // fee === '혼합' 이고 규칙 판단 불가 → free_rules 비움(재검증 큐로)
  };
  push('평일', row[FIELD.wdStart], row[FIELD.wdEnd]);
  push('토요일', row[FIELD.satStart], row[FIELD.satEnd]);
  push('공휴일', row[FIELD.holStart], row[FIELD.holEnd]);
  return rules.length ? rules : (fee === '무료' ? [{ day_type: '전일', fee_type: '상시무료' }] : []);
}

function toFeature(row) {
  const rules = deriveRules(row);
  if (!rules) return null;
  const lat = Number(row[FIELD.lat]), lng = Number(row[FIELD.lng]);
  if (!(lat > 33 && lat < 39 && lng > 124 && lng < 132)) return null; // KR bbox 검증
  const gubun = row[FIELD.gubun] || '';
  const type = row[FIELD.type] || '';
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      id: `dg-${row[FIELD.pk] || `${lat},${lng}`}`,
      category: 'legal_free',
      kind: gubun.includes('공영') ? '공영' : gubun.includes('민영') ? '민영' : (type.includes('부설') ? '부설' : '공영'),
      free_type: rules.some((r) => r.fee_type === '최초N분무료') ? '시간제무료'
        : rules.every((r) => r.fee_type === '상시무료') ? '상시무료' : '시간제무료',
      name: row[FIELD.name] || '무료주차장',
      address: row[FIELD.addrRoad] || row[FIELD.addrJibun] || '',
      num_spaces: Number(row[FIELD.spaces]) || null,
      managing_org: row[FIELD.org] || '',
      source: 'official',
      source_dataset: '15012896',
      parking_mgmt_no: row[FIELD.pk] || null,
      verify: { status: 'verified', check_date: row[FIELD.asof] || null, confidence: 0.8 },
      free_rules: rules,
    },
  };
}

async function fetchPage(page, perPage = 1000) {
  const url = `${BASE}?page=${page}&perPage=${perPage}&serviceKey=${encodeURIComponent(SERVICE_KEY)}&returnType=JSON`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — 엔드포인트/서비스키 확인 필요`);
  return res.json();
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('SERVICE_KEY 환경변수가 필요합니다.\n' +
      '  1) https://www.data.go.kr/data/15012896/ 에서 활용신청 → 서비스키 발급\n' +
      '  2) SERVICE_KEY=... node scripts/ingest.mjs\n' +
      '  3) BASE/FIELD(영문 태그) 를 상세기능정보로 1회 대조 후 확정\n' +
      '지금은 예시 시드(data/*.seed.json)로 앱이 동작합니다.');
    process.exit(1);
  }
  const features = [];
  for (let page = 1; ; page++) {
    const json = await fetchPage(page);
    const rows = json.data || json.records || [];
    if (!rows.length) break;
    for (const row of rows) { const f = toFeature(row); if (f) features.push(f); }
    console.log(`page ${page}: 누적 ${features.length}건`);
    if (rows.length < 1000) break;
  }
  const fc = { type: 'FeatureCollection', meta: { layer: 'legal_free', source: '15012896', seed: false }, features };
  await writeFile(OUT, JSON.stringify(fc, null, 0));
  console.log(`✅ ${features.length}건 → ${OUT.pathname}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
