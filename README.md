# 🅿️ 전국 무료주차맵

전국의 **합법 무료주차**를 찾고, **과태료 위험구역은 경고**로 알려주는 지도. 유료주차로 돈 버는 기존 앱들이 무료를 부가 필터로만 다루는 반면, 이 서비스는 **무료 그 자체를 제품 전체로** 삼는다.

이 저장소는 동작하는 MVP 프로토타입이다. **전국 실데이터(전국주차장정보표준데이터 2026-06-23)에서 무료 11,739곳이 기본 적용**되어 있다(`data/free-parking.json`). 최신본 갱신은 아래 "전국 실데이터 적용하기" 참고.

---

## 빠른 실행

```bash
npm run server     # 🌐 공유 서버(멀티플레이) → http://localhost:8000  ★권장
npm run dev        # 📴 로컬 전용(시드+localStorage) → http://localhost:8000
npm test           # 유닛 테스트 (node --test, 34개)
```

- **`npm run server`**: Node 내장 SQLite 백엔드 + REST API. 제보가 **공유 서버에 저장되어 모든 사용자에게 보인다**(진짜 크라우드소싱).
- **`npm run dev`**: 백엔드 없이 시드 데이터 + `localStorage`. 앱은 서버 유무를 자동 감지해 두 모드를 오간다.
- 모듈 import 때문에 `file://` 직접 열기는 안 되고 정적 서버 필요.

## 공유 서버 (멀티플레이) — `npm run server`

싱글플레이(localStorage) → 멀티플레이 각성. `scripts/server.mjs`가 Node **내장 `node:sqlite`**로 REST API를 연다(외부 계정·의존성 없음). 프런트(`lib/backend.js`)는 `GET /api/health`로 서버를 감지해 모드를 전환한다.

| 메서드 | 엔드포인트 | 설명 |
|---|---|---|
| `GET` | `/api/health` | 모드·스팟 수 |
| `GET` | `/api/spots?bbox=minLng,minLat,maxLng,maxLat&cat=` | **뷰포트 질의**(보는 만큼만) |
| `POST` | `/api/spots` | 제보 생성 — 서버가 `buildFeature`로 검증(**안전가드 서버측 강제**) |
| `PATCH` | `/api/spots/:id` | 수정 (editable 스팟만) |
| `DELETE` | `/api/spots/:id` | 삭제 (공식 시드는 403) |

- 최초 실행 시 시드 3파일을 DB(`data/spots.db`, gitignore)로 1회 이관.
- 지도를 움직이면 새 bbox로 재조회(뷰포트 API — 전국 수만 곳으로 확장 대비).
- **프로덕션 경로**: 이 스키마/엔드포인트를 그대로 **Supabase(PostGIS + Auth + RLS)**로 승격 → 카카오 로그인, `ST_Intersects` 공간질의, `submitted_by = auth.uid()` 정책. 좌표 영구저장은 VWorld 지오코딩.

## 내 제보 (사용자 편집)

좌측 **‘제보 추가’** → 지도를 클릭해 위치 지정(📍 마커 드래그로 미세조정) → 이름·분류·무료규칙 입력 → 저장. 마커 팝업에서 **편집·삭제**. 공유 서버 모드면 **모두에게 즉시 반영**, 로컬 모드면 `localStorage`에 저장. **⬇ 내보내기 / ⬆ 가져오기**(JSON)로 백업·공유.

- 시드 데이터는 읽기 전용, **내 제보만 편집 가능**(파란 테두리 마커).
- **안전 가드**: ‘단속 뜸한 곳(불법)’ 제보는 *소화전·스쿨존·횡단보도·버스정류소·교차로가 아님*을 확인해야 등록(클라이언트+**서버 양쪽 강제**). ‘주차금지’ 분류는 항상 경고(safety_critical)로 저장.
- 순수 로직(`lib/userSpots.js`: 검증·안전가드·규칙 정규화·직렬화)은 UI·서버와 분리해 유닛 테스트로 커버.

---

## 핵심 아이디어: 무료는 "시간 조건부"다

한국 무료주차는 `무료/유료` 불리언이 아니다. **평일유료·주말무료**, **18시 이후 무료**, **최초 30분 무료**, **명절 무료개방**, **거주자우선 야간개방**… 아무도 이 뉘앙스를 구조화하지 않았다. 이 앱의 코어는 `free_rules[]`(요일유형 × 시간창 × 요금유형)를 두고 **"지금 무료냐?"**를 판정하는 규칙 엔진(`lib/freeRules.js`)이다. 좌측 패널의 *기준 시각 지정*으로 "토요일 밤엔 무료인 곳"을 즉시 확인할 수 있다.

