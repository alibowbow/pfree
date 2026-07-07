import { evaluateSpot, fmtHM } from './lib/freeRules.js';
import { holidaySet } from './lib/holidays.js';
import {
  buildFeature, featureToForm, upsertFeature, removeFeature,
  loadUserSpots, saveUserSpots,
} from './lib/userSpots.js';
import { detectServer, isServer, apiLoad, apiCreate, apiUpdate, apiDelete } from './lib/backend.js';
import { csvToFeatures, rowsToFeatures } from './lib/ingest.js';

const HOLIDAYS = holidaySet();
let govFeatures = []; // 공공데이터 CSV로 불러온 전국 무료주차(세션 오버레이)

// ── 지도 ────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true, zoomSnap: 0.5 }).setView([37.5665, 126.9769], 12);
// OSM 표준 타일 — 한국 지명을 한글(name 태그)로 렌더링(저줌에서도 서울/부산 등 한글).
// CARTO Voyager는 국제명(영문) 위주라 교체. (프로덕션은 Kakao Map 권장)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  detectRetina: true,
  attribution: '&copy; OpenStreetMap · 무료주차: 공공데이터/사용자 제보',
}).addTo(map);

// 도시 줌 이상에서만 주차 마커 표시(전국 뷰가 숫자로 뒤덮이는 것 방지)
const MIN_MARKER_ZOOM = 11;
const NAVER_TO = (name, lat, lng) => `https://map.naver.com/p/directions/-/${lng},${lat},${encodeURIComponent(name)}/-/car`;
const freeCluster = L.markerClusterGroup({
  maxClusterRadius: 70, spiderfyOnMaxZoom: true, showCoverageOnHover: false,
  chunkedLoading: true, removeOutsideVisibleBounds: true,
});
const grayLayer = L.layerGroup();
const npLayer = L.layerGroup();
const layerObj = { legal_free: freeCluster, gray_zone: grayLayer, no_parking: npLayer };
const freeVisible = () => els.lyrFree.checked && map.getZoom() >= MIN_MARKER_ZOOM;

// store.all = 전체 스팟(공식 시드 + 사용자 제보). 서버 모드면 서버에서, 로컬 모드면 시드+localStorage.
const store = { all: [] };
const crowdSpots = () => store.all.filter((f) => f.properties.editable);

// 커뮤니티 시드 원본 스냅샷(id→JSON)·삭제 톰스톤 — 로컬 모드 전용.
// 편집 안 한 시드는 localStorage에 저장하지 않아(스냅샷과 동일하면 제외) 시드 업데이트가 막히지 않고,
// 시드를 삭제하면 톰스톤으로 기록해 새로고침 후 부활하지 않는다.
const seedSnapshots = new Map();
const TOMB_KEY = 'pfree.tombstones.v1';
const loadTombs = () => { try { return new Set(JSON.parse(localStorage.getItem(TOMB_KEY) || '[]')); } catch { return new Set(); } };
const saveTombs = (s) => { try { localStorage.setItem(TOMB_KEY, JSON.stringify([...s])); } catch {} };
const persistLocal = () => {
  if (isServer()) return;
  saveUserSpots(crowdSpots().filter((f) => {
    const snap = seedSnapshots.get(f.properties.id);
    return !snap || JSON.stringify(f) !== snap; // 시드 원본 그대로면 저장 안 함
  }));
};
const currentBbox = () => { const b = map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; };
async function refreshFromServer() { store.all = await apiLoad(currentBbox()); render(); }

const $ = (id) => document.getElementById(id);
const els = {
  lyrFree: $('lyr-free'), lyrGray: $('lyr-gray'), lyrNp: $('lyr-np'),
  fts: [...document.querySelectorAll('.ft')],
  tmNow: $('tm-now'), tmSim: $('tm-sim'), simBox: $('sim-box'),
  simDay: $('sim-day'), simHour: $('sim-hour'), simHourLbl: $('sim-hour-lbl'),
  onlyFree: $('only-free'), statsContent: $('stats-content'), mineCount: $('mine-count'), near: $('near'),
};

let userLoc = null;   // {lat,lng}
let meMarker = null;

// 하버사인 거리(m)
function distM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);
const walkMin = (m) => Math.max(1, Math.round(m / 67)); // ~4km/h

