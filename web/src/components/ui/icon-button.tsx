import type { LucideIcon } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';

/** A button with only an icon: its name is required, shown as a tooltip and read by screen readers. */
export function IconButton({ icon: Icon, label, size = 'icon', variant = 'ghost', ...props }: Omit<ButtonProps, 'children' | 'aria-label'> & { icon: LucideIcon; label: string }) {
  return (
    <Button size={size} variant={variant} aria-label={label} title={label} {...props}>
      <Icon aria-hidden />
    </Button>
  );
}
