import { useEffect, useRef } from 'react';

/** How long a point of the light trail stays, fading as it goes. */
const TRAIL_MS = 260;
/** A ring from a click: how long it grows, and how wide it gets. */
const RING_MS = 520;
const RING_RADIUS = 30;

interface Point { x: number; y: number; at: number }
interface Ring { x: number; y: number; at: number }

/**
 * Neon's pointer effect, on one canvas over the page that never takes a click:
 * a short light trail behind the cursor (the cursor itself stays), magenta at
 * the cursor fading to sunset orange, and a ring of light from a click on a
 * button or link. Nothing follows a cursor that rests, the trail hides over
 * fields and editors, and the canvas rests whenever nothing is lit. The grid
 * and the stars behind the page are CSS (styles/neon.css).
 */
export function NeonEffects() {
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

    let pink = '#ff4fd8';
    let sunset = '#ff9a3c';
    let dark = true;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const read = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      pink = read('--nn-pink');
      sunset = read('--nn-sunset');
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const points: Point[] = [];
    const rings: Ring[] = [];
    let hide = false;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = e.target instanceof Element ? e.target : null;
      hide = Boolean(el?.closest('input, textarea, select, [contenteditable], .cm-editor'));
      if (hide) points.length = 0;
      else points.push({ x: e.clientX, y: e.clientY, at: performance.now() });
      wake();
    };
    const onLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) points.length = 0;
    };
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      rings.push({ x: e.clientX, y: e.clientY, at: performance.now() });
      wake();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('mouseout', onLeave);
    window.addEventListener('click', onClick, true);

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      c.clearRect(0, 0, W, H);
      while (points.length && now - (points[0] as Point).at > TRAIL_MS) points.shift();
      c.lineCap = 'round';
      c.lineJoin = 'round';
      // The trail, segment by segment: older is thinner, fainter and more orange.
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1] as Point;
        const b = points[i] as Point;
        const life = 1 - (now - b.at) / TRAIL_MS;
        if (life <= 0) continue;
        c.strokeStyle = life > 0.5 ? pink : sunset;
        c.globalAlpha = (dark ? 0.22 : 0.16) * life;
        c.lineWidth = 7 * life + 1;
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        c.globalAlpha = (dark ? 0.85 : 0.65) * life;
        c.lineWidth = 2 * life + 0.5;
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i] as Ring;
        const t = (now - ring.at) / RING_MS;
        if (t >= 1) {
          rings.splice(i, 1);
          continue;
        }
        const r = 4 + RING_RADIUS * (1 - (1 - t) ** 3);
        c.strokeStyle = pink;
        c.globalAlpha = (dark ? 0.25 : 0.18) * (1 - t);
        c.lineWidth = 6;
        c.beginPath();
        c.arc(ring.x, ring.y, r, 0, 6.29);
        c.stroke();
        c.strokeStyle = t < 0.5 ? pink : sunset;
        c.globalAlpha = (dark ? 0.9 : 0.7) * (1 - t);
        c.lineWidth = 1.6;
        c.beginPath();
        c.arc(ring.x, ring.y, r, 0, 6.29);
        c.stroke();
      }
      c.globalAlpha = 1;
      // Rest once nothing is lit; the next move or click wakes it.
      if (points.length > 1 || rings.length) raf = requestAnimationFrame(frame);
      else c.clearRect(0, 0, W, H);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      points.length = 0;
      rings.length = 0;
      c.clearRect(0, 0, W, H);
    };
    document.addEventListener('visibilitychange', onVisible);
    const sized = new ResizeObserver(size);
    sized.observe(cv);
    return () => {
      cancelAnimationFrame(raf);
      watch.disconnect();
      sized.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}
