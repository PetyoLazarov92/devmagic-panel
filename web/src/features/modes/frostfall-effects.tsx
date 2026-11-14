import { useEffect, useRef } from 'react';

/** Flakes for every this many square pixels of window, and never more than the cap. */
const AREA_PER_FLAKE = 16_000;
const MAX_FLAKES = 120;
/** A gust comes this often: it builds, holds a moment and dies down, all in GUST_MS. */
const GUST_EVERY_MS: [number, number] = [12_000, 18_000];
const GUST_MS = 6_500;
/** How far a gust pushes the nearest flakes sideways, in pixels a frame at 60 a second. */
const GUST_PUSH = 2.4;
/** A click's frost: how long it grows and melts, and how far it reaches. */
const FROST_MS = 950;
const FROST_REACH = 17;

interface Flake { x: number; y: number; vx: number; r: number; depth: number; sway: number; swaySpeed: number; rot: number; spin: number; crystal: boolean }
interface Frost { x: number; y: number; at: number; turn: number }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function rgba(color: string, alpha: number): string {
  const hex = color.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (hex) return `rgba(${parseInt(hex[1] as string, 16)},${parseInt(hex[2] as string, 16)},${parseInt(hex[3] as string, 16)},${alpha})`;
  const m = color.match(/[\d.]+/g);
  return m && m.length >= 3 ? `rgba(${m[0]},${m[1]},${m[2]},${alpha})` : color;
}
/** One soft flake drawn once into an image every frame reuses; in light, a faint blue rim so white snow shows on a pale sky. */
function flakeSprite(snow: string, rim: string | null): HTMLCanvasElement {
  const s = document.createElement('canvas');
  s.width = s.height = 16;
  const g = s.getContext('2d');
  if (!g) return s;
  if (rim) {
    const halo = g.createRadialGradient(8, 8, 2, 8, 8, 8);
    halo.addColorStop(0, rgba(rim, 0.55));
    halo.addColorStop(1, rgba(rim, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, 16, 16);
  }
  const grad = g.createRadialGradient(8, 8, 0, 8, 8, 6);
  grad.addColorStop(0, rgba(snow, 1));
  grad.addColorStop(0.55, rgba(snow, 0.85));
  grad.addColorStop(1, rgba(snow, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 16);
  return s;
}
/**
 * A snow crystal drawn once, large, into an image: six arms, each with two
 * pairs of branches, and a small hexagon at its heart. In light, a soft blue
 * shadow around the white so it shows on a pale sky without a hard edge.
 */
function crystalSprite(snow: string, shadow: string | null): HTMLCanvasElement {
  const s = document.createElement('canvas');
  s.width = s.height = 64;
  const g = s.getContext('2d');
  if (!g) return s;
  if (shadow) {
    g.shadowColor = rgba(shadow, 0.55);
    g.shadowBlur = 6;
  }
  g.strokeStyle = rgba(snow, 1);
  g.fillStyle = rgba(snow, 1);
  g.lineWidth = 3.4;
  g.lineCap = 'round';
  g.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 - Math.PI / 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    g.moveTo(32 + ca * 4, 32 + sa * 4);
    g.lineTo(32 + ca * 24, 32 + sa * 24);
    for (const [at, len] of [[11, 8], [18, 5]] as const) {
      const bx = 32 + ca * at;
      const by = 32 + sa * at;
      for (const side of [-1, 1]) {
        const b = a + side * 0.8;
        g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(b) * len, by + Math.sin(b) * len);
      }
    }
  }
  g.stroke();
  g.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    g.lineTo(32 + Math.cos(a) * 5, 32 + Math.sin(a) * 5);
  }
  g.fill();
  return s;
}
/** How strong a gust is at t (0 to 1 through it): builds over the first quarter, holds, then dies down slowly. */
function gustAt(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  if (t < 0.25) return Math.sin((t / 0.25) * (Math.PI / 2)) ** 2;
  if (t < 0.45) return 1;
  return Math.cos(((t - 0.45) / 0.55) * (Math.PI / 2)) ** 2;
}

/**
 * Frostfall's effects, on two canvases that never take a click.
 * Background: snow drifting down behind the cards, the nearer flakes
 * six-armed crystals, larger, quicker and turning slowly, and every 12 to 18
 * seconds a gust that sweeps it sideways and dies down. Pointer: a click on a button or link leaves a ring of frost,
 * six small crystals that grow out and melt. The cursor never changes,
 * nothing runs while the tab is hidden, and the click canvas rests when
 * nothing is on it. The landscape is CSS (styles/frostfall.css).
 */
