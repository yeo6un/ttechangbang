// 색깔 트랙 타임라인: 맨 위는 원곡(초록), 그 아래는 자리별 파트. 녹음이 끝난 파트에는 파형이 채워진다.
import { useEffect, useMemo, useRef } from 'react';
import { base64ToBytes } from '../lib/audio/peaks';
import { fmtTime, lineRecorded, seatColor, type Line } from '../lib/parts';
import { Icon, useRaf } from '../ui';

export interface TimelineTake {
  seat: number;
  start: number;
  dur: number;
  offsetMs: number;
  peaks: string;
}

interface Props {
  dur: number;
  songPeaks: string;
  seatCount: number;
  lines: Line[];
  takes: TimelineTake[];
  /** 자리별 표시 이름 (없으면 빈 자리) */
  names: (string | null)[];
  mySeat?: number | null;
  playing?: boolean;
  getPosition?: () => number;
  onSeek?: (pos: number) => void;
  /** 미리보기용 작은 크기 */
  compact?: boolean;
}

const SONG = '#2BD576';

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex: string, a: number) => {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
const shade = (hex: string, k: number) => {
  const [r, g, b] = rgb(hex);
  // 배경색(#161226) 쪽으로 섞어 어둡게
  return `rgb(${Math.round(22 + (r - 22) * k)},${Math.round(18 + (g - 18) * k)},${Math.round(38 + (b - 38) * k)})`;
};

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function drawWave(c: CanvasRenderingContext2D, peaks: Uint8Array, x0: number, x1: number, yMid: number, half: number, color: string) {
  const w = x1 - x0;
  if (w < 2 || !peaks.length) return;
  c.fillStyle = color;
  const step = 2.5;
  for (let x = 0; x < w; x += step) {
    const a = Math.floor((x / w) * peaks.length);
    const b = Math.max(a + 1, Math.floor(((x + step) / w) * peaks.length));
    let p = 0;
    for (let i = a; i < b && i < peaks.length; i++) p = Math.max(p, peaks[i]);
    if (p < 3) continue; // 조용한 곳은 비워 둔다
    const h = Math.max(1, (p / 255) * half);
    c.fillRect(x0 + x, yMid - h, 1.5, h * 2);
  }
}

export function Timeline({ dur, songPeaks, seatCount, lines, takes, names, mySeat, playing, getPosition, onSeek, compact }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const RULER = compact ? 0 : 16;
  const SONG_H = compact ? 22 : 34;
  const ROW_H = compact ? 18 : 30;
  const GAP = compact ? 4 : 6;
  const height = RULER + SONG_H + seatCount * (ROW_H + GAP);

  const song = useMemo(() => base64ToBytes(songPeaks), [songPeaks]);
  const takeKey = takes.map((t) => `${t.seat}:${t.start}:${t.dur}:${t.offsetMs}:${t.peaks.length}`).join('|');
  const lineKey = lines.map((l) => `${l.id}:${l.t0}:${l.t1}:${l.seats.join('.')}`).join('|');

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const draw = () => {
      const width = wrap.clientWidth;
      if (!width) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = height + 'px';
      const c = canvas.getContext('2d');
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, width, height);
      const X = (t: number) => (Math.max(0, Math.min(dur, t)) / dur) * width;

      if (RULER) {
        c.font = '10px system-ui, sans-serif';
        c.fillStyle = '#8A80B0';
        c.textBaseline = 'top';
        const step = dur > 70 ? 20 : dur > 35 ? 10 : 5;
        for (let t = 0; t < dur - step * 0.4; t += step) {
          const x = X(t);
          c.fillRect(x, RULER - 4, 1, 4);
          c.fillText(fmtTime(t), x + 3, 0);
        }
      }

      // 원곡 트랙
      roundRect(c, 0, RULER, width, SONG_H, 7);
      c.fillStyle = shade(SONG, 0.42);
      c.fill();
      drawWave(c, song, 3, width - 3, RULER + SONG_H / 2, SONG_H / 2 - 4, SONG);

      for (let s = 0; s < seatCount; s++) {
        const y = RULER + SONG_H + GAP + s * (ROW_H + GAP);
        const color = seatColor(s);
        // 빈 줄 바탕
        c.fillStyle = 'rgba(255,248,234,0.035)';
        roundRect(c, 0, y, width, ROW_H, 6);
        c.fill();
        for (const l of lines) {
          if (!l.seats.includes(s)) continue;
          const x0 = X(l.t0);
          const w = Math.max(3, X(l.t1) - x0 - 1.5);
          const done = lineRecorded(l, s, takes);
          roundRect(c, x0, y, w, ROW_H, 6);
          if (done) {
            c.fillStyle = shade(color, 0.5);
            c.fill();
          } else {
            c.fillStyle = rgba(color, 0.16);
            c.fill();
            c.save();
            c.setLineDash([4, 3]);
            c.lineWidth = 1.25;
            c.strokeStyle = rgba(color, 0.75);
            roundRect(c, x0 + 0.6, y + 0.6, w - 1.2, ROW_H - 1.2, 5.5);
            c.stroke();
            c.restore();
          }
        }
        for (const t of takes) {
          if (t.seat !== s) continue;
          const st = t.start + t.offsetMs / 1000;
          c.save();
          c.beginPath();
          c.rect(X(st), y, Math.max(1, X(st + t.dur) - X(st)), ROW_H);
          c.clip();
          drawWave(c, base64ToBytes(t.peaks), X(st), X(st + t.dur), y + ROW_H / 2, ROW_H / 2 - 3, color);
          c.restore();
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dur, song, seatCount, lineKey, takeKey, height]);

  const place = () => {
    const pos = getPosition ? getPosition() : 0;
    const wrap = wrapRef.current;
    if (headRef.current && wrap) headRef.current.style.transform = `translateX(${(Math.max(0, Math.min(dur, pos)) / dur) * wrap.clientWidth}px)`;
  };
  useRaf(place, !!playing);
  useEffect(place);

  const seekFrom = (clientX: number) => {
    const wrap = wrapRef.current;
    if (!wrap || !onSeek) return;
    const r = wrap.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur);
    requestAnimationFrame(place);
  };

  return (
    <div className={`timeline${compact ? ' is-compact' : ''}`}>
      <div className="timeline-labels" style={{ paddingTop: RULER }} aria-hidden="true">
        <span className="tl-label tl-song" style={{ height: SONG_H }}>
          <Icon name="music" size={compact ? 12 : 16} />
        </span>
        {Array.from({ length: seatCount }, (_, s) => (
          <span key={s} className={`tl-label${mySeat === s ? ' is-me' : ''}${names[s] ? '' : ' is-empty'}`} style={{ height: ROW_H, marginTop: GAP, '--c': seatColor(s) } as React.CSSProperties}>
            {names[s] ? names[s]!.slice(0, 1) : ''}
          </span>
        ))}
      </div>
      <div
        className="timeline-canvas"
        ref={wrapRef}
        onPointerDown={(e) => {
          if (!onSeek) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          seekFrom(e.clientX);
        }}
        onPointerMove={(e) => {
          if (onSeek && e.buttons) seekFrom(e.clientX);
        }}
        role={onSeek ? 'slider' : 'img'}
        aria-label={onSeek ? '재생 위치' : '파트 타임라인'}
        aria-valuemin={onSeek ? 0 : undefined}
        aria-valuemax={onSeek ? Math.round(dur) : undefined}
        aria-valuenow={onSeek ? Math.round(getPosition ? getPosition() : 0) : undefined}
        tabIndex={onSeek ? 0 : undefined}
        onKeyDown={(e) => {
          if (!onSeek || !getPosition) return;
          if (e.key === 'ArrowRight') onSeek(Math.min(dur, getPosition() + 2));
          if (e.key === 'ArrowLeft') onSeek(Math.max(0, getPosition() - 2));
        }}
      >
        <canvas ref={canvasRef} />
        {getPosition && <div className="timeline-head" ref={headRef} style={{ top: RULER - 2, height: height - RULER + 2 }} />}
      </div>
    </div>
  );
}
