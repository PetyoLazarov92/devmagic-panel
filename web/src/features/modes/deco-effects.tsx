import { useEffect, useRef } from 'react';

/** How long a star opens and fades, its long and short points, and how many points it has. */
const STAR_MS = 900;
const LONG_POINT = 26;
const SHORT_POINT = 12;
const POINTS = 8;

interface Star { x: number; y: number; at: number }

/**
 * Art Deco's pointer effect, on one canvas over the page that never takes a
 * click: a click on a button or link opens a gold star, four long points and
 * four short around a small diamond, that fades. Nothing follows the cursor,
 * and the canvas rests whenever no star is on it. The pattern and the shimmer behind
 * the page are CSS (styles/deco.css).
 */
export function DecoEffects() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const c = cv?.getContext('2d');
    if (!cv || !c) return;
    let W = 0;
    let H = 0;
    const size = () => {
      const r = cv.getBoundingClientRect();
      const d = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width || window.innerWidth;
      H = r.height || window.innerHeight;
      cv.width = Math.round(W * d);
      cv.height = Math.round(H * d);
      c.setTransform(d, 0, 0, d, 0, 0);
    };
    size();

    let gold = '#d4af5a';
    let dark = true;
    const read = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      probe.style.color = 'var(--dc-gold)';
      document.body.appendChild(probe);
      gold = getComputedStyle(probe).color;
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const stars: Star[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button:not([data-quiet]), a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      stars.push({ x: e.clientX, y: e.clientY, at: performance.now() });
      wake();
    };
    window.addEventListener('click', onClick, true);

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      c.clearRect(0, 0, W, H);
      c.strokeStyle = gold;
      c.fillStyle = gold;
      c.lineCap = 'round';
      c.lineWidth = 1.2;
      for (let i = stars.length - 1; i >= 0; i--) {
        const star = stars[i] as Star;
        const t = (now - star.at) / STAR_MS;
        if (t >= 1) {
          stars.splice(i, 1);
          continue;
        }
        const open = 1 - (1 - Math.min(1, t * 1.6)) ** 3;
        c.globalAlpha = (dark ? 0.9 : 0.85) * (t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55);
        // The points: long ones straight up, down and to the sides, short ones between.
        const inner = 4 + 3 * open;
        c.beginPath();
        for (let p = 0; p < POINTS; p++) {
          const a = (p / POINTS) * Math.PI * 2 - Math.PI / 2;
          const reach = inner + (p % 2 ? SHORT_POINT : LONG_POINT) * open;
          c.moveTo(star.x + Math.cos(a) * inner, star.y + Math.sin(a) * inner);
          c.lineTo(star.x + Math.cos(a) * reach, star.y + Math.sin(a) * reach);
        }
        c.stroke();
        // A small diamond at the heart.
        const d = 3 + 2 * open;
        c.beginPath();
        c.moveTo(star.x, star.y - d);
        c.lineTo(star.x + d, star.y);
        c.lineTo(star.x, star.y + d);
        c.lineTo(star.x - d, star.y);
        c.closePath();
        c.fill();
      }
      c.globalAlpha = 1;
      if (stars.length) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      stars.length = 0;
      c.clearRect(0, 0, W, H);
    };
    document.addEventListener('visibilitychange', onVisible);
    const sized = new ResizeObserver(size);
    sized.observe(cv);
    return () => {
      cancelAnimationFrame(raf);
      watch.disconnect();
      sized.disconnect();
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}
