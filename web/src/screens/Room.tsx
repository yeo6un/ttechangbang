// 방 화면: 타임라인, 내 파트, 함께 부르는 사람, 가사. 여기서 녹음하러 가거나 완성본을 들으러 간다.
import { useEffect, useMemo, useState } from 'react';
import { Timeline } from '../components/Timeline';
import { api, ApiError, type Room } from '../lib/api';
import { fmtSpan, fmtTime, isAll, roomProgress, seatColor, seatName, type Line } from '../lib/parts';
import { fmtCode, navigate, roomLink } from '../lib/router';
import { useRoom } from '../lib/room';
import { useRoomAudio } from '../lib/roomAudio';
import { daysLeft, seatInfos, seatNames, type SeatInfo } from '../lib/roomView';
import { store } from '../lib/store';
import { YtFrame, YtTapNote } from '../lib/yt/useYt';
import { copyText, Icon, InAppNotice, SeatDot, Sheet, Spinner, TopBar, useRaf, useToast } from '../ui';

export function RoomScreen({ code }: { code: string }) {
  const toast = useToast();
  const { room, error, who, apply, setWho } = useRoom(code);
  const audio = useRoomAudio(room, who);
  const [invite, setInvite] = useState(false);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [freeing, setFreeing] = useState<number | null>(null);

  useEffect(() => {
    if (room?.me) store.touchRecent(room, room.me.isHost);
  }, [room?.me, room?.title, room?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (audio.error) toast(audio.error, 'error');
  }, [audio.error, toast]);

  if (error && (error.status === 404 || error.status === 410 || !room)) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate('/')} title="떼창방" />
        <section className="stack empty">
          <h1 className="title">{error.status === 410 ? '기간이 끝난 방이에요' : error.code === 'not_ready' ? '아직 준비 중인 방이에요' : '방을 찾지 못했어요'}</h1>
          <p className="lead">{error.message}</p>
          <button
            className="btn btn-primary btn-xl"
            onClick={() => {
              if (error.status === 410 || error.code === 'not_found') store.forget(code);
              navigate('/');
            }}
          >
            처음으로
          </button>
        </section>
      </main>
    );
  }
  if (!room) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate('/')} title="떼창방" />
        <Spinner label="방에 들어가는 중…" />
      </main>
    );
  }

  const me = room.me;
  const seats = seatInfos(room);
  const names = seatNames(room);
  const progress = roomProgress(room.lines, room.seatCount, room.takes);
  const mySeat = me?.seat ?? null;
  const mine = mySeat !== null ? seats[mySeat] : null;
  const hidden = room.blind && !room.revealed;
  const finishedSeats = seats.filter((s) => s.total > 0 && s.done === s.total).length;
  const activeSeats = seats.filter((s) => s.total > 0).length;

  const run = async (fn: () => Promise<Room | void>, okMsg?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await fn();
      if (next) apply(next);
      if (okMsg) toast(okMsg);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '요청을 처리하지 못했어요.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const takeSeat = (seat: number | null) =>
    run(async () => {
      const next = await api.setMe(code, who!, { seat });
      setPicking(false);
      return next;
    });

  const waiting = activeSeats - finishedSeats;
  const shareText = `떼창방에서 같이 불러요! "${room.title}"${waiting > 0 && room.takes.length > 0 ? `\n아직 ${waiting}파트 녹음이 남았어요.` : ''}\n방 번호 ${fmtCode(code)}\n${roomLink(code)}`;

  return (
    <main className="page room" style={mySeat !== null ? ({ '--me': seatColor(mySeat) } as React.CSSProperties) : undefined}>
      <TopBar
        onBack={() => navigate('/')}
        backLabel="처음으로"
        title={
          <button className="code-chip" onClick={() => setInvite(true)} aria-label={`방 번호 ${code}, 초대하기`}>
            {fmtCode(code)}
            <Icon name="share" size={16} />
          </button>
        }
        right={
          me ? (
            <button className="icon-btn" onClick={() => setMenu(true)} aria-label="더보기">
              <Icon name="more" />
            </button>
          ) : null
        }
      />

      <header className="room-head">
        <h1 className="title">{room.title}</h1>
        {room.song.artist && <p className="room-artist">{room.song.artist}</p>}
        <p className="meta meta-split">
          <span>{activeSeats > 0 ? `${activeSeats}파트 중 ${finishedSeats}파트 녹음 완료` : '파트 준비 중'}</span>
          <span>{daysLeft(room)}</span>
        </p>
      </header>

      <InAppNotice />

      {!me ? (
        <JoinCard
          room={room}
          onJoin={(name) =>
            run(async () => {
              const out = await api.join(code, name);
              store.setName(name);
              setWho(out.member);
              store.touchRecent(out.room, false);
              return out.room;
            })
          }
          busy={busy}
        />
      ) : (
        <>
          {room.blind ? (
            <Banner room={room} allDone={progress.allDone} onReveal={() => run(() => api.putSettings(code, who!, { revealed: true }), '모두에게 공개했어요!')} />
          ) : (
            progress.allDone && (
              <section className="banner banner-party">
                <strong>모든 파트가 모였어요</strong>
                <span>{finishedSeats}파트의 목소리가 한 곡으로 합쳐졌어요. 아래에서 완성본을 들어 보세요.</span>
              </section>
            )
          )}

          {/* 파트를 아직 안 골랐으면 고르는 일이 먼저다 */}
          {mySeat === null && <SeatPicker seats={seats} busy={busy} onPick={takeSeat} current={null} />}

          <section className="card player-card">
            {audio.isYt && <YtFrame yt={audio.yt} note={audio.needTap ? <YtTapNote after="그다음부터는 여기 버튼으로 움직여요." /> : null} />}
            <div className="player-row">
              {/* 유튜브 반주: 영상이 다 불러와질 때까지는 누를 수 없다. 파일 반주: 소리를 받는 동안 돌아가는 표시. */}
              <button className="play-btn" onClick={audio.toggle} disabled={audio.isYt ? !audio.yt.player : audio.loading} aria-label={audio.playing ? '멈추기' : '재생'}>
                {(audio.isYt ? audio.yt.loading : audio.loading) ? <span className="spinner" /> : <Icon name={audio.playing ? 'pause' : 'play'} size={26} />}
              </button>
              <div className="player-text">
                <strong>
                  <Clock getPosition={audio.getPosition} active={audio.playing} /> / {fmtTime(room.song.dur)}
                </strong>
                <span>
                  {audio.isYt && audio.playing && audio.loading
                    ? '영상을 준비하는 중…'
                    : hidden
                      ? '지금은 반주와 내 녹음만 들려요'
                      : room.takes.length
                        ? `${audio.isYt ? '유튜브 영상' : '반주'}과 지금까지의 녹음이 함께 나와요`
                        : `아직 녹음이 없어 ${audio.isYt ? '영상' : '반주'}만 나와요`}
                </span>
              </div>
            </div>
            <Timeline
              dur={room.song.dur}
              songPeaks={room.song.peaks}
              seatCount={room.seatCount}
              lines={room.lines}
              takes={room.takes}
              names={names}
              mySeat={mySeat}
              playing={audio.playing}
              getPosition={audio.getPosition}
              onSeek={audio.seek}
            />
          </section>

          {mySeat !== null &&
            (mine && !picking ? (
              <MyPart info={mine} room={room} onChange={() => setPicking(true)} />
            ) : (
              <SeatPicker seats={seats} busy={busy} onPick={takeSeat} current={mySeat} onCancel={() => setPicking(false)} />
            ))}

          <section className="stack-sm">
            <h2 className="section-title">함께 부르는 사람</h2>
            <ul className="people">
              {seats.map((s) => (
                <li key={s.seat} className={s.mine ? 'is-me' : ''}>
                  <span className="avatar" style={{ '--c': seatColor(s.seat) } as React.CSSProperties}>
                    {s.name ? s.name.slice(0, 1) : ''}
                  </span>
                  <span className="people-name">
                    <strong>{s.name || '아직 비어 있어요'}</strong>
                    <small>
                      {seatName(s.seat)} 파트, {s.lines.length}줄 {Math.round(s.seconds)}초
                    </small>
                  </span>
                  {me.isHost && s.occupied && !s.mine ? (
                    freeing === s.seat ? (
                      <span className="take-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => setFreeing(null)}>
                          취소
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={busy}
                          onClick={() => {
                            setFreeing(null);
                            void run(() => api.release(code, who!, s.seat), `${seatName(s.seat)} 파트를 비웠어요. 녹음은 그대로 남아요.`);
                          }}
                        >
                          비우기
                        </button>
                      </span>
                    ) : (
                      <button className="status-btn" onClick={() => setFreeing(s.seat)} aria-label={`${s.name} 님의 ${seatName(s.seat)} 파트 비우기`}>
                        <SeatStatus info={s} />
                        <Icon name="more" size={16} />
                      </button>
                    )
                  ) : (
                    <SeatStatus info={s} />
                  )}
                </li>
              ))}
            </ul>
            {room.members.filter((m) => m.seat === null).length > 0 && (
              <p className="hint">파트를 아직 안 고른 사람: {room.members.filter((m) => m.seat === null).map((m) => m.name).join(', ')}</p>
            )}
            {seats.some((s) => !s.occupied && s.total > 0 && s.done < s.total) && (
              <button className="btn btn-secondary" onClick={() => setInvite(true)}>
                <Icon name="share" size={18} />
                빈 파트에 친구 초대하기
              </button>
            )}
          </section>

          <section className="stack-sm">
            <h2 className="section-title">가사와 파트</h2>
            <LyricsList lines={room.lines} seatCount={room.seatCount} mySeat={mySeat} />
          </section>

          <div className="bottom-bar">
            {mine && mine.total > 0 && mine.done < mine.total && (
              <button className="btn btn-primary btn-xl" onClick={() => navigate(`/r/${code}/rec`)}>
                <Icon name="mic" />
                {mine.done > 0 ? `이어서 녹음하기 (${mine.done}/${mine.total})` : '내 파트 녹음하기'}
              </button>
            )}
            {/* 내 녹음이 남아 있지 않으면(다 불렀거나, 파트 없이 구경·진행만 하는 사람) 합친 것을 들으러 간다 */}
            {!(mine && mine.total > 0 && mine.done < mine.total) && (hidden ? !!mine && mine.done > 0 : room.takes.length > 0) && (
              <button className="btn btn-primary btn-xl" onClick={() => navigate(`/r/${code}/mix`)}>
                <Icon name="headphones" />
                {hidden ? '내 녹음 들어보기' : progress.allDone ? '완성본 듣기' : '지금까지 합친 것 듣기'}
              </button>
            )}
            {mine && mine.total > 0 && mine.done === mine.total && (
              <button className="btn btn-ghost" onClick={() => navigate(`/r/${code}/rec`)}>
                다시 녹음하기
              </button>
            )}
            {mine && mine.total === 0 && <p className="hint center">이 색에는 부를 줄이 없어요. 다른 파트를 골라 주세요.</p>}
          </div>
        </>
      )}

      <Sheet open={invite} onClose={() => setInvite(false)} title="친구 초대하기">
        <div className="code-show sm">{fmtCode(code)}</div>
        <p className="hint center">방 번호나 링크를 보내 주세요. 설치·가입 없이 바로 들어와요.</p>
        <div className="sheet-actions col">
          <button
            className="btn btn-primary btn-xl"
            onClick={async () => {
              const ok = await copyText(shareText);
              toast(ok ? '초대 글을 복사했어요. 채팅방에 붙여 넣어 주세요.' : '복사하지 못했어요. 번호를 직접 알려 주세요.', ok ? 'info' : 'error');
            }}
          >
            <Icon name="copy" />
            초대 글 복사하기
          </button>
          {typeof navigator.share === 'function' && (
            <button className="btn btn-secondary btn-xl" onClick={() => navigator.share({ text: shareText }).catch(() => {})}>
              <Icon name="share" />
              다른 앱으로 보내기
            </button>
          )}
        </div>
      </Sheet>

      {me && (
        <MenuSheet
          open={menu}
          onClose={() => setMenu(false)}
          room={room}
          busy={busy}
          onRename={(name) =>
            run(async () => {
              const next = await api.setMe(code, who!, { name });
              store.setName(name);
              return next;
            }, '이름을 바꿨어요')
          }
          onEdit={() => navigate(`/r/${code}/edit`)}
          onBlind={(v) => run(() => api.putSettings(code, who!, { blind: v }), v ? '블라인드 모드를 켰어요' : '블라인드 모드를 껐어요')}
          onExtend={() => run(() => api.putSettings(code, who!, { extend: true }), '방 기간을 7일 늘렸어요')}
          onClose2={() =>
            run(async () => {
              await api.deleteRoom(code, who!);
              store.forget(code);
              toast('방을 닫았어요');
              navigate('/');
            })
          }
        />
      )}
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

function Banner({ room, allDone, onReveal }: { room: Room; allDone: boolean; onReveal: () => void }) {
  if (room.revealed) {
    return (
      <section className="banner banner-party">
        <strong>모두의 녹음이 공개됐어요</strong>
        <span>이제 서로의 목소리를 들을 수 있어요.</span>
        <button className="btn btn-primary" onClick={() => navigate(`/r/${room.code}/mix`)}>
          같이 들어보기
        </button>
      </section>
    );
  }
  return (
    <section className="banner">
      <strong>
        <Icon name="lock" size={16} /> 블라인드 모드
      </strong>
      <span>{allDone ? (room.me?.isHost ? '모두 녹음을 마쳤어요. 이제 공개할 수 있어요.' : '모두 녹음을 마쳤어요. 방장이 공개하면 들을 수 있어요.') : '모두 녹음을 마칠 때까지 서로의 녹음은 들을 수 없어요.'}</span>
      {room.me?.isHost && (
        <button className={`btn ${allDone ? 'btn-primary' : 'btn-secondary'}`} onClick={onReveal}>
          {allDone ? '지금 공개하기' : '기다리지 않고 공개하기'}
        </button>
      )}
    </section>
  );
}

function SeatStatus({ info }: { info: SeatInfo }) {
  if (info.total === 0) return <span className="status">줄 없음</span>;
  if (info.done === info.total)
    return (
      <span className="status status-done">
        <Icon name="check" size={15} /> 다 불렀어요
      </span>
    );
  if (info.done > 0) return <span className="status status-part">{info.done}/{info.total} 녹음</span>;
  return <span className="status">{info.occupied ? '아직' : '빈 자리'}</span>;
}

function JoinCard({ room, onJoin, busy }: { room: Room; onJoin: (name: string) => void; busy: boolean }) {
  const [name, setName] = useState(() => store.name());
  const host = room.members.find((m) => m.isHost);
  return (
    <form
      className="card join-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onJoin(name.trim());
      }}
    >
      <h2>{host ? `${host.name} 님이 만든 방이에요` : '초대받은 방이에요'}</h2>
      <p className="hint">
        {room.seatCount}명이 파트를 나눠 부르는 {fmtSpan(room.song.dur)}짜리 {room.song.dur > 150 ? '노래' : '구간'}예요. 이름만 넣으면 바로 들어가요.
      </p>
      <label className="field">
        <span>내 이름</span>
        <input id="join-name" className="input" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} placeholder="친구들이 알아볼 이름" autoComplete="nickname" autoFocus />
      </label>
      <button className="btn btn-primary btn-xl" disabled={!name.trim() || busy}>
        {busy ? '들어가는 중…' : '들어가기'}
      </button>
    </form>
  );
}

