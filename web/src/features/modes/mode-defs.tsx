/**
 * The SVG filters the Wizard mode's paper edges use (styles/modes.css): fractal
 * noise that moves the edge a few pixels, three seeds so cards side by side
 * get different edges. Drawn once, out of sight.
 */
export function ModeDefs() {
  const edge = (id: string, seed: number, frequency: number) => (
    <filter id={id} x="-6%" y="-6%" width="112%" height="112%">
      <feTurbulence type="fractalNoise" baseFrequency={frequency} numOctaves={3} seed={seed} result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale={7} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden focusable="false">
      {edge('dmp-paper-edge', 4, 0.035)}
      {edge('dmp-paper-edge-2', 11, 0.04)}
      {edge('dmp-paper-edge-3', 23, 0.03)}
    </svg>
  );
}
