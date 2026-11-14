import { useEffect, useRef } from 'react';

/** How long a +1 floats up, how far, and the sparks around it. */
const POP_MS = 750;
const POP_RISE = 26;
const SPARKS = 6;
/** Everything moves on a grid of this many pixels and fades in this many steps, as an old game draws. */
const GRID = 2;
const FADE_STEPS = 4;

interface Pop { x: number; y: number; at: number; sparks: Array<{ dx: number; dy: number }> }

const snap = (v: number) => Math.round(v / GRID) * GRID;

/**
 * Pixel's pointer effect, on one canvas over the page that never takes a
 * click: a click on a button or link shows a +1 that floats up and a few
 * square sparks flying out, moving on a coarse grid and fading in steps.
 * Nothing follows the cursor, and the canvas rests whenever nothing is on it.
 * The blinking stars behind the page are CSS (styles/pixel.css).
 */
export function PixelEffects() {
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
      c.imageSmoothingEnabled = false;
    };
    size();

    let lime = '#9be15d';
    let coin = '#ffd860';
    let font = 'monospace';
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const read = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      lime = read('--px-lime');
      coin = read('--px-coin');
      probe.remove();
      font = getComputedStyle(document.documentElement).getPropertyValue('--font-pixel').trim() || 'monospace';
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const pops: Pop[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      const sparks = Array.from({ length: SPARKS }, (_, i) => {
        const a = (i / SPARKS) * Math.PI * 2 + 0.3;
        return { dx: Math.cos(a), dy: Math.sin(a) };
      });
      pops.push({ x: e.clientX, y: e.clientY, at: performance.now(), sparks });
      wake();
    };
    window.addEventListener('click', onClick, true);

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      c.clearRect(0, 0, W, H);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `700 13px ${font}`;
      for (let i = pops.length - 1; i >= 0; i--) {
        const pop = pops[i] as Pop;
        const t = (now - pop.at) / POP_MS;
        if (t >= 1) {
          pops.splice(i, 1);
          continue;
        }
        // Fades in a few hard steps rather than smoothly.
        const alpha = Math.ceil((1 - t) * FADE_STEPS) / FADE_STEPS;
        const rise = snap(POP_RISE * (1 - (1 - t) ** 2));
        c.globalAlpha = alpha;
        c.fillStyle = coin;
        c.fillText('+1', snap(pop.x + 10), snap(pop.y - 12 - rise));
        c.fillStyle = lime;
        const reach = 6 + 16 * Math.min(1, t * 1.6);
        const s = t < 0.5 ? 4 : 2;
        for (const sp of pop.sparks) c.fillRect(snap(pop.x + sp.dx * reach) - s / 2, snap(pop.y + sp.dy * reach) - s / 2, s, s);
      }
      c.globalAlpha = 1;
      if (pops.length) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      pops.length = 0;
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
