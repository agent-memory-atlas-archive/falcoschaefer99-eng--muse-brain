import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
	globToRegExp,
	matchesAnyPattern,
	loadManifest,
	findManifestSelfConsistencyErrors,
	sampleNeverAllowPath,
	listCandidateFiles,
	findUnlistedPaths,
	scanTextForContentMarkers,
	scanTextForDcCreator,
	findContentMarkersMissingContextScope,
	extractPrintableStrings,
	loadNameDenylistFragments,
	buildNameDenylistMarker,
	findExiftoolAuthorFindings,
	runExiftoolJson,
	fingerprintHash,
	partitionFindingsBySuppression,
	partitionSkippedLargeByException,
	sniffBinaryFormat,
	looksLikeBinaryContent,
	scanCandidateForPublicationRisks
} from '../../ops/verify-public-release.mjs';

// The gate this suite exercises lives at the OUTER git root (ops/verify-public-release.mjs,
// ops/public-release-manifest.json), not inside this nested package — see June's agent memory
// (muse-brain.md, "repo-layout landmine") for why. Path from here: test/ -> muse-brain/ (nested
// pkg root) -> muse-brain/ (outer root) -> ops/.
const VERIFY_SCRIPT = join(__dirname, '../../ops/verify-public-release.mjs');
const REAL_MANIFEST_PATH = join(__dirname, '../../ops/public-release-manifest.json');
const REAL_VERIFY_SCRIPT_SOURCE_PATH = join(__dirname, '../../ops/verify-public-release.mjs');

function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeFile(root: string, relPath: string, content: string): void {
	const abs = join(root, relPath);
	mkdirSync(join(abs, '..'), { recursive: true });
	writeFileSync(abs, content);
}

function writeBinaryFile(root: string, relPath: string, content: Buffer): void {
	const abs = join(root, relPath);
	mkdirSync(join(abs, '..'), { recursive: true });
	writeFileSync(abs, content);
}

// Builds a real, minimal, structurally-valid OLE2 Compound File Binary Format document
// (the legacy .doc/.xls/.ppt container) containing a single "\x05SummaryInformation"
// property-set stream with the Author property set, encoded per [MS-OLEPS] the way real
// Microsoft Office documents encode it: CodePage 1200 (Unicode) and the Author value as
// VT_LPWSTR — genuine UTF-16LE bytes on disk, not hand-waved. Mini-FAT is sidestepped
// entirely (Mini Stream Cutoff Size = 0) so every stream, however small, is allocated
// through the regular FAT — a standard trick for a minimal writer that avoids
// implementing the Mini FAT allocator. Verified empirically against the real exiftool
// binary before this was ported into a test fixture: `exiftool -j -a -G1` on a file this
// function builds reports `File:FileType: "DOC"` and `FlashPix:Author` with the exact
// value passed in — no `-overwrite_original` write step needed (unlike the TIFF fixture
// below), since exiftool cannot write OLE2/DOC metadata at all ("Writing of DOC files is
// not yet supported") — confirmed directly against the real binary. The Author value is
// baked in at construction time instead.
function buildMinimalOle2DocWithAuthor(authorName: string): Buffer {
	const SECTOR_SIZE = 512;
	const ENDOFCHAIN = 0xfffffffe;
	const FREESECT = 0xffffffff;
	const FATSECT = 0xfffffffd;
	const NOSTREAM = 0xffffffff;

	function le16(n: number): Buffer {
		const b = Buffer.alloc(2);
		b.writeUInt16LE(n >>> 0, 0);
		return b;
	}
	function le32(n: number): Buffer {
		const b = Buffer.alloc(4);
		b.writeUInt32LE(n >>> 0, 0);
		return b;
	}

	// FMTID for the SummaryInformation property set (Microsoft's own public [MS-OLEPS]
	// constant, hex only here -- undashed -- so this comment doesn't read as a matchable
	// UUID-shaped literal against this gate's own uuid-v4-shape marker; see the byte array
	// below for the actual value): F29F85E04FF91068AB9108002B27B3D9, encoded as a COM GUID
	// (first three fields little-endian, last field as-is).
	const FMTID_SUMMARY_INFO = Buffer.from([
		0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10,
		0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9
	]);

	function buildSummaryInfoStream(author: string): Buffer {
		const header = Buffer.concat([
			le16(0xfffe), // byte order
			le16(0), // version
			le32(0x00020006), // system identifier (arbitrary)
			Buffer.alloc(16), // CLSID (reserved, zero)
			le32(1) // NumPropertySets
		]);
		const fmtidOffsetListSize = 16 + 4;
		const propsetOffset = header.length + fmtidOffsetListSize;

		// Property 1: CodePage (PID 1), VT_I2 (2), value 1200 (Unicode) + 2-byte pad to align.
		const prop1Value = Buffer.concat([le32(2), le16(1200), Buffer.alloc(2)]);
		// Property 2: Author (PID 4), VT_LPWSTR (0x1F) — genuine UTF-16LE bytes.
		const nameU16 = Buffer.concat([Buffer.from(author, 'utf16le'), Buffer.alloc(2)]); // + null terminator
		const numWchars = nameU16.length / 2;
		let prop2Value = Buffer.concat([le32(0x1f), le32(numWchars), nameU16]);
		const pad = (4 - (prop2Value.length % 4)) % 4;
		if (pad > 0) prop2Value = Buffer.concat([prop2Value, Buffer.alloc(pad)]);

		const numProperties = 2;
		const tableSize = 4 + 4 + numProperties * 8;
		const prop1Offset = tableSize;
		const prop2Offset = prop1Offset + prop1Value.length;

		const propsetBody = Buffer.concat([
			le32(numProperties),
			le32(1),
			le32(prop1Offset), // PIDSI_CODEPAGE
			le32(4),
			le32(prop2Offset), // PIDSI_AUTHOR
			prop1Value,
			prop2Value
		]);
		const propsetSize = 4 + propsetBody.length;
		const propset = Buffer.concat([le32(propsetSize), propsetBody]);
		const fmtidOffsetEntry = Buffer.concat([FMTID_SUMMARY_INFO, le32(propsetOffset)]);
		return Buffer.concat([header, fmtidOffsetEntry, propset]);
	}

	const streamData = buildSummaryInfoStream(authorName);
	const streamSize = streamData.length;
	const nStreamSectors = Math.max(1, Math.ceil(streamSize / SECTOR_SIZE));

	// --- Header (512 bytes) ---
	const difat = Buffer.concat([le32(0), ...Array(108).fill(le32(FREESECT))]);
	const header = Buffer.concat([
		Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // signature
		Buffer.alloc(16), // CLSID
		le16(0x003e), // minor version
		le16(0x0003), // major version (3 -> 512-byte sectors)
		le16(0xfffe), // byte order
		le16(9), // sector shift (2^9 = 512)
		le16(6), // mini sector shift (unused here)
		Buffer.alloc(6), // reserved
		le32(0), // number of directory sectors (0 for major version 3)
		le32(1), // number of FAT sectors
		le32(1), // first directory sector location (sector 1)
		le32(0), // transaction signature number
		le32(0), // mini stream cutoff size = 0 -> force all streams into regular FAT
		le32(ENDOFCHAIN), // first mini FAT sector location (none)
		le32(0), // number of mini FAT sectors
		le32(ENDOFCHAIN), // first DIFAT sector location (none beyond header)
		le32(0), // number of DIFAT sectors
		difat
	]);

	// --- FAT sector (sector 0) ---
	const fatEntries: number[] = [FATSECT, ENDOFCHAIN];
	for (let i = 0; i < nStreamSectors; i++) {
		fatEntries.push(i === nStreamSectors - 1 ? ENDOFCHAIN : 2 + i + 1);
	}
	while (fatEntries.length < SECTOR_SIZE / 4) fatEntries.push(FREESECT);
	const fatSector = Buffer.concat(fatEntries.map(le32));

	// --- Directory sector (sector 1): 4 entries x 128 bytes ---
	function dirEntry(name: string, objType: number, color: number, left: number, right: number, child: number, startSector: number, size: number): Buffer {
		const nameUtf16 = Buffer.from(name, 'utf16le');
		let nameField = Buffer.concat([nameUtf16, Buffer.alloc(2)]);
		nameField = nameField.length >= 64 ? nameField.subarray(0, 64) : Buffer.concat([nameField, Buffer.alloc(64 - nameField.length)]);
		const nameLen = nameUtf16.length + 2;
		return Buffer.concat([
			nameField,
			le16(nameLen),
			Buffer.from([objType]),
			Buffer.from([color]),
			le32(left),
			le32(right),
			le32(child),
			Buffer.alloc(16), // CLSID
			le32(0), // state bits
			Buffer.alloc(8), // creation time
			Buffer.alloc(8), // modified time
			le32(startSector),
			le32(size),
			le32(0)
		]);
	}
	const rootEntry = dirEntry('Root Entry', 5, 1, NOSTREAM, NOSTREAM, 1, ENDOFCHAIN, 0);
	const streamEntry = dirEntry('\x05SummaryInformation', 2, 1, NOSTREAM, NOSTREAM, NOSTREAM, 2, streamSize);
	const emptyEntry = dirEntry('', 0, 0, NOSTREAM, NOSTREAM, NOSTREAM, 0, 0);
	const dirSector = Buffer.concat([rootEntry, streamEntry, emptyEntry, emptyEntry]);

	// --- stream data sectors ---
	const paddedStream = Buffer.concat([streamData, Buffer.alloc(nStreamSectors * SECTOR_SIZE - streamSize)]);

	return Buffer.concat([header, fatSector, dirSector, paddedStream]);
}

