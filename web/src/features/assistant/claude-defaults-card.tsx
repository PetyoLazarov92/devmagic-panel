import type { OrgSettings } from '@devmagic-panel/shared';
import { Check, CircleAlert, CircleCheck, Plug, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ClaudeRunFields } from '@/features/assistant/claude-run-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { savePreferences, usePreferences } from '@/lib/preferences';
import type { UseClaude } from '@devmagic-panel/shared';
import { Spinner } from '@/components/ui/spinner';

/**
 * The panel's defaults for the Claude Code step of an install from a
 * project: one model, effort and spending cap, which an install can change
 * for itself. Claude Code runs with your own sign-in; the AI assistant above
 * uses your API key and keeps its own model.
 */
export function ClaudeDefaultsCard() {
  const status = useAsync(() => api.orgStatus(), []);
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [probe, setProbe] = useState<{ asana: boolean; drive: boolean; docs: boolean; costUsd: number } | null>(null);
  const [probing, setProbing] = useState(false);
  // Each change saves at once; this says so for a moment.
  const [saved, setSaved] = useState<'saving' | 'saved' | null>(null);
  useEffect(() => {
    if (status.data) setSettings(status.data.settings);
  }, [status.data]);
  useEffect(() => {
    if (saved !== 'saved') return;
    const timer = window.setTimeout(() => setSaved(null), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  async function save(next: OrgSettings) {
    const before = settings;
    setSettings(next);
    setSaved('saving');
    try {
      setSettings(await api.saveOrgSettings(next));
      setSaved('saved');
    } catch (err) {
      setSettings(before);
      setSaved(null);
      toast({ tone: 'danger', title: 'Not saved', detail: (err as Error).message });
    }
  }
  async function checkConnectors() {
    setProbing(true);
    try {
      setProbe(await api.orgTest());
    } catch (err) {
      toast({ tone: 'danger', title: 'Could not check the connectors', detail: (err as Error).message });
    } finally {
      setProbing(false);
    }
  }
  const claude = status.data?.claude;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Claude Code for installs</CardTitle>
        <Badge tone={claude?.claudeAi ? 'success' : 'neutral'}>{claude?.claudeAi ? 'signed in' : claude?.signedIn ? 'no claude.ai' : 'not ready'}</Badge>
      </CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        <UseClaudeField />
        <div>
          <p className="flex items-center gap-1.5 font-medium"><Sparkles className="size-4 text-primary" />Defaults for the Claude Code step</p>
          <p className="text-xs text-muted-foreground">Claude Code runs with your own sign-in, never an API key. One model, effort and spending cap for the step that reads a repo and checks its links, saved as you change them. They apply to every install, unless that install changed its own on its Code step.</p>
          <p className="mt-1 flex min-h-4 items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
            {saved === 'saving' && <><Spinner className="size-3.5" />Saving...</>}
            {saved === 'saved' && <><Check className="size-3.5 text-success" />Saved as your defaults</>}
          </p>
        </div>
        {status.loading && !status.data && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />Checking Claude Code...</p>}
        {claude && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {claude.claudeAi ? <CircleCheck className="size-3.5 text-success" /> : <CircleAlert className="size-3.5 text-warning" />}
            {!claude.found ? 'Claude Code is not installed.' : !claude.signedIn ? 'Claude Code is not signed in: run claude auth login in a terminal.' : claude.claudeAi ? `Claude Code ${claude.version ?? ''}, signed in with claude.ai.` : 'Signed in without claude.ai: Asana and Google links need claude auth login with your claude.ai account.'}
          </p>
        )}
        {settings && (
          <div className="grid gap-2 border-t pt-4">
            <div>
              <p className="font-medium">Claude reads the project</p>
              <p className="text-xs text-muted-foreground">
                Reads a repo&apos;s README, docs and build files into the install&apos;s form, then opens the Asana tasks and Google files they link, read-only, and lists the dumps in Drive. The effort is for reading; links are always checked at low effort. The cap covers both: the links get what reading left.
              </p>
            </div>
            <ClaudeRunFields value={settings.run} onChange={(run) => void save({ ...settings, run })} />
          </div>
        )}
        <div className="grid gap-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={probing || !claude?.signedIn} onClick={() => void checkConnectors()}>
              {probing ? <Spinner /> : <Plug />}
              Check connectors
            </Button>
            <span className="text-xs text-muted-foreground">One small Haiku run, at most $0.10.</span>
          </div>
          {probe && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {([['Asana', probe.asana], ['Google Drive', probe.drive], ['Google Docs', probe.docs]] as const).map(([name, ok]) => (
                <span key={name} className={ok ? 'flex items-center gap-1 text-success' : 'flex items-center gap-1 text-danger'}>{ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}{name}</span>
              ))}
              <span className="text-muted-foreground">${probe.costUsd.toFixed(3)}</span>
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Whether a new install from a project lets Claude Code read the repo: on unless switched off, off unless switched on, or never offered. */
function UseClaudeField() {
  const { useClaude } = usePreferences();
  const hints: Record<UseClaude, string> = {
    always: 'The Code step has the switch on; switch it off for one install.',
    ask: 'The switch starts off; switch it on for an install that needs it.',
    never: 'No switch and no Claude steps in new installs.',
  };
  return (
    <div className="grid gap-1.5">
      <label htmlFor="use-claude" className="font-medium">Use Claude Code in new installs</label>
      <Select id="use-claude" value={useClaude} onChange={(e) => void savePreferences({ useClaude: e.target.value as UseClaude })} wrapClassName="max-w-64">
        <option value="always">Always, switch off per install</option>
        <option value="ask">Off, switch on per install</option>
        <option value="never">Never</option>
      </Select>
      <p className="text-xs text-muted-foreground">{hints[useClaude]}</p>
    </div>
  );
}
