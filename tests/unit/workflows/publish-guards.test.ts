import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests the guard steps of .github/workflows/publish.yml (#196): the tip-of-main
// check (#188), the missing-tag check and the tag push. The test reads the real
// run text from the workflow and runs it with bash the way GitHub does, against
// a local bare repository as origin. No network, no new dependency.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const PUBLISH_YML = readFileSync(`${root}.github/workflows/publish.yml`, 'utf8');

// ---------------------------------------------------------------------------
// A strict reader for the YAML subset that publish.yml uses for its steps.
// It throws on anything it does not understand, so a reshaped workflow fails
// the test with a message instead of being skipped.

interface Step {
  line: number;
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  shell?: string;
  run?: string;
  env?: Record<string, string>;
  keys: string[];
}

// A step key not listed here, anywhere in publish.yml (for example
// `timeout-minutes:`), fails this file on purpose. Add it to STEP_KEYS only
// after checking that it does not change how the guard steps run.
const STEP_KEYS = new Set(['name', 'id', 'uses', 'if', 'shell', 'env', 'with', 'run']);
const SCALAR_KEYS = ['name', 'id', 'uses', 'if', 'shell'] as const;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function plainScalar(value: string, where: string): string {
  if (
    value === '' ||
    /^['"{[&*!|>%@`]/.test(value) ||
    value.includes(' #') ||
    value.endsWith(':')
  ) {
    throw new Error(`${where}: unsupported YAML value "${value}" (only plain scalars are read)`);
  }
  return value;
}

function parseJobSteps(text: string, job: string): Step[] {
  const lines = text.split('\n');
  const fail = (i: number, why: string): never => {
    throw new Error(`publish.yml line ${i + 1}: ${why}: "${lines[i] ?? ''}"`);
  };
  const jobs = lines.indexOf('jobs:');
  if (jobs < 0) throw new Error('publish.yml: no top-level "jobs:" key');
  let start = -1;
  for (let i = jobs + 1; i < lines.length; i++) {
    if (lines[i] === `  ${job}:`) {
      start = i;
      break;
    }
  }
  if (start < 0) throw new Error(`publish.yml: no job "${job}" under jobs`);
  // `defaults:` (run: shell: or working-directory:) at workflow level or under
  // the job changes how GitHub runs a step that has no shell: key, such as
  // Tag release. The run tests assume GitHub's own defaults, so refuse it.
  for (let d = 0; d < lines.length; d++) {
    const l = lines[d] ?? '';
    if (/^defaults:/.test(l)) fail(d, 'workflow-level "defaults:" is not supported');
  }
  for (let d = start + 1; d < lines.length; d++) {
    const l = lines[d] ?? '';
    if (l.trim() !== '' && indentOf(l) <= 2) break; // end of the job
    if (/^ {4}defaults:/.test(l)) fail(d, `"defaults:" under job "${job}" is not supported`);
  }
  let i = start + 1;
  for (; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() !== '' && indentOf(l) <= 2)
      throw new Error(`publish.yml: job "${job}" has no "    steps:" key`);
    if (l === '    steps:') break;
  }
  if (i >= lines.length) throw new Error(`publish.yml: job "${job}" has no "    steps:" key`);

  const steps: Step[] = [];
  let step: Step | undefined;
  i++;
  while (i < lines.length) {
    let l = lines[i] ?? '';
    if (l.includes('\t')) fail(i, 'tab character');
    if (l.trim() === '') {
      i++;
      continue;
    }
    const indent = indentOf(l);
    if (indent < 6) break; // end of the steps list
    if (indent === 6) {
      if (l.startsWith('      #')) {
        i++;
        continue;
      }
      if (!l.startsWith('      - ')) fail(i, 'expected a step item "- key: value"');
      step = { line: i + 1, keys: [] };
      steps.push(step);
      l = `        ${l.slice(8)}`;
    } else if (indent !== 8 || step === undefined) {
      fail(i, 'unexpected indentation in the steps list');
    }
    const current = step as Step;
    const m = /^ {8}([a-z-]+):(?: (.*))?$/.exec(l);
    if (!m) fail(i, 'expected "key: value" at 8 spaces');
    const key = (m as RegExpExecArray)[1] as string;
    const value = ((m as RegExpExecArray)[2] ?? '').trimEnd();
    if (!STEP_KEYS.has(key)) fail(i, `unknown step key "${key}"`);
    if (current.keys.includes(key)) fail(i, `duplicate step key "${key}"`);
    current.keys.push(key);
    i++;

    if (key === 'env' || key === 'with') {
      if (value !== '') fail(i - 1, `"${key}:" must be a block mapping`);
      const map: Record<string, string> = {};
      while (i < lines.length) {
        const e = lines[i] ?? '';
        if (e.trim() !== '' && indentOf(e) <= 8) break;
        if (e.trim() !== '' && key === 'env') {
          const em = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.+)$/.exec(e);
          if (!em) fail(i, 'expected "NAME: value" at 10 spaces in env');
          const [, name, raw] = em as RegExpExecArray;
          map[name as string] = plainScalar((raw as string).trimEnd(), `publish.yml line ${i + 1}`);
        }
        i++;
      }
      if (key === 'env') current.env = map;
      continue;
    }

    if (key === 'run') {
      if (value === '|') {
        const body: string[] = [];
        while (i < lines.length) {
          const b = lines[i] ?? '';
          if (b.trim() !== '' && indentOf(b) <= 8) break;
          body.push(b);
          i++;
        }
        while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
        const first = body.find((b) => b.trim() !== '');
        if (first === undefined) fail(i - 1, 'empty run block');
        const n = indentOf(first as string);
        current.run = `${body
          .map((b) => {
            if (b.trim() === '') return '';
            if (indentOf(b) < n)
              throw new Error(
                `publish.yml: run block of the step at line ${current.line} is under-indented`
              );
            return b.slice(n);
          })
          .join('\n')}\n`;
      } else if (/^[|>]/.test(value)) {
        fail(i - 1, `unsupported block style "${value}" (only "run: |" is read)`);
      } else {
        current.run = plainScalar(value, `publish.yml line ${i}`);
      }
      continue;
    }

    const scalar = plainScalar(value, `publish.yml line ${i}`);
    for (const k of SCALAR_KEYS) if (k === key) current[k] = scalar;
  }
  if (steps.length === 0) throw new Error(`publish.yml: job "${job}" has no steps`);
  return steps;
}

