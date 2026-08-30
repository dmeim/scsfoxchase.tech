import { execFileSync } from 'node:child_process';

export function resolveBuildSha(env = process.env, cwd = process.cwd()) {
  const fromEnv =
    env.CF_VERSION_METADATA_ID ||
    env.WORKERS_CI_COMMIT_SHA ||
    env.GITHUB_SHA;
  if (fromEnv) {
    return fromEnv.trim().slice(0, 12);
  }
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .slice(0, 12);
  } catch {
    return 'unknown';
  }
}
