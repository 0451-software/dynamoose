// PBT: `dynamoose-utils` wildcard_allowed_check.
//
// The intended semantics are derived from the EXISTING test file
// `packages/dynamoose/test/utils/dynamoose/wildcard_allowed_check.js`:
//
//   [true,  "random"]                  -> true    (boolean passthrough)
//   [false, "random"]                  -> false   (boolean passthrough)
//   [["random"], "random"]             -> true    (literal matches itself)
//   [["other"], "random"]              -> false   (literal mismatch)
//   [["random"], "random.test"]        -> false   (pattern is a strict prefix of the key)
//   [["random.1"], "random.1"]         -> true
//   [["random.1"], "random.2"]         -> false
//   [["random.test"], "random"]        -> true    (key is a strict prefix of the pattern)
//   [["random.*"], "random"]            -> true    (`*` may match zero segments)
//   [["random.*"], "random.test"]       -> true    (`*` matches exactly one segment)
//   [["random.*"], "random.test.random"]-> false   (`*` must not match two segments)
//   [["random.*.hello"], "random.test.hello"]     -> true
//   [["random.*.hello"], "random.test.random"]    -> false
//   [["random.*.hello"], "random.test.hello.test"]-> false
//   [["random.**"], "random.test.random"] -> true  (`**` matches many segments)
//   [["**"], "random.test.random"]        -> true
//
// The reference model below is written from those expectations, independently of the
// implementation in packages/dynamoose-utils/lib/wildcard_allowed_check.ts.
//
// NOTE: the existing test file explicitly marks `**` followed by a literal segment as
// "TODO: add support for this later", so that case is *not* treated as a bug here.
const {fc} = require("./_helpers");
const {wildcard_allowed_check} = require("dynamoose-utils");

/**
 * Independent reference model of the wildcard semantics.
 *
 * @param {string[]} patterns list of allowed patterns
 * @param {string} checkKey  dotted path to test
 * @returns {boolean}
 */
const referenceMatch = (patterns, checkKey) => {
	if (!Array.isArray(patterns)) {
		return patterns;
	}
	return patterns.some((pattern) => {
		const patternParts = pattern.split(".");
		const keyParts = checkKey.split(".");
		let patternIndex = 0;
		for (let keyIndex = 0; keyIndex < keyParts.length; keyIndex++) {
			if (patternIndex >= patternParts.length) {
				// The pattern ran out of segments while the key still has some left.
				return false;
			}
			if (patternParts[patternIndex] === "**") {
				// `**` swallows the remaining key segments (zero or more).
				return true;
			}
			if (patternParts[patternIndex] !== "*" && patternParts[patternIndex] !== keyParts[keyIndex]) {
				return false;
			}
			patternIndex++;
		}
		// The key was fully consumed. A pattern with leftover segments still matches
		// (the key is a prefix of the pattern) — see ["random.test"] vs "random" -> true.
		return true;
	});
};

// Segments must not contain "." — otherwise the segment count of a generated key
// would not match the number of generated segments.
const segmentArb = fc.oneof(
	fc.constantFrom("a", "b", "c", "random", "test", "hello", "0", "1"),
	fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes("."))
);

const patternArb = fc.array(segmentArb, {minLength: 1, maxLength: 4}).map((parts) => parts.join("."));
const keyArb = fc.array(segmentArb, {minLength: 1, maxLength: 4}).map((parts) => parts.join("."));

/** Patterns that contain no `**` (the `**` semantics are covered separately). */
const simplePatternArb = fc.array(
	fc.oneof(segmentArb, fc.constant("*")),
	{minLength: 1, maxLength: 4}
).map((parts) => parts.join("."));

/**
 * Patterns made only of literal segments (no `*`, no `**`).
 * A segment that is exactly "*" is a wildcard for the implementation, so it is
 * excluded here as well.
 */
const literalPatternArb = fc.array(
	segmentArb.filter((s) => !s.includes("*")),
	{minLength: 1, maxLength: 4}
).map((parts) => parts.join("."));

describe("dynamoose-utils wildcard_allowed_check", () => {
	it("matches the reference model for patterns without '**'", () => {
		fc.assert(fc.property(
			fc.array(simplePatternArb, {minLength: 1, maxLength: 3}),
			keyArb,
			(patterns, key) => {
				return wildcard_allowed_check(patterns, key) === referenceMatch(patterns, key);
			}
		), {numRuns: 5000});
		// eslint-disable-next-line no-console
		console.log("[pbt] ok: wildcard_allowed_check matches reference model (5000 runs)");
	});

	it("passes booleans straight through", () => {
		fc.assert(fc.property(
			fc.boolean(),
			fc.string({minLength: 1}),
			(flag, key) => wildcard_allowed_check(flag, key) === flag
		), {numRuns: 500});
		// eslint-disable-next-line no-console
		console.log("[pbt] ok: wildcard_allowed_check boolean passthrough (500 runs)");
	});

	it("'**' matches zero or more trailing segments", () => {
		fc.assert(fc.property(
			fc.array(segmentArb, {minLength: 1, maxLength: 3}),
			fc.array(segmentArb, {minLength: 0, maxLength: 4}),
			(prefix, rest) => {
				const pattern = [...prefix, "**"].join(".");
				const key = [...prefix, ...rest].join(".");
				return wildcard_allowed_check([pattern], key) === true;
			}
		), {numRuns: 2000});
		// eslint-disable-next-line no-console
		console.log("[pbt] ok: '**' matches zero or more trailing segments (2000 runs)");
	});

	it("'*' matches exactly one segment and never two", () => {
		fc.assert(fc.property(
			fc.array(segmentArb, {minLength: 1, maxLength: 3}),
			fc.array(segmentArb, {minLength: 0, maxLength: 2}),
			(prefix, rest) => {
				const pattern = [...prefix, "*"].join(".");
				const key = [...prefix, ...rest].join(".");
				const expected = rest.length === 0 || rest.length === 1;
				return wildcard_allowed_check([pattern], key) === expected;
			}
		), {numRuns: 2000});
		// eslint-disable-next-line no-console
		console.log("[pbt] ok: '*' matches at most one segment (2000 runs)");
	});

	it("a literal pattern only matches itself (or a key it is a prefix of)", () => {
		fc.assert(fc.property(
			literalPatternArb,
			keyArb,
			(pattern, key) => {
				const patternParts = pattern.split(".");
				const keyParts = key.split(".");
				const isPrefix = keyParts.length <= patternParts.length &&
					keyParts.every((part, index) => part === patternParts[index]);
				return wildcard_allowed_check([pattern], key) === isPrefix;
			}
		), {numRuns: 2000});
		// eslint-disable-next-line no-console
		console.log("[pbt] ok: literal pattern matches only itself / its prefixes (2000 runs)");
	});
});
