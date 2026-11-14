import { useEffect, useRef } from 'react';
import { CircuitBoard, CircuitGlint, CircuitPointer } from '@/features/modes/circuit-effects';
import { ForgeEffects } from '@/features/modes/forge-effects';
import { GroveEffects } from '@/features/modes/grove-effects';
import { AbyssEffects } from '@/features/modes/abyss-effects';
import { NeonEffects } from '@/features/modes/neon-effects';
import { InkEffects } from '@/features/modes/ink-effects';
import { DuneEffects } from '@/features/modes/dune-effects';
import { PixelEffects } from '@/features/modes/pixel-effects';
import { useActiveMode } from '@/lib/modes';

/** The most particles alive at once, so a long drag never piles them up. */
const MAX_PARTS = 180;
const MOTES = 16;
/** A rising ember from a broken site's card, at most this often. */
const EMBER_MS = 220;
/** While only motes and embers drift, 30 frames a second is plenty; the pointer and a click's stars get every frame. */
const CALM_FRAME_MS = 33;
/** Where the wisp sits from the cursor's tip: right on the point, where a click lands. */
const ARROW_X = 0;
const ARROW_Y = 0;
/** How much of the way to the cursor the wisp goes each frame (at 60 a second): quick, and it never overshoots. */
const FOLLOW = 0.5;
/** The same while it drifts on its own loop, which moves smoothly already. */
const DRIFT_FOLLOW = 0.08;
const LIVELY_MS = 900;

