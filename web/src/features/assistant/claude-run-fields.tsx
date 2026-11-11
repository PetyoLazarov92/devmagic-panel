import type { ClaudeEffort, ClaudeModel, ClaudeRun } from '@devmagic-panel/shared';
import { CLAUDE_EFFORTS, CLAUDE_MODELS, DEFAULT_CLAUDE_RUN } from '@devmagic-panel/shared';
import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export const CLAUDE_MODEL_LABELS: Record<ClaudeModel, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };
export const CLAUDE_EFFORT_LABELS: Record<ClaudeEffort, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** A model or effort with "recommended" when it is the default the step was tuned for. */
const tag = (field: 'model' | 'effort', value: string, label: string) => (DEFAULT_CLAUDE_RUN[field] === value ? `${label} (recommended)` : label);

/**
 * The model, effort and spending cap of the Claude Code step, in one row:
 * your defaults under Settings, and one install's own on its Code step. The
 * cap is for the whole step, reading the repo and checking its links.
 */
export function ClaudeRunFields({ value, onChange, disabled }: { value: ClaudeRun; onChange: (value: ClaudeRun) => void; disabled?: boolean }) {
  const [cap, setCap] = useState(String(value.budgetUsd));
  useEffect(() => setCap(String(value.budgetUsd)), [value.budgetUsd]);
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_7rem]">
      <Select aria-label="Model" value={value.model} disabled={disabled} onChange={(e) => onChange({ ...value, model: e.target.value as ClaudeModel })}>
        {CLAUDE_MODELS.map((m) => <option key={m} value={m}>{tag('model', m, CLAUDE_MODEL_LABELS[m])}</option>)}
      </Select>
      <Select aria-label="Effort for reading the repo" value={value.effort} disabled={disabled} onChange={(e) => onChange({ ...value, effort: e.target.value as ClaudeEffort })}>
        {CLAUDE_EFFORTS.map((m) => <option key={m} value={m}>{tag('effort', m, `${CLAUDE_EFFORT_LABELS[m]} effort`)}</option>)}
      </Select>
      <div className="relative" title="Spending cap for the step, from $0.05 to $5">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">$</span>
        <Input
          aria-label="Spending cap for the step in dollars"
          type="number"
          min={0.05}
          max={5}
          step={0.05}
          value={cap}
          disabled={disabled}
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
  );
}
