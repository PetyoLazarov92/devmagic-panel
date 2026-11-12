import { describe, expect, it } from 'vitest';
import { RunStore } from '../src/store.js';
import { changelogVersions, decodeEntities, htmlBlocks, wporgDetails, WporgDetailsMissing } from '../src/wporg-details.js';

describe('the HTML of a plugin readme', () => {
  it('becomes paragraphs, headings and lists with bold, code and http(s) links only', () => {
    const blocks = htmlBlocks('<h4>Usage</h4><p>Turn it <strong>on</strong> in <code>Settings</code>, see <a href="https://www.spellbook.example/docs">the docs</a>.</p><ul><li>One</li><li>Two <a href="javascript:alert(1)">bad</a></li></ul>');
    expect(blocks).toEqual([
      { kind: 'h', parts: [{ text: 'Usage' }] },
      { kind: 'p', parts: [{ text: 'Turn it ' }, { text: 'on', bold: true }, { text: ' in ' }, { text: 'Settings', code: true }, { text: ', see ' }, { text: 'the docs', href: 'https://www.spellbook.example/docs' }, { text: '.' }] },
      { kind: 'ul', items: [[{ text: 'One' }], [{ text: 'Two bad' }]] },
    ]);
  });

  it('leaves out scripts, styles, frames and images with what is in them, and keeps the text of other tags', () => {
    const blocks = htmlBlocks('<p>Before<script>steal()</script><style>p{}</style><iframe src="https://x.example"></iframe><img src="x.png" onerror="y()"> <span class="x">after</span></p>');
    expect(blocks).toEqual([{ kind: 'p', parts: [{ text: 'Before after' }] }]);
    expect(JSON.stringify(blocks)).not.toMatch(/steal|onerror|iframe/);
  });

  it('reads entities, line breaks, preformatted text and a list inside a list', () => {
    expect(decodeEntities('Tom &amp; Jerry &#8211; &#x2713; &hellip;')).toBe('Tom & Jerry - ✓ ...');
    expect(htmlBlocks('<p>one<br />two</p><pre><code>wp plugin list\nwp cache flush</code></pre><ol><li>A<ul><li>A.1</li></ul></li><li>B</li></ol>')).toEqual([
      { kind: 'p', parts: [{ text: 'one\ntwo' }] },
      { kind: 'pre', text: 'wp plugin list\nwp cache flush' },
      { kind: 'ol', items: [[{ text: 'A' }], [{ text: 'A.1' }], [{ text: 'B' }]] },
    ]);
  });
});

describe('a changelog', () => {
  it('is cut into versions at headings, all-bold lines and lines that are only a version and a date', () => {
    const versions = changelogVersions(htmlBlocks(`
      <p>Every change, newest first.</p>
      <h4>2.9.9 - 2026-11-10</h4><ul><li>Fixed: the export of entries</li></ul>
      <p><strong>2.9.8</strong></p><ul><li>Added: a field</li></ul>
      <p>2.9.7 (2026-10-02)</p><ul><li>Faster</li></ul>
      <p>2.9 is the version that added forms in blocks, and many more things.</p>`));
    expect(versions.map((v) => [v.version, v.note ?? null, v.blocks.length])).toEqual([
      ['', null, 1],
      ['2.9.9', '2026-11-10', 1],
      ['2.9.8', null, 1],
      ['2.9.7', '2026-10-02', 2],
    ]);
  });
});

describe('the details from WordPress.org', () => {
  const answer = {
    slug: 'spellbook-forms', name: 'Spellbook Forms &#8211; Wandworks', version: '2.9.9', requires: '6.3', tested: '6.8', requires_php: '7.4',
    last_updated: '2026-11-10 3:22pm GMT', active_installs: 10000, rating: 96, num_ratings: 120,
    sections: { description: '<p>Forms.</p>', changelog: '<h4>2.9.9</h4><ul><li>Fixed</li></ul>', installation: '', faq: '<h4>Why?</h4><p>Because.</p>' },
  };

  it('asks by slug only, keeps the fields the dialog shows and keeps the answer six hours', async () => {
    const store = new RunStore(':memory:');
    const asked: string[] = [];
    const fetcher = async (url: string) => (asked.push(url), { status: 200, body: answer });
    const details = await wporgDetails('plugin', 'spellbook-forms', store, fetcher, 1_000);
    expect(details).toMatchObject({ name: 'Spellbook Forms - Wandworks', version: '2.9.9', requires: '6.3', tested: '6.8', requiresPhp: '7.4', activeInstalls: 10000, rating: 96, page: 'https://wordpress.org/plugins/spellbook-forms/' });
    expect(details.changelog).toEqual([{ version: '2.9.9', blocks: [{ kind: 'ul', items: [[{ text: 'Fixed' }]] }] }]);
    expect(asked[0]).toContain('request[slug]=spellbook-forms');
    expect(asked[0]).not.toMatch(/version=|site|domain/);
    await wporgDetails('plugin', 'spellbook-forms', store, fetcher, 1_000 + 3_600_000);
    expect(asked).toHaveLength(1);
    await wporgDetails('plugin', 'spellbook-forms', store, fetcher, 1_000 + 7 * 3_600_000);
    expect(asked).toHaveLength(2);
    store.close();
  });

  it('says when WordPress.org has no such plugin, and asks nothing for a name that is not a slug', async () => {
    const store = new RunStore(':memory:');
    let asked = 0;
    const fetcher = async () => (asked++, { status: 404, body: { error: 'Plugin not found.' } });
    await expect(wporgDetails('plugin', 'wandworks-custom', store, fetcher)).rejects.toThrow(WporgDetailsMissing);
    await expect(wporgDetails('plugin', '../etc', store, fetcher)).rejects.toThrow('Not a slug');
    expect(asked).toBe(1);
    store.close();
  });
});
