import { evaluateSpot, STATE_COLOR, fmtHM } from './lib/freeRules.js';
import { holidaySet } from './lib/holidays.js';
import {
  buildFeature, featureToForm, upsertFeature, removeFeature,
  loadUserSpots, saveUserSpots,
} from './lib/userSpots.js';
import { detectServer, isServer, apiLoad, apiCreate, apiUpdate, apiDelete } from './lib/backend.js';

const HOLIDAYS = holidaySet();

// ── 지도 ────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true, zoomSnap: 0.5 }).setView([37.5665, 126.9769], 12);
// 레티나(@2x) 지원 베이스맵 — 고해상도 화면에서 선명. (프로덕션은 Kakao Map 권장)
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 20,
  detectRetina: true,
  subdomains: 'abcd',
  attribution: '&copy; OpenStreetMap &copy; CARTO · 무료주차: 공공데이터/사용자 제보',
}).addTo(map);

const freeCluster = L.markerClusterGroup({ maxClusterRadius: 45, spiderfyOnMaxZoom: true });
const grayLayer = L.layerGroup();
const npLayer = L.layerGroup();
const layerObj = { legal_free: freeCluster, gray_zone: grayLayer, no_parking: npLayer };

// store.all = 전체 스팟(공식 시드 + 사용자 제보). 서버 모드면 서버에서, 로컬 모드면 시드+localStorage.
const store = { all: [] };
const crowdSpots = () => store.all.filter((f) => f.properties.editable);
const persistLocal = () => { if (!isServer()) saveUserSpots(crowdSpots()); };
const currentBbox = () => { const b = map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; };
async function refreshFromServer() { store.all = await apiLoad(currentBbox()); render(); }

const $ = (id) => document.getElementById(id);
const els = {
  lyrFree: $('lyr-free'), lyrGray: $('lyr-gray'), lyrNp: $('lyr-np'),
  fts: [...document.querySelectorAll('.ft')],
  tmNow: $('tm-now'), tmSim: $('tm-sim'), simBox: $('sim-box'),
  simDay: $('sim-day'), simHour: $('sim-hour'), simHourLbl: $('sim-hour-lbl'),
  onlyFree: $('only-free'), stats: $('stats'), mineCount: $('mine-count'),
};

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

