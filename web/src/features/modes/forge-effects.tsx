import { useEffect, useRef } from 'react';

/** Embers in the air at once, and how often a new one rises. */
const EMBERS = 14;
const EMBER_EVERY_MS = 700;
/** Sparks from one click, and the most alive at once. */
const SPARKS = 14;
const MAX_SPARKS = 120;
/** While only embers rise, 30 frames a second is plenty; sparks get every frame. */
const CALM_FRAME_MS = 33;
const LIVELY_MS = 900;

interface Mote { x: number; y: number; vx: number; vy: number; life: number; max: number; r: number; hot: boolean; drag: number; g: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function rgba(color: string, alpha: number): string {
  const m = color.match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color;
}

/** A soft glow, drawn once per color into an image every frame reuses. */
function glowSprite(color: string): HTMLCanvasElement {
  const s = document.createElement('canvas');
  s.width = s.height = 32;
  const g = s.getContext('2d');
  if (!g) return s;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, rgba(color, 1));
  grad.addColorStop(0.2, rgba(color, 0.85));
  grad.addColorStop(0.5, rgba(color, 0.2));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return s;
}

/**
 * Forge's effects, on one canvas over the page that never takes a click.
 * Pointer: a short burst of sparks from a click on a button or link, falling
 * as they cool; nothing follows the cursor. Background: a few embers rise
 * slowly from the bottom of the page and fade. Nothing runs while the tab is
 * hidden, and the canvas rests when nothing is in the air.
 */
export function ForgeEffects({ pointer, background }: { pointer: boolean; background: boolean }) {
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

    // The ember and gold tokens, read again when the theme changes.
    let ember = glowSprite('#ff7a2e');
    let gold = glowSprite('#e2a64a');
    let dark = true;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      probe.style.color = 'var(--fg-ember)';
      const e = getComputedStyle(probe).color;
      probe.style.color = 'var(--fg-gold)';
      const g = getComputedStyle(probe).color;
      probe.remove();
      ember = glowSprite(e);
      gold = glowSprite(g);
      dark = document.documentElement.classList.contains('dark');
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const motes: Mote[] = [];
    let emberAt = 0;
    let livelyUntil = 0;
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      for (let i = 0; i < SPARKS; i++) {
        if (motes.length >= MAX_SPARKS) motes.shift();
        const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
        const sp = rand(1.4, 3.4);
        motes.push({ x: e.clientX, y: e.clientY, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(420, 760), max: 760, r: rand(0.7, 1.4), hot: Math.random() < 0.6, drag: 0.97, g: 0.09 });
      }
      livelyUntil = performance.now() + LIVELY_MS;
      wake();
    };
    if (pointer) window.addEventListener('click', onClick, true);

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = 0;
      if (last && now >= livelyUntil && now - last < CALM_FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? Math.min(60, now - last) : 16.7;
      last = now;
      const k = dt / 16.7;
      c.clearRect(0, 0, W, H);

      if (background && now - emberAt > EMBER_EVERY_MS && motes.filter((m) => m.g < 0).length < EMBERS) {
        emberAt = now;
        motes.push({ x: rand(0, W), y: H + 6, vx: rand(-0.15, 0.15), vy: rand(-0.55, -0.3), life: rand(5000, 9000), max: 9000, r: rand(0.9, 1.8), hot: Math.random() < 0.7, drag: 1, g: -0.0004 });
      }
      for (let i = motes.length - 1; i >= 0; i--) {
        const m = motes[i] as Mote;
        m.life -= dt;
        if (m.life <= 0 || m.y < -10) {
          motes.splice(i, 1);
          continue;
        }
        m.vx = (m.vx + (m.g < 0 ? Math.sin((m.life + i * 97) / 900) * 0.004 : 0)) * Math.pow(m.drag, k);
        m.vy = (m.vy + m.g * k) * Math.pow(m.drag, k);
        m.x += m.vx * k;
        m.y += m.vy * k;
        const fade = m.life / m.max;
        const size = m.r * 9;
        c.globalAlpha = Math.max(0, (m.g < 0 ? (dark ? 0.55 : 0.4) : 0.9) * Math.min(1, fade * 1.6));
        c.drawImage(m.hot ? ember : gold, m.x - size / 2, m.y - size / 2, size, size);
      }
      c.globalAlpha = 1;
      // Rest once nothing is in the air and no embers are wanted; the next click wakes it.
      if (motes.length || background) raf = requestAnimationFrame(frame);
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
    document.addEventListener('visibilitychange', onVisible);
    const sized = new ResizeObserver(size);
    sized.observe(cv);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      watch.disconnect();
      sized.disconnect();
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pointer, background]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}
