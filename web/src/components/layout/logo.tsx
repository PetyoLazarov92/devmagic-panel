import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-8', className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M9 22V10h5.5a6 6 0 0 1 0 12H9Z" fill="none" className="stroke-primary-foreground" strokeWidth="2.6" strokeLinejoin="round" />
      <circle cx="22.5" cy="22" r="2" className="fill-primary-foreground" />
    </svg>
  );
}
