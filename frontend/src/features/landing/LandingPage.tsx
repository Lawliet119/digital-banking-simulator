import { useEffect, useRef } from 'react';
import { Link, Navigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { Icon, type IconName } from '../../components/Icon';
import { Brand, Tag } from '../../components/ui';

const PROMISES: { icon: IconName; tone: string; title: string; text: string }[] = [
  {
    icon: 'scale',
    tone: 'in',
    title: 'Số dư luôn chính xác',
    text: 'Tiền chỉ rời tài khoản khi người nhận được cộng đủ.',
  },
  {
    icon: 'shield',
    tone: 'info',
    title: 'Không trừ tiền hai lần',
    text: 'Mạng chập chờn cũng không sao, mỗi lệnh chỉ được thực hiện một lần.',
  },
  {
    icon: 'search',
    tone: 'warn',
    title: 'Giao dịch được giám sát',
    text: 'Mọi giao dịch đều được ghi lại và theo dõi để bảo vệ bạn.',
  },
];

const STEPS = [
  ['Tra người nhận', 'Gõ số tài khoản 12 chữ số, thấy đúng tên trước khi chuyển.'],
  ['Xác nhận', 'Kiểm tra nguồn, người nhận và số tiền trên một màn hình.'],
  ['Chuyển', 'Tiền đến tài khoản người nhận trong vài giây.'],
  ['Biên lai', 'Cả hai bên nhận thông báo có số tiền và người đối ứng.'],
] as const;

/**
 * Entrance and scroll animation of the landing page. Loaded only here, and not at all for a
 * visitor who asked for reduced motion; the page reads the same without it.
 */
function useLandingMotion(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let revert: (() => void) | undefined;
    let cancelled = false;
    void Promise.all([import('gsap'), import('gsap/ScrollTrigger')]).then(
      ([{ gsap }, { ScrollTrigger }]) => {
        if (cancelled) return;
        gsap.registerPlugin(ScrollTrigger);
        const context = gsap.context(() => {
          gsap.from('.rise-in', {
            y: 40,
            opacity: 0,
            duration: 0.9,
            stagger: 0.12,
            ease: 'power4.out',
          });
          gsap.from('.phone', {
            y: 240,
            opacity: 0,
            duration: 1.2,
            delay: 0.35,
            ease: 'power4.out',
          });
          gsap.from('.float', {
            y: 100,
            opacity: 0,
            scale: 0.85,
            duration: 1.1,
            stagger: 0.15,
            delay: 0.55,
            ease: 'back.out(1.5)',
          });
          gsap.utils.toArray<HTMLElement>('.float').forEach((card, index) => {
            gsap.to(card, {
              y: index % 2 ? 14 : -14,
              duration: 3 + index * 0.5,
              delay: 2,
              yoyo: true,
              repeat: -1,
              ease: 'sine.inOut',
            });
          });
          gsap.utils.toArray<HTMLElement>('.reveal').forEach(card => {
            gsap.from(card, {
              y: 56,
              opacity: 0,
              duration: 0.8,
              ease: 'power3.out',
              scrollTrigger: { trigger: card, start: 'top 90%' },
            });
          });
        }, element);
        revert = () => context.revert();
      },
    );
    return () => {
      cancelled = true;
      revert?.();
    };
  }, [root]);
}

/** `/welcome`: the page a visitor sees before signing in. The figures on the phone are a drawing. */
export function LandingPage() {
  const { signedIn } = useAuth();
  const root = useRef<HTMLDivElement>(null);
  useLandingMotion(root);
  if (signedIn) return <Navigate to="/" replace />;

  return (
    <div className="landing" ref={root}>
      <div className="hero">
        <header className="wrap">
          <div className="pill-nav">
            <Brand />
            <nav className="row" aria-label="Trang giới thiệu" style={{ gap: '2.25rem' }}>
              <a href="#cam-ket">Cam kết</a>
              <a href="#cach-chuyen">Cách chuyển tiền</a>
            </nav>
            <Link to="/login" className="button">
              Đăng nhập
            </Link>
          </div>
        </header>
        <div className="wrap">
          <h1>
            <span className="rise-in">Chuyển tiền trong vài giây.</span>
            <span className="rise-in soft-text">Rõ từng đồng. Luôn kiểm soát.</span>
          </h1>
          <div className="cta rise-in">
            <Link to="/login" className="button">
              Chuyển tiền ngay
            </Link>
          </div>
          <div className="stage" aria-hidden="true">
            <div className="phone">
              <span className="island" />
              <div className="row nowrap">
                <span className="tile">MA</span>
                <div className="grow">
                  <div className="muted">Chào mừng quay lại,</div>
                  <b>Nguyễn Minh Anh</b>
                </div>
                <span className="tile">
                  <Icon name="bell" size={18} />
                </span>
              </div>
              <div className="card">
                <div className="muted">Tổng số dư</div>
                <div className="big">68.000.000 ₫</div>
              </div>
              <div className="balance-card">
                <div className="row between">
                  <span>Thanh toán</span>
                  <span className="mono">**** 0002</span>
                </div>
                <div className="big">48.000.000 ₫</div>
                <span>NGUYEN MINH ANH</span>
              </div>
              <div className="card row nowrap">
                <span className="tile out">
                  <Icon name="out" size={18} />
                </span>
                <div className="grow">
                  <b>Trần Thu Hà</b>
                  <div className="muted">Hôm nay</div>
                </div>
                <span className="money-out">−2.000.000</span>
              </div>
            </div>
            <div className="float row nowrap" style={{ left: '2%', top: '5rem' }}>
              <span className="tile in">
                <Icon name="in" />
              </span>
              <div>
                <div className="muted">Nhận từ Thanh Bình</div>
                <b className="money-in">+500.000 ₫</b>
              </div>
            </div>
            <div className="float col" style={{ right: '3%', top: '7rem', width: '17rem' }}>
              <div className="row between">
                <span className="muted">Trạng thái</span>
                <Tag tone="ok">Hoàn tất</Tag>
              </div>
              <div className="row between">
                <span className="muted">Số tiền</span>
                <b>2.000.000 ₫</b>
              </div>
            </div>
            <div className="float row nowrap" style={{ left: '4%', top: '21rem' }}>
              <span className="tile">TH</span>
              <div>
                <b>Trần Thu Hà</b>
                <div className="muted mono">100000000004</div>
              </div>
              <Tag tone="info">Đúng người nhận</Tag>
            </div>
          </div>
        </div>
      </div>

      <section id="cam-ket" className="wrap section">
        <h2 className="reveal">
          Yên tâm với từng giao dịch.
          <br />
          <span className="soft-text">Rõ ràng từ đầu đến cuối.</span>
        </h2>
        <div className="grid">
          {PROMISES.map(item => (
            <div key={item.title} className="panel reveal">
              <span className={`tile ${item.tone}`}>
                <Icon name={item.icon} size={22} />
              </span>
              <h3>{item.title}</h3>
              <p className="muted">{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="cach-chuyen" className="wrap section">
        <h2 className="reveal">
          Bốn bước là xong.
          <br />
          <span className="soft-text">Không có gì phải đoán.</span>
        </h2>
        <ol className="grid tight items">
          {STEPS.map(([title, text], index) => (
            <li key={title} className="panel reveal">
              <span className="step-number">{index + 1}</span>
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="wrap section final">
        <div className="balance-card reveal">
          <h2>Sẵn sàng bắt đầu?</h2>
          <Link to="/login" className="button">
            Đăng nhập
          </Link>
        </div>
        <footer className="muted">© 2026 mophong</footer>
      </section>
    </div>
  );
}
