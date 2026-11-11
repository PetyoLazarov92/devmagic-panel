/** What a card's changes touch: every site, one PHP version, or one site. Shown in the card's header. */
export function ScopeLabel({ children }: { children: string }) {
  return <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">Applies to: {children}</span>;
}
