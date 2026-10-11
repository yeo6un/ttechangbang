// 여러 화면이 함께 쓰는 작은 부품들
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { inAppBrowser } from './lib/inapp';
import { seatColor } from './lib/parts';

// ───────────── 아이콘 (24px, 선 굵기 2) ─────────────
const paths: Record<string, ReactNode> = {
  back: <path d="M15 5l-7 7 7 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6.5A2.5 2.5 0 017.5 4H15" />
    </>
  ),
  share: <path d="M12 15V4m0 0L8 8m4-4l4 4M5 13v5a2 2 0 002 2h10a2 2 0 002-2v-5" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  headphones: (
    <>
      <path d="M4 14v-2a8 8 0 0116 0v2" />
      <rect x="3" y="13" width="5" height="7" rx="2" />
      <rect x="16" y="13" width="5" height="7" rx="2" />
    </>
  ),
  speaker: <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" />,
  trash: <path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 018 0v2.5" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  redo: <path d="M5 12a7 7 0 1 0 2.2-5.1M5 4.5v4h4" />,
  music: (
    <>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </>
  ),
  download: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />,
  spark: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0113 0M16 5.3a3.5 3.5 0 010 6.4M18 14.2a6.5 6.5 0 013.5 5.8" />
    </>
  ),
  tap: <path d="M9 11V5.5a1.75 1.75 0 013.5 0V11m0-1.5a1.75 1.75 0 013.5 0V12m0-.8a1.75 1.75 0 013.5 0V15a6 6 0 01-6 6h-1.6a6 6 0 01-4.7-2.3L4 14.5a1.7 1.7 0 012.6-2.2L9 14.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="3.5" />
      <path d="M10.2 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none" />
    </>
  ),
  paste: (
    <>
      <rect x="5.5" y="5" width="13" height="16" rx="2.5" />
      <path d="M9 5V4.2A1.2 1.2 0 0110.2 3h3.6A1.2 1.2 0 0115 4.2V5M9 11h6M9 15h4" />
    </>
  ),
  out: <path d="M13 5h6v6M19 5l-8.5 8.5M10 6H7a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-3" />,
};

export function Icon({ name, size = 22 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

// ───────────── 알림(토스트) ─────────────
const ToastCtx = createContext<(msg: string, kind?: 'info' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; msg: string; kind: 'info' | 'error' } | null>(null);
  const timer = useRef(0);
  const show = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    window.clearTimeout(timer.current);
    setToast({ id: Date.now(), msg, kind });
    timer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 4200 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {toast && (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
            {toast.msg}
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────────── 위쪽 막대 ─────────────
export function TopBar({ title, onBack, right, backLabel = '뒤로' }: { title?: ReactNode; onBack?: () => void; right?: ReactNode; backLabel?: string }) {
  return (
    <header className="topbar">
      {onBack ? (
        <button className="icon-btn" onClick={onBack} aria-label={backLabel}>
          <Icon name="back" />
        </button>
      ) : (
        <span className="icon-btn-space" />
      )}
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">{right}</div>
    </header>
  );
}

// ───────────── 아래에서 올라오는 창 ─────────────
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        {title && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="닫기">
              <Icon name="close" />
            </button>
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

// ───────────── 방 번호 6칸 입력 ─────────────
export function CodeInput({ value, onChange, onComplete, autoFocus }: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; autoFocus?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const digits = value.padEnd(6, ' ').split('');
  return (
    <label className="code-input" onClick={() => ref.current?.focus()}>
      <span className="sr-only">방 번호 6자리</span>
      <input
        ref={ref}
        id="room-code"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        maxLength={7}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, '').slice(0, 6);
          onChange(v);
          if (v.length === 6) onComplete?.(v);
        }}
      />
      <span className="code-cells" aria-hidden="true">
        {digits.map((d, i) => (
          <span key={i} className={`code-cell${i === value.length ? ' is-cursor' : ''}${d.trim() ? ' is-filled' : ''}${i === 3 ? ' gap' : ''}`}>
            {d.trim()}
          </span>
        ))}
      </span>
    </label>
  );
}

// ───────────── 자리 색 표시 ─────────────
export function SeatDot({ seat, size = 12 }: { seat: number; size?: number }) {
  return <span className="seat-dot" style={{ background: seatColor(seat), width: size, height: size }} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button className="icon-btn" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="줄이기">
        <Icon name="minus" />
      </button>
      <output className="stepper-value">{value}</output>
      <button className="icon-btn" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="늘리기">
        <Icon name="plus" />
      </button>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; id: string }) {
  return (
    <label className="toggle-row" htmlFor={id}>
      <span className="toggle-text">
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
    </label>
  );
}

/** 복사: 실패하면 false */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** requestAnimationFrame 루프 */
export function useRaf(fn: () => void, active: boolean): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = () => {
      saved.current();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}


/** 카카오톡 같은 앱 안에서 열렸을 때: 마이크가 안 될 수 있으니 기본 브라우저로 열도록 안내한다 */
export function InAppNotice() {
  const app = useMemo(() => inAppBrowser(), []);
  const toast = useToast();
  if (!app) return null;
  return (
    <section className="banner banner-warn">
      <strong>{app.name} 안에서 열렸어요</strong>
      <span>여기서는 마이크가 막혀 녹음이 안 될 수 있어요. 들어가기 전에 크롬이나 사파리로 열어 주세요. (브라우저마다 따로 기억해서, 나중에 옮기면 다시 들어와야 해요.)</span>
      <div className="row-actions">
        {app.openExternal && (
          <button className="btn btn-primary" onClick={app.openExternal}>
            기본 브라우저로 열기
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={async () => {
            const ok = await copyText(location.href);
            toast(ok ? '주소를 복사했어요. 크롬이나 사파리 주소창에 붙여 넣어 주세요.' : '복사하지 못했어요. 화면의 메뉴에서 "다른 브라우저로 열기"를 눌러 주세요.', ok ? 'info' : 'error');
          }}
        >
          주소 복사
        </button>
      </div>
    </section>
  );
}