// ── 마커 ────────────────────────────────────────────────────────────────────
function pinIcon(state, isUser) {
  const warn = state === 'warning';
  return L.divIcon({
    className: '',
    html: `<div class="pin ${warn ? 'warning' : ''}" style="background:${STATE_COLOR[state]}${isUser ? ';outline:2px solid #2b6cff;outline-offset:1px' : ''}"></div>`,
    iconSize: [18, 18], iconAnchor: warn ? [9, 9] : [9, 16], popupAnchor: [0, warn ? -10 : -16],
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
  const m = { verified: '✅ 검증됨', user: '👤 사용자 제보', stale: '⏳ 재검증 필요', disputed: '⚠️ 제보 상충' };
  return `<div style="margin-top:6px"><span class="badge">${m[v.status] || v.status} · ${v.check_date || ''}</span></div>`;
}

function popupHtml(p, ev) {
  const color = STATE_COLOR[ev.state];
  let body = `<div class="pp"><div class="name">${esc(p.name)}</div>` +
    `<span class="state" style="background:${color}">${ev.label}</span>` +
    `<div class="row">${esc(ev.detail || '')}</div>`;
  if (p.category === 'legal_free') {
    if (p.address) body += `<div class="muted">${esc(p.address)}</div>`;
    body += `<div class="row">${p.num_spaces ? '주차면 ' + p.num_spaces + '면 · ' : ''}${esc(p.kind || '')} · ${esc(p.free_type || '')}</div>`;
    body += `<div class="row" style="margin-top:6px">${rulesText(p.free_rules)}</div>`;
    if (p.note) body += `<div class="muted">${esc(p.note)}</div>`;
    body += verifyBadge(p.verify);
  } else if (p.category === 'gray_zone') {
    body += `<div class="graybox">🚫 <b>불법 주정차 구역.</b> ${esc(p.note || '')}<br>안 걸린다는 <u>보장 없음</u> · 주민신고제 대상 · 본인 책임.</div>`;
    body += verifyBadge(p.verify);
  } else if (p.category === 'no_parking') {
    const r = p.risk || {};
    body += `<div class="warnbox">⛔ <b>주정차 절대금지</b> — ${esc(r.zone_type || '')}<br>과태료 ${esc(r.fine || '부과')}${r.citizen_report ? ' · 주민신고제' : ''}${r.safety_critical ? ' · 안전 위협' : ''}<br>${esc(p.note || '')}</div>`;
  }
  if (p.editable) {
    body += `<div class="pp-actions"><button class="btn small" data-act="edit" data-id="${esc(p.id)}">편집</button>` +
      `<button class="btn small danger" data-act="del" data-id="${esc(p.id)}">삭제</button></div>`;
  }
  return body + `</div>`;
}

// ── 렌더 ────────────────────────────────────────────────────────────────────
function layerFeatures(cat) {
  return store.all.filter((f) => f.properties.category === cat);
}

function render() {
  const now = refDate();
  const activeFts = new Set(els.fts.filter((c) => c.checked).map((c) => c.value));
  const onlyFree = els.onlyFree.checked;
  freeCluster.clearLayers(); grayLayer.clearLayers(); npLayer.clearLayers();
  const count = { legal_free: 0, gray_zone: 0, no_parking: 0 }; let nowFree = 0;

  for (const cat of ['legal_free', 'gray_zone', 'no_parking']) {
    const on = { legal_free: els.lyrFree, gray_zone: els.lyrGray, no_parking: els.lyrNp }[cat].checked;
    if (!on) continue;
    for (const f of layerFeatures(cat)) {
      const p = f.properties;
      if (cat === 'legal_free' && p.free_type && !activeFts.has(p.free_type)) continue;
      const ev = evaluateSpot(f, now, HOLIDAYS);
      const isFreeNow = ev.state === 'free' || ev.state === 'partial';
      if (cat === 'legal_free' && onlyFree && !isFreeNow) continue;
      count[cat]++; if (cat === 'legal_free' && isFreeNow) nowFree++;
      const [lng, lat] = f.geometry.coordinates;
      L.marker([lat, lng], { icon: pinIcon(ev.state, p.editable) }).bindPopup(popupHtml(p, ev)).addTo(layerObj[cat]);
    }
  }

  const t = now.toLocaleString('ko-KR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  els.stats.innerHTML = `<b>기준: ${t}</b><br>합법 무료 ${count.legal_free}곳 중 <b style="color:var(--free)">지금 무료 ${nowFree}곳</b><br>단속 뜸함 ${count.gray_zone}곳 · 주차금지 ${count.no_parking}곳`;
  const mine = crowdSpots().length;
  const mode = isServer() ? '🌐 공유 서버 (모두에게 보임)' : '📴 로컬 (이 브라우저에만 저장)';
  els.mineCount.innerHTML = `${mine ? `제보 ${mine}곳` : '아직 제보 없음 — ‘제보 추가’로 시작'}<br><span class="mode">${mode}</span>`;
}

function syncLayers() {
  els.lyrFree.checked ? map.addLayer(freeCluster) : map.removeLayer(freeCluster);
  els.lyrGray.checked ? map.addLayer(grayLayer) : map.removeLayer(grayLayer);
  els.lyrNp.checked ? map.addLayer(npLayer) : map.removeLayer(npLayer);
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
    placeMarker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: '', html: '<div class="place-pin">📍</div>', iconSize: [26, 26], iconAnchor: [13, 24] }) }).addTo(map);
    placeMarker.on('dragend', () => { const ll = placeMarker.getLatLng(); setPending(ll.lat, ll.lng); });
  } else {
    placeMarker.setLatLng([lat, lng]);
  }
}

function openEditor(feature) {
  editorOpen = true;
  ed.panel.classList.remove('hidden'); ed.panel.setAttribute('aria-hidden', 'false');
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
  if (res.errors.length) { ed.errors.textContent = '⚠ ' + res.errors.join('\n⚠ '); return; }
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
  else { store.all = removeFeature(store.all, id); persistLocal(); render(); }
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
    // 로컬 모드: 시드 JSON + localStorage
    const [free, gray, np] = await Promise.all([
      fetch('./data/free-parking.seed.json').then((r) => r.json()),
      fetch('./data/gray-zones.seed.json').then((r) => r.json()),
      fetch('./data/no-parking.seed.json').then((r) => r.json()),
    ]);
    store.all = [...(free.features || []), ...(gray.features || []), ...(np.features || []), ...loadUserSpots()];
  }
  syncLayers(); render();
}

load().catch((e) => {
  $('stats').innerHTML = `<b style="color:var(--warning)">데이터 로드 실패</b><br>정적 서버로 실행: <code>npm run dev</code> 또는 공유 서버 <code>npm run server</code>`;
  console.error(e);
});
