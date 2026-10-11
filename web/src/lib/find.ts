// 곡 찾기: 가수·곡 이름으로 곡 목록을 찾고, 고른 곡의 가사와 (가능하면) 유튜브 영상을 찾아온다.
//  - 곡 목록은 Apple 의 공개 곡 검색을 브라우저에서 직접 부른다 (한글로 적은 가수·곡 이름을 잘 알아듣는다).
//    서버에서 부르면 Apple 이 막기 때문에 화면 쪽에서 부른다. 곡 이름·가수·길이만 쓰고 그림이나 미리듣기는 쓰지 않는다.
//  - 그게 안 되면 서버의 가사 데이터베이스 검색으로 대신한다.
import { api, type FoundLyrics, type FoundSong, type FoundVideo } from './api';

interface ItunesRow {
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
}

/** 다른 사이트의 응답을 스크립트로 받아 오는 오래된 방법(JSONP). Apple 의 곡 검색이 공식으로 지원한다. */
function jsonp<T>(url: string, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const name = `__ttbJsonp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const w = window as unknown as Record<string, unknown>;
    const script = document.createElement('script');
    const clean = () => {
      window.clearTimeout(timer);
      // 늦게 도착한 응답이 오류를 내지 않게 빈 함수로 남겨 둔다
      w[name] = () => {
        delete w[name];
      };
      script.remove();
    };
    const timer = window.setTimeout(() => {
      clean();
      reject(new Error('timeout'));
    }, timeoutMs);
    w[name] = (data: T) => {
      clean();
      delete w[name];
      resolve(data);
    };
    script.onerror = () => {
      clean();
      reject(new Error('network'));
    };
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${name}`;
    script.async = true;
    document.head.appendChild(script);
  });
}

/** 비교용으로 다듬기: 괄호 안 설명·기호·띄어쓰기를 뺀다 */
export function normName(s: string): string {
  const base = String(s || '').normalize('NFKC').toLowerCase();
  const stripped = base
    .replace(/\([^()]*\)|\[[^\[\]]*\]/g, ' ')
    .replace(/\s[-–]\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return stripped || base.replace(/[^\p{L}\p{N}]+/gu, '');
}

const sameName = (a: string, b: string) => {
  const x = normName(a);
  const y = normName(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))));
};

export function fromItunes(rows: ItunesRow[] | undefined): FoundSong[] {
  const out: FoundSong[] = [];
  const seen = new Set<string>();
  for (const x of rows || []) {
    if (x?.kind !== 'song' || !x.trackId || !x.trackName || !x.artistName) continue;
    const dur = Math.round((Number(x.trackTimeMillis) || 0) / 1000);
    // 같은 곡이 싱글·앨범·모음집으로 여러 번 나온다
    const key = `${normName(x.trackName)}|${normName(x.artistName)}|${Math.round(dur / 4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: 'it' + x.trackId,
      itunesId: x.trackId,
      title: x.trackName.slice(0, 120),
      artist: x.artistName.slice(0, 80),
      album: (x.collectionName || '').slice(0, 120),
      dur,
      art: '',
    });
  }
  return out;
}

async function itunesSearch(q: string): Promise<FoundSong[]> {
  const data = await jsonp<{ results?: ItunesRow[] }>(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=KR&media=music&entity=song&limit=14`);
  return fromItunes(data.results);
}

/** 같은 곡의 영어 표기 (가사 데이터베이스에는 영어 이름으로 올라온 곡이 많다) */
async function itunesEnglish(itunesId: number): Promise<{ title: string; artist: string } | null> {
  try {
    const data = await jsonp<{ results?: ItunesRow[] }>(`https://itunes.apple.com/lookup?id=${itunesId}&country=KR&lang=en_us`, 5000);
    const x = (data.results || []).find((r) => r.trackName && r.artistName);
    return x ? { title: x.trackName!, artist: x.artistName! } : null;
  } catch {
    return null;
  }
}

export interface SongSearch {
  songs: FoundSong[];
  /** 검색 서버들이 모두 답하지 않았다 */
  down: boolean;
  /** AI 가 검색어를 공식 표기로 바꿔서 찾았을 때, 그 표기 */
  rewritten?: string;
}

