import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ACTIVITY_SUMMARY_PROMPT_FILE = path.join(
  os.homedir(),
  '.clawworld',
  'activity-summary-prompt.md',
);

export const DEFAULT_ACTIVITY_SUMMARY_INSTRUCTIONS = [
  'You are generating a short, safe activity summary for a coding session.',
  'Decide whether the LATEST_USER_MESSAGE indicates a real, concrete work topic.',
  'Requirements:',
  '- Output only plain text.',
  '- If there is no clear, concrete work topic, output exactly NONE.',
  '- Output exactly NONE if the latest user message is a heartbeat, ping, pong, health check, keepalive, noop, status probe, connection test, or similar non-work probe.',
  '- Output exactly NONE if the latest user message is meta-only, transitional, too vague, missing, or cannot be understood confidently.',
  '- Do NOT infer a work topic from older context alone.',
  '- RECENT_CONTEXT is only supporting evidence; the latest user message must itself justify the activity.',
  '- Otherwise output exactly 1 short sentence, max 140 characters if possible.',
  '- Focus on the current task/activity, not generic effort.',
  '- Do not include secrets, credentials, file paths, repo names, usernames, code snippets, or long quotations.',
  '- Do not explain your reasoning.',
].join('\n');

export async function loadActivitySummaryInstructions(params?: {
  homeDir?: string;
}): Promise<string> {
  const homeDir = params?.homeDir ?? os.homedir();
  const promptFile = path.join(homeDir, '.clawworld', 'activity-summary-prompt.md');

  try {
    const raw = await fs.readFile(promptFile, 'utf8');
    const normalized = raw.trim();
    return normalized || DEFAULT_ACTIVITY_SUMMARY_INSTRUCTIONS;
  } catch {
    return DEFAULT_ACTIVITY_SUMMARY_INSTRUCTIONS;
  }
}
