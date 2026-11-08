// Finishes the public demo in dist-demo/ (npm run build:demo): the mockup, built as static
// files, with an .htaccess for Apache or LiteSpeed. The page's inline script is allowed by its
// hash, so the CSP needs no 'unsafe-inline' for scripts; nothing loads from another origin.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../dist-demo/', import.meta.url));
const html = readFileSync(`${out}index.html`, 'utf8');

const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  ([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
);
if (/\/healthz/.test(html)) throw new Error('dist-demo/index.html still has the panel-only script');

const csp = [
  "default-src 'self'",
  `script-src 'self' ${hashes.join(' ')}`.trim(),
  // CodeMirror and the UI library add <style> elements as they run.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

writeFileSync(
  `${out}.htaccess`,
  `# The devmagic-panel demo: static files only. Every answer comes from sample data in the
# visitor's browser tab; nothing runs on this server. Written by scripts/demo/finish.mjs
# in the devmagic-panel repository, so edit it there, not on the server.

Options -Indexes
DirectoryIndex index.html

<IfModule mod_rewrite.c>
  RewriteEngine On

  # HTTPS everywhere (a proxy in front may say so in X-Forwarded-Proto).
  RewriteCond %{HTTPS} !=on
  RewriteCond %{HTTP:X-Forwarded-Proto} !=https
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]

  # There is no API here: the demo never asks for one, and nothing should find one.
  RewriteRule ^api(/|$) - [R=404,L]

  # Every page of the app is index.html, so a link to /sites or a reload works.
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>

<IfModule mod_headers.c>
  Header always set Content-Security-Policy "${csp}"
  # A demo on sample data is not a page for search results; the tool's page is.
  Header always set X-Robots-Tag "noindex, nofollow"
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  Header always set Cross-Origin-Opener-Policy "same-origin"
  Header always set X-Frame-Options "DENY"
  Header always set Strict-Transport-Security "max-age=31536000"

  # The page is checked on every visit; hashed build files never change.
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  SetEnvIf Request_URI "^/assets/" DMP_ASSET
  Header set Cache-Control "public, max-age=31536000, immutable" env=DMP_ASSET
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain application/javascript application/json image/svg+xml
</IfModule>

AddType font/woff2 .woff2
`,
);
console.log(`dist-demo/ is ready: ${hashes.length} inline script(s) allowed by hash`);
