import { useEffect, useRef } from 'react';

/** The old runes, as strokes in a 20 by 20 box centred on 0. */
const RUNES = [
  'M-3 -7V7M-3 -4L4 -7M-3 1L4 -2',
  'M-4 7V-7L4 -2V7',
  'M-3 -7V7M-3 -3L3 0L-3 3',
  'M-3 -7V7M-3 -7L4 -3M-3 -2L4 2',
  'M-3 7V-7L3 -4L-3 0L4 7',
  'M-5 -6L5 6M5 -6L-5 6',
  'M0 7V-7M0 -1L-5 -6M0 -1L5 -6',
  'M0 7V-7M-5 -2L0 -7L5 -2',
  'M-3 -7V7M-3 -7L3 -3.5L-3 0L3 3.5L-3 7',
  'M-4 7V-7L0 -3L4 -7V7',
];
/** A rune surfaces every this many pixels of the cursor's path, and fades over TRAIL_MS. */
const TRAIL_GAP = 64;
const TRAIL_MS = 2_200;
/** A click's rune flares over FLARE_MS, with a few sparks. */
const FLARE_MS = 900;
const SPARKS = 7;
/** Lightning far off: how often, and how long one flash lasts. */
const BOLT_EVERY_MS: [number, number] = [32_000, 60_000];
const BOLT_MS = 1_100;

interface Mark { x: number; y: number; at: number; rune: number; rot: number }
interface Flare { x: number; y: number; at: number; rune: number; sparks: Array<{ vx: number; vy: number }> }
interface Bolt { at: number; path: Array<[number, number]>; branch: Array<[number, number]> }

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A fork of lightning from the clouds, jagged, with one short branch. */
function makeBolt(W: number, H: number): Bolt {
  const x0 = rand(W * 0.08, W * 0.92);
  let x = x0;
  let y = rand(H * 0.02, H * 0.08);
  const end = rand(H * 0.22, H * 0.34);
  const path: Array<[number, number]> = [[x, y]];
  while (y < end) {
    x += rand(-14, 14);
    y += rand(10, 22);
    path.push([x, y]);
  }
  const from = path[Math.floor(path.length * 0.4)] ?? path[0] ?? [x0, 0];
  const branch: Array<[number, number]> = [from];
  let bx = from[0];
  let by = from[1];
  const dir = Math.random() < 0.5 ? -1 : 1;
  for (let k = 0; k < 4; k++) {
    bx += dir * rand(6, 14);
    by += rand(8, 16);
    branch.push([bx, by]);
  }
  return { at: performance.now(), path, branch };
}

/**
 * Hall of Storms' effects, on two canvases that never take a click.
 * Pointer: as the cursor moves, a rune surfaces faintly in amber every few
 * steps along its path, eases in, drifts up a little and slowly fades; a click on a button or
 * link makes a larger rune flare with a few sparks falling from it. The
 * cursor itself never changes, and nothing shows over fields and editors.
 * Background: once in a while a fork of lightning glows softly far off in
 * the sky, behind the cards, and the sky lightens a little for a moment. Nothing runs while the
 * tab is hidden, and both canvases rest when nothing is on them. The realm
 * and the great stone's glow are CSS (styles/storms.css).
 */
