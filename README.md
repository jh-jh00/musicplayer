# Playlist Player 설치용 소스

- **직접 설치**는 [INSTALL-KO.md](INSTALL-KO.md)의 1단계부터 따라가세요.
- **AI에게 맡기기**는 원본 ZIP과 [AI-HANDOFF-KO.md](AI-HANDOFF-KO.md)를 함께 전달하세요.

한국어 재생목록 플레이어입니다. 단일 YouTube 링크 재생, 브라우저 내 재생목록, 대기열, 테마를 지원합니다. YouTube Data API 검색과 Google 로그인·기기 간 동기화는 설정 후 켜집니다. 음악 모드에서도 YouTube 영상이 표시됩니다.

`index.html`과 `js/`는 화면과 재생목록 기능, `worker.mjs`와 `functions/`는 Cloudflare API, `schema.sql`은 새 D1의 빈 테이블 정의입니다. `npm test`는 문법 검사, Worker 빌드 및 테스트를 로컬에서 실행합니다. `npm run deploy`는 검사를 통과한 소스를 새 Cloudflare Worker에 올립니다.

운영자 개인 정보나 기존 DB 데이터는 동봉하지 않았습니다. `privacy.html`, `terms.html`을 내 서비스 기준으로 작성하고 공개하세요.
