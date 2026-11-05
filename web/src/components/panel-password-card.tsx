import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { ChangePasswordDialog, CopyCommand } from '@/components/panel-password';
import { ScopeLabel } from '@/components/scope-label';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useAsync } from '@/lib/use-async';

const SET_PASSWORD = 'node ~/.local/share/devmagic-panel/current/server/dist/cli.js set-password';

/** The Environment page's Settings: when the panel password was set, changing it, and how to get back in without it. */
export function PanelPasswordCard() {
  const info = useAsync(() => api.passwordInfo(), []);
  const [open, setOpen] = useState(false);
  const changedAt = info.data?.changedAt;
  return (
    <Card>
      <CardHeader><CardTitle>Panel password</CardTitle><ScopeLabel>this panel</ScopeLabel></CardHeader>
      <div className="grid gap-3 p-5 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground">{changedAt ? `Last changed ${timeAgo(changedAt)}.` : 'Set when the panel was installed.'} Changing it signs every other browser out.</p>
          <Button variant="soft" onClick={() => setOpen(true)}><KeyRound />Change password</Button>
        </div>
        <details className="group text-xs text-muted-foreground">
          <summary className="cursor-pointer">If you forget it</summary>
          <div className="mt-2 grid gap-2">
            <p>The login page has Forgot your password?, which resets it with the password you log in to this computer with (where sudo asks you for one). Or run this in a terminal:</p>
            <CopyCommand command={SET_PASSWORD} />
          </div>
        </details>
      </div>
      <ChangePasswordDialog open={open} onClose={() => setOpen(false)} onChanged={info.reload} />
    </Card>
  );
}