// ── 기준 시각 ────────────────────────────────────────────────────────────────
function refDate() {
  if (els.tmNow.checked) return new Date();
  const hour = Number(els.simHour.value);
  const wanted = els.simDay.value;
  const base = new Date(); base.setHours(hour, 0, 0, 0);
  if (wanted === '공휴일') {
    const iso = [...HOLIDAYS].sort()[0];
    if (iso) { const d = new Date(`${iso}T00:00:00`); d.setHours(hour, 0, 0, 0); return d; }
    return base;
  }
  const targetDow = { '일요일': 0, '평일': 1, '토요일': 6 }[wanted];
  const d = new Date(base);
  for (let i = 0; i < 7 && d.getDay() !== targetDow; i++) d.setDate(d.getDate() + 1);
  if (wanted === '평일' && HOLIDAYS.has(toISO(d))) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── 마커 (커스텀 SVG 픽토그램) ───────────────────────────────────────────────
// 합법무료 = 'P' 핀, 단속뜸 = 주의 핀, 주차금지 = 주차금지 표지판(P+사선).
const MARKER_COLOR = { free: '#2f7355', partial: '#a9741f', paid: '#a8a49b', gray: '#94781f', warning: '#a5443a', unknown: '#a8a49b' };
const FONT_ATTR = "font-family='Pretendard Variable',-apple-system,sans-serif";

function markerHtml(state, isUser) {
  const badge = isUser ? `<circle cx='23' cy='6.5' r='4' fill='#3b6cc7' stroke='#fff' stroke-width='1.6'/>` : '';
  if (state === 'warning') { // 주차금지 표지판: 빨간 원 + P + 사선
    return `<div class="mk"><svg width="28" height="28" viewBox="0 0 28 28" ${FONT_ATTR}>` +
      `<circle cx="14" cy="14" r="11.4" fill="${MARKER_COLOR.warning}" stroke="#fff" stroke-width="2.4"/>` +
      `<text x="14" y="18.6" font-size="13" font-weight="700" text-anchor="middle" fill="#fff">P</text>` +
      `<line x1="6.6" y1="6.6" x2="21.4" y2="21.4" stroke="#fff" stroke-width="2.3"/>${badge}</svg></div>`;
  }
  const color = MARKER_COLOR[state] || MARKER_COLOR.unknown;
  const glyph = state === 'gray' ? '!' : 'P';
  return `<div class="mk"><svg width="28" height="36" viewBox="0 0 28 36" ${FONT_ATTR}>` +
    `<path d="M14 1.5C7.4 1.5 2 6.9 2 13.5c0 8.7 12 21 12 21s12-12.3 12-21C26 6.9 20.6 1.5 14 1.5z" fill="${color}" stroke="#fff" stroke-width="2.4"/>` +
    `<text x="14" y="18.8" font-size="14" font-weight="700" text-anchor="middle" fill="#fff">${glyph}</text>${badge}</svg></div>`;
}
function pinIcon(state, isUser) {
  const warn = state === 'warning';
  return L.divIcon({
    className: '', html: markerHtml(state, isUser),
    iconSize: warn ? [28, 28] : [28, 36], iconAnchor: warn ? [14, 14] : [14, 35], popupAnchor: [0, warn ? -15 : -33],
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function rulesText(rules) {
  if (!rules || !rules.length) return '<span class="muted">무료 규칙 미등록</span>';
  return rules.map((r) => {
    const day = r.day_type || '전일';
    const win = r.start || r.end ? `${r.start || '00:00'}~${r.end || '24:00'}` : '종일';
    let fee;
    if (r.fee_type === '상시무료' || r.fee_type === '시간대무료') fee = '무료';
    else if (r.fee_type === '최초N분무료') fee = `최초 ${r.first_free_minutes}분 무료`;
    else fee = `유료${r.fee_info ? ' (' + r.fee_info + ')' : ''}`;
    return `· ${day} ${win} — ${fee}`;
  }).join('<br>');
}

function verifyBadge(v) {
  if (!v) return '';
  const m = { verified: ['free', '검증됨'], user: ['paid', '사용자 제보'], stale: ['partial', '재검증 필요'], disputed: ['warning', '제보 상충'] };
  const [cls, label] = m[v.status] || ['paid', v.status];
  return `<div style="margin-top:8px"><span class="badge"><span class="dot ${cls}"></span>${label}${v.check_date ? ' · ' + v.check_date : ''}</span></div>`;
}

// 오늘(기준 시각의 요일유형) 24시간 무료/유료 타임라인 — 규칙 엔진을 15분 단위로 샘플링
function timelineHtml(p, now) {
  if (!p.free_rules || !p.free_rules.length) return '';
  const probe = new Date(now);
  const segs = [];
  let cur = null;
  for (let m = 0; m < 1440; m += 15) {
    probe.setHours(Math.floor(m / 60), m % 60, 0, 0);
    const st = evaluateSpot({ properties: p }, probe, HOLIDAYS).state;
    if (cur && cur.state === st) cur.end = m + 15;
    else { cur = { state: st, start: m, end: m + 15 }; segs.push(cur); }
  }
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const bars = segs.map((s) =>
    `<span class="tl-seg ${s.state}" style="left:${(s.start / 14.4).toFixed(2)}%;width:${((s.end - s.start) / 14.4).toFixed(2)}%"></span>`).join('');
  return `<div class="tl-wrap"><div class="tl-head">오늘 무료 시간대</div>` +
    `<div class="tl">${bars}<span class="tl-now" style="left:${(nowMin / 14.4).toFixed(2)}%"></span></div>` +
    `<div class="tl-hours"><span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>24시</span></div></div>`;
}

function popupHtml(p, ev, lng, lat) {
  let body = `<div class="pp"><div class="name">${esc(p.name)}</div>` +
    `<span class="state"><span class="dot ${ev.state}"></span>${ev.label}</span>` +
    `<div class="row">${esc(ev.detail || '')}</div>`;
  if (p.category === 'legal_free') {
    if (p.address) body += `<div class="muted">${esc(p.address)}</div>`;
    body += `<div class="row">${p.num_spaces ? '주차면 ' + p.num_spaces + '면 · ' : ''}${esc(p.kind || '')} · ${esc(p.free_type || '')}</div>`;
    body += timelineHtml(p, refDate());
    body += `<div class="row" style="margin-top:7px">${rulesText(p.free_rules)}</div>`;
    if (p.hours) body += `<div class="muted" style="margin-top:4px">운영 ${esc(p.hours)}</div>`;
    if (p.tel) {
      body += `<div class="muted">문의 <a class="tel" href="tel:${esc(String(p.tel).replace(/[^0-9+\-]/g, ''))}">${esc(p.tel)}</a>` +
        (p.managing_org ? ` · ${esc(p.managing_org)}` : '') + `</div>`;
    } else if (p.managing_org) {
      body += `<div class="muted">관리 ${esc(p.managing_org)}</div>`;
    }
    if (p.note) body += `<div class="muted">${esc(p.note)}</div>`;
    body += verifyBadge(p.verify);
  } else if (p.category === 'gray_zone') {
    body += `<div class="graybox"><b>불법 주정차 구역.</b> ${esc(p.note || '')}<br>안 걸린다는 보장 없음 · 주민신고제 대상 · 본인 책임.</div>`;
    body += verifyBadge(p.verify);
  } else if (p.category === 'no_parking') {
    const r = p.risk || {};
    body += `<div class="warnbox"><b>주정차 절대금지</b> — ${esc(r.zone_type || '')}<br>과태료 ${esc(r.fine || '부과')}${r.citizen_report ? ' · 주민신고제' : ''}${r.safety_critical ? ' · 안전 위협' : ''}<br>${esc(p.note || '')}</div>`;
  }
  // 길안내(카카오맵 웹 링크, 키 불필요 — 앱 설치 시 앱으로 연결)
  if (p.category === 'legal_free' && lat != null && lng != null) {
    body += `<div class="pp-actions"><a class="btn small" target="_blank" rel="noopener" href="${NAVER_TO(p.name, lat, lng)}">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><path d="M3 11l19-8-8 19-2.5-8.5L3 11z"/></svg>길안내</a></div>`;
  }
  if (p.editable) {
    body += `<div class="pp-actions"><button class="btn small" data-act="edit" data-id="${esc(p.id)}">편집</button>` +
      `<button class="btn small danger" data-act="del" data-id="${esc(p.id)}">삭제</button></div>`;
  }
  return body + `</div>`;
}

// ── 렌더 ────────────────────────────────────────────────────────────────────
// 서버/로컬 데이터 + 공공데이터 오버레이. 공공데이터가 있으면 합법무료(공식)는 그것으로 대체,
// 사용자 제보(crowd)·단속뜸·주차금지 레이어는 유지.
function allFeatures() {
  if (!govFeatures.length) return store.all;
  const kept = store.all.filter((f) => !(f.properties.category === 'legal_free' && f.properties.source === 'official'));
  return kept.concat(govFeatures);
}
function layerFeatures(cat) {
  return allFeatures().filter((f) => f.properties.category === cat);
}

let freeNowFeatures = []; // 내 주변 리스트용 (지금 무료인 합법 스팟)

function render() {
  const now = refDate();
  const activeFts = new Set(els.fts.filter((c) => c.checked).map((c) => c.value));
  const onlyFree = els.onlyFree.checked;
  freeCluster.clearLayers(); grayLayer.clearLayers(); npLayer.clearLayers();
  const count = { legal_free: 0, gray_zone: 0, no_parking: 0 }; let nowFree = 0;
  freeNowFeatures = [];

  for (const cat of ['legal_free', 'gray_zone', 'no_parking']) {
    const checked = { legal_free: els.lyrFree, gray_zone: els.lyrGray, no_parking: els.lyrNp }[cat].checked;
    if (!checked) continue;
    // 합법무료는 마커가 많아 도시 줌 이상에서만 그림(개수는 항상 집계)
    const draw = cat === 'legal_free' ? (map.getZoom() >= MIN_MARKER_ZOOM) : true;
    for (const f of layerFeatures(cat)) {
      const p = f.properties;
      if (cat === 'legal_free' && p.free_type && !activeFts.has(p.free_type)) continue;
      const ev = evaluateSpot(f, now, HOLIDAYS);
      const isFreeNow = ev.state === 'free' || ev.state === 'partial';
      if (cat === 'legal_free' && isFreeNow) freeNowFeatures.push({ f, ev });
      if (cat === 'legal_free' && onlyFree && !isFreeNow) continue;
      count[cat]++; if (cat === 'legal_free' && isFreeNow) nowFree++;
      if (!draw) continue;
      const [lng, lat] = f.geometry.coordinates;
      L.marker([lat, lng], { icon: pinIcon(ev.state, p.editable) }).bindPopup(popupHtml(p, ev, lng, lat)).addTo(layerObj[cat]);
    }
  }

  const t = now.toLocaleString('ko-KR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  els.statsContent.innerHTML =
    `<div class="now-num ${nowFree ? 'has' : ''}"><span class="mono-num">${nowFree.toLocaleString()}</span><small>곳 지금 무료</small></div>` +
    `<div class="now-label">합법 무료 ${count.legal_free.toLocaleString()}곳${freeVisible() ? '' : ' · 지도 확대 시 표시'}</div>` +
    `<div class="breakdown">` +
      `<span class="bk"><span class="dot gray"></span>단속뜸 <b>${count.gray_zone}</b></span>` +
      `<span class="bk"><span class="dot warning"></span>주차금지 <b>${count.no_parking}</b></span>` +
      `<span class="bk">내 제보 <b>${crowdSpots().length}</b></span>` +
    `</div>` +
    `<div class="when">기준 ${t} · <span class="${isServer() ? 'sv' : ''}">${isServer() ? '공유 서버' : '로컬 저장'}</span></div>`;

  const mine = crowdSpots().length;
  const mode = isServer() ? '<span class="mode server">공유 서버 · 모두에게 보임</span>' : '<span class="mode">로컬 · 이 브라우저에만 저장</span>';
  els.mineCount.innerHTML = `${mine ? `제보 ${mine}곳` : '아직 제보가 없습니다'}<br>${mode}`;

  renderNearby();
  syncLayers();
}

// 내 주변 무료 리스트 (현위치 기준 거리정렬)
function renderNearby() {
  if (!userLoc) {
    els.near.innerHTML =
      `<div class="near-illust"><svg viewBox="0 0 96 74" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">` +
        `<ellipse cx="48" cy="60" rx="27" ry="6.5" opacity=".22"/><ellipse cx="48" cy="60" rx="15" ry="3.6" opacity=".4"/>` +
        `<path d="M48 12c-8.6 0-15.5 6.9-15.5 15.5C32.5 39 48 55 48 55s15.5-16 15.5-27.5C63.5 18.9 56.6 12 48 12z"/>` +
        `<circle cx="48" cy="27.5" r="5.6" fill="currentColor" stroke="none"/></svg></div>` +
      `<div class="near-empty">현위치를 켜면 가까운 <b>지금 무료</b> 주차를 거리순으로 보여줍니다.</div>` +
      `<button class="btn block" id="near-locate" style="margin-top:12px">현위치 켜기</button>`;
    const b = $('near-locate'); if (b) b.addEventListener('click', locate);
    return;
  }
  const items = freeNowFeatures
    .map(({ f, ev }) => { const [lng, lat] = f.geometry.coordinates; return { f, ev, d: distM(userLoc, { lat, lng }), lat, lng }; })
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  if (!items.length) { els.near.innerHTML = `<div class="near-empty">주변에 ‘지금 무료’ 스팟이 없습니다. 지도를 이동하거나 시각을 바꿔보세요.</div>`; return; }
  els.near.innerHTML = `<div class="near-list">${items.map((it, i) => {
    const until = it.ev.until != null ? ` · ${fmtHM(it.ev.until)}까지` : '';
    return `<div class="near-item" data-i="${i}"><span class="dot ${it.ev.state}"></span>` +
      `<div class="ni-main"><div class="ni-name">${esc(it.f.properties.name)}</div>` +
      `<div class="ni-sub">${it.ev.label}${until} · 도보 ${walkMin(it.d)}분</div></div>` +
      `<div class="ni-dist">${fmtDist(it.d)}</div></div>`;
  }).join('')}</div>`;
  els.near.querySelectorAll('.near-item').forEach((el) => el.addEventListener('click', () => {
    const it = items[Number(el.dataset.i)];
    map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 16));
  }));
}

function syncLayers() {
  freeVisible() ? map.addLayer(freeCluster) : map.removeLayer(freeCluster);
  els.lyrGray.checked ? map.addLayer(grayLayer) : map.removeLayer(grayLayer);
  els.lyrNp.checked ? map.addLayer(npLayer) : map.removeLayer(npLayer);
  const hint = $('zoom-hint');
  if (hint) hint.classList.toggle('hidden', !(els.lyrFree.checked && map.getZoom() < MIN_MARKER_ZOOM));
}

// ── 편집기 ──────────────────────────────────────────────────────────────────
const ed = {
  panel: $('editor'), title: $('ed-title'), hint: $('ed-hint'),
  name: $('f-name'), category: $('f-category'), freetype: $('f-freetype'),
  spaces: $('f-spaces'), zone: $('f-zone'), fine: $('f-fine'), guard: $('f-guard'),
  guardWrap: $('guard'), npNote: $('np-note'), note: $('f-note'),
  grpFree: $('grp-free'), grpRisk: $('grp-risk'), rules: $('rules'),
  coords: $('ed-coords'), errors: $('ed-errors'), delBtn: $('ed-delete'),
};
let editorOpen = false;
let editingId = null;
let pending = null;       // {lat,lng}
let placeMarker = null;

function ruleRow(rule = {}) {
  const row = document.createElement('div');
  row.className = 'rule';
  row.innerHTML = `
    <select class="r-day">${['전일', '평일', '토요일', '일요일', '주말', '공휴일'].map((d) => `<option${d === (rule.day_type || '전일') ? ' selected' : ''}>${d}</option>`).join('')}</select>
    <select class="r-fee">${['상시무료', '시간대무료', '최초N분무료', '유료'].map((d) => `<option${d === (rule.fee_type || '시간대무료') ? ' selected' : ''}>${d}</option>`).join('')}</select>
    <button type="button" class="rm" title="삭제">✕</button>
    <div class="rule-times"><input class="r-start" type="time" value="${rule.start || ''}"><input class="r-end" type="time" value="${rule.end || ''}"></div>
    <input class="r-min" type="number" min="0" placeholder="최초 N분" value="${rule.first_free_minutes || ''}">`;
  const fee = row.querySelector('.r-fee');
  const sync = () => {
    const v = fee.value;
    row.querySelector('.rule-times').style.display = (v === '시간대무료' || v === '유료') ? 'flex' : 'none';
    row.querySelector('.r-min').style.display = v === '최초N분무료' ? 'block' : 'none';
  };
  fee.addEventListener('change', sync); sync();
  row.querySelector('.rm').addEventListener('click', () => row.remove());
  return row;
}
function setRules(rules) { ed.rules.innerHTML = ''; (rules && rules.length ? rules : [{}]).forEach((r) => ed.rules.appendChild(ruleRow(r))); }
function readRules() {
  return [...ed.rules.querySelectorAll('.rule')].map((row) => ({
    day_type: row.querySelector('.r-day').value,
    fee_type: row.querySelector('.r-fee').value,
    start: row.querySelector('.r-start').value,
    end: row.querySelector('.r-end').value,
    first_free_minutes: row.querySelector('.r-min').value,
  }));
}

function syncCategoryUI() {
  const c = ed.category.value;
  ed.grpFree.classList.toggle('hidden', c !== 'legal_free');
  ed.grpRisk.classList.toggle('hidden', c === 'legal_free');
  ed.guardWrap.classList.toggle('hidden', c !== 'gray_zone');
  ed.npNote.classList.toggle('hidden', c !== 'no_parking');
}

function setPending(lat, lng) {
  pending = { lat, lng };
  ed.coords.textContent = `좌표: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (!placeMarker) {
    placeMarker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: '', html: '<div class="place-pin"><svg viewBox="0 0 24 24"><path d="M12 2C8.1 2 5 5.1 5 9c0 4.9 7 13 7 13s7-8.1 7-13c0-3.9-3.1-7-7-7z" fill="#2f6a50" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="9" r="2.4" fill="#fff"/></svg></div>', iconSize: [26, 26], iconAnchor: [13, 25] }) }).addTo(map);
    placeMarker.on('dragend', () => { const ll = placeMarker.getLatLng(); setPending(ll.lat, ll.lng); });
  } else {
    placeMarker.setLatLng([lat, lng]);
  }
}

function openEditor(feature) {
  editorOpen = true;
  ed.panel.classList.remove('hidden'); ed.panel.setAttribute('aria-hidden', 'false');
  $('locate').classList.add('hidden'); // 편집기와 겹치지 않게
  ed.errors.textContent = '';
  if (placeMarker) { map.removeLayer(placeMarker); placeMarker = null; }
  pending = null;
  if (feature) {
    const form = featureToForm(feature);
    editingId = form.id;
    ed.title.textContent = '제보 편집';
    ed.delBtn.classList.remove('hidden');
    ed.name.value = form.name; ed.category.value = form.category;
    ed.freetype.value = form.free_type; ed.spaces.value = form.num_spaces || '';
    ed.note.value = form.note; ed.zone.value = form.risk_zone_type || '';
    ed.fine.value = form.risk_fine || ''; ed.guard.checked = !!form.not_safety_critical;
    setRules(form.free_rules);
    setPending(form.lat, form.lng);
    ed.hint.style.display = 'none';
  } else {
    editingId = null;
    ed.title.textContent = '제보 추가';
    ed.delBtn.classList.add('hidden');
    ed.name.value = ''; ed.category.value = 'legal_free'; ed.freetype.value = '상시무료';
    ed.spaces.value = ''; ed.note.value = ''; ed.zone.value = ''; ed.fine.value = '';
    ed.guard.checked = false; setRules([{ day_type: '전일', fee_type: '상시무료' }]);
    ed.hint.style.display = 'block';
  }
  syncCategoryUI();
}

function closeEditor() {
  editorOpen = false; editingId = null; pending = null;
  ed.panel.classList.add('hidden'); ed.panel.setAttribute('aria-hidden', 'true');
  $('locate').classList.remove('hidden');
  if (placeMarker) { map.removeLayer(placeMarker); placeMarker = null; }
}

function collectForm() {
  return {
    id: editingId || undefined,
    name: ed.name.value, category: ed.category.value,
    free_type: ed.freetype.value, num_spaces: ed.spaces.value, note: ed.note.value,
    free_rules: readRules(),
    risk_zone_type: ed.zone.value, risk_fine: ed.fine.value,
    not_safety_critical: ed.category.value === 'gray_zone' ? ed.guard.checked : true,
    lat: pending ? pending.lat : NaN, lng: pending ? pending.lng : NaN,
  };
}

async function saveEditor() {
  const form = collectForm();
  // 서버 모드는 서버가 검증(안전가드 포함), 로컬 모드는 클라이언트 buildFeature
  const res = isServer()
    ? (editingId ? await apiUpdate(editingId, form) : await apiCreate(form))
    : buildFeature(form);
  if (res.errors.length) { ed.errors.textContent = res.errors.join('\n'); return; }
  const feature = res.feature;
  if (isServer()) { await refreshFromServer(); }
  else { store.all = upsertFeature(store.all, feature); persistLocal(); }
  // 방금 추가/편집한 제보가 바로 보이도록 해당 레이어를 켠다
  const chk = { legal_free: els.lyrFree, gray_zone: els.lyrGray, no_parking: els.lyrNp }[feature.properties.category];
  if (chk && !chk.checked) chk.checked = true;
  closeEditor();
  syncLayers(); render();
  const [lng, lat] = feature.geometry.coordinates;
  map.panTo([lat, lng]);
}

async function deleteEditor() {
  if (!editingId) return;
  if (!confirm('이 제보를 삭제할까요?')) return;
  await removeSpot(editingId);
  closeEditor();
}

async function removeSpot(id) {
  if (isServer()) { const r = await apiDelete(id); if (!r.ok) { alert('삭제 실패: ' + (r.errors || []).join(', ')); return; } await refreshFromServer(); }
  else {
    store.all = removeFeature(store.all, id);
    if (seedSnapshots.has(id)) { const t = loadTombs(); t.add(id); saveTombs(t); } // 시드 삭제는 톰스톤으로 고정
    persistLocal(); render();
  }
}

// ── 내보내기 / 가져오기 ──────────────────────────────────────────────────────
function exportUser() {
  const fc = { type: 'FeatureCollection', meta: { layer: 'user', exported: true }, features: crowdSpots() };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `무료주차_내제보_${toISO(new Date())}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}
async function importUser(file) {
  try {
    const json = JSON.parse(await file.text());
    const feats = Array.isArray(json) ? json : (json.features || []);
    let added = 0;
    for (const f of feats) {
      if (!f || !f.geometry || !f.properties) continue;
      f.properties.editable = true; f.properties.source = 'crowd';
      if (isServer()) { const form = featureToForm(f); delete form.id; await apiCreate(form); }
      else {
        if (!f.properties.id) f.properties.id = `u-imp-${Date.now()}-${added}`;
        store.all = upsertFeature(store.all, f);
      }
      added++;
    }
    if (isServer()) await refreshFromServer(); else { persistLocal(); syncLayers(); render(); }
    alert(`${added}곳 가져왔습니다.`);
  } catch (e) { alert('가져오기 실패: 올바른 JSON이 아닙니다.'); }
}

// ── 이벤트 ──────────────────────────────────────────────────────────────────
[els.lyrFree, els.lyrGray, els.lyrNp].forEach((el) => el.addEventListener('change', () => { syncLayers(); render(); }));
els.fts.forEach((c) => c.addEventListener('change', render));
els.onlyFree.addEventListener('change', render);
[els.tmNow, els.tmSim].forEach((el) => el.addEventListener('change', () => { els.simBox.classList.toggle('on', els.tmSim.checked); render(); }));
els.simDay.addEventListener('change', render);
els.simHour.addEventListener('input', () => { els.simHourLbl.textContent = fmtHM(Number(els.simHour.value) * 60); render(); });

$('panel-toggle').addEventListener('click', () => {
  document.body.classList.toggle('panel-collapsed');
  setTimeout(() => map.invalidateSize(), 60); // 패널 접힘/펼침 후 지도 크기 재계산
});

// 줌 힌트 클릭 → 도시 줌으로 확대
$('zoom-hint').addEventListener('click', () => map.setZoom(MIN_MARKER_ZOOM));

// 지역 빠른 이동
$('region-chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip-r');
  if (!b) return;
  const [lat, lng] = b.dataset.ll.split(',').map(Number);
  map.flyTo([lat, lng], Math.max(MIN_MARKER_ZOOM + 1, 12));
});

// 모바일: 지도 먼저 — 패널 섹션 기본 접힘
if (matchMedia('(max-width: 760px)').matches) {
  document.querySelectorAll('#panel details[open]').forEach((d) => { d.open = false; });
}

// ── 검색 (주차장·주소 로컬 + Enter 시 장소[Nominatim]) ──────────────────────
const qEl = $('q'), qRes = $('q-results');
let qTimer = null, qResults = [], qSeq = 0; // qSeq: 늦게 도착한 응답이 최신 결과를 덮지 않게 하는 세대 토큰

function hideResults() {
  clearTimeout(qTimer); // 대기 중 디바운스가 닫힌 드롭다운을 다시 열지 않도록
  qSeq++;               // 진행 중 장소검색 응답 무효화
  qRes.classList.add('hidden'); qRes.innerHTML = ''; qResults = [];
}

function localSearch(q) {
  const needle = q.toLowerCase();
  const scored = [];
  for (const f of allFeatures()) {
    const p = f.properties;
    if (p.category !== 'legal_free') continue;
    const name = (p.name || '').toLowerCase();
    const addr = (p.address || '').toLowerCase();
    let s = 0;
    if (name.startsWith(needle)) s = 3;
    else if (name.includes(needle)) s = 2;
    else if (addr.includes(needle)) s = 1;
    if (s) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 6).map((x) => x.f);
}

async function placeSearch(q) {
  // Nominatim(OSM) — 브라우저에서 직접 호출(CORS 허용), 한국·한국어 우선
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ko&countrycodes=kr&limit=4&q=${encodeURIComponent(q)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('place search failed');
  return (await r.json()).map((it) => ({
    place: true, name: it.name || it.display_name.split(',')[0],
    sub: it.display_name, lat: Number(it.lat), lng: Number(it.lon),
  }));
}

function renderResults(items, tip) {
  qResults = items;
  if (!items.length && !tip) { hideResults(); return; }
  qRes.innerHTML = items.map((it, i) => {
    if (it.place) {
      return `<div class="q-item" data-i="${i}">` +
        `<svg class="qi-place" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8 2 5 5 5 9c0 5 7 13 7 13s7-8 7-13c0-4-3-7-7-7z"/><circle cx="12" cy="9" r="2.4"/></svg>` +
        `<div class="qi-main"><div class="qi-name">${esc(it.name)}</div><div class="qi-sub">${esc(it.sub)}</div></div></div>`;
    }
    const p = it.properties, [lng, lat] = it.geometry.coordinates;
    const d = userLoc ? fmtDist(distM(userLoc, { lat, lng })) : '';
    return `<div class="q-item" data-i="${i}"><span class="dot free"></span>` +
      `<div class="qi-main"><div class="qi-name">${esc(p.name)}</div><div class="qi-sub">${esc(p.address || p.free_type || '')}</div></div>` +
      (d ? `<span class="qi-dist">${d}</span>` : '') + `</div>`;
  }).join('') + (tip ? `<div class="q-tip">${tip}</div>` : '');
  qRes.classList.remove('hidden');
}

async function runSearch(q, withPlaces) {
  q = q.trim();
  if (q.length < 2) { hideResults(); return; }
  const seq = ++qSeq;
  const local = localSearch(q);
  if (!withPlaces) {
    renderResults(local, local.length ? 'Enter를 누르면 장소·주소도 검색합니다' : 'Enter를 누르면 장소·주소를 검색합니다');
    return;
  }
  let places = [];
  let tip = '';
  try { places = await placeSearch(q); } catch { tip = '장소 검색 실패 — 네트워크 확인'; }
  if (seq !== qSeq) return; // 그 사이 더 새로운 검색/닫기가 있었으면 이 응답은 버림
  renderResults([...local, ...places], tip);
}

function goToResult(it) {
  hideResults(); qEl.blur();
  if (it.place) { map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 14)); return; }
  const [lng, lat] = it.geometry.coordinates;
  const ev = evaluateSpot(it, refDate(), HOLIDAYS);
  // flyTo 시간은 거리 비례(원거리 수 초) — 고정 지연 대신 비행 종료(moveend)에 팝업 오픈
  let opened = false;
  const open = () => {
    if (opened) return; opened = true;
    L.popup({ offset: [0, -26] }).setLatLng([lat, lng]).setContent(popupHtml(it.properties, ev, lng, lat)).openOn(map);
  };
  map.once('moveend', open);
  setTimeout(open, 3000); // moveend 미발화 대비 안전망
  map.flyTo([lat, lng], Math.max(map.getZoom(), 16));
}

