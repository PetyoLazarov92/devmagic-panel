import { describe, expect, it } from 'vitest';
import { classifyRepo, cleanDumps, cleanLinks, hostOf, prefillFromFacts, type RepoFacts } from '../src/org.js';

const facts = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  buildCommands: [],
  productionUrl: 'https://www.wandworks.example/',
  docsLocalSetup: null,
  wordpressVersion: null,
  phpVersion: null,
  branch: null,
  composer: true,
  npm: false,
  asanaLinks: [],
  googleLinks: [],
  dumpHints: [],
  notes: [],
  sources: [],
  ...over,
});

const repo = { sshUrl: 'git@github.com:wandworks/site.git', defaultBranch: 'main', kind: 'site' as const };

describe('classifyRepo', () => {
  it('tells sites, wp-content folders, themes and plugins apart by their top-level names', () => {
    expect(classifyRepo(['wp-content', 'index.php', '.gitignore'])).toBe('site');
    expect(classifyRepo(['wp-config-sample.php', 'wp-admin'])).toBe('site');
    expect(classifyRepo(['themes', 'plugins', 'mu-plugins'])).toBe('wp-content');
    expect(classifyRepo(['style.css', 'functions.php', 'inc'])).toBe('theme');
    expect(classifyRepo(['readme.txt', 'wandworks-forms.php'])).toBe('plugin');
    expect(classifyRepo(['package.json', 'src'])).toBe('other');
  });
});

describe('prefillFromFacts', () => {
  it('takes the build from the docs and the local setup from this machine, and no domains: those come from the dump', () => {
    const p = prefillFromFacts(repo, facts(), ['7.1.3', '6.8.3']);
    expect(p).toMatchObject({
      repoUrl: 'git@github.com:wandworks/site.git',
      branch: 'main',
      layout: 'site-root',
      coreVersion: '7.1.3',
      productionHint: 'www.wandworks.example',
      composer: true,
      npm: false,
      missing: [],
    });
    expect(p).not.toHaveProperty('domains');
    expect(prefillFromFacts({ ...repo, kind: 'theme' }, facts(), ['7.1.3']).productionHint).toBe('');
  });

  it('says where the docs differ, keeps your setup, and leaves what nothing answered empty', () => {
    const p = prefillFromFacts(
      { sshUrl: repo.sshUrl, kind: repo.kind },
      facts({ productionUrl: null, docsLocalSetup: 'Lando', wordpressVersion: '6.4.2', branch: 'develop' }),
      ['7.1.3'],
    );
    expect(p.productionHint).toBe('');
    expect(p.missing).toEqual(['a branch']);
    expect(p.coreVersion).toBe('7.1.3');
    expect(p.notes.join(' ')).toContain('WordPress 6.4.2');
    expect(p.notes.join(' ')).toContain('develop');
    expect(p.differences.join(' ')).toContain('Lando');
    // A core the docs name that you have is offered, not picked: the newest stays.
    const older = prefillFromFacts({ sshUrl: repo.sshUrl, kind: repo.kind }, facts({ wordpressVersion: '6.8.3' }), ['7.1.3', '6.8.3']);
    expect(older.coreVersion).toBe('7.1.3');
    expect(older.notes.join(' ')).toContain('You can pick 6.8.3 on the WordPress step');
    expect(prefillFromFacts(repo, null, []).missing).toEqual(['a WordPress core']);
  });
});

describe('what Claude answers is checked before use', () => {
  it('keeps only Asana and Google links over https, once each', () => {
    expect(
      cleanLinks(
        ['https://app.asana.com/0/123/456', 'http://app.asana.com/0/1', 'https://evil.example/asana'],
        ['https://docs.google.com/document/d/abc/edit', 'https://drive.google.com/drive/folders/xyz', 'https://docs.google.com/document/d/abc/edit', 'javascript:alert(1)'],
      ),
    ).toEqual(['https://app.asana.com/0/123/456', 'https://docs.google.com/document/d/abc/edit', 'https://drive.google.com/drive/folders/xyz']);
  });

  it('keeps only dumps with a Drive id and a dump name, newest first, with sane sizes and dates', () => {
    expect(
      cleanDumps([
        { fileId: '1AbCdEfGhIjKlMn', name: 'wandworks-2026-10-01.sql.gz', sizeBytes: 1234.4, modifiedAt: '2026-10-01T10:00:00Z', foundIn: 'Asana task' },
        { fileId: '1ZyXwVuTsRqPoNm', name: 'wandworks-2026-10-20.sql', sizeBytes: -1, modifiedAt: 'yesterday', foundIn: 'Doc' },
        { fileId: '../etc/passwd', name: 'x.sql', sizeBytes: 1, modifiedAt: null, foundIn: 'x' },
        { fileId: '1AbCdEfGhIjKlMx', name: 'notes.txt', sizeBytes: 1, modifiedAt: null, foundIn: 'x' },
      ]),
    ).toEqual([
      { fileId: '1AbCdEfGhIjKlMn', name: 'wandworks-2026-10-01.sql.gz', sizeBytes: 1234, modifiedAt: '2026-10-01T10:00:00Z', foundIn: 'Asana task' },
      { fileId: '1ZyXwVuTsRqPoNm', name: 'wandworks-2026-10-20.sql', sizeBytes: null, modifiedAt: null, foundIn: 'Doc' },
    ]);
  });

  it('reads production addresses as bare hosts only', () => {
    expect(hostOf('https://www.wandworks.example/path?x=1')).toBe('www.wandworks.example');
    expect(hostOf('wandworks.example')).toBe('wandworks.example');
    expect(hostOf('not a host')).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});
