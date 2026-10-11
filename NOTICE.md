# 쓰인 오픈소스

| 이름 | 쓰임 | 라이선스 |
|---|---|---|
| [React](https://react.dev) | 화면 | MIT |
| [Vite](https://vite.dev) | 빌드 도구 (개발용) | MIT |
| [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders) | 브라우저에서 MP3 만들기. `web/public/vendor/mp3.wasm` 은 이 패키지에 들어 있는 파일을 그대로 복사한 것입니다. | MIT (안에 든 LAME 인코더는 LGPL) |
| [Black Han Sans](https://fonts.google.com/specimen/Black+Han+Sans) (`@fontsource/black-han-sans`) | 제목 글꼴 | SIL Open Font License 1.1 |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) | Cloudflare 배포 도구 (개발용) | MIT / Apache-2.0 |
| [Vitest](https://vitest.dev), [Playwright](https://playwright.dev) | 테스트 (개발용) | MIT / Apache-2.0 |

연습용 비트와 그 가사는 이 앱을 위해 코드로 새로 만든 것입니다 (`web/src/lib/audio/demo.ts`).

# 바깥 서비스

앱이 돌아가는 동안 아래 서비스를 부릅니다. 각 서비스의 이용 약관을 따릅니다.

| 이름 | 쓰임 | 비고 |
|---|---|---|
| [LRCLIB](https://lrclib.net) | 가사와 줄별 시간표 찾기 (서버가 대신 부릅니다) | 누구나 쓸 수 있게 열어 둔 가사 모음. 열쇠가 필요 없습니다. |
| [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) | 유튜브 영상을 방 안에서 그대로 재생 (따라 부르는 원곡 가이드, 또는 MR 파일이 없을 때의 반주) | 영상·음원을 내려받거나 저장하지 않습니다. 플레이어 위에 다른 것을 덮지 않습니다. |
| YouTube oEmbed | 붙여 넣은 링크의 영상 제목 확인 (서버) | |
| [YouTube Data API v3](https://developers.google.com/youtube/v3) | 가수·곡 이름으로 영상 자동 찾기 (선택, 서버) | `YOUTUBE_API_KEY`를 넣었을 때만 씁니다. |
| [iTunes Search API](https://performance-partners.apple.com/search-api) | 가수·곡 이름으로 곡 목록 찾기 (브라우저가 직접 부릅니다) | 곡 이름·가수·길이만 쓰고, 앨범 그림이나 미리듣기 음원은 쓰지 않습니다. 막혀 있으면 LRCLIB 검색으로 대신합니다. |
| Cloudflare Workers AI | 검색어 다듬기, 파트 추천, 가사 자동 싱크 (선택) | |