function stepKey(s: Step): string {
  return s.id ?? s.name ?? s.uses ?? `line ${s.line}`;
}

function findStep(steps: Step[], key: string): Step {
  const found = steps.filter((s) => s.id === key || (s.id === undefined && s.name === key));
  if (found.length !== 1) {
    throw new Error(
      `publish.yml: expected one step "${key}", found ${found.length} (steps: ${steps.map(stepKey).join(', ')})`
    );
  }
  return found[0] as Step;
}

// ---------------------------------------------------------------------------
// The steps under test and their exact conditions.

const PUBLISHED_FALSE = "steps.version-check.outputs.published == 'false'";
const PUBLISHED_TRUE = "steps.version-check.outputs.published == 'true'";
const IS_TIP = "steps.tip-check.outputs.tip == 'true'";
const PUBLISH_IF = `${PUBLISHED_FALSE} && ${IS_TIP}`;
const TAG_RELEASE_IF = `(${PUBLISH_IF}) || steps.tag-check.outputs.missing == 'true'`;
const GITHUB_SHA = '${{ github.sha }}';
const VERSION_EXPR = '${{ steps.version-check.outputs.version }}';

const steps = parseJobSteps(PUBLISH_YML, 'publish');
const tipCheck = findStep(steps, 'tip-check');
const tagCheck = findStep(steps, 'tag-check');
const tagRelease = findStep(steps, 'Tag release');

