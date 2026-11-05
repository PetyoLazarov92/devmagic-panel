import type { AssistantSettings } from '@devmagic-panel/shared';
import { ASSISTANT_MODELS } from '@devmagic-panel/shared';
import { BookText, Check, Copy, ExternalLink, KeyRound, LoaderCircle, Sparkles, Terminal } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/field';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';

/** Where to create a Console API key, and Anthropic's page on what it is. */
const CONSOLE_KEYS_URL = 'https://platform.claude.com/settings/keys';
const API_DOCS_URL = 'https://platform.claude.com/docs/en/api/overview';

const SOURCE: Record<AssistantSettings['keySource'], string> = {
  panel: 'Saved in the panel',
  environment: 'From ANTHROPIC_API_KEY in the panel service environment',
  none: 'No key saved; an ant auth login profile is used if you have one',
};

/** The optional Claude assistant: off by default, every page works without it. */
export function AssistantCard() {
  const { data, reload } = useAsync(() => api.assistant(), []);
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const current = settings ?? data;
  if (!current) return null;

  async function save(name: string, run: () => Promise<AssistantSettings>, done?: string) {
    setBusy(name);
    try {
      setSettings(await run());
      if (done) toast({ tone: 'success', title: done });
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save', detail: (error as Error).message });
      reload();
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    const result = await api.testAssistant().catch((error: Error) => ({ ok: false, error: error.message }));
    toast(result.ok ? { tone: 'success', title: 'Claude answered', detail: 'The key and model work.' } : { tone: 'danger', title: 'Claude did not answer', detail: result.error ?? '' });
    setBusy(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI assistant</CardTitle>
        <Badge tone={current.enabled ? 'success' : 'neutral'}>{current.enabled ? 'on' : 'off'}</Badge>
      </CardHeader>
      <div className="grid gap-4 p-5 text-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="flex items-center gap-1.5 font-medium"><Sparkles className="size-4 text-primary" />Claude briefing at login</p>
            <p className="text-xs text-muted-foreground">Turns the Aura findings into a short summary with their fix buttons on the Sites page. Optional: the panel works the same without it.</p>
          </div>
          <Switch checked={current.enabled} label="AI assistant" disabled={busy !== null} onChange={(enabled) => void save('enabled', () => api.saveAssistant({ enabled }))} />
        </div>

        <Field label="Model" htmlFor="assistant-model">
          <Select id="assistant-model" value={current.model} disabled={busy !== null} onChange={(e) => void save('model', () => api.saveAssistant({ model: e.target.value as AssistantSettings['model'] }))}>
            {ASSISTANT_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </Field>

        <div className="grid gap-2 border-t pt-4">
          <p className="flex items-center gap-1.5 font-medium"><KeyRound className="size-4 text-muted-foreground" />Anthropic API key</p>
          <div className="rounded-md border border-primary/25 bg-primary/6 px-3 py-2 text-xs text-muted-foreground">
            <p>
              An API key from the Claude Console, starting <code className="font-mono text-foreground">sk-ant-api03-</code> and billed per use, apart from a Claude plan. A token from{' '}
              <code className="font-mono text-foreground">claude setup-token</code> (<code className="font-mono text-foreground">sk-ant-oat01-</code>) signs in Claude Code only, and Claude refuses it here.
            </p>
            <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              <a href={CONSOLE_KEYS_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                Create a key <ExternalLink className="size-3" />
              </a>
              <a href={API_DOCS_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                How API keys work <ExternalLink className="size-3" />
              </a>
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {SOURCE[current.keySource]}{current.keyHint ? ` (ends in ${current.keyHint})` : ''}. A saved key stays in ~/.config/devmagic-panel/secrets.json, readable only by you, and never comes back to the browser.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={current.keySource === 'panel' ? 'Replace the saved key: sk-ant-api03-...' : 'sk-ant-api03-...'}
              autoComplete="off"
              aria-label="Anthropic API key"
              className="min-w-56 flex-1 font-mono text-[13px]"
            />
            <Button
              variant="outline"
              className="h-10"
              disabled={busy !== null || !key.startsWith('sk-ant-')}
              onClick={() => void save('key', () => api.saveAssistantKey(key), 'Key saved').then(() => setKey(''))}
            >
              {busy === 'key' ? <LoaderCircle className="animate-spin" /> : <Check />}
              Save key
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void test()}>
              {busy === 'test' && <LoaderCircle className="animate-spin" />}
              Test connection
            </Button>
            {current.keySource === 'panel' && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void save('remove', () => api.removeAssistantKey(), 'Key removed')}>
                Remove saved key
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <div>
            <p className="flex items-center gap-1.5 font-medium"><BookText className="size-4 text-muted-foreground" />Conventions</p>
            <p className="text-xs text-muted-foreground">How sites are named and set up here. Claude reads it before it fills in the new site wizard; share it with your team.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
        </div>
        {editing && <ConventionsEditor onClose={() => setEditing(false)} />}

        <McpSection />

        <p className="border-t pt-4 text-xs text-muted-foreground">
          What Claude gets: site names and the panel's findings, with anything secret-looking blanked out. Never database contents, passwords or keys. Each briefing shows exactly what was sent.
        </p>
      </div>
    </Card>
  );
}

/** conventions.md: the machine's default until you save your own. */
function ConventionsEditor({ onClose }: { onClose: () => void }) {
  const { data } = useAsync(() => api.conventions(), []);
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = text ?? data?.text ?? '';

  async function save() {
    setSaving(true);
    try {
      await api.saveConventions(value);
      toast({ tone: 'success', title: 'Conventions saved' });
      onClose();
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save', detail: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="conventions.md"
      description={data ? `${data.saved ? 'Saved in' : 'Not saved yet; this is the default for this machine. Saving writes'} ${data.path}.` : 'Loading...'}
    >
      <Textarea aria-label="conventions.md" className="min-h-96 font-mono text-[13px]" value={value} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={saving || !data} onClick={() => void save()}>
          {saving && <LoaderCircle className="animate-spin" />}
          Save
        </Button>
      </div>
    </Dialog>
  );
}

/** The MCP server needs no API key: Claude Code or Claude Desktop bring their own model. */
function McpSection() {
  const { data } = useAsync(() => api.mcpCommand(), []);
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  return (
    <div className="grid gap-2 border-t pt-4">
      <p className="flex items-center gap-1.5 font-medium"><Terminal className="size-4 text-muted-foreground" />Use from Claude Code</p>
      <p className="text-xs text-muted-foreground">
        Gives Claude Code (or Claude Desktop) the same read tools and suggestions as the chat. Its suggestions wait here as cards until you run them; it never changes anything by itself. Run once in a terminal:
      </p>
      <div className="flex items-start gap-2">
        <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">{data.command}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(data.command);
            setCopied(true);
          }}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
