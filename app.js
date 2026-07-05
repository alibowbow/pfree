import { evaluateSpot, STATE_COLOR, STATE_LABEL, fmtHM } from './lib/freeRules.js';
import { holidaySet } from './lib/holidays.js';

const HOLIDAYS = holidaySet();

// ── 지도 초기화 ────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([37.5665, 126.9769], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap · 무료주차 데이터: 공공데이터포털/사용자 제보',
}).addTo(map);
// ↑ 프로토타입은 OSM 타일. 프로덕션은 Kakao Map(도로명·POI 우수, 무료 클러스터러) 권장.

const freeCluster = L.markerClusterGroup({ maxClusterRadius: 45, spiderfyOnMaxZoom: true });
const grayLayer = L.layerGroup();
const npLayer = L.layerGroup();

// ── 상태 ───────────────────────────────────────────────────────────────────
const store = { free: [], gray: [], np: [] };
const els = {
  lyrFree: document.getElementById('lyr-free'),
  lyrGray: document.getElementById('lyr-gray'),
  lyrNp: document.getElementById('lyr-np'),
  fts: [...document.querySelectorAll('.ft')],
  tmNow: document.getElementById('tm-now'),
  tmSim: document.getElementById('tm-sim'),
  simBox: document.getElementById('sim-box'),
  simDay: document.getElementById('sim-day'),
  simHour: document.getElementById('sim-hour'),
  simHourLbl: document.getElementById('sim-hour-lbl'),
  onlyFree: document.getElementById('only-free'),
  stats: document.getElementById('stats'),
};

