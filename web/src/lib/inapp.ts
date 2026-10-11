// 카카오톡·인스타그램 같은 앱 안의 브라우저에서는 마이크가 막혀 있는 경우가 많다.
// 그런 곳에서 열렸는지 알아내고, 가능하면 기본 브라우저로 다시 여는 방법을 준다.

export interface InApp {
  name: string;
  /** 기본 브라우저로 다시 열기 (방법이 없으면 null) */
  openExternal: (() => void) | null;
}

export function inAppBrowser(): InApp | null {
  const ua = navigator.userAgent || '';
  if (!/KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|Line\/|NAVER\(inapp|DaumApps|everytimeApp|; wv\)/i.test(ua)) return null;
  const name = /KAKAOTALK/i.test(ua) ? '카카오톡' : /Instagram/i.test(ua) ? '인스타그램' : /FBAN|FBAV|FB_IAB/i.test(ua) ? '페이스북' : /Line\//i.test(ua) ? '라인' : /NAVER\(inapp/i.test(ua) ? '네이버 앱' : '앱';
  const url = location.href;
  let openExternal: (() => void) | null = null;
  if (/Android/i.test(ua)) {
    openExternal = () => {
      location.href = `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=com.android.chrome;end`;
    };
  } else if (/KAKAOTALK/i.test(ua)) {
    openExternal = () => {
      location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
    };
  }
  return { name, openExternal };
}
