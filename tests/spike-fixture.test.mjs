import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

test('spike skill is visible to git without exposing local skills', async () => {
  const skill = await readFile('skills/spike/SKILL.md', 'utf8');
  assert.match(skill, /PI_SPIKE_SKILL_MARKER/);
  const ignored = execFileSync(
    'git',
    ['check-ignore', 'skills/private/SKILL.md'],
    { encoding: 'utf8' }
  );
  assert.equal(ignored.trim(), 'skills/private/SKILL.md');
  // Tracked (survives being committed) and not ignored.
  const tracked = execFileSync(
    'git',
    ['ls-files', '--error-unmatch', 'skills/spike/SKILL.md'],
    { encoding: 'utf8' }
  );
  assert.equal(tracked.trim(), 'skills/spike/SKILL.md');
  assert.throws(
    () => execFileSync('git', ['check-ignore', '-q', 'skills/spike/SKILL.md']),
    'spike skill must not be ignored'
  );
});
