import type { MailMessage, MailSummary } from '@devmagic-panel/shared';
import { MAILPIT_WEB, textLinks } from '@devmagic-panel/shared';
import { ExternalLink, Mail, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { MailpitInstall } from '@/features/services/mailpit-install';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { api } from '@/lib/api';
import { mailRead } from '@/lib/mail-unread';
import { timeAgo } from '@/lib/format';
import { runWithToast } from '@/lib/site-actions';
import { useAsync } from '@/lib/use-async';
import { cn } from '@/lib/utils';
import { CheckAgain, PageHeader } from '@/components/layout/page';
import { CardSkeleton, ListSkeleton, Reading } from '@/components/layout/skeletons';

/** The site filter starts from ?site= so a site page can link straight to its mail. */
const initialSite = () => new URLSearchParams(window.location.search).get('site') ?? '';

/**
 * Mail the local sites sent, caught by Mailpit. Local mode tags each message
 * with its site, so the list can show one site's mail. HTML mail renders in a
 * sandboxed frame that runs no scripts.
 */
export function MailPage() {
  const sites = useAsync(() => api.sites(), []);
  const [site, setSite] = useState(initialSite);
  const [page, setPage] = useState<{ total: number; messages: MailSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const services = useAsync(() => api.services(), []);
  const offer = services.data?.services.find((s) => s.id === 'mailpit')?.offer;

  const load = useCallback(() => {
    setLoading(true);
    api.mail(site || undefined).then(
      (p) => {
        setPage(p);
        setError(null);
      },
      (err: Error) => setError(err.message),
    ).finally(() => setLoading(false));
  }, [site]);

  useEffect(load, [load]);
  // New mail shows up without a reload while the page is open.
  useEffect(() => {
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function clear() {
    const result = await runWithToast('mail.clear', site ? { domain: site } : {}, site ? `Deleted the mail from ${site}` : 'Deleted all caught mail');
    if (result?.ok) {
      setSelected(null);
      load();
    }
  }

  // Mail is caught per domain: a site under a path of another shares its domain, so each domain is listed once.
  const localModeSites = (sites.data ?? []).filter((s, i, all) => s.localMode?.enabled && all.findIndex((o) => o.domain === s.domain && o.localMode?.enabled) === i);
  return (
    <div className="pt-4">
      <PageHeader
        title="Mail"
        intro="Everything your local sites sent, caught by Mailpit so it never reaches real people."
        actions={
          <>
            <div className="w-64">
              <Select aria-label="Site" value={site} onChange={(e) => { setSite(e.target.value); setSelected(null); }}>
                <option value="">All sites</option>
                {localModeSites.map((s) => <option key={s.domain} value={s.domain}>{s.domain}</option>)}
              </Select>
            </div>
            <ButtonLink variant="outline" href={MAILPIT_WEB} target="_blank" rel="noopener noreferrer"><ExternalLink />Mailpit</ButtonLink>
            {page && page.total > 0 && <Button variant="outline" onClick={() => void clear()}><Trash2 />{site ? 'Delete this site\'s mail' : 'Delete all'}</Button>}
            <CheckAgain onClick={load} loading={loading} />
          </>
        }
      />

      {error && (
        <Card className="mt-6">
          <CardBody className="gap-3">
            <p className="font-medium">Mailpit is not running</p>
            <p className="text-muted-foreground">Until it runs, mail from sites in Local mode goes nowhere. {offer === 'install' ? 'The panel installs it for you: a pinned release, checked against its checksum, running as your user on 127.0.0.1.' : ''}</p>
            {offer && <MailpitInstall offer={offer} size="default" onDone={() => { services.reload(); load(); }} />}
            {!offer && <p className="text-xs text-muted-foreground">{error}</p>}
          </CardBody>
        </Card>
      )}

      {!page && !error && loading && (
        <div className="mt-6 grid gap-3" aria-busy="true">
          <Reading>Reading the mail Mailpit caught...</Reading>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <ListSkeleton rows={6} />
            <CardSkeleton lines={8} values={false} className="h-fit" />
          </div>
        </div>
      )}
      {page && !error && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Card className="h-fit overflow-hidden">
            {page.messages.length === 0 ? (
              <p className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground"><Mail className="size-4" />{site ? `No mail from ${site} yet.` : 'No mail caught yet.'}</p>
            ) : (
              <ul className="max-h-[70vh] divide-y overflow-auto">
                {page.messages.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => setSelected(m.id)} className={cn('grid w-full gap-0.5 px-4 py-3 text-left text-sm hover:bg-muted/60', selected === m.id && 'bg-muted')}>
                      <span className="flex items-center gap-2">
                        <span className={cn('min-w-0 flex-1 truncate', !m.read && 'font-semibold')}>{m.subject || '(no subject)'}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{m.date ? timeAgo(m.date) : ''}</span>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">To {m.to.join(', ') || 'nobody'}{!site && m.site ? ` · from ${m.site}` : ''}</span>
                      {m.snippet && <span className="truncate text-xs text-muted-foreground">{m.snippet}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {page.total > page.messages.length && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the newest {page.messages.length} of {page.total}. Open Mailpit for the rest.</p>}
          </Card>
          {selected ? <MessageView id={selected} /> : <Card className="hidden h-fit lg:block"><CardBody className="text-muted-foreground">Pick a message to read it.</CardBody></Card>}
        </div>
      )}
    </div>
  );
}

function MessageView({ id }: { id: string }) {
  // Opening it marks it read in Mailpit; the sidebar's count follows.
  const { data: message, error, loading } = useAsync<MailMessage>(() => api.mailMessage(id).then((m) => (mailRead(), m)), [id]);
  const [plain, setPlain] = useState(false);
  if (loading && !message) return <CardSkeleton lines={8} values={false} className="h-fit" />;
  if (error || !message) return <Card className="h-fit"><CardBody className="text-danger">{error ?? 'Message not found'}</CardBody></Card>;
  const html = message.html && !plain;
  return (
    <Card className="h-fit">
      <CardBody className="gap-3">
        <div className="grid gap-1">
          <h2 className="text-base font-semibold">{message.subject || '(no subject)'}</h2>
          <p className="text-muted-foreground">From {message.from || 'unknown'} to {message.to.join(', ') || 'nobody'}</p>
          <p className="text-xs text-muted-foreground">{message.date ? new Date(message.date).toLocaleString() : ''}</p>
        </div>
        {!message.html && <p className="text-xs text-muted-foreground">Plain text email: it has no HTML version to show.</p>}
        {message.html && message.text && (
          <Segmented label="Show as" value={plain ? 'text' : 'html'} onChange={(v) => setPlain(v === 'text')} options={[['html', 'HTML'], ['text', 'Text']]} className="justify-self-start text-xs" />
        )}
        {html ? (
          // No scripts, no forms, no same-origin access: the mail is shown, never run.
          <iframe title={message.subject} sandbox="" srcDoc={message.html} className="h-[60vh] w-full rounded-md border bg-white" />
        ) : (
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {message.text
              ? textLinks(message.text).map((part, i) =>
                  part.href ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{part.text}</a> : part.text,
                )
              : '(empty)'}
          </pre>
        )}
      </CardBody>
    </Card>
  );
}