qEl.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => runSearch(qEl.value, false), 250); });
qEl.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 한글 IME 조합 확정 Enter는 무시(중복 발사 방지)
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qTimer); runSearch(qEl.value, true); }
  else if (e.key === 'Escape') { hideResults(); qEl.blur(); }
});
qRes.addEventListener('click', (e) => {
  const el = e.target.closest('.q-item');
  if (el) goToResult(qResults[Number(el.dataset.i)]);
});
document.addEventListener('click', (e) => { if (!e.target.closest('#search')) hideResults(); });

// 현위치(GPS)
function locate() {
  if (!navigator.geolocation) { alert('이 브라우저는 위치를 지원하지 않습니다.'); return; }
  const btn = $('locate'); btn.classList.add('active');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.marker([userLoc.lat, userLoc.lng], {
        icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
        interactive: false, zIndexOffset: 1000,
      }).addTo(map);
      render();
      map.flyTo([userLoc.lat, userLoc.lng], Math.max(map.getZoom(), 15));
    },
    (err) => { btn.classList.remove('active'); alert('현위치를 가져올 수 없습니다: ' + err.message); },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}
$('locate').addEventListener('click', locate);

// 테마(라이트/다크)
function applyTheme(t) { document.documentElement.dataset.theme = t; }
$('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const isDark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = isDark ? 'light' : 'dark';
  applyTheme(next); try { localStorage.setItem('pfree.theme', next); } catch {}
});
try { const savedTheme = localStorage.getItem('pfree.theme'); if (savedTheme) applyTheme(savedTheme); } catch {}

