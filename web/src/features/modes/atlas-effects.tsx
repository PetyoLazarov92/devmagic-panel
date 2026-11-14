import { useEffect, useRef } from 'react';

/** How long a pin falls, bounces once and stays before it fades. */
const PIN_MS = 1600;
const DROP = 0.28;

interface Pin { x: number; y: number; at: number }

/**
 * Atlas's pointer effect, on one canvas over the page that never takes a
 * click: a click on a button or link drops a small red pin on the map, with
 * its shadow, that bounces once, settles and fades. Nothing follows the
 * cursor, and the canvas rests whenever no pin is on it. The map and its
 * route are CSS (styles/atlas.css).
 */
export function AtlasEffects() {
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

    let red = '#b03024';
    let ink = '#4a2c0e';
    const read = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const get = (name: string) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      red = get('--at-red');
      ink = get('--at-ink');
      probe.remove();
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-mode'] });

    const pins: Pin[] = [];
    const onClick = (e: MouseEvent) => {
      if (e.detail === 0) return;
      const el = e.target instanceof Element ? e.target.closest('button, a[href], [role="button"], [role="switch"]') : null;
      if (!el) return;
      pins.push({ x: e.clientX, y: e.clientY, at: performance.now() });
      wake();
    };
    window.addEventListener('click', onClick, true);

    let raf = 0;
    const frame = (now: number) => {
      raf = 0;
      c.clearRect(0, 0, W, H);
      for (let i = pins.length - 1; i >= 0; i--) {
        const pin = pins[i] as Pin;
        const t = (now - pin.at) / PIN_MS;
        if (t >= 1) {
          pins.splice(i, 1);
          continue;
        }
        // Falls in, bounces once, then rests; fades over the last third.
        let lift: number;
        if (t < DROP) lift = 16 * (1 - (t / DROP) ** 2);
        else if (t < DROP + 0.14) lift = 4 * Math.sin(((t - DROP) / 0.14) * Math.PI);
        else lift = 0;
        const fade = t < 0.66 ? 1 : 1 - (t - 0.66) / 0.34;
        c.globalAlpha = fade * 0.35;
        c.fillStyle = '#000';
        c.beginPath();
        c.ellipse(pin.x + 1, pin.y + 1, 4 - lift * 0.1, 1.6, 0, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = fade;
        const top = pin.y - lift;
        c.strokeStyle = ink;
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(pin.x, top);
        c.lineTo(pin.x, top - 13);
        c.stroke();
        c.fillStyle = red;
        c.beginPath();
        c.arc(pin.x, top - 15, 4.5, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = 'rgba(255,255,255,.55)';
        c.beginPath();
        c.arc(pin.x - 1.4, top - 16.4, 1.3, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
      if (pins.length) raf = requestAnimationFrame(frame);
    };
    function wake() {
      if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
    }
    const onVisible = () => {
      if (!document.hidden) return;
      cancelAnimationFrame(raf);
      raf = 0;
      pins.length = 0;
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
