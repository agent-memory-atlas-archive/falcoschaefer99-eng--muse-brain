#!/usr/bin/env node

/**
 * Assembles a public-release publish candidate: copies the subset of a source
 * tree that ops/public-release-manifest.json's `allow` list actually admits
 * into a clean output directory, ready to hand to
 * ops/verify-public-release.mjs.
 *
 * Why this exists: the manifest's own `_howToInvoke` used to document a
 * two-step flow -- `git archive <ref> | tar -x` to build a candidate, then run
 * the verify gate against it directly. That produces the FULL tracked source
 * tree, and verify-public-release.mjs hard-fails (`findUnlistedPaths` ->
 * `failed = true`) on any path not explicitly allowlisted. Following the
 * documented procedure exactly could therefore never pass -- there was no
 * step anywhere in this repo that actually filtered the tree down to what the
 * manifest allows before handing it to the gate. This script is that missing
 * step.
 *
 * Deliberately reuses loadManifest / listCandidateFiles / findUnlistedPaths
 * from verify-public-release.mjs rather than reimplementing glob matching or
 * directory walking here -- an assembler and a gate that each maintain their
 * own idea of "what matches the allowlist" can drift apart silently. This
 * way, whatever verify-public-release.mjs considers allowlisted is exactly
 * what this script ships, by construction, not by two hand-kept lists
 * agreeing on paper.
 *
 * Usage:
 *   node ops/assemble-public-release.mjs <source-dir> <output-dir> [--force]
 *
 * <source-dir> is a tracked working tree (e.g. the output of
 * `git archive <ref> | tar -x -C <source-dir>`). <output-dir> must not exist
 * or must be empty, unless --force is passed, in which case it is removed and
 * recreated fresh (never merged with leftovers from a previous run).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, listCandidateFiles, findUnlistedPaths, findManifestSelfConsistencyErrors } from "./verify-public-release.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function outputDirIsEmpty(outputDir) {
	let entries;
	try {
		entries = await fs.readdir(outputDir);
	} catch (err) {
		if (err.code === "ENOENT") return true; // doesn't exist yet -- that's fine, mkdir will create it
		throw err;
	}
	return entries.length === 0;
}

/**
 * Pure assembly step: copies every allowlisted file from sourceDir into
 * outputDir. Returns a status-tagged result rather than throwing for the
 * expected failure mode (non-empty output dir without --force) so callers
 * (including tests) can inspect the outcome without a try/catch -- mirrors
 * this repo's existing status-object convention (see runGitleaks,
 * runExiftoolJson in verify-public-release.mjs).
 *
 * Symlinks found in sourceDir are never copied (a candidate containing one
 * fails verify-public-release.mjs outright -- "SYMLINK NOT ALLOWED IN
 * CANDIDATE") but are always returned in the result for the caller to
 * surface, never silently dropped.
 */
export async function assembleCandidate({ sourceDir, outputDir, manifest, force = false }) {
	const allowPatterns = manifest.allow.map((e) => e.pattern);
	const { files, symlinks } = await listCandidateFiles(sourceDir);
	const unlisted = findUnlistedPaths(files, allowPatterns);
	const unlistedSet = new Set(unlisted);
	const shipping = files.filter((f) => !unlistedSet.has(f));

	if (force) {
		await fs.rm(outputDir, { recursive: true, force: true });
	} else if (!(await outputDirIsEmpty(outputDir))) {
		return { status: "output-not-empty", files, symlinks, unlisted, shipping };
	}
	await fs.mkdir(outputDir, { recursive: true });

	for (const rel of shipping) {
		const from = path.join(sourceDir, rel);
		const to = path.join(outputDir, rel);
		await fs.mkdir(path.dirname(to), { recursive: true });
		await fs.copyFile(from, to);
	}

	return { status: "ok", files, symlinks, unlisted, shipping };
}

async function main(argv) {
	const sourceDir = argv[2];
	const outputDir = argv[3];
	const force = argv.includes("--force");

	if (!sourceDir || !outputDir) {
		console.error("Usage: node ops/assemble-public-release.mjs <source-dir> <output-dir> [--force]");
		console.error("See ops/public-release-manifest.json's _howToInvoke for the full three-step release flow.");
		process.exitCode = 2;
		return;
	}

	let sourceStat;
	try {
		sourceStat = await fs.stat(sourceDir);
	} catch {
		console.error(`ERROR: source directory does not exist: ${sourceDir}`);
		process.exitCode = 2;
		return;
	}
	if (!sourceStat.isDirectory()) {
		console.error(`ERROR: not a directory: ${sourceDir}`);
		process.exitCode = 2;
		return;
	}

	let manifest;
	try {
		manifest = await loadManifest(path.join(__dirname, "public-release-manifest.json"));
	} catch (err) {
		console.error(`ERROR: could not load the manifest: ${err.message}`);
		process.exitCode = 2;
		return;
	}

	// LOW fix (2026-09-10): verify-public-release.mjs runs this check first thing; this
	// assembler didn't run it at all. Not a security gap on its own -- the gate re-validates
	// unconditionally regardless of what this script assembles -- but a broken manifest
	// should fail at the FIRST tool to load it, not one step later at the second.
	const selfCheckErrors = findManifestSelfConsistencyErrors(manifest);
	if (selfCheckErrors.length > 0) {
		for (const e of selfCheckErrors) console.error(e);
		process.exitCode = 2;
		return;
	}

	const result = await assembleCandidate({ sourceDir, outputDir, manifest, force });

	if (result.status === "output-not-empty") {
		console.error(`ERROR: output directory is not empty: ${outputDir}`);
		console.error("Refusing to write into a non-empty directory. Pass --force to remove it and start fresh, or point at an empty/new directory.");
		process.exitCode = 2;
		return;
	}

	if (result.symlinks.length > 0) {
		console.log(`[assemble-public-release] NOTE: ${result.symlinks.length} symlink(s) found in the source tree and NOT copied (a candidate containing a symlink fails verify-public-release.mjs outright):`);
		for (const s of result.symlinks) console.log(`  SKIPPED SYMLINK: ${s}`);
	}

	console.log(`[assemble-public-release] source files:   ${result.files.length}`);
	console.log(`[assemble-public-release] unlisted:       ${result.unlisted.length}`);
	console.log(`[assemble-public-release] SHIPPING:       ${result.shipping.length}`);
	console.log(`[assemble-public-release] wrote candidate to: ${outputDir}`);
	process.exitCode = 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main(process.argv).catch((err) => {
		console.error("[assemble-public-release] UNEXPECTED ERROR:", err);
		process.exitCode = 2;
	});
}
