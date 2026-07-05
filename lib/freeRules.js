// ────────────────────────────────────────────────────────────────────────────
// 무료주차 규칙 엔진 (핵심)
// 한국의 무료주차는 free/paid 불리언이 아니라 "시간 조건부"이므로
// spot 마다 free_rules[] (요일유형 × 시간창 × 요금유형) 집합으로 모델링하고,
// evaluateSpot(spot, 시각) 이 "지금 무료냐?"를 판정한다.
// 브라우저(ES module)와 Node(--test) 양쪽에서 그대로 쓰인다.
// ────────────────────────────────────────────────────────────────────────────

/** 'HH:MM' → 자정 기준 분. null/undefined → null(=시간 미지정=24시간). '24:00' → 1440. */
export function parseHM(s) {
  if (s == null || s === '') return null;
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** 분 → 'HH:MM' */
export function fmtHM(min) {
  if (min == null) return '';
  const mm = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

/** Date → 로컬 'YYYY-MM-DD' */
export function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 자정 기준 현재 분 */
export function nowMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * nowMin 이 [startMin, endMin) 창에 들어가는가.
 * null 창 = 24시간(전일). start>end = 야간창(예: 18:00~09:00).
 */
export function inWindow(nowMin, startMin, endMin) {
  if (startMin == null || endMin == null) return true;
  if (startMin === endMin) return true; // 00:00~00:00 = 종일
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin; // 자정 넘김
}

/** Date → 요일유형 (공휴일 우선) */
export function dayTypeOf(date, holidays) {
  if (holidays && holidays.has(toISODate(date))) return '공휴일';
  const d = date.getDay(); // 0=일 … 6=토
  if (d === 0) return '일요일';
  if (d === 6) return '토요일';
  return '평일';
}

/** rule.day_type 이 오늘의 요일유형에 적용되는가 */
export function ruleMatchesDay(ruleDayType, todayType) {
  if (!ruleDayType || ruleDayType === '전일') return true;
  if (ruleDayType === todayType) return true;
  if (ruleDayType === '주말' && (todayType === '토요일' || todayType === '일요일' || todayType === '공휴일')) return true;
  // 관례상 공휴일은 일요일 요금체계를 따르는 경우가 많음
  if (ruleDayType === '일요일' && todayType === '공휴일') return true;
  return false;
}

function windowText(rule) {
  const s = rule.start, e = rule.end;
  if (!s && !e) return '종일 무료';
  return `${s || '00:00'}~${e || '24:00'} 무료`;
}

/** 지금은 유료지만 오늘 이후에 무료로 바뀌는 시각이 있으면 안내 */
function paidWithNext(applicable, nowMin) {
  const freeStarts = applicable
    .filter((r) => r.fee_type === '상시무료' || r.fee_type === '시간대무료')
    .map((r) => parseHM(r.start))
    .filter((v) => v != null && v > nowMin)
    .sort((a, b) => a - b);
  if (freeStarts.length) {
    return { state: 'paid', label: '지금 유료', detail: `${fmtHM(freeStarts[0])}부터 무료` };
  }
  return { state: 'paid', label: '지금 유료', detail: '현재 무료 시간대 아님' };
}

/**
 * spot 한 곳의 현재 상태를 판정한다.
 * @returns {{state:'free'|'partial'|'paid'|'gray'|'warning'|'unknown', label:string, detail:string, until?:number, rule?:object}}
 *   free    = 지금 무료 (초록)
 *   partial = 최초 N분 무료 등 조건부 (주황)
 *   paid    = 지금 유료 / 무료 시간대 아님 (회색)
 *   gray    = 단속 뜸한 불법 구역 (노랑, 정보 제공·본인 책임)
 *   warning = 주정차 절대금지 (빨강, 경고 전용)
 */
export function evaluateSpot(spot, atDate = new Date(), holidays) {
  const p = (spot && spot.properties) || spot || {};

  if (p.category === 'no_parking') {
    const r = p.risk || {};
    return {
      state: 'warning',
      label: '주정차 절대금지',
      detail: `${r.zone_type || '금지구역'} · 과태료 ${r.fine || '부과 대상'}${r.citizen_report ? ' · 주민신고제 대상' : ''}`,
    };
  }

  if (p.category === 'gray_zone') {
    const r = p.risk || {};
    return {
      state: 'gray',
      label: '단속 뜸한 구역 (불법)',
      detail: `주정차 금지 · ${r.citizen_report ? '주민신고제 대상 · ' : ''}과태료 ${r.fine || '위험'} · 본인 책임`,
    };
  }

  // legal_free
  const today = dayTypeOf(atDate, holidays);
  const nowMin = nowMinutes(atDate);
  const rules = p.free_rules || [];
  const applicable = rules.filter((r) => ruleMatchesDay(r.day_type, today));

  let active = null;
  for (const r of applicable) {
    if (inWindow(nowMin, parseHM(r.start), parseHM(r.end))) {
      active = r;
      break;
    }
  }

  if (active) {
    if (active.fee_type === '상시무료') {
      return { state: 'free', label: '지금 무료', detail: '상시 무료', rule: active };
    }
    if (active.fee_type === '시간대무료') {
      return { state: 'free', label: '지금 무료', detail: windowText(active), until: parseHM(active.end), rule: active };
    }
    if (active.fee_type === '최초N분무료') {
      return {
        state: 'partial',
        label: `최초 ${active.first_free_minutes}분 무료`,
        detail: active.fee_info || '이후 유료',
        rule: active,
      };
    }
    // active.fee_type === '유료'
    return paidWithNext(applicable, nowMin);
  }

  if (applicable.length === 0 && rules.length === 0) {
    return { state: 'unknown', label: '정보 없음', detail: '무료 규칙 미등록' };
  }
  return paidWithNext(applicable, nowMin);
}

/** 지도 마커 색상 매핑 */
export const STATE_COLOR = {
  free: '#1f9d55',    // 초록 - 지금 무료
  partial: '#e0820a', // 주황 - 조건부 무료
  paid: '#8a8f98',    // 회색 - 지금 유료
  gray: '#d9a400',    // 노랑 - 단속 뜸함(불법)
  warning: '#d63838', // 빨강 - 주차금지 경고
  unknown: '#8a8f98',
};

export const STATE_LABEL = {
  free: '지금 무료',
  partial: '조건부 무료',
  paid: '지금 유료',
  gray: '단속 뜸함(불법)',
  warning: '주차금지',
  unknown: '정보 없음',
};
