/**
 * The plugin search on the wizard's WordPress step. Letters and digits only,
 * so "mail chimp", "Mailchimp" and "mailchimp-for" all find mailchimp-for-wp.
 */
const letters = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Whether a plugin slug matches what you typed; everything matches an empty search. */
export function pluginMatches(slug: string, query: string): boolean {
  const wanted = letters(query);
  return wanted === '' || letters(slug).includes(wanted);
}
