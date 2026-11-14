import { useEffect, useRef } from 'react';

/** Grid step of the board's traces, in CSS pixels. */
const STEP = 14;
const MAX_TRACES = 140;
const MAX_PULSES = 10;
/** A new pulse at most this often; the board is drawn at 30 frames a second. */
const PULSE_EVERY_MS = 300;
const FRAME_MS = 33;
/** How much of the way to the cursor the reticle goes each frame (at 60 a second). */
const FOLLOW = 0.5;
const LIVELY_MS = 900;
/** The lock closes only on a compact control; a wide row or a big panel keeps the reticle. */
const LOCK_MAX_W = 320;
const LOCK_MAX_H = 64;
/** How much of the way the brackets go each frame: they land on a new control almost at once. */
const LOCK_FOLLOW = 0.6;

const DIRS: Array<[number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
function rgba(color: string, alpha: number): string {
  const m = color.match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color;
}

/** Reads the mode's tokens as colors a canvas takes, again when the theme or mode changes. */
function useTokenReader(names: string[], onChange: () => void) {
  useEffect(() => {
    const watch = new MutationObserver(onChange);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });
    return () => watch.disconnect();
  }, [onChange]);
  return () => {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const out = Object.fromEntries(names.map((n) => {
      probe.style.color = `var(${n})`;
      return [n, getComputedStyle(probe).color];
    }));
    probe.remove();
    return out as Record<string, string>;
  };
}

function fit(cv: HTMLCanvasElement): { c: CanvasRenderingContext2D; W: number; H: number } | null {
  const c = cv.getContext('2d');
  if (!c) return null;
  const d = Math.min(window.devicePixelRatio || 1, 2);
  // The canvas's own size on screen: the window less its scrollbar, so what is drawn lines up with the page.
  const r = cv.getBoundingClientRect();
  const W = r.width || window.innerWidth;
  const H = r.height || window.innerHeight;
  cv.width = Math.round(W * d);
  cv.height = Math.round(H * d);
  c.setTransform(d, 0, 0, d, 0, 0);
  return { c, W, H };
}

interface Trace { pts: Array<[number, number]>; seg: number[]; len: number }

/** Straight runs with 45-degree bends on a grid, each ending in a pad, never crossing another. */
function layTraces(W: number, H: number): Trace[] {
  const used = new Set<string>();
  const key = (x: number, y: number) => `${Math.round(x / STEP)},${Math.round(y / STEP)}`;
  const blocked = (x: number, y: number) => x < 4 || y < 4 || x > W - 4 || y > H - 4 || used.has(key(x, y));
  const traces: Trace[] = [];
  const want = Math.min(MAX_TRACES, Math.round((W * H) / 9000));
  for (let tries = 0; tries < want * 4 && traces.length < want; tries++) {
    let x = Math.round(rand(8, W - 8) / STEP) * STEP;
    let y = Math.round(rand(8, H - 8) / STEP) * STEP;
    if (blocked(x, y)) continue;
    let di = Math.floor(Math.random() * 4) * 2;
    const pts: Array<[number, number]> = [[x, y]];
    used.add(key(x, y));
    let diag = 0;
    let back = 0;
    let steps = 0;
    const max = 6 + Math.floor(Math.random() * 26);
    while (steps < max) {
      if (diag > 0) {
        diag--;
        if (diag === 0) {
          di = (di + back + 8) % 8;
          pts.push([x, y]);
        }
      } else if (steps > 2 && Math.random() < 0.14) {
        const s = Math.random() < 0.5 ? 1 : -1;
        di = (di + s + 8) % 8;
        back = -s;
        diag = 1 + Math.floor(Math.random() * 3);
        pts.push([x, y]);
      }
      const dir = DIRS[di] as [number, number];
      const nx = x + dir[0] * STEP;
      const ny = y + dir[1] * STEP;
      if (blocked(nx, ny)) break;
      used.add(key(nx, ny));
      x = nx;
      y = ny;
      steps++;
    }
    pts.push([x, y]);
    if (steps < 4) continue;
    const seg: number[] = [];
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as [number, number];
      const b = pts[i] as [number, number];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      seg.push(d);
      len += d;
    }
    traces.push({ pts, seg, len });
  }
  return traces;
}