export function StormsEffects({ pointer, background }: { pointer: boolean; background: boolean }) {
  const skyRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const sc = skyRef.current;
    const fc = fxRef.current;
    const s = sc?.getContext('2d');
    const c = fc?.getContext('2d');
    if (!sc || !fc || !s || !c) return;
    let W = 0;
    let H = 0;
    const size = () => {
      const d = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      for (const [cv, ctx] of [[sc, s], [fc, c]] as const) {
        cv.width = Math.round(W * d);
        cv.height = Math.round(H * d);
        ctx.setTransform(d, 0, 0, d, 0, 0);
      }
    };
    size();

    let amber = '#ffb347';
    let dark = true;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      probe.style.color = 'var(--hs-amber)';
      document.body.appendChild(probe);
      amber = getComputedStyle(probe).color;
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });
    const runes = RUNES.map((d) => new Path2D(d));

    const marks: Mark[] = [];
    const flares: Flare[] = [];
    let last: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable], .cm-editor')) {
        last = null;
        return;
      }
      if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < TRAIL_GAP) return;
      last = { x: e.clientX, y: e.clientY };
      marks.push({ x: e.clientX, y: e.clientY, at: performance.now(), rune: Math.floor(Math.random() * runes.length), rot: rand(-0.15, 0.15) });
      if (marks.length > 16) marks.shift();
      wake();
    };
    const onLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) last = null;
    };
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button:not([data-quiet]), a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      const sparks = Array.from({ length: SPARKS }, () => {
        const a = -Math.PI / 2 + rand(-1.1, 1.1);
        const sp = rand(0.6, 1.7);
        return { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp };
      });
      flares.push({ x: e.clientX, y: e.clientY, at: performance.now(), rune: Math.floor(Math.random() * runes.length), sparks });
      wake();
    };
    if (pointer) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('mouseout', onLeave);
      window.addEventListener('click', onClick, true);
    }

    let bolt: Bolt | null = null;
    let boltTimer = 0;
    const scheduleBolt = () => {
      window.clearTimeout(boltTimer);
      boltTimer = window.setTimeout(() => {
        if (!document.hidden) {
          bolt = makeBolt(W, H);
          wake();
        }
        scheduleBolt();
      }, rand(BOLT_EVERY_MS[0], BOLT_EVERY_MS[1]));
    };
    if (background) scheduleBolt();

    const drawSky = (now: number) => {
      s.clearRect(0, 0, W, H);
      if (!bolt) return;
      const t = (now - bolt.at) / BOLT_MS;
      if (t >= 1) {
        bolt = null;
        return;
      }
      // A soft swell and a softer second one, then a slow fade: no hard flicker.
      const glow = Math.sin(Math.PI * Math.min(1, t / 0.3)) * (t < 0.3 ? 1 : 0) + 0.6 * Math.sin(Math.PI * Math.max(0, Math.min(1, (t - 0.25) / 0.75)));
      const flicker = Math.max(0, Math.min(1, glow));
      s.globalAlpha = (dark ? 0.035 : 0.06) * flicker;
      s.fillStyle = dark ? '#dfe9ff' : '#ffffff';
      s.fillRect(0, 0, W, H * 0.6);
      s.globalAlpha = (dark ? 0.4 : 0.32) * flicker;
      s.strokeStyle = dark ? '#e6eeff' : '#ffffff';
      s.shadowColor = dark ? '#9fb8ff' : '#c8d6f0';
      s.shadowBlur = 16;
      s.lineJoin = 'round';
      for (const [line, width] of [[bolt.path, 1.6], [bolt.branch, 1]] as const) {
        s.lineWidth = width;
        s.beginPath();
        line.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
        s.stroke();
      }
      s.shadowBlur = 0;
      s.globalAlpha = 1;
    };

    const drawRunes = (now: number) => {
      c.clearRect(0, 0, W, H);
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.strokeStyle = amber;
      c.shadowColor = amber;
      for (let i = marks.length - 1; i >= 0; i--) {
        const m = marks[i] as Mark;
        const t = (now - m.at) / TRAIL_MS;
        if (t >= 1) {
          marks.splice(i, 1);
          continue;
        }
        // Eases in and out on a slow curve, so a rune never pops on or off.
        const a = Math.sin(Math.PI * t) ** 2;
        c.save();
        c.translate(m.x, m.y - t * 4);
        c.rotate(m.rot);
        c.scale(0.85, 0.85);
        c.globalAlpha = (dark ? 0.32 : 0.36) * a;
        c.shadowBlur = dark ? 4 : 2;
        c.lineWidth = 1.5;
        c.stroke(runes[m.rune] as Path2D);
        c.restore();
      }
      for (let i = flares.length - 1; i >= 0; i--) {
        const fl = flares[i] as Flare;
        const t = (now - fl.at) / FLARE_MS;
        if (t >= 1) {
          flares.splice(i, 1);
          continue;
        }
        const a = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        c.save();
        c.translate(fl.x, fl.y);
        c.scale(1.4 + t * 0.3, 1.4 + t * 0.3);
        c.globalAlpha = a;
        c.shadowBlur = 12;
        c.lineWidth = 1.6;
        c.stroke(runes[fl.rune] as Path2D);
        c.restore();
        const frames = (t * FLARE_MS) / 16.7;
        c.save();
        c.fillStyle = amber;
        c.shadowBlur = 6;
        c.globalAlpha = a * 0.9;
        for (const sp of fl.sparks) {
          c.beginPath();
          c.arc(fl.x + sp.vx * frames, fl.y + sp.vy * frames + 0.03 * frames * frames, 1.3, 0, 6.29);
          c.fill();
        }
        c.restore();
      }
      c.globalAlpha = 1;
    };

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      if (background) drawSky(now);
      if (pointer) drawRunes(now);
      if (bolt || marks.length || flares.length) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      bolt = null;
      marks.length = 0;
      flares.length = 0;
      s.clearRect(0, 0, W, H);
      c.clearRect(0, 0, W, H);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('resize', size);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(boltTimer);
      watch.disconnect();
      window.removeEventListener('resize', size);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pointer, background]);

  return (
    <>
      <canvas ref={skyRef} aria-hidden className="pointer-events-none fixed inset-0 size-full" style={{ zIndex: -1 }} />
      <canvas ref={fxRef} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />
    </>
  );
}
