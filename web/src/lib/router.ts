// 아주 작은 주소 처리기 (History API)
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'room'; code: string }
  | { name: 'rec'; code: string }
  | { name: 'mix'; code: string }
  | { name: 'edit'; code: string }
  | { name: 'missing' };

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  if (p === '/new') return { name: 'new' };
  const m = /^\/r\/(\d{6})(?:\/(rec|mix|edit))?$/.exec(p);
  if (m) return { name: (m[2] as 'rec' | 'mix' | 'edit') || 'room', code: m[1] };
  return { name: 'missing' };
}

const listeners = new Set<() => void>();

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (path === location.pathname) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

export function goBack(fallback: string): void {
  if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
  else navigate(fallback, { replace: true });
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.pathname));
    listeners.add(on);
    window.addEventListener('popstate', on);
    return () => {
      listeners.delete(on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return route;
}

export const roomLink = (code: string) => `${location.origin}/r/${code}`;
export const fmtCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