function pointOn(t: Trace, d: number): [number, number] {
  if (d <= 0) return t.pts[0] as [number, number];
  for (let i = 0; i < t.seg.length; i++) {
    const s = t.seg[i] as number;
    if (d <= s) {
      const p = t.pts[i] as [number, number];
      const q = t.pts[i + 1] as [number, number];
      const f = s ? d / s : 0;
      return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
    }
    d -= s;
  }
  return t.pts[t.pts.length - 1] as [number, number];
}

/**
 * Circuit's board: traces and pads laid once per window size on a canvas
 * fixed behind the pages, so the glass panels sit on it and it shows between
 * them. With the Background effect on, light pulses run along the traces;
 * off, the board stays still and is drawn only once.
 */
export function CircuitBoard({ animate }: { animate: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const redraw = useRef<() => void>(() => undefined);
  const read = useTokenReader(['--ck-trace', '--ck-pad', '--primary'], () => redraw.current());

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let g = fit(cv);
    let traces: Trace[] = [];
    let board: HTMLCanvasElement | null = null;
    let col = read();
    const paintBoard = () => {
      if (!g) return;
      board = document.createElement('canvas');
      board.width = cv.width;
      board.height = cv.height;
      const b = board.getContext('2d');
      if (!b) return;
      const d = cv.width / g.W;
      b.setTransform(d, 0, 0, d, 0, 0);
      b.lineWidth = 1.2;
      b.lineJoin = 'round';
      b.lineCap = 'round';
      b.strokeStyle = col['--ck-trace'] ?? '';
      b.fillStyle = col['--ck-pad'] ?? '';
      for (const t of traces) {
        b.beginPath();
        const [x0, y0] = t.pts[0] as [number, number];
        b.moveTo(x0, y0);
        for (const [x, y] of t.pts.slice(1)) b.lineTo(x, y);
        b.stroke();
        for (const [x, y] of [t.pts[0], t.pts[t.pts.length - 1]] as Array<[number, number]>) {
          b.beginPath();
          b.arc(x, y, 2.4, 0, 6.29);
          b.fill();
        }
      }
    };
    const pulses: Array<{ t: Trace; d: number; v: number }> = [];
    const draw = () => {
      if (!g) return;
      const { c } = g;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      if (board) c.drawImage(board, 0, 0);
      const d = cv.width / g.W;
      c.setTransform(d, 0, 0, d, 0, 0);
      const light = col['--primary'] ?? '';
      for (const p of pulses) {
        for (let k = 6; k >= 0; k--) {
          const a = pointOn(p.t, p.d - k * 4);
          const b2 = pointOn(p.t, p.d - (k + 1) * 4);
          c.strokeStyle = rgba(light, (1 - k / 7) * 0.7);
          c.lineWidth = 1.8;
          c.beginPath();
          c.moveTo(b2[0], b2[1]);
          c.lineTo(a[0], a[1]);
          c.stroke();
        }
        const h = pointOn(p.t, p.d);
        const glow = c.createRadialGradient(h[0], h[1], 0, h[0], h[1], 8);
        glow.addColorStop(0, rgba(light, 0.75));
        glow.addColorStop(1, rgba(light, 0));
        c.fillStyle = glow;
        c.beginPath();
        c.arc(h[0], h[1], 8, 0, 6.29);
        c.fill();
      }
    };
    const build = () => {
      g = fit(cv);
      if (!g) return;
      traces = layTraces(g.W, g.H);
      pulses.length = 0;
      paintBoard();
      draw();
    };
    redraw.current = () => {
      col = read();
      paintBoard();
      draw();
    };
    build();

    let raf = 0;
    let last = 0;
    let spawnAt = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (last && now - last < FRAME_MS) return;
      const dt = last ? Math.min(80, now - last) : FRAME_MS;
      last = now;
      if (now - spawnAt > PULSE_EVERY_MS && pulses.length < MAX_PULSES && traces.length) {
        spawnAt = now;
        const t = traces[Math.floor(Math.random() * traces.length)] as Trace;
        pulses.push({ t, d: 0, v: rand(0.06, 0.12) });
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i] as { t: Trace; d: number; v: number };
        p.d += p.v * dt;
        if (p.d - 30 > p.t.len) pulses.splice(i, 1);
      }
      draw();
    };
    const start = () => {
      if (animate && !raf && !document.hidden) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisible = () => (document.hidden ? stop() : start());
    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(build, 150);
    };
    document.addEventListener('visibilitychange', onVisible);
    // A scrollbar that comes or goes changes the canvas, not the window: watch the canvas.
    const sized = new ResizeObserver(onResize);
    sized.observe(cv);
    start();
    return () => {
      stop();
      window.clearTimeout(resizeTimer);
      document.removeEventListener('visibilitychange', onVisible);
      sized.disconnect();
    };
    // Only `animate` starts the board over; the colors come through redraw.
  }, [animate]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 -z-10 size-full" />;
}