// ── 기준 시각 계산(현재 or 시뮬레이션) ─────────────────────────────────────
// 시뮬레이션은 요일유형(평일/토/일/공휴일)에 맞는 실제 날짜를 골라 규칙 엔진을 그대로 태운다.
function refDate() {
  if (els.tmNow.checked) return new Date();
  const hour = Number(els.simHour.value);
  const wanted = els.simDay.value;
  const base = new Date();
  base.setHours(hour, 0, 0, 0);
  if (wanted === '공휴일') {
    // 가장 가까운 미래 공휴일 하나를 사용 (없으면 오늘)
    const iso = [...HOLIDAYS].sort()[0];
    if (iso) { const d = new Date(`${iso}T00:00:00`); d.setHours(hour, 0, 0, 0); return d; }
    return base;
  }
  const targetDow = { '일요일': 0, '평일': 1, '토요일': 6 }[wanted];
  const d = new Date(base);
  for (let i = 0; i < 7; i++) {
    if (d.getDay() === targetDow) break;
    d.setDate(d.getDate() + 1);
  }
  // 평일이 공휴일과 겹치면 하루 더
  if (wanted === '평일' && HOLIDAYS.has(d.toISOString().slice(0, 10))) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// ── 마커 생성 ──────────────────────────────────────────────────────────────
function pinIcon(state) {
  const warn = state === 'warning';
  return L.divIcon({
    className: '',
    html: `<div class="pin ${warn ? 'warning' : ''}" style="background:${STATE_COLOR[state]}"></div>`,
    iconSize: [18, 18],
    iconAnchor: warn ? [9, 9] : [9, 16],
    popupAnchor: [0, warn ? -10 : -16],
  });
}

function popupHtml(p, ev) {
  const color = STATE_COLOR[ev.state];
  let body = `<div class="pp"><div class="name">${esc(p.name)}</div>` +
    `<span class="state" style="background:${color}">${ev.label}</span>` +
    `<div class="row">${esc(ev.detail || '')}</div>`;

  if (p.category === 'legal_free') {
    if (p.address) body += `<div class="muted">${esc(p.address)}</div>`;
    if (p.num_spaces) body += `<div class="row">주차면 ${p.num_spaces}면 · ${esc(p.kind || '')} · ${esc(p.free_type || '')}</div>`;
    body += `<div class="row" style="margin-top:6px">${rulesText(p.free_rules)}</div>`;
    if (p.note) body += `<div class="muted">${esc(p.note)}</div>`;
    body += verifyBadge(p.verify);
  } else if (p.category === 'gray_zone') {
    body += `<div class="graybox">🚫 <b>불법 주정차 구역입니다.</b> ${esc(p.note || '')}<br>` +
      `안 걸린다는 <u>보장은 없습니다</u> · 주민신고제 대상 · 주차 책임은 본인.</div>`;
    body += verifyBadge(p.verify);
  } else if (p.category === 'no_parking') {
    const r = p.risk || {};
    body += `<div class="warnbox">⛔ <b>주정차 절대금지</b> — ${esc(r.zone_type || '')}<br>` +
      `과태료 ${esc(r.fine || '부과')} · ${r.citizen_report ? '주민신고제 대상' : ''}${r.safety_critical ? ' · 안전 위협' : ''}<br>` +
      `${esc(p.note || '')}</div>`;
  }
  return body + `</div>`;
}

function rulesText(rules) {
  if (!rules || !rules.length) return '<span class="muted">무료 규칙 미등록</span>';
  return rules.map((r) => {
    const day = r.day_type || '전일';
    const win = r.start || r.end ? `${r.start || '00:00'}~${r.end || '24:00'}` : '종일';
    let fee;
    if (r.fee_type === '상시무료') fee = '무료';
    else if (r.fee_type === '시간대무료') fee = '무료';
    else if (r.fee_type === '최초N분무료') fee = `최초 ${r.first_free_minutes}분 무료`;
    else fee = `유료${r.fee_info ? ' (' + r.fee_info + ')' : ''}`;
    return `· ${day} ${win} — ${fee}`;
  }).join('<br>');
}

function verifyBadge(v) {
  if (!v) return '';
  const map = { verified: '✅ 검증됨', user: '👤 사용자 제보', stale: '⏳ 재검증 필요', disputed: '⚠️ 제보 상충' };
  return `<div style="margin-top:6px"><span class="badge">${map[v.status] || v.status} · ${v.check_date || ''}</span></div>`;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 렌더링 ─────────────────────────────────────────────────────────────────
function render() {
  const now = refDate();
  const activeFts = new Set(els.fts.filter((c) => c.checked).map((c) => c.value));
  const onlyFree = els.onlyFree.checked;
  freeCluster.clearLayers();
  grayLayer.clearLayers();
  npLayer.clearLayers();
  let cFree = 0, cNow = 0, cGray = 0, cNp = 0;

  // 합법 무료
  if (els.lyrFree.checked) {
    for (const f of store.free) {
      const p = f.properties;
      if (p.free_type && !activeFts.has(p.free_type)) continue;
      const ev = evaluateSpot(f, now, HOLIDAYS);
      const isFreeNow = ev.state === 'free' || ev.state === 'partial';
      if (onlyFree && !isFreeNow) continue;
      cFree++; if (isFreeNow) cNow++;
      const [lng, lat] = f.geometry.coordinates;
      L.marker([lat, lng], { icon: pinIcon(ev.state) }).bindPopup(popupHtml(p, ev)).addTo(freeCluster);
    }
  }
  // 단속 뜸한 곳
  if (els.lyrGray.checked) {
    for (const f of store.gray) {
      const ev = evaluateSpot(f, now, HOLIDAYS);
      const [lng, lat] = f.geometry.coordinates;
      L.marker([lat, lng], { icon: pinIcon(ev.state) }).bindPopup(popupHtml(f.properties, ev)).addTo(grayLayer);
      cGray++;
    }
  }
  // 주차금지 경고
  if (els.lyrNp.checked) {
    for (const f of store.np) {
      const ev = evaluateSpot(f, now, HOLIDAYS);
      const [lng, lat] = f.geometry.coordinates;
      L.marker([lat, lng], { icon: pinIcon(ev.state) }).bindPopup(popupHtml(f.properties, ev)).addTo(npLayer);
      cNp++;
    }
  }

  const t = now.toLocaleString('ko-KR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  els.stats.innerHTML =
    `<b>기준: ${t}</b><br>` +
    `합법 무료 ${cFree}곳 중 <b style="color:var(--free)">지금 무료 ${cNow}곳</b><br>` +
    `단속 뜸함 ${cGray}곳 · 주차금지 경고 ${cNp}곳`;
}

// ── 이벤트 바인딩 ──────────────────────────────────────────────────────────
function syncLayers() {
  els.lyrFree.checked ? map.addLayer(freeCluster) : map.removeLayer(freeCluster);
  els.lyrGray.checked ? map.addLayer(grayLayer) : map.removeLayer(grayLayer);
  els.lyrNp.checked ? map.addLayer(npLayer) : map.removeLayer(npLayer);
}
[els.lyrFree, els.lyrGray, els.lyrNp].forEach((el) => el.addEventListener('change', () => { syncLayers(); render(); }));
els.fts.forEach((c) => c.addEventListener('change', render));
els.onlyFree.addEventListener('change', render);
[els.tmNow, els.tmSim].forEach((el) => el.addEventListener('change', () => {
  els.simBox.classList.toggle('on', els.tmSim.checked);
  render();
}));
els.simDay.addEventListener('change', render);
els.simHour.addEventListener('input', () => {
  els.simHourLbl.textContent = fmtHM(Number(els.simHour.value) * 60);
  render();
});

// ── 데이터 로드 ────────────────────────────────────────────────────────────
async function load() {
  const [free, gray, np] = await Promise.all([
    fetch('./data/free-parking.seed.json').then((r) => r.json()),
    fetch('./data/gray-zones.seed.json').then((r) => r.json()),
    fetch('./data/no-parking.seed.json').then((r) => r.json()),
  ]);
  store.free = free.features || [];
  store.gray = gray.features || [];
  store.np = np.features || [];
  syncLayers();
  render();
}

load().catch((e) => {
  document.getElementById('stats').innerHTML =
    `<b style="color:var(--warning)">데이터 로드 실패</b><br>정적 서버로 실행하세요:<br><code>npm run dev</code> 또는 <code>python3 -m http.server</code>`;
  console.error(e);
});
