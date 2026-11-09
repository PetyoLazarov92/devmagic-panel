import { join } from 'node:path';
import { Readable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { defaultConventions, readConventions, writeConventions } from '../src/assistant/conventions.js';
import { suggestWizard, toPreset } from '../src/assistant/wizard.js';
import { saveUpload } from '../src/sites/uploads.js';
import { fakeExec, wpSiteTree } from './helpers.js';

const OUT = {
  domains: [
    { production: 'www.wandworks.example', local: 'local.wandworks.example' },
    { production: 'not a host', local: 'local.shop.wandworks.example' },
    { local: 'www.wandworks.example' },
    { local: 'local.wandworks.example' },
  ],
  layout: 'wp-content' as const,
  branch: 'develop',
  core: { mode: 'wpcore' as const, version: '7.1.3' },
  deactivate: ['wp-rocket', 'Bad Slug!'],
  uploadsFrom: 'www.wandworks.example',
  build: { composer: true, npm: false },
  notes: 'Assumed the shop subdomain.',
};

describe('toPreset', () => {
  it('keeps only what the panel accepts: local names, real hosts, installed cores, plugin slugs', () => {
    expect(toPreset(OUT, ['7.1.3'])).toEqual({
      domains: [{ production: 'www.wandworks.example', local: 'local.wandworks.example' }, { local: 'local.shop.wandworks.example' }],
      placement: { dir: '', folder: 'wp-content' },
      extra: [],
      core: { mode: 'wpcore', version: '7.1.3' },
      deactivate: ['wp-rocket'],
      activate: [],
      uploadsFrom: 'www.wandworks.example',
      build: { composer: true, npm: false },
    });
    expect(toPreset(OUT, ['6.8.3']).core).toBeUndefined();
    expect(() => toPreset({ ...OUT, domains: [{ local: 'www.wandworks.example' }] }, [])).toThrow(/usable local domain/);
  });
});

describe('conventions.md', () => {
  it('defaults to this machine\'s setup until you save your own', () => {
    const t = wpSiteTree();
    const file = join(t.root, 'home/.config/devmagic-panel/conventions.md');
    const first = readConventions(file, t.config, t.wpcoreConf);
    expect(first.saved).toBe(false);
    expect(first.text).toContain(`Sites live in \`${t.config.WEB_DIR}/<primary domain>\``);
    expect(first.text).toContain(join(t.root, 'wp-cores'));
    expect(defaultConventions(t.config, t.wpcoreConf)).not.toMatch(/—/);
    writeConventions(file, '# Ours');
    expect(readConventions(file, t.config, t.wpcoreConf)).toEqual({ text: '# Ours\n', saved: true });
  });
});

describe('suggestWizard', () => {
  it('sends the description, conventions, repo docs, dump facts and similar sites, all redacted', async () => {
    const t = wpSiteTree();
    const url = 'git@github.com:wandworks/site.git';
    const { exec } = fakeExec({
      'git ls-remote': { stdout: 'ref: refs/heads/main\tHEAD\n' },
      'git clone': { stdout: '' },
      'git -C': (call) => (call.args.at(-1) === 'HEAD:README.md' ? { stdout: '# Wandworks\nDB password=hunter2\n' } : { code: 128, stderr: 'fatal: path does not exist' }),
    });
    const uploadsDir = join(t.root, 'uploads');
    const upload = await saveUpload(exec, uploadsDir, 'wandworks.sql', Readable.from(["CREATE TABLE `wp_options` (x int);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://www.wandworks.example','yes');\n"]));
    let sent = '';
    const claude = () =>
      ({
        messages: {
          parse: async (params: { messages: Array<{ content: string }> }) => {
            sent = params.messages[0]?.content ?? '';
            return { stop_reason: 'end_turn', parsed_output: { ...OUT, branch: '--evil' } };
          },
        },
      }) as unknown as Anthropic;
    const result = await suggestWizard(claude, undefined, 'claude-opus-5-5', {
      exec, workDir: join(t.root, 'tmp'), uploadsDir,
      sites: async () => [], cores: () => ['7.1.3'], conventions: () => '# Ours: local. prefix',
      preset: () => ({ domains: [{ local: 'local.wandworks.example' }], layout: 'wp-content', deactivate: [], build: { composer: false, npm: false } }),
    }, { description: 'Wandworks with its shop', repoUrl: url, uploadId: upload.id });

    const context = JSON.parse(sent);
    expect(context).toMatchObject({ description: 'Wandworks with its shop', conventions: '# Ours: local. prefix', repo: { url, branch: 'main', lastInstallHere: { layout: 'wp-content' } }, dump: { name: 'wandworks.sql', facts: { hosts: ['www.wandworks.example'] } }, installedCores: ['7.1.3'] });
    expect(sent).toContain('password=[redacted]');
    expect(sent).not.toContain('hunter2');
    expect(result.sent).toBe(sent);
    // A branch git could read as an option falls back to the repo's default.
    expect(result.branch).toBe('main');
    expect(result.preset.placement).toEqual({ dir: '', folder: 'wp-content' });
  });
});
