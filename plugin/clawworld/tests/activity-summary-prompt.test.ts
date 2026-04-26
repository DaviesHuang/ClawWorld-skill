import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_ACTIVITY_SUMMARY_INSTRUCTIONS,
  buildActivitySummaryPrompt,
  loadActivitySummaryInstructions,
} from '../activity-summary-prompt.ts';

test('loads custom activity summary instructions from ~/.clawworld/activity-summary-prompt.md', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'clawworld-prompt-home-'));
  const promptDir = path.join(tempHome, '.clawworld');
  await fs.mkdir(promptDir, { recursive: true });
  await fs.writeFile(
    path.join(promptDir, 'activity-summary-prompt.md'),
    'Use exactly one short sentence and avoid implementation details.\n',
    'utf8',
  );

  const instructions = await loadActivitySummaryInstructions({ homeDir: tempHome });

  assert.equal(instructions, 'Use exactly one short sentence and avoid implementation details.');
});

test('falls back to default activity summary instructions when prompt file is missing', async () => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'clawworld-prompt-home-'));

  const instructions = await loadActivitySummaryInstructions({ homeDir: tempHome });

  assert.equal(instructions, DEFAULT_ACTIVITY_SUMMARY_INSTRUCTIONS);
});

test('builds summary prompt by prepending runtime context before the prompt file contents', () => {
  const prompt = buildActivitySummaryPrompt({
    latestUserPreview: 'user: fix the login issue',
    recentContext: '1. user: earlier context',
    instructions: 'Return NONE for keepalives. Otherwise write one short privacy-safe sentence.',
  });

  assert.match(prompt, /^LATEST_USER_MESSAGE:\nuser: fix the login issue\n\nRECENT_CONTEXT:\n1\. user: earlier context\n\nReturn NONE for keepalives\./);
});
