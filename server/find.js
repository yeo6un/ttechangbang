// 곡·가사·유튜브 영상 찾기. 공개 서비스를 서버가 대신 불러 준다.
//  - 가사와 곡 목록: LRCLIB (공개 가사 데이터베이스. 줄별 시간표가 들어 있는 곡이 많다)
//  - 유튜브 영상 찾기: YOUTUBE_API_KEY 가 있을 때만, 공식 YouTube Data API 로
//  - 영상 제목 확인: YouTube oEmbed
// 음원은 내려받지 않는다. 영상은 유튜브 플레이어로 그대로 재생한다.
// (Apple 의 곡 검색은 Cloudflare 서버에서 부르면 막혀서, 화면 쪽에서 직접 부른다 — web/src/lib/find.ts)
// env.fetch 가 있으면 그것을 쓴다 (테스트에서 가짜 응답을 넣기 위한 자리).

const UA = 'ttechangbang/0.2 (https://github.com/yeo6un/ttechangbang)';
const LRCLIB = 'https://lrclib.net/api';
const YT_API = 'https://www.googleapis.com/youtube/v3';

const enc = encodeURIComponent;

async function getJson(env, url, timeoutMs = 7000) {
  const f = env.fetch || fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: await res.json() };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────── 이름 비교 ─────────────