export function FrostfallEffects({ pointer, background }: { pointer: boolean; background: boolean }) {
  const snowRef = useRef<HTMLCanvasElement>(null);
  const frostRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const sc = snowRef.current;
    const fc = frostRef.current;
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

    let ice = '#4a7ca6';
    let frost = '#8fb4d4';
    let sprite = flakeSprite('#ffffff', '#8fa8c0');
    let crystal = crystalSprite('#ffffff', '#5f7f9e');
    let dark = false;
    const colors = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const read = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      ice = read('--ff-ice');
      frost = read('--ff-frost');
      probe.remove();
      dark = document.documentElement.classList.contains('dark');
      sprite = dark ? flakeSprite('#eef5fc', null) : flakeSprite('#ffffff', '#7f9ab4');
      crystal = dark ? crystalSprite('#e6f0fa', null) : crystalSprite('#ffffff', '#5f7f9e');
    };
    colors();
    const watch = new MutationObserver(colors);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const flakes: Flake[] = [];
    const newFlake = (top: boolean): Flake => {
      const depth = rand(0.25, 1);
      // The nearer half are crystals you can make out, turning slowly as they fall; the far ones are soft specks.
      const isCrystal = depth > 0.5;
      return { x: rand(-20, W + 20), y: top ? rand(-40, -6) : rand(0, H), vx: 0, r: isCrystal ? 3.5 + depth * 4 : 1.2 + depth * 2, depth, sway: rand(0, 6.28), swaySpeed: rand(0.008, 0.02), rot: rand(0, Math.PI / 3), spin: rand(-0.005, 0.005), crystal: isCrystal };
    };
    const fill = () => {
      const want = Math.min(MAX_FLAKES, Math.round((W * H) / AREA_PER_FLAKE));
      while (flakes.length < want) flakes.push(newFlake(false));
      flakes.length = Math.min(flakes.length, want);
    };
    if (background) fill();
    let gustStart = performance.now() + rand(4_000, 8_000);

    const frosts: Frost[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button:not([data-quiet]), a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      frosts.push({ x: e.clientX, y: e.clientY, at: performance.now(), turn: rand(0, Math.PI / 3) });
      wake();
    };
    if (pointer) window.addEventListener('click', onClick, true);

    const drawFrost = (now: number) => {
      c.clearRect(0, 0, W, H);
      c.lineCap = 'round';
      for (let i = frosts.length - 1; i >= 0; i--) {
        const fr = frosts[i] as Frost;
        const t = (now - fr.at) / FROST_MS;
        if (t >= 1) {
          frosts.splice(i, 1);
          continue;
        }
        const grow = 1 - (1 - Math.min(1, t * 1.5)) ** 3;
        const fade = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
        const reach = 4 + FROST_REACH * grow;
        // A thin ring of rime, just past the crystals' tips.
        c.globalAlpha = (dark ? 0.45 : 0.4) * fade;
        c.strokeStyle = frost;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(fr.x, fr.y, reach + 4, 0, 6.29);
        c.stroke();
        // Six crystals, each a spine with a pair of branches.
        c.globalAlpha = (dark ? 0.9 : 0.8) * fade;
        c.strokeStyle = dark ? frost : ice;
        c.lineWidth = 1.4;
        c.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = fr.turn + (k * Math.PI) / 3;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const x0 = fr.x + ca * 3;
          const y0 = fr.y + sa * 3;
          c.moveTo(x0, y0);
          c.lineTo(fr.x + ca * reach, fr.y + sa * reach);
          const bx = fr.x + ca * reach * 0.6;
          const by = fr.y + sa * reach * 0.6;
          const bl = reach * 0.28;
          for (const side of [-1, 1]) {
            const b = a + side * 0.75;
            c.moveTo(bx, by);
            c.lineTo(bx + Math.cos(b) * bl, by + Math.sin(b) * bl);
          }
        }
        c.stroke();
      }
      c.globalAlpha = 1;
    };

    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(80, now - last) : 16.7;
      last = now;
      const k = dt / 16.7;
      if (background) {
        if (now > gustStart + GUST_MS) gustStart = now + rand(GUST_EVERY_MS[0], GUST_EVERY_MS[1]);
        const gust = gustAt((now - gustStart) / GUST_MS);
        s.clearRect(0, 0, W, H);
        for (const f of flakes) {
          f.sway += f.swaySpeed * k;
          // Nearer flakes feel the wind more; each eases toward it, so a gust builds and settles softly.
          const want = 0.12 + gust * GUST_PUSH * (0.4 + 0.6 * f.depth) + Math.sin(f.sway) * 0.25;
          f.vx += (want - f.vx) * (1 - Math.pow(0.96, k));
          f.x += f.vx * k;
          f.y += (0.22 + 0.55 * f.depth) * (1 + gust * 0.35) * k;
          // Blown off one side, a flake comes back on the other at the same height; one that lands starts again at the top.
          if (f.x > W + 24) f.x = -20;
          else if (f.x < -24) f.x = W + 20;
          if (f.y > H + 8) Object.assign(f, newFlake(true));
          s.globalAlpha = (dark ? 0.35 : 0.55) + f.depth * (dark ? 0.45 : 0.4);
          if (f.crystal) {
            f.rot += f.spin * (1 + gust * 0.6) * k;
            const d = f.r * 2;
            s.save();
            s.translate(f.x, f.y);
            s.rotate(f.rot);
            s.imageSmoothingQuality = 'high';
            s.drawImage(crystal, -d / 2, -d / 2, d, d);
            s.restore();
          } else {
            const d = f.r * 2.6;
            s.drawImage(sprite, f.x - d / 2, f.y - d / 2, d, d);
          }
        }
        s.globalAlpha = 1;
      }
      if (pointer) drawFrost(now);
      if (background || frosts.length) raf = requestAnimationFrame(frame);
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
        frosts.length = 0;
        c.clearRect(0, 0, W, H);
      } else wake();
    };
    document.addEventListener('visibilitychange', onVisible);
    const onResize = () => {
      size();
      if (background) fill();
    };
    window.addEventListener('resize', onResize);
    if (background) wake();
    else s.clearRect(0, 0, W, H);
    return () => {
      cancelAnimationFrame(raf);
      watch.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pointer, background]);

  return (
    <>
      <canvas ref={snowRef} aria-hidden className="pointer-events-none fixed inset-0 size-full" style={{ zIndex: -1 }} />
      <canvas ref={frostRef} aria-hidden className="pointer-events-none fixed inset-0 z-50 size-full" />
    </>
  );
}
