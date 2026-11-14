import { useEffect, useRef } from 'react';

/** How much of the way to the cursor the firefly goes each frame (at 60 a second): slower than Wizard's wisp, so it trails. */
const FOLLOW = 0.14;
const DRIFT_FOLLOW = 0.05;
/** Fireflies wandering behind the page; leaves falling at once at most, and how far apart a new one starts. */
const FIREFLIES = 8;
const LEAVES = 3;
const LEAF_EVERY_MS: [number, number] = [2_500, 7_000];
/** Most of the time 30 frames a second is plenty; the firefly by a moving cursor gets every frame. */
const CALM_FRAME_MS = 33;
const LIVELY_MS = 900;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function rgba(color: string, alpha: number): string {
  const m = color.match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color;
}
function glowSprite(color: string): HTMLCanvasElement {
  const s = document.createElement('canvas');
  s.width = s.height = 32;
  const g = s.getContext('2d');
  if (!g) return s;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, rgba(color, 1));
  grad.addColorStop(0.18, rgba(color, 0.9));
  grad.addColorStop(0.5, rgba(color, 0.2));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return s;
}

interface Fly { x: number; y: number; a: number; s: number; p: number }
interface Leaf { x: number; y: number; vx: number; rot: number; spin: number; sway: number; size: number; autumn: boolean }

/**
 * Grove's effects, on one canvas over the page that never takes a click.
 * Pointer: a firefly follows the cursor (the cursor itself stays) a little
 * behind it, and drifts on its own while the cursor is off the page.
 * Background: a few fireflies wander and blink, and up to three leaves fall
 * across the page, a few seconds apart. Nothing runs while the tab is hidden.
 */
export function GroveEffects({ pointer, background }: { pointer: boolean; background: boolean }) {
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

    let glow = glowSprite('#e8f59a');
    let leafGreen = '#7ccf8a';
    let leafAutumn = '#d98a3a';
    let dark = true;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const read = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      glow = glowSprite(read('--gv-glow'));
      leafGreen = read('--primary');
      leafAutumn = read('--gv-autumn');
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
      return { x: W * (0.5 + 0.36 * Math.sin(t * 0.19)), y: H * (0.5 + 0.3 * Math.sin(t * 0.31 + 2)) };
    };
    const start = driftAt(t0);
    const target = { ...start };
    const fly = { x: start.x, y: start.y };
    let inside = false;
    let hide = false;
    let livelyUntil = 0;
    const flies: Fly[] = Array.from({ length: FIREFLIES }, () => ({ x: rand(0, W), y: rand(0, H), a: rand(0, 6.28), s: rand(0.15, 0.35), p: rand(0, 6.28) }));
    const leaves: Leaf[] = [];
    let leafAt = performance.now() + rand(1500, 4000);

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
    if (pointer) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.addEventListener('mouseout', onLeave);
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
      const base = dark ? 0.75 : 0.55;

      if (background) {
        for (const f of flies) {
          f.a += rand(-0.08, 0.08) * k;
          f.x += Math.cos(f.a) * f.s * k;
          f.y += Math.sin(f.a) * f.s * k;
          if (f.x < -10) f.x = W + 10;
          if (f.x > W + 10) f.x = -10;
          if (f.y < -10) f.y = H + 10;
          if (f.y > H + 10) f.y = -10;
          f.p += 0.03 * k;
          // A firefly blinks: mostly dim, now and then bright.
          const blink = Math.max(0, Math.sin(f.p)) ** 3;
          c.globalAlpha = base * (0.15 + 0.85 * blink);
          c.drawImage(glow, f.x - 9, f.y - 9, 18, 18);
        }
        if (leaves.length < LEAVES && now > leafAt) {
          leaves.push({ x: rand(W * 0.05, W * 0.95), y: -20, vx: rand(-0.3, 0.3), rot: rand(0, 6.28), spin: rand(-0.02, 0.02), sway: rand(0, 6.28), size: rand(8, 14), autumn: Math.random() < 0.35 });
          leafAt = now + rand(LEAF_EVERY_MS[0], LEAF_EVERY_MS[1]);
        }
        for (let i = leaves.length - 1; i >= 0; i--) {
          const leaf = leaves[i] as Leaf;
          leaf.sway += 0.02 * k;
          leaf.x += (leaf.vx + Math.sin(leaf.sway) * 0.6) * k;
          leaf.y += (0.45 + leaf.size * 0.012) * k;
          leaf.rot += (leaf.spin + Math.cos(leaf.sway) * 0.01) * k;
          const { x, y, size: s } = leaf;
          c.save();
          c.translate(x, y);
          c.rotate(leaf.rot);
          c.globalAlpha = dark ? 0.55 : 0.45;
          c.fillStyle = leaf.autumn ? leafAutumn : leafGreen;
          c.beginPath();
          c.moveTo(0, -s);
          c.quadraticCurveTo(s * 0.75, -s * 0.2, 0, s);
          c.quadraticCurveTo(-s * 0.75, -s * 0.2, 0, -s);
          c.fill();
          c.globalAlpha = dark ? 0.35 : 0.3;
          c.strokeStyle = dark ? '#0f1913' : '#fbfcf7';
          c.lineWidth = 0.8;
          c.beginPath();
          c.moveTo(0, -s * 0.85);
          c.lineTo(0, s * 0.9);
          c.stroke();
          c.restore();
          if (leaf.y > H + 30) leaves.splice(i, 1);
        }
      }

      if (pointer && canDrift) {
        if (!inside) Object.assign(target, driftAt(now));
        const step = 1 - Math.pow(1 - (inside ? FOLLOW : DRIFT_FOLLOW), k);
        fly.x += (target.x - fly.x) * step;
        fly.y += (target.y - fly.y) * step;
        if (!hide) {
          const pulse = 0.8 + 0.2 * Math.sin(now / 260);
          c.globalAlpha = base * pulse + 0.2;
          c.drawImage(glow, fly.x - 13, fly.y - 13, 26, 26);
        }
      }
      c.globalAlpha = 1;
      if (background || (pointer && canDrift)) raf = requestAnimationFrame(frame);
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
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pointer, background]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />;
}