// 안내바 닫기
try { if (localStorage.getItem('pfree.notice') === 'off') $('notice').classList.add('hidden'); } catch {}
$('notice-close').addEventListener('click', () => { $('notice').classList.add('hidden'); try { localStorage.setItem('pfree.notice', 'off'); } catch {} });

// 공공데이터 CSV/JSON을 브라우저에서 직접 불러오기 (data.go.kr 15012896 표준데이터)
async function loadGovFile(file) {
  const status = $('gov-status');
  status.textContent = '불러오는 중…';
  try {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    let res;
    if (file.name.toLowerCase().endsWith('.json')) {
      const json = JSON.parse(text);
      const items = Array.isArray(json) ? json : (json.data || json.records || json.features || []);
      const rows = items.map((it) => (it.properties ? it.properties : it));
      res = rowsToFeatures(rows.length ? Object.keys(rows[0]) : [], rows);
    } else {
      // 한글 헤더가 깨지면 EUC-KR/CP949로 재디코딩
      if (!/주차장|위도/.test(text.slice(0, 4000))) { try { text = new TextDecoder('euc-kr').decode(buf); } catch {} }
      res = csvToFeatures(text);
    }
    if (!res.features.length) {
      status.textContent = '무료 주차장을 찾지 못했습니다. 전국주차장정보표준데이터(15012896) CSV/JSON이 맞는지 확인하세요.';
      return;
    }
    govFeatures = res.features;
    if (!els.lyrFree.checked) els.lyrFree.checked = true;
    syncLayers(); render();
    const b = L.latLngBounds(govFeatures.map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]]));
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30] });
    status.innerHTML = `<span class="mode server">전국 무료주차 ${res.features.length.toLocaleString()}곳 불러옴</span> · 이 세션 표시 (원본 ${res.stats.total.toLocaleString()}행)`;
  } catch (e) {
    status.textContent = '읽기 실패: ' + e.message;
  }
}
$('btn-gov').addEventListener('click', () => $('gov-file').click());
$('gov-file').addEventListener('change', (e) => { if (e.target.files[0]) loadGovFile(e.target.files[0]); e.target.value = ''; });

