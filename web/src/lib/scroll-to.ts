/**
 * Goes to a card on the same page, for a link like "12 table problems": a
 * smooth scroll (at once when motion is reduced), then a ring on the card
 * for two seconds, so it is clear which card you landed on, left or right.
 * Focus moves to it too, so the keyboard and a screen reader carry on from
 * there. Every in-page link to a card goes through this.
 */
export function scrollToCard(target: string | HTMLElement | null | undefined, { block = 'start' }: { block?: ScrollLogicalPosition } = {}): void {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block });
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.classList.add('scroll-target');
  el.focus({ preventScroll: true });
  // The ring goes on the card itself, so it follows its corners: the element, or the cards a wrapper holds.
  const cards = el.classList.contains('rounded-xl') ? [el] : [...el.querySelectorAll<HTMLElement>(':scope > .rounded-xl')];
  const ringed = cards.length ? cards : [el];
  let shown = false;
  const flash = () => {
    if (shown) return;
    shown = true;
    for (const card of ringed) {
      card.classList.remove('card-flash');
      // Read the layout once, so the ring starts again on a second click.
      void card.offsetWidth;
      card.classList.add('card-flash');
      window.setTimeout(() => card.classList.remove('card-flash'), 2000);
    }
  };
  // Once the scroll arrives, where the browser says so; otherwise after a smooth scroll's usual time.
  if (reduce) return flash();
  // Capture: the page may scroll inside the app's own scroll area, whose scrollend does not bubble.
  document.addEventListener('scrollend', flash, { once: true, capture: true });
  window.setTimeout(flash, 700);
}
