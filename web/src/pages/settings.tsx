import { AssistantCard } from '@/components/assistant-card';
import { ClaudeDefaultsCard } from '@/components/claude-defaults-card';
import { LocalConstantsCard } from '@/components/local-constants-card';
import { PageHeader } from '@/components/page';
import { PanelPasswordCard } from '@/components/panel-password-card';

/** The panel's own settings: its password, the AI assistant, Claude Code's defaults and the constants new sites get. */
export function SettingsPage() {
  return (
    <div className="pt-4">
      <PageHeader title="Settings" intro="The panel password, the AI assistant, the defaults Claude Code uses for organization installs, and the constants new sites get." />
      <div className="mt-6 grid gap-4">
        <PanelPasswordCard />
        <AssistantCard />
        <ClaudeDefaultsCard />
        <LocalConstantsCard />
      </div>
    </div>
  );
}
