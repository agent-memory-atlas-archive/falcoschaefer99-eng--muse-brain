import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { assembleCandidate } from '../../ops/assemble-public-release.mjs';

// This gate's assembler lives at the OUTER git root (ops/assemble-public-release.mjs),
// same repo-layout landmine as ops/verify-public-release.mjs — see
// public-release-verify.spec.ts's own header comment and June's agent memory
// (muse-brain.md, "repo-layout landmine") for why. Path from here: test/ -> muse-brain/
// (nested pkg root) -> muse-brain/ (outer root) -> ops/.
const ASSEMBLE_SCRIPT = join(__dirname, '../../ops/assemble-public-release.mjs');

const tmpDirs: string[] = [];
function trackedTmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function writeFile(root: string, relPath: string, content: string): void {
	const abs = join(root, relPath);
	mkdirSync(join(abs, '..'), { recursive: true });
	writeFileSync(abs, content);
}

// A minimal, self-contained fake manifest -- these tests exercise assembleCandidate's own
// copy/filter logic, not the real repo manifest's actual allowlist (that's covered by the
// end-to-end tests below, which run the real script against the real manifest).
function fakeManifest(patterns: string[]) {
	return { allow: patterns.map((pattern) => ({ pattern, reason: 'test fixture' })) };
}