export async function searchSongs(q: string, aiAvailable: boolean): Promise<SongSearch> {
  const [it, lr] = await Promise.allSettled([itunesSearch(q), api.findSongs(q)]);
  const fromApple = it.status === 'fulfilled' ? it.value : [];
  const fromLyrics = lr.status === 'fulfilled' ? lr.value.songs : [];
  if (fromApple.length) {
    // 같은 검색어로 가사 쪽에서도 찾힌 곡은 그 가사를 바로 쓸 수 있게 이어 둔다
    for (const s of fromApple) {
      const hit = fromLyrics.find((l) => sameName(l.title, s.title) && (sameName(l.artist, s.artist) || Math.abs(l.dur - s.dur) <= 3));
      if (hit) {
        s.lyrics = hit.lyrics;
        // 길이가 거의 같을 때만 그 가사로 못 박는다 (길이가 다르면 다른 판일 수 있어서, 고른 뒤에 다시 찾는다)
        if (Math.abs(hit.dur - s.dur) <= 3) s.lrclibId = hit.lrclibId;
      }
    }
    // Apple 목록에 없는 곡은 뒤에 붙인다
    const extra = fromLyrics.filter((l) => !fromApple.some((s) => sameName(l.title, s.title) && (sameName(l.artist, s.artist) || Math.abs(l.dur - s.dur) <= 3)));
    return { songs: [...fromApple.slice(0, 10), ...extra.slice(0, 4)], down: false };
  }
  if (fromLyrics.length) return { songs: fromLyrics, down: false };
  // 둘 다 없으면: AI 가 검색어를 공식 표기로 바꿔서 한 번 더 (한글로 적은 외국어 제목 등)
  if (aiAvailable) {
    try {
      const again = await api.findSongs(q, true);
      if (again.songs.length) return { songs: again.songs, down: false, rewritten: again.rewritten };
    } catch {
      /* 아래에서 결과 없음으로 처리 */
    }
  }
  return { songs: [], down: it.status === 'rejected' && (lr.status === 'rejected' || !!lr.value.down) };
}

export async function loadLyrics(song: FoundSong): Promise<FoundLyrics> {
  if (song.lrclibId) return api.findLyrics({ lrclibId: song.lrclibId });
  const names = [{ title: song.title, artist: song.artist }];
  if (song.itunesId) {
    const en = await itunesEnglish(song.itunesId);
    if (en && (normName(en.title) !== normName(song.title) || normName(en.artist) !== normName(song.artist))) names.push(en);
  }
  return api.findLyrics({ names, dur: song.dur });
}

export async function loadVideo(song: FoundSong): Promise<{ video: FoundVideo; alts: FoundVideo[] } | null> {
  const r = await api.findVideo({ title: song.title, artist: song.artist, dur: song.dur });
  if (!r.found) return null;
  return { video: { id: r.id, title: r.title, author: r.author, thumb: r.thumb, len: r.len }, alts: r.alts || [] };
}

/** 유튜브에서 직접 찾아볼 때 쓰는 검색어. 뮤직비디오보다 음원 영상이 가사 타이밍과 잘 맞는다. */
export const ytQueryFor = (song: { title: string; artist: string }) => `${song.artist} ${song.title} audio`.trim();

/** 영상 제목에서 곡 이름만 어림해 뽑는다 (링크로 시작했을 때 가사를 찾아보려고) */
export function guessFromVideoTitle(title: string, author: string): string {
  const t = title
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ')
    .replace(/\b(official|music|video|audio|lyrics?|mv|m\/v|hd|4k|performance|ver\.?|version)\b/gi, ' ')
    .replace(/가사|뮤직비디오|공식|음원|자막/g, ' ')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const topic = / - topic$/i.test(author);
  const a = author.replace(/\s*-\s*topic$/i, '').replace(/\b(official|vevo)\b/gi, '').trim();
  if (!t) return a;
  // 음원 영상("가수 - Topic" 채널)은 제목에 곡 이름만 있어서 가수 이름을 붙여 준다
  return topic && a && !normName(t).includes(normName(a)) ? `${a} ${t}` : t;
}
