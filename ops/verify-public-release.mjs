#!/usr/bin/env node

/**
 * The public-release safety gate.
 *
 * Why: a 2026-09 security audit found real, sensitive personal data about a
 * living person (verbatim private conversations — financial hardship, welfare
 * status, tax details, a third party's name) staged to ship in the pending
 * v1.11.0 public release, inside a benchmark fixture directory nobody had
 * reviewed for publication. It never shipped — caught one step before the
 * mirror. The audit's first-pass remedy ("exclude benchmarks/golden/") was
 * itself the bug: an exclusion list only protects against the dangerous thing
 * you already know about. This script enforces the opposite shape: nothing
 * ships unless ops/public-release-manifest.json explicitly names it. Unlisted
 * means blocked, always. Fails closed by construction.
 *
 * This script SCANS an already-assembled publish candidate directory. It does
 * not assemble one, does not mirror, does not tag, does not push. Publishing
 * is currently manual — see public-release-manifest.json's `_howToInvoke` for
 * the full recipe. If an automated release/mirror script is added later, call
 * this gate from it the same unconditional way `predeploy` gates `npm run
 * deploy` today.
 *
 * There is no --force, no skip flag, no env-var bypass. If a real finding
 * needs to be overridden, that happens by editing a tracked, reviewed file
 * (the manifest itself, or one of its two scan-specific exception files) in a
 * diff a reviewer sees — never by a flag passed at run time.
 *
 * 2026-09 addendum: an independent review found that this gate's own binary
 * skip-list (see BINARY_EXTENSIONS below) let muse-brain/docs/images/banner.png
 * ship to the public repo carrying a real person's full legal name in an XMP
 * `pdf:Author` field — invisible to visual review, invisible to grep-on-text,
 * because grep never looked inside the PNG's bytes at all. Binaries are no
 * longer skipped for content scanning: they get a printable-string extraction
 * pass (extractPrintableStrings), a set of XMP/PDF author-tag pattern markers,
 * a configurable local name-denylist (loadNameDenylistFragments /
 * buildNameDenylistMarker — never committed, see ops/.release-name-denylist.local.example),
 * and, when exiftool is on PATH, a structural EXIF/IPTC/XMP field pass
 * (findExiftoolAuthorFindings). None of this claims to catch every possible
 * way a binary can carry personal data — it catches the specific shape that
 * actually shipped, plus the adjacent shapes named in the audit.
 *
 * 2026-09-10 CRITICAL fix: the addendum above widened what happens to a file
 * ONCE it is classified as binary — but BINARY_EXTENSIONS itself, the thing that
 * decides which files GET that classification, was still a hand-maintained
 * 15-extension enum. A real name in a `.tiff` or `.webp` (neither listed) took
 * the plain-text branch instead, where classic (non-XMP) EXIF fields have no
 * XML wrapper for the text-path patterns to catch — zero coverage from any
 * layer, the exact shape of the incident this file exists to prevent, just
 * with the enum widened instead of removed as the actual gate. Binary
 * classification is now decided by sniffing each file's leading bytes for known
 * media/container magic numbers (sniffBinaryFormat) FIRST; BINARY_EXTENSIONS is
 * kept only as an additive fast path (a file with a listed extension still gets
 * binary treatment even if the sniff misses it — e.g. legacy .eot fonts, which
 * have no simple fixed-offset magic number worth hand-rolling), never as the
 * gate a file must pass to be scanned as binary at all.
 *
 * 2026-09-13 CRITICAL fix (supersedes "just add the missing signature"): Michael found a
 * THIRD instance of the same defect class — OLE2 Compound File Binary Format (the legacy
 * `.doc`/`.xls`/`.ppt` container) was in neither BINARY_SIGNATURES nor BINARY_EXTENSIONS,
 * reachable today with zero manifest change (`cli/**`, `runner/**`,
 * `muse-brain/scripts/**`, `muse-brain/templates/**` are all directory-glob allow
 * entries). Reproduced: a `.doc` carrying a real name took the plain-text branch
 * entirely — fully blind, worse than the disclosed `.eot` gap, which at least gets the
 * BINARY_EXTENSIONS fast path and the sniff-coverage-gap alarm as backstops. OLE2 is now
 * a named signature (see BINARY_SIGNATURES) — but the actual fix is structural, not a
 * fourth patched enum entry: the extension-enum-then-magic-number-table pattern will
 * always have a next gap, because "a from-scratch sniff table is only as complete as its
 * author's enumerated list." The default is now inverted. Previously, unknown format meant
 * plain text — fail-open by construction. Now, unknown format AND not plausibly plain text
 * means binary treatment (full extractPrintableStrings + exiftool), regardless of whether
 * the format is ever named in BINARY_SIGNATURES (see looksLikeBinaryContent below).
 * BINARY_SIGNATURES stays valuable as the fast path for known formats; it just stops being
 * the thing that decides safety. Priced against this repo's real 321-file public-release
 * candidate before shipping: 2 files sniff as known binary, 319 look like plain text, and
 * zero are unknown-and-binary-looking — the fail-closed default adds zero new exiftool
 * invocations against this repo's own content today.
 *
 * Usage:
 *   node ops/verify-public-release.mjs <candidate-dir>
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { createHash } from "node:crypto";
import { BINARY_SNIFF_HEADER_BYTES, sniffBinaryFormat } from "./lib/binary-sniff.mjs";

// Re-exported so this file's own import surface (and every existing caller/test importing
// sniffBinaryFormat from HERE) stays unchanged after the 2026-09-13 extraction below.
export { sniffBinaryFormat };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, "public-release-manifest.json");
const GITLEAKS_BASELINE_PATH = path.join(__dirname, "public-release-gitleaks-baseline.json");

const MAX_CONTENT_SCAN_BYTES = 2 * 1024 * 1024; // 2MB — soft limit, see scanCandidateForPublicationRisks.
// 25MB — deliberately much larger than MAX_CONTENT_SCAN_BYTES. This repo's own tracked,
// shipping images (rainer-spec-sheet.png) run ~2.6MB — over the *text* file cap — and
// images/screenshots are exactly the file shape most likely to carry embedded author
// metadata. A binary this scan needs to see must not be waved through by a cap sized
// for source text.
const MAX_BINARY_SCAN_BYTES = 25 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".eot",
	".pdf", ".zip", ".gz", ".tgz", ".sqlite", ".db"
]);
// Extensions in BINARY_EXTENSIONS are no longer skipped for content scanning — they are
// scanned differently (see extractPrintableStrings + the "binary metadata" section
// below) because reading them as utf8 text, or grepping their raw bytes with text-shaped
// assumptions, does not reliably surface embedded metadata fields.
//
// 2026-09-10: this set is no longer what DECIDES whether a file gets that treatment —
// see sniffBinaryFormat below. It survives only as an additive fast path for the one
// legacy format (.eot) with no simple fixed-offset magic number worth hand-rolling.
//
// 2026-09-13: neither is this set (nor BINARY_SIGNATURES) the SAFETY NET anymore — see
// looksLikeBinaryContent below. A file that matches neither still gets binary treatment
// if its content simply doesn't look like plausible plain text. Both this set and the
// sniff table are now pure fast paths: convenience and speed for the common/known case,
// not the thing standing between an unrecognized format and silent plain-text treatment.

// ── content-based binary sniffing ───────────────────────────────────────────
// 2026-09-13: extracted to ops/lib/binary-sniff.mjs (BINARY_SNIFF_HEADER_BYTES,
// sniffBinaryFormat, BINARY_SIGNATURES, and the two byte-matching helpers) -- imported
// and re-exported above. See that file's own header comment for the full rationale
// (Reeve LOW/82: a genuinely reusable "detect a binary format from bytes" utility with
// zero coupling to anything else in this file).

// ── fail-closed default for an unrecognized format ──────────────────────────────────
// 2026-09-13 CRITICAL fix (see the file-header addendum above): the safety net beneath
// both BINARY_SIGNATURES and BINARY_EXTENSIONS. A format sniffBinaryFormat doesn't know
// and whose extension isn't in the fast-path set no longer defaults to plain text — it
// gets binary treatment unless its content is plausibly plain text. "Plausibly plain
// text" means: no NUL byte, and no more than a 5% share of C0 control characters (below
// 0x20, excluding tab/LF/CR — the three that appear constantly in real source and doc
// text) in the scanned window. A NUL byte or a run of other control bytes is not
// something legitimate text produces; a genuine unknown BINARY format produces plenty of
// both.
//
// The window is 512 bytes, not BINARY_SNIFF_HEADER_BYTES (32) — a NUL byte or a
// control-byte run can start well past a format's leading magic number, and a
// statistical judgment about the file's content needs more than the first 32 bytes to
// be meaningful. This costs one extra bounded read, only for files neither the sniff nor
// the extension already classified — verified against this repo's own real 321-file
// public-release candidate: 0 files hit this path today (2 already sniff as binary; the
// other 319 read as plausible text), so this adds zero exiftool invocations on this
// repo's own content while it stands ready to catch the next unlisted binary format.
const TEXT_PLAUSIBILITY_SCAN_BYTES = 512;
const TEXT_PLAUSIBILITY_CONTROL_BYTE_RATIO = 0.05;

export function looksLikeBinaryContent(buffer) {
	if (buffer.length === 0) return false;
	if (buffer.includes(0x00)) return true;
	let controlBytes = 0;
	for (let i = 0; i < buffer.length; i++) {
		const byte = buffer[i];
		if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controlBytes++;
	}
	return controlBytes / buffer.length > TEXT_PLAUSIBILITY_CONTROL_BYTE_RATIO;
}

// ── glob matching ───────────────────────────────────────────────────────────
// Hand-rolled rather than a dependency: this repo's own package.json has no
// glob library in its direct dependencies (picomatch is present only as a
// transitive dep of dev tooling, not something this repo owns), and the
// subset of glob syntax the manifest needs (`*`, `**`, literal paths) is small
// enough that a dependency would be more risk than the code it replaces.
//
// Supported: `*` matches within one path segment (no `/`); `**` matches zero
// or more path segments, including none; everything else is literal. Patterns
// are always matched against POSIX-style (`/`-separated) relative paths.
export function globToRegExp(glob) {
	let re = "";
	let i = 0;
	const n = glob.length;
	while (i < n) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			let j = i + 2;
			if (glob[j] === "/") j++; // absorb an adjacent slash so 'a/**/b' and 'a/**' both read naturally
			re += "(?:.*(?:/|$))?";
			i = j;
			continue;
		}
		if (c === "*") {
			re += "[^/]*";
			i++;
			continue;
		}
		if (c === "?") {
			re += "[^/]";
			i++;
			continue;
		}
		if (".+^${}()|[]\\".includes(c)) {
			re += "\\" + c;
			i++;
			continue;
		}
		re += c;
		i++;
	}
	return new RegExp("^" + re + "$");
}

export function matchesAnyPattern(relPath, patterns) {
	return patterns.some((pattern) => globToRegExp(pattern).test(relPath));
}

// ── manifest loading + self-consistency ─────────────────────────────────────

// 2026-09-13 fix (Reeve MEDIUM/90): per-entry shape validation used to exist for only two
// of these four lists (allow, oversizedExceptions) -- a neverAllow entry missing `pattern`
// sailed through this function untouched and crashed findManifestSelfConsistencyErrors
// later with a raw `TypeError: Cannot read properties of undefined (reading 'endsWith')`
// instead of this function's own clean "Manifest is malformed" message. Generalized into
// one shape-check applied to all four lists here, so a malformed entry in ANY of them
// fails at the FIRST tool to load the manifest, not one step (or one caller) later.
function assertEntriesHaveKeyAndReason(listName, list, keyField) {
	for (const entry of list) {
		if (typeof entry[keyField] !== "string" || !entry[keyField] || typeof entry.reason !== "string" || !entry.reason) {
			throw new Error(`Manifest is malformed: every "${listName}" entry needs a non-empty "${keyField}" and "reason". Offending entry: ${JSON.stringify(entry)}`);
		}
	}
}

export async function loadManifest(manifestPath = MANIFEST_PATH) {
	const raw = await fs.readFile(manifestPath, "utf8");
	const manifest = JSON.parse(raw);
	for (const key of ["allow", "neverAllow", "reviewedContentFindings", "oversizedExceptions"]) {
		if (!Array.isArray(manifest[key])) {
			throw new Error(`Manifest is malformed: "${key}" must be an array (got ${typeof manifest[key]}).`);
		}
	}
	assertEntriesHaveKeyAndReason("allow", manifest.allow, "pattern");
	assertEntriesHaveKeyAndReason("neverAllow", manifest.neverAllow, "pattern");
	assertEntriesHaveKeyAndReason("reviewedContentFindings", manifest.reviewedContentFindings, "fingerprint");
	assertEntriesHaveKeyAndReason("oversizedExceptions", manifest.oversizedExceptions, "fingerprint");
	return manifest;
}

// Turns a neverAllow pattern into one concrete sample path to test against the
// allow list. A directory-glob like "a/b/**" samples as "a/b/__consistency_check__";
// anything else is used as a literal path. This catches the specific regression
// this manifest exists to prevent: an allow glob later widened so far that it
// silently re-admits a directory someone deliberately excluded.
export function sampleNeverAllowPath(pattern) {
	if (pattern.endsWith("/**")) {
		return pattern.slice(0, -3) + "/__consistency_check__";
	}
	return pattern;
}

// 2026-09-10 HIGH fix: sampleNeverAllowPath's single extensionless sample missed the most
// natural real mistake — an allow glob written in this manifest's own dominant per-file
// style (`*.sql`, `*.spec.ts`) only matches files WITH an extension. Adding the allow
// pattern `muse-brain/benchmarks/golden/*.json` (matching that style) reported ZERO
// self-check errors against the single extensionless sample, while
// `muse-brain/benchmarks/golden/surfacer-rook.json` — the actual leaked audit fixture —
// matches that exact glob and would ship. Sampling several representative extensions per
// directory-glob neverAllow entry closes the gap this specific style of mistake opens,
// without attempting a general glob-vs-glob overlap solver (see the LOW-priority note in
// this repo's PR history for why that's future work, not this fix).
const SELF_CONSISTENCY_SAMPLE_SUFFIXES = ["", ".json", ".md", ".sql", ".ts", ".png"];

export function sampleNeverAllowPaths(pattern) {
	if (!pattern.endsWith("/**")) return [pattern];
	const base = pattern.slice(0, -3);
	return SELF_CONSISTENCY_SAMPLE_SUFFIXES.map((suffix) => `${base}/__consistency_check__${suffix}`);
}

export function findManifestSelfConsistencyErrors(manifest) {
	const allowPatterns = manifest.allow.map((e) => e.pattern);
	const errors = [];
	for (const entry of manifest.neverAllow) {
		for (const sample of sampleNeverAllowPaths(entry.pattern)) {
			if (matchesAnyPattern(sample, allowPatterns)) {
				errors.push(
					`MANIFEST SELF-CHECK FAILED: neverAllow entry "${entry.pattern}" is matched by an ` +
					`"allow" pattern (sample path "${sample}" matched). An allow glob has been widened ` +
					`to swallow something this manifest says must never ship. Fix the allow pattern.`
				);
			}
		}
	}
	return errors;
}

// ── candidate directory walking ─────────────────────────────────────────────

export async function listCandidateFiles(candidateDir) {
	const results = [];
	const symlinks = [];

	async function walk(absDir, relDir) {
		const entries = await fs.readdir(absDir, { withFileTypes: true });
		for (const entry of entries) {
			const absPath = path.join(absDir, entry.name);
			const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) {
				symlinks.push(relPath);
				continue;
			}
			if (entry.isDirectory()) {
				await walk(absPath, relPath);
			} else if (entry.isFile()) {
				results.push(relPath);
			}
		}
	}

	await walk(candidateDir, "");
	results.sort();
	return { files: results, symlinks };
}

export function findUnlistedPaths(relPaths, allowPatterns) {
	return relPaths.filter((p) => !matchesAnyPattern(p, allowPatterns));
}

// ── content markers ──────────────────────────────────────────────────────────
// "High-signal personal-data markers" per the audit: the shape of this
// codebase's own production ids, session/message id shapes, and obvious PII.
// Each pattern is documented with WHY it was chosen, not just what it matches.
const CONTENT_MARKERS = [
	{
		name: "production-id-shape",
		// Every internally-generated id in this codebase (observations, proposals,
		// entities, tasks, skills, ...) comes from helpers.ts's generateId(prefix): a
		// lowercase prefix, an underscore, a 14-digit timestamp, an underscore, and
		// an 8-hex-char uuid fragment. A real id leaked exactly this way (see the
		// benchmarks/golden/surfacer-rook.json incident this manifest documents,
		// in its evidence_ids field) took that shape. Any file containing a token
		// matching it is referencing a real production record, not synthetic/
		// example data. (Deliberately described here rather than spelled out as
		// one instantiated literal — this file is itself allowlisted to ship, and
		// a concrete example in this very comment would trip this same marker
		// against this same file.)
		regex: /\b[a-z][a-z_]{1,24}_\d{14}_[0-9a-f]{8}\b/g,
		contextScope: "match"
	},
	{
		name: "claude-session-id",
		// This repo's own commit trailers carry Claude Code session URLs of the
		// form https://claude.ai/code/session_<ULID> — a session_ prefix, "01",
		// then roughly 24 more Crockford-base32 characters. A literal one of
		// these embedded in a fixture or doc is a real session reference. (Left
		// as a placeholder rather than a real instantiated id for the same
		// self-reference reason noted on production-id-shape above.)
		regex: /\bsession_01[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{20,30}\b/g,
		// 2026-09-13 fix (Michael LOW/88, Reeve HIGH/95): this entry had no contextScope of
		// its own and rode scanTextForContentMarkers's `?? "match"` fallback silently --
		// harmless in practice (a session id has enough structure that "match" is the
		// correct scope for it, same as production-id-shape and uuid-v4-shape), but it broke
		// the very claim the comment below made in the same diff that introduced it, with
		// nothing catching it. See findContentMarkersMissingContextScope, which now fails
		// the gate loud if this ever regresses on any entry in this array.
		contextScope: "match"
	},
	{
		name: "uuid-v4-shape",
		regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
		contextScope: "match"
	},
	{
		name: "iban-shape",
		regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
		contextScope: "match"
	},
	{
		name: "email",
		// Narrow, deliberate carve-out for the exact literal SSH remote prefix this repo's
		// own docs/scripts/tests reference nine times as a plain git remote URL (username
		// "git", host "github.com") — a systemic, reappearing literal, not a one-off. A
		// negative lookahead anchored at the same position the match itself starts from,
		// so it only refuses to START a match at a position where that exact literal sits.
		// Deliberately NOT a wildcard on the username or the whole domain — either would
		// blind this marker to a real address that happens to share one half of it. A
		// real-looking address at the same host, or an address whose local part merely
		// contains "git" as a substring of something longer, still needs to trip this
		// marker, and does: the lookahead only matches the exact literal, and the leading
		// boundary keeps it from firing mid-local-part (a longer local part ending in
		// "...git" has no valid match-start position immediately before the trailing
		// "git", so the lookahead is never even evaluated at that inner position — the
		// whole longer address matches as an ordinary email instead).
		//
		// The marker's own leading boundary is a negative lookbehind keyed to the local-
		// part character class, not `\b` (2026-09-10 MEDIUM fix, Kairo/Michael): `\b` only
		// fires at a transition between a `\w` char and a non-`\w` char, and none of
		// `. _ % + -` count as `\w` — so a local part that STARTS with one of them (a
		// leading dot, plus, or hyphen before the rest of the address) had no boundary at
		// its true start, silently truncating the match to whatever came after the leading
		// punctuation, and a local part made ENTIRELY of such characters had no boundary
		// anywhere in it and failed to match at all. Three differently-truncated matches
		// for three different real inputs collapsed to the SAME fingerprint too (`\b`
		// dropped the identical characters every time) — a fingerprint-collision bug riding
		// on the boundary bug. A lookbehind asks "is the immediately preceding character
		// NOT itself a local-part atom", true at the true start of each of these inputs
		// (preceded by whitespace, punctuation, or nothing), so the match now starts in
		// the right place regardless of what the first character is.
		//
		// Local-part and domain-label characters use Unicode letter/number classes
		// (`\p{L}`/`\p{N}`, `u` flag), not ASCII-only `A-Za-z0-9` (2026-09-10 HIGH fix):
		// Falco's business operates in German, where umlauts in an address are routine,
		// not exotic. Verified against the ASCII-only version: a local part starting with
		// an umlaut matched nothing (no boundary, same root cause as the leading-
		// punctuation bug above, since the ASCII lookbehind didn't recognize the umlaut
		// as a local-part atom either), and a domain label containing an umlaut matched
		// only the portion after it, silently truncating the address. The TLD itself stays
		// ASCII-only (`[A-Za-z]{2,}`) deliberately -- real TLDs, including internationalized
		// ones, are represented in ASCII/punycode wherever this marker would see them in
		// plain text, so widening it would only risk over-matching.
		//
		// The literal is bounded by `(?![A-Za-z0-9.-])`, NOT `\b`, on its trailing edge —
		// a real gap Michael's audit (2026-09-10) found: `\b` sits between "com" and a
		// following "." just as happily as between "com" and a colon or whitespace, so
		// the exempted literal matched as a PREFIX of a longer dotted domain too — the
		// exact shape of a phishing domain that starts with the real host name and keeps
		// going, not an accidental-leak shape. Rejecting any domain-continuation character
		// after the literal (not just any non-word character) closes that: the literal
		// followed by a colon, or sitting at end-of-line, still correctly exempts (neither
		// is a domain character), but the literal followed by more dotted domain segments
		// is no longer exempted and falls through to the base pattern, which matches the
		// whole longer address as an ordinary (flagged) email. (Described in prose rather
		// than as an instantiated example for the same self-reference reason noted below —
		// first draft of this exact comment used a literal example and immediately tripped
		// this file's own "never trips its own scan" regression test.)
		//
		// Verified by this file's own test suite, not just described here — see
		// public-release-verify.spec.ts's "email marker: git@github.com" tests, deliberately
		// written as inline prose above rather than as instantiated literals in this comment,
		// for the self-reference reason documented on scanTextForContentMarkers below.
		regex: /(?<![\p{L}\p{N}._%+-])(?!git@github\.com(?![A-Za-z0-9.-]))[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}\b/gu,
		contextScope: "match"
	},
	{
		name: "phone-with-country-code",
		regex: /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
		contextScope: "match"
	},
	{
		name: "metadata-author-field",
		// Populated XMP/PDF author-ish tags stored as inline XML text with the value
		// directly between the open/close tag (as opposed to dc:creator, which XMP wraps
		// in an rdf:Seq/rdf:li — see scanTextForDcCreator below, handled separately
		// because it needs to span more than one extracted line). This is presence
		// detection, not name detection: a populated field is the finding, whatever its
		// value — exactly the shape that shipped in banner.png's `pdf:Author`.
		regex: /<(pdf:Author|xmp:CreatorTool|tiff:Artist|tiff:Copyright|exif:Artist|exif:Copyright|photoshop:Credit|photoshop:Copyright|Iptc4xmpCore:CreatorTool|Iptc4xmpCore:By-line|Iptc4xmpCore:Byline)>([^<]*[^<\s][^<]*)<\/\1>/gi,
		contextScope: "match"
	}
];

// Self-check, mirroring findManifestSelfConsistencyErrors's style below: every entry in
// CONTENT_MARKERS must declare its OWN contextScope, not ride scanTextForContentMarkers's
// `?? "match"` fallback. 2026-09-13 fix (Michael LOW/88, Reeve HIGH/95): claude-session-id
// had exactly this gap in the same diff that first claimed "every marker declares this
// explicitly" -- the discipline lapsed with nothing catching it. The whole point of making
// scope a declared property instead of an implicit default was so a future bare-substring
// marker (the shape buildNameDenylistMarker exists to handle) can't silently inherit the
// unsafe "match" default; this closes the gap between that intent and what was actually
// enforced.
export function findContentMarkersMissingContextScope(markers = CONTENT_MARKERS) {
	const errors = [];
	for (const marker of markers) {
		if (!Object.prototype.hasOwnProperty.call(marker, "contextScope")) {
			errors.push(
				`CONTENT MARKER SELF-CHECK FAILED: "${marker.name}" has no contextScope of its ` +
				'own -- every CONTENT_MARKERS entry must explicitly choose "match" or "line" ' +
				"(see the fingerprints comment above scanTextForContentMarkers)."
			);
		} else if (marker.contextScope !== "match" && marker.contextScope !== "line") {
			errors.push(
				`CONTENT MARKER SELF-CHECK FAILED: "${marker.name}" declares contextScope ` +
				`${JSON.stringify(marker.contextScope)}, which is neither "match" nor "line".`
			);
		}
	}
	return errors;
}

// ── fingerprints ─────────────────────────────────────────────────────────────
// A suppression fingerprint has to change whenever the MATCHED TEXT changes, not just
// track a file+pattern+line coordinate. The prior scheme (`${relPath}:${marker.name}:
// ${lineNo + 1}`) was fail-open: line numbers shift on any edit above them in a file —
// proven empirically in the prior round, when adding one regression test to this very
// spec silently broke 11 of its 12 baseline entries — so a stale entry keyed to a line
// number will happily suppress WHATEVER new match lands on that line after a future
// edit, including a genuinely sensitive one, with zero signal to a human. Folding a
// hash of the actual matched text into the key means a different match produces a
// different key, misses the reviewed-findings map, and surfaces as unreviewed —
// failing loud, as this gate is designed to, instead of failing open.
//
// Line number is dropped from the key entirely rather than kept alongside the hash —
// the one real tradeoff here, worth naming plainly: keeping it would still force a
// re-key on every benign edit that shifts lines below it, the exact churn that broke
// 11 of 12 entries in the prior round from a single new test. Since the key already
// carries a hash of the literal matched text, keeping the line too buys nothing but
// fragility for a MATCH-scoped marker: two occurrences of the identical matched string
// really are the same reviewed fact, because every CONTENT_MARKERS pattern requires
// enough surrounding structure (an id shape, an email shape, an IBAN checksum-length
// shape, an XML tag pair) that the matched text alone effectively carries its context.
//
// 2026-09-10 correction: that claim is NOT universally true, and this file has a named
// exception — the name-denylist marker (buildNameDenylistMarker) is a bare, context-free
// substring match with no surrounding structure to narrow it. The SAME short name
// fragment recurring elsewhere in a file is not reliably the same reviewed fact the way
// a repeated production-id or email is; a person's name can legitimately appear in many
// unrelated sentences. Every marker therefore declares its own `contextScope`: "match"
// (the default above, hash the matched text alone) or "line" (hash the whole containing
// line instead, so the SAME name on a DIFFERENT line produces a DIFFERENT fingerprint
// and is never silently suppressed by approving an earlier occurrence). See
// scanTextForContentMarkers below for where this is applied, and buildNameDenylistMarker
// for the one marker that currently opts into "line".
//
// The remaining scope is still real and deliberate regardless of contextScope: the same
// literal (or line) is only suppressed within the SAME file, and only against the SAME
// marker/pattern, never blanket-approved across the whole repo.
//
// sha256, truncated to 16 hex characters (64 bits of the digest): long enough that
// brute-forcing a second input to collide with an already-approved hash is
// computationally infeasible (2^64 search space), short enough to stay readable
// sitting next to a human-written reason in the manifest.
const FINGERPRINT_HASH_HEX_LENGTH = 16;

export function fingerprintHash(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, FINGERPRINT_HASH_HEX_LENGTH);
}

export function scanTextForContentMarkers(relPath, text, markers = CONTENT_MARKERS) {
	const findings = [];
	const lines = text.split("\n");
	for (const marker of markers) {
		// contextScope: "line" hashes the CONTAINING LINE instead of the bare matched text —
		// see the 2026-09-10 correction in the fingerprints comment above for why. Every
		// marker in this file's own CONTENT_MARKERS declares "match" or "line" explicitly,
		// and findContentMarkersMissingContextScope (below) fails the gate loud if a future
		// entry in this array ever omits it — a 2026-09-13 fix, after claude-session-id had
		// exactly that gap in the same diff that introduced this claim, with nothing catching
		// it (Michael LOW/88, Reeve HIGH/95). The `?? "match"` fallback here is a safety net
		// for a marker built by a future EXTERNAL caller (a hand-built test fixture, an
		// array passed directly to this function rather than the default CONTENT_MARKERS),
		// never license for an entry living in CONTENT_MARKERS itself to skip declaring it.
		const scope = marker.contextScope ?? "match";
		for (let lineNo = 0; lineNo < lines.length; lineNo++) {
			const line = lines[lineNo];
			marker.regex.lastIndex = 0;
			let match;
			while ((match = marker.regex.exec(line)) !== null) {
				const fingerprintSource = scope === "line" ? line : match[0];
				findings.push({
					path: relPath,
					line: lineNo + 1,
					pattern: marker.name,
					match: match[0],
					fingerprint: `${relPath}:${marker.name}:${fingerprintHash(fingerprintSource)}`
				});
				if (match[0].length === 0) marker.regex.lastIndex++; // guard against zero-length matches
			}
		}
	}
	return findings;
}

// dc:creator is virtually always wrapped in an rdf:Seq/rdf:Bag element containing an
// rdf:li element holding the actual name (nesting order: dc:creator, then rdf:Seq, then
// rdf:li, then the name) — commonly pretty-printed across 3+ lines. (Described with
// element names rather than literal angle-bracket markup for the same self-reference
// reason noted on the content markers above — this file ships, and literal markup
// matching this exact nesting would trip scanTextForDcCreator against itself.)
// scanTextForContentMarkers is deliberately
// line-by-line (so text-file findings get a real, useful line number), which cannot see
// a pattern spanning multiple lines. This runs separately, against the whole text at
// once, specifically for that one multi-line shape. line is reported as 0 (whole-file,
// not line-addressable) rather than guessed at.
export function scanTextForDcCreator(relPath, text) {
	const findings = [];
	const regex = /<dc:creator>[\s\S]{0,1000}?<rdf:li[^>]*>([^<]+)<\/rdf:li>/gi;
	let match;
	while ((match = regex.exec(text)) !== null) {
		const snippet = match[0].length > 200 ? `${match[0].slice(0, 200)}…` : match[0];
		findings.push({
			path: relPath,
			line: 0,
			pattern: "metadata-dc-creator-field",
			match: snippet,
			// Hashed on the FULL match (match[0]), not the display-truncated `snippet` — this
			// finding never had a line number to key on (it's a whole-file, multi-line match),
			// so before this change its fingerprint was a bare `:0` shared by every dc:creator
			// finding in a file regardless of value: the single most fail-open shape this gate
			// had, wide open the same way the line-keyed markers were, just without even a line
			// number to shift. A hash of the actual matched value closes it the same way.
			fingerprint: `${relPath}:metadata-dc-creator-field:${fingerprintHash(match[0])}`
		});
		if (match[0].length === 0) regex.lastIndex++; // guard against zero-length matches
	}
	return findings;
}

// `strings`-equivalent: printable-text runs of >= minLen bytes. Deliberately hand-rolled
// (same reasoning as globToRegExp above) rather than a dependency or a shell-out to the
// `strings` binary, which is not guaranteed present on every platform this gate might
// run on. A real newline (0x0a) breaks a run, same as the system `strings` tool — which,
// empirically, is exactly why banner.png's pretty-printed XMP block extracts as one
// tag-plus-value per run: each XML line has no embedded newline of its own.
//
// 2026-09-10 HIGH fix: a run used to break on ANY byte outside 0x20-0x7e, which shreds
// every multi-byte UTF-8 sequence — verified against a populated author-field tag whose
// value was a real German name containing an umlaut: the run split in half exactly at
// the umlaut's 2-byte UTF-8 encoding, one run ending mid-name and a second beginning
// right after it, so the name never appeared intact in either extracted run. (Described
// in prose rather than as an instantiated example for the same self-reference reason
// documented throughout this file — an actual populated author-field literal here would
// trip this file's own "never trips its own scan" regression test.) The name-denylist
// marker (the second line of defense built specifically after the banner.png incident)
// only ever worked on ASCII names as a result. A run now also continues through
// any byte sequence that is STRUCTURALLY a valid UTF-8 multi-byte character (a correct
// lead byte followed by the right count of correct continuation bytes) — not "any byte
// >= 0x80", which would glue runs across arbitrary binary noise (real image/font payload
// bytes routinely fall in the continuation-byte range by chance) and blow up both the
// volume of extracted text and the cost of scanning it. Once a run's boundaries are
// found, it is decoded with Node's own `Buffer#toString("utf8", ...)`, which replaces any
// remaining invalid subsequence with U+FFFD rather than throwing — "replacement on error"
// as specified, not a hand-rolled decoder.
function utf8LeadByteSequenceLength(byte) {
	if ((byte & 0xe0) === 0xc0) return 2; // 110xxxxx
	if ((byte & 0xf0) === 0xe0) return 3; // 1110xxxx
	if ((byte & 0xf8) === 0xf0) return 4; // 11110xxx
	return 0; // not a valid UTF-8 lead byte (continuation byte, ASCII, or an invalid lead)
}

function isUtf8ContinuationByte(byte) {
	return (byte & 0xc0) === 0x80; // 10xxxxxx
}

export function extractPrintableStrings(buffer, minLen = 4) {
	const runs = [];
	let start = -1;
	let i = 0;
	while (i <= buffer.length) {
		if (i === buffer.length) {
			if (start !== -1 && i - start >= minLen) runs.push(buffer.toString("utf8", start, i));
			break;
		}
		const byte = buffer[i];
		if (byte >= 0x20 && byte <= 0x7e) {
			if (start === -1) start = i;
			i++;
			continue;
		}
		const seqLen = utf8LeadByteSequenceLength(byte);
		if (seqLen >= 2 && i + seqLen <= buffer.length) {
			let validSequence = true;
			for (let k = 1; k < seqLen; k++) {
				if (!isUtf8ContinuationByte(buffer[i + k])) { validSequence = false; break; }
			}
			if (validSequence) {
				if (start === -1) start = i;
				i += seqLen;
				continue;
			}
		}
		if (start !== -1) {
			if (i - start >= minLen) runs.push(buffer.toString("utf8", start, i));
			start = -1;
		}
		i++;
	}
	return runs;
}

// Exact (case-insensitive) exiftool tag names that carry human authorship/rights
// information when populated. Deliberately an EXACT-match set, not a "-creator"/
// "-copyright" suffix heuristic: a suffix match also catches ICC color-profile fields
// like "ProfileCreator" ("Apple Computer Inc.") and "ProfileCopyright" ("Copyright Apple
// Inc., 2026"), which are boilerplate present in nearly every macOS-generated PNG and
// carry zero personal-authorship signal. Verified against three of this repo's actual
// tracked images (rainer.png is tracked but, per this manifest's neverAllow, does not
// ship — kept here as a verification data point, not a claim about what publishes):
// this exact list flags banner.png's Author/CreatorTool fields and flags nothing in
// rainer.png or rainer-spec-sheet.png — matching the independent reviewer's own
// three-file assessment (one dirty, two clean).
export const AUTHOR_METADATA_TAG_NAMES = new Set([
	"author", "creator", "creatortool", "artist", "copyright",
	"credit", "byline", "by-line", "rights", "xpauthor"
]);

// exifData keys are exiftool's own `-G1`-grouped shape ("IFD0:Artist",
// "XMP-tiff:Artist", "System:FileName" — everything except SourceFile carries a
// "Group:Tag" prefix; see runExiftoolJson). Matching against the unqualified tag name
// (the part after the first colon) rather than the whole key means the SAME tag name
// populated by two different tools/groups on one file — the exact banner.png/Canva
// shape (2026-09-10 MEDIUM-HIGH fix) — surfaces as two separate findings instead of one
// silently overwriting the other in exiftool's own default (ungrouped) JSON output.
function unqualifiedExiftoolTagName(key) {
	const colonIndex = key.indexOf(":");
	return colonIndex === -1 ? key : key.slice(colonIndex + 1);
}

export function findExiftoolAuthorFindings(relPath, exifData) {
	const findings = [];
	for (const [key, rawValue] of Object.entries(exifData)) {
		if (key === "SourceFile") continue;
		const tagName = unqualifiedExiftoolTagName(key);
		if (!AUTHOR_METADATA_TAG_NAMES.has(tagName.toLowerCase())) continue;
		if (rawValue === undefined || rawValue === null) continue;
		const value = String(rawValue).trim();
		if (value.length === 0) continue;
		findings.push({
			path: relPath,
			line: 0,
			pattern: `exiftool-author-field:${key}`,
			match: value,
			// The tag NAME (`key`) alone is stable and never shifts, but it is not the
			// sensitive artifact — the VALUE is. Keying on tag name only has the identical
			// fail-open shape as the old line-only text-marker fingerprint: a stale entry
			// approving "this file's Author field is fine" would silently keep suppressing
			// that same field forever even if a future edit swapped in a different, real
			// name under the same key. Hashing the value closes it the same way as above.
			// `key` here already carries the group prefix (e.g. "XMP-tiff:Artist"), so a
			// same-named tag in a DIFFERENT group gets its own fingerprint automatically.
			fingerprint: `${relPath}:exiftool-author-field:${key}:${fingerprintHash(value)}`
		});
	}
	return findings;
}

export function isExiftoolAvailable() {
	const probe = spawnSync("exiftool", ["-ver"], { encoding: "utf8" });
	return !probe.error;
}

export function runExiftoolJson(absPath) {
	// -G1 (not exiftool's default ungrouped output): verified empirically that writing
	// both EXIF:Artist and XMP-tiff:Artist to one JPEG surfaces only the EXIF value
	// without -G1 — the XMP one is silently absent from the JSON entirely, exiftool's
	// own last-value-wins collapse across groups for same-named tags. Plausible for any
	// image touched by more than one tool — exactly banner.png's Canva provenance.
	const result = spawnSync("exiftool", ["-j", "-a", "-G1", absPath], { encoding: "utf8" });
	if (result.error) {
		if (result.error.code === "ENOENT") return { status: "missing-binary" };
		return { status: "error", stderr: String(result.error) };
	}
	if (result.status !== 0) {
		return { status: "error", stderr: result.stderr || `exiftool exited ${result.status}` };
	}
	try {
		const parsed = JSON.parse(result.stdout);
		return { status: "ok", data: parsed[0] ?? {} };
	} catch (err) {
		return { status: "error", stderr: `exiftool output unparseable: ${err.message}` };
	}
}

// ── name denylist ────────────────────────────────────────────────────────────
// A local-only, gitignored list of real-person name fragments to screen for. Never
// hardcode a real name into this file or the manifest — that would republish exactly
// the string this gate exists to keep out of a public release. See
// ops/.release-name-denylist.local.example for the format.
export const NAME_DENYLIST_PATH = path.join(__dirname, ".release-name-denylist.local");

export async function loadNameDenylistFragments(denylistPath = NAME_DENYLIST_PATH) {
	let raw;
	try {
		raw = await fs.readFile(denylistPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return { fragments: [], present: false };
		throw err;
	}
	const fragments = raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	return { fragments, present: true };
}

export function buildNameDenylistMarker(fragments) {
	if (!fragments || fragments.length === 0) return null;
	const escaped = fragments.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return {
		// This label is deliberately generic and must never be built from the fragment
		// values themselves — the marker's own identity must not carry the value it
		// exists to catch, or a fingerprint (potentially copied into a committed
		// reviewedContentFindings entry later) would re-embed the real name. Only
		// `match` on a runtime finding carries the actual matched text.
		name: "person-name-denylist",
		regex: new RegExp(`(${escaped.join("|")})`, "gi"),
		// "line", not "match" (2026-09-10 fix): a bare substring match has no surrounding
		// structure to narrow it, unlike email/iban/uuid/production-id shapes — the SAME
		// name recurring elsewhere in the same file is NOT reliably the same reviewed fact,
		// since a short/common name fragment can legitimately appear in many unrelated
		// contexts. Hashing the containing line instead of the bare match means approving
		// one occurrence never silently suppresses a DIFFERENT line's occurrence of the
		// identical fragment.
		contextScope: "line"
	};
}

// Reads the first `length` bytes of a file — bounded, so sniffing a huge file's magic
// number never means reading the whole thing.
async function readHeaderBytes(absPath, length) {
	const handle = await fs.open(absPath, "r");
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

// Looks up a tag by its unqualified name in exifData's -G1-grouped keys (e.g. "FileType"
// finds "File:FileType"). Used for the sniff-coverage-gap alarm below, which needs
// exiftool's own type-identification fields regardless of which group -G1 filed them
// under (verified: -G1 puts FileType/MIMEType under "File:", not bare).
function groupedExiftoolValue(exifData, tagName) {
	for (const [key, value] of Object.entries(exifData)) {
		if (unqualifiedExiftoolTagName(key) === tagName) return value;
	}
	return undefined;
}

// True when exiftool's own analysis (content-based, not extension-based) recognized this
// file as a real, named media type — used only for the sniff-coverage-gap alarm below.
function exiftoolReportsRealFileType(exifData) {
	const fileType = groupedExiftoolValue(exifData, "FileType");
	return typeof fileType === "string" && fileType.trim().length > 0;
}

// 2026-09-13 fix (Michael MEDIUM/85, Reeve HIGH/85, found independently): an oversized
// file that gets skipped from scanning is identified by `${relPath}:${hash of its own
// content}`, not by path alone — matching the convention reviewedContentFindings already
// uses. Exact-path-only keying was fail-open on replacement: a human reviews and exempts
// file X today; a later release swaps a different, larger, sensitive file into that same
// path and the old approval silently still applies, with no re-review and no signal. The
// identical fail-open shape this whole effort eliminated from line-numbered content-marker
// fingerprints, one level up — from "line" to "file". Hashing the whole file is cheap even
// at the 25MB binary ceiling; the expensive part an oversized-skip avoids is regex/XMP
// scanning, not hashing, so this doesn't reintroduce the cost the skip exists to avoid.
async function fingerprintOversizedFile(relPath, absPath) {
	const buffer = await fs.readFile(absPath);
	return `${relPath}:${fingerprintHash(buffer)}`;
}

export async function scanCandidateForPublicationRisks(candidateDir, relFiles, options = {}) {
	const markers = options.markers ?? CONTENT_MARKERS;
	const exiftoolAvailable = options.exiftoolAvailable ?? false;
	const findings = [];
	const skippedLarge = [];
	let binaryFileCount = 0;

	for (const relPath of relFiles) {
		const ext = path.extname(relPath).toLowerCase();
		const absPath = path.join(candidateDir, relPath);
		const stat = await fs.stat(absPath);
		const header = await readHeaderBytes(absPath, BINARY_SNIFF_HEADER_BYTES);
		const sniffedFormat = sniffBinaryFormat(header);
		let isBinary = sniffedFormat !== null || BINARY_EXTENSIONS.has(ext);
		if (!isBinary) {
			// Neither fast path matched — the fail-closed default decides this file's fate now,
			// not a silent fall-through to the plain-text branch below. A second, larger read:
			// see looksLikeBinaryContent's own comment for why 32 bytes isn't enough window for
			// this judgment.
			const plausibilityWindow = await readHeaderBytes(absPath, TEXT_PLAUSIBILITY_SCAN_BYTES);
			isBinary = looksLikeBinaryContent(plausibilityWindow);
		}

		if (isBinary) {
			binaryFileCount++;
			if (stat.size > MAX_BINARY_SCAN_BYTES) {
				skippedLarge.push({ path: relPath, fingerprint: await fingerprintOversizedFile(relPath, absPath) });
				continue;
			}
			const buffer = await fs.readFile(absPath);
			const extractedText = extractPrintableStrings(buffer).join("\n");
			findings.push(...scanTextForContentMarkers(relPath, extractedText, markers));
			findings.push(...scanTextForDcCreator(relPath, extractedText));
			if (exiftoolAvailable) {
				const exifResult = runExiftoolJson(absPath);
				if (exifResult.status === "ok") {
					findings.push(...findExiftoolAuthorFindings(relPath, exifResult.data));
					if (sniffedFormat === null && exiftoolReportsRealFileType(exifResult.data)) {
						// Coverage-gap alarm, not a content finding: sniffBinaryFormat did not
						// recognize this file's bytes as any known signature, yet it still got binary
						// treatment (and therefore got scanned by exiftool at all) — either because
						// its extension was in BINARY_EXTENSIONS, or because the 2026-09-13
						// fail-closed default (looksLikeBinaryContent, above) judged its content
						// implausible as plain text. exiftool's own content-based analysis just
						// identified it as a real media type anyway, meaning the sniff table has a
						// gap for this shape. Before the 2026-09-13 fix, a file with this SAME byte
						// shape but an extension NOT in BINARY_EXTENSIONS would have been silently
						// treated as plain text — the fail-closed default now catches that case too
						// (this alarm cannot fire from inside the plain-text branch), but a sniff
						// table gap is still worth closing: fail-closed coverage is buffer-scan +
						// exiftool, not the tighter, format-specific magic-number fast path. Fix by
						// adding this format's magic number to BINARY_SIGNATURES, not by suppressing
						// this finding.
						const detectedFileType = groupedExiftoolValue(exifResult.data, "FileType");
						const detectedMimeType = groupedExiftoolValue(exifResult.data, "MIMEType") ?? "unknown";
						findings.push({
							path: relPath,
							line: 0,
							pattern: "sniff-coverage-gap",
							match: `exiftool identified this as ${detectedFileType} (MIME: ${detectedMimeType}); sniffBinaryFormat did not recognize it`,
							fingerprint: `${relPath}:sniff-coverage-gap:${fingerprintHash(String(detectedFileType))}`
						});
					}
				} else if (exifResult.status === "error") {
					// A single file's exiftool invocation failing is itself reported as an
					// unreviewed finding (never silently dropped) — the buffer-scan pass above
					// already ran against this same file regardless, so this is additive, not
					// the only signal.
					//
					// Deliberately NOT given the fingerprintHash(value) treatment applied to the
					// other binary-metadata findings above: this finding's "value" is exiftool's
					// own stderr wording, which can vary across exiftool versions/environments for
					// the exact same underlying file — not sensitive content. Suppressing it never
					// hides a PII leak, because coverage of the file's actual content never
					// depended on exiftool succeeding in the first place: the buffer-scan pass a
					// few lines up already ran unconditionally. Hashing volatile-but-harmless text
					// here would only manufacture churn, the exact failure mode this change exists
					// to remove everywhere else.
					findings.push({
						path: relPath,
						line: 0,
						pattern: "exiftool-error",
						match: exifResult.stderr ?? "unknown error",
						fingerprint: `${relPath}:exiftool-error:0`
					});
				} else if (exifResult.status === "missing-binary") {
					// 2026-09-10 MEDIUM fix: runExiftoolJson can return "missing-binary" if
					// exiftool vanishes mid-run after isExiftoolAvailable() already reported it
					// present (a narrow TOCTOU window) — this branch didn't exist, so the
					// per-file exif pass silently no-opped instead of failing loud, contradicting
					// this file's own stated principle for every other missing-tool case. Same
					// treatment as exiftool-error above: reported, not swallowed.
					findings.push({
						path: relPath,
						line: 0,
						pattern: "exiftool-missing-binary",
						match: "exiftool disappeared mid-scan (isExiftoolAvailable() reported it present; this invocation got ENOENT)",
						fingerprint: `${relPath}:exiftool-missing-binary:0`
					});
				}
			}
			continue;
		}

		if (stat.size > MAX_CONTENT_SCAN_BYTES) {
			skippedLarge.push({ path: relPath, fingerprint: await fingerprintOversizedFile(relPath, absPath) });
			continue;
		}
		let text;
		try {
			text = await fs.readFile(absPath, "utf8");
		} catch (err) {
			// 2026-09-10: this used to `continue` silently on the claim that "path allowlist +
			// gitleaks still cover it" — the same false coverage claim the oversized-skip fix
			// below removes, for the same reason: gitleaks hunts credentials, not PII, and an
			// unreadable file was never scanned by anything. A file this gate cannot read is
			// exactly as unreviewed as one it chose not to scan for being oversized — reported
			// as a finding so it fails the gate the same way, not silently waved through.
			findings.push({
				path: relPath,
				line: 0,
				pattern: "unreadable-as-text",
				match: `could not read this file to scan it: ${err.code ?? err.message ?? "unknown error"}`,
				fingerprint: `${relPath}:unreadable-as-text:0`
			});
			continue;
		}
		findings.push(...scanTextForContentMarkers(relPath, text, markers));
		findings.push(...scanTextForDcCreator(relPath, text));
	}
	return { findings, skippedLarge, binaryFileCount };
}

// ── gitleaks ─────────────────────────────────────────────────────────────────

export function runGitleaks(candidateDir, baselinePath, tmpReportPath) {
	const args = [
		"detect",
		"--no-git",
		"--source", ".",
		"--report-format", "json",
		"--report-path", tmpReportPath,
		"--exit-code", "1",
		"--no-banner",
		"--redact"
	];
	if (baselinePath) args.push("--baseline-path", baselinePath);
	// cwd (not an absolute --source) matters: gitleaks reports File relative to
	// whatever --source was given, so an absolute candidateDir would bake a
	// throwaway temp-dir path into Fingerprint, making every finding "new" on
	// every run and silently defeating the baseline suppression mechanism. Every
	// candidate directory reports itself as "." this way, so fingerprints are
	// stable and comparable across releases.
	const result = spawnSync("gitleaks", args, { encoding: "utf8", cwd: candidateDir });
	if (result.error) {
		if (result.error.code === "ENOENT") {
			return { status: "missing-binary", stderr: result.stderr ?? "" };
		}
		return { status: "error", stderr: String(result.error) };
	}
	// gitleaks' own convention: 0 = clean, 1 (our --exit-code) = leaks found.
	// Anything else is gitleaks itself failing to run — that is NOT a clean scan
	// and must not be treated as one.
	if (result.status === 0) return { status: "clean" };
	if (result.status === 1) return { status: "leaks-found" };
	return { status: "error", stderr: result.stderr ?? `gitleaks exited ${result.status}` };
}

// Splits scan findings into unreviewed (must fail the gate) and suppressed (already
// reviewed, per the manifest's reviewedContentFindings) by fingerprint. Pulled out of
// main() so the exact suppression logic the gate runs in production is what a test can
// call directly against a synthetic reviewedContentFindings array — the whole point of
// the regression test this change adds is proving a stale/mismatched fingerprint does
// NOT suppress a new match, and that needs to exercise this real lookup, not a
// reimplementation of it in test scope.
export function partitionFindingsBySuppression(findings, reviewedEntries) {
	const reviewed = new Map(reviewedEntries.map((e) => [e.fingerprint, e]));
	return {
		reviewed,
		unreviewed: findings.filter((f) => !reviewed.has(f.fingerprint)),
		suppressed: findings.filter((f) => reviewed.has(f.fingerprint))
	};
}

// Splits the oversized-and-therefore-unscanned file list into ones a human has
// deliberately reviewed and exempted (manifest.oversizedExceptions) versus ones that must
// fail the gate. An unscanned file defaults to failing: it is not "covered" by the path
// allowlist or gitleaks (gitleaks hunts credentials, not PII — verified empirically, see
// the 2026-09-10 CRITICAL fix this function exists for), so there is no mechanism that
// gets to claim it was checked unless a human actually looked at it and said so here.
//
// 2026-09-13 fix: matched by `fingerprint` (`${path}:${hash of the file's own content}`,
// see fingerprintOversizedFile above), not by path alone — same "edit a tracked, reviewed
// file" discipline as reviewedContentFindings and the gitleaks baseline, never a flag or
// env var, but exact-path-only keying was fail-open on replacement: a human reviews and
// exempts file X today; a later release swaps a different, larger, sensitive file into
// that same path and the old approval silently still applied, with no re-review and no
// signal. `skippedLarge` entries are `{path, fingerprint}` objects (built by
// scanCandidateForPublicationRisks), not bare path strings.
export function partitionSkippedLargeByException(skippedLarge, oversizedExceptions) {
	const exceptions = new Map((oversizedExceptions ?? []).map((e) => [e.fingerprint, e]));
	return {
		exceptions,
		exempted: skippedLarge.filter((f) => exceptions.has(f.fingerprint)),
		unreviewed: skippedLarge.filter((f) => !exceptions.has(f.fingerprint))
	};
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(argv) {
	const candidateDir = argv[2];
	if (!candidateDir) {
		console.error("Usage: node ops/verify-public-release.mjs <candidate-dir>");
		console.error("See ops/public-release-manifest.json's _howToInvoke for how to assemble a candidate.");
		process.exitCode = 2;
		return;
	}

	let candidateStat;
	try {
		candidateStat = await fs.stat(candidateDir);
	} catch {
		console.error(`ERROR: candidate directory does not exist: ${candidateDir}`);
		process.exitCode = 2;
		return;
	}
	if (!candidateStat.isDirectory()) {
		console.error(`ERROR: not a directory: ${candidateDir}`);
		process.exitCode = 2;
		return;
	}

	let manifest;
	try {
		manifest = await loadManifest();
	} catch (err) {
		console.error(`ERROR: could not load ${MANIFEST_PATH}: ${err.message}`);
		process.exitCode = 2;
		return;
	}

	const selfCheckErrors = findManifestSelfConsistencyErrors(manifest);
	if (selfCheckErrors.length > 0) {
		for (const e of selfCheckErrors) console.error(e);
		process.exitCode = 2;
		return;
	}

	const contentMarkerErrors = findContentMarkersMissingContextScope();
	if (contentMarkerErrors.length > 0) {
		for (const e of contentMarkerErrors) console.error(e);
		process.exitCode = 2;
		return;
	}

	let failed = false;
	const allowPatterns = manifest.allow.map((e) => e.pattern);
	const neverAllowPatterns = manifest.neverAllow.map((e) => e.pattern);

	console.log(`[verify-public-release] Scanning candidate: ${candidateDir}`);

	// 1. Path allowlist
	const { files, symlinks } = await listCandidateFiles(candidateDir);
	if (symlinks.length > 0) {
		failed = true;
		for (const s of symlinks) console.error(`SYMLINK NOT ALLOWED IN CANDIDATE: ${s}`);
	}
	const unlisted = findUnlistedPaths(files, allowPatterns);
	if (unlisted.length > 0) {
		failed = true;
		console.error(
			`\n${unlisted.length} path(s) not on the allowlist — this FAILS the gate (see "FAIL" below), it does not filter ` +
			"them out for you. This script only scans; it never assembles or excludes. If you fed it a raw " +
			"`git archive | tar -x` tree, that is the whole source tree, unfiltered — use ops/assemble-public-release.mjs " +
			"to build a candidate containing only allowlisted paths first, then run this gate against that candidate:"
		);
		for (const p of unlisted) {
			const explicit = manifest.neverAllow.find((e) => matchesAnyPattern(p, [e.pattern]));
			if (explicit) {
				console.error(`  NOT ON ALLOWLIST (deliberately excluded — ${explicit.reason}): ${p}`);
			} else {
				console.error(`  NOT ON ALLOWLIST: ${p}`);
			}
		}
	} else {
		console.log(`[verify-public-release] All ${files.length} file(s) matched the allowlist.`);
	}

	// 2. gitleaks
	const tmpReportPath = path.join(os.tmpdir(), `verify-public-release-gitleaks-${process.pid}.json`);
	const gitleaksResult = runGitleaks(candidateDir, GITLEAKS_BASELINE_PATH, tmpReportPath);
	if (gitleaksResult.status === "missing-binary") {
		failed = true;
		console.error("\nGITLEAKS NOT INSTALLED — refusing to skip the secret scan silently. Install gitleaks and re-run.");
	} else if (gitleaksResult.status === "error") {
		failed = true;
		console.error(`\nGITLEAKS FAILED TO RUN — treating as a failed scan, not a clean one:\n${gitleaksResult.stderr}`);
	} else if (gitleaksResult.status === "leaks-found") {
		failed = true;
		let report = [];
		try {
			report = JSON.parse(await fs.readFile(tmpReportPath, "utf8"));
		} catch {
			// report unreadable; still fail — the exit code already told us leaks exist
		}
		console.error(`\n${report.length || "some"} gitleaks finding(s) not covered by ops/public-release-gitleaks-baseline.json:`);
		for (const f of report) {
			console.error(`  GITLEAKS [${f.RuleID}] ${f.File}:${f.StartLine} — fingerprint ${f.Fingerprint}`);
		}
		console.error(
			`  Full finding records are in: ${tmpReportPath}\n` +
			"  To suppress a REVIEWED false positive: copy that finding's exact object (as printed in the\n" +
			"  file above) into ops/public-release-gitleaks-baseline.json's array. gitleaks' own baseline\n" +
			"  matcher compares nearly the whole record (RuleID, File, Start/EndLine, Start/EndColumn,\n" +
			"  Entropy — verified empirically, not just Fingerprint) — hand-typing a minimal " +
			'{"Fingerprint": "..."} entry will NOT suppress it. Copy the object, don\'t retype it.'
		);
	} else {
		console.log("[verify-public-release] gitleaks: clean.");
		await fs.rm(tmpReportPath, { force: true });
	}

	// 3. name denylist — a local, gitignored, non-published list of real-person name
	// fragments (see ops/.release-name-denylist.local.example). An absent denylist is
	// UNKNOWN, not clean: this gate cannot claim to have screened for a real name it was
	// never told about, so it fails loud rather than silently scanning with zero names
	// configured and calling that a pass.
	const { fragments: nameFragments, present: denylistPresent } = await loadNameDenylistFragments();
	if (!denylistPresent) {
		failed = true;
		console.error(
			"\nNAME DENYLIST MISSING: ops/.release-name-denylist.local not found. An absent " +
			"denylist is UNKNOWN, not clean. Copy ops/.release-name-denylist.local.example to " +
			"ops/.release-name-denylist.local, list the real name(s) to guard (one fragment per " +
			"line, e.g. full legal name and surname alone), and re-run. That file is gitignored " +
			"and must never be committed."
		);
	}
	const nameDenylistMarker = buildNameDenylistMarker(nameFragments);
	const allMarkers = nameDenylistMarker ? [...CONTENT_MARKERS, nameDenylistMarker] : CONTENT_MARKERS;

	// 4. exiftool — an additional structural EXIF/IPTC/XMP pass over every binary. Never
	// skipped-because-missing: the buffer-scan fallback below always runs regardless, but
	// a missing exiftool is reported the same way a missing gitleaks is (see step 2) —
	// loud, blocking, not a quiet degrade — scoped to only fire when the candidate
	// actually contains a binary file exiftool would have added coverage for.
	const exiftoolAvailable = isExiftoolAvailable();
	if (exiftoolAvailable) {
		console.log("[verify-public-release] exiftool available — running as an additional structural metadata pass on binaries.");
	}

	// 5. content-marker + binary-metadata scan (PII / production-id shapes / author fields)
	const { findings, skippedLarge, binaryFileCount } = await scanCandidateForPublicationRisks(candidateDir, files, {
		markers: allMarkers,
		exiftoolAvailable
	});
	if (!exiftoolAvailable && binaryFileCount > 0) {
		failed = true;
		console.error(
			`\nEXIFTOOL NOT INSTALLED — ${binaryFileCount} binary file(s) in this candidate could only ` +
			"be scanned with the reduced buffer-scan fallback (printable-string extraction + XMP/PDF " +
			"tag-pattern matching + name-denylist matching all still ran and their findings are reported " +
			"below same as always). This is the same missing-binary shape as a missing gitleaks: never " +
			"treated as a clean scan. Install exiftool and re-run for full EXIF/IPTC/binary-XMP coverage."
		);
	}
	const { reviewed, unreviewed, suppressed } = partitionFindingsBySuppression(findings, manifest.reviewedContentFindings);
	if (suppressed.length > 0) {
		console.log(`\n${suppressed.length} content marker(s) suppressed via reviewedContentFindings:`);
		for (const f of suppressed) {
			console.log(`  SUPPRESSED (reviewed): ${f.path}:${f.line} [${f.pattern}] — ${reviewed.get(f.fingerprint).reason}`);
		}
	}
	if (unreviewed.length > 0) {
		failed = true;
		console.error(`\n${unreviewed.length} unreviewed content marker(s) — report for a human to judge, does not auto-approve:`);
		for (const f of unreviewed) {
			const location = f.line > 0 ? `${f.path}:${f.line}` : `${f.path} (binary — no line number)`;
			console.error(`  MARKER [${f.pattern}] ${location} — "${f.match}"`);
		}
		console.error("  To suppress a reviewed false positive: add its fingerprint (printed above the match) to reviewedContentFindings in ops/public-release-manifest.json, with a reason.");
	} else {
		console.log("[verify-public-release] content-marker scan: no unreviewed findings.");
	}
	if (skippedLarge.length > 0) {
		// 2026-09-10 CRITICAL fix: this used to be a console.log NOTE claiming the skipped scan
		// was "still covered by path allowlist + gitleaks" — tested against real gitleaks
		// 8.30.1: a file containing a real-shaped email, this codebase's own obs_<ts>_<hex> id
		// shape, and a valid IBAN produces ZERO gitleaks findings. gitleaks hunts credentials,
		// not PII. That backstop does not exist. Every other "a coverage layer is unavailable"
		// case in this file already blocks (missing gitleaks, missing exiftool, missing name
		// denylist) — this was the one place that philosophy was abandoned for a NOTE line.
		// "We did not scan this" is a FAIL line now, unless a human reviewed it by hand and
		// said so in oversizedExceptions.
		const { exceptions, exempted, unreviewed } = partitionSkippedLargeByException(skippedLarge, manifest.oversizedExceptions);
		if (exempted.length > 0) {
			console.log(`\n${exempted.length} oversized file(s) exempted via oversizedExceptions (a human reviewed these by hand; they are still unscanned by this gate, by design):`);
			// 2026-09-13 fix (Reeve MEDIUM/92): every oversizedExceptions entry requires and
			// validates a reason, and it was never printed here -- the EXEMPTED branch logged
			// only the path, while its sibling SUPPRESSED branch (content-marker findings,
			// above) has always printed `— ${reason}`. The exceptions Map already carries it;
			// this was purely a read the print side never did. Silently dropping the reason
			// undercut the manifest's own stated purpose ("so the decision is visible to
			// whoever reviews it").
			for (const f of exempted) console.log(`  EXEMPTED (reviewed, unscanned): ${f.path} — ${exceptions.get(f.fingerprint).reason}`);
		}
		if (unreviewed.length > 0) {
			failed = true;
			console.error(
				`\n${unreviewed.length} file(s) skipped content-marker/metadata scanning for being oversized ` +
				"(over 2MB for text, over 25MB for binaries) — this FAILS the gate. An unscanned file is not " +
				"a covered file. To ship one of these anyway: shrink it under the limit, split it into smaller " +
				"allowlisted pieces, or — after actually reading its content yourself — add its fingerprint " +
				"(printed below) to oversizedExceptions in ops/public-release-manifest.json with a reason:"
			);
			for (const f of unreviewed) console.error(`  SKIPPED (oversized, UNREVIEWED): ${f.path} — fingerprint ${f.fingerprint}`);
		}
	}

	if (failed) {
		console.error("\n[verify-public-release] FAIL. Do not publish this candidate.");
		process.exitCode = 1;
	} else {
		console.log(`\n[verify-public-release] PASS — ${files.length} file(s), all allowlisted, gitleaks clean, no unreviewed content markers.`);
		process.exitCode = 0;
	}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main(process.argv).catch((err) => {
		console.error("[verify-public-release] UNEXPECTED ERROR:", err);
		process.exitCode = 2;
	});
}
