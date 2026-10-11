// 가짜 검색 서버: 바깥 서비스(iTunes, LRCLIB, Odesli, YouTube) 대신 정해 둔 응답을 돌려준다. 테스트 전용.
// 노래는 앱에 들어 있는 연습용 비트(가사도 이 앱을 위해 새로 지은 것)를 "발매된 곡"처럼 꾸민 것이다.
//  - 한글 이름으로는 가사가 안 나오고 영어 이름으로만 나온다 → 다른 표기로 다시 찾는 길을 확인
//  - 검색어에 itunesdown 이 들어가면 곡 검색 서버가 죽은 것처럼 군다 → 가사 서버 목록으로 대신하는 길을 확인
const BAR = (4 * 60) / 92;
export const DEMO_TEXTS = ['하나 둘 셋 시작해', '목소리를 겹쳐 봐', '틀려도 그냥 웃어', '박자는 대충 가도', '여기는 내가 할게', '다음은 네가 받아', '다 같이 크게 질러 봐', '떼창방에서 만나'];
export const DEMO_VIDEO = 'ttbDEMO0001';
export const DEMO_MV = 'ttbMV000001';
export const BLOCKED_VIDEO = 'blockedAAAA';

const stamp = (t) => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}]`;
const SYNCED = DEMO_TEXTS.map((text, i) => `${stamp((1 + i) * BAR)} ${text}`).join('\n');
const PLAIN = DEMO_TEXTS.join('\n');

const SONGS = [
  { trackId: 1001, ko: ['연습용 노래', '떼창방 밴드'], en: ['Practice Song', 'Ttechang Band'], album: '떼창방 1집', ms: 24080 },
  { trackId: 1002, ko: ['가사 없는 노래', '떼창방 밴드'], en: ['Song Without Words', 'Ttechang Band'], album: '떼창방 1집', ms: 200000 },
  { trackId: 1003, ko: ['타이밍 없는 노래', '떼창방 밴드'], en: ['Untimed Song', 'Ttechang Band'], album: '떼창방 2집', ms: 24080 },
];
const itunesRow = (s, lang) => ({
  wrapperType: 'track',
  kind: 'song',
  trackId: s.trackId,
  trackName: s[lang][0],
  artistName: s[lang][1],
  collectionName: s.album,
  trackTimeMillis: s.ms,
  artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/test/${s.trackId}/100x100bb.jpg`,
});
const LRC = [
  { id: 501, trackName: 'Practice Song', artistName: 'Ttechang Band', albumName: 'Ttechang Vol.1', duration: 24.0, instrumental: false, plainLyrics: PLAIN, syncedLyrics: SYNCED },
  { id: 502, trackName: 'Practice Song', artistName: 'Ttechang Band', albumName: 'Ttechang Live', duration: 61.0, instrumental: false, plainLyrics: PLAIN, syncedLyrics: null },
  { id: 503, trackName: 'Untimed Song', artistName: 'Ttechang Band', albumName: 'Ttechang Vol.2', duration: 24.0, instrumental: false, plainLyrics: PLAIN, syncedLyrics: null },
  // 제목만 같은 남의 노래: 골라지면 안 된다
  { id: 504, trackName: 'Practice Song', artistName: 'Somebody Else', albumName: 'Other', duration: 199.0, instrumental: false, plainLyrics: 'la la la', syncedLyrics: '[00:01.00] la la la' },
];

export const calls = [];
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const has = (text, word) => String(text || '').toLowerCase().includes(word.toLowerCase());

export default async function mockFetch(input) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const p = url.searchParams;
  calls.push(url.host + url.pathname + url.search);

  if (url.host === 'itunes.apple.com') {
    if (url.pathname === '/search') {
      const term = p.get('term') || '';
      if (has(term, 'itunesdown')) return json({}, 503);
      const hits = SONGS.filter((s) => [...s.ko, ...s.en].some((n) => has(term, n) || has(n, term)) || (has(term, '떼창방') || has(term, '연습')) && s.trackId !== 1002);
      return json({ resultCount: hits.length, results: hits.map((s) => itunesRow(s, 'ko')) });
    }
    if (url.pathname === '/lookup') {
      const s = SONGS.find((x) => String(x.trackId) === p.get('id'));
      const lang = p.get('lang') === 'en_us' || p.get('country') === 'US' ? 'en' : 'ko';
      return json({ resultCount: s ? 1 : 0, results: s ? [itunesRow(s, lang)] : [] });
    }
  }

  if (url.host === 'lrclib.net') {
    const m = /^\/api\/get\/(\d+)$/.exec(url.pathname);
    if (m) {
      const r = LRC.find((x) => String(x.id) === m[1]);
      return r ? json(r) : json({ code: 404, name: 'TrackNotFound' }, 404);
    }
    if (url.pathname === '/api/search') {
      const q = p.get('q');
      const track = p.get('track_name');
      const artist = p.get('artist_name');
      const hits = LRC.filter((r) => {
        if (q) return q.toLowerCase().replace('itunesdown', '').trim().split(/\s+/).every((w) => has(r.trackName + ' ' + r.artistName, w));
        return (!track || has(r.trackName, track)) && (!artist || has(r.artistName, artist));
      });
      return json(hits);
    }
  }

  if (url.host === 'api.song.link') {
    const id = p.get('id');
    if (id === '1001' || id === '1003') {
      return json({
        entityUniqueId: `ITUNES_SONG::${id}`,
        linksByPlatform: {
          youtube: { country: 'KR', url: `https://www.youtube.com/watch?v=${DEMO_VIDEO}`, entityUniqueId: `YOUTUBE_VIDEO::${DEMO_VIDEO}` },
          youtubeMusic: { country: 'KR', url: `https://music.youtube.com/watch?v=${DEMO_VIDEO}`, entityUniqueId: `YOUTUBE_VIDEO::${DEMO_VIDEO}` },
        },
      });
    }
    return json({ statusCode: 404, code: 'could_not_resolve_entity' }, 404);
  }

  if (url.host === 'www.youtube.com' && url.pathname === '/oembed') {
    const id = new URL(p.get('url')).searchParams.get('v');
    if (id === DEMO_VIDEO) return json({ title: '떼창방 밴드 - 연습용 노래 (Official Audio)', author_name: '떼창방 밴드 - Topic', thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    if (id === DEMO_MV) return json({ title: '떼창방 밴드 - 연습용 노래 M/V', author_name: '떼창방 밴드', thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    if (id === BLOCKED_VIDEO) return new Response('Unauthorized', { status: 401 });
    return new Response('Not Found', { status: 404 });
  }

  if (url.host === 'www.googleapis.com') {
    if (url.pathname.endsWith('/search')) {
      return json({
        items: [
          { id: { videoId: 'liveLIVE001' }, snippet: { title: '떼창방 밴드 - 연습용 노래 (Live)', channelTitle: '떼창방 밴드' } },
          { id: { videoId: DEMO_MV }, snippet: { title: '떼창방 밴드 - 연습용 노래 M/V', channelTitle: '떼창방 밴드' } },
          { id: { videoId: DEMO_VIDEO }, snippet: { title: '연습용 노래', channelTitle: '떼창방 밴드 - Topic' } },
        ],
      });
    }
    if (url.pathname.endsWith('/videos')) {
      const lens = { liveLIVE001: 'PT24S', [DEMO_MV]: 'PT29S', [DEMO_VIDEO]: 'PT24S' };
      return json({ items: (p.get('id') || '').split(',').map((id) => ({ id, contentDetails: { duration: lens[id] || 'PT0S' } })) });
    }
  }

  return new Response('not mocked: ' + url.href, { status: 404 });
}
