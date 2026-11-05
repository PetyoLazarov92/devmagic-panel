import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { AuraItem, AuraReport, Briefing } from '@devmagic-panel/shared';
import { z } from 'zod';
import { redact } from './redact.js';

/** Makes a client: with the panel's saved key, or the SDK's own lookup (ANTHROPIC_API_KEY, ant auth login). */
export type ClaudeFactory = (apiKey: string | undefined) => Anthropic;

export const defaultClaude: ClaudeFactory = (apiKey) => (apiKey ? new Anthropic({ apiKey }) : new Anthropic());

const BriefingOutput = z.object({
  headline: z.string(),
  points: z.array(z.object({ text: z.string(), items: z.array(z.number().int()) })),
});

const SYSTEM = `You write the login briefing of devmagic-panel, a control panel for local WordPress sites on a developer's machine.
You get the panel's own health findings as JSON. Each finding has a number (n), the site it is about, its status (fail or warn), the problem, and the label of its one-click fix when there is one.
Write a headline of one short sentence, then 1 to 5 points, most urgent first: failures before warnings, security problems and broken sites before cosmetic ones.
Group findings that share a cause or a fix, such as the same problem on several sites. Each point names the sites, says what is wrong and what to do in plain words, and lists the numbers of the findings it covers.
Use only the findings given. Never invent problems, sites or fixes. Write short, plain sentences without em dashes.`;

/** What Claude sees: the findings, redacted, numbered so its points can point back at them. */
export function briefingContext(report: AuraReport): string {
  return JSON.stringify(
    report.items.map((item, i) => ({
      n: i + 1,
      site: item.domain ?? 'this machine',
      status: item.status,
      problem: redact(item.text),
      ...(item.fix ? { fix: item.fix.label } : {}),
    })),
    null,
    1,
  );
}

export function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'Claude refused the API key. Check it under AI assistant on the Environment page.';
  if (error instanceof Anthropic.RateLimitError) return 'Claude is rate limiting this key; the briefing tries again on the next visit.';
  if (error instanceof Anthropic.APIError) return `Claude answered ${error.status ?? 'with an error'}: ${error.message}`;
  return (error as Error).message || 'Claude could not be reached';
}

const TTL_MS = 15 * 60_000;

/**
 * Writes briefings and keeps each for 15 minutes per set of findings and
 * model, so reloading the Sites page does not call Claude again.
 */
export class Briefings {
  private readonly cache = new Map<string, { at: number; briefing: Briefing }>();

  constructor(
    private readonly claude: ClaudeFactory,
    private readonly now: () => number = Date.now,
  ) {}

  async brief(report: AuraReport, model: string, apiKey: string | undefined): Promise<Briefing> {
    const sent = briefingContext(report);
    if (report.items.length === 0) return { status: 'clear', sent };
    const key = createHash('sha256').update(`${model}\n${sent}`).digest('hex');
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.briefing;

    let briefing: Briefing;
    try {
      const response = await this.claude(apiKey).messages.parse({
        model,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: sent }],
        output_config: { format: zodOutputFormat(BriefingOutput) },
      });
      const out = response.parsed_output;
      if (response.stop_reason === 'refusal' || !out) {
        briefing = { status: 'error', error: 'Claude did not return a briefing this time.' };
      } else {
        briefing = {
          status: 'ready',
          headline: out.headline,
          points: out.points.map((p) => ({ text: p.text, items: pick(report.items, p.items) })),
          model,
          generatedAt: new Date(this.now()).toISOString(),
          sent,
        };
      }
    } catch (error) {
      // Errors are not cached: a fixed key works on the next visit.
      return { status: 'error', error: describeError(error) };
    }
    this.cache.set(key, { at: this.now(), briefing });
    return briefing;
  }
}

/** The findings a point covers, by their 1-based numbers; numbers Claude made up are dropped. */
function pick(items: AuraItem[], numbers: number[]): AuraItem[] {
  return [...new Set(numbers)].flatMap((n) => (items[n - 1] ? [items[n - 1] as AuraItem] : []));
}