$('btn-add').addEventListener('click', () => openEditor(null));
$('btn-export').addEventListener('click', exportUser);
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', (e) => { if (e.target.files[0]) importUser(e.target.files[0]); e.target.value = ''; });

$('ed-close').addEventListener('click', closeEditor);
$('ed-cancel').addEventListener('click', closeEditor);
$('ed-save').addEventListener('click', saveEditor);
$('ed-delete').addEventListener('click', deleteEditor);
ed.category.addEventListener('change', syncCategoryUI);
$('rule-add').addEventListener('click', () => ed.rules.appendChild(ruleRow()));
document.querySelectorAll('.chip[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const p = b.dataset.preset;
  if (p === 'always') { ed.freetype.value = '상시무료'; setRules([{ day_type: '전일', fee_type: '상시무료' }]); }
  else if (p === 'night') { ed.freetype.value = '시간제무료'; setRules([{ day_type: '평일', fee_type: '시간대무료', start: '18:00', end: '09:00' }, { day_type: '주말', fee_type: '시간대무료' }]); }
  else if (p === 'firstN') { ed.freetype.value = '시간제무료'; setRules([{ day_type: '전일', fee_type: '최초N분무료', first_free_minutes: 30 }]); }
}));

// 지도 클릭 → 위치 지정 (편집기 열려 있을 때만)
map.on('click', (e) => { if (editorOpen) setPending(e.latlng.lat, e.latlng.lng); });