---

## 3개 레이어 (제품 정책의 핵심)

| 레이어 | 내용 | 처리 |
|---|---|---|
| 🟢 **합법 무료** | 공영 무료/개방·관공서 야간개방·거주자우선 개방·민간 개방·명절 무료 | 지도 표시·추천·"지금 무료냐" 판정 |
| 🟡 **단속 뜸한 곳(불법)** | "여기 잘 안 걸린다"는 제보 구역 | **추천 아님, 정직한 위험 정보만** — "불법·주민신고제 대상·과태료·본인 책임" 라벨. **안전 치명 구역(소화전/스쿨존/횡단보도/버스정류소/교차로)은 이 레이어에 절대 안 넣음** |
| 🔴 **주차금지 경고** | 도로교통법 §32/§33 절대금지구역 | 추천이 아니라 **빨간 경고**로 뒤집어 표시(친-안전) |

### 왜 "단속 안 하는 곳"을 이렇게 다루나
- **주민신고제**(안전신문고, 사진 2장 1분 간격 → 현장 단속관 없이 자동 과태료)가 확대 중이라 "안 걸리는 곳"은 갈수록 줄어든다 — 여기 베팅하면 "괜찮다더니 티켓"으로 신뢰가 무너진다.
- **민법 §760③ 방조 책임**: 앱이 사용자를 소화전·스쿨존으로 적극 유도해 사고로 이어지면 공동불법행위 소지. 위험은 *얼마나 적극 추천했나*에 비례하므로, 안전 치명 구역은 절대 "주차 가능" 마커로 만들지 않는다.
- 그래서 "단속 회피"가 아니라 **"합법 무료 찾기 + 과태료 회피"**로 같은 니즈를 리스크 없이 충족한다.

---

## 데이터 소스 (Phase 1 시드)

| 역할 | 데이터셋 | ID |
|---|---|---|
| BASE | 전국주차장정보표준데이터 | data.go.kr `15012896` |
| OVERLAY | 공공개방자원 '주차장 목록'(공유누리) | data.go.kr `15077522` |
| OVERLAY | 서울시 공영주차장 안내(GetParkInfo) — `야간무료개방여부` 규준 | 서울 `OA-13122` |
| 보강 | 거주자우선 표준 / 부설개방(대구) / 명절무료 | `15021105` / `15108762` / `15099790` |

모두 무료·저장/상업재사용 가능(대개 KOGL 제1유형, 이용허락범위 개별 확인). 좌표 지오코딩은 저장 가능한 **VWorld(국토부)** 권장.

### 전국 실데이터 적용하기

**방법 0 (가장 쉬움 · 폰에서도) — 앱에서 CSV 바로 불러오기**
data.go.kr에서 표준데이터 CSV를 받은 뒤, 앱 좌측 **‘데이터 출처 → 공공데이터 CSV 불러오기’**에서 그 파일을 고르면 끝. **PC·터미널·node 불필요**, 브라우저에서 `lib/ingest.js`로 파싱(무료 필터·`free_rules`·EUC-KR/UTF-8 자동)해 전국 무료주차를 즉시 지도에 표시(해당 세션). 서버에 영구 반영하려면 아래 파일/API 방식 사용.

**방법 1·2 (영구 반영) — `scripts/ingest.mjs`**
표준데이터를 **무료만 필터 + `free_rules` 정규화**해 `data/free-parking.json`으로 변환하고, **앱/서버는 이 파일이 있으면 시드 대신 자동 로드**한다.

```bash
# 방법 1 (권장): CSV 파일로 — data.go.kr 활용신청/키 불필요
#   1) https://www.data.go.kr/data/15012896/standard.do → '다운로드'(CSV)
#   2) 변환 (EUC-KR/UTF-8, CSV/JSON 자동 처리):
node scripts/ingest.mjs 전국주차장정보표준데이터.csv
#   3) 재시작 → 전국 무료주차가 지도에 뜸
npm run server   # 또는 npm run dev

# 방법 2: Open API (활용신청 후 서비스키)
SERVICE_KEY=발급키 API_URL='https://api.odcloud.kr/api/15012896/v1/uddi:...' node scripts/ingest.mjs
```

