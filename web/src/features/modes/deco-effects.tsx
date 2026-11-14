import { useEffect, useRef } from 'react';

/** How long a fan of lines rises and fades, how long its rays grow, and how many there are. */
const FAN_MS = 900;
const FAN_LENGTH = 30;
const RAYS = 7;

interface Fan { x: number; y: number; at: number }

/**
 * Art Deco's pointer effect, on one canvas over the page that never takes a
 * click: a click on a button or link sends up a thin gold fan of lines, a
 * half sunburst, that grows and fades. Nothing follows the cursor, and the
 * canvas rests whenever no fan is on it. The pattern and the shimmer behind
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

    const fans: Fan[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      fans.push({ x: e.clientX, y: e.clientY, at: performance.now() });
      wake();
    };
    window.addEventListener('click', onClick, true);

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      c.clearRect(0, 0, W, H);
      c.strokeStyle = gold;
      c.lineCap = 'round';
      for (let i = fans.length - 1; i >= 0; i--) {
        const fan = fans[i] as Fan;
        const t = (now - fan.at) / FAN_MS;
        if (t >= 1) {
          fans.splice(i, 1);
          continue;
        }
        const grow = 1 - (1 - Math.min(1, t * 1.8)) ** 3;
        const inner = 6 + 6 * grow;
        const outer = inner + FAN_LENGTH * grow;
        c.globalAlpha = (dark ? 0.9 : 0.8) * (t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55);
        c.lineWidth = 1.2;
        c.beginPath();
        // A half sunburst opening upward: rays from just above the click, evenly from left to right.
        for (let r = 0; r < RAYS; r++) {
          const a = Math.PI + (r / (RAYS - 1)) * Math.PI;
          c.moveTo(fan.x + Math.cos(a) * inner, fan.y + Math.sin(a) * inner);
          c.lineTo(fan.x + Math.cos(a) * outer, fan.y + Math.sin(a) * outer);
        }
        c.stroke();
        // A fine arc tying the rays together, as on a deco fan.
        c.lineWidth = 0.8;
        c.beginPath();
        c.arc(fan.x, fan.y, inner + (outer - inner) * 0.55, Math.PI, Math.PI * 2);
        c.stroke();
      }
      c.globalAlpha = 1;
      if (fans.length) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      fans.length = 0;
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
