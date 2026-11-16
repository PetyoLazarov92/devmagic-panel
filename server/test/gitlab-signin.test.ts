import { afterEach, describe, expect, it } from 'vitest';
import { glabSignIn, useGlabBinary } from '../src/repo-hosts/gitlab.js';
import { fakeExec } from './helpers.js';

afterEach(() => useGlabBinary(null));

describe('signing glab in with a token', () => {
  it('hands the token to glab on stdin only, then asks GitLab who that is', async () => {
    const fake = fakeExec({ 'glab auth login': { stdout: '' }, 'glab api --hostname gitlab.wandworks.test user': { stdout: JSON.stringify({ username: 'alex', name: 'Alex' }) } });
    const r = await glabSignIn(fake.exec, 'gitlab.wandworks.test', ' glpat-abcdefgh \n');
    expect(r).toEqual({ code: 0, stdout: 'glab is signed in to gitlab.wandworks.test as alex', stderr: '' });
    expect(fake.calls[0]).toMatchObject({ file: 'glab', args: ['auth', 'login', '--hostname', 'gitlab.wandworks.test', '--stdin'], input: 'glpat-abcdefgh\n' });
    expect(fake.calls.flatMap((c) => c.args).join(' ')).not.toContain('glpat');
  });

  it('says so when glab or GitLab refuses the token', async () => {
    const refused = fakeExec({ 'glab auth login': { code: 1, stderr: 'error validating token: 401 Unauthorized\n' } });
    expect((await glabSignIn(refused.exec, 'gitlab.com', 'glpat-wrongwrong')).stderr).toBe('glab did not take the token: error validating token: 401 Unauthorized');
    const nobody = fakeExec({ 'glab auth login': { stdout: '' }, 'glab api': { code: 1, stderr: 'HTTP 401 Unauthorized' } });
    const r = await glabSignIn(nobody.exec, 'gitlab.com', 'glpat-expiredxx');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('does not answer as you');
  });

  it("runs the panel's own glab once it installed one", async () => {
    useGlabBinary('/home/alex/.local/share/devmagic-panel/tools/glab/1.130.0/glab');
    const fake = fakeExec({ '/home/alex/.local/share/devmagic-panel/tools/glab/1.130.0/glab': { stdout: '' } });
    await glabSignIn(fake.exec, 'gitlab.com', 'glpat-abcdefgh');
    expect(fake.calls.every((c) => c.file.endsWith('/tools/glab/1.130.0/glab'))).toBe(true);
  });
});
