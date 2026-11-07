import { Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { Input } from '@/components/ui/input';
import { drawsDots, SECRET_FIELD, secretFieldType } from '@/lib/secret-field';
import { cn } from '@/lib/utils';

const dots = drawsDots();

/**
 * A secret the browser and password managers leave alone (see SECRET_FIELD),
 * with an eye button that shows what was typed. The panel's own login uses
 * PasswordInput instead, so a manager can save and fill it.
 */
export function SecretInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type' | 'autoComplete'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        {...SECRET_FIELD}
        type={secretFieldType(shown, dots)}
        className={cn('pr-10', !shown && dots && '[-webkit-text-security:disc]', className)}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'Hide it' : 'Show it'}
        aria-pressed={shown}
        className="absolute top-1/2 right-1 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}
