import { Ban, Check, FlaskConical, Link2, Shapes } from 'lucide-react';
import type { ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { navigate } from '@/lib/router';
import { Notice, PageHeader } from '@/components/page';
import { DEMO_HOME, isDemo } from '@/lib/api';

/** Only in the mockup (npm run mockup): what it is, what it never touches, and the addresses that show other states. */
export function MockupPage() {
  return (
    <div className="pt-4">
      <PageHeader
        title={isDemo ? 'Demo' : 'Mockup'}
        intro={
          isDemo
            ? "devmagic-panel's own screens on made-up sample data, to click through every page before you install it. It looks and clicks like the panel, but nothing behind it is real."
            : "The panel's own screens on made-up sample data, for trying a flow, designing a change or taking screenshots. It looks and clicks like the panel, but nothing behind it is real."
        }
        actions={!isDemo && <ButtonLink href="/mockup/parts" variant="outline" onClick={(e) => { e.preventDefault(); navigate('/mockup/parts'); }}><Shapes />The parts</ButtonLink>}
      />
      <Notice tone="info" className="mt-6">
        {isDemo
          ? 'Nothing you do here reaches your computer or this server. There is no panel server, no root and no database behind it: every answer comes from sample data in this browser tab.'
          : 'Nothing you do here reaches this machine. There is no panel server, no root and no database behind it: every answer comes from sample data in this browser tab.'}
      </Notice>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Ban className="size-4 text-muted-foreground" />What it never touches</span>} />
          <CardBody>
            <ul className="grid gap-2">
              <Item>Your sites, their files and their git repos</Item>
              <Item>Apache, nginx, PHP, the certificates and <code className="font-mono text-dense">/etc/hosts</code></Item>
              <Item>MySQL: no database is read, changed, exported or dropped</Item>
              <Item>cron, Mailpit and the panel&apos;s own settings and run history</Item>
              <Item>
                <code className="font-mono text-dense">dmp-root</code> and sudo: nothing runs as root, and no password is asked for or sent
              </Item>
              <Item>Claude, GitHub and GitLab: no request leaves the browser, and no API key is used</Item>
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><FlaskConical className="size-4 text-muted-foreground" />How it works</span>} />
          <CardBody>
            <ul className="grid gap-2">
              <Item>
                {isDemo ? (
                  <>This is only the panel&apos;s web app, built with its sample data. Every call the screens make is answered in this tab, from <code className="font-mono text-dense">web/src/mock/</code> instead of a panel server.</>
                ) : (
                  <><code className="font-mono text-dense">npm run mockup</code> starts only the web app. Every call the screens make goes to <code className="font-mono text-dense">web/src/mock/</code> instead of the panel server.</>
                )}
              </Item>
              <Item>The sites, databases, logs and jobs are made up, with names like local.wandworks.example that are not on this machine.</Item>
              <Item>Actions answer as the panel would: a job runs its steps on a timer, a toast offers Undo, and the screen updates.</Item>
              <Item>A link out of the panel (a site, wp-admin, GitHub, your editor) never leaves the mockup: a toast shows the address it would open. Downloads are left out.</Item>
              <Item>
                A reload starts over: changes live in this tab&apos;s memory. Only your preferences (theme, views) stay until the tab closes.
              </Item>
            </ul>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title={<span className="flex items-center gap-2"><Link2 className="size-4 text-muted-foreground" />Other states, from the address</span>} />
        <CardBody className="gap-3">
          <p className="text-muted-foreground">Each opens its page as it looks when something is not as usual. A reload without it goes back to normal.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {STATES.map(([query, page, what]) => (
                  <tr key={query}>
                    <td className="py-2 pr-4 align-top whitespace-nowrap">
                      {/* A full load, not the panel's own navigation: the mockup reads these as it starts. */}
                      <a href={`${page}?${query}`} className="font-mono text-dense text-primary hover:underline">?{query}</a>
                    </td>
                    <td className="py-2 pr-4 align-top whitespace-nowrap text-muted-foreground">{PAGE_NAME[page]}</td>
                    <td className="py-2 text-muted-foreground">{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <p className="mt-6 text-sm text-muted-foreground">
        The real panel runs at <span className="font-mono text-dense">https://local.devmagic</span> once it is installed, and it changes this machine for real, with Undo for each change.
        {isDemo && (
          <>
            {' '}
            <a href={DEMO_HOME} data-mockup-exit className="text-primary hover:underline">
              How to install it
            </a>
            .
          </>
        )}
      </p>
    </div>
  );
}

/** The query, the page it shows on, and what it shows. */
const STATES: Array<[string, string, string]> = [
  ['proposals=none', '/sites', 'Nothing waits in the corner from an MCP client, as for screenshots.'],
  ['session=ends', '/sites', 'You are signed out after 15 seconds, as when the session runs out.'],
  ['panel=starting', '/sites', 'The panel answers only after 8 seconds, as right after a login.'],
  ['terminal', '/update', 'The newest release changes the root scripts and needs the installer in a terminal.'],
  ['install=failed', '/update', 'The last install from the Updates page failed (also done or interrupted).'],
  ['claude=signed-out', '/settings', 'Claude Code is not signed in (also missing or api).'],
  ['gh=signed-out', '/settings', 'The GitHub CLI is not signed in.'],
  ['glab=missing', '/settings', 'The GitLab CLI is not installed (also signed-out).'],
  ['rclone=1', '/settings', 'A Google Drive remote is set up, with its Download button.'],
];

const PAGE_NAME: Record<string, string> = { '/sites': 'Sites', '/update': 'Updates', '/settings': 'Settings' };

function Item({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      <span className="min-w-0">{children}</span>
    </li>
  );
}
