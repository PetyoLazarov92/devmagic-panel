import { AssistantCard } from '@/features/assistant/assistant-card';
import { ClaudeDefaultsCard } from '@/features/assistant/claude-defaults-card';
import { LocalConstantsCard } from '@/features/settings/local-constants-card';
import { PageHeader } from '@/components/layout/page';
import { PanelPasswordCard } from '@/features/settings/panel-password-card';
import { RememberedCard, TrustedOwnersCard } from '@/features/settings/remembered-card';

/** The panel's own settings: its password, the AI assistant, Claude Code's defaults and the constants new sites get. */
export function SettingsPage() {
  return (
    <div className="pt-4">
      <PageHeader title="Settings" intro="The panel password, the AI assistant, the defaults Claude Code uses for installs, the constants new sites get, and what the wizard remembers per repo." />
      {/* In pairs of about the same size once there is room, each pair as tall as its taller card; a lone last card takes the row. */}
      <div className="mt-6 grid items-stretch gap-4 @4xl:grid-cols-2 @4xl:[&>:last-child:nth-child(odd)]:col-span-2">
        <PanelPasswordCard />
        <LocalConstantsCard />
        <AssistantCard />
        <ClaudeDefaultsCard />
        <RememberedCard />
        <TrustedOwnersCard />
      </div>
    </div>
  );
}
