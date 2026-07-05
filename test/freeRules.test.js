import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHM, fmtHM, inWindow, dayTypeOf, ruleMatchesDay, evaluateSpot,
} from '../lib/freeRules.js';
import { holidaySet } from '../lib/holidays.js';

const H = holidaySet();

// 특정 요일/시각의 Date 를 만든다 (로컬 시간)
const at = (iso, hm) => new Date(`${iso}T${hm}:00`);

test('parseHM / fmtHM', () => {
  assert.equal(parseHM('18:30'), 18 * 60 + 30);
  assert.equal(parseHM('24:00'), 1440);
  assert.equal(parseHM(''), null);
  assert.equal(parseHM(null), null);
  assert.equal(fmtHM(18 * 60 + 30), '18:30');
  assert.equal(fmtHM(0), '00:00');
});

test('inWindow - 일반 창', () => {
  assert.equal(inWindow(600, 540, 1080), true);  // 10:00 in 09:00~18:00
  assert.equal(inWindow(1100, 540, 1080), false); // 18:20 밖
  assert.equal(inWindow(540, 540, 1080), true);   // 경계 시작 포함
  assert.equal(inWindow(1080, 540, 1080), false); // 경계 끝 배제
});

test('inWindow - 야간창(자정 넘김)', () => {
  // 18:00~09:00
  assert.equal(inWindow(1200, 1080, 540), true);  // 20:00 무료
  assert.equal(inWindow(60, 1080, 540), true);    // 01:00 무료
  assert.equal(inWindow(600, 1080, 540), false);  // 10:00 유료
});

test('inWindow - 전일(null)', () => {
  assert.equal(inWindow(720, null, null), true);
});

test('dayTypeOf', () => {
  assert.equal(dayTypeOf(at('2026-07-06', '10:00'), H), '평일');   // 월
  assert.equal(dayTypeOf(at('2026-07-04', '10:00'), H), '토요일'); // 토
  assert.equal(dayTypeOf(at('2026-07-05', '10:00'), H), '일요일'); // 일
  assert.equal(dayTypeOf(at('2026-08-15', '10:00'), H), '공휴일'); // 광복절
});

test('ruleMatchesDay', () => {
  assert.equal(ruleMatchesDay('전일', '평일'), true);
  assert.equal(ruleMatchesDay('주말', '토요일'), true);
  assert.equal(ruleMatchesDay('주말', '공휴일'), true);
  assert.equal(ruleMatchesDay('일요일', '공휴일'), true);
  assert.equal(ruleMatchesDay('평일', '토요일'), false);
});

test('상시무료 - 항상 free', () => {
  const spot = { properties: { category: 'legal_free', free_rules: [{ day_type: '전일', fee_type: '상시무료' }] } };
  assert.equal(evaluateSpot(spot, at('2026-07-06', '03:00'), H).state, 'free');
  assert.equal(evaluateSpot(spot, at('2026-07-06', '15:00'), H).state, 'free');
});

test('평일유료·주말무료', () => {
  const spot = { properties: { category: 'legal_free', free_rules: [
    { day_type: '평일', start: '09:00', end: '19:00', fee_type: '유료' },
    { day_type: '주말', fee_type: '시간대무료' }, // 종일 무료
  ] } };
  // 평일 낮 → 유료
  assert.equal(evaluateSpot(spot, at('2026-07-06', '12:00'), H).state, 'paid');
  // 토요일 → 무료
  assert.equal(evaluateSpot(spot, at('2026-07-04', '12:00'), H).state, 'free');
  // 공휴일(광복절, 토) → 주말 규칙으로 무료
  assert.equal(evaluateSpot(spot, at('2026-08-15', '12:00'), H).state, 'free');
});

test('18시 이후 무료 (야간창) + 유료→무료 전환 안내', () => {
  const spot = { properties: { category: 'legal_free', free_rules: [
    { day_type: '평일', start: '18:00', end: '09:00', fee_type: '시간대무료' },
    { day_type: '평일', start: '09:00', end: '18:00', fee_type: '유료' },
  ] } };
  assert.equal(evaluateSpot(spot, at('2026-07-06', '20:00'), H).state, 'free'); // 저녁 무료
  assert.equal(evaluateSpot(spot, at('2026-07-06', '07:00'), H).state, 'free'); // 새벽 무료
  const midday = evaluateSpot(spot, at('2026-07-06', '12:00'), H);              // 낮 유료
  assert.equal(midday.state, 'paid');
  assert.match(midday.detail, /18:00부터 무료/);
});

test('최초 N분 무료 → partial', () => {
  const spot = { properties: { category: 'legal_free', free_rules: [
    { day_type: '전일', fee_type: '최초N분무료', first_free_minutes: 30, fee_info: '이후 10분당 500원' },
  ] } };
  const r = evaluateSpot(spot, at('2026-07-06', '12:00'), H);
  assert.equal(r.state, 'partial');
  assert.match(r.label, /최초 30분 무료/);
});

test('gray_zone → gray, 정직한 위험 라벨', () => {
  const spot = { properties: { category: 'gray_zone', risk: { fine: '4만원', citizen_report: true } } };
  const r = evaluateSpot(spot, at('2026-07-06', '23:00'), H);
  assert.equal(r.state, 'gray');
  assert.match(r.detail, /본인 책임/);
  assert.match(r.detail, /주민신고제/);
});

test('no_parking → warning (경고 전용)', () => {
  const spot = { properties: { category: 'no_parking', risk: { zone_type: '소화전 5m', fine: '8만원', citizen_report: true, safety_critical: true } } };
  const r = evaluateSpot(spot, at('2026-07-06', '23:00'), H);
  assert.equal(r.state, 'warning');
  assert.match(r.label, /절대금지/);
});
