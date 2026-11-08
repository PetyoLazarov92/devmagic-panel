/**
 * A site's .htaccess files, read for nginx: nginx reads no .htaccess, so the
 * panel translates the rules it can into rules of a few fixed kinds, which
 * dmp-root checks and writes into the site's nginx file. What each rule
 * becomes is shown before anything is applied.
 */

/**
 * What a rule of an .htaccess is on nginx:
 * - covered: nginx does it already (WordPress's own rules, http to https, no folder listings)
 * - translated: the panel can write it into the site's nginx file
 * - local: not needed on this computer (page caches, compression, expiry, production host names)
 * - php: a PHP setting, which goes on the site's PHP tab
 * - manual: the panel does not translate it; it does nothing on nginx
 */
export const HTACCESS_RULE_STATUSES = ['covered', 'translated', 'local', 'php', 'manual'] as const;
export type HtaccessRuleStatus = (typeof HTACCESS_RULE_STATUSES)[number];

export const HTACCESS_STATUS_LABEL: Record<HtaccessRuleStatus, string> = {
  covered: 'Covered',
  translated: 'Translated',
  local: 'Not needed here',
  php: 'PHP setting',
  manual: 'Not translated',
};

export interface HtaccessRule {
  /** Stable for the same text in the same file, so a choice to leave one out survives a new read. */
  id: string;
  /** The folder of the .htaccess it is in: / for the site's own, like /wp-content/uploads/wc-logs for one below. */
  file: string;
  /** Its first line in that file, from 1. */
  line: number;
  /** The lines as written (a RewriteRule with its RewriteCond lines, a whole <Files> block). */
  source: string;
  /** The # BEGIN section it is in, like "Wandworks Security". */
  section?: string;
  status: HtaccessRuleStatus;
  /** Why it has that status: what covers it, why it is not needed, or what the panel does not translate. */
  note?: string;
  /** For a translated rule: what dmp-root takes (redirect, rewrite, deny, header or error-page)... */
  rule?: string;
  /** ...and the nginx it becomes, as the site's file has it. */
  nginx?: string;
}

/** One .htaccess of the site and the checksum of what it holds. */
export interface HtaccessFile {
  folder: string;
  sha256: string;
}

export interface HtaccessReport {
  checkedAt: string;
  files: HtaccessFile[];
  rules: HtaccessRule[];
  /** The scan stopped at its limit of folders or rules, so some may be missing. */
  partial?: boolean;
  /** For a site on nginx: what its nginx file has now. */
  applied?: {
    rules: string[];
    /** The checksum of each .htaccess when its rules were applied, by folder. */
    sums: Record<string, string>;
  };
  /** For a site on nginx: an .htaccess changed, came or went since its rules were applied (or never were, while it has rules to apply). */
  changed?: boolean;
  /** For a site on nginx: the translated rules differ from what its nginx file has, so there is something to apply. */
  pending?: boolean;
  /** For a site on nginx: you put off the change as it is now (Not now). */
  dismissed?: boolean;
  /** The nginx directives of the translated rules, to copy to a host's own nginx settings. */
  nginx: string;
}

/** What a review of the rules hands back: the files as they were read, and the translated rules left out. */
export interface HtaccessChoice {
  sums: Record<string, string>;
  skip: string[];
}

/**
 * A change to the .htaccess files of a site on nginx, as the panel noticed it:
 * - rules: the rules nginx would get changed, so there is something to review
 * - manual: new rules nginx does nothing with (not translated, or PHP settings)
 * - quiet: nothing nginx gets changed (WordPress's rules, caches, comments)
 */
export interface HtaccessChange {
  domain: string;
  at: string;
  kind: 'rules' | 'manual' | 'quiet';
  /** Translated rules the nginx file does not have yet, and ones it has that are gone from the .htaccess. */
  added: number;
  removed: number;
}

export interface HtaccessChanges {
  /** Pass it back as since: the next answer has only the changes after it. */
  now: string;
  changes: HtaccessChange[];
}
