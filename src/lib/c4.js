import fs from 'node:fs';
import path from 'node:path';
import { sessionGroupForEndpoint } from './session-group.js';

// Old Core versions do not accept the flag. Keep the typed endpoint so the
// ownership query remains deterministic when that Core is later upgraded.
export function buildC4ReceiveArgs(content, endpoint, receivePath) {
  const group = sessionGroupForEndpoint(endpoint);
  const args = ['--channel', 'multica', '--endpoint', endpoint, '--json'];
  let supported = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(receivePath), 'c4-receive-options.json'), 'utf8'));
    supported = manifest?.options !== null && typeof manifest?.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, '--session-group');
  } catch { /* Missing manifest is the old-Core compatibility path. */ }
  if (group && supported) args.push('--session-group', group);
  args.push('--content', content);
  return args;
}
