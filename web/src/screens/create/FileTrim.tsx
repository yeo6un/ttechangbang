// 파일 반주에서 부를 구간을 고르는 상자 (파형 위의 밝은 창을 끌어 옮긴다)
import { useEffect, useRef, useState } from 'react';
import type { Transport } from '../../lib/audio/transport';
import { fmtTime } from '../../lib/parts';
import { Icon } from '../../ui';

export interface Source {
  buffer: AudioBuffer;
  name: string;
  demo: boolean;
  peaks: Uint8Array;
}

// ───────── 구간 고르기 상자 ─────────
export function TrimBox({ source, sel, onChange }: { source: Source; sel: { start: number; len: number }; onChange: (s: { start: number; len: number }) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const total = source.buffer.duration;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const draw = () => {
      const w = wrap.clientWidth;
      const h = 84;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const c = canvas.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      c.fillStyle = '#2BD576';
      const p = source.peaks;
      for (let x = 0; x < w; x += 3) {
        const a = Math.floor((x / w) * p.length);
        const b = Math.max(a + 1, Math.floor(((x + 3) / w) * p.length));
        let m = 0;
        for (let i = a; i < b; i++) m = Math.max(m, p[i]);
        const bar = Math.max(2, (m / 255) * (h - 10));
        c.fillRect(x, (h - bar) / 2, 2, bar);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [source]);

  const clampStart = (s: number) => Math.max(0, Math.min(total - sel.len, s));
  const toTime = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * total;
  };

  return (
    <div className="trim">
      <div
        className="trim-wave"
        ref={wrapRef}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const t = toTime(e.clientX);
          const inside = t >= sel.start && t <= sel.start + sel.len;
          const start = inside ? sel.start : clampStart(t - sel.len / 2);
          if (!inside) onChange({ ...sel, start });
          drag.current = { x: e.clientX, start };
        }}
        onPointerMove={(e) => {
          if (!drag.current || !e.buttons) return;
          const r = wrapRef.current!.getBoundingClientRect();
          onChange({ ...sel, start: clampStart(drag.current.start + ((e.clientX - drag.current.x) / r.width) * total) });
        }}
        onPointerUp={() => (drag.current = null)}
        role="slider"
        tabIndex={0}
        aria-label="구간 시작 위치"
        aria-valuemin={0}
        aria-valuemax={Math.round(total - sel.len)}
        aria-valuenow={Math.round(sel.start)}
        aria-valuetext={`${fmtTime(sel.start)}부터 ${fmtTime(sel.start + sel.len)}까지`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onChange({ ...sel, start: clampStart(sel.start - 1) });
          if (e.key === 'ArrowRight') onChange({ ...sel, start: clampStart(sel.start + 1) });
        }}
      >
        <canvas ref={canvasRef} />
        <div className="trim-window" style={{ left: `${(sel.start / total) * 100}%`, width: `${(sel.len / total) * 100}%` }} />
      </div>
      <p className="trim-times">
        <strong>
          {fmtTime(sel.start)} ~ {fmtTime(sel.start + sel.len)}
        </strong>
        <span>
          전체 {fmtTime(total)} 중 {Math.round(sel.len)}초
        </span>
      </p>
    </div>
  );
}

export function PreviewButton({ source, sel, getTransport }: { source: Source; sel: { start: number; len: number }; getTransport: () => Promise<Transport> }) {
  const [on, setOn] = useState(false);
  const tRef = useRef<Transport | null>(null);
  const key = `${sel.start.toFixed(2)}:${sel.len}`;
  useEffect(() => {
    // 구간을 옮기면 재생을 멈춘다
    tRef.current?.stop();
    setOn(false);
  }, [key]);
  useEffect(() => () => tRef.current?.stop(), []);
  return (
    <button
      className="btn btn-secondary"
      onClick={async () => {
        const t = await getTransport();
        tRef.current = t;
        if (on) {
          t.stop();
          return setOn(false);
        }
        t.setSong(source.buffer);
        t.setTakes([]);
        t.play(sel.start, { until: sel.start + sel.len, withTakes: false, onEnd: () => setOn(false) });
        setOn(true);
      }}
    >
      <Icon name={on ? 'pause' : 'play'} size={18} />
      {on ? '멈추기' : '구간 듣기'}
    </button>
  );
}
