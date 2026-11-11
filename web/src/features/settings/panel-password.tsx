import { PANEL_PASSWORD_MIN, panelPasswordProblem } from '@devmagic-panel/shared';
import { Check, Copy, KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { PasswordInput } from '@/components/ui/password-input';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

const RULE = `At least ${PANEL_PASSWORD_MIN} characters. A few unrelated words are easy to remember and hard to guess.`;

/**
 * The new password and its repeat, checked as you type by the same rules the
 * server and the CLI use. `ok` is true once both are fine.
 */
export function NewPassword({ id, value, repeat, onValue, onRepeat, user, disabled }: {
  id: string;
  value: string;
  repeat: string;
  onValue: (v: string) => void;
  onRepeat: (v: string) => void;
  user?: string;
  disabled?: boolean;
}) {
  const problem = value ? panelPasswordProblem(value, user) : undefined;
  const mismatch = repeat.length > 0 && repeat !== value;
  return (
    <>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-new`} className="text-sm font-medium">New password</label>
        <PasswordInput id={`${id}-new`} autoComplete="new-password" value={value} onChange={(e) => onValue(e.target.value)} disabled={disabled} aria-invalid={problem ? true : undefined} aria-describedby={`${id}-rule`} />
        <p id={`${id}-rule`} className={problem ? 'text-xs text-danger' : 'text-xs text-muted-foreground'}>{problem ?? RULE}</p>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-repeat`} className="text-sm font-medium">Repeat it</label>
        <PasswordInput id={`${id}-repeat`} autoComplete="new-password" value={repeat} onChange={(e) => onRepeat(e.target.value)} disabled={disabled} aria-invalid={mismatch ? true : undefined} />
        {mismatch && <p className="text-xs text-danger">The two do not match</p>}
      </div>
    </>
  );
}

export const newPasswordOk = (value: string, repeat: string, user?: string) => value.length > 0 && !panelPasswordProblem(value, user) && value === repeat;

/** Changing the panel password while signed in: the current one, then the new one twice. */
export function ChangePasswordDialog({ open, onClose, user, onChanged }: { open: boolean; onClose: () => void; user?: string; onChanged?: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setCurrent('');
    setNext('');
    setRepeat('');
    setError(null);
    onClose();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      toast({ tone: 'success', title: 'Password changed', detail: 'Any other browser signed in to the panel was signed out.' });
      onChanged?.();
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title="Change the panel password" description="Every other browser signed in to the panel is signed out; this one stays signed in.">
      <form className="mt-4 grid gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-1.5">
          <label htmlFor="pw-current" className="text-sm font-medium">Current password</label>
          <PasswordInput id="pw-current" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} />
        </div>
        <NewPassword id="pw" value={next} repeat={repeat} onValue={setNext} onRepeat={setRepeat} disabled={busy} {...(user ? { user } : {})} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="soft" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !current || !newPasswordOk(next, repeat, user)}>
            {busy ? <Spinner /> : <KeyRound />}
            Change password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A command with a copy button, for the terminal way. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2">
      <code className="min-w-0 flex-1 font-mono text-xs break-all">{command}</code>
      <IconButton
        icon={copied ? Check : Copy}
        label="Copy the command"
        className={cn('-my-1 size-6 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground', copied && 'text-success hover:text-success')}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      />
    </div>
  );
}
