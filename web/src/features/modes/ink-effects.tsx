import { useEffect, useRef } from 'react';

/** How long a drop of ink spreads and fades, and how far it spreads. */
const DROP_MS = 1100;
const DROP_RADIUS = 16;
/** The blots one drop is made of, around its middle, so its edge is uneven. */
const BLOTS = 6;

interface Drop { x: number; y: number; at: number; blots: Array<{ dx: number; dy: number; r: number }> }

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Ink's pointer effect, on one canvas over the page that never takes a click:
 * a click on a button or link leaves a drop of ink that spreads for a moment,
 * its edge uneven, and fades. Nothing follows the cursor, and the canvas rests
 * whenever no drop is on it. The paper grain and the wash behind the page are
 * CSS (styles/ink.css).
 */
export function InkEffects() {
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

    let ink = '#1c1a17';
    let dark = false;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      probe.style.color = 'var(--ik-ink)';
      document.body.appendChild(probe);
      ink = getComputedStyle(probe).color;
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const drops: Drop[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      const blots = Array.from({ length: BLOTS }, (_, i) => {
        const a = (i / BLOTS) * Math.PI * 2 + rand(-0.4, 0.4);
        const d = rand(0.25, 0.5);
        return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: rand(0.45, 0.7) };
      });
      drops.push({ x: e.clientX, y: e.clientY, at: performance.now(), blots });
      wake();
    };
    window.addEventListener('click', onClick, true);

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      c.clearRect(0, 0, W, H);
      c.fillStyle = ink;
      for (let i = drops.length - 1; i >= 0; i--) {
        const drop = drops[i] as Drop;
        const t = (now - drop.at) / DROP_MS;
        if (t >= 1) {
          drops.splice(i, 1);
          continue;
        }
        // Spreads fast, then slows, as ink does on paper; fades over the second half.
        const spread = DROP_RADIUS * (0.35 + 0.65 * (1 - (1 - t) ** 3));
        const fade = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
        c.globalAlpha = (dark ? 0.22 : 0.26) * fade;
        c.beginPath();
        c.arc(drop.x, drop.y, spread * 0.6, 0, 6.29);
        for (const b of drop.blots) {
          c.moveTo(drop.x + b.dx * spread + b.r * spread, drop.y + b.dy * spread);
          c.arc(drop.x + b.dx * spread, drop.y + b.dy * spread, b.r * spread, 0, 6.29);
        }
        c.fill();
        // A darker heart where the drop fell.
        c.globalAlpha = (dark ? 0.3 : 0.35) * fade;
        c.beginPath();
        c.arc(drop.x, drop.y, spread * 0.3, 0, 6.29);
        c.fill();
      }
      c.globalAlpha = 1;
      if (drops.length) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      drops.length = 0;
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
