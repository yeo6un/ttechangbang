import '@fontsource/black-han-sans/korean-400.css';
import '@fontsource/black-han-sans/latin-400.css';
import './app.css';
import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { decodeWithLead } from './lib/audio/codec';
import { getCtx } from './lib/audio/context';
import { renderDemoBeat } from './lib/audio/demo';
import { encodeWav } from './lib/audio/wav';
import { navigate, useRoute } from './lib/router';
import { Create } from './screens/Create';
import { EditParts } from './screens/EditParts';
import { Home } from './screens/Home';
import { Mix } from './screens/Mix';
import { Record } from './screens/Record';
import { RoomScreen } from './screens/Room';
import { ToastProvider } from './ui';

function App() {
  const route = useRoute();
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'new':
      return <Create />;
    case 'room':
      return <RoomScreen key={route.code} code={route.code} />;
    case 'rec':
      return <Record key={route.code} code={route.code} />;
    case 'mix':
      return <Mix key={route.code} code={route.code} />;
    case 'edit':
      return <EditParts key={route.code} code={route.code} />;
    default:
      return (
        <main className="page">
          <section className="stack empty">
            <h1 className="title">없는 주소예요</h1>
            <p className="lead">주소가 잘못됐거나, 방 번호가 6자리 숫자가 아니에요.</p>
            <button className="btn btn-primary btn-xl" onClick={() => navigate('/')}>
              처음으로
            </button>
          </section>
        </main>
      );
  }
}

// 자동 테스트가 저장된 소리를 앱과 같은 방법으로 풀어 볼 수 있게 열어 둔다 (테스트 훅이 있을 때만)
const testHooks = (window as unknown as { __ttbTest?: Record<string, unknown> }).__ttbTest;
if (testHooks) testHooks.lib = { decodeWithLead, getCtx, renderDemoBeat, encodeWav };

/** 예상 못 한 오류가 나도 빈 화면 대신 다시 시작할 길을 보여 준다 */
class Safety extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <main className="page">
        <section className="stack empty">
          <h1 className="title">화면을 그리다 문제가 생겼어요</h1>
          <p className="lead">저장된 녹음은 그대로 있어요. 새로 고치면 이어서 할 수 있어요.</p>
          <button className="btn btn-primary btn-xl" onClick={() => location.reload()}>
            새로 고침
          </button>
        </section>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Safety>
      <ToastProvider>
        <App />
      </ToastProvider>
    </Safety>
  </StrictMode>,
);