describe('publish.yml guard steps: structure (#196)', () => {
  it('keeps the exact if: conditions', () => {
    expect(tipCheck.if).toBe(PUBLISHED_FALSE);
    expect(findStep(steps, 'Publish to npm').if).toBe(PUBLISH_IF);
    expect(findStep(steps, 'Verify publish').if).toBe(PUBLISH_IF);
    expect(tagCheck.if).toBe(PUBLISHED_TRUE);
    expect(tagRelease.if).toBe(TAG_RELEASE_IF);
  });

  it('runs the checks with shell: bash and Tag release with the default shell', () => {
    expect(tipCheck.shell).toBe('bash');
    expect(tagCheck.shell).toBe('bash');
    expect(tagRelease.keys).not.toContain('shell');
  });

  it('passes values only through env:, never as ${{ }} in the run text', () => {
    expect(tipCheck.env).toEqual({ COMMIT_SHA: GITHUB_SHA });
    expect(tagCheck.env).toEqual({ COMMIT_SHA: GITHUB_SHA, VERSION: VERSION_EXPR });
    expect(tagRelease.env).toEqual({ VERSION: VERSION_EXPR });
    for (const s of [tipCheck, tagCheck, tagRelease]) {
      expect(s.run, stepKey(s)).toBeTypeOf('string');
      expect(s.run, stepKey(s)).not.toContain('${{');
    }
  });

  it('keeps the step order', () => {
    const order = steps.map(stepKey);
    const at = (key: string) => order.indexOf(stepKey(findStep(steps, key)));
    expect(at('tip-check')).toBe(at('version-check') + 1);
    expect(at('Publish to npm')).toBe(at('tip-check') + 1);
    expect(at('Verify publish')).toBe(at('Publish to npm') + 1);
    expect(at('tag-check')).toBeGreaterThan(at('Verify publish'));
    expect(at('Tag release')).toBeGreaterThan(at('tag-check'));
    expect(at('Tag release')).toBe(steps.length - 1);
  });
});

describe('publish.yml step reader: fails loudly on a reshaped workflow', () => {
  const sample = (body: string) =>
    `name: x\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${body}`;
  const good =
    "      - name: Check\n        id: tip-check\n        if: a == 'b'\n        run: |\n          echo hi\n\n          echo there\n";

  it('reads a well-formed step', () => {
    const [s] = parseJobSteps(sample(good), 'publish');
    expect(s).toMatchObject({
      name: 'Check',
      id: 'tip-check',
      if: "a == 'b'",
      run: 'echo hi\n\necho there\n',
    });
  });

  it('throws when the step id is renamed', () => {
    const parsed = parseJobSteps(
      sample(good.replace('id: tip-check', 'id: tip-check-2')),
      'publish'
    );
    expect(() => findStep(parsed, 'tip-check')).toThrow(/expected one step "tip-check", found 0/);
  });

  it('throws on a folded or chomped run block', () => {
    expect(() => parseJobSteps(sample(good.replace('run: |', 'run: >')), 'publish')).toThrow(
      /unsupported block style/
    );
    expect(() => parseJobSteps(sample(good.replace('run: |', 'run: |-')), 'publish')).toThrow(
      /unsupported block style/
    );
  });

  it('throws on an unknown key, a quoted value and an unexpected indent', () => {
    expect(() => parseJobSteps(sample(`${good}        timeout-minutes: 5\n`), 'publish')).toThrow(
      /unknown step key/
    );
    expect(() =>
      parseJobSteps(sample(good.replace("if: a == 'b'", `if: "a == 'b'"`)), 'publish')
    ).toThrow(/unsupported YAML value/);
    expect(() =>
      parseJobSteps(sample(good.replace('        id:', '         id:')), 'publish')
    ).toThrow(/unexpected indentation/);
  });

  it('throws on workflow-level defaults:', () => {
    const yml = `defaults:\n  run:\n    shell: sh\n${sample(good)}`;
    expect(() => parseJobSteps(yml, 'publish')).toThrow(
      /line 1: workflow-level "defaults:" is not supported/
    );
  });

  it('throws on defaults: under the job', () => {
    const yml = sample(good).replace(
      '    steps:\n',
      '    defaults:\n      run:\n        working-directory: sub\n    steps:\n'
    );
    expect(() => parseJobSteps(yml, 'publish')).toThrow(
      /line 5: "defaults:" under job "publish" is not supported/
    );
  });

  it('throws when the job or its steps are missing', () => {
    expect(() => parseJobSteps(sample(good), 'release')).toThrow(/no job "release"/);
    expect(() => parseJobSteps('jobs:\n  publish:\n    runs-on: x\n', 'publish')).toThrow(
      /no " {4}steps:" key/
    );
  });
});

// ---------------------------------------------------------------------------
// Running the run text against a local bare repository.

