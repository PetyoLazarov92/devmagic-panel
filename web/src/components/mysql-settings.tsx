import type { MysqlSetting, MysqlSettingName } from '@devmagic-panel/shared';
import { MYSQL_SETTINGS } from '@devmagic-panel/shared';
import { Pencil, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { JobFooter } from '@/components/job-box';
import { settled, useJob, useResumeJob } from '@/components/job-steps';
import { CardLinesSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAsync } from '@/lib/use-async';

const MB = 1024 * 1024;
const GB = 1024 * MB;
/** The sizes a size setting offers, inside its bounds, with the value it has and the one suggested. */
const SIZES = [MB, 4 * MB, 8 * MB, 16 * MB, 32 * MB, 64 * MB, 128 * MB, 256 * MB, 512 * MB, GB, 2 * GB, 3 * GB, 4 * GB, 6 * GB, 8 * GB, 12 * GB, 16 * GB, 24 * GB, 32 * GB, 48 * GB, 64 * GB];
const TARGET = 'mysql settings';

type Def = (typeof MYSQL_SETTINGS)[number];
const defOf = (name: MysqlSettingName) => MYSQL_SETTINGS.find((s) => s.name === name) as Def;

/** A value as the page says it: a size, a count, a choice, on or off, seconds. */
function shown(def: Def, value: number): string {
  if (def.unit === 'bytes') return bytes(value);
  if (def.unit === 'switch') return value ? 'On' : 'Off';
  if (def.unit === 'choice') return value === 2 ? 'Once a second' : value === 0 ? 'Once a second, not even to the OS' : 'Every commit';
  if (def.unit === 'seconds') return `${value} ${value === 1 ? 'second' : 'seconds'}`;
  return value.toLocaleString('en-US');
}

/** What a draft asks for: only the settings edited since Change opened; '' takes one out of the panel's file. */
function changesOf(settings: MysqlSetting[], draft: Record<string, string>, initial: Record<string, string>): Partial<Record<MysqlSettingName, number | null>> {
  const out: Partial<Record<MysqlSettingName, number | null>> = {};
  for (const s of settings) {
    const text = draft[s.name];
    if (text === undefined || text === initial[s.name]) continue;
    if (text.trim() === '') {
      if (s.kept !== undefined) out[s.name] = null;
      continue;
    }
    const n = Number(text);
    if (Number.isFinite(n)) out[s.name] = n;
  }
  return out;
}

/**
 * MySQL's settings that matter on a computer for local work: what runs now,
 * what the panel keeps for the next start, what an import holds raised, and
 * what the panel suggests. A change is a job: applied at once with SET
 * GLOBAL, kept in the panel's file through dmp-root, and Undo puts it back.
 */
export function MysqlSettingsCard() {
  const [refresh, setRefresh] = useState(0);
  const report = useAsync(() => api.mysqlSettings(), [refresh]);
  const runner = useJob();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const done = useRef<string | null>(null);
  useResumeJob(runner, TARGET, { 'mysql.setSettings': true }, () => undefined);
  const { job } = runner;
  const busy = job !== null && !settled(job);
  useEffect(() => {
    if (!job || !settled(job) || done.current === job.id) return;
    done.current = job.id;
    setRefresh((n) => n + 1);
    if (job.status === 'done') {
      setEditing(false);
      toast({ tone: 'success', title: `${job.title}: done` });
    }
  }, [job]);

  const data = report.data;
  const settings = data?.settings ?? [];

  function edit() {
    const start = Object.fromEntries(settings.map((s) => [s.name, String(s.kept ?? s.value)]));
    setDraft(start);
    setInitial(start);
    setEditing(true);
  }

  function apply(values: Partial<Record<MysqlSettingName, number | null>>) {
    if (Object.keys(values).length === 0) return setEditing(false);
    void runner.follow(api.startJob('mysql.setSettings', { values }));
  }

  const changes = changesOf(settings, draft, initial);
  const count = Object.keys(changes).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <SlidersHorizontal className="size-4 text-muted-foreground" />
      </CardHeader>
      {report.loading && !data && <CardLinesSkeleton lines={6} />}
      {report.error && <p role="alert" className="px-5 py-4 text-sm text-danger">{report.error}</p>}
      {data && (
        <>
          <p className="px-5 pt-3 text-xs text-muted-foreground">
            {data.file ? (
              <>A change applies at once, and is kept for {data.product}&apos;s next start in <span className="font-mono">{data.file}</span>, which {data.product} reads last.</>
            ) : (
              data.fileNote
            )}
          </p>
          <ul className="mt-2 divide-y">
            {settings.map((s) => {
              const def = defOf(s.name);
              return (
                <li key={s.name} className="grid gap-x-4 gap-y-1.5 px-5 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {def.label} <span className="font-mono text-xs font-normal text-muted-foreground">{s.name === 'tmp_table_size' ? 'tmp_table_size, max_heap_table_size' : s.name}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{def.about}</p>
                  </div>
                  {editing ? (
                    <Control def={def} setting={s} value={draft[s.name] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [s.name]: v }))} />
                  ) : (
                    <div className="grid content-start gap-1 sm:justify-items-end sm:text-right">
                      <span className="tabular-nums">{shown(def, s.value)}</span>
                      <span className="flex flex-wrap gap-1 sm:justify-end">
                        {s.raisedFrom !== undefined && <Badge tone="warning" title="An import raised it; it goes back when the import ends">{shown(def, s.raisedFrom)} after the import</Badge>}
                        {s.kept !== undefined && s.kept !== s.value && s.raisedFrom === undefined && <Badge tone="primary">{shown(def, s.kept)} from the next start</Badge>}
                        {s.kept !== undefined && s.kept === s.value && <Badge tone="neutral">Kept by the panel</Badge>}
                      </span>
                      {s.suggested !== undefined && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} title={s.why} onClick={() => apply({ [s.name]: s.suggested as number })}>
                          Use {def.unit === 'choice' ? shown(def, s.suggested).toLowerCase() : shown(def, s.suggested)}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
            {editing ? (
              <>
                <Button size="sm" disabled={busy || count === 0} onClick={() => apply(changes)}>
                  Apply {count === 0 ? '' : count === 1 ? '1 change' : `${count} changes`}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
                <p className="w-full text-xs text-muted-foreground">Empty, or {data.product}&apos;s own, takes a setting out of the panel&apos;s file: {data.product}&apos;s own value applies from its next start.</p>
              </>
            ) : (
              <Button size="sm" variant="outline" disabled={busy || settings.length === 0} onClick={edit}>
                <Pencil />Change...
              </Button>
            )}
          </div>
        </>
      )}
      <JobFooter job={job} error={runner.error} onRetry={() => void runner.retry()} />
    </Card>
  );
}

function Control({ def, setting, value, onChange }: { def: Def; setting: MysqlSetting; value: string; onChange: (value: string) => void }) {
  const own = setting.kept !== undefined || value === '';
  const label = `${def.label}, ${setting.name}`;
  if (def.unit === 'bytes') {
    const sizes = [...new Set([...SIZES.filter((n) => n >= def.min && n <= def.max), setting.value, ...(setting.kept !== undefined ? [setting.kept] : []), ...(setting.suggested !== undefined ? [setting.suggested] : [])])].sort((a, b) => a - b);
    return (
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-9">
        {own && <option value="">MySQL&apos;s own</option>}
        {sizes.map((n) => <option key={n} value={String(n)}>{bytes(n)}{n === setting.suggested ? ' (suggested)' : ''}</option>)}
      </Select>
    );
  }
  if (def.unit === 'choice' || def.unit === 'switch') {
    const options = def.unit === 'choice' ? [[1, 'Every commit (safest)'], [2, 'Once a second (faster)']] : [[1, 'On'], [0, 'Off']];
    return (
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-9">
        {own && <option value="">MySQL&apos;s own</option>}
        {!options.some(([n]) => String(n) === value) && value !== '' && <option value={value}>{shown(def, Number(value))}</option>}
        {options.map(([n, text]) => <option key={n} value={String(n)}>{text}</option>)}
      </Select>
    );
  }
  return (
    <Input
      aria-label={label}
      type="number"
      inputMode="decimal"
      min={def.min}
      max={def.max}
      step={def.unit === 'seconds' ? 0.1 : 1}
      value={value}
      placeholder="MySQL's own"
      onChange={(e) => onChange(e.target.value)}
      className="h-9"
    />
  );
}
