/** A tile's share of a six-column row: rows of two, from @xl rows of three, the last row's tiles splitting it. */
export function tileSpan(i: number, count: number): string {
  const pairs = count % 2 === 1 && i === count - 1 ? 'col-span-6' : 'col-span-3';
  const rest = count % 3;
  const threes = i < count - rest ? '@xl:col-span-2' : rest === 1 ? '@xl:col-span-6' : '@xl:col-span-3';
  return `${pairs} ${threes}`;
}
