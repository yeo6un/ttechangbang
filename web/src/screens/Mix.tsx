// 완성본 화면: 합쳐서 듣기, 소리 크기 맞추기, 녹음별 싱크 고치기, 시상, 파일로 저장
import { useEffect, useMemo, useState } from 'react';
import { Timeline } from '../components/Timeline';
import { api, ApiError, type Room, type Take } from '../lib/api';
import { encodeRaw } from '../lib/audio/codec';
import { isIOS } from '../lib/audio/context';
import { loadAudio } from '../lib/audio/library';
import { renderMix } from '../lib/audio/transport';
import { fmtTime, roomProgress, seatColor, seatName } from '../lib/parts';
import { navigate } from '../lib/router';
import { useRoom } from '../lib/room';
import { audibleTakes, loadPlayTakes, useRoomAudio } from '../lib/roomAudio';
import { awards, seatNames } from '../lib/roomView';
import { YtFrame, YtTapNote } from '../lib/yt/useYt';
import { Icon, SeatDot, Spinner, TopBar, useRaf, useToast } from '../ui';

export function Mix({ code }: { code: string }) {
  const toast = useToast();
  const { room, error, who, apply } = useRoom(code);
  const audio = useRoomAudio(room, who);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState<{ label: string; progress: number } | null>(null);
  const [file, setFile] = useState<{ file: File; url: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState('');

  useEffect(() => {
    if (room && !room.me) navigate(`/r/${code}`, { replace: true });
  }, [room, code]);
  useEffect(() => {
    if (audio.error) toast(audio.error, 'error');
  }, [audio.error, toast]);
  useEffect(() => () => {
    if (file) URL.revokeObjectURL(file.url);
  }, [file]);

  const names = useMemo(() => (room ? seatNames(room) : []), [room]);
  const prizes = useMemo(() => (room ? awards(room) : []), [room]);

  if (error && !room) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate('/')} title="완성본" />
        <section className="stack empty">
          <h1 className="title">방을 찾지 못했어요</h1>
          <p className="lead">{error.message}</p>
        </section>
      </main>
    );
  }
  if (!room || !room.me) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate(`/r/${code}`)} title="완성본" />
        <Spinner label="불러오는 중…" />
      </main>
    );
  }

  const me = room.me;
  const isYt = audio.isYt;
  const hidden = room.blind && !room.revealed;
  const progress = roomProgress(room.lines, room.seatCount, room.takes);
  const heard = audibleTakes(room);
  const usedSeats = [...new Set(heard.map((t) => t.seat))].sort((a, b) => a - b);
  const editable = heard.filter((t) => t.member === me.id || me.isHost).sort((a, b) => a.seat - b.seat || a.start - b.start);

  const run = async (fn: () => Promise<Room>) => {
    if (busy) return;
    setBusy(true);
    try {
      apply(await fn());
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '요청을 처리하지 못했어요.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const shift = (t: Take, delta: number) => run(() => api.patchTake(code, who!, t.id, { offsetMs: Math.max(-500, Math.min(500, t.offsetMs + delta)) }));

  const exportMix = async () => {
    if (!room.song.blob && !isYt) return;
    audio.pause();
    setFile(null);
    setExporting({ label: isYt ? '목소리를 합치는 중' : '노래를 합치는 중', progress: 0.05 });
    try {
      // 유튜브 반주 방은 영상의 소리를 파일에 담을 수 없어서 목소리만 합친다
      const [song, list] = await Promise.all([room.song.blob ? loadAudio(code, room.song.blob, who) : Promise.resolve(null), loadPlayTakes(room, who, heard)]);
      const mixed = await renderMix(song, list, audio.mix, 44100, room.song.dur);
      setExporting({ label: '파일로 만드는 중', progress: 0.3 });
      const bytes = await encodeRaw([mixed.getChannelData(0), mixed.getChannelData(1)], mixed.sampleRate, 2, (p) => setExporting({ label: '파일로 만드는 중', progress: 0.3 + p * 0.7 }));
      const name = `${room.title.replace(/[\\/:*?"<>|]/g, ' ').trim() || '떼창방'} - 떼창방${isYt ? ' (목소리)' : ''}.mp3`;
      const f = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'audio/mpeg' });
      setFile({ file: f, url: URL.createObjectURL(f) });
    } catch {
      toast('완성본을 만들지 못했어요. 다시 눌러 주세요.', 'error');
    } finally {
      setExporting(null);
    }
  };

  const canShareFile = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file.file] });

  return (
    <main className="page mix" style={me.seat !== null ? ({ '--me': seatColor(me.seat) } as React.CSSProperties) : undefined}>
      <TopBar onBack={() => navigate(`/r/${code}`)} backLabel="방으로" title={hidden ? '내 녹음 듣기' : progress.allDone ? '완성본' : '지금까지 합친 것'} />

      <header className="room-head">
        <h1 className="title">{room.title}</h1>
        <p className="meta">
          {hidden
            ? '블라인드 모드라 반주와 내 녹음만 들려요.'
            : progress.allDone
              ? `${usedSeats.length}명의 목소리가 모두 모였어요.`
              : `아직 ${progress.total - progress.done}군데 녹음이 남았어요. 지금까지 모인 것만 들려요.`}
        </p>
      </header>

      <section className="card player-card">
        {isYt && <YtFrame yt={audio.yt} note={audio.needTap ? <YtTapNote after="그다음부터는 여기 버튼으로 움직여요." /> : null} />}
        <div className="player-row">
          <button className="play-btn" onClick={audio.toggle} disabled={isYt ? !audio.yt.player : audio.loading} aria-label={audio.playing ? '멈추기' : '재생'}>
            {(isYt ? audio.yt.loading : audio.loading) ? <span className="spinner" /> : <Icon name={audio.playing ? 'pause' : 'play'} size={26} />}
          </button>
          <div className="player-text">
            <strong>
              <Clock getPosition={audio.getPosition} active={audio.playing} /> / {fmtTime(room.song.dur)}
            </strong>
            <span>{isYt && audio.playing && audio.loading ? '영상을 준비하는 중…' : '타임라인을 누르면 그 자리부터 들을 수 있어요'}</span>
          </div>
        </div>
        <Timeline dur={room.song.dur} songPeaks={room.song.peaks} seatCount={room.seatCount} lines={room.lines} takes={room.takes} names={names} mySeat={me.seat} playing={audio.playing} getPosition={audio.getPosition} onSeek={audio.seek} />
      </section>

      {!hidden && progress.allDone && prizes.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">오늘의 시상식</h2>
          <ul className="awards">
            {prizes.map((a) => (
              <li key={a.title} style={{ '--c': seatColor(a.seat) } as React.CSSProperties}>
                <span className="award-title">{a.title}</span>
                <strong>{a.name}</strong>
                <small>{a.detail}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack-sm">
        <h2 className="section-title">소리 크기</h2>
        <div className="card mixer">
          <MixRow label={isYt ? '영상 소리' : '반주'} color="var(--song)" value={Math.min(audio.mix.backing, isYt ? 1 : 1.5)} max={isYt ? 1 : 1.5} onChange={(v) => audio.setMix({ ...audio.mix, backing: v })} id="mix-backing" />
          {usedSeats.map((s) => (
            <MixRow key={s} label={names[s] || seatName(s)} color={seatColor(s)} value={audio.mix.seats[s] ?? 1} max={2} onChange={(v) => audio.setMix({ ...audio.mix, seats: { ...audio.mix.seats, [s]: v } })} id={`mix-seat-${s}`} />
          ))}
          <MixRow label="노래방 에코" color="var(--ink-2)" value={audio.mix.echo} max={0.6} onChange={(v) => audio.setMix({ ...audio.mix, echo: v })} id="mix-echo" />
          <p className="hint">
            소리 크기는 이 기기에만 저장되고, 저장하는 파일에 그대로 반영돼요.{isYt && isIOS() ? ' 아이폰·아이패드에서는 영상 소리 크기가 기기 음량을 따라가요.' : ''}
          </p>
        </div>
      </section>

      {isYt && heard.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">목소리 전체 타이밍</h2>
          <div className="card sync-card">
            <div className="sync-head">
              <strong>이 기기에서만</strong>
              <output>{audio.shift === 0 ? '그대로' : audio.shift > 0 ? `${audio.shift}ms 늦게` : `${-audio.shift}ms 빠르게`}</output>
            </div>
            <div className="sync-row">
              <button className="icon-btn" onClick={() => audio.setShift(audio.shift - 10)} aria-label="목소리 전체 10ms 빠르게">
                <Icon name="minus" />
              </button>
              <input id="yt-shift" type="range" min={-300} max={300} step={10} value={audio.shift} onChange={(e) => audio.setShift(Number(e.target.value))} aria-label="목소리 전체 타이밍" />
              <button className="icon-btn" onClick={() => audio.setShift(audio.shift + 10)} aria-label="목소리 전체 10ms 늦게">
                <Icon name="plus" />
              </button>
            </div>
            <p className="hint">유튜브 영상과 목소리는 기기마다 소리가 나오는 빠르기가 조금 달라요. 모든 목소리가 한쪽으로 밀려 들리면 여기서 맞춰 주세요. 블루투스 이어폰을 쓰면 더 크게 어긋날 수 있어요.</p>
            <Diagnose read={audio.diagnose} />
          </div>
        </section>
      )}

      {editable.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">{me.isHost ? '녹음 다듬기' : '내 녹음 다듬기'}</h2>
          <ul className="take-list">
            {editable.map((t) => (
              <li key={t.id}>
                <SeatDot seat={t.seat} size={14} />
                <span className="take-name">
                  <strong>{t.memberName}</strong>
                  <small>
                    {fmtTime(Math.max(0, t.start))} ~ {fmtTime(t.start + t.dur)}
                    {t.offsetMs ? `, ${t.offsetMs > 0 ? `${t.offsetMs}ms 늦게` : `${-t.offsetMs}ms 빠르게`}` : ''}
                  </small>
                </span>
                {confirmDelete === t.id ? (
                  <span className="take-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete('')}>
                      취소
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={() => {
                        setConfirmDelete('');
                        void run(() => api.deleteTake(code, who!, t.id));
                      }}
                    >
                      지우기
                    </button>
                  </span>
                ) : (
                  <span className="take-actions">
                    <button className="icon-btn" disabled={busy} onClick={() => shift(t, -20)} aria-label="20ms 빠르게">
                      <Icon name="minus" size={18} />
                    </button>
                    <button className="icon-btn" disabled={busy} onClick={() => shift(t, 20)} aria-label="20ms 늦게">
                      <Icon name="plus" size={18} />
                    </button>
                    <button className="icon-btn" onClick={() => setConfirmDelete(t.id)} aria-label="이 녹음 지우기">
                      <Icon name="trash" size={18} />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="hint">− 는 목소리를 빠르게, + 는 늦게 옮겨요. 바꾸면 모두에게 바로 적용돼요.</p>
        </section>
      )}

      <section className="stack-sm">
        <h2 className="section-title">파일로 저장</h2>
        {hidden ? (
          <p className="hint">모두의 녹음이 공개된 뒤에 저장할 수 있어요.</p>
        ) : (
          <div className="card export">
            {exporting ? (
              <>
                <Spinner label={`${exporting.label}… ${Math.round(exporting.progress * 100)}%`} />
                <div className="bar">
                  <i style={{ width: `${exporting.progress * 100}%` }} />
                </div>
              </>
            ) : file ? (
              <>
                <p className="pill pill-ok">
                  <Icon name="check" size={16} /> 파일이 준비됐어요 ({(file.file.size / 1024 / 1024).toFixed(1)}MB)
                </p>
                <a className="btn btn-primary btn-xl" href={file.url} download={file.file.name}>
                  <Icon name="download" />
                  MP3 내려받기
                </a>
                {canShareFile && (
                  <button className="btn btn-secondary btn-xl" onClick={() => navigator.share({ files: [file.file], title: room.title }).catch(() => {})}>
                    <Icon name="share" />
                    다른 앱으로 보내기
                  </button>
                )}
                <button className="btn btn-ghost" onClick={exportMix}>
                  다시 만들기
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-primary btn-xl" onClick={exportMix} disabled={!heard.length}>
                  <Icon name="download" />
                  {isYt ? '목소리만 파일로 만들기' : progress.allDone ? '완성본 파일 만들기' : '지금까지 합친 것 파일 만들기'}
                </button>
                <p className="hint">
                  {!heard.length
                    ? '녹음이 하나라도 있어야 만들 수 있어요.'
                    : isYt
                      ? '유튜브 영상의 소리는 파일에 담을 수 없어서, 합친 목소리만 MP3 로 만들어요. 영상과 함께 남기고 싶으면 여기서 재생하면서 휴대폰의 화면 녹화를 켜 주세요.'
                      : '지금 들리는 그대로 MP3 한 개로 만들어요.'}
                </p>
              </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function Clock({ getPosition, active }: { getPosition: () => number; active: boolean }) {
  const [text, setText] = useState('0:00');
  useRaf(() => {
    const t = fmtTime(Math.max(0, getPosition()));
    setText((cur) => (cur === t ? cur : t));
  }, active);
  useEffect(() => {
    if (!active) setText(fmtTime(Math.max(0, getPosition())));
  }, [active, getPosition]);
  return <>{text}</>;
}

/** 싱크가 이상할 때 캡처해서 보낼 수 있는 진단 정보. 펼쳐 둔 동안만 1초마다 새로 읽는다. */
function Diagnose({ read }: { read: () => string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!open) return;
    setText(read());
    const timer = window.setInterval(() => setText(read()), 1000);
    return () => window.clearInterval(timer);
  }, [open, read]);
  return (
    <details className="diag" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>싱크가 계속 이상하면 (진단 정보)</summary>
      <p>재생하는 동안 이 부분을 캡처해서 방을 만든 사람에게 보내 주세요.</p>
      <pre>{text}</pre>
    </details>
  );
}

function MixRow({ label, color, value, max, onChange, id }: { label: string; color: string; value: number; max: number; onChange: (v: number) => void; id: string }) {
  return (
    <label className="mix-row" htmlFor={id}>
      <span className="mix-label">
        <i style={{ background: color }} />
        {label}
      </span>
      <input id={id} type="range" min={0} max={max} step={0.02} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{Math.round(value * 100)}</output>
    </label>
  );
}