/**
 * Circuit's pointer: a reticle of turning arcs on the cursor's tip (the cursor
 * itself stays), four brackets that lock onto the button, link or control you
 * point at, and two rings that spread from a click. It hides over text fields,
 * rests when the cursor leaves the window, and never runs on a touch screen.
 */
export function CircuitPointer() {
  const ref = useRef<HTMLCanvasElement>(null);
  const read = useTokenReader(['--primary'], () => undefined);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !window.matchMedia('(hover: hover)').matches) return;
    let g = fit(cv);
    let light = read()['--primary'] ?? '';
    const recolor = new MutationObserver(() => {
      light = read()['--primary'] ?? '';
    });
    recolor.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const target = { x: 0, y: 0 };
    const ret = { x: 0, y: 0, seen: false };
    let inside = false;
    let hide = false;
    let lockEl: Element | null = null;
    let box: { x: number; y: number; w: number; h: number } | null = null;
    let rot = 0;
    let livelyUntil = 0;
    const rings: Array<{ x: number; y: number; life: number; max: number; to: number }> = [];

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      target.x = e.clientX;
      target.y = e.clientY;
      if (!ret.seen) {
        ret.x = target.x;
        ret.y = target.y;
        ret.seen = true;
      }
      inside = true;
      livelyUntil = performance.now() + LIVELY_MS;
      const el = e.target instanceof Element ? e.target : null;
      hide = Boolean(el?.closest('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable], .cm-editor'));
      const control = hide ? null : (el?.closest('button, a[href], [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="option"], [role="menuitem"]') ?? null);
      const size = control?.getBoundingClientRect();
      lockEl = control && size && size.width <= LOCK_MAX_W && size.height <= LOCK_MAX_H ? control : null;
      wake();
    };
    const onLeave = (e: MouseEvent) => {
      if (e.relatedTarget) return;
      inside = false;
      lockEl = null;
      box = null;
      wake();
    };
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      rings.push({ x: e.clientX, y: e.clientY, life: 520, max: 520, to: 30 }, { x: e.clientX, y: e.clientY, life: 760, max: 760, to: 52 });
      if (rings.length > 8) rings.splice(0, rings.length - 8);
      livelyUntil = performance.now() + LIVELY_MS;
      wake();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('mouseout', onLeave);
    window.addEventListener('click', onClick, true);

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = 0;
      if (!g) return;
      const calm = now >= livelyUntil;
      if (last && calm && now - last < FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? Math.min(60, now - last) : 16.7;
      last = now;
      const k = dt / 16.7;
      const { c, W, H } = g;
      c.clearRect(0, 0, W, H);
      const step = 1 - Math.pow(1 - FOLLOW, k);
      ret.x += (target.x - ret.x) * step;
      ret.y += (target.y - ret.y) * step;
      rot += 0.03 * k;
      c.strokeStyle = light;
      c.lineWidth = 1.5;
      if (inside && !hide) {
        const r = lockEl?.getBoundingClientRect();
        const goal = r && r.width > 0 ? { x: r.left - 3, y: r.top - 3, w: r.width + 6, h: r.height + 6 } : { x: ret.x - 13, y: ret.y - 13, w: 26, h: 26 };
        if (!box) box = { ...goal };
        const s = 1 - Math.pow(1 - LOCK_FOLLOW, k);
        box.x += (goal.x - box.x) * s;
        box.y += (goal.y - box.y) * s;
        box.w += (goal.w - box.w) * s;
        box.h += (goal.h - box.h) * s;
        if (lockEl) {
          // Locked: four brackets close around the control.
          // On whole pixels (plus a half, for a crisp line), so the brackets meet the control's edges cleanly.
          const L = 7;
          const x0 = Math.round(box.x) + 0.5;
          const y0 = Math.round(box.y) + 0.5;
          const x1 = Math.round(box.x + box.w) - 0.5;
          const y1 = Math.round(box.y + box.h) - 0.5;
          c.globalAlpha = 0.85;
          c.beginPath();
          c.moveTo(x0, y0 + L); c.lineTo(x0, y0); c.lineTo(x0 + L, y0);
          c.moveTo(x1 - L, y0); c.lineTo(x1, y0); c.lineTo(x1, y0 + L);
          c.moveTo(x1, y1 - L); c.lineTo(x1, y1); c.lineTo(x1 - L, y1);
          c.moveTo(x0 + L, y1); c.lineTo(x0, y1); c.lineTo(x0, y1 - L);
          c.stroke();
        } else {
          // Free: four turning arcs around the tip, and three fainter ones further out turning the other way.
          c.globalAlpha = 0.8;
          for (let i = 0; i < 4; i++) {
            const a0 = rot + (i * Math.PI) / 2 + 0.3;
            c.beginPath();
            c.arc(ret.x, ret.y, 12, a0, a0 + Math.PI / 2 - 0.6);
            c.stroke();
          }
          c.globalAlpha = 0.35;
          for (let j = 0; j < 3; j++) {
            const a1 = -rot * 1.4 + (j * Math.PI * 2) / 3;
            c.beginPath();
            c.arc(ret.x, ret.y, 18, a1, a1 + 0.5);
            c.stroke();
          }
        }
      }
      for (let n = rings.length - 1; n >= 0; n--) {
        const q = rings[n] as { x: number; y: number; life: number; max: number; to: number };
        q.life -= dt;
        if (q.life <= 0) {
          rings.splice(n, 1);
          continue;
        }
        const t = 1 - q.life / q.max;
        c.globalAlpha = (1 - t) * 0.7;
        c.beginPath();
        c.arc(q.x, q.y, 4 + t * q.to, 0, 6.29);
        c.stroke();
      }
      c.globalAlpha = 1;
      // Out of the window with no rings left: rest until the cursor is back.
      if (inside || rings.length) raf = requestAnimationFrame(frame);
      else last = 0;
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      } else wake();
    };
    const onResize = () => {
      g = fit(cv);
    };
    document.addEventListener('visibilitychange', onVisible);
    const sized = new ResizeObserver(onResize);
    sized.observe(cv);
    return () => {
      cancelAnimationFrame(raf);
      recolor.disconnect();
      sized.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}