function SeatPicker({ seats, onPick, current, busy, onCancel }: { seats: SeatInfo[]; onPick: (seat: number | null) => void; current: number | null; busy: boolean; onCancel?: () => void }) {
  return (
    <section className="stack-sm">
      <h2 className="section-title">어느 파트를 부를래요?</h2>
      <ul className="seat-list">
        {seats.map((s) => {
          const takenByOther = s.occupied && !s.mine;
          return (
            <li key={s.seat}>
              <button className={`seat-card${s.mine ? ' is-mine' : ''}`} style={{ '--c': seatColor(s.seat) } as React.CSSProperties} disabled={busy || takenByOther || s.total === 0} onClick={() => onPick(s.seat)}>
                <span className="avatar">{s.occupied && s.name ? s.name.slice(0, 1) : ''}</span>
                <span className="seat-card-body">
                  <span className="seat-card-head">
                    <strong>{seatName(s.seat)} 파트</strong>
                    <small>{takenByOther ? `${s.name} 님이 골랐어요` : s.mine ? '지금 내 파트' : s.total === 0 ? '부를 줄이 없어요' : `${s.lines.length}줄 ${Math.round(s.seconds)}초`}</small>
                  </span>
                  <span className="seat-card-preview">{s.lines.slice(0, 2).map((l) => l.text || `${fmtTime(l.t0)} 구간`).join(' / ') || '부를 줄 없음'}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="row-actions">
        {current !== null && (
          <button className="btn btn-ghost" disabled={busy} onClick={() => onPick(null)}>
            내 파트 내려놓기
          </button>
        )}
        {onCancel && (
          <button className="btn btn-ghost" onClick={onCancel}>
            그대로 두기
          </button>
        )}
      </div>
    </section>
  );
}

function MyPart({ info, room, onChange }: { info: SeatInfo; room: Room; onChange: () => void }) {
  return (
    <section className="card my-part">
      <div className="my-part-head">
        <div>
          <p className="my-part-label">내 파트는 {seatName(info.seat)}</p>
          <h2>
            {info.lines.length}줄, {Math.round(info.seconds)}초
          </h2>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onChange}>
          바꾸기
        </button>
      </div>
      <ul className="my-lines">
        {info.lines.slice(0, 4).map((l) => (
          <li key={l.id}>
            <small>{fmtTime(l.t0)}</small>
            {l.text || '가사 없는 구간'}
            {isAll(l, room.seatCount) && <em>다같이</em>}
          </li>
        ))}
        {info.lines.length > 4 && <li className="more">외 {info.lines.length - 4}줄</li>}
      </ul>
    </section>
  );
}

function LyricsList({ lines, seatCount, mySeat }: { lines: Line[]; seatCount: number; mySeat: number | null }) {
  const rows = useMemo(() => [...lines].sort((a, b) => a.t0 - b.t0), [lines]);
  if (!rows.length) return <p className="hint">아직 파트가 없어요.</p>;
  return (
    <ol className="lyrics">
      {rows.map((l, i) => {
        const mineLine = mySeat !== null && l.seats.includes(mySeat);
        return (
          <li key={l.id} className={mineLine ? 'is-mine' : ''}>
            <span className="lyrics-who">
              {isAll(l, seatCount) ? <span className="all-chip">다같이</span> : l.seats.map((s) => <SeatDot key={s} seat={s} />)}
            </span>
            <span className="lyrics-text">{l.text || `구간 ${i + 1}`}</span>
            <small>{fmtTime(l.t0)}</small>
          </li>
        );
      })}
    </ol>
  );
}

function MenuSheet({
  open,
  onClose,
  room,
  busy,
  onRename,
  onEdit,
  onBlind,
  onExtend,
  onClose2,
}: {
  open: boolean;
  onClose: () => void;
  room: Room;
  busy: boolean;
  onRename: (name: string) => void;
  onEdit: () => void;
  onBlind: (v: boolean) => void;
  onExtend: () => void;
  onClose2: () => void;
}) {
  const [name, setName] = useState(room.me?.name || '');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (open) {
      setName(room.me?.name || '');
      setConfirm(false);
    }
  }, [open, room.me?.name]);
  const host = !!room.me?.isHost;
  return (
    <Sheet open={open} onClose={onClose} title="더보기">
      <form
        className="rename"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== room.me?.name) onRename(name.trim());
        }}
      >
        <label className="field">
          <span>내 이름</span>
          <input id="rename" className="input" value={name} maxLength={16} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn btn-secondary" disabled={busy || !name.trim() || name.trim() === room.me?.name}>
          바꾸기
        </button>
      </form>
      {host && (
        <ul className="menu-list">
          <li>
            <button onClick={onEdit}>
              <Icon name="edit" />
              <span>
                <strong>파트 다시 나누기</strong>
                <small>인원수나 줄별 담당을 바꿔요</small>
              </span>
            </button>
          </li>
          <li>
            <button onClick={() => onBlind(!room.blind)} disabled={busy}>
              <Icon name="lock" />
              <span>
                <strong>블라인드 모드 {room.blind ? '끄기' : '켜기'}</strong>
                <small>{room.blind ? '끄면 서로의 녹음을 바로 들을 수 있어요' : '다 모일 때까지 서로의 녹음을 숨겨요'}</small>
              </span>
            </button>
          </li>
          <li>
            <button onClick={onExtend} disabled={busy}>
              <Icon name="clock" />
              <span>
                <strong>방 기간 7일 늘리기</strong>
                <small>지금은 {daysLeft(room)}</small>
              </span>
            </button>
          </li>
          <li>
            {confirm ? (
              <div className="confirm">
                <p>방을 닫으면 노래와 모든 녹음이 바로 지워지고 되돌릴 수 없어요.</p>
                <div className="sheet-actions">
                  <button className="btn btn-secondary" onClick={() => setConfirm(false)}>
                    취소
                  </button>
                  <button className="btn btn-danger" onClick={onClose2} disabled={busy}>
                    방 닫고 모두 지우기
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirm(true)} className="danger">
                <Icon name="trash" />
                <span>
                  <strong>방 닫기</strong>
                  <small>노래와 녹음을 모두 지워요</small>
                </span>
              </button>
            )}
          </li>
        </ul>
      )}
      {!host && <p className="hint">파트를 다시 나누거나 방을 닫는 일은 방을 만든 사람만 할 수 있어요.</p>}
    </Sheet>
  );
}
