// 파트 나누기 편집기: 인원 수, 자동 배정(AI·룰렛), 줄별 수동 지정. 방 만들기와 파트 수정에서 같이 쓴다.
import { useMemo, useState } from 'react';
import { Timeline } from '../components/Timeline';
import { api, ApiError, type Identity } from '../lib/api';
import { applyAssignment, autoAssign, fmtTime, isAll, seatColor, seatName, seatSeconds, SEATS, type Line } from '../lib/parts';
import { Icon, SeatDot, Sheet, Spinner, Stepper, useToast } from '../ui';

interface Props {
  lines: Line[];
  seatCount: number;
  onChange: (lines: Line[], seatCount: number) => void;
  dur: number;
  songPeaks: string;
  /** AI 추천을 부를 수 있는 방 (초안이 올라간 뒤) */
  ai?: { code: string; who: Identity } | null;
  aiAvailable: boolean;
}

export function PartsEditor({ lines, seatCount, onChange, dur, songPeaks, ai, aiAvailable }: Props) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const [notes, setNotes] = useState('');
  const editLine = lines.find((l) => l.id === editing) || null;
  const names = useMemo(() => Array.from({ length: seatCount }, (_, i) => seatName(i)), [seatCount]);
  const total = lines.reduce((s, l) => s + (l.t1 - l.t0), 0) || 1;

  const reassign = (count: number, mode: 'smart' | 'roulette') => {
    setSummary(mode === 'roulette' ? '룰렛을 돌렸어요. 마음에 안 들면 또 돌려 보세요.' : '');
    onChange(autoAssign(lines, count, mode), count);
  };

  const askAi = async () => {
    if (!ai) return reassign(seatCount, 'smart');
    setBusy(true);
    try {
      const out = await api.aiSplit(ai.code, ai.who, { lines, seatCount, notes });
      onChange(applyAssignment(lines, out.assign, seatCount), seatCount);
      setSummary(out.summary || 'AI가 가사 흐름에 맞춰 나눴어요.');
    } catch (e) {
      onChange(autoAssign(lines, seatCount, 'smart'), seatCount);
      setSummary('');
      toast(e instanceof ApiError ? e.message : 'AI 추천을 받지 못해 자동 배정으로 나눴어요.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const setSeats = (id: string, seats: number[]) => {
    onChange(
      lines.map((l) => (l.id === id ? { ...l, seats: [...seats].sort((a, b) => a - b) } : l)),
      seatCount,
    );
  };

  return (
    <div className="parts-editor">
      <div className="field-row">
        <div>
          <h3>몇 명이 부르나요?</h3>
          <p className="hint">색깔 하나가 한 사람 자리예요.</p>
        </div>
        <Stepper value={seatCount} min={1} max={SEATS.length} label="부르는 사람 수" onChange={(n) => reassign(n, 'smart')} />
      </div>

      <div className="assign-actions">
        <button className="btn btn-secondary" onClick={aiAvailable && ai ? askAi : () => reassign(seatCount, 'smart')} disabled={busy}>
          <Icon name="spark" size={18} />
          {aiAvailable && ai ? 'AI 추천' : '자동 추천'}
        </button>
        <button className="btn btn-secondary" onClick={() => reassign(seatCount, 'roulette')} disabled={busy}>
          <Icon name="dice" size={18} />
          룰렛
        </button>
      </div>
      {aiAvailable && ai && (
        <input
          id="ai-notes"
          className="input input-sm"
          placeholder="AI에게 부탁 (선택): 예) 랩은 2번이, 후렴은 다같이"
          value={notes}
          maxLength={200}
          onChange={(e) => setNotes(e.target.value)}
        />
      )}
      {busy && <Spinner label="AI가 가사를 읽고 나누는 중…" />}
      {summary && !busy && <p className="ai-summary">{summary}</p>}

      <div className="card card-tight">
        <Timeline dur={dur} songPeaks={songPeaks} seatCount={seatCount} lines={lines} takes={[]} names={names} compact />
      </div>

      <ul className="seat-loads" aria-label="자리별 부르는 시간">
        {Array.from({ length: seatCount }, (_, s) => {
          const sec = seatSeconds(lines, s);
          return (
            <li key={s}>
              <SeatDot seat={s} />
              <span className="seat-load-name">{seatName(s)}</span>
              <span className="seat-load-bar">
                <i style={{ width: `${Math.min(100, (sec / total) * 100 * Math.max(1, seatCount * 0.6))}%`, background: seatColor(s) }} />
              </span>
              <span className="seat-load-sec">{sec ? `${Math.round(sec)}초` : '없음'}</span>
            </li>
          );
        })}
      </ul>

      <h3 className="list-title">줄마다 누가 부를지</h3>
      <p className="hint">줄을 누르면 부를 사람을 바꿀 수 있어요. 여러 명을 고르면 같이 불러요.</p>
      <ol className="line-list">
        {lines.map((l, i) => (
          <li key={l.id}>
            <button className="line-row" onClick={() => setEditing(l.id)}>
              <span className="line-time">{fmtTime(l.t0)}</span>
              <span className="line-text">{l.text || `구간 ${i + 1}`}</span>
              <span className="line-seats">
                {isAll(l, seatCount) ? (
                  <span className="all-chip">다같이</span>
                ) : l.seats.length ? (
                  l.seats.map((s) => <SeatDot key={s} seat={s} size={14} />)
                ) : (
                  <span className="none-chip">미정</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <Sheet open={!!editLine} onClose={() => setEditing(null)} title="이 줄은 누가 부를까요?">
        {editLine && (
          <>
            <p className="sheet-quote">{editLine.text || '가사 없는 구간'}</p>
            <div className="seat-pick-grid">
              {Array.from({ length: seatCount }, (_, s) => {
                const on = editLine.seats.includes(s);
                return (
                  <button
                    key={s}
                    className={`seat-pick${on ? ' is-on' : ''}`}
                    style={{ '--c': seatColor(s) } as React.CSSProperties}
                    aria-pressed={on}
                    onClick={() => setSeats(editLine.id, on ? editLine.seats.filter((x) => x !== s) : [...editLine.seats, s])}
                  >
                    <SeatDot seat={s} size={16} />
                    {seatName(s)}
                    {on && <Icon name="check" size={16} />}
                  </button>
                );
              })}
            </div>
            <div className="sheet-actions">
              {seatCount > 1 && (
                <button className="btn btn-secondary" onClick={() => setSeats(editLine.id, Array.from({ length: seatCount }, (_, i) => i))}>
                  다같이
                </button>
              )}
              <button className="btn btn-primary" onClick={() => setEditing(null)} disabled={!editLine.seats.length}>
                {editLine.seats.length ? '이대로' : '한 명 이상 골라 주세요'}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  );
}
