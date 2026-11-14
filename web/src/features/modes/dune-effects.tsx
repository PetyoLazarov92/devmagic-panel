import { useEffect, useRef } from 'react';

/** Grains let fall behind a moving cursor: at most this many at once, one every this many pixels moved. */
const MAX_GRAINS = 90;
const GRAIN_EVERY_PX = 9;
/** A drift of sand across the page: how often one starts, how long it blows, and how many grains it carries. */
const DRIFT_EVERY_MS: [number, number] = [16_000, 26_000];
const DRIFT_MS = 4_500;
const DRIFT_GRAINS = 70;
/** While only a drift blows, 30 frames a second is plenty; the cursor's grains get every frame. */
const CALM_FRAME_MS = 33;
const LIVELY_MS = 900;

interface Grain { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; warm: boolean }

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Dune's effects, on one canvas over the page that never takes a click.
 * Pointer: a few grains of sand fall behind a moving cursor and fade; a
 * resting cursor leaves nothing. Background: now and then a thin drift of sand
 * blows across the page for a few seconds (the warm haze is CSS,
 * styles/dune.css). Nothing runs while the tab is hidden, and the canvas rests
 * whenever no grain is in the air.
 */
export function DuneEffects({ pointer, background }: { pointer: boolean; background: boolean }) {
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

    let sand = '#e2955a';
    let gold = '#f0b45a';
    let dark = true;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const read = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      sand = read('--du-sand');
      gold = read('--du-sun');
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const grains: Grain[] = [];
    let last: { x: number; y: number } | undefined;
    let livelyUntil = 0;
    let driftUntil = 0;
    let driftY = 0;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable], .cm-editor')) {
        last = undefined;
        return;
      }
      const p = { x: e.clientX, y: e.clientY };
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < GRAIN_EVERY_PX) return;
      last = p;
      if (grains.length >= MAX_GRAINS) grains.shift();
      grains.push({ x: p.x + rand(-3, 3), y: p.y + rand(-2, 2), vx: rand(-0.25, 0.25), vy: rand(0.15, 0.5), life: rand(500, 900), max: 900, r: rand(0.7, 1.5), warm: Math.random() < 0.7 });
      livelyUntil = performance.now() + LIVELY_MS;
      wake();
    };
    const onLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) last = undefined;
    };
    if (pointer) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('mouseout', onLeave);
    }

    let raf = 0;
    let lastFrame = 0;
    let driftTimer = 0;
    const frame = (now: number) => {
      raf = 0;
      if (lastFrame && now >= livelyUntil && now - lastFrame < CALM_FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = lastFrame ? Math.min(60, now - lastFrame) : 16.7;
      lastFrame = now;
      const k = dt / 16.7;
      c.clearRect(0, 0, W, H);

      // A drift: grains blow in from the left in a thin band, for a few seconds.
      if (background && now < driftUntil) {
        const share = DRIFT_GRAINS / (DRIFT_MS / 16.7);
        for (let n = share * k; n > 0; n--) {
          if (n < 1 && Math.random() > n) break;
          grains.push({ x: -6, y: driftY + rand(-26, 26), vx: rand(2.2, 3.6), vy: rand(-0.12, 0.12), life: 8_000, max: 8_000, r: rand(0.5, 1.2), warm: Math.random() < 0.5 });
        }
      }
      for (let i = grains.length - 1; i >= 0; i--) {
        const g = grains[i] as Grain;
        g.life -= dt;
        g.x += g.vx * k;
        g.y += g.vy * k;
        if (g.max < 2_000) g.vy += 0.012 * k;
        else g.y += Math.sin((g.x + i * 13) / 60) * 0.15 * k;
        if (g.life <= 0 || g.x > W + 10 || g.y > H + 10) {
          grains.splice(i, 1);
          continue;
        }
        const fade = g.max < 2_000 ? Math.min(1, g.life / 450) : Math.min(1, g.life / 900, (W - g.x) / 120 + 0.2);
        c.globalAlpha = (dark ? 0.75 : 0.6) * Math.max(0, fade);
        c.fillStyle = g.warm ? sand : gold;
        c.fillRect(g.x, g.y, g.r * 1.6, g.r * 1.6);
      }
      c.globalAlpha = 1;
      if (grains.length || now < driftUntil) raf = requestAnimationFrame(frame);
      else lastFrame = 0;
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    // The next drift, timed apart from the frames so a quiet page draws nothing in between.
    const schedule = (wait: number) => {
      driftTimer = window.setTimeout(() => {
        if (!document.hidden) {
          driftY = rand(H * 0.25, H * 0.85);
          driftUntil = performance.now() + DRIFT_MS;
          wake();
        }
        schedule(rand(DRIFT_EVERY_MS[0], DRIFT_EVERY_MS[1]));
      }, wait);
    };
    if (background) schedule(rand(6_000, 12_000));
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
      grains.length = 0;
      driftUntil = 0;
      c.clearRect(0, 0, W, H);
    };
    document.addEventListener('visibilitychange', onVisible);
    const sized = new ResizeObserver(size);
    sized.observe(cv);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(driftTimer);
      watch.disconnect();
      sized.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseout', onLeave);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pointer, background]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}
