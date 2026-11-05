/**
 * The panel password's rules, the same in the browser, the server and the
 * CLI, after NIST SP 800-63B: a minimum length, a generous maximum, no
 * composition rules, and the most common and the obvious passwords refused.
 */

export const PANEL_PASSWORD_MIN = 8;
export const PANEL_PASSWORD_MAX = 1024;

/** The most common passwords of at least eight characters, from the published leak lists, lowercase. */
const COMMON = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '87654321', '11111111', '00000000', '88888888', '11223344', '12341234',
  '123123123', '987654321', '147258369', '123456123', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', 'q1w2e3r4', 'zaq12wsx', 'qwer1234',
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'pa$$word', 'password!', 'mypassword',
  'qwertyui', 'qwertyuiop', 'qwerty123', 'qwerty12', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', 'iloveyou', 'iloveyou1', 'sunshine',
  'princess', 'football', 'baseball', 'superman', 'trustno1', 'welcome1', 'welcome123', 'letmein1', 'abc12345', 'abcd1234',
  'abcdefgh', 'administrator', 'admin123', 'admin1234', 'adminadmin', 'changeme', 'computer', 'internet', 'whatever', 'starwars',
  'michelle', 'jennifer', 'jordan23', 'liverpool', 'chelsea1', 'charlie1', 'killer12', 'master12', 'monkey12', 'dragon12',
  'shadow12', 'secret12', 'samsung1', 'iloveu12', 'loveyou1', 'freedom1', 'hello123', 'test1234', 'testtest', 'wordpress',
  'wordpress1', 'localhost', 'devmagic', 'devmagic1', 'devmagic-panel', 'devmagicpanel', 'localdevmagic', 'local.devmagic',
]);

/** Why a password cannot be the panel password, or undefined when it can. `user` is the computer account's name. */
export function panelPasswordProblem(password: string, user?: string): string | undefined {
  if (password.length < PANEL_PASSWORD_MIN) return `At least ${PANEL_PASSWORD_MIN} characters`;
  if (password.length > PANEL_PASSWORD_MAX) return `At most ${PANEL_PASSWORD_MAX} characters`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'Too common: pick something only you would use';
  // The user name with only digits or signs around it (alex2026, alex!): the first thing a guesser tries.
  if (user && user.length >= 3 && lower.replace(/[^a-z]/g, '') === user.toLowerCase().replace(/[^a-z]/g, '')) return 'Too close to your user name';
  if (/^(.)\1+$/.test(password)) return 'One character repeated is too easy to guess';
  return undefined;
}
