# Modes

A mode is a look on top of the light and dark theme. **Classic** is the panel
as it always was and is always there. Other modes start sealed and open as you
use the panel. How each one opens is left out of these docs and the changelog
on purpose: finding it is part of the fun.

## The Modes page

The palette icon at the bottom of the menu opens it (`/modes`), as does Modes
in Ctrl+K. The mode you use is the wide card on top, with:

- a small picture of the panel in that mode,
- the theme switch (Light, Dark, System), the same as in the top bar,
- its effects, each a switch of its own (Classic has none).

Below are the other modes. An unlocked one has **Activate** and **Preview**,
which shows it on the Modes page for 20 seconds without saving it. A mode you
use for the first time comes with its effects on. A sealed one is blurred
behind a lock and shows a riddle for each way it opens; once you are past half
way on one of them, its riddle says **The seal is weakening**.

## When a mode opens

The panel shows it once, in a dialog: **You unlocked Wizard mode**, what
earned it, and **Switch to Wizard** or **Later**. It waits for a quiet moment,
never opening over another dialog or a form with unsaved changes, and it shows
once, whichever browser you use: the panel keeps that it was shown. Later
leaves everything as it is; the mode waits on the Modes page with a **New**
badge.

What the panel counts for this stays in its own database and is sent
nowhere, and nothing you type in Ctrl+K is kept.

## Effects

Each mode keeps its own switches:

- **Pointer**: a light that follows your cursor (the cursor itself stays as
  it is), star dust behind it, and a few stars when you click a button or a
  link. With the cursor off the page it drifts around on its own, and flies
  back when the cursor returns. It hides over text fields and does nothing on
  a touch screen.
- **Elements**: what happens on the page itself, like a glow on a broken
  site's card, a soft pulse on a healthy site's dot and turning rune circles.
- **Background**: a soft glow of violet and teal at the edges of the page,
  and a few small glowing motes drifting up.

When your system asks for reduced motion, every effect stays off whatever the
switches say, and the Modes page says so. The effects draw on one canvas that
never takes a click, rest when nothing moves, and stop while the tab is
hidden.

## Wizard

Starlit colors (moon-white paper, indigo ink, violet and aurora teal in the
light theme; deep night blue in the dark one), cards as sheets of paper with
uneven edges, and everything else in a frame in the same hand: tiles, the
boxes inside cards and the New site wizard's choices with an inked edge,
fields and dropdowns on toned paper with a gold line under them, checkboxes
as small gilded boxes, the main buttons, switches, progress bars and whatever
is chosen (a filter, a view, the open section, the step you are on) in a soft
aurora from pale violet into pale teal, the open tab underlined
in gold, faint indigo scrollbars, and menus and modals as sheets with a gold
frame. Rune circles turn where something runs, and a few pages have names of
their own:

| Classic | Wizard |
| --- | --- |
| Demo | Mirage |
| Sites | Portals |
| Mail | Ravens |
| Services | Sentinels |
| WP Cores | Keystones |
| Activity | Quests |
| Updates | Phoenix |
| Settings | Grimoire |
| Modes | Glamours |
| Developer options | Arcana |

Only the names change: the addresses stay (`/mail` is still `/mail`), a page
keeps its Classic name in the tooltip, and Ctrl+K finds it by either name. The
words inside pages stay plain, and so do errors, warnings, status labels
(Healthy, Needs attention, Broken) and anything that removes something.

## Trying it out

[Developer options](pages.md#developer-options) has a Modes card that unlocks
and seals each mode, fills or resets its paths, and shows the unlock dialog
again.
