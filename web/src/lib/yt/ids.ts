// 유튜브 주소 다루기
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** 붙여 넣은 글에서 영상 번호를 뽑는다. 주소 앞뒤에 다른 글이 섞여 있어도 된다. */
export function parseYtId(input: string): string {
  const raw = String(input || '').trim();
  if (YT_ID.test(raw)) return raw;
  // 공유 글처럼 주소가 문장 속에 들어 있는 경우
  const candidates = raw.match(/(?:https?:\/\/)?(?:[a-z]+\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/[^\s"'<>]+/gi) || [raw];
  for (const c of candidates) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(c) ? c : 'https://' + c);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = '';
    if (host === 'youtu.be') id = u.pathname.split('/')[1] || '';
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else id = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1] || '';
    }
    if (YT_ID.test(id)) return id;
  }
  return '';
}

export const ytWatchUrl = (id: string, at = 0) => `https://www.youtube.com/watch?v=${id}${at >= 1 ? `&t=${Math.floor(at)}s` : ''}`;

/** 유튜브에서 직접 찾아볼 때 여는 검색 주소 */
export const ytSearchUrl = (query: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

export const ytThumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