// 줌 변경 시 마커 표시 갱신 (도시 줌 이상에서만 그림). 서버 모드는 moveend가 처리.
map.on('zoomend', () => { if (!isServer()) render(); else syncLayers(); });

// 팝업 편집/삭제 버튼 (이벤트 위임)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const f = store.all.find((x) => x.properties.id === btn.dataset.id);
  if (!f) return;
  map.closePopup();
  if (btn.dataset.act === 'edit') openEditor(f);
  else if (btn.dataset.act === 'del') { if (confirm('이 제보를 삭제할까요?')) removeSpot(f.properties.id); }
});

// ── 로드 ────────────────────────────────────────────────────────────────────
let bboxTimer = null;
async function load() {
  const server = await detectServer();
  if (server) {
    // 공유 서버 모드: 뷰포트로 읽고, 지도 이동 시 재조회(뷰포트 API)
    store.all = await apiLoad(currentBbox());
    map.on('moveend', () => { clearTimeout(bboxTimer); bboxTimer = setTimeout(refreshFromServer, 300); });
  } else {
    // 로컬 모드: 실데이터(free-parking.json, ingest 산출물) 우선, 없으면 시드 + localStorage
    const getJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const free = (await getJson('./data/free-parking.json')) || (await getJson('./data/free-parking.seed.json')) || { features: [] };
    const [community, gray, np] = await Promise.all([
      getJson('./data/community.seed.json'),
      getJson('./data/gray-zones.seed.json'),
      getJson('./data/no-parking.seed.json'),
    ]);
    // 커뮤니티 시드 스냅샷 등록(편집 여부 판별·톰스톤 대상 식별용)
    const communityFeats = (community || {}).features || [];
    for (const f of communityFeats) seedSnapshots.set(f.properties.id, JSON.stringify(f));

    // localStorage 정리: ① 시드 원본과 동일한 자동 사본 제거(시드 업데이트 통과)
    // ② 과거 버전이 자동 저장한 소두방공원 구좌표 사본 제거(좌표 수정이 막히던 문제 치유)
    const rawUser = loadUserSpots();
    let user = rawUser.filter((f) => {
      const id = f.properties.id;
      if (JSON.stringify(f) === seedSnapshots.get(id)) return false;
      if (id === 'comm-sodubang-park') {
        const [lng, lat] = f.geometry.coordinates;
        if (lng === 129.185 && lat === 35.32) return false; // 구시드 자동 사본 시그니처
      }
      return true;
    });
    if (user.length !== rawUser.length) saveUserSpots(user); // 정리된 목록을 저장소에도 반영

    // 같은 id는 저장본(사용자 편집)이 시드를 이김 + 삭제 톰스톤 적용
    const tombs = loadTombs();
    const userIds = new Set(user.map((f) => f.properties.id));
    const base = [...(free.features || []), ...communityFeats, ...((gray || {}).features || []), ...((np || {}).features || [])];
    store.all = [...base.filter((f) => !userIds.has(f.properties.id) && !tombs.has(f.properties.id)), ...user];
  }
  syncLayers(); render();
}

load().catch((e) => {
  $('stats-content').innerHTML = `<b style="color:var(--s-warn)">데이터 로드 실패</b><br>정적 서버로 실행: <code>npm run dev</code> 또는 공유 서버 <code>npm run server</code>`;
  console.error(e);
});
