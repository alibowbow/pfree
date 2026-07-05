import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSpotForm, buildFeature, normalizeRules, featureToForm,
  upsertFeature, removeFeature, loadUserSpots, saveUserSpots, STORAGE_KEY,
} from '../lib/userSpots.js';

const seoul = { lat: 37.5665, lng: 126.9769 };
const DET = { now: 1751000000000, rand: 0.5, date: '2026-07-05' }; // 결정적

test('validate - 필수값', () => {
  assert.ok(validateSpotForm({ category: 'legal_free', ...seoul, free_rules: [{ fee_type: '상시무료' }] }).some((m) => /이름/.test(m)));
  assert.ok(validateSpotForm({ name: 'x', category: 'legal_free', lat: 10, lng: 10, free_rules: [{ fee_type: '상시무료' }] }).some((m) => /한국 내 좌표/.test(m)));
  assert.deepEqual(validateSpotForm({ name: 'ok', category: 'legal_free', ...seoul, free_rules: [{ fee_type: '상시무료' }] }), []);
});

test('validate - 합법무료는 규칙 최소 1개', () => {
  assert.ok(validateSpotForm({ name: 'x', category: 'legal_free', ...seoul, free_rules: [] }).some((m) => /규칙/.test(m)));
});

test('안전 가드 - gray_zone 은 not_safety_critical 확인 필수', () => {
  const errs = validateSpotForm({ name: 'x', category: 'gray_zone', ...seoul });
  assert.ok(errs.some((m) => /안전 치명 구역/.test(m)));
  assert.deepEqual(validateSpotForm({ name: 'x', category: 'gray_zone', ...seoul, not_safety_critical: true }), []);
});

test('normalizeRules', () => {
  const r = normalizeRules([
    { day_type: '평일', fee_type: '시간대무료', start: '18:00', end: '09:00' },
    { fee_type: '' }, // 버려짐
    { day_type: '전일', fee_type: '최초N분무료', first_free_minutes: '30', fee_info: '이후 유료' },
    { day_type: '전일', fee_type: '상시무료', start: '01:00' }, // 상시무료는 시간창 제거
  ]);
  assert.equal(r.length, 3);
  assert.equal(r[0].start, '18:00');
  assert.equal(r[1].first_free_minutes, 30);
  assert.equal(r[2].start, undefined);
});

test('buildFeature - 합법무료', () => {
  const { errors, feature } = buildFeature({
    name: '동네 무료주차장', category: 'legal_free', free_type: '상시무료', num_spaces: '20',
    free_rules: [{ day_type: '전일', fee_type: '상시무료' }], ...seoul, note: '메모',
  }, DET);
  assert.deepEqual(errors, []);
  assert.equal(feature.properties.category, 'legal_free');
  assert.equal(feature.properties.source, 'crowd');
  assert.equal(feature.properties.editable, true);
  assert.equal(feature.properties.num_spaces, 20);
  assert.equal(feature.geometry.coordinates[0], seoul.lng);
  assert.equal(feature.properties.verify.status, 'user');
});

test('buildFeature - gray_zone 안전가드 실패 시 feature 없음', () => {
  const { errors, feature } = buildFeature({ name: 'x', category: 'gray_zone', ...seoul }, DET);
  assert.ok(errors.length);
  assert.equal(feature, null);
});

test('buildFeature - no_parking 은 safety_critical=true', () => {
  const { feature } = buildFeature({ name: '소화전 앞', category: 'no_parking', risk_zone_type: '소화전 5m', risk_fine: '8만원', ...seoul }, DET);
  assert.equal(feature.properties.category, 'no_parking');
  assert.equal(feature.properties.risk.safety_critical, true);
  assert.equal(feature.properties.risk.citizen_report, true);
});

test('featureToForm 왕복', () => {
  const { feature } = buildFeature({
    name: 'A', category: 'legal_free', free_type: '시간제무료',
    free_rules: [{ day_type: '주말', fee_type: '시간대무료' }], ...seoul,
  }, DET);
  const form = featureToForm(feature);
  assert.equal(form.name, 'A');
  assert.equal(form.free_rules[0].day_type, '주말');
  const again = buildFeature(form, DET);
  assert.equal(again.errors.length, 0);
  assert.equal(again.feature.properties.id, feature.properties.id); // id 유지
});

test('upsert / remove', () => {
  const a = buildFeature({ name: 'A', category: 'legal_free', free_rules: [{ fee_type: '상시무료' }], ...seoul }, { ...DET, id: 'a' }).feature;
  const b = buildFeature({ name: 'B', category: 'legal_free', free_rules: [{ fee_type: '상시무료' }], ...seoul }, { ...DET, id: 'b' }).feature;
  let list = upsertFeature([], a);
  list = upsertFeature(list, b);
  assert.equal(list.length, 2);
  const a2 = { ...a, properties: { ...a.properties, name: 'A2' } };
  list = upsertFeature(list, a2);
  assert.equal(list.length, 2);
  assert.equal(list.find((f) => f.properties.id === 'a').properties.name, 'A2');
  list = removeFeature(list, 'a');
  assert.equal(list.length, 1);
  assert.equal(list[0].properties.id, 'b');
});

test('load / save (가짜 storage)', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadUserSpots(storage), []);
  const f = buildFeature({ name: 'A', category: 'legal_free', free_rules: [{ fee_type: '상시무료' }], ...seoul }, { ...DET, id: 'a' }).feature;
  saveUserSpots([f], storage);
  assert.match(mem.get(STORAGE_KEY), /"id":"a"/);
  assert.equal(loadUserSpots(storage).length, 1);
});
