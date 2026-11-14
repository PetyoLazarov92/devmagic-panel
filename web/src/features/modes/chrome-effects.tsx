import { useEffect, useRef } from 'react';

/** How long a ripple runs, how far it spreads, and the droplets that splash from it. */
const RIPPLE_MS = 850;
const RIPPLE_RADIUS = 28;
const DROPLETS = 4;

interface Ripple { x: number; y: number; at: number; drops: Array<{ vx: number; vy: number; r: number }> }

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A small chrome bead: a highlight up and to the left, drawn once into an image every frame reuses. */
function beadSprite(hi: string, mid: string, lo: string): HTMLCanvasElement {
  const s = document.createElement('canvas');
  s.width = s.height = 24;
  const g = s.getContext('2d');
  if (!g) return s;
  const grad = g.createRadialGradient(8.5, 7.5, 0.5, 12, 12, 12);
  grad.addColorStop(0, hi);
  grad.addColorStop(0.38, mid);
  grad.addColorStop(1, lo);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(12, 12, 11.5, 0, 6.29);
  g.fill();
  return s;
}

/**
 * Chrome's pointer effect, on one canvas over the page that never takes a
 * click: a click on a button or link sends a silver ripple out, two rings with
 * a bright edge like a drop into mercury, and a few chrome droplets splash
 * from it and fall. Nothing follows the cursor, and the canvas rests whenever
 * nothing is on it. The drifting light behind the page is CSS
 * (styles/chrome.css).
 */
export function ChromeEffects() {
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

    let silver = '#c8d2de';
    let bead = beadSprite('#ffffff', '#b8c2ce', '#3a4049');
    let dark = true;
    const read = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const get = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      silver = get('--cr-silver');
      bead = beadSprite(get('--cr-hi'), get('--cr-mid'), get('--cr-lo'));
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const ripples: Ripple[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      const drops = Array.from({ length: DROPLETS }, () => {
        const a = rand(-Math.PI * 0.85, -Math.PI * 0.15);
        const sp = rand(1.1, 2.2);
        return { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: rand(2.2, 3.6) };
      });
      ripples.push({ x: e.clientX, y: e.clientY, at: performance.now(), drops });
      wake();
    };
    window.addEventListener('click', onClick, true);

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      c.clearRect(0, 0, W, H);
      for (let i = ripples.length - 1; i >= 0; i--) {
        const rp = ripples[i] as Ripple;
        const t = (now - rp.at) / RIPPLE_MS;
        if (t >= 1) {
          ripples.splice(i, 1);
          continue;
        }
        // Two rings, the second a beat behind, each with a soft wide edge and a bright thin one.
        for (let k = 0; k < 2; k++) {
          const tk = Math.max(0, Math.min(1, (t - k * 0.18) / 0.82));
          if (tk <= 0) continue;
          const r = 3 + RIPPLE_RADIUS * (1 - (1 - tk) ** 3) * (k ? 0.7 : 1);
          const fade = 1 - tk;
          c.strokeStyle = silver;
          c.globalAlpha = (dark ? 0.22 : 0.18) * fade;
          c.lineWidth = 5;
          c.beginPath();
          c.arc(rp.x, rp.y, r, 0, 6.29);
          c.stroke();
          c.globalAlpha = (dark ? 0.85 : 0.7) * fade;
          c.lineWidth = 1.2;
          c.beginPath();
          c.arc(rp.x, rp.y, r, 0, 6.29);
          c.stroke();
        }
        // The droplets: thrown up and out, falling back, gone by the end.
        const ms = t * RIPPLE_MS;
        c.globalAlpha = Math.min(1, (1 - t) * 1.6) * (dark ? 1 : 0.9);
        for (const dp of rp.drops) {
          const x = rp.x + dp.vx * (ms / 16.7);
          const y = rp.y + dp.vy * (ms / 16.7) + 0.5 * 0.07 * (ms / 16.7) ** 2;
          c.drawImage(bead, x - dp.r, y - dp.r, dp.r * 2, dp.r * 2);
        }
      }
      c.globalAlpha = 1;
      if (ripples.length) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      ripples.length = 0;
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
