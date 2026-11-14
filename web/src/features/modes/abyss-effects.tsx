import { useEffect, useRef } from 'react';

/** How much of the way to the cursor the jellyfish goes each frame (at 60 a second): slow, so it floats behind. */
const FOLLOW = 0.12;
const DRIFT_FOLLOW = 0.04;
/** Its trail: the places it was, drawn fainter and smaller. */
const TRAIL = 5;
/** Bubbles rising behind the page at once, and how often a new one starts; bubbles from one click. */
const BUBBLES = 12;
const BUBBLE_EVERY_MS = 650;
const CLICK_BUBBLES = 8;
/** Most of the time 30 frames a second is plenty; the jellyfish by a moving cursor gets every frame. */
const CALM_FRAME_MS = 33;
const LIVELY_MS = 900;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function rgba(color: string, alpha: number): string {
  const m = color.match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color;
}
/** The jellyfish: a soft glow, coral at its heart fading to aqua, drawn once into an image every frame reuses. */
function jellySprite(coral: string, aqua: string): HTMLCanvasElement {
  const s = document.createElement('canvas');
  s.width = s.height = 48;
  const g = s.getContext('2d');
  if (!g) return s;
  const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
  grad.addColorStop(0, rgba(coral, 0.95));
  grad.addColorStop(0.25, rgba(coral, 0.55));
  grad.addColorStop(0.55, rgba(aqua, 0.2));
  grad.addColorStop(1, rgba(aqua, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 48, 48);
  return s;
}

interface Bubble { x: number; y: number; r: number; vy: number; wob: number; life: number; max: number }

/**
 * Abyss's effects, on one canvas over the page that never takes a click.
 * Pointer: a jellyfish glow follows the cursor slowly with a short trail, and
 * drifts on its own while the cursor is off the page; a click on a button or
 * link sends up a few bubbles. Background: bubbles rise from the bottom of the
 * page, wobbling. Nothing runs while the tab is hidden.
 */
export function AbyssEffects({ pointer, background }: { pointer: boolean; background: boolean }) {
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

    let jelly = jellySprite('#ff7ab6', '#7ef0c8');
    let aqua = '#a0e6ff';
    let dark = true;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const read = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      const coral = read('--ab-coral');
      aqua = read('--ab-aqua');
      jelly = jellySprite(coral, aqua);
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const canDrift = window.matchMedia('(hover: hover)').matches;
    const t0 = performance.now();
    const driftAt = (now: number) => {
      const t = (now - t0) / 1000;
      return { x: W * (0.5 + 0.34 * Math.sin(t * 0.17)), y: H * (0.5 + 0.28 * Math.sin(t * 0.27 + 1.3)) };
    };
    const start = driftAt(t0);
    const target = { ...start };
    const jel = { x: start.x, y: start.y };
    const trail: Array<{ x: number; y: number }> = [];
    let inside = false;
    let hide = false;
    let livelyUntil = 0;
    const bubbles: Bubble[] = [];
    let bubbleAt = 0;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      target.x = e.clientX;
      target.y = e.clientY;
      inside = true;
      livelyUntil = performance.now() + LIVELY_MS;
      const el = e.target instanceof Element ? e.target : null;
      hide = Boolean(el?.closest('input, textarea, select, [contenteditable], .cm-editor'));
      wake();
    };
    const onLeave = (e: MouseEvent) => {
      if (e.relatedTarget) return;
      inside = false;
      hide = false;
      wake();
    };
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      for (let i = 0; i < CLICK_BUBBLES; i++) {
        bubbles.push({ x: e.clientX + rand(-8, 8), y: e.clientY + rand(-4, 4), r: rand(1.4, 3.4), vy: rand(-1.4, -0.7), wob: rand(0, 6.28), life: rand(700, 1100), max: 1100 });
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
      raf = 0;
      if (last && now >= livelyUntil && now - last < CALM_FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = last ? Math.min(60, now - last) : 16.7;
      last = now;
      const k = dt / 16.7;
      c.clearRect(0, 0, W, H);

      if (background && now - bubbleAt > BUBBLE_EVERY_MS && bubbles.filter((b) => b.max > 2000).length < BUBBLES) {
        bubbleAt = now;
        bubbles.push({ x: rand(0, W), y: H + 8, r: rand(1.5, 4.5), vy: rand(-0.6, -0.3), wob: rand(0, 6.28), life: 30_000, max: 30_000 });
      }
      c.lineWidth = 1;
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i] as Bubble;
        b.life -= dt;
        b.wob += 0.05 * k;
        b.y += b.vy * k;
        b.x += Math.sin(b.wob) * 0.35 * k;
        if (b.life <= 0 || b.y < -10) {
          bubbles.splice(i, 1);
          continue;
        }
        const fade = Math.min(1, b.life / Math.min(b.max, 900));
        c.globalAlpha = (dark ? 0.45 : 0.4) * fade;
        c.strokeStyle = aqua;
        c.beginPath();
        c.arc(b.x, b.y, b.r, 0, 6.29);
        c.stroke();
        c.globalAlpha = (dark ? 0.35 : 0.3) * fade;
        c.fillStyle = aqua;
        c.beginPath();
        c.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, Math.max(0.5, b.r * 0.25), 0, 6.29);
        c.fill();
      }

      if (pointer && canDrift) {
        if (!inside) Object.assign(target, driftAt(now));
        const step = 1 - Math.pow(1 - (inside ? FOLLOW : DRIFT_FOLLOW), k);
        jel.x += (target.x - jel.x) * step;
        jel.y += (target.y - jel.y) * step;
        trail.unshift({ x: jel.x, y: jel.y });
        if (trail.length > TRAIL * 3) trail.length = TRAIL * 3;
        if (!hide) {
          const pulse = 0.85 + 0.15 * Math.sin(now / 420);
          // Its trail, fainter and smaller the further back.
          for (let i = TRAIL; i >= 1; i--) {
            const p = trail[i * 3 - 1];
            if (!p) continue;
            const s = 22 * (1 - i / (TRAIL + 2));
            c.globalAlpha = (dark ? 0.35 : 0.3) * (1 - i / (TRAIL + 1));
            c.drawImage(jelly, p.x - s / 2, p.y - s / 2, s, s);
          }
          const s = 34 * pulse;
          c.globalAlpha = dark ? 0.9 : 0.75;
          c.drawImage(jelly, jel.x - s / 2, jel.y - s / 2, s, s);
        }
      }
      c.globalAlpha = 1;
      if (background || (pointer && canDrift) || bubbles.length) raf = requestAnimationFrame(frame);
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
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pointer, background]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}
