import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGitHub } from '../src/index.ts';

describe('fake github', () => {
  it('produces real git object ids', () => {
    const d = mkdtempSync(join(tmpdir(), 'fg-'));
    writeFileSync(join(d, 'a.md'), 'hello\n');
    const gitSha = execFileSync('git', ['hash-object', join(d, 'a.md')], { encoding: 'utf8' }).trim();
    const fake = new FakeGitHub({ files: { 'a.md': 'hello\n', 'x/y.md': 'z' } });
    expect(fake.files().get('a.md')).toBe(gitSha);
    execFileSync('git', ['init', '-q', d]);
    execFileSync('git', ['-C', d, 'add', 'a.md']);
    mkdtempSync(join(tmpdir(), 'x'));
    const tree = execFileSync('git', ['-C', d, 'write-tree'], { encoding: 'utf8' }).trim();
    const single = new FakeGitHub({ files: { 'a.md': 'hello\n' } });
    expect(single.commitObj(single.head()).tree).toBe(tree);
  });

  it('enforces fast-forward ref updates', async () => {
    const fake = new FakeGitHub();
    const auth = { authorization: 'token ghs_x' };
    const head = fake.head();
    const other = fake.writeCommit(fake.commitObj(head).tree, [], 'orphan');
    const r = await fake.fetch(`https://api.github.com/repos/octo/notes/git/refs/heads/main`, { method: 'PATCH', headers: auth, body: JSON.stringify({ sha: other, force: false }) });
    expect(r.status).toBe(422);
  });
});
