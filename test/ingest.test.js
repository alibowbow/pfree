import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvToFeatures, rowsToFeatures, deriveFreeRules, makeGetter, looksLikeStandard, hoursText } from '../lib/ingest.js';

// 실제 15012896 표준데이터 컬럼(순서 섞음 — 헤더명 매칭 견고성 확인)
const CSV = [
  '주차장관리번호,주차장명,주차장구분,주차장유형,소재지도로명주소,주차구획수,요금정보,주차기본시간,주차기본요금,관리기관명,위도,경도,데이터기준일자',
  'A-1,행복 공영주차장,공영,노외,서울 중구 세종대로 1,40,무료,,0,중구청,37.5665,126.9780,2026-06-01',
  'A-2,유료타워,민영,노외,서울 강남구 테헤란로 2,120,유료,30,1500,민간,37.4979,127.0276,2026-06-01',
  'A-3,마트주차장,민영,부설,서울 마포구 월드컵로 3,300,혼합,120,0,○○마트,37.5563,126.9013,2026-06-01',
  'A-4,좌표없음주차장,공영,노상,어딘가,10,무료,,0,구청,0,0,2026-06-01',
  'A-5,상시무료 하천주차장,공영,노외,부산 해운대구,50,무료,,,해운대구,35.1631,129.1636,2026-06-01',
].join('\n');

test('parseCsv 헤더/행', () => {
  const { headers, rows } = parseCsv(CSV);
  assert.ok(headers.includes('주차장명'));
  assert.equal(rows.length, 5);
  assert.equal(rows[0]['요금정보'], '무료');
});

test('looksLikeStandard', () => {
  const { headers } = parseCsv(CSV);
  assert.equal(looksLikeStandard(headers), true);
  assert.equal(looksLikeStandard(['a', 'b']), false);
});

test('deriveFreeRules — 무료/유료/혼합', () => {
  const { headers, rows } = parseCsv(CSV);
  const g = (i) => makeGetter(headers, rows[i]);
  assert.deepEqual(deriveFreeRules(g(0)), [{ day_type: '전일', fee_type: '상시무료' }]);      // 무료
  assert.equal(deriveFreeRules(g(1)), null);                                                    // 유료 → 제외
  assert.deepEqual(deriveFreeRules(g(2)), [{ day_type: '전일', fee_type: '최초N분무료', first_free_minutes: 120 }]); // 혼합 무료구간
});

test('csvToFeatures — 무료+유효좌표만, 통계', () => {
  const { features, stats } = csvToFeatures(CSV);
  assert.equal(stats.total, 5);
  assert.equal(stats.free, 4);       // 무료3 + 혼합무료1 (유료 제외)
  assert.equal(stats.kept, 3);       // 좌표없음(A-4) 제외
  assert.equal(stats.badCoord, 1);
  const names = features.map((f) => f.properties.name);
  assert.ok(names.includes('행복 공영주차장'));
  assert.ok(names.includes('상시무료 하천주차장'));
  assert.ok(!names.includes('유료타워'));
  assert.ok(!names.includes('좌표없음주차장'));
});

test('Feature 스키마 — 좌표·id·free_rules·출처', () => {
  const { features } = csvToFeatures(CSV);
  const f = features.find((x) => x.properties.name === '행복 공영주차장');
  assert.equal(f.geometry.coordinates[0], 126.978);  // [lng, lat]
  assert.equal(f.geometry.coordinates[1], 37.5665);
  assert.equal(f.properties.id, 'dg-A-1');
  assert.equal(f.properties.category, 'legal_free');
  assert.equal(f.properties.source, 'official');
  assert.equal(f.properties.source_dataset, '15012896');
  assert.equal(f.properties.num_spaces, 40);
  assert.deepEqual(f.properties.free_rules, [{ day_type: '전일', fee_type: '상시무료' }]);
  const mart = features.find((x) => x.properties.name === '마트주차장');
  assert.equal(mart.properties.free_type, '시간제무료');
});

test('중복 제거(같은 관리번호)', () => {
  const dup = CSV + '\nA-1,행복 공영주차장 중복,공영,노외,서울 중구,40,무료,,0,중구청,37.5665,126.9780,2026-06-01';
  const { features } = csvToFeatures(dup);
  assert.equal(features.filter((f) => f.properties.parking_mgmt_no === 'A-1').length, 1);
});

test('JSON(객체 배열) 경로 — rowsToFeatures', () => {
  const { headers, rows } = parseCsv(CSV);
  const { features } = rowsToFeatures(headers, rows);
  assert.equal(features.length, 3);
});

// 실제 표준데이터 전체 컬럼(운영시각·전화번호 포함) 픽스처
const FULL = [
  '주차장관리번호,주차장명,주차장구분,주차장유형,소재지도로명주소,소재지지번주소,주차구획수,급지구분,부제시행구분,운영요일,평일운영시작시각,평일운영종료시각,토요일운영시작시각,토요일운영종료시각,공휴일운영시작시각,공휴일운영종료시각,요금정보,주차기본시간,주차기본요금,추가단위시간,추가단위요금,1일주차권요금적용시간,1일주차권요금,월정기권요금,결제방법,특기사항,관리기관명,전화번호,위도,경도,장애인,데이터기준일자',
  'F-1,전일무료 주차장,공영,노외,서울 중구 A로 1,,30,기타,미시행,평일+토요일+공휴일,00:00,23:59,00:00,23:59,00:00,23:59,무료,0,0,,,,,,,,중구청,02-100-2000,37.56,126.98,,2026-06-23',
  'F-2,주간운영 무료주차장,공영,노상,부산 금정구 B로 2,,20,기타,미시행,평일+토요일+공휴일,9:00,18:00,9:00,18:00,10:00,17:00,무료,0,0,,,,,,,,금정구청,051-200-3000,35.28,129.09,,2026-06-23',
].join('\n');

test('전화번호·운영시간 강화 필드', () => {
  const { features } = csvToFeatures(FULL);
  const allDay = features.find((f) => f.properties.name === '전일무료 주차장');
  assert.equal(allDay.properties.tel, '02-100-2000');
  assert.equal(allDay.properties.hours, '24시간');
  const dayOnly = features.find((f) => f.properties.name === '주간운영 무료주차장');
  assert.equal(dayOnly.properties.tel, '051-200-3000');
  assert.equal(dayOnly.properties.hours, '평일 09:00~18:00 · 토 09:00~18:00 · 공휴일 10:00~17:00');
});

test('hoursText — 매일 동일/부분 누락', () => {
  const mk = (o) => (k) => o[k] ?? '';
  assert.equal(hoursText(mk({ wdS: '9:00', wdE: '18:00', satS: '9:00', satE: '18:00', holS: '9:00', holE: '18:00' })), '매일 09:00~18:00');
  assert.equal(hoursText(mk({ wdS: '9:00', wdE: '18:00', satS: '10:00', satE: '17:00', holS: '10:00', holE: '17:00' })), '평일 09:00~18:00 · 주말·공휴일 10:00~17:00');
  assert.equal(hoursText(mk({})), undefined);
  assert.equal(hoursText(mk({ wdS: '9:00', wdE: '18:00' })), '평일 09:00~18:00');
});