interface Part { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; c: string; tw: number; drag: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function rgba(color: string, alpha: number): string {
  const m = color.match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color;
}

/** A four-pointed star with curved sides. */
function star(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const s = r * 2.4;
  c.beginPath();
  c.moveTo(x, y - s);
  c.quadraticCurveTo(x, y, x + s, y);
  c.quadraticCurveTo(x, y, x, y + s);
  c.quadraticCurveTo(x, y, x - s, y);
  c.quadraticCurveTo(x, y, x, y - s);
  c.fill();
}

/**
 * The effects of the mode on screen, on one canvas over the page that never
 * takes a click. Pointer: a wisp of light follows the cursor (the cursor
 * itself stays) and leaves star dust, and a click on a button or link sends
 * out a ring of stars; with the cursor off the page the wisp drifts around on
 * its own. Background: a few faint motes drift up. Elements: a
 * broken site's card gives off embers (its glow is CSS). Nothing runs while
 * the tab is hidden, and there is no canvas at all while every effect is off.
 */
export function ModeEffects() {
  const { mode, effects, reduced } = useActiveMode();
  if (mode === 'circuit') {
    // The board is part of Circuit's look and is drawn even with every effect off; only its pulses move.
    return (
      <>
        <CircuitBoard animate={effects.background && !reduced} />
        {effects.pointer && <CircuitPointer />}
        {effects.elements && <CircuitGlint />}
      </>
    );
  }
  if (mode === 'forge') return effects.pointer || effects.background ? <ForgeEffects pointer={effects.pointer} background={effects.background} /> : null;
  if (mode === 'grove') return effects.pointer || effects.background ? <GroveEffects pointer={effects.pointer} background={effects.background} /> : null;
  if (mode === 'abyss') return effects.pointer || effects.background ? <AbyssEffects pointer={effects.pointer} background={effects.background} /> : null;
  // Neon's grid and stars are CSS; only the pointer's trail and rings need a canvas.
  if (mode === 'neon') return effects.pointer ? <NeonEffects /> : null;
  // Ink's grain and wash are CSS; only a click's drop of ink needs a canvas.
  if (mode === 'ink') return effects.pointer ? <InkEffects /> : null;
  if (mode === 'dune') return effects.pointer || effects.background ? <DuneEffects pointer={effects.pointer} background={effects.background} /> : null;
  // Pixel's stars are CSS; only a click's +1 and sparks need a canvas.
  if (mode === 'pixel') return effects.pointer ? <PixelEffects /> : null;
  const on = mode === 'wizard' && (effects.pointer || effects.background || effects.elements);
  if (!on) return null;
  return <WizardCanvas pointer={effects.pointer} background={effects.background} elements={effects.elements} />;
}

function WizardCanvas({ pointer, background, elements }: { pointer: boolean; background: boolean; elements: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const c = cv?.getContext('2d');
    if (!cv || !c) return;
    let W = 0;
    let H = 0;
    const size = () => {
      const d = Math.min(window.devicePixelRatio || 1, 2);
      // The canvas's own size on screen: the window less its scrollbar, so the wisp sits on the cursor.
      const r = cv.getBoundingClientRect();
      W = r.width || window.innerWidth;
      H = r.height || window.innerHeight;
      cv.width = Math.round(W * d);
      cv.height = Math.round(H * d);
      c.setTransform(d, 0, 0, d, 0, 0);
    };
    size();

    // The mode's colors, read from its tokens, again when the theme changes.
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const read = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    let col = { spark: '', accent: '', gold: '', ember: '' };
    // A mote is a small glow, drawn once per color into an image the frames reuse; brighter on the dark theme.
    let moteSprites: HTMLCanvasElement[] = [];
    let moteAlpha: [number, number] = [0.3, 0.4];
    const sprite = (color: string) => {
      const s = document.createElement('canvas');
      s.width = s.height = 32;
      const g = s.getContext('2d');
      if (!g) return s;
      const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, rgba(color, 1));
      grad.addColorStop(0.18, rgba(color, 0.85));
      grad.addColorStop(0.45, rgba(color, 0.22));
      grad.addColorStop(1, rgba(color, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, 32, 32);
      return s;
    };
    const colors = () => {
      col = { spark: read('--wz-spark'), accent: read('--primary'), gold: read('--wz-gold'), ember: read('--wz-ember') };
      moteSprites = [sprite(col.accent), sprite(col.spark), sprite(col.gold)];
      moteAlpha = document.documentElement.classList.contains('dark') ? [0.16, 0.26] : [0.1, 0.18];
    };
    colors();
    const themeWatch = new MutationObserver(colors);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const parts: Part[] = [];
    const add = (p: Part) => {
      if (parts.length >= MAX_PARTS) parts.shift();
      parts.push(p);
    };
    const motes = Array.from({ length: MOTES }, (_, i) => ({ x: Math.random(), y: Math.random(), p: Math.random() * 6.28, s: rand(0.004, 0.012), r: rand(0.8, 1.8), c: i % 3 }));
    // With no cursor on the page (it left, or has not come yet) the wisp drifts on a slow loop of its own;
    // never on a touch screen, which has no cursor to come back.
    const canDrift = window.matchMedia('(hover: hover)').matches;
    const t0 = performance.now();
    const driftAt = (now: number) => {
      const t = (now - t0) / 1000;
      return { x: W * (0.5 + 0.38 * Math.sin(t * 0.23)), y: H * (0.5 + 0.32 * Math.sin(t * 0.37 + 1)) };
    };
    const start = driftAt(t0);
    const target = { ...start };
    const wisp = { x: start.x, y: start.y, vx: 0, vy: 0, R: 11, seen: canDrift };
    let inside = false;
    let hover = false;
    let hide = false;
    let emberAt = 0;
    let livelyUntil = 0;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      target.x = e.clientX + ARROW_X;
      target.y = e.clientY + ARROW_Y;
      if (!wisp.seen) {
        wisp.x = target.x;
        wisp.y = target.y;
        wisp.seen = true;
      }
      inside = true;
      livelyUntil = performance.now() + LIVELY_MS;
      const el = e.target instanceof Element ? e.target : null;
      // Over a field the text cursor matters more than the light: it hides.
      hide = Boolean(el?.closest('input, textarea, select, [contenteditable], .cm-editor'));
      hover = Boolean(el?.closest('button, a[href], [role="button"], [role="switch"]'));
      wake();
    };
    // Out of the window: mouseout with nowhere it went to.
    const onLeave = (e: MouseEvent) => {
      if (e.relatedTarget) return;
      inside = false;
      hover = false;
      hide = false;
      wake();
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"]') : null;
      if (!el || e.detail === 0) return;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + rand(-0.15, 0.15);
        const sp = rand(1.4, 2.6);
        add({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(520, 820), max: 820, r: rand(1, 1.8), c: i % 3 ? col.spark : col.gold, tw: rand(0, 6), drag: 0.93 });
      }
      livelyUntil = performance.now() + LIVELY_MS;
      wake();
    };
    if (pointer) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('mouseout', onLeave);
      window.addEventListener('click', onClick, true);
    }

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      if (last && now >= livelyUntil && now - last < CALM_FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? Math.min(50, now - last) : 16.7;
      last = now;
      const k = dt / 16.7;
      c.clearRect(0, 0, W, H);

      if (background) {
        // Each mote a soft glowing dot, drawn from a ready image, twinkling as it drifts up.
        for (const m of motes) {
          m.y -= m.s * k * 0.06;
          m.p += 0.02 * k;
          if (m.y < -0.02) {
            m.y = 1.02;
            m.x = Math.random();
          }
          const sprite = moteSprites[m.c];
          if (!sprite) continue;
          const size = m.r * 10;
          c.globalAlpha = moteAlpha[0] + (moteAlpha[1] * (1 + Math.sin(m.p))) / 2;
          c.drawImage(sprite, m.x * W + Math.sin(m.p) * 6 - size / 2, m.y * H - size / 2, size, size);
        }
      }

      if (elements && now - emberAt > EMBER_MS) {
        emberAt = now;
        const burning = [...document.querySelectorAll<HTMLElement>('[data-health="fail"][data-ui="card"]')]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.bottom > 0 && r.top < H && r.width > 0);
        const r = burning[Math.floor(Math.random() * burning.length)];
        if (r) {
          const top = Math.random() < 0.5;
          const left = Math.random() < 0.5;
          add({ x: top ? rand(r.left, r.right) : left ? r.left : r.right, y: top ? r.top : rand(r.top, r.bottom), vx: rand(-0.25, 0.25), vy: rand(-0.8, -0.3), life: rand(900, 1500), max: 1500, r: rand(0.8, 1.6), c: col.ember, tw: 1.57, drag: 1 });
        }
      }

      if (pointer && wisp.seen) {
        if (!inside) Object.assign(target, driftAt(now));
        // Eases toward the cursor by a share of the distance each frame, the same at any frame rate.
        const step = 1 - Math.pow(1 - (inside ? FOLLOW : DRIFT_FOLLOW), k);
        wisp.vx = ((target.x - wisp.x) * step) / k;
        wisp.vy = ((target.y - wisp.y) * step) / k;
        wisp.x += wisp.vx * k;
        wisp.y += wisp.vy * k;
        wisp.R += ((hover ? 15 : 10) - wisp.R) * 0.15 * k;
        const speed = Math.hypot(wisp.vx, wisp.vy);
        let n = Math.min(3, speed * (inside ? 0.2 : 0.35));
        while (!hide && (n >= 1 || Math.random() < n)) {
          add({ x: wisp.x + rand(-3, 3), y: wisp.y + rand(-3, 3), vx: rand(-0.25, 0.25) - wisp.vx * 0.05, vy: rand(0.05, 0.4), life: rand(450, 900), max: 900, r: rand(0.6, 1.3), c: Math.random() < 0.55 ? col.spark : Math.random() < 0.5 ? col.accent : col.gold, tw: rand(0, 6), drag: 0.985 });
          n -= 1;
          if (n < 0) break;
        }
      }

      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i] as Part;
        p.life -= dt;
        if (p.life <= 0) {
          parts.splice(i, 1);
          continue;
        }
        p.vx *= Math.pow(p.drag, k);
        p.vy *= Math.pow(p.drag, k);
        p.x += p.vx * k;
        p.y += p.vy * k;
        c.fillStyle = p.c;
        c.globalAlpha = Math.max(0, (p.life / p.max) * (0.65 + 0.35 * Math.sin(p.tw + now / 80)));
        star(c, p.x, p.y, p.r);
      }

      if (pointer && wisp.seen && !hide) {
        const R = wisp.R * 2.2;
        const g = c.createRadialGradient(wisp.x, wisp.y, 0, wisp.x, wisp.y, R);
        g.addColorStop(0, rgba(col.spark, 0.9));
        g.addColorStop(0.25, rgba(col.spark, 0.5));
        g.addColorStop(0.55, rgba(col.accent, 0.2));
        g.addColorStop(1, rgba(col.accent, 0));
        c.globalAlpha = 1;
        c.fillStyle = g;
        c.beginPath();
        c.arc(wisp.x, wisp.y, R, 0, 6.29);
        c.fill();
      }
      c.globalAlpha = 1;

      // With only the pointer on, rest once the wisp settled by the cursor and the dust is gone; the next move wakes it. A drifting wisp never rests.
      const drifting = pointer && canDrift && !inside;
      const resting = !background && !elements && !drifting && parts.length === 0 && Math.hypot(wisp.vx, wisp.vy) < 0.05;
      raf = resting ? 0 : requestAnimationFrame(frame);
      if (resting) last = 0;
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
    document.addEventListener('visibilitychange', onVisible);
    // A scrollbar that comes or goes changes the canvas, not the window: watch the canvas.
    const sized = new ResizeObserver(size);
    sized.observe(cv);
    wake();

    return () => {
      cancelAnimationFrame(raf);
      themeWatch.disconnect();
      probe.remove();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
      sized.disconnect();
    };
  }, [pointer, background, elements]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}
