/**
 * Uploads from production, the second view of a site's Files tab: what the
 * site's own server has in wp-content/uploads next to what is here, and what
 * you choose to bring. Read on the server, added here, never the other way.
 */

/** What a folder of uploads is for. Only media is ticked to begin with. */
export type UploadsKind = 'media' | 'generated' | 'private' | 'other';

/** Folders plugins fill with files they can make again: page builder styles, converted images and the like. */
const GENERATED = /^(elementor|et-cache|fusion-(styles|scripts|icons)|bb-plugin|bb-theme|siteorigin-widgets|generateblocks|oxygen|brizy|uag-plugin|kadence(-blocks)?|astra|omgf|smush(-webp)?|webp-express|litespeed|avada-styles|thrive|beaver-builder|spectra|essential-addons-elementor|jet-engine|wp-optimize|ewww|shortpixel|imagify|rank-math|wpseo-redirects|maxmegamenu|stackable|blocksy|redux|wpcode|custom-css-js|sb-instagram-feed-images|facebook-feed|complianz|pum|mc4wp-debug-log|[a-z0-9-]*-(cache|css|styles))$/i;
/** Folders that hold what people sent or bought: form entries, order files, paid downloads, members' files. */
const PRIVATE = /^(woocommerce_uploads|wc-(uploads|exports)|gravity_forms|gravityforms|wpforms|ninja-forms|formidable|edd|wpcf7_uploads|wpcf7-files|learndash|mailpoet|fluentform|forminator|wpo_wcpdf|wpo-wcpdf|private|members|memberpress|mepr|civicrm|dlm_uploads|wp-job-manager-uploads|job-manager-uploads|buddypress|bp-attachments|rtmedia|avatars|group-avatars|ultimatemember|um|user-registration|wpdm|file-manager|invoices|wc-invoices|exports?|imports?|caldera|cf7-uploads|sensei|tutor|lifterlms|llms|peepso|wpjobboard|quform|happyforms|everest_forms|ws-form|nf-attachments|frm_uploads)$/i;

/** The kind of a folder right in uploads, by its name. */
export function uploadsKind(name: string): UploadsKind {
  if (/^\d{4}$/.test(name)) return 'media';
  if (PRIVATE.test(name)) return 'private';
  if (GENERATED.test(name)) return 'generated';
  return 'other';
}

/**
 * A folder of uploads as the view names it: 2026/11 for a month, a plain
 * folder name, a dot for the files right in uploads, and each of those on a
 * site of a network under sites/3/.
 */
export const UPLOADS_FOLDER = /^(sites\/\d{1,9}\/)?(\.|\d{4}\/\d{2}|[A-Za-z0-9_][A-Za-z0-9._-]{0,99})$/;
export const isUploadsFolder = (key: unknown): key is string => typeof key === 'string' && UPLOADS_FOLDER.test(key) && !key.split('/').includes('..');

/** A resized copy WordPress made of an image: photo-300x200.jpg. */
export const RESIZED_COPY = /-\d+x\d+\.(jpe?g|png|gif|webp|avif)$/i;

/** The folder a file of uploads belongs to, with the network site it is under. */
export function uploadsFolderOf(file: string): { key: string; kind: UploadsKind; site?: number } {
  let parts = file.split('/');
  let prefix = '';
  let site: number | undefined;
  if (parts[0] === 'sites' && /^\d+$/.test(parts[1] ?? '') && parts.length >= 3) {
    prefix = `sites/${parts[1]}/`;
    site = Number(parts[1]);
    parts = parts.slice(2);
  }
  const at = site === undefined ? {} : { site };
  if (parts.length === 1) return { key: `${prefix}.`, kind: 'other', ...at };
  if (parts.length >= 3 && /^\d{4}$/.test(parts[0] as string) && /^\d{2}$/.test(parts[1] as string)) return { key: `${prefix}${parts[0]}/${parts[1]}`, kind: 'media', ...at };
  return { key: `${prefix}${parts[0]}`, kind: uploadsKind(parts[0] as string), ...at };
}

/** One folder of the server's uploads next to what is here. */
export interface UploadsFolder {
  /** 2026/11, elementor, a dot for files right in uploads; sites/3/2026/11 on a network. */
  key: string;
  kind: UploadsKind;
  /** The network site it belongs to, when it is under sites/. */
  site?: number;
  /** On the server. */
  files: number;
  bytes: number;
  /** Not here yet. */
  newFiles: number;
  newBytes: number;
  /** Of the new ones, the resized copies WordPress can make again. */
  newResizedFiles: number;
  newResizedBytes: number;
  /** Here, and newer on the server. */
  changedFiles: number;
  changedBytes: number;
}

export interface UploadsCompare {
  host: string;
  /** The uploads folder on the server. */
  dir: string;
  files: number;
  bytes: number;
  folders: UploadsFolder[];
  /** Files that are here and newer on the server: the first of them, for the list. */
  changed: Array<{ file: string; bytes: number; changedAt: string }>;
  changedFiles: number;
  /** Files that are here and not on the server: the first of them. Nothing is done with them. */
  onlyHere: string[];
  onlyHereFiles: number;
  /** Folders with a name the copy does not take (a space, a bracket): left to a terminal. */
  unusual: number;
  /** Free on this disk. */
  freeBytes: number;
}

/** What a site has in wp-content/uploads here. */
export interface UploadsHere {
  exists: boolean;
  files: number;
  bytes: number;
  freeBytes: number;
  /** The last copy from the server that finished. */
  last?: { at: string; host: string };
}

/** Files larger than this are counted as they are listed; the first of each list the view shows. */
export const UPLOADS_LISTED = 200;