- 필터 규칙: `요금정보=무료` 또는 `주차기본요금=0` → 상시무료 / `혼합`+기본요금0 → 최초N분무료 / 그 외(유료) 제외. KR bbox 밖·좌표누락 자동 제거, `주차장관리번호` 중복 제거.
- `data/free-parking.json`은 `.gitignore` 대상(대용량·재생성 가능). 변환 로직은 `lib/ingest.js`에 순수 함수로 두고 유닛테스트(`test/ingest.test.js`)로 커버.
- ⚠️ 폐쇄망/허용목록 환경(예: 일부 CI)에서는 data.go.kr 접근이 막힐 수 있으니, 위 **CSV 파일 방식**을 쓰면 네트워크 없이 적용된다.

---

## 데이터 모델

`data/*.seed.json` — GeoJSON `FeatureCollection`. 주요 `properties`:

```jsonc
{
  "category": "legal_free | gray_zone | no_parking",
  "kind": "공영|민영|부설|거주자우선|노상|회색지대|금지구역",
  "free_type": "상시무료|시간제무료|공영개방|민간개방",   // legal_free
  "free_rules": [
    { "day_type": "평일|토요일|일요일|주말|공휴일|전일",
      "start": "18:00", "end": "09:00",
      "fee_type": "상시무료|시간대무료|최초N분무료|유료",
      "first_free_minutes": 30, "fee_info": "이후 10분당 500원" }
  ],
  "risk":   { "zone_type": "...", "fine": "...", "citizen_report": true, "safety_critical": true },  // gray/no_parking
  "verify": { "status": "verified|user|stale|disputed", "check_date": "YYYY-MM-DD", "confidence": 0.8 },
  "source": "official|crowd", "source_dataset": "15012896"
}
```

---

## 기술 스택

- **프로토타입**: Leaflet + `leaflet.markercluster` + **CARTO Voyager 레티나(@2x) 타일**(고해상도 화면 대응, `detectRetina`), 바닐라 JS(ES module). Leaflet은 `vendor/`에 포함해 설치·CDN 없이 동작. 규칙 엔진·제보 로직은 프레임워크 무관 순수 모듈.
- **프로덕션 권장**: 베이스맵 **Kakao Map**(도로명·POI 우수, 1st-party 무료 클러스터러) + 지오코딩 **VWorld**(좌표 영구저장 가능) + 백엔드 **PostgreSQL/PostGIS**(반경검색·conflation).

---

## 로드맵

- **Phase 1** — 공공데이터 시드 → 무료 필터 → `free_rules` 정규화 → 지도 표시 + 안전경고 레이어. *(현재 프로토타입 = 이 구조 + 예시 데이터)*
- **Phase 2** — 크라우드소싱: *(현재 = 로컬 편집/제보 + **공유 서버(SQLite REST API·뷰포트 질의·서버측 검증) 구현 ✅**)* → 다음은 카카오 로그인/Supabase 승격, 원탭 "아직 무료?" 확인, 사진 증빙, **GPS 반경 검증(proof-of-presence)**, 파괴적 편집 고증거, 속성별 시간감쇠 신뢰도.
- **Phase 3** — 실시간 여유면수(KOTSA `15099883`), 거주자우선 개방 캘린더, 지역 확장, 합법 수익화(주차공유·개방 예약).

---

## 파일 구조

```
index.html · app.js · styles.css     지도 UI + 제보 편집기
lib/freeRules.js                     "지금 무료냐" 규칙 엔진 (코어)
lib/userSpots.js                     사용자 제보: 검증·안전가드·규칙정규화·저장
lib/backend.js                       프런트 데이터 계층 (공유 서버 ↔ 로컬 자동 전환)
lib/ingest.js                        표준데이터 → 무료 GeoJSON 변환 (파싱·필터·free_rules)
lib/holidays.js                      공휴일(프로토타입용)
data/*.seed.json                     3개 레이어 시드 데이터
data/free-parking.json               (ingest 산출물, gitignore) 있으면 실데이터로 자동 사용
vendor/…                             Leaflet 1.9.4 / markercluster 1.5.3 / Pretendard (오프라인)
scripts/server.mjs                   공유 백엔드 (내장 SQLite + REST API + 정적 서빙)
scripts/serve.mjs                    무의존 정적 서버 (로컬 모드)
scripts/ingest.mjs                   전국 실데이터 인제스트 (CSV/JSON 파일 · Open API)
test/freeRules.test.js               규칙 엔진 유닛 테스트 (12)
test/userSpots.test.js               제보 로직 유닛 테스트 (10)
test/server.test.js                  공유 서버 API 테스트 (5)
test/ingest.test.js                  실데이터 변환 파이프라인 테스트 (7)
```
