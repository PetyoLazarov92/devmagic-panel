import { useEffect, useRef } from 'react';

/** Sprinkles from one click, and the most alive at once. */
const SPRINKLES = 10;
const MAX_SPRINKLES = 80;

interface Sprinkle { x: number; y: number; vx: number; vy: number; rot: number; spin: number; life: number; max: number; color: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Sorbet's pointer effect, on one canvas over the page that never takes a
 * click: a click on a button or link pops a few sprinkles, short rounded bits
 * in the mode's four pastels, that fly out, fall a little and fade. Nothing
 * follows the cursor, and the canvas rests whenever no sprinkle is in the air.
 * The drifting blobs behind the page are CSS (styles/sorbet.css).
 */
export function SorbetEffects() {
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

    let colors = ['#7fd1b9', '#ff9bb3', '#ffe08a', '#c8a8f0'];
    let dark = true;
    const read = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      colors = ['--sb-mint', '--sb-berry', '--sb-lemon', '--sb-lilac'].map((name) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      });
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const sprinkles: Sprinkle[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      for (let i = 0; i < SPRINKLES; i++) {
        if (sprinkles.length >= MAX_SPRINKLES) sprinkles.shift();
        const a = rand(-Math.PI * 0.9, -Math.PI * 0.1);
        const sp = rand(1.2, 2.6);
        sprinkles.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, rot: rand(0, 6.28), spin: rand(-0.15, 0.15), life: rand(650, 950), max: 950, color: i % 4 });
      }
      wake();
    };
    window.addEventListener('click', onClick, true);

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(60, now - last) : 16.7;
      last = now;
      const k = dt / 16.7;
      c.clearRect(0, 0, W, H);
      c.lineCap = 'round';
      c.lineWidth = 3;
      for (let i = sprinkles.length - 1; i >= 0; i--) {
        const s = sprinkles[i] as Sprinkle;
        s.life -= dt;
        if (s.life <= 0) {
          sprinkles.splice(i, 1);
          continue;
        }
        s.vy += 0.08 * k;
        s.vx *= Math.pow(0.98, k);
        s.x += s.vx * k;
        s.y += s.vy * k;
        s.rot += s.spin * k;
        const dx = Math.cos(s.rot) * 3.5;
        const dy = Math.sin(s.rot) * 3.5;
        c.globalAlpha = (dark ? 0.95 : 0.85) * Math.min(1, s.life / 350);
        c.strokeStyle = colors[s.color] ?? '#ff9bb3';
        c.beginPath();
        c.moveTo(s.x - dx, s.y - dy);
        c.lineTo(s.x + dx, s.y + dy);
        c.stroke();
      }
      c.globalAlpha = 1;
      if (sprinkles.length) raf = requestAnimationFrame(frame);
      else last = 0;
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      sprinkles.length = 0;
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