// The real, gitignored, local name denylist — see ops/.release-name-denylist.local.example.
// The gate treats an absent denylist as UNKNOWN, not clean, and fails loud (by design — see
// verify-public-release.mjs's own comment on this). That means any end-to-end test asserting
// a PASS needs this file provisioned, same as the private-key test below needs gitleaks
// installed: intentionally not skipped, so a missing local setup step never masquerades as a
// green test run.
const REAL_NAME_DENYLIST_PATH = join(__dirname, '../../ops/.release-name-denylist.local');

function nameDenylistProvisioned(): boolean {
	return existsSync(REAL_NAME_DENYLIST_PATH);
}

function runVerify(candidateDir: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync('node', [VERIFY_SCRIPT, candidateDir], { encoding: 'utf8' });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function gitleaksAvailable(): boolean {
	const result = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
	return !result.error;
}

function exiftoolAvailableForTest(): boolean {
	const result = spawnSync('exiftool', ['-ver'], { encoding: 'utf8' });
	return !result.error;
}

// Locates the real directory a binary resolves from via the CURRENT PATH -- no hardcoded
// machine-specific absolute path, portable across environments this test might run in.
function locateBinaryDir(binaryName: string): string | null {
	for (const dir of (process.env.PATH ?? '').split(':')) {
		if (dir && existsSync(join(dir, binaryName))) return dir;
	}
	return null;
}

// Kairo's technique: build a scratch PATH containing ONLY a symlink to the real gitleaks
// binary, so the real verify-public-release.mjs subprocess sees gitleaks as present and
// exiftool as ENOENT-missing -- cleanly and deterministically, without needing gitleaks
// and exiftool to be installed in different locations on the real machine (they are not,
// on this one: both live in /opt/homebrew/bin). process.execPath (not the bare string
// "node") is used for the OUTER spawn so locating the node binary itself never depends on
// the deliberately-narrowed child PATH.
function runVerifyWithOnlyGitleaksOnPath(candidateDir: string): { status: number | null; stdout: string; stderr: string } {
	const gitleaksDir = locateBinaryDir('gitleaks');
	if (!gitleaksDir) throw new Error('gitleaks is not installed in this environment. This test intentionally does not skip.');
	const scratchBinDir = trackedTmpDir('only-gitleaks-bin-');
	symlinkSync(join(gitleaksDir, 'gitleaks'), join(scratchBinDir, 'gitleaks'));
	const result = spawnSync(process.execPath, [VERIFY_SCRIPT, candidateDir], { encoding: 'utf8', env: { PATH: scratchBinDir } });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const tmpDirs: string[] = [];
function trackedTmpDir(prefix: string): string {
	const dir = makeTmpDir(prefix);
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe('globToRegExp / matchesAnyPattern', () => {
	it('matches a literal path exactly and rejects a suffix variant', () => {
		const re = globToRegExp('muse-brain/CHANGELOG.md');
		expect(re.test('muse-brain/CHANGELOG.md')).toBe(true);
		expect(re.test('muse-brain/CHANGELOG.md.bak')).toBe(false);
	});

	it('"dir/**" matches everything under dir, including nested paths, but not a sibling directory', () => {
		const re = globToRegExp('muse-brain/benchmarks/scripts/**');
		expect(re.test('muse-brain/benchmarks/scripts/cognitive-lane.mjs')).toBe(true);
		expect(re.test('muse-brain/benchmarks/scripts/sub/deep.mjs')).toBe(true);
		expect(re.test('muse-brain/benchmarks/golden/surfacer-rook.json')).toBe(false);
	});

	it('"*.sql" matches only within one path segment, by extension, regardless of filename', () => {
		const re = globToRegExp('muse-brain/migrations/*.sql');
		expect(re.test('muse-brain/migrations/017_agent_house_trust_layer.sql')).toBe(true);
		expect(re.test('muse-brain/migrations/nested/017_agent_house_trust_layer.sql')).toBe(false);
	});

	it('matchesAnyPattern is true if ANY pattern in the list matches', () => {
		expect(matchesAnyPattern('README.md', ['LICENSE', 'README.md'])).toBe(true);
		expect(matchesAnyPattern('SECRETS.md', ['LICENSE', 'README.md'])).toBe(false);
	});
});

describe('sampleNeverAllowPath', () => {
	it('turns a directory glob into a concrete sample path under that directory', () => {
		expect(sampleNeverAllowPath('muse-brain/benchmarks/golden/**')).toBe('muse-brain/benchmarks/golden/__consistency_check__');
	});

	it('leaves a literal (non-glob) pattern unchanged', () => {
		expect(sampleNeverAllowPath('ops/CODEX-BRIEF-daemon-box-migration.md')).toBe('ops/CODEX-BRIEF-daemon-box-migration.md');
	});
});

describe('loadManifest shape validation (2026-09-13 fix: generalized to all four lists)', () => {
	function writeManifest(dir: string, overrides: Record<string, unknown>): string {
		const manifest = {
			allow: [{ pattern: 'README.md', reason: 'ok' }],
			neverAllow: [{ pattern: 'secret.md', reason: 'ok' }],
			reviewedContentFindings: [],
			oversizedExceptions: [],
			...overrides
		};
		const manifestPath = join(dir, 'manifest.json');
		writeFileSync(manifestPath, JSON.stringify(manifest));
		return manifestPath;
	}

	it('accepts a well-formed manifest with all four lists populated', async () => {
		const dir = trackedTmpDir('manifest-ok-');
		const manifestPath = writeManifest(dir, {
			reviewedContentFindings: [{ fingerprint: 'a.md:email:abc123', reason: 'reviewed' }],
			oversizedExceptions: [{ fingerprint: 'big.bin:def456', reason: 'reviewed' }]
		});
		await expect(loadManifest(manifestPath)).resolves.toBeTruthy();
	});

	it('HIGH regression (Reeve/90): a neverAllow entry missing "pattern" produces the clean "Manifest is malformed" message, not a raw TypeError', async () => {
		const dir = trackedTmpDir('manifest-bad-neverallow-');
		const manifestPath = writeManifest(dir, { neverAllow: [{ reason: 'oops, no pattern' }] });
		await expect(loadManifest(manifestPath)).rejects.toThrow(/Manifest is malformed.*"neverAllow".*"pattern"/s);
	});

	it('a reviewedContentFindings entry missing "fingerprint" produces the clean message, not a TypeError', async () => {
		const dir = trackedTmpDir('manifest-bad-reviewed-');
		const manifestPath = writeManifest(dir, { reviewedContentFindings: [{ reason: 'oops, no fingerprint' }] });
		await expect(loadManifest(manifestPath)).rejects.toThrow(/Manifest is malformed.*"reviewedContentFindings".*"fingerprint"/s);
	});

	it('an oversizedExceptions entry missing "fingerprint" produces the clean message (post-2026-09-13 rename from "path")', async () => {
		const dir = trackedTmpDir('manifest-bad-oversized-');
		const manifestPath = writeManifest(dir, { oversizedExceptions: [{ path: 'x.bin', reason: 'stale shape' }] });
		await expect(loadManifest(manifestPath)).rejects.toThrow(/Manifest is malformed.*"oversizedExceptions".*"fingerprint"/s);
	});

	it('an allow entry missing "reason" still produces the clean message (pre-existing coverage, unaffected by the generalization)', async () => {
		const dir = trackedTmpDir('manifest-bad-allow-');
		const manifestPath = writeManifest(dir, { allow: [{ pattern: 'README.md' }] });
		await expect(loadManifest(manifestPath)).rejects.toThrow(/Manifest is malformed.*"allow".*"reason"/s);
	});
});

describe('findManifestSelfConsistencyErrors', () => {
	it('reports zero errors against the real, current manifest', async () => {
		const manifest = await loadManifest(REAL_MANIFEST_PATH);
		expect(findManifestSelfConsistencyErrors(manifest)).toEqual([]);
	});

	it('catches an allow glob that has been widened to swallow a neverAllow directory', async () => {
		const manifest = await loadManifest(REAL_MANIFEST_PATH);
		const broken = {
			...manifest,
			allow: [...manifest.allow, { pattern: 'muse-brain/benchmarks/**', reason: 'oops, too broad' }]
		};
		const errors = findManifestSelfConsistencyErrors(broken);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain('muse-brain/benchmarks/golden/**');
	});

	it('HIGH regression (2026-09-10): catches an extension-scoped allow glob that only matched the OLD single extensionless sample as clean — the most natural real way to write this mistake', async () => {
		const manifest = await loadManifest(REAL_MANIFEST_PATH);
		// Matches this manifest's own dominant per-file style (`*.sql`, `*.spec.ts`) --
		// this exact glob would have reported ZERO self-check errors under the old
		// single-extensionless-sample check, while still admitting the real leaked fixture,
		// muse-brain/benchmarks/golden/surfacer-rook.json.
		const broken = {
			...manifest,
			allow: [...manifest.allow, { pattern: 'muse-brain/benchmarks/golden/*.json', reason: 'oops, extension-scoped but still too broad' }]
		};
		const errors = findManifestSelfConsistencyErrors(broken);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some((e: string) => e.includes('muse-brain/benchmarks/golden/**'))).toBe(true);
		// The real fixture itself is admitted by the broken glob -- confirms this isn't a
		// false alarm on an unrelated sample path.
		expect(matchesAnyPattern('muse-brain/benchmarks/golden/surfacer-rook.json', broken.allow.map((e: { pattern: string }) => e.pattern))).toBe(true);
	});
});

describe('the real manifest, against real paths this repo actually has today', () => {
	// These pin the exact regression the whole gate exists to prevent: a real, currently
	// unreviewed/excluded path must stay excluded unless someone deliberately edits the
	// manifest. If any of these ever legitimately gets added to `allow`, this test should be
	// updated in the SAME diff that adds it — not treated as a stale test to delete.
	it('does NOT allow the leaked golden benchmark fixture', async () => {
		const manifest = await loadManifest(REAL_MANIFEST_PATH);
		const allowPatterns = manifest.allow.map((e: { pattern: string }) => e.pattern);
		expect(matchesAnyPattern('muse-brain/benchmarks/golden/surfacer-rook.json', allowPatterns)).toBe(false);
	});

	it('does NOT allow the CODEX daemon-box-migration brief (real Neon/Cloudflare identifiers)', async () => {
		const manifest = await loadManifest(REAL_MANIFEST_PATH);
		const allowPatterns = manifest.allow.map((e: { pattern: string }) => e.pattern);
		expect(matchesAnyPattern('ops/CODEX-BRIEF-daemon-box-migration.md', allowPatterns)).toBe(false);
	});

	it('does NOT allow muse-brain/daemon-runner/ — a real, currently-tracked directory that has never shipped publicly', async () => {
		const manifest = await loadManifest(REAL_MANIFEST_PATH);
		const allowPatterns = manifest.allow.map((e: { pattern: string }) => e.pattern);
		expect(matchesAnyPattern('muse-brain/daemon-runner/main.ts', allowPatterns)).toBe(false);
	});

	it('does NOT allow muse-brain/docs/images/rainer.png (2026-09-10: legally clear per Evangeline, excluded anyway as unreferenced dead weight -- nothing in this repo renders it)', async () => {
		const manifest = await loadManifest(REAL_MANIFEST_PATH);
		const allowPatterns = manifest.allow.map((e: { pattern: string }) => e.pattern);
		expect(matchesAnyPattern('muse-brain/docs/images/rainer.png', allowPatterns)).toBe(false);
	});
});

describe('listCandidateFiles / findUnlistedPaths', () => {
	it('finds a path that matches no allow pattern', async () => {
		const dir = trackedTmpDir('candidate-unlisted-');
		writeFile(dir, 'README.md', '# ok\n');
		writeFile(dir, 'muse-brain/daemon-runner/main.ts', 'export {};\n');
		const { files } = await listCandidateFiles(dir);
		const unlisted = findUnlistedPaths(files, ['README.md']);
		expect(unlisted).toEqual(['muse-brain/daemon-runner/main.ts']);
	});

	it('reports zero unlisted paths when every file matches an allow pattern', async () => {
		const dir = trackedTmpDir('candidate-listed-');
		writeFile(dir, 'README.md', '# ok\n');
		writeFile(dir, 'muse-brain/src/index.ts', 'export {};\n');
		const { files } = await listCandidateFiles(dir);
		const unlisted = findUnlistedPaths(files, ['README.md', 'muse-brain/src/**']);
		expect(unlisted).toEqual([]);
	});
});

describe("this gate's own source never trips its own content-marker scan", () => {
	// Regression guard for a real, found-in-this-task defect: CONTENT_MARKERS' doc comments
	// used to instantiate concrete matching examples (a real leaked production-id-shape
	// token, a real-shaped session id, a literal dc:creator/rdf:Seq/rdf:li XML example) to
	// explain what each marker catches. Since ops/verify-public-release.mjs is itself
	// allowlisted to ship, those examples matched the very markers they were documenting,
	// permanently failing the gate against its own source with no way to reach exit 0. Fixed
	// by describing each shape in prose instead of instantiating a literal that matches it.
	// This test reads the real file and would fail again the instant a future edit
	// re-introduces a concrete matching example in a comment.
	it('scanTextForContentMarkers and scanTextForDcCreator report zero findings against the real verify-public-release.mjs source', () => {
		const source = readFileSync(REAL_VERIFY_SCRIPT_SOURCE_PATH, 'utf8');
		const findings = [...scanTextForContentMarkers('ops/verify-public-release.mjs', source), ...scanTextForDcCreator('ops/verify-public-release.mjs', source)];
		expect(findings).toEqual([]);
	});
});

describe('findContentMarkersMissingContextScope (2026-09-13 fix: contextScope was a false guarantee -- claude-session-id had none)', () => {
	it('reports zero errors against the real CONTENT_MARKERS array', () => {
		expect(findContentMarkersMissingContextScope()).toEqual([]);
	});

	it('catches a marker with no contextScope at all', () => {
		// Deliberately malformed input (the whole point of this test) -- `as any` because the
		// real CONTENT_MARKERS array's inferred type requires contextScope on every entry, and
		// this fixture intentionally omits it.
		const markers = [{ name: 'no-scope-marker', regex: /x/g }] as any;
		const errors = findContentMarkersMissingContextScope(markers);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('no-scope-marker');
		expect(errors[0]).toContain('no contextScope');
	});

	it('catches a marker with an invalid contextScope value', () => {
		const markers = [{ name: 'typo-scope-marker', regex: /x/g, contextScope: 'Match' }] as any;
		const errors = findContentMarkersMissingContextScope(markers);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain('typo-scope-marker');
		expect(errors[0]).toContain('neither "match" nor "line"');
	});

	it('does not flag a marker declaring "match" or "line"', () => {
		const markers = [
			{ name: 'a', regex: /x/g, contextScope: 'match' },
			{ name: 'b', regex: /x/g, contextScope: 'line' }
		];
		expect(findContentMarkersMissingContextScope(markers)).toEqual([]);
	});
});

describe('extractPrintableStrings', () => {
	it('extracts printable ASCII runs >= minLen, dropping shorter runs and non-printable noise', () => {
		const buf = Buffer.concat([
			Buffer.from([0x00, 0x01]),
			Buffer.from('hello', 'ascii'),
			Buffer.from([0x00]),
			Buffer.from('ab', 'ascii'), // below the default minLen(4) — must be dropped
			Buffer.from([0x00]),
			Buffer.from('world!', 'ascii')
		]);
		expect(extractPrintableStrings(buf)).toEqual(['hello', 'world!']);
	});

	it('splits a run at a real newline byte, matching the `strings` CLI convention', () => {
		// This is WHY banner.png's pretty-printed XMP block extracts as one tag-plus-value
		// per run: each XML line in the real file has no embedded newline of its own.
		const buf = Buffer.from('line-one\nline-two', 'ascii');
		expect(extractPrintableStrings(buf)).toEqual(['line-one', 'line-two']);
	});

	it('HIGH regression (2026-09-10): a run continues through an embedded UTF-8 multi-byte character instead of splitting in half', () => {
		// A German-shaped fictional name straddling a run boundary (an umlaut, not a real
		// person -- this repo's established 'Jordan Q. Testcase' fixture with an umlaut
		// added) is exactly the shape that broke
		// findExiftoolAuthorFindings's second line of defense (the name-denylist buffer
		// scan) — the umlaut used to shred the run in half, so the name never appeared
		// intact in either extracted piece.
		const buf = Buffer.from('<pdf:Author>Jördan Q. Testcäse</pdf:Author>', 'utf8');
		expect(extractPrintableStrings(buf)).toEqual(['<pdf:Author>Jördan Q. Testcäse</pdf:Author>']);
	});

	it('the content-marker scan sees the full name once extractPrintableStrings stops shredding it at the umlaut', () => {
		const extracted = extractPrintableStrings(Buffer.from('<pdf:Author>Jördan Q. Testcäse</pdf:Author>', 'utf8')).join('\n');
		const findings = scanTextForContentMarkers('img.tiff', extracted);
		expect(findings.some((f: { pattern: string; match: string }) => f.pattern === 'metadata-author-field' && f.match.includes('Testcäse'))).toBe(true);
	});

	it('does not glue arbitrary high-byte binary noise into one giant run — only structurally valid UTF-8 sequences extend a run', () => {
		// Four bytes that do NOT form a valid UTF-8 sequence (an isolated continuation byte
		// with no lead byte, then three more non-lead bytes) sitting between two short ASCII
		// words — must not bridge them into one run.
		const buf = Buffer.concat([
			Buffer.from('wordone', 'ascii'),
			Buffer.from([0x80, 0x81, 0x82, 0x83]),
			Buffer.from('wordtwo', 'ascii')
		]);
		expect(extractPrintableStrings(buf)).toEqual(['wordone', 'wordtwo']);
	});
});

describe('sniffBinaryFormat (2026-09-10 CRITICAL fix: content-based binary classification)', () => {
	it('recognizes each documented magic number, and returns null for plain text', () => {
		expect(sniffBinaryFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
		expect(sniffBinaryFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
		expect(sniffBinaryFormat(Buffer.from('GIF89a', 'ascii'))).toBe('gif');
		expect(sniffBinaryFormat(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('tiff-little-endian');
		expect(sniffBinaryFormat(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe('tiff-big-endian');
		expect(sniffBinaryFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('webp');
		expect(sniffBinaryFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBe('wav');
		expect(sniffBinaryFormat(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]))).toBe('iso-bmff');
		expect(sniffBinaryFormat(Buffer.from([0x42, 0x4d]))).toBe('bmp');
		expect(sniffBinaryFormat(Buffer.from([0x00, 0x00, 0x01, 0x00]))).toBe('ico');
		expect(sniffBinaryFormat(Buffer.from('%PDF-1.7', 'ascii'))).toBe('pdf');
		expect(sniffBinaryFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
		expect(sniffBinaryFormat(Buffer.from([0x1f, 0x8b]))).toBe('gzip');
		expect(sniffBinaryFormat(Buffer.from('wOFF', 'ascii'))).toBe('woff');
		expect(sniffBinaryFormat(Buffer.from('wOF2', 'ascii'))).toBe('woff2');
		expect(sniffBinaryFormat(Buffer.from([0x00, 0x01, 0x00, 0x00]))).toBe('truetype-opentype');
		expect(sniffBinaryFormat(Buffer.from('SQLite format 3\0', 'ascii'))).toBe('sqlite');
		expect(sniffBinaryFormat(Buffer.from('OggS', 'ascii'))).toBe('ogg');
		expect(sniffBinaryFormat(Buffer.from('ID3', 'ascii'))).toBe('mp3-id3');
		expect(sniffBinaryFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm-mkv');
		expect(sniffBinaryFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('ole2-cfb');
		expect(sniffBinaryFormat(Buffer.from('This is ordinary prose, not a binary file.', 'ascii'))).toBeNull();
	});
});

describe('looksLikeBinaryContent (2026-09-13 CRITICAL fix: fail-closed default for an unrecognized format)', () => {
	it('a NUL byte anywhere in the window is binary', () => {
		expect(looksLikeBinaryContent(Buffer.from([0x41, 0x42, 0x00, 0x43]))).toBe(true);
	});

	it('plain ASCII prose with no control bytes is not binary', () => {
		expect(looksLikeBinaryContent(Buffer.from('This is ordinary prose, not a binary file.', 'ascii'))).toBe(false);
	});

	it('tab, LF, and CR do not count against the control-byte ratio, even in a short buffer', () => {
		const text = Buffer.from('line one\r\nline\ttwo\r\nline three\r\n', 'ascii');
		expect(looksLikeBinaryContent(text)).toBe(false);
	});

	it('more than 5% other C0 control bytes in the window is binary', () => {
		// 8 control bytes (0x01) in a 100-byte buffer -- 8% -- over the 5% threshold.
		const buf = Buffer.concat([Buffer.alloc(8, 0x01), Buffer.from('x'.repeat(92), 'ascii')]);
		expect(looksLikeBinaryContent(buf)).toBe(true);
	});

	it('exactly at or under the 5% threshold is not binary', () => {
		// 5 control bytes in a 100-byte buffer -- exactly 5%, not OVER the threshold.
		const buf = Buffer.concat([Buffer.alloc(5, 0x01), Buffer.from('x'.repeat(95), 'ascii')]);
		expect(looksLikeBinaryContent(buf)).toBe(false);
	});

	it('an empty buffer is not binary', () => {
		expect(looksLikeBinaryContent(Buffer.alloc(0))).toBe(false);
	});

	it('does not misclassify this gate\'s own real source as binary -- guards against the heuristic firing on legitimate source text (Unicode prose, em-dashes, etc.)', () => {
		const source = readFileSync(REAL_VERIFY_SCRIPT_SOURCE_PATH);
		expect(looksLikeBinaryContent(source.subarray(0, 512))).toBe(false);
		expect(looksLikeBinaryContent(source)).toBe(false);
	});
});

describe('CRITICAL fix (2026-09-13): the fail-closed default gives full binary treatment to a format neither sniffBinaryFormat nor BINARY_EXTENSIONS recognizes', () => {
	it('an unrecognized-format file that fails the text-plausibility check gets extractPrintableStrings + content-marker treatment, not the plain-text branch', async () => {
		const dir = trackedTmpDir('candidate-fail-closed-');
		// No known signature, no listed extension (.bin) -- only the NUL byte in its header
		// distinguishes it from plain text. A populated XMP-shaped author tag, sitting after
		// the NUL, so this test isolates "did it get binary treatment" from "does exiftool
		// exist" -- the buffer-scan pass runs unconditionally on anything classified binary.
		const planted = Buffer.concat([
			Buffer.from([0x00, 0x01, 0x02, 0x03]),
			Buffer.from('<pdf:Author>Jordan Q. Testcase</pdf:Author>', 'ascii')
		]);
		writeBinaryFile(dir, 'muse-brain/src/oops-unknown-format.bin', planted);

		const { findings, binaryFileCount } = await scanCandidateForPublicationRisks(dir, ['muse-brain/src/oops-unknown-format.bin'], { exiftoolAvailable: false });
		expect(binaryFileCount).toBe(1);
		expect(findings.some((f: { pattern: string; match: string }) => f.pattern === 'metadata-author-field' && f.match.includes('Jordan Q. Testcase'))).toBe(true);
	});

	it('a plain-text file with no NUL byte and few control characters still takes the ordinary text path (no false-positive binary reclassification)', async () => {
		const dir = trackedTmpDir('candidate-fail-closed-text-');
		writeFile(dir, 'muse-brain/src/ordinary.ts', 'export const ok = true;\n// a normal comment, no control bytes here\n');
		const { binaryFileCount } = await scanCandidateForPublicationRisks(dir, ['muse-brain/src/ordinary.ts'], { exiftoolAvailable: false });
		expect(binaryFileCount).toBe(0);
	});
});

describe('CRITICAL fix (2026-09-13): OLE2 CFB (.doc/.xls/.ppt) was invisible to every layer -- Michael\'s finding, the third instance of this defect class', () => {
	it('a real .doc with an Author property set (genuine UTF-16LE bytes on disk) now sniffs as ole2-cfb and FAILS the real gate end-to-end', () => {
		if (!exiftoolAvailableForTest()) {
			throw new Error(
				'exiftool is not installed in this environment. This test intentionally does not skip: ' +
				'a silently-skipped test for the exact CRITICAL defect class this whole gate exists to ' +
				'avoid is the same failure class as the defect itself. Install exiftool.'
			);
		}
		const dir = trackedTmpDir('candidate-ole2-doc-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		const docBuffer = buildMinimalOle2DocWithAuthor('Jordan Q. Testcase');
		// Sanity check on the fixture itself, matching the task's own wording: the name is
		// genuinely stored as UTF-16LE bytes, not ASCII -- if this ever failed, the fixture
		// wouldn't be testing what it claims to.
		expect(docBuffer.includes(Buffer.from('Jordan Q. Testcase', 'utf16le'))).toBe(true);
		expect(docBuffer.includes(Buffer.from('Jordan Q. Testcase', 'ascii'))).toBe(false);
		expect(sniffBinaryFormat(docBuffer.subarray(0, 32))).toBe('ole2-cfb');

		writeBinaryFile(dir, 'cli/templates/oops-leaked.doc', docBuffer);
		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('exiftool-author-field');
		expect(result.stderr).toContain('Jordan Q. Testcase');
	});
});

describe('CRITICAL-1 regression (2026-09-10): a real name in an unlisted-extension binary was invisible to every layer', () => {
	// The exact independently-reproduced defect: BINARY_EXTENSIONS is a 15-extension enum;
	// a .tiff (not in it) carrying classic (non-XMP) EXIF:Artist/EXIF:Copyright took the
	// plain-text branch, where those fields have no XML wrapper for the text-path patterns
	// to catch. scanCandidateForPublicationRisks(..., {exiftoolAvailable:true}) used to return
	// zero findings for this shape. This test drives the real exiftool binary to WRITE the
	// tags (same as the CRITICAL-1 repro that found the defect), then runs the real gate
	// subprocess end-to-end -- proving both the sniff-based classification AND the exiftool
	// structural pass actually catch it now, not just a unit-level reimplementation.
	it('FAILS on a real .tiff with EXIF:Artist/Copyright set via real exiftool', () => {
		if (!exiftoolAvailableForTest()) {
			throw new Error(
				'exiftool is not installed in this environment. This test intentionally does not skip: ' +
				'a silently-skipped test for the exact CRITICAL-1 regression is the same failure class ' +
				'this whole gate exists to avoid. Install exiftool.'
			);
		}
		const dir = trackedTmpDir('candidate-tiff-repro-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		const tiffPath = join(dir, 'muse-brain/src/oops-leaked-image.tiff');
		mkdirSync(join(tiffPath, '..'), { recursive: true });
		// Minimal valid little-endian TIFF: 8-byte header + a zero-entry IFD. Real, valid
		// enough for exiftool to write actual EXIF tags into -- no image data needed.
		const tiff = Buffer.alloc(8 + 2 + 4);
		tiff.write('II', 0, 'ascii');
		tiff.writeUInt16LE(42, 2);
		tiff.writeUInt32LE(8, 4);
		tiff.writeUInt16LE(0, 8);
		tiff.writeUInt32LE(0, 10);
		writeFileSync(tiffPath, tiff);
		const write = spawnSync(
			'exiftool',
			['-Artist=Jordan Q. Testcase', '-Copyright=Jordan Q. Testcase', '-overwrite_original', tiffPath],
			{ encoding: 'utf8' }
		);
		if (write.status !== 0) throw new Error(`exiftool test-fixture setup failed: ${write.stderr}`);

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('exiftool-author-field');
		expect(result.stderr).toContain('Jordan Q. Testcase');
	});
});

describe('sniff-coverage-gap alarm (2026-09-10): exiftool identifies real media that sniffBinaryFormat missed', () => {
	it('surfaces a loud finding when a BINARY_EXTENSIONS-matched file sniffs as unrecognized but exiftool reports a real FileType', async () => {
		if (!exiftoolAvailableForTest()) {
			throw new Error('exiftool is not installed in this environment. This test intentionally does not skip.');
		}
		const dir = trackedTmpDir('candidate-sniff-gap-');
		// A minimal, valid RTF document -- deliberately NOT in BINARY_SIGNATURES (out of the
		// fix mandate's named scope: images/fonts/archives/SQLite/audio/video containers).
		// Saved with a .eot extension so BINARY_EXTENSIONS' fast path, not the sniff, is what
		// triggers binary treatment -- isolating "sniff missed it but exiftool didn't" from
		// "nothing noticed it at all".
		const rtfPath = join(dir, 'muse-brain/src/oops-mislabeled.eot');
		mkdirSync(join(rtfPath, '..'), { recursive: true });
		writeFileSync(rtfPath, '{\\rtf1\\ansi Hello world}', 'ascii');

		const { findings } = await scanCandidateForPublicationRisks(dir, ['muse-brain/src/oops-mislabeled.eot'], { exiftoolAvailable: true });
		expect(findings.some((f: { pattern: string }) => f.pattern === 'sniff-coverage-gap')).toBe(true);
	});

	it('does NOT fire when sniffBinaryFormat correctly recognizes the format', async () => {
		const dir = trackedTmpDir('candidate-no-sniff-gap-');
		const pngPath = join(dir, 'muse-brain/src/ok.png');
		mkdirSync(join(pngPath, '..'), { recursive: true });
		writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
		const { findings } = await scanCandidateForPublicationRisks(dir, ['muse-brain/src/ok.png'], { exiftoolAvailable: false });
		expect(findings.some((f: { pattern: string }) => f.pattern === 'sniff-coverage-gap')).toBe(false);
	});
});

describe('missing-tool branch (2026-09-10, Kairo): exiftool absent, gitleaks present, via a real subprocess', () => {
	it('the top-level EXIFTOOL NOT INSTALLED message fires when a binary file is present and only gitleaks is on PATH', () => {
		const dir = trackedTmpDir('candidate-only-gitleaks-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		writeBinaryFile(dir, 'muse-brain/docs/images/x.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

		const result = runVerifyWithOnlyGitleaksOnPath(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('EXIFTOOL NOT INSTALLED');
		expect(result.stdout).not.toContain('GITLEAKS NOT INSTALLED');
	});
});

describe('MEDIUM regression (2026-09-10): the missing-binary exiftool status now has a handling branch', () => {
	it('adds a loud, blocking finding when exiftool disappears mid-scan even though exiftoolAvailable was true (a TOCTOU-style gap) -- deterministic in-process PATH override, not a real race', async () => {
		const dir = trackedTmpDir('candidate-missing-binary-');
		const pngPath = join(dir, 'muse-brain/src/x.png');
		mkdirSync(join(pngPath, '..'), { recursive: true });
		writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

		const originalPath = process.env.PATH;
		try {
			// isExiftoolAvailable() is not re-checked inside scanCandidateForPublicationRisks --
			// exiftoolAvailable is passed in as an option, so this simulates the real gap
			// (present at the top-level check, gone by the time this file's own exiftool
			// invocation runs) without needing an actual race.
			process.env.PATH = '/definitely/does/not/exist/on/this/machine';
			const { findings } = await scanCandidateForPublicationRisks(dir, ['muse-brain/src/x.png'], { exiftoolAvailable: true });
			expect(findings.some((f: { pattern: string }) => f.pattern === 'exiftool-missing-binary')).toBe(true);
		} finally {
			process.env.PATH = originalPath;
		}
	});
});

describe('scanTextForContentMarkers — metadata-author-field (binary XMP/PDF author tags)', () => {
	it('flags a populated pdf:Author tag — the exact shape banner.png shipped with', () => {
		const findings = scanTextForContentMarkers('img.png', '<pdf:Author>Jordan Q. Testcase</pdf:Author>');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'metadata-author-field')).toBe(true);
	});

	it('flags a populated xmp:CreatorTool tag', () => {
		const findings = scanTextForContentMarkers('img.png', '<xmp:CreatorTool>Canva (Renderer)</xmp:CreatorTool>');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'metadata-author-field')).toBe(true);
	});

	it('does not flag an empty tag', () => {
		const findings = scanTextForContentMarkers('img.png', '<pdf:Author></pdf:Author>');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'metadata-author-field')).toBe(false);
	});
});

describe('scanTextForDcCreator', () => {
	it('flags a populated dc:creator wrapped in rdf:Seq/rdf:li spanning multiple lines', () => {
		const text = [
			'<dc:creator>',
			'  <rdf:Seq>',
			'    <rdf:li>Jordan Q. Testcase</rdf:li>',
			'  </rdf:Seq>',
			'</dc:creator>'
		].join('\n');
		const findings = scanTextForDcCreator('img.png', text);
		expect(findings.length).toBe(1);
		expect(findings[0].pattern).toBe('metadata-dc-creator-field');
	});

	it('does not flag ordinary text with no dc:creator tag', () => {
		expect(scanTextForDcCreator('doc.md', 'nothing here').length).toBe(0);
	});
});

describe('name denylist (loadNameDenylistFragments / buildNameDenylistMarker)', () => {
	it('reports present:false and an empty fragment list when the file does not exist', async () => {
		const result = await loadNameDenylistFragments('/nonexistent/path/does-not-exist.local');
		expect(result).toEqual({ fragments: [], present: false });
	});

	it('strips comments, blank lines, and surrounding whitespace', async () => {
		const dir = trackedTmpDir('denylist-');
		const filePath = join(dir, 'denylist.local');
		writeFileSync(filePath, '# comment\n\n  Jordan Q. Testcase  \nTestcase\n');
		const result = await loadNameDenylistFragments(filePath);
		expect(result).toEqual({ fragments: ['Jordan Q. Testcase', 'Testcase'], present: true });
	});

	it('buildNameDenylistMarker returns null for an empty fragment list', () => {
		expect(buildNameDenylistMarker([])).toBeNull();
	});

	it('buildNameDenylistMarker matches a configured fragment case-insensitively, and its own marker name never carries the fragment value (never re-embed the value you exist to catch)', () => {
		const marker = buildNameDenylistMarker(['Jordan Q. Testcase']);
		expect(marker).not.toBeNull();
		expect(marker!.name).toBe('person-name-denylist');
		expect(marker!.name.toLowerCase()).not.toContain('jordan');
		const findings = scanTextForContentMarkers('doc.md', 'Bio: jordan q. testcase joined the team.', [marker!]);
		expect(findings.length).toBe(1);
		expect(findings[0].match.toLowerCase()).toBe('jordan q. testcase');
	});

	it('is scoped to "line", not the whole file (2026-09-10 HIGH fix)', () => {
		const marker = buildNameDenylistMarker(['Jordan Q. Testcase']);
		expect(marker!.contextScope).toBe('line');
	});

	it('HIGH regression (2026-09-10): approving occurrence A does not silently suppress occurrence B on a different line -- fix-first-then-pin, written against the FIXED (line-scoped) behavior', () => {
		const marker = buildNameDenylistMarker(['Jordan Q. Testcase']);
		const text = [
			'Bio: Jordan Q. Testcase joined the team in a harmless example sentence.',
			'Unrelated line with no match.',
			'A private note: Jordan Q. Testcase actually lives at a real address.'
		].join('\n');
		const findings = scanTextForContentMarkers('doc.md', text, [marker!]);
		expect(findings.length).toBe(2);
		expect(findings[0].fingerprint).not.toBe(findings[1].fingerprint);

		// A human reviews and approves ONLY occurrence A (the harmless example on line 1).
		const approvedEntry = { fingerprint: findings[0].fingerprint, reason: 'harmless example sentence, reviewed' };
		const { unreviewed, suppressed } = partitionFindingsBySuppression(findings, [approvedEntry]);
		expect(suppressed.length).toBe(1);
		expect(suppressed[0].line).toBe(1);
		// Occurrence B, on a different line, still surfaces as unreviewed -- the whole point
		// of scoping to "line" instead of the bare matched text.
		expect(unreviewed.length).toBe(1);
		expect(unreviewed[0].line).toBe(3);
	});
});

describe('findExiftoolAuthorFindings', () => {
	it('flags a populated Author field and ignores SourceFile', () => {
		const findings = findExiftoolAuthorFindings('img.png', {
			SourceFile: 'img.png',
			Author: 'Jordan Q. Testcase',
			FileType: 'PNG'
		});
		expect(findings.length).toBe(1);
		expect(findings[0].pattern).toBe('exiftool-author-field:Author');
		expect(findings[0].match).toBe('Jordan Q. Testcase');
	});

	it('does NOT flag ICC profile fields like ProfileCreator/ProfileCopyright — exact-match, not suffix-match', () => {
		// Regression guard for the false-positive this exact-match design avoids: these two
		// fields are boilerplate present in nearly every macOS-generated PNG (verified against
		// this repo's own muse-brain/docs/images/rainer-spec-sheet.png) and carry zero
		// personal-authorship signal. A suffix-based ("-creator"/"-copyright") heuristic would
		// wrongly flag both on every screenshot.
		const findings = findExiftoolAuthorFindings('img.png', {
			SourceFile: 'img.png',
			ProfileCreator: 'Apple Computer Inc.',
			ProfileCopyright: 'Copyright Apple Inc., 2026'
		});
		expect(findings).toEqual([]);
	});

	it('ignores an empty/whitespace-only value', () => {
		expect(findExiftoolAuthorFindings('img.png', { Author: '   ' })).toEqual([]);
	});

	it('MEDIUM-HIGH regression (2026-09-10): a -G1-grouped same-named tag in TWO DIFFERENT groups surfaces as TWO findings, not one silently overwriting the other', () => {
		// exiftool's own default (ungrouped) -j -a output collapses same-named tags across
		// groups -- verified empirically: writing both EXIF:Artist and XMP-tiff:Artist to
		// one real JPEG surfaced only the EXIF value in the JSON, the XMP one silently
		// absent. This is the -G1-grouped shape runExiftoolJson now requests instead.
		const findings = findExiftoolAuthorFindings('img.jpg', {
			SourceFile: 'img.jpg',
			'IFD0:Artist': 'EXIF Artist Name',
			'XMP-tiff:Artist': 'XMP Artist Name',
			'File:FileType': 'JPEG'
		});
		expect(findings.length).toBe(2);
		expect(findings.map((f: { match: string }) => f.match).sort()).toEqual(['EXIF Artist Name', 'XMP Artist Name']);
		expect(findings.map((f: { pattern: string }) => f.pattern).sort()).toEqual(['exiftool-author-field:IFD0:Artist', 'exiftool-author-field:XMP-tiff:Artist']);
	});

	it('still excludes a grouped ICC boilerplate field by its unqualified tag name', () => {
		const findings = findExiftoolAuthorFindings('img.png', {
			SourceFile: 'img.png',
			'ICC-header:ProfileCreator': 'Apple Computer Inc.'
		});
		expect(findings).toEqual([]);
	});
});

describe('runExiftoolJson + findExiftoolAuthorFindings integration (real exiftool, real -G1 output)', () => {
	// Kairo's finding: the pre-existing e2e "exact regression banner.png shipped" test uses
	// a byte-invalid PNG (deliberately, to test the buffer-scan fallback), so real exiftool
	// never successfully parses it there -- that integration had never actually executed
	// successfully in any test run. This drives a REAL, valid JPEG through the real
	// exiftool binary end-to-end, proving both the -G1 grouping fix and the integration
	// itself actually work, not just a reimplementation of the parsing logic in test scope.
	it('a real JPEG with EXIF:Artist AND XMP-tiff:Artist both set surfaces both fields through the real exiftool binary', () => {
		if (!exiftoolAvailableForTest()) {
			throw new Error('exiftool is not installed in this environment. This test intentionally does not skip.');
		}
		const dir = trackedTmpDir('candidate-real-jpeg-dual-group-');
		const jpegPath = join(dir, 'real.jpg');
		// A minimal, valid, byte-correct baseline JPEG (SOI/APP0/DQT/SOF0/DHT/SOS/EOI for a
		// 1x1 grayscale image) -- real enough for exiftool to parse and write real EXIF/XMP
		// tags into, unlike the deliberately-invalid PNG used elsewhere in this suite.
		const jpegHex =
			'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1918' +
			'130f0f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1fffc0000b' +
			'080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b510' +
			'0002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1' +
			'f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a6364656667' +
			'68696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c' +
			'3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00f7' +
			'ffd9';
		writeBinaryFile(dir, 'real.jpg', Buffer.from(jpegHex, 'hex'));
		const write = spawnSync(
			'exiftool',
			['-EXIF:Artist=EXIF Artist Name', '-XMP-tiff:Artist=XMP Artist Name', '-overwrite_original', jpegPath],
			{ encoding: 'utf8' }
		);
		if (write.status !== 0) throw new Error(`exiftool test-fixture setup failed: ${write.stderr}`);

		const exifResult = runExiftoolJson(jpegPath);
		expect(exifResult.status).toBe('ok');
		const findings = findExiftoolAuthorFindings('real.jpg', exifResult.data);
		expect(findings.length).toBe(2);
		expect(findings.map((f: { match: string }) => f.match).sort()).toEqual(['EXIF Artist Name', 'XMP Artist Name']);
	});
});

describe('scanTextForContentMarkers', () => {
	it('flags the real generateId() shape (the exact form a leaked evidence_id took in benchmarks/golden)', () => {
		const findings = scanTextForContentMarkers('fixture.json', 'evidence_ids: ["obs_20260711131056_eb461fb4"]');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'production-id-shape')).toBe(true);
	});

	it('flags a Claude Code session id shape', () => {
		const findings = scanTextForContentMarkers('doc.md', 'Claude-Session: https://claude.ai/code/session_01DRspNF2aKPhT3g5ZyPErp6');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'claude-session-id')).toBe(true);
	});

	it('flags an email address', () => {
		const findings = scanTextForContentMarkers('doc.md', 'contact: falco@example.com');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
	});

	it('does not flag the literal git@github.com SSH remote prefix (narrow, deliberate carve-out -- this repo tracks it in docs/scripts/tests as a plain git remote URL, not a real address)', () => {
		const findings = scanTextForContentMarkers('doc.md', 'git remote add origin git@github.com:funkatorium/dupin-service.git');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(false);
	});

	it('still flags a real-looking address at the SAME github.com domain -- the carve-out is the exact SSH prefix, not the whole domain', () => {
		const findings = scanTextForContentMarkers('doc.md', 'contact: someone@github.com');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
	});

	it('still flags an address whose local part merely CONTAINS "git" as a substring of something longer', () => {
		const findings = scanTextForContentMarkers('doc.md', 'contact: mygit@github.com');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
	});

	describe('git@github.com carve-out: smuggling probe (Michael\'s audit, 2026-09-10)', () => {
		// A real gap the audit found: the carve-out used to be bounded by `\b` on its
		// trailing edge, and `\b` sits between "com" and "." just as happily as between
		// "com" and a real word boundary -- so the literal matched as a PREFIX of a longer
		// domain too. Fixed by rejecting any domain-continuation character after the
		// literal instead of relying on `\b`. This is the pinned regression for that fix,
		// plus the cases the audit confirmed already worked (kept here as intentional
		// coverage rather than "passing by accident of exact-ASCII matching").
		it('FLAGS git@github.com when it is a PREFIX of a longer domain (the smuggling case: a phishing-domain shape, not an accidental-leak shape, but the comment above promised this marker still fires here)', () => {
			const findings = scanTextForContentMarkers('doc.md', 'contact: git@github.com.evil.io');
			expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
		});

		it('still does not flag the bare literal at end-of-string or before a non-domain character (the carve-out itself must survive the fix)', () => {
			const findings = scanTextForContentMarkers('doc.md', 'git@github.com');
			expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(false);
		});

		it('FLAGS a different host with the same username ("git@gitlab.com")', () => {
			const findings = scanTextForContentMarkers('doc.md', 'contact: git@gitlab.com');
			expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
		});

		it('FLAGS an uppercase or mixed-case variant -- the regex has no `i` flag, deliberately: the real git CLI always emits this literal lowercase', () => {
			const upper = scanTextForContentMarkers('doc.md', 'contact: GIT@GITHUB.COM');
			const mixed = scanTextForContentMarkers('doc.md', 'contact: Git@Github.Com');
			expect(upper.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
			expect(mixed.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
		});

		it('FLAGS a dotless-i homoglyph substituted into "git" -- the carve-out\'s own literal comparison stays exact-ASCII and non-normalizing (homoglyph defense was never its job), so it never recognizes this as the exempted literal and the match falls through to the general pattern', () => {
			// U+0131 LATIN SMALL LETTER DOTLESS I, not U+0069 "i". Since the 2026-09-10 HIGH
			// Unicode fix, \p{L} recognizes this codepoint as a letter, so the match is now
			// the FULL "gıt@github.com" (not a truncated suffix the way pre-Unicode-fix ASCII
			// matching would have produced) -- worth pinning explicitly, since it's a second,
			// independent reason this still fires here.
			const findings = scanTextForContentMarkers('doc.md', 'contact: gıt@github.com');
			expect(findings.some((f: { pattern: string; match: string }) => f.pattern === 'email' && f.match === 'gıt@github.com')).toBe(true);
		});
	});

	describe('MEDIUM regression (2026-09-10): the leading boundary no longer drops or blinds itself to a punctuation-only local-part prefix', () => {
		// The old leading `\b` only fires at a transition between a \w char and a non-\w
		// char -- none of `. _ % + -` count as \w, so a local part STARTING with one of
		// them had no boundary at its true start and silently truncated.
		it('does not truncate a local part starting with a leading dot', () => {
			const findings = scanTextForContentMarkers('doc.md', '.john@test.com');
			expect(findings[0].match).toBe('.john@test.com');
		});

		it('does not truncate a local part starting with a leading plus', () => {
			const findings = scanTextForContentMarkers('doc.md', '+john@test.com');
			expect(findings[0].match).toBe('+john@test.com');
		});

		it('does not truncate a local part starting with a leading hyphen', () => {
			const findings = scanTextForContentMarkers('doc.md', '-john@test.com');
			expect(findings[0].match).toBe('-john@test.com');
		});

		it('matches a local part made entirely of punctuation, which used to fail to match at all', () => {
			const findings = scanTextForContentMarkers('doc.md', '+.-%@example.com');
			expect(findings.length).toBe(1);
			expect(findings[0].match).toBe('+.-%@example.com');
		});

		it('the fingerprint-collision this boundary bug rode on is closed: three differently-prefixed local parts no longer share one fingerprint', () => {
			const dot = scanTextForContentMarkers('doc.md', '.john@test.com')[0];
			const plus = scanTextForContentMarkers('doc.md', '+john@test.com')[0];
			const hyphen = scanTextForContentMarkers('doc.md', '-john@test.com')[0];
			const fingerprints = new Set([dot.fingerprint, plus.fingerprint, hyphen.fingerprint]);
			expect(fingerprints.size).toBe(3);
		});
	});

	describe('HIGH regression (2026-09-10): the email marker is Unicode-aware -- German umlauts are routine in this business, not exotic', () => {
		it('flags a German address with an umlaut in both the local part and the domain', () => {
			const findings = scanTextForContentMarkers('doc.md', 'kontakt an büro@münchen.de bitte');
			expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(true);
			expect(findings.find((f: { pattern: string }) => f.pattern === 'email')!.match).toBe('büro@münchen.de');
		});

		it('does not silently truncate a local part starting with an umlaut', () => {
			const findings = scanTextForContentMarkers('doc.md', 'füchte@example.com');
			expect(findings[0].match).toBe('füchte@example.com');
		});

		it('the git@github.com carve-out is unaffected by the Unicode widening -- still exempt, still ASCII, still ungreedy about the domain', () => {
			const findings = scanTextForContentMarkers('doc.md', 'git remote add origin git@github.com:funkatorium/dupin-service.git');
			expect(findings.some((f: { pattern: string }) => f.pattern === 'email')).toBe(false);
		});
	});

	it('flags an IBAN-shaped token', () => {
		const findings = scanTextForContentMarkers('doc.md', 'IBAN: DE89370400440532013000');
		expect(findings.some((f: { pattern: string }) => f.pattern === 'iban-shape')).toBe(true);
	});

	it('does not flag ordinary prose with no id-shaped or PII-shaped tokens', () => {
		const findings = scanTextForContentMarkers('README.md', 'This project ships a Cloudflare Worker and a CLI.\nNo secrets here.\n');
		expect(findings).toEqual([]);
	});

	it('produces a fingerprint of the form path:pattern:hash-of-matched-text, stable across identical re-scans and across a benign line shift of the SAME literal', () => {
		const text = 'line one\nobs_20260711131056_eb461fb4\n';
		const shiftedText = 'an inserted line above it\nline one\nobs_20260711131056_eb461fb4\n';
		const first = scanTextForContentMarkers('a.md', text);
		const second = scanTextForContentMarkers('a.md', text);
		const shifted = scanTextForContentMarkers('a.md', shiftedText);
		expect(first[0].fingerprint).toBe(`a.md:production-id-shape:${fingerprintHash('obs_20260711131056_eb461fb4')}`);
		expect(first[0].fingerprint).toBe(second[0].fingerprint);
		// The regression the prior line-keyed scheme could not survive: the SAME literal,
		// now one line further down, still produces the SAME fingerprint -- no re-review
		// needed for a purely cosmetic shift.
		expect(shifted[0].fingerprint).toBe(first[0].fingerprint);
	});
});

describe('fingerprint fail-open regression (2026-09-10): a stale line-keyed suppression must not swallow a NEW match', () => {
	// This is the regression the whole change exists to fix. The prior fingerprint scheme
	// was `${path}:${pattern}:${line}` -- no matched text in the key at all. Proven
	// empirically in the prior round: inserting one regression test into this very spec
	// shifted line numbers enough to silently break 11 of 12 baseline entries. Put those
	// two facts together: a stale entry approved for one value at one line will keep
	// suppressing whatever DIFFERENT value a future edit happens to land on that same
	// line, in the same file, forever -- silently. That is fail-open inside a gate whose
	// whole design point is failing closed.
	it('does NOT suppress a different match that now occupies a previously-approved line number', () => {
		// A stale entry in the OLD line-only shape, as if carried over unedited from before
		// this fix -- exactly the shape that used to live in reviewedContentFindings. Reuses
		// the literal 'someone@example.com' already planted (and already reviewed) elsewhere
		// in this same spec file, rather than inventing a new one -- deliberately, to avoid
		// growing the manifest's reviewedContentFindings list for a fixture that exists purely
		// to prove suppression logic, not to exercise a new marker shape. Written as two
		// concatenated literals (not one string with an embedded \n) so the raw source text
		// has no leading-backslash-n artifact ahead of the email -- see the 'n'-prefix note
		// on the fingerprint-stability test above for why that artifact exists at all.
		const staleEntry = { fingerprint: 'a.md:email:2', reason: 'stale pre-fix fingerprint, kept only to prove it no longer matches anything' };
		const text = 'line one\n' + 'someone@example.com\n'; // a DIFFERENT email now sits on line 2
		const findings = scanTextForContentMarkers('a.md', text);
		const { unreviewed, suppressed } = partitionFindingsBySuppression(findings, [staleEntry]);
		expect(suppressed.length).toBe(0);
		expect(unreviewed.length).toBe(1);
		expect(unreviewed[0].match).toBe('someone@example.com');
	});

	it('DOES suppress the exact same literal after a benign edit shifts it to a different line (not a security event)', () => {
		// Same reuse-not-invent reasoning as the test above: 'falco@example.com' is already
		// a reviewed literal in this file's own email-marker test near the top of this
		// describe block.
		const approvedText = 'falco@example.com\n';
		const approvedFinding = scanTextForContentMarkers('a.md', approvedText)[0];
		const approvedEntry = { fingerprint: approvedFinding.fingerprint, reason: 'reviewed, approved contact address' };
		const shiftedText = 'an unrelated line inserted above\n' + 'falco@example.com\n';
		const shiftedFindings = scanTextForContentMarkers('a.md', shiftedText);
		const { unreviewed, suppressed } = partitionFindingsBySuppression(shiftedFindings, [approvedEntry]);
		expect(unreviewed.length).toBe(0);
		expect(suppressed.length).toBe(1);
	});
});

// Honest coverage gap (Reeve, 2026-09-13): the EXEMPTED branch is exercised here directly
// against the real production function -- not reimplemented in test scope -- but not via a
// real `runVerify` subprocess, because `main()` hardcodes the real manifest path and this
// repo's real oversizedExceptions list is (deliberately) empty. Adding an injectable
// manifest path to main() purely to reach this branch end-to-end would add exactly the
// kind of surface this gate's own design explicitly rejects ("no --force, no skip flag, no
// env-var bypass") for a marginal gain: the untested slice is thin CLI wiring (a filter and
// two console.log lines), not scan/matching logic, which these unit tests DO exercise
// against the real partitionSkippedLargeByException.
describe('partitionSkippedLargeByException', () => {
	it('splits skipped files into exempted (fingerprint match) and unreviewed (must fail)', () => {
		const lockFingerprint = `muse-brain/package-lock.json:${fingerprintHash('{"lockfileVersion":1}')}`;
		const hugeFingerprint = `muse-brain/src/oops-huge.ts:${fingerprintHash('x'.repeat(1000))}`;
		const skipped = [
			{ path: 'muse-brain/package-lock.json', fingerprint: lockFingerprint },
			{ path: 'muse-brain/src/oops-huge.ts', fingerprint: hugeFingerprint }
		];
		const result = partitionSkippedLargeByException(skipped, [{ fingerprint: lockFingerprint, reason: 'manually reviewed, hashes only' }]);
		expect(result.exempted).toEqual([skipped[0]]);
		expect(result.unreviewed).toEqual([skipped[1]]);
	});

	it('treats every skipped file as unreviewed when no exceptions are configured', () => {
		const skipped = [{ path: 'muse-brain/src/oops-huge.ts', fingerprint: `muse-brain/src/oops-huge.ts:${fingerprintHash('content')}` }];
		const result = partitionSkippedLargeByException(skipped, []);
		expect(result.unreviewed).toEqual(skipped);
		expect(result.exempted).toEqual([]);
	});

	it('CRITICAL fix (2026-09-13): a stale exception approving the OLD content at a path does not silently exempt DIFFERENT content that later lands at the same path', () => {
		const path = 'muse-brain/docs/images/oops-swapped.png';
		const staleFingerprint = `${path}:${fingerprintHash('the original, reviewed, harmless content')}`;
		const newFingerprint = `${path}:${fingerprintHash('a different, larger, sensitive file swapped into the same path later')}`;
		const skipped = [{ path, fingerprint: newFingerprint }];
		const result = partitionSkippedLargeByException(skipped, [{ fingerprint: staleFingerprint, reason: 'reviewed a while back -- but that was different content' }]);
		expect(result.exempted).toEqual([]);
		expect(result.unreviewed).toEqual(skipped);
	});

	it('DOES exempt when the fingerprint matches -- same path, same content, genuinely reviewed', () => {
		const path = 'muse-brain/docs/images/oops-swapped.png';
		const fingerprint = `${path}:${fingerprintHash('the same content, still')}`;
		const skipped = [{ path, fingerprint }];
		const result = partitionSkippedLargeByException(skipped, [{ fingerprint, reason: 'reviewed' }]);
		expect(result.exempted).toEqual(skipped);
		expect(result.unreviewed).toEqual([]);
	});

	it('MEDIUM fix (2026-09-13): the returned exceptions Map lets a caller read the reviewer\'s reason for an exempted file -- what main() prints on the EXEMPTED line, which used to log only the path', () => {
		const path = 'muse-brain/docs/images/oops-swapped.png';
		const fingerprint = `${path}:${fingerprintHash('reviewed content')}`;
		const skipped = [{ path, fingerprint }];
		const { exceptions, exempted } = partitionSkippedLargeByException(skipped, [{ fingerprint, reason: 'manually reviewed, hashes only, no PII' }]);
		expect(exceptions.get(exempted[0].fingerprint)?.reason).toBe('manually reviewed, hashes only, no PII');
	});
});

describe('end-to-end gate (spawns the real script as a subprocess)', () => {
	it('PASSES on a candidate containing only allowlisted paths', () => {
		if (!nameDenylistProvisioned()) {
			throw new Error(
				'ops/.release-name-denylist.local is not provisioned in this environment. This test ' +
				'intentionally does not skip: a silently-skipped "does the gate even pass on a clean ' +
				'candidate" test is exactly the "plausible answer, structurally unable to catch the thing" ' +
				'failure class this whole gate exists to avoid. Copy ' +
				'ops/.release-name-denylist.local.example to ops/.release-name-denylist.local and list ' +
				'the real name(s) to guard.'
			);
		}
		const dir = trackedTmpDir('candidate-clean-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		writeFile(dir, 'LICENSE', 'MIT\n');
		writeFile(dir, '.github/workflows/dep-script-guard.yml', 'name: ci\n');
		writeFile(dir, 'muse-brain/src/index.ts', 'export const ok = true;\n');

		const result = runVerify(dir);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('PASS');
	});

	it('FAILS when a file matches no allow pattern — the core property this gate exists for', () => {
		const dir = trackedTmpDir('candidate-unlisted-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		writeFile(dir, 'muse-brain/daemon-runner/main.ts', 'export {};\n');

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('NOT ON ALLOWLIST');
		expect(result.stderr).toContain('muse-brain/daemon-runner/main.ts');
	});

	it('the unlisted-path message says the gate FAILS, not that it filters the paths out for you — pins the exit-1 branch and the fixed wording', () => {
		// Regression guard for the defect where this line read as informational
		// ("excluded by default, will NOT publish") sitting directly above code that
		// sets `failed = true` -- an operator could read it as "the gate filtered
		// these out for me" and go hunting the wrong cause when FAIL printed below.
		const dir = trackedTmpDir('candidate-unlisted-message-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		writeFile(dir, 'muse-brain/daemon-runner/main.ts', 'export {};\n');

		const result = runVerify(dir);
		expect(result.status).toBe(1); // the unlisted-path branch actually fails the gate
		expect(result.stderr).toContain('FAILS the gate');
		expect(result.stderr).toContain('assemble-public-release.mjs');
		expect(result.stderr).not.toContain('will NOT publish');
		expect(result.stderr).toContain('FAIL. Do not publish this candidate.');
	});

	it('FAILS with the documented reason when a deliberately-excluded path is present (benchmarks/golden)', () => {
		const dir = trackedTmpDir('candidate-golden-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		writeFile(dir, 'muse-brain/benchmarks/golden/surfacer-rook.json', '{}\n');

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('deliberately excluded');
		expect(result.stderr).toContain('muse-brain/benchmarks/golden/surfacer-rook.json');
	});

	it('FAILS when adding a brand-new top-level directory nobody has reviewed — no manifest edit means no silent pass', () => {
		const dir = trackedTmpDir('candidate-newfile-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		writeFile(dir, 'muse-brain/src/index.ts', 'export const ok = true;\n');
		// A brand-new top-level directory — not src/, not test/, not any directory this manifest
		// has ever heard of. This is the regression that matters most: the manifest's job is to
		// make sure a path like this is excluded by DEFAULT, not because someone remembered to
		// deny it.
		writeFile(dir, 'muse-brain/internal-planning-notes/todo.md', '- ship it\n');

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('muse-brain/internal-planning-notes/todo.md');
	});

	it('FAILS on a planted fake secret (private key), detected by gitleaks', () => {
		if (!gitleaksAvailable()) {
			throw new Error(
				'gitleaks is not installed in this environment. This test intentionally does not skip: ' +
				'a silently-skipped secret-scan test is exactly the "plausible answer, structurally unable ' +
				'to catch the thing" failure class this whole gate exists to avoid. Install gitleaks.'
			);
		}
		const dir = trackedTmpDir('candidate-secret-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		// A real RSA-key-shaped body — gitleaks' private-key rule needs realistic length/entropy,
		// a short placeholder like "FAKE_KEY" does not trigger it.
		const body = Array.from({ length: 14 }, (_, i) =>
			`Y7pdjFjacXtSbtz17FM9smIjrQ8gSyOfOnjdwUkX+z5vqALOqyi1EcUgD4Rey1wn${i}`
		).join('\n');
		writeFile(dir, 'muse-brain/src/oops-leaked-key.ts', `export const KEY = \`-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\`;\n`);

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('gitleaks');
		expect(result.stderr.toLowerCase()).toContain('private-key');
	});

	it('FAILS on a planted fake production observation id and tenant-shaped content, via the content-marker scan', () => {
		const dir = trackedTmpDir('candidate-pii-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		writeFile(
			dir,
			'muse-brain/src/oops-leaked-fixture.ts',
			'// planted for the fail-closed test: evidence_ids referencing a real-shaped production record\n' +
			'export const evidence = "obs_20260711131056_eb461fb4";\n' +
			'export const contact = "someone@example.com";\n'
		);

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('production-id-shape');
		expect(result.stderr).toContain('obs_20260711131056_eb461fb4');
	});

	it('FAILS on a PNG with a planted author field in its metadata — the exact regression banner.png shipped (a real leak this gate previously could not see, per BINARY_EXTENSIONS skipping content scanning on binaries)', () => {
		const dir = trackedTmpDir('candidate-planted-author-metadata-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		// Not a byte-valid PNG — this gate never decodes PNG structure, it scans raw bytes
		// regardless of file validity. Mirrors the real banner.png shape: an iTXt-style XMP
		// text block with a populated <pdf:Author> tag, sitting between binary noise, at a
		// path the allowlist already permits (muse-brain/docs/**) — isolating this failure to
		// the metadata scan, not the path allowlist.
		const planted = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
			Buffer.from([0x00, 0x00, 0x00, 0x00]),
			Buffer.from(
				"iTXtXML:com.adobe.xmp\x00\x00\x00\x00\x00<x:xmpmeta><pdf:Author>Jordan Q. Testcase</pdf:Author></x:xmpmeta>",
				'utf8'
			),
			Buffer.from([0x00, 0x00, 0x00, 0x00])
		]);
		writeBinaryFile(dir, 'muse-brain/docs/images/planted-fixture.png', planted);

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('metadata-author-field');
		expect(result.stderr).toContain('Jordan Q. Testcase');
	});

	it('CRITICAL-2 regression (2026-09-10): FAILS on an oversized allowlisted text file carrying planted PII — an unscanned file is not a covered one', () => {
		const dir = trackedTmpDir('candidate-oversized-pii-');
		writeFile(dir, 'README.md', '# muse-brain\n');
		// Path matches the allowlisted `muse-brain/src/**` glob and stays well under
		// gitleaks' own domain (a production-id-shape token, not a credential) -- isolating
		// this to the oversized-skip path specifically, not the path allowlist or gitleaks.
		const padding = 'x'.repeat(3 * 1024 * 1024); // over MAX_CONTENT_SCAN_BYTES (2MB)
		writeFile(
			dir,
			'muse-brain/src/oops-huge-fixture.ts',
			`// ${padding}\nexport const evidence = "obs_20260711131056_eb461fb4";\n`
		);

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('oversized');
		expect(result.stderr).toContain('muse-brain/src/oops-huge-fixture.ts');
		// 2026-09-13: the printed line now carries a content fingerprint too (path:hash), not
		// just the bare path -- the thing a human copies into oversizedExceptions.
		expect(result.stderr).toMatch(/muse-brain\/src\/oops-huge-fixture\.ts — fingerprint muse-brain\/src\/oops-huge-fixture\.ts:[0-9a-f]{16}/);
	});
});
