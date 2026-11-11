import { ArrowRight, ExternalLink } from 'lucide-react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link } from '@/lib/router';
import { cn } from '@/lib/utils';

const TONES = {
  /** A link in running text or a card: the accent colour. */
  primary: 'font-medium text-primary hover:underline',
  /** A quiet link next to facts: grey until hovered. */
  muted: 'text-muted-foreground hover:text-foreground hover:underline',
  /** Keeps the text's colour, underlined on hover: a name that opens its page. */
  plain: 'hover:underline',
} as const;

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  tone?: keyof typeof TONES;
  /** "Open Apache ->": a way out of a card to the page that holds the rest. */
  arrow?: boolean;
  children: ReactNode;
};

const isExternal = (href: string) => /^(https?:|mailto:|vscode:)/.test(href);

/**
 * A link: it goes somewhere (a button does something). Inside the panel it moves without a
 * reload; to another site it opens a new tab, with a small arrow out and no referrer.
 */
export function TextLink({ href, tone = 'primary', arrow = false, className, children, ...props }: Props) {
  const classes = cn('inline-flex items-center gap-1 rounded-sm underline-offset-2', TONES[tone], className);
  if (isExternal(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={classes} {...props}>
        {children}
        {href.startsWith('http') && <ExternalLink className="size-3 shrink-0 opacity-70" aria-hidden />}
        {href.startsWith('http') && <span className="sr-only"> (opens in a new tab)</span>}
      </a>
    );
  }
  return (
    <Link href={href} className={classes} {...props}>
      {children}
      {arrow && <ArrowRight className="size-3.5 shrink-0" aria-hidden />}
    </Link>
  );
}