/** 비교용으로 다듬기: 괄호 안 설명·feat 표기·기호·띄어쓰기를 뺀다 */
export function norm(s) {
  const base = String(s || '').normalize('NFKC').toLowerCase();
  const stripped = base
    .replace(/\([^()]*\)|\[[^\[\]]*\]/g, ' ')
    .replace(/\s[-–]\s.*$/, ' ')
    .replace(/\b(feat|ft|prod|with)\b\.?\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return stripped || base.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 제목 뒤에 붙는 설명을 떼어 낸 검색용 제목 */
export function stripTitle(s) {
  const t = String(s || '')
    .replace(/\s*[(\[][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\s[-–]\s.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || String(s || '').trim();
}

/** 2 = 같음, 1 = 한쪽이 다른 쪽을 품음, 0 = 다름 */
export function sameText(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 2;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short) ? 1 : 0;
}

/** 가수 이름은 "A, B" "A & B" 처럼 여럿일 수 있어서 조각끼리도 비교한다 */
export function sameArtist(a, b) {
  const whole = sameText(a, b);
  if (whole) return whole;
  const parts = (s) => String(s || '').split(/\s*(?:,|&|×|\/|;|\band\b|\bfeat\.?|\bwith\b)\s*/i).filter((p) => norm(p).length >= 2);
  for (const p of parts(a)) for (const q of parts(b)) if (sameText(p, q)) return 1;
  return 0;
}

// ───────────── 유튜브 주소 ─────────────

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYtId(input) {
  const s = String(input || '').trim();
  if (YT_ID.test(s)) return s;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return '';
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.split('/')[1] || '';
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
      id = m ? m[1] : '';
    }
  }
  return YT_ID.test(id) ? id : '';
}

// ───────────── 곡 목록 ─────────────

const lrc = (r) => ({
  id: Number(r?.id) || 0,
  title: String(r?.trackName || r?.name || ''),
  artist: String(r?.artistName || ''),
  album: String(r?.albumName || ''),
  dur: Number(r?.duration) || 0,
  instrumental: !!r?.instrumental,
  plain: typeof r?.plainLyrics === 'string' ? r.plainLyrics : '',
  synced: typeof r?.syncedLyrics === 'string' ? r.syncedLyrics : '',
});

/** 한글 가사인지. 같은 곡이 한글판과 로마자 표기판으로 함께 올라와 있으면 한글판을 고르려는 것이다. */
const hasHangul = (x) => /[가-힣]/.test(x.synced || x.plain);
/** 같은 곡의 가사 여러 벌 가운데 어느 쪽이 더 쓸 만한지: 시간표가 있는 쪽, 그다음 한글로 적힌 쪽 */
const lyricRank = (x) => (x.synced ? 2 : 0) + (hasHangul(x) ? 1 : 0);

async function lrclibSongs(env, q) {
  const r = await getJson(env, `${LRCLIB}/search?q=${enc(q)}`);
  const groups = new Map();
  for (const raw of Array.isArray(r.data) ? r.data : []) {
    const x = lrc(raw);
    if (!x.id || !x.title || x.instrumental || (!x.plain && !x.synced)) continue;
    const key = `${norm(x.title)}|${norm(x.artist)}`;
    const cur = groups.get(key);
    if (!cur || lyricRank(x) > lyricRank(cur)) groups.set(key, x);
  }
  const songs = [...groups.values()].slice(0, 12).map((x) => ({
    id: 'lr' + x.id,
    lrclibId: x.id,
    title: x.title.slice(0, 120),
    artist: x.artist.slice(0, 80),
    album: x.album.slice(0, 120),
    dur: Math.round(x.dur),
    art: '',
    lyrics: x.synced ? 'synced' : 'plain',
  }));
  return { status: r.status, songs };
}

/**
 * 곡 목록 찾기. 한글로 적은 검색어는 가사 데이터베이스의 영어 표기와 안 맞는 일이 많아서,
 * 결과가 없고 AI 가 연결돼 있으면 공식 표기로 바꾼 검색어로 한 번 더 찾는다.
 */
export async function findSongs(env, q, { rewrite } = {}) {
  const first = await lrclibSongs(env, q);
  if (first.songs.length) return { songs: first.songs, via: 'lrclib' };
  if (rewrite) {
    let alts = [];
    try {
      alts = await rewrite(q);
    } catch {
      alts = [];
    }
    for (const alt of alts.slice(0, 3)) {
      if (norm(alt) === norm(q)) continue;
      const r = await lrclibSongs(env, alt);
      if (r.songs.length) return { songs: r.songs, via: 'lrclib', rewritten: alt };
    }
  }
  return { songs: [], via: 'none', down: first.status !== 200 };
}

// ───────────── 가사 ─────────────

function scoreLyrics(x, names, dur) {
  if (x.instrumental || (!x.plain && !x.synced)) return -100;
  let title = 0;
  let artist = 0;
  for (const n of names) {
    title = Math.max(title, sameText(x.title, n.title));
    artist = Math.max(artist, sameArtist(x.artist, n.artist));
  }
  const gap = dur > 0 && x.dur > 0 ? Math.abs(x.dur - dur) : NaN;
  // 제목이 맞아야 하고, 가수가 맞거나 길이가 거의 같아야 같은 곡으로 본다
  if (!title) return -100;
  if (!artist && !(gap <= 3)) return -100;
  let s = title * 2 + artist * 2;
  if (x.synced) s += 3;
  if (hasHangul(x)) s += 3;
  if (gap <= 2) s += 4;
  else if (gap <= 5) s += 2;
  else if (gap > 20) s -= 3;
  return s;
}

export async function findLyrics(env, want) {
  const pool = new Map();
  const add = (list) => {
    for (const raw of Array.isArray(list) ? list : []) {
      const x = lrc(raw);
      if (x.id && !pool.has(x.id)) pool.set(x.id, x);
    }
  };
  const result = (x) => ({
    found: true,
    id: x.id,
    title: x.title,
    artist: x.artist,
    dur: Math.round(x.dur),
    synced: x.synced.slice(0, 40000),
    plain: x.plain.slice(0, 40000),
    source: 'LRCLIB',
  });

  if (want.lrclibId) {
    const r = await getJson(env, `${LRCLIB}/get/${enc(want.lrclibId)}`);
    const x = r.data ? lrc(r.data) : null;
    if (x && (x.plain || x.synced)) return result(x);
  }
  // 같은 곡의 여러 표기(한글 이름, 영어 이름)를 차례로 찾아본다
  const names = [];
  for (const n of want.names || []) {
    if (!n?.title) continue;
    if (!names.some((m) => norm(m.title) === norm(n.title) && norm(m.artist) === norm(n.artist))) names.push({ title: n.title, artist: n.artist || '' });
  }
  if (!names.length) return { found: false };

  const best = () => {
    let top = null;
    let topScore = 0;
    for (const x of pool.values()) {
      const s = scoreLyrics(x, names, want.dur || 0);
      if (s > topScore) {
        top = x;
        topScore = s;
      }
    }
    return top;
  };
  let reached = false;
  for (const { title, artist } of names.slice(0, 3)) {
    const short = stripTitle(title);
    const queries = new Set();
    if (artist) queries.add(`track_name=${enc(short)}&artist_name=${enc(artist)}`);
    queries.add(`track_name=${enc(short)}`);
    if (artist) queries.add(`q=${enc(`${short} ${artist}`)}`);
    const res = await Promise.all([...queries].map((q) => getJson(env, `${LRCLIB}/search?${q}`)));
    for (const r of res) {
      add(r.data);
      if (r.status === 200) reached = true;
    }
    const top = best();
    if (top?.synced) return result(top);
  }
  const top = best();
  return top ? result(top) : { found: false, down: !reached };
}

// ───────────── 유튜브 영상 ─────────────

export async function ytInfo(env, id) {
  if (!YT_ID.test(id)) return { ok: false, reason: 'bad' };
  const r = await getJson(env, `https://www.youtube.com/oembed?url=${enc(`https://www.youtube.com/watch?v=${id}`)}&format=json`, 5000);
  const thumb = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  if (r.data) return { ok: true, id, title: String(r.data.title || '').slice(0, 120), author: String(r.data.author_name || '').slice(0, 80), thumb };
  if (r.status === 401 || r.status === 403) return { ok: false, id, reason: 'blocked' };
  if (r.status === 404 || r.status === 400) return { ok: false, id, reason: 'missing' };
  // 확인 서버가 답하지 않으면 일단 통과시키고, 실제 재생에서 가린다
  return { ok: true, id, title: '', author: '', thumb, unverified: true };
}

const isoSeconds = (iso) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
};

const OFF_VERSION = /\b(live|cover|remix|karaoke|instrumental|inst\.?|reaction|sped\s*up|slowed|nightcore|8d|1\s*hour|dance\s*practice|fancam|teaser|mr)\b|라이브|커버|직캠|노래방|1시간|리믹스|반응|교차편집|안무/i;

async function ytApiSearch(env, want) {
  const key = env.YOUTUBE_API_KEY;
  const q = `${want.artist || ''} ${want.title || ''}`.trim();
  const s = await getJson(env, `${YT_API}/search?part=snippet&type=video&videoEmbeddable=true&videoSyndicated=true&maxResults=8&q=${enc(q)}&key=${enc(key)}`);
  const items = (s.data?.items || []).filter((i) => YT_ID.test(i?.id?.videoId || ''));
  if (!items.length) return [];
  const d = await getJson(env, `${YT_API}/videos?part=contentDetails&id=${items.map((i) => i.id.videoId).join(',')}&key=${enc(key)}`);
  const lens = new Map((d.data?.items || []).map((v) => [v.id, isoSeconds(v.contentDetails?.duration)]));
  const decode = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  return items
    .map((i, rank) => {
      const title = decode(i.snippet?.title);
      const author = decode(i.snippet?.channelTitle);
      const len = lens.get(i.id.videoId) || 0;
      let score = -rank * 0.3;
      if (want.dur > 0 && len > 0) {
        const gap = Math.abs(len - want.dur);
        score += gap <= 2 ? 6 : gap <= 6 ? 3 : gap > 40 ? -3 : 0;
      }
      if (/ - topic$/i.test(author)) score += 2;
      if (/official\s*(audio|video|mv|music video)|\bm\/v\b|\bmv\b/i.test(title)) score += 1;
      // 찾는 곡 제목에 없는 "라이브·커버" 같은 말이 붙은 영상은 뒤로 미룬다
      if (OFF_VERSION.test(title) && !OFF_VERSION.test(want.title || '')) score -= 5;
      return { id: i.id.videoId, title: title.slice(0, 120), author: author.slice(0, 80), len, thumb: `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...v }) => v);
}

/** 가수·곡 이름으로 유튜브 영상을 찾는다. YouTube Data API 열쇠가 있을 때만 된다. */
export async function findVideo(env, want) {
  if (!env.YOUTUBE_API_KEY) return { found: false, reason: 'no_key' };
  const list = await ytApiSearch(env, want);
  if (!list.length) return { found: false, reason: 'empty' };
  return { found: true, ...list[0], alts: list.slice(1, 5), via: 'youtube' };
}
