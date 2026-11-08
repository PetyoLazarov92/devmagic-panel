import { useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The login page's brand panel: five sites around 127.0.0.1, and below them
 * their names, one by one; when a name gets its certificate, its node turns
 * live and requests start coming in. Made-up names only: the login page shows
 * before anyone is signed in, so nothing of this machine's sites is on it.
 */

const HUB = { x: 130, y: 120 };
const SITES = [
  { name: 'local.wandworks.test', x: 70, y: 70, speed: 1.8 },
  { name: 'local.shop.test', x: 190, y: 68, speed: 2.2 },
  { name: 'www.local.blog.test', x: 200, y: 150, speed: 2 },
  { name: 'shop.localhost', x: 66, y: 160, speed: 2.5 },
  { name: 'local.docs.test', x: 130, y: 190, speed: 1.6 },
] as const;
/** Each site starts 1.2 seconds after the one before, on one 12-second loop. */
const delay = (i: number) => ({ animationDelay: `${0.3 + i * 1.2}s` });

export function LoginArt({ variant = 'full', paused = false, reset = false, className }: {
  /** full: the orbit and the names; orbit: only the orbit, for a narrow screen. */
  variant?: 'full' | 'orbit';
  /** Holds every movement, while the password is typed. */
  paused?: boolean;
  /** The password reset: everything holds, and the centre shows a key. */
  reset?: boolean;
  className?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  // Two of these can be on the page (the full one and the narrow-screen one): their ids must differ.
  const uid = useId();
  const still = paused || reset;
  // CSS animations stop with data-paused; the requests' SMIL motion needs its own pause.
  useEffect(() => {
    if (still) svg.current?.pauseAnimations();
    else svg.current?.unpauseAnimations();
  }, [still]);

  const full = variant === 'full';
  return (
    <svg
      ref={svg}
      viewBox={full ? '0 0 260 370' : '0 40 260 170'}
      className={cn('login-art', className)}
      {...(still ? { 'data-paused': '' } : {})}
      role="img"
      aria-labelledby={`${uid}-title`}
    >
      <title id={`${uid}-title`}>Local sites on this computer, each with its own certificate, all served from 127.0.0.1</title>
      {full && <text x="20" y="30" fill="var(--la-title)" fontSize="13" fontWeight="500">devmagic-panel</text>}

      <g fill="none" strokeWidth="1.2">
        {SITES.map((s, i) => (
          <path key={s.name} id={`${uid}-spoke-${i}`} d={`M${s.x} ${s.y} L${HUB.x} ${HUB.y}`} stroke="var(--la-line)" />
        ))}
        {SITES.map((s, i) => (
          <path key={s.name} className="la-on" style={delay(i)} d={`M${s.x} ${s.y} L${HUB.x} ${HUB.y}`} stroke="var(--la-line-lit)" />
        ))}
      </g>

      <circle className="la-breath" cx={HUB.x} cy={HUB.y} r="22" fill="var(--la-glow)" />
      <circle cx={HUB.x} cy={HUB.y} r="19" fill="var(--la-hub)" />
      {reset ? (
        // A key: proving who you are, while the password is reset.
        <g fill="none" stroke="var(--la-title)" strokeWidth="1.8" strokeLinecap="round">
          <circle cx={HUB.x - 4} cy={HUB.y} r="4.5" />
          <path d={`M${HUB.x + 0.5} ${HUB.y} H${HUB.x + 10} M${HUB.x + 6.5} ${HUB.y} V${HUB.y + 4} M${HUB.x + 10} ${HUB.y} V${HUB.y + 3}`} />
        </g>
      ) : (
        <text x={HUB.x} y={HUB.y + 4} fill="var(--la-title)" fontSize="9.5" textAnchor="middle" fontFamily="ui-monospace, monospace">127.0.0.1</text>
      )}

      {SITES.map((s) => <circle key={s.name} cx={s.x} cy={s.y} r="5" fill="var(--la-node)" />)}
      {SITES.map((s, i) => <circle key={s.name} className="la-on" style={delay(i)} cx={s.x} cy={s.y} r="5" fill="var(--la-live)" />)}
      {SITES.map((s, i) => (
        <circle key={s.name} className="la-req" style={delay(i)} r="2.4" fill="var(--la-live-soft)">
          <animateMotion dur={`${s.speed}s`} repeatCount="indefinite">
            <mpath href={`#${uid}-spoke-${i}`} />
          </animateMotion>
        </circle>
      ))}

      {full && (
        <>
          <line x1="20" y1="218" x2="240" y2="218" stroke="var(--la-line)" />
          <g fontFamily="ui-monospace, monospace" fontSize="11">
            {SITES.map((s, i) => {
              const y = 240 + i * 24;
              return (
                <g key={s.name}>
                  <g className="la-row" style={delay(i)}>
                    <circle cx="26" cy={y} r="3" fill="var(--la-live)" />
                    <text x="36" y={y + 4} fill="var(--la-text)">{s.name}</text>
                  </g>
                  <g className="la-on" style={delay(i)}>
                    <rect x="200" y={y - 8} width="34" height="16" rx="4" fill="var(--la-badge)" />
                    <text x="217" y={y + 4} fill="var(--la-live-soft)" fontSize="10" textAnchor="middle">TLS</text>
                  </g>
                </g>
              );
            })}
          </g>
        </>
      )}
    </svg>
  );
}