/** The glint's sweep (styles/circuit.css) and how far apart two are. */
const GLINT_MS = 2400;
const GLINT_EVERY_MS: [number, number] = [10_000, 20_000];

/**
 * Circuit's glint: now and then a soft band of light passes slowly over one
 * card you can see, as light catching glass. It marks the card with
 * data-glint for one sweep; the sweep itself is CSS. Nothing runs while the
 * tab is hidden.
 */
export function CircuitGlint() {
  useEffect(() => {
    let timer = 0;
    let lit: Element | null = null;
    const next = () => {
      const [min, max] = GLINT_EVERY_MS;
      timer = window.setTimeout(glint, min + Math.random() * (max - min));
    };
    const glint = () => {
      if (!document.hidden) {
        const H = window.innerHeight;
        const seen = [...document.querySelectorAll('[data-ui="card"]')].filter((el) => {
          if (el.closest('dialog')) return false;
          const r = el.getBoundingClientRect();
          return r.width > 120 && r.top < H && r.bottom > 0;
        });
        lit = seen[Math.floor(Math.random() * seen.length)] ?? null;
        lit?.setAttribute('data-glint', '');
        const done = lit;
        window.setTimeout(() => done?.removeAttribute('data-glint'), GLINT_MS + 100);
      }
      next();
    };
    next();
    return () => {
      window.clearTimeout(timer);
      lit?.removeAttribute('data-glint');
    };
  }, []);
  return null;
}
