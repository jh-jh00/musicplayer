# 유튜브 플레이어를 내 주소에 만들기

기존 플레이어의 설치용 소스입니다. 내 Cloudflare 계정에 복사해 나만의 주소를 만들 수 있습니다. 직접 설치할 분은 아래 1단계부터 시작하세요. AI 에이전트가 있는 분은 **`playlist-player-self-host.zip`과 `AI-HANDOFF-KO.md` 두 파일**을 같은 대화에 첨부하고 “첨부한 안내대로 내 계정에 설치해줘”라고 보내세요.

**어디까지 설치할지 먼저 고르세요.** 1~5단계면 단일 YouTube 영상 링크를 붙여 넣어 재생하고, 같은 브라우저에 재생목록을 저장할 수 있습니다. **6단계**는 제목 검색·채널·재생목록 가져오기를 켭니다. **7단계**는 Google 로그인과 기기 간 동기화를 켭니다.

## 1. 준비하기

- **ZIP 파일**을 내려받고 **모두 압축 풀기**를 누릅니다. 압축을 푼 폴더 안에 `package.json`, `wrangler.jsonc`, `schema.sql`이 보이면 맞는 폴더입니다.
- **Node.js** 사이트의 **LTS** 버전을 설치합니다. Windows라면 Windows Installer를 받아 기본 설정으로 설치합니다. [Node.js 다운로드](https://nodejs.org/en/download)
- **Cloudflare**에 로그인하고 **Workers & Pages**를 엽니다. **Workers Free**로 시작하세요. `workers.dev` 주소를 만들라는 화면이 뜨면 원하는 계정용 이름을 적습니다. 이미 같은 이름의 Worker를 운영한다면 배포 전에 `wrangler.jsonc`의 맨 위 `name`을 새로운 영문 소문자 이름으로 바꿉니다. [Cloudflare 대시보드](https://dash.cloudflare.com/) · [무료 workers.dev 주소 설정](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

## 2. 명령어를 입력할 창 열기

Windows에서는 압축을 푼 폴더를 파일 탐색기로 열고, 위쪽 **주소창**을 클릭합니다. `cmd`를 입력하고 **Enter**를 누르면 그 폴더에서 명령 프롬프트가 열립니다. macOS에서는 터미널에 `cd `를 입력한 뒤 압축을 푼 폴더를 터미널 위로 끌어오고 Enter를 누릅니다.

아래는 **한 줄씩** 복사합니다. 한 줄을 실행하고 끝나면 다음 줄로 넘어갑니다. `node --version`에서 버전이 나오면 설치가 된 겁니다.

```text
node --version
npm ci
npm test
```

`npm test`에서 `PASS`가 나오면 파일을 확인한 겁니다. `node` 또는 `npm`을 찾을 수 없으면 Node.js 설치 후 창을 닫았다 다시 여세요. `package.json`이 없다는 오류가 나오면 1단계에서 확인한 폴더에서 다시 엽니다.

## 3. Cloudflare 연결하기

```text
npx wrangler login
```

브라우저 창이 열리면 **내가 방금 만든 Cloudflare 계정**으로 로그인하고 권한 허용 버튼을 누릅니다. 다시 터미널로 돌아와 아래 명령을 입력합니다. 여러 계정이 보이면 대상 계정을 먼저 확인하고 진행하세요. [Wrangler 로그인 안내](https://developers.cloudflare.com/workers/wrangler/commands/#login)

```text
npx wrangler whoami
```

## 4. 빈 저장소 만들기

D1은 로그인한 사람이 만든 재생목록을 보관하고, 검색 응답을 캐시하는 저장소입니다.

```text
npx wrangler d1 create playlist-player-db --update-config=false
```

출력의 **`database_id`** 옆에 나오는 하이픈이 있는 긴 값을 복사합니다. 기존에 같은 이름의 DB가 있다면 명령에서 다른 이름을 사용하고 다음 단계에서 `database_name`도 그 이름으로 맞춥니다. [Cloudflare D1 명령 설명](https://developers.cloudflare.com/d1/wrangler-commands/#d1-create)

1. 압축을 푼 폴더의 **`wrangler.jsonc`**를 메모장이나 텍스트 편집기로 엽니다.
2. **`00000000-0000-0000-0000-000000000000`** 부분만 방금 복사한 값으로 바꿉니다. 양쪽 따옴표와 `youtube_player_db`라는 이름은 그대로 둡니다.
3. 저장하고 터미널에서 아래 한 줄을 실행합니다. 끝나면 빈 저장소에 필요한 표가 생깁니다.

```text
npm run db:init
```

## 5. 내 주소로 열고 영상 재생하기

```text
npm run deploy
```

마지막에 나오는 `https://이름.계정이름.workers.dev` 주소를 복사해 브라우저에서 엽니다. 페이지에서 **추가 → URL**을 누르고, YouTube에서 복사한 **영상 하나의 링크**를 붙여 넣고 **재생**을 누릅니다. 임베드가 허용된 공개 영상으로 확인하세요. 기기에서 자동재생이 제한되면 화면 안의 YouTube 재생 버튼을 눌러 주세요. 같은 브라우저에서 만든 재생목록은 그 브라우저에 저장됩니다.

## 6. 선택 사항 — 제목으로 검색하기

1. Google Cloud 콘솔 상단의 **프로젝트 선택 → 새 프로젝트**에서 내 프로젝트를 만들고 선택합니다. [Google Cloud 콘솔](https://console.cloud.google.com/)
2. **API 및 서비스 → 라이브러리**에서 **YouTube Data API v3**를 검색하고 **사용**을 누릅니다. [YouTube Data API 페이지](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
3. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키**를 누릅니다. 키 편집 화면의 **API 제한사항 → 키 제한**에서 **YouTube Data API v3**를 선택해 저장합니다. 이 키는 Worker가 사용하므로 브라우저 웹사이트 제한은 적용하지 않습니다. [Google API 키 공식 안내](https://cloud.google.com/docs/authentication/api-keys)

터미널에서 아래 줄을 입력합니다. 값 입력을 요청할 때 **내 API 키**를 붙여 넣고 Enter를 누릅니다. 콘솔 밖으로 공유하지 마세요.

```text
npx wrangler secret put YOUTUBE_API_KEY
```

사이트를 새로고침하고 **추가 → 검색**에서 영상 제목을 검색합니다. 사이트 주소 끝에 `/api/config`를 붙여 열면 `"searchConfigured":true`로 키 연결 여부를 확인할 수 있습니다. 검색 횟수를 다 쓴 날에도 단일 영상 링크는 5단계 방식으로 재생할 수 있습니다. API 키가 없어도 링크 재생은 되지만 제목이나 채널 정보가 덜 표시될 수 있습니다.

## 7. 선택 사항 — Google 로그인과 동기화 켜기

기기마다 같은 재생목록을 보고 싶을 때만 진행하세요. 6단계와 같은 Google Cloud 프로젝트를 써도 됩니다.

1. Google Cloud의 **Google 인증 플랫폼 → 시작하기**를 엽니다. **브랜딩**에서 앱 이름과 내가 관리하는 지원 이메일을 입력합니다. **대상**에서 개인 계정으로 시험할 경우 **외부**를 선택합니다. 테스트 사용자 메뉴가 표시되면 로그인에 쓸 Google 계정을 추가합니다. [OAuth 동의 화면 설정](https://developers.google.com/workspace/guides/configure-oauth-consent)
2. **클라이언트 → 클라이언트 만들기 → 웹 애플리케이션**을 고릅니다. **승인된 리디렉션 URI**에 5단계 주소 뒤에 **`/api/auth/callback`**을 붙여 넣습니다. 예시 주소는 `https://playlist-player.myname.workers.dev/api/auth/callback`입니다. 예시의 주소를 복사해서 쓰는 대신 실제로 배포한 내 주소를 사용하세요. [Google 웹 OAuth 안내](https://developers.google.com/identity/protocols/oauth2/web-server)
3. 생성 화면의 **클라이언트 ID**와 **클라이언트 보안 비밀번호**를 아래 명령에 하나씩 입력합니다. 각 줄을 실행한 뒤 표시되는 입력 칸에 해당 값을 붙여 넣으세요.

```text
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

아래 명령은 **이 앱 전용 난수**를 내 컴퓨터에서 만듭니다. 출력된 긴 문자열을 복사해 두 번째 명령의 입력 칸에 붙여 넣습니다.

```text
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put SESSION_SECRET
```

사이트를 새로고침하고 **설정 → Google로 로그인**을 누릅니다. 로그인 후 목록을 하나 만든 뒤 다른 브라우저에서 같은 계정으로 로그인해 목록이 보이는지 확인합니다. `/api/config`의 `"authConfigured":true`는 비밀값이 등록됐다는 뜻입니다. 실제 로그인까지 눌러야 리디렉션 설정도 확인됩니다.

**관리자 메뉴가 필요한 경우**에는 `npx wrangler secret put ADMIN_EMAILS`를 실행하고 관리자 본인의 Google 이메일을 입력한 뒤 다시 로그인합니다. 기본 공개 모드에서 이용 코드는 필요하지 않습니다. 비밀값 입력 방법은 Cloudflare 공식 문서에서도 확인할 수 있습니다. [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 8. 돈이 들 수 있는 곳

| 어디에서 | 무료로 시작할 때 | 돈이 들거나 기능이 제한되는 경우 |
| --- | --- | --- |
| **Cloudflare Workers** | Worker 호출 하루 10만 건, 호출당 CPU 10ms. 이 ZIP은 HTML·JS·CSS 같은 파일을 정적 자산으로 제공하고 API와 `/watch`만 Worker를 거치게 설정했습니다. | Free 한도에 닿으면 Worker 요청이 오류를 낼 수 있습니다. Paid는 월 **US$5**부터이며, 월 1,000만 요청과 CPU 3,000만 ms 포함량을 넘기면 각각 100만 단위당 **US$0.30**, **US$0.02**가 추가됩니다. |
| **Cloudflare D1** | 계정 기준 읽기 하루 500만 행, 쓰기 하루 10만 행, 저장공간 합계 5GB. | 무료 한도에 닿으면 DB 작업이 실패할 수 있습니다. Paid에서도 포함량을 넘기면 읽기·쓰기·저장공간 요금이 붙습니다. |
| **YouTube Data API** | Google 프로젝트의 기본 `search.list` 한도는 하루 100회입니다. 영상과 채널 검색, 다음 페이지 호출이 함께 이 한도를 사용할 수 있습니다. | 한도가 차면 검색이 막힐 수 있습니다. 여러 사람이 같은 사이트를 써도 프로젝트의 한도를 함께 씁니다. 정확한 수치는 Google Cloud **YouTube Data API v3 → 할당량**에서 확인하세요. |
| **사이트 주소** | Cloudflare가 주는 `workers.dev` 주소를 씁니다. | 개인 도메인을 새로 사면 구입비와 갱신비가 생깁니다. |

한도와 요금의 출처입니다. [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/) · [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/) · [정적 자산 요금](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/) · [YouTube API 할당량](https://developers.google.com/youtube/data/determine_quota_cost)

**비용이 걱정되면 Workers Free를 유지하세요.** 주소를 공유한 뒤에는 Cloudflare의 **Workers & Pages → 내 Worker → Metrics**에서 요청 수를, **D1 → 내 DB → Metrics**에서 읽기·쓰기량을 확인합니다. 영상 재생은 이용자의 브라우저에서 공식 YouTube 플레이어가 처리하고 Worker는 영상 파일을 전송하지 않습니다. 검색, 재생목록 동기화, 피드백은 서버 요청을 사용합니다.

## 9. 링크를 다른 사람에게 보내기 전에

- 내 도메인으로 운영할 경우 Google 로그인 콜백도 그 주소로 맞춥니다. 많은 이용자에게 Google 로그인을 열 때는 **Google 인증 플랫폼 → 대상**에서 게시 상태와 Google이 요구하는 앱 검증을 확인합니다.
- ZIP의 `privacy.html`과 `terms.html`은 운영자용 초안입니다. 공개 전에 내 운영 연락처, 적용일, 실제 보관·삭제 방식으로 고칩니다. 로그인하면 Google 식별자·프로필과 동기화 상태가 D1에 저장됩니다. 피드백을 보내면 작성 내용이 저장되며, 선택한 경우에만 재생·기기 정보와 진단 로그가 함께 전송됩니다. 단일 링크 제목 조회에는 Noembed가 사용될 수 있습니다.
- 검색이나 로그인이 안 될 때는 먼저 `/api/config`를 봅니다. `searchConfigured` 또는 `authConfigured`가 `false`이면 해당 비밀값 등록을 확인합니다. `redirect_uri_mismatch`는 Google에 적은 주소의 **https, 도메인, /api/auth/callback, 마지막 슬래시**를 비교하세요.
- 일부 영상은 권리자 설정으로 외부 재생이 제한됩니다. 다른 공개 영상으로 먼저 확인하세요. 플레이어는 YouTube 공식 IFrame을 사용하며, 표시되는 광고는 YouTube가 결정합니다. [YouTube 임베드 도움말](https://support.google.com/youtube/answer/171780) · [YouTube API 개발자 정책](https://developers.google.com/youtube/terms/developer-policies)
