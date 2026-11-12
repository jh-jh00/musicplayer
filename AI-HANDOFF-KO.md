# AI 에이전트에게 전달하는 설치 요청

첨부한 `playlist-player-self-host.zip`을 압축 해제하고, 내 Cloudflare 계정에서 실행할 수 있도록 준비해 줘. 우선 **Cloudflare Workers Free**, **D1 Free**, 무료 **workers.dev** 주소로 단일 YouTube 링크 재생을 확인해 줘. 제목 검색과 Google 로그인은 내가 원할 때만 추가해 줘. 사용 방법과 비용 안내는 ZIP 안의 `INSTALL-KO.md`를 기준으로 삼아 줘.

1. ZIP의 소스를 먼저 읽고 Node.js LTS가 있는지 확인한 뒤 `npm ci`와 `npm test`를 실행해 줘. 문제가 있으면 원인을 고치고 다시 검사해 줘.
2. `npx wrangler whoami`로 내 계정을 확인해 줘. 로그인이 필요하면 내가 브라우저에서 직접 로그인할 수 있게 안내해 줘. 대상 계정과 Worker 이름을 확인하고 같은 이름의 기존 서비스가 있으면 새 이름을 골라 줘.
3. 내가 지정한 계정에 새 D1을 만들고 `wrangler.jsonc`에 그 DB의 이름과 ID를 채워 줘. 바인딩은 `youtube_player_db`로 유지해 줘. `npm run db:init`을 실행해 줘.
4. 내 계정에 새 Worker를 올려 달라는 요청이 확인되면 `npm run deploy`를 실행하고 결과에 나온 새 주소를 알려 줘. 기존 서비스의 데이터나 설정은 사용하지 말아 줘. 플랜 변경, 결제, 도메인 구매가 필요한 화면이 나오면 진행을 멈추고 알려 줘.
5. 새 주소의 홈과 `/api/config`가 열리는지, 임베드가 허용된 YouTube 단일 영상 링크가 재생되는지 확인해 줘. 검색을 요청했으면 제목 검색까지, Google 로그인을 요청했으면 실제 로그인과 재생목록 동기화까지 확인해 줘. 브라우저 접근이나 로그인이 필요한 검사는 내가 눌러야 할 버튼과 기대하는 결과를 알려 줘.
6. Google 인증이나 키 등록 단계에서는 비밀번호, API 키, 클라이언트 보안 비밀번호, 세션 비밀값을 채팅·소스·Notion에 남기지 말아 줘. 내가 입력할 Cloudflare Secret 이름과 방법을 알려 줘. 검색은 `YOUTUBE_API_KEY`, 로그인은 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`을 사용해. Google 콜백은 내 실제 배포 주소 뒤에 `/api/auth/callback`을 붙인 값이야.
7. 서비스 공개 전에는 내 운영 연락처와 실제 처리 방식으로 `privacy.html`과 `terms.html`을 마무리할 수 있게 안내해 줘. 영상은 YouTube 공식 IFrame으로 재생하고 광고·임베드 제한은 YouTube 설정을 따라 줘.
8. 작업이 끝나면 사이트 주소, 실제로 통과한 검사, 내가 이어서 할 일, 사용 중인 플랜과 확인한 한도를 한국어로 짧게 정리해 줘.
