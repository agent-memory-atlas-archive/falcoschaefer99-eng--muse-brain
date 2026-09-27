/**
 * Content-based binary/media format sniffing: identifies well-known binary container
 * formats from their leading bytes, independent of file extension.
 *
 * Extracted from ops/verify-public-release.mjs (2026-09-13, Reeve LOW/82 -- his second
 * answer on this file after initially saying "leave it as one file", which he doesn't
 * change lightly). These five exports are ~74 lines of pure functions with zero coupling
 * to anything else in that file: a genuinely reusable "detect a binary format from bytes"
 * utility that has nothing to do with verifying a release. verify-public-release.mjs
 * re-exports sniffBinaryFormat so every existing import of it (including this repo's own
 * test suite) keeps working unchanged.
 *
 * Deliberately NOT exhaustive of every binary format that has ever existed — it covers
 * the shapes named in the original 2026-09 fix mandate (images, fonts, archives, SQLite,
 * common audio/video containers, legacy OLE2 CFB documents) plus PDF and ZIP-family. A
 * format with no signature here falls through to verify-public-release.mjs's own
 * fail-closed default for content that isn't plausibly plain text either (see that
 * file's TEXT_PLAUSIBILITY_* constants and looksLikeBinaryContent), or to its
 * sniff-coverage-gap alarm if exiftool recognizes the file as real media when this sniff
 * didn't.
 */

// Sized for fixed-offset magic numbers, not a statistical judgment about a file's content
// as a whole (see verify-public-release.mjs's separate, larger TEXT_PLAUSIBILITY_SCAN_BYTES
// window for that).
export const BINARY_SNIFF_HEADER_BYTES = 32;

export function startsWithBytes(buffer, bytes) {
	if (buffer.length < bytes.length) return false;
	for (let i = 0; i < bytes.length; i++) {
		if (buffer[i] !== bytes[i]) return false;
	}
	return true;
}

export function matchesAsciiAt(buffer, offset, ascii) {
	if (buffer.length < offset + ascii.length) return false;
	for (let i = 0; i < ascii.length; i++) {
		if (buffer[offset + i] !== ascii.charCodeAt(i)) return false;
	}
	return true;
}

export const BINARY_SIGNATURES = [
	{ name: "png", test: (b) => startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
	{ name: "jpeg", test: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]) },
	{ name: "gif", test: (b) => matchesAsciiAt(b, 0, "GIF8") },
	{ name: "tiff-little-endian", test: (b) => startsWithBytes(b, [0x49, 0x49, 0x2a, 0x00]) },
	{ name: "tiff-big-endian", test: (b) => startsWithBytes(b, [0x4d, 0x4d, 0x00, 0x2a]) },
	// WebP and WAV share the RIFF container shape (RIFF, 4-byte size, then a format tag) —
	// distinguished by the tag at byte offset 8.
	{ name: "webp", test: (b) => matchesAsciiAt(b, 0, "RIFF") && matchesAsciiAt(b, 8, "WEBP") },
	{ name: "wav", test: (b) => matchesAsciiAt(b, 0, "RIFF") && matchesAsciiAt(b, 8, "WAVE") },
	// ISO base media file format: the container shape shared by MP4, MOV, HEIC, and AVIF
	// (a 4-byte box size, then the literal "ftyp", then a brand code this sniff does not
	// need to distinguish further — every brand under this box is a real media container).
	{ name: "iso-bmff", test: (b) => matchesAsciiAt(b, 4, "ftyp") },
	{ name: "bmp", test: (b) => startsWithBytes(b, [0x42, 0x4d]) },
	{ name: "ico", test: (b) => startsWithBytes(b, [0x00, 0x00, 0x01, 0x00]) },
	{ name: "pdf", test: (b) => matchesAsciiAt(b, 0, "%PDF-") },
	{ name: "zip", test: (b) =>
		startsWithBytes(b, [0x50, 0x4b, 0x03, 0x04]) ||
		startsWithBytes(b, [0x50, 0x4b, 0x05, 0x06]) ||
		startsWithBytes(b, [0x50, 0x4b, 0x07, 0x08]) },
	{ name: "gzip", test: (b) => startsWithBytes(b, [0x1f, 0x8b]) }, // also covers .tgz
	{ name: "woff", test: (b) => matchesAsciiAt(b, 0, "wOFF") },
	{ name: "woff2", test: (b) => matchesAsciiAt(b, 0, "wOF2") },
	{ name: "truetype-opentype", test: (b) =>
		startsWithBytes(b, [0x00, 0x01, 0x00, 0x00]) || matchesAsciiAt(b, 0, "true") ||
		matchesAsciiAt(b, 0, "ttcf") || matchesAsciiAt(b, 0, "OTTO") },
	{ name: "sqlite", test: (b) => matchesAsciiAt(b, 0, "SQLite format 3\0") },
	// Legacy .doc/.xls/.ppt container (Compound File Binary Format). 2026-09-13 CRITICAL
	// fix (see verify-public-release.mjs's file-header addendum): the third instance of
	// the same defect class, found by Michael, reachable today via cli/**, runner/**,
	// muse-brain/scripts/**, and muse-brain/templates/** with zero manifest change.
	{ name: "ole2-cfb", test: (b) => startsWithBytes(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
	{ name: "ogg", test: (b) => matchesAsciiAt(b, 0, "OggS") },
	{ name: "mp3-id3", test: (b) => matchesAsciiAt(b, 0, "ID3") },
	// A bare MP3 frame sync (no ID3 header) is an 11-bit run of 1s at the start of the
	// frame: byte 0 all-1s, byte 1's top 3 bits also 1s.
	{ name: "mp3-frame-sync", test: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
	{ name: "webm-mkv", test: (b) => startsWithBytes(b, [0x1a, 0x45, 0xdf, 0xa3]) } // EBML
];

export function sniffBinaryFormat(buffer) {
	for (const sig of BINARY_SIGNATURES) {
		if (sig.test(buffer)) return sig.name;
	}
	return null;
}
