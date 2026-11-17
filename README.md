# HWPX 동시편집

한글 문서(HWPX/HWP)를 여러 사람이 브라우저에서 동시에 고치는 프로그램입니다.
「HWPX 실시간 동시편집 개발계획」의 **2단계(텍스트 동시편집)** 를 중심으로, 3단계 일부(글자 서식, 표 셀 내용)까지 동작하는 첫 구현입니다.

```
브라우저 (rHWP 편집기 + Yjs)  ⇄  동기화 서버 (Hocuspocus)  →  저장 워커 (HWPX 생성)  →  파일 저장소 / WebDAV(Nextcloud)
```

## 실행

Node.js 22 이상이 필요합니다.

```bash
npm install
npm run build     # 웹 화면 빌드 (dist/web)
npm start         # http://localhost:8787
```

개발할 때는 `npm run dev` (서버 8787 + Vite 5173).
Docker: `docker build -t hwpx-coedit . && docker run -p 8787:8787 -v hwpx-data:/data hwpx-coedit`

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | 서버 주소 |
| `DATA_DIR` | `./data` | 원본·편집 상태·저장본 위치 |
| `WEBDAV_URL`, `WEBDAV_USER`, `WEBDAV_PASSWORD` | 없음 | 지정하면 저장본을 WebDAV 폴더(Nextcloud 등)에도 올림 |

## 할 수 있는 것

- HWPX/HWP 파일 올리기, 빈 문서로 시작, 문서 목록
- 본문과 **표 셀** 안의 글자 동시편집 (입력·삭제·문단 나누기/합치기·여러 줄 붙여넣기)
- 다른 참여자의 커서·선택 영역·이름 표시
- 한글 입력기(IME) 조합 처리 — 조합 중에는 다른 사람의 변경을 미뤘다가 조합이 끝나면 반영
- 굵게·기울임·밑줄·취소선·글자색, 실행 취소/다시 실행(내 편집만)
- 자동 저장(편집이 멈추면 HWPX 생성), 시점별 저장본, HWPX 내려받기
- 저장 검사 — 만든 HWPX를 다시 열어 글자가 편집 상태와 같은지 매번 확인

## 아직 없는 것

- 로그인·권한 (지금은 주소를 아는 사람 누구나 편집 가능 → 내부망이나 인증 프록시 뒤에서만 쓰세요)
- 표 구조 편집(행·열 추가 등), 그림·개체 편집, 표 안의 표, 머리말·꼬리말·각주 편집 — 화면에는 보이지만 고칠 수 없습니다
- 문단 서식(정렬·줄 간격), 글꼴·크기 변경
- PostgreSQL 저장, Keycloak 연동, XLSX(ONLYOFFICE) 서비스, 부하 시험
- 한컴오피스에서 저장본이 제대로 열리는지에 대한 검증 (rHWP로 다시 여는 검사만 자동화되어 있음)

표·그림을 품은 문단은 지워지지 않도록 보호됩니다(그 문단 앞에서 Backspace로 합치기 불가).
글꼴은 보는 사람의 컴퓨터에 설치된 것을 쓰므로, 한컴 글꼴이 없으면 줄 나눔이 한글 프로그램과 다를 수 있습니다.

## 동작 원리

- **원본은 그대로 두고 변경만 공유합니다.** 모든 참여자와 저장 워커가 같은 원본 파일을 rHWP로 열고,
  Yjs 문서(문단 리스트 + 문단별 `Y.Text`)에 담긴 편집 상태를 그 위에 맞춥니다.
- **연산 재생이 아니라 상태 맞추기.** `Reconciler`가 바뀐 문단만 골라 rHWP 문서를 Yjs 상태와 같게 만듭니다.
  실시간 편집, 늦게 들어온 참여자, 실행 취소, 저장 워커가 모두 같은 코드를 쓰므로 결과가 같습니다.
- **서식 보존.** 글자마다 원본의 글자모양 번호(`cs`)를 속성으로 들고 다녀, 문단을 나누거나 합쳐도 글꼴·크기가 유지됩니다.

| 경로 | 내용 |
|---|---|
| `src/shared/model.js` | Yjs 데이터 모델, 원본 문서 훑기, 초기 상태 만들기 |
| `src/shared/ops.js` | 편집 연산 (모두 Yjs 연산) |
| `src/shared/reconciler.js` | Yjs 상태 → rHWP 문서 맞추기 |
| `src/shared/hwp-adapter.js` | rHWP API를 본문/표 셀 공통으로 감싼 어댑터 |
| `server/` | REST API, Hocuspocus 동기화, 저장 워커, 파일 저장소, WebDAV |
| `web/` | 편집기 화면 (쪽 그리기, 커서, 입력 처리) |

## 시험

```bash
npm test                          # 단위·통합 시험 (무작위 3인 동시편집 수렴 시험 포함)
npm run build && npm run test:e2e # 브라우저 두 개로 실제 동시편집 (Playwright 필요)
```

시험 문서는 rHWP로 만든 견본입니다. 실제 업무 서식으로의 검증(계획의 0단계)은 아직 하지 않았습니다.

## 사용한 오픈소스

rHWP `@rhwp/core` (MIT), Yjs (MIT), Hocuspocus (MIT), Express (MIT), Vite (MIT)
