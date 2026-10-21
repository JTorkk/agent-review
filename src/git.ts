import { execFile } from 'child_process';
import * as path from 'path';

/** The version of a file the review diff is compared against. */
export type BaseVersion =
  | { kind: 'tracked'; ref: string; text: string }
  | { kind: 'untracked'; ref: string }
  | { kind: 'nogit' };

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Reads the HEAD version of a file using the git CLI. Shelling out avoids
 * waiting on the built-in git extension to discover repositories.
 */
export async function readHeadVersion(fsPath: string): Promise<BaseVersion> {
  const cwd = path.dirname(fsPath);
  let ref: string;
  try {
    ref = (await git(['rev-parse', '--short', 'HEAD'], cwd)).trim();
  } catch {
    return { kind: 'nogit' };
  }
  try {
    const text = await git(['show', `HEAD:./${path.basename(fsPath)}`], cwd);
    return { kind: 'tracked', ref, text };
  } catch {
    return { kind: 'untracked', ref };
  }
}

export function describeBase(base: BaseVersion): string {
  switch (base.kind) {
    case 'tracked':
      return `HEAD (${base.ref})`;
    case 'untracked':
      return `new file, not in HEAD (${base.ref})`;
    case 'nogit':
      return 'not in a git repository, no diff';
  }
}
