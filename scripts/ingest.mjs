// ────────────────────────────────────────────────────────────────────────────
// 전국 무료주차 실데이터 인제스트
//   원천: 전국주차장정보표준데이터 (data.go.kr 15012896)
//   → 무료만 필터 + free_rules 정규화 → data/free-parking.json 출력
//     (앱과 서버가 이 파일이 있으면 시드 대신 자동으로 사용)
//
//   ▶ 방법 1 (권장·키 불필요): CSV/JSON 파일로
//       1) https://www.data.go.kr/data/15012896/standard.do → '다운로드'(CSV)
//       2) node scripts/ingest.mjs 전국주차장정보표준데이터.csv
//          (EUC-KR/UTF-8, CSV/JSON 자동 처리)
//
//   ▶ 방법 2 (Open API): 활용신청 후 서비스키로
//       SERVICE_KEY=발급키 API_URL='https://api.odcloud.kr/api/15012896/v1/uddi:...' \
//         node scripts/ingest.mjs
// ────────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { csvToFeatures, rowsToFeatures, looksLikeStandard, parseCsv } from '../lib/ingest.js';

const OUT = fileURLToPath(new URL('../data/free-parking.json', import.meta.url));

function decodeBuffer(buf) {
  // UTF-8 우선, 한글 헤더가 깨지면 EUC-KR/CP949 재시도(Node full-ICU)
  let text = new TextDecoder('utf-8').decode(buf);
  if (!/주차장|위도/.test(text.slice(0, 4000))) {
    try { text = new TextDecoder('euc-kr').decode(buf); } catch {}
  }
  return text;
}

function fromFile(path) {
  const buf = readFileSync(path);
  const text = decodeBuffer(buf);
  if (path.toLowerCase().endsWith('.json')) {
    const json = JSON.parse(text);
    const items = Array.isArray(json) ? json : (json.data || json.records || json.features || []);
    const rows = items.map((it) => (it.properties ? it.properties : it));
    const headers = rows.length ? Object.keys(rows[0]) : [];
    if (!looksLikeStandard(headers)) console.warn('⚠ 표준데이터 컬럼이 아닌 것 같습니다. 계속 진행하지만 결과가 비어있을 수 있습니다.');
    return rowsToFeatures(headers, rows);
  }
  const { headers } = parseCsv(text.slice(0, 8000));
  if (!looksLikeStandard(headers)) {
    console.warn('⚠ 표준데이터 헤더를 못 찾았습니다. 인코딩(EUC-KR→UTF-8) 또는 파일을 확인하세요.\n  헤더 예: ' + headers.slice(0, 6).join(', '));
  }
  return csvToFeatures(text);
}

async function fromApi() {
  const key = process.env.SERVICE_KEY, url = process.env.API_URL;
  if (!url) throw new Error('API_URL 이 필요합니다 (data.go.kr 15012896 활용신청 상세페이지의 엔드포인트).');
  const all = [];
  for (let page = 1; ; page++) {
    const u = `${url}${url.includes('?') ? '&' : '?'}page=${page}&perPage=1000&serviceKey=${encodeURIComponent(key)}&returnType=JSON`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status} — API_URL/SERVICE_KEY 확인`);
    const j = await res.json();
    const items = j.data || j.records || [];
    if (!items.length) break;
    all.push(...items);
    process.stdout.write(`\rAPI page ${page}: 누적 ${all.length}행`);
    if (items.length < 1000) break;
  }
  process.stdout.write('\n');
  const headers = all.length ? Object.keys(all[0]) : [];
  return rowsToFeatures(headers, all);
}

function write(features, stats) {
  const low = features.filter((f) => f.properties.category === 'low_cost').length;
  const fc = {
    type: 'FeatureCollection',
    meta: {
      layer: 'legal_free+low_cost', source: '15012896', real: true,
      count: features.length, free: features.length - low, low_cost: low,
    },
    features,
  };
  writeFileSync(OUT, JSON.stringify(fc));
  console.log(`\n총 ${stats.total}행 → 무료 ${stats.free}곳 · 저가 ${stats.lowCost}곳 → 좌표유효 ${stats.kept}곳 저장`);
  console.log(`  (저장된 Feature: 무료 ${features.length - low}곳 + 저가 ${low}곳)`);
  if (stats.badCoord) console.log(`  (좌표 누락/범위밖 ${stats.badCoord}곳 제외)`);
  console.log(`✅ ${OUT}`);
  console.log('   앱/서버 재시작 시 이 실데이터가 시드 대신 자동 로드됩니다.');
}

async function main() {
  const file = process.argv[2];
  if (file) { const { features, stats } = fromFile(file); write(features, stats); return; }
  if (process.env.SERVICE_KEY) { const { features, stats } = await fromApi(); write(features, stats); return; }
  console.log(`전국 무료주차 실데이터 인제스트

사용법:
  node scripts/ingest.mjs <파일.csv|파일.json>      # data.go.kr에서 받은 표준데이터 파일
  SERVICE_KEY=키 API_URL=엔드포인트 node scripts/ingest.mjs   # Open API

CSV 받기(키 불필요): https://www.data.go.kr/data/15012896/standard.do → 다운로드
결과: data/free-parking.json (앱이 자동 사용)`);
  process.exit(file ? 0 : 1);
}

main().catch((e) => { console.error('오류:', e.message); process.exit(1); });
