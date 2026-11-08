import type { ChatTurn, Proposal } from '@devmagic-panel/shared';
import { Check, Eye, LoaderCircle, Play, SendHorizontal, Sparkles, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { settled, StepList, useJob } from '@/components/job-steps';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { api } from '@/lib/api';
import { setAssistantOpen, useAssistantOpen } from '@/lib/assistant';
import { lastLine } from '@/lib/site-actions';
import { cn } from '@/lib/utils';

interface Message extends ChatTurn {
  proposals?: Proposal[];
  looked?: string[];
}

const EXAMPLES = ['Which sites need attention?', 'Why is local.arcade.example throwing fatals?', 'Fix the certificate problems'];

/** A change Claude suggested. It runs only when you click Run, through the same action route as every panel button. */
export function ProposalCard({ proposal, onClose }: { proposal: Proposal; onClose?: (status: 'ran' | 'dismissed') => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'failed' | 'dismissed'>('idle');
  const [output, setOutput] = useState('');
  const job = useJob();
  const [openStep, setOpenStep] = useState<string | null>(null);
  if (state === 'dismissed') return null;

  async function run() {
    setState('running');
    try {
      const result = await api.runAction(proposal.action, proposal.input);
      if (result.data?.jobId) {
        void job.follow(Promise.resolve(result.data.jobId));
        setState('done');
        onClose?.('ran');
        return;
      }
      if (result.data?.url) window.open(result.data.url, '_blank', 'noopener');
      setOutput(lastLine(result.output));
      setState(result.ok ? 'done' : 'failed');
      if (result.ok) onClose?.('ran');
    } catch (error) {
      setOutput((error as Error).message);
      setState('failed');
    }
  }

  const entries = Object.entries(proposal.input).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0));
  return (
    <div className="grid gap-2 rounded-lg border bg-background p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{proposal.title}</p>
          {proposal.why && <p className="text-xs text-muted-foreground">{proposal.why}</p>}
        </div>
        {state === 'done' && !job.job && <Check className="size-4 shrink-0 text-success" aria-label="Done" />}
      </div>
      {entries.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {job.job && <StepList steps={job.job.steps} open={openStep} setOpen={setOpenStep} />}
      {output && <p className={cn('text-xs', state === 'failed' ? 'text-danger' : 'text-muted-foreground')}>{output}</p>}
      {(state === 'idle' || state === 'failed') && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => void run()}>
            <Play />
            {state === 'failed' ? 'Run again' : 'Run'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setState('dismissed');
              onClose?.('dismissed');
            }}
          >
            Dismiss
          </Button>
        </div>
      )}
      {state === 'running' && <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Running...</p>}
      {job.job && !settled(job.job) && <p className="text-xs text-muted-foreground">Running as a job; you can close this drawer.</p>}
    </div>
  );
}

/**
 * The chat drawer. Claude reads with its read tools; every change it suggests
 * is a card that only runs when you click Run.
 */
export function AssistantDrawer() {
  const open = useAssistantOpen();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages, busy]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setAssistantOpen(false);
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: Message[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      // Only the text of earlier turns goes back; tool results stay on the server.
      const reply = await api.chat(next.map(({ role, content: c }) => ({ role, content: c || '(proposed changes)' })).slice(-40));
      setMessages([...next, { role: 'assistant', content: reply.reply, proposals: reply.proposals, looked: reply.looked }]);
    } catch (err) {
      setError((err as Error).message);
      setMessages(messages);
      setDraft(content);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  if (!open) return null;
  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l bg-card shadow-xl sm:w-[28rem]" aria-label="Ask Claude">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 text-primary" />
        <h2 className="flex-1 font-semibold">Ask Claude</h2>
        {messages.length > 0 && <Button size="sm" variant="ghost" onClick={() => setMessages([])} disabled={busy}>New chat</Button>}
        <Button size="icon" variant="ghost" onClick={() => setAssistantOpen(false)} title="Close (Esc)">
          <X />
          <span className="sr-only">Close</span>
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">Ask about your sites. Claude looks at the panel's own data; anything it wants to change comes back as a card you run yourself.</p>
            {EXAMPLES.map((q) => (
              <button key={q} type="button" onClick={() => void send(q)} className="rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted">{q}</button>
            ))}
          </div>
        )}
        <div className="grid gap-4">
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <p key={i} className="ml-8 justify-self-end rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">{m.content}</p>
            ) : (
              <div key={i} className="grid gap-2">
                {m.content && <p className="text-sm whitespace-pre-wrap">{m.content}</p>}
                {m.looked && m.looked.length > 0 && (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Eye className="mt-px size-3.5 shrink-0" />Looked at {m.looked.join(', ')}</p>
                )}
                {m.proposals?.map((p) => <ProposalCard key={p.id} proposal={p} />)}
              </div>
            ),
          )}
          {busy && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Claude is looking...</p>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div ref={end} />
        </div>
      </div>

      <footer className="border-t p-3">
        <div className="flex items-end gap-2">
          <Textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about your sites"
            aria-label="Message"
            rows={2}
            className="min-h-0 resize-none"
            disabled={busy}
          />
          <Button size="icon" className="size-10 shrink-0" onClick={() => void send(draft)} disabled={busy || !draft.trim()} title="Send (Enter)">
            <SendHorizontal />
            <span className="sr-only">Send</span>
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">Sends your question and what Claude looks up, with secrets blanked out. Never database contents.</p>
      </footer>
    </aside>
  );
}
