import type { ClaudeEffort, ClaudeModel, ClaudeRun, ClaudeStep, OrgSettings } from '@devmagic-panel/shared';
import { CLAUDE_EFFORTS, CLAUDE_MODELS, DEFAULT_CLAUDE_STEPS } from '@devmagic-panel/shared';
import { Check, CircleAlert, CircleCheck, LoaderCircle, Plug, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';
import { CLAUDE_EFFORT_LABELS, CLAUDE_MODEL_LABELS, CLAUDE_STEP_LABELS } from '@/pages/new-site-org';

const STEP_TEXT: Record<ClaudeStep, string> = {
  read: "Reads a repo's README, docs and build files into the install's form.",
  access: 'Opens the linked Asana tasks and Google files read-only and lists the dumps in Drive.',
};

/**
 * The panel's defaults for the Claude Code steps of an install from an
 * organization: model, effort and spending cap for each, which an install can
 * change for itself. Claude Code runs with your own sign-in; the AI assistant
 * above uses your API key and keeps its own model.
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
        <div>
          <p className="flex items-center gap-1.5 font-medium"><Sparkles className="size-4 text-primary" />Defaults for installs from an organization</p>
          <p className="text-xs text-muted-foreground">Claude Code runs with your own sign-in, never an API key. Model, effort and spending cap per run for each step, saved as you change them. They apply to the next Claude Code step of every install, unless that install changed its own on its Claude Code card.</p>
          <p className="mt-1 flex min-h-4 items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
            {saved === 'saving' && <><LoaderCircle className="size-3.5 animate-spin" />Saving...</>}
            {saved === 'saved' && <><Check className="size-3.5 text-success" />Saved as your defaults</>}
          </p>
        </div>
        {status.loading && !status.data && <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Checking Claude Code...</p>}
        {claude && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {claude.claudeAi ? <CircleCheck className="size-3.5 text-success" /> : <CircleAlert className="size-3.5 text-warning" />}
            {!claude.found ? 'Claude Code is not installed.' : !claude.signedIn ? 'Claude Code is not signed in: run claude auth login in a terminal.' : claude.claudeAi ? `Claude Code ${claude.version ?? ''}, signed in with claude.ai.` : 'Signed in without claude.ai: Asana and Google links need claude auth login with your claude.ai account.'}
          </p>
        )}
        {settings &&
          (['read', 'access'] as const).map((step) => (
            <StepDefaults key={step} step={step} value={settings[step]} onChange={(value) => void save({ ...settings, [step]: value })} />
          ))}
        <div className="grid gap-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={probing || !claude?.signedIn} onClick={() => void checkConnectors()}>
              {probing ? <LoaderCircle className="animate-spin" /> : <Plug />}
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

function StepDefaults({ step, value, onChange }: { step: ClaudeStep; value: ClaudeRun; onChange: (value: ClaudeRun) => void }) {
  const [cap, setCap] = useState(String(value.budgetUsd));
  useEffect(() => setCap(String(value.budgetUsd)), [value.budgetUsd]);
  const tag = (field: 'model' | 'effort', v: string, label: string) => (DEFAULT_CLAUDE_STEPS[step][field] === v ? `${label} (recommended)` : label);
  return (
    <div className="grid gap-2 border-t pt-4">
      <div>
        <p className="font-medium">{CLAUDE_STEP_LABELS[step]}</p>
        <p className="text-xs text-muted-foreground">{STEP_TEXT[step]}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem]">
        <Select aria-label={`${CLAUDE_STEP_LABELS[step]}: model`} value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value as ClaudeModel })}>
          {CLAUDE_MODELS.map((m) => <option key={m} value={m}>{tag('model', m, CLAUDE_MODEL_LABELS[m])}</option>)}
        </Select>
        <Select aria-label={`${CLAUDE_STEP_LABELS[step]}: effort`} value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as ClaudeEffort })}>
          {CLAUDE_EFFORTS.map((m) => <option key={m} value={m}>{tag('effort', m, `${CLAUDE_EFFORT_LABELS[m]} effort`)}</option>)}
        </Select>
        <div className="relative" title="Spending cap per run">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">$</span>
          <Input
            aria-label={`${CLAUDE_STEP_LABELS[step]}: spending cap per run in dollars`}
            type="number"
            min={0.05}
            max={5}
            step={0.05}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => {
              const budgetUsd = Math.min(5, Math.max(0.05, Number(cap) || value.budgetUsd));
              setCap(String(budgetUsd));
              // Leaving the field unchanged saves nothing.
              if (budgetUsd !== value.budgetUsd) onChange({ ...value, budgetUsd });
            }}
            className="pl-6"
          />
        </div>
      </div>
    </div>
  );
}