const missingTools = ['git', 'bash'].filter((tool) => spawnSync(tool, ['--version']).status !== 0);
if (missingTools.length > 0 && process.env.CI) {
  throw new Error(
    `publish.yml guard tests need ${missingTools.join(' and ')} on PATH; they are never skipped on CI`
  );
}
if (missingTools.length > 0) {
  console.warn(
    `Skipping the publish.yml guard run tests: ${missingTools.join(' and ')} not found on PATH.`
  );
}
const describeRun = missingTools.length > 0 ? describe.skip : describe;

const VERSION = '1.2.3';
const TAG_REF = `refs/tags/v${VERSION}`;

interface StepResult {
  status: number | null;
  log: string;
  output: string;
  summary: string;
}

describeRun('publish.yml guard steps: run against a local origin (#196)', () => {
  const tempDirs: string[] = [];
  let template = '';
  let OLD = '';
  let TIP = '';
  let DECOY = '';

  const gitEnv = (home: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? '',
    HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });

  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, env: gitEnv(cwd), encoding: 'utf8' });
    if (r.status !== 0)
      throw new Error(`git ${args.join(' ')} failed (${String(r.status)}): ${r.stderr}`);
    return r.stdout.trim();
  };

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-guards-'));
    tempDirs.push(dir);
    return dir;
  };

  beforeAll(() => {
    template = tempDir();
    const origin = join(template, 'origin.git');
    const work = join(template, 'work');
    git(template, 'init', '-q', '--bare', origin);
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(template, 'init', '-q', work);
    git(work, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
    OLD = git(work, 'rev-parse', 'HEAD');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
    TIP = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'main');
    DECOY = git(work, 'commit-tree', '-p', OLD, '-m', 'decoy', `${OLD}^{tree}`);
  });

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  // A fresh copy of the template repositories for one test.
  const repo = () => {
    const dir = tempDir();
    cpSync(template, dir, { recursive: true });
    const work = join(dir, 'work');
    git(work, 'remote', 'set-url', 'origin', join(dir, 'origin.git'));
    const origin = join(dir, 'origin.git');
    return {
      dir,
      work,
      git: (...args: string[]) => git(work, ...args),
      // Deletes main in the bare origin itself: a push cannot delete its HEAD branch.
      deleteMain: () => git(origin, 'update-ref', '-d', 'refs/heads/main'),
    };
  };

  const ENV_VALUES = (commitSha: string): Record<string, string> => ({
    [GITHUB_SHA]: commitSha,
    [VERSION_EXPR]: VERSION,
  });

  // Runs a step's run text as GitHub does: written to a file and passed to
  // `bash --noprofile --norc -eo pipefail {0}` for `shell: bash`, or to
  // `bash -e {0}` when the step has no shell (the Linux default).
  const runStep = (step: Step, work: string, commitSha: string): StepResult => {
    let shellArgs: string[];
    if (step.shell === 'bash') shellArgs = ['--noprofile', '--norc', '-eo', 'pipefail'];
    else if (step.shell === undefined) shellArgs = ['-e'];
    else throw new Error(`step ${stepKey(step)}: unsupported shell "${step.shell}"`);
    if (step.run === undefined) throw new Error(`step ${stepKey(step)} has no run text`);
    if (step.run.includes('${{'))
      throw new Error(`step ${stepKey(step)}: run text has a \${{ }} expression`);

    const dir = tempDir();
    const script = join(dir, 'step.sh');
    const output = join(dir, 'output');
    const summary = join(dir, 'summary');
    writeFileSync(script, step.run);
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const env: NodeJS.ProcessEnv = {
      ...gitEnv(dir),
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
    };
    const values = ENV_VALUES(commitSha);
    for (const [name, raw] of Object.entries(step.env ?? {})) {
      if (raw.includes('${{')) {
        const value = values[raw];
        if (value === undefined)
          throw new Error(`step ${stepKey(step)}: no test value for ${name}: ${raw}`);
        env[name] = value;
      } else {
        env[name] = raw;
      }
    }
    const r = spawnSync('bash', [...shellArgs, script], { cwd: work, env, encoding: 'utf8' });
    return {
      status: r.status,
      log: `${r.stdout}${r.stderr}`,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
    };
  };

  const notTipWarning = (tip: string) =>
    `::warning::Skipped publish and tag: a different commit (${tip}) is on main. Its run should publish; if that run failed, was cancelled or did not start, see CLAUDE.md, Releasing.`;
  const notTipSummary = (sha: string, tip: string) =>
    `Skipped npm publish and tag: commit ${sha} is not the tip of main (${tip}).\n`;
  const NO_TIP_ERROR = '::error::Could not read the tip of main from origin.';
  const TAG_PRESENT = `Tag v${VERSION} is on origin.`;
  const TAG_AT_TIP_WARNING = `::warning::Version ${VERSION} is on npm but tag v${VERSION} is missing on origin. Tagging this commit, the tip of main.`;
  const TAG_OFF_TIP_WARNING = `::warning::Tag v${VERSION} is missing on origin, but this commit is not the tip of main. Not tagging.`;
  const tagOffTipSummary = (sha: string, tip: string) =>
    `Did not push tag v${VERSION}: it is missing on origin, but commit ${sha} is not the tip of main (${tip}).\n`;

  describe('tip-check', () => {
    it('skips an older commit: tip=false, a warning and a summary line', () => {
      const r = repo();
      const res = runStep(tipCheck, r.work, OLD);
      expect(res.status).toBe(0);
      expect(res.output).toBe('tip=false\n');
      expect(res.log).toContain(notTipWarning(TIP));
      expect(res.summary).toBe(notTipSummary(OLD, TIP));
    });

    it('publishes the tip commit: tip=true and no summary', () => {
      const r = repo();
      const res = runStep(tipCheck, r.work, TIP);
      expect(res.status).toBe(0);
      expect(res.output).toBe('tip=true\n');
      expect(res.log).toContain(`Commit ${TIP} is the tip of main, publishing.`);
      expect(res.summary).toBe('');
    });

    it('matches refs/heads/main exactly, not a decoy ref whose name ends in it', () => {
      const r = repo();
      r.git('push', '-q', 'origin', `${DECOY}:refs/heads/foo/refs/heads/main`);
      // The decoy is listed by the plain ls-remote pattern.
      expect(r.git('ls-remote', 'origin', 'refs/heads/main').split('\n')).toHaveLength(2);

      const tip = runStep(tipCheck, r.work, TIP);
      expect(tip.status).toBe(0);
      expect(tip.output).toBe('tip=true\n');

      for (const sha of [OLD, DECOY]) {
        const res = runStep(tipCheck, r.work, sha);
        expect(res.status, sha).toBe(0);
        expect(res.output, sha).toBe('tip=false\n');
        expect(res.summary, sha).toBe(notTipSummary(sha, TIP));
      }
    });

    it('fails when origin has only the decoy and no main', () => {
      const r = repo();
      r.git('push', '-q', 'origin', `${DECOY}:refs/heads/foo/refs/heads/main`);
      r.deleteMain();
      const res = runStep(tipCheck, r.work, DECOY);
      expect(res.status).toBe(1);
      expect(res.log).toContain(NO_TIP_ERROR);
      expect(res.output).toBe('');
    });

    it('fails when origin has no main', () => {
      const r = repo();
      const empty = join(r.dir, 'empty.git');
      git(r.dir, 'init', '-q', '--bare', empty);
      r.git('remote', 'set-url', 'origin', empty);
      const res = runStep(tipCheck, r.work, TIP);
      expect(res.status).toBe(1);
      expect(res.log).toContain(NO_TIP_ERROR);
      expect(res.output).toBe('');
      expect(res.summary).toBe('');
    });

    it('fails with the ls-remote exit code when origin cannot be read (pipefail)', () => {
      const r = repo();
      r.git('remote', 'set-url', 'origin', join(r.dir, 'missing.git'));
      const res = runStep(tipCheck, r.work, TIP);
      // With `bash -e` alone, awk would succeed and the step would exit 1 with
      // the ::error:: line. pipefail stops it at the failing ls-remote.
      expect(res.status).toBe(128);
      expect(res.log).not.toContain(NO_TIP_ERROR);
      expect(res.output).toBe('');
    });
  });

  describe('tag-check', () => {
    it('finds a lightweight tag: missing=false', () => {
      const r = repo();
      r.git('tag', `v${VERSION}`, OLD);
      r.git('push', '-q', 'origin', `v${VERSION}`);
      const res = runStep(tagCheck, r.work, TIP);
      expect(res.status).toBe(0);
      expect(res.output).toBe('missing=false\n');
      expect(res.log).toContain(TAG_PRESENT);
      expect(res.summary).toBe('');
    });

    it('finds an annotated tag: missing=false', () => {
      const r = repo();
      r.git('tag', '-a', `v${VERSION}`, '-m', 'annotated', OLD);
      r.git('push', '-q', 'origin', `v${VERSION}`);
      expect(r.git('ls-remote', 'origin', `${TAG_REF}*`)).toContain(`${TAG_REF}^{}`);
      const res = runStep(tagCheck, r.work, TIP);
      expect(res.status).toBe(0);
      expect(res.output).toBe('missing=false\n');
      expect(res.log).toContain(TAG_PRESENT);
    });

    it('looks up the tag before main: a present tag passes without main', () => {
      const r = repo();
      r.git('tag', `v${VERSION}`, OLD);
      r.git('push', '-q', 'origin', `v${VERSION}`);
      r.deleteMain();
      const res = runStep(tagCheck, r.work, TIP);
      expect(res.status).toBe(0);
      expect(res.output).toBe('missing=false\n');
    });

    it('repairs a missing tag at the tip: missing=true and no summary', () => {
      const r = repo();
      const res = runStep(tagCheck, r.work, TIP);
      expect(res.status).toBe(0);
      expect(res.output).toBe('missing=true\n');
      expect(res.log).toContain(TAG_AT_TIP_WARNING);
      expect(res.summary).toBe('');
    });

    it('does not tag off the tip: missing=false, a warning and a summary line', () => {
      const r = repo();
      const res = runStep(tagCheck, r.work, OLD);
      expect(res.status).toBe(0);
      expect(res.output).toBe('missing=false\n');
      expect(res.log).toContain(TAG_OFF_TIP_WARNING);
      expect(res.summary).toBe(tagOffTipSummary(OLD, TIP));
    });

    it('treats a decoy ref whose name ends in the tag ref as a missing tag', () => {
      const r = repo();
      r.git('push', '-q', 'origin', `${DECOY}:refs/heads/x/${TAG_REF}`);
      expect(r.git('ls-remote', 'origin', TAG_REF)).toContain(`refs/heads/x/${TAG_REF}`);
      const res = runStep(tagCheck, r.work, TIP);
      expect(res.status).toBe(0);
      expect(res.output).toBe('missing=true\n');
    });

    it('matches main exactly when the tag is missing', () => {
      const r = repo();
      r.git('push', '-q', 'origin', `${DECOY}:refs/heads/foo/refs/heads/main`);
      const tip = runStep(tagCheck, r.work, TIP);
      expect(tip.output).toBe('missing=true\n');
      const decoy = runStep(tagCheck, r.work, DECOY);
      expect(decoy.output).toBe('missing=false\n');
      expect(decoy.summary).toBe(tagOffTipSummary(DECOY, TIP));
    });

    it('fails when the tag is missing and origin has no main', () => {
      const r = repo();
      r.deleteMain();
      const res = runStep(tagCheck, r.work, TIP);
      expect(res.status).toBe(1);
      expect(res.log).toContain(NO_TIP_ERROR);
      expect(res.output).toBe('');
    });

    it('fails with the ls-remote exit code when origin cannot be read (pipefail)', () => {
      const r = repo();
      r.git('remote', 'set-url', 'origin', join(r.dir, 'missing.git'));
      const res = runStep(tagCheck, r.work, TIP);
      expect(res.status).toBe(128);
      expect(res.output).toBe('');
    });
  });

  describe('Tag release', () => {
    it('pushes the tag for the checked-out tip commit, after which tag-check finds it', () => {
      const r = repo();
      r.git('checkout', '-q', '--detach', TIP);
      expect(runStep(tagCheck, r.work, TIP).output).toBe('missing=true\n');

      const res = runStep(tagRelease, r.work, TIP);
      expect(res.status, res.log).toBe(0);
      expect(r.git('ls-remote', 'origin', TAG_REF)).toBe(`${TIP}\t${TAG_REF}`);

      const again = runStep(tagCheck, r.work, TIP);
      expect(again.output).toBe('missing=false\n');
      expect(again.log).toContain(TAG_PRESENT);
    });
  });
});
