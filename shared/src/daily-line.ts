import { isUnlocked, MODE_WORDS, type ModesState, type WordModeId } from './modes.js';

/**
 * The daily line: once a day, a thought, a bit of wisdom or a fact, written
 * for the panel and set as a quote, with one mode's secret word in bold
 * (marked **like this** in the text). Its sources are made up, never a real
 * person. The word comes from a mode still sealed, a different one each day;
 * once all are open, any word.
 */
export interface DailyLineText {
  text: string;
  source: string;
}

export interface DailyLine extends DailyLineText {
  /** The day it is for, this machine's date, YYYY-MM-DD. */
  date: string;
}

const SYSADMIN = "an old sysadmin's saying";
const HANDBOOK = 'the Wandworks handbook';
const STICKY = 'a sticky note on a monitor';
const RACK = 'a note taped to a server rack';
const NIGHT = "the night shift's wall";
const CONFIG = 'a comment in an old config file';
const ALMANAC = 'the Spellbook almanac';
const ALEX = "Alex Morgan's notebook";
const SAM = 'Sam Lee, after a Friday deploy';

export const DAILY_LINES: Record<WordModeId, DailyLineText[]> = {
  wizard: [
    { text: 'Most bugs vanish the moment someone else looks at them. It is the oldest **abracadabra** in the trade.', source: SYSADMIN },
    { text: 'A good commit message is no **abracadabra**: it says what changed and why.', source: HANDBOOK },
    { text: 'Clear the cache, reload, say **abracadabra** if it helps; then read the log.', source: STICKY },
    { text: 'Every clever trick looks like **abracadabra** until you write it down for the next person.', source: ALEX },
  ],
  circuit: [
    { text: 'Rest is part of the work. You cannot **overclock** a tired mind.', source: NIGHT },
    { text: 'Before you **overclock** the server, make sure the query is not the problem.', source: CONFIG },
    { text: 'Teams that **overclock** every week are worn out by spring.', source: HANDBOOK },
    { text: 'Measure first. The urge to **overclock** fades once you see where the time goes.', source: SYSADMIN },
  ],
  forge: [
    { text: 'A small fix shipped today can **ignite** more progress than a perfect plan next month.', source: SAM },
    { text: 'Curiosity will **ignite** a good debugging session; patience finishes it.', source: RACK },
    { text: "One kind review can **ignite** a newcomer's whole year.", source: HANDBOOK },
    { text: 'Do not wait for inspiration to **ignite**. Open the editor and start with one line.', source: STICKY },
  ],
  grove: [
    { text: 'Sites, like gardens, **bloom** when someone tends them a little every day.', source: ALMANAC },
    { text: 'Let ideas **bloom** in a branch before they meet production.', source: CONFIG },
    { text: 'Small habits **bloom** into big results. Update one plugin today.', source: HANDBOOK },
    { text: 'Good teams let questions **bloom**; the silly ones save the most time.', source: SYSADMIN },
  ],
  abyss: [
    { text: 'When the error makes no sense, **dive** into the logs first.', source: SYSADMIN },
    { text: 'The deepest bugs reward those who **dive** slowly and take notes.', source: ALEX },
    { text: 'Before you **dive** into a rewrite, read the code you want to replace.', source: HANDBOOK },
    { text: 'A fresh backup is the air tank that lets you **dive** without fear.', source: RACK },
  ],
  neon: [
    { text: 'The best part of a release is the quiet **afterglow** when nothing breaks.', source: NIGHT },
    { text: 'Write the notes in the **afterglow** of a fix, while you still remember why.', source: SAM },
    { text: 'A launch fades; the **afterglow** of good documentation lasts for years.', source: HANDBOOK },
    { text: 'Enjoy the **afterglow**, then check the error log one more time.', source: STICKY },
  ],
  ink: [
    { text: 'Readable code is a kind of **calligraphy**: every stroke placed with care.', source: HANDBOOK },
    { text: 'Naming things well is the **calligraphy** of programming.', source: SYSADMIN },
    { text: 'Slow down. Even **calligraphy** starts with one careful line.', source: ALEX },
    { text: 'A tidy config file is quiet **calligraphy** for whoever reads it next.', source: CONFIG },
  ],
  dune: [
    { text: 'In a **sandstorm** of alerts, fix the first one first.', source: NIGHT },
    { text: 'Every migration feels like a **sandstorm** until you have a map and a backup.', source: ALMANAC },
    { text: 'When the **sandstorm** hits, the team with the runbook keeps walking.', source: HANDBOOK },
    { text: 'Close the tabs you do not need. Your browser is not a **sandstorm** to survive.', source: STICKY },
  ],
  pixel: [
    { text: 'A recent backup is an **extralife** you only notice when you need it.', source: SYSADMIN },
    { text: 'Undo is the **extralife** every tool owes the people who use it.', source: HANDBOOK },
    { text: 'Treat each failing test as an **extralife**: you learned something before production did.', source: SAM },
    { text: 'Saving often is the closest thing to an **extralife** at a keyboard.', source: RACK },
  ],
  sorbet: [
    { text: 'A **brainfreeze** at four in the afternoon is a sign to take a walk, not to push harder.', source: NIGHT },
    { text: 'Everyone gets a **brainfreeze** over a regular expression. There is no shame in the docs.', source: STICKY },
    { text: 'Explain the problem out loud and the **brainfreeze** usually melts.', source: ALEX },
    { text: 'Sleep cures more **brainfreeze** than coffee ever will.', source: SYSADMIN },
  ],
  deco: [
    { text: 'Save the **champagne** for the day after the launch, when it is still working.', source: HANDBOOK },
    { text: 'Green tests on the first try deserve a little **champagne**.', source: SAM },
    { text: 'Not every fix needs **champagne**, but every fix deserves a thank you.', source: ALMANAC },
    { text: 'A quiet Friday deploy is worth more than any **champagne**.', source: NIGHT },
  ],
  chrome: [
    { text: 'Requirements are **quicksilver**: write them down before they change shape.', source: HANDBOOK },
    { text: 'A fast site feels like **quicksilver**, and most of its speed is what you left out.', source: CONFIG },
    { text: 'Deadlines move like **quicksilver**; a good estimate leaves room for it.', source: SYSADMIN },
    { text: 'Ideas are **quicksilver**. Keep a notebook close.', source: ALEX },
  ],
};

/** Days since 1970-01-01 for a YYYY-MM-DD date, so the pick changes once a day and is the same all day. */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** This machine's date, YYYY-MM-DD. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** The line for a day: a word from a mode still sealed, a different one each day in turn; once all are open, any. */
export function dailyLine(state: ModesState, date: string): DailyLine {
  const all = Object.keys(MODE_WORDS) as WordModeId[];
  const sealed = all.filter((m) => !isUnlocked(state, m));
  const pool = sealed.length ? sealed : all;
  const day = dayNumber(date);
  const mode = pool[day % pool.length] as WordModeId;
  const lines = DAILY_LINES[mode];
  const line = lines[Math.floor(day / pool.length) % lines.length] as DailyLineText;
  return { ...line, date };
}

/** The text split around its bold word, for the dialog. */
export function dailyLineParts(text: string): { before: string; word: string; after: string } {
  const m = /^(.*?)\*\*(.+?)\*\*(.*)$/s.exec(text);
  return m ? { before: m[1] ?? '', word: m[2] ?? '', after: m[3] ?? '' } : { before: text, word: '', after: '' };
}