function runAssemble(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync('node', [ASSEMBLE_SCRIPT, ...args], { encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('assembleCandidate — the regression that matters: unlisted paths never reach the artifact', () => {
	it('copies an allowlisted file and omits an unlisted one', async () => {
		const source = trackedTmpDir('assemble-source-');
		const output = trackedTmpDir('assemble-output-');
		rmSync(output, { recursive: true, force: true }); // assembleCandidate must create it itself
		writeFile(source, 'README.md', '# ok\n');
		writeFile(source, 'muse-brain/daemon-runner/main.ts', 'export {};\n');

		const result = await assembleCandidate({
			sourceDir: source,
			outputDir: output,
			manifest: fakeManifest(['README.md'])
		});

		expect(result.status).toBe('ok');
		expect(result.shipping).toEqual(['README.md']);
		expect(result.unlisted).toEqual(['muse-brain/daemon-runner/main.ts']);
		expect(existsSync(join(output, 'README.md'))).toBe(true);
		expect(existsSync(join(output, 'muse-brain/daemon-runner/main.ts'))).toBe(false);
		expect(readFileSync(join(output, 'README.md'), 'utf8')).toBe('# ok\n');
	});

	it('ships nested allowlisted paths under a directory glob and nothing else in that directory tree that is unlisted', async () => {
		const source = trackedTmpDir('assemble-source-');
		const output = trackedTmpDir('assemble-output-');
		rmSync(output, { recursive: true, force: true });
		writeFile(source, 'muse-brain/src/index.ts', 'export {};\n');
		writeFile(source, 'muse-brain/src/nested/deep.ts', 'export {};\n');
		writeFile(source, 'muse-brain/benchmarks/golden/leaked.json', '{}\n');

		const result = await assembleCandidate({
			sourceDir: source,
			outputDir: output,
			manifest: fakeManifest(['muse-brain/src/**'])
		});

		expect(result.status).toBe('ok');
		expect(result.shipping.sort()).toEqual(['muse-brain/src/index.ts', 'muse-brain/src/nested/deep.ts']);
		expect(existsSync(join(output, 'muse-brain/src/nested/deep.ts'))).toBe(true);
		expect(existsSync(join(output, 'muse-brain/benchmarks/golden/leaked.json'))).toBe(false);
	});
});

describe('assembleCandidate — output directory safety', () => {
	it('refuses to write into a non-empty output directory without force, and touches nothing', async () => {
		const source = trackedTmpDir('assemble-source-');
		const output = trackedTmpDir('assemble-output-');
		writeFile(source, 'README.md', '# ok\n');
		writeFile(output, 'pre-existing.txt', 'do not touch me\n');

		const result = await assembleCandidate({
			sourceDir: source,
			outputDir: output,
			manifest: fakeManifest(['README.md']),
			force: false
		});

		expect(result.status).toBe('output-not-empty');
		expect(existsSync(join(output, 'pre-existing.txt'))).toBe(true);
		expect(readFileSync(join(output, 'pre-existing.txt'), 'utf8')).toBe('do not touch me\n');
		expect(existsSync(join(output, 'README.md'))).toBe(false);
	});

	it('an empty existing output directory is fine without force', async () => {
		const source = trackedTmpDir('assemble-source-');
		const output = trackedTmpDir('assemble-output-'); // exists, empty (mkdtempSync creates it)
		writeFile(source, 'README.md', '# ok\n');

		const result = await assembleCandidate({
			sourceDir: source,
			outputDir: output,
			manifest: fakeManifest(['README.md']),
			force: false
		});

		expect(result.status).toBe('ok');
		expect(existsSync(join(output, 'README.md'))).toBe(true);
	});

	it('force wipes a non-empty output directory and rebuilds it fresh, not merged with leftovers', async () => {
		const source = trackedTmpDir('assemble-source-');
		const output = trackedTmpDir('assemble-output-');
		writeFile(source, 'README.md', '# ok\n');
		writeFile(output, 'stale-from-a-previous-run.txt', 'leftover\n');

		const result = await assembleCandidate({
			sourceDir: source,
			outputDir: output,
			manifest: fakeManifest(['README.md']),
			force: true
		});

		expect(result.status).toBe('ok');
		expect(existsSync(join(output, 'README.md'))).toBe(true);
		expect(existsSync(join(output, 'stale-from-a-previous-run.txt'))).toBe(false);
	});
});

describe('assembleCandidate — symlinks are surfaced, never silently dropped', () => {
	it('reports a symlink in the result and does not copy it into the candidate', async () => {
		const source = trackedTmpDir('assemble-source-');
		const output = trackedTmpDir('assemble-output-');
		rmSync(output, { recursive: true, force: true });
		writeFile(source, 'README.md', '# ok\n');
		writeFile(source, 'target.txt', 'linked content\n');
		symlinkSync(join(source, 'target.txt'), join(source, 'README.link'));

		const result = await assembleCandidate({
			sourceDir: source,
			outputDir: output,
			manifest: fakeManifest(['README.md', 'target.txt', 'README.link'])
		});

		expect(result.status).toBe('ok');
		expect(result.symlinks).toEqual(['README.link']);
		expect(existsSync(join(output, 'README.md'))).toBe(true);
		expect(existsSync(join(output, 'README.link'))).toBe(false);
	});
});

describe('end-to-end assembler CLI (spawns the real script, against the real repo manifest)', () => {
	it('prints usage and exits 2 with no arguments', () => {
		const result = runAssemble([]);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('Usage:');
	});

	it('assembles a real candidate from a real allowlisted path and reports counts', () => {
		const source = trackedTmpDir('assemble-e2e-source-');
		const output = trackedTmpDir('assemble-e2e-output-');
		rmSync(output, { recursive: true, force: true });
		writeFile(source, 'README.md', '# muse-brain\n');
		writeFile(source, 'muse-brain/daemon-runner/main.ts', 'export {};\n'); // real, currently-unlisted path

		const result = runAssemble([source, output]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('source files:   2');
		expect(result.stdout).toContain('unlisted:       1');
		expect(result.stdout).toContain('SHIPPING:       1');
		expect(existsSync(join(output, 'README.md'))).toBe(true);
		expect(existsSync(join(output, 'muse-brain/daemon-runner/main.ts'))).toBe(false);
	});

	it('refuses a non-empty output directory via the CLI and exits 2', () => {
		const source = trackedTmpDir('assemble-e2e-source-');
		const output = trackedTmpDir('assemble-e2e-output-');
		writeFile(source, 'README.md', '# muse-brain\n');
		writeFile(output, 'already-here.txt', 'x\n');

		const result = runAssemble([source, output]);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain('not empty');
		expect(result.stderr).toContain('--force');
	});

	it('--force rebuilds a previously non-empty output directory', () => {
		const source = trackedTmpDir('assemble-e2e-source-');
		const output = trackedTmpDir('assemble-e2e-output-');
		writeFile(source, 'README.md', '# muse-brain\n');
		writeFile(output, 'stale.txt', 'x\n');

		const result = runAssemble([source, output, '--force']);

		expect(result.status).toBe(0);
		expect(existsSync(join(output, 'README.md'))).toBe(true);
		expect(existsSync(join(output, 'stale.txt'))).toBe(false);
	});
});

describe('LOW fix (2026-09-10): assemble-public-release.mjs runs the manifest self-consistency check too', () => {
	// verify-public-release.mjs runs findManifestSelfConsistencyErrors first thing; this
	// assembler didn't call it at all. Not a security gap on its own -- the gate re-validates
	// unconditionally regardless of what this script assembles -- but a broken manifest
	// should fail at the FIRST tool to load it, not one step later. The CLI hardcodes the
	// real repo manifest path (no injectable override), so a source-shape check is the
	// proportionate way to pin this wiring for a LOW-severity fix -- the check function
	// itself already has extensive direct unit coverage in public-release-verify.spec.ts.
	it('calls findManifestSelfConsistencyErrors before assembling', () => {
		const source = readFileSync(ASSEMBLE_SCRIPT, 'utf8');
		const importsIt = /import\s*\{[^}]*findManifestSelfConsistencyErrors[^}]*\}\s*from\s*["']\.\/verify-public-release\.mjs["']/.test(source);
		expect(importsIt).toBe(true);
		const checkCallIndex = source.indexOf('findManifestSelfConsistencyErrors(manifest)');
		const assembleCallIndex = source.indexOf('await assembleCandidate(');
		expect(checkCallIndex).toBeGreaterThan(-1);
		expect(assembleCallIndex).toBeGreaterThan(checkCallIndex);
	});
});
