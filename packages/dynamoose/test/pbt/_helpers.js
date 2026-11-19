// Shared helpers for property-based test suites (discovery branch only).
//
// IMPORTANT: This directory holds DISCOVERY machinery. It is deliberately
// unoptimized and may contain exploratory properties. Only confirmed
// regressions belong in a real fix branch.

const fc = require("fast-check");

/**
 * Run a property with a deterministic-ish budget.
 * @param {any} property fast-check property
 * @param {object} [options]
 * @param {number} [options.numRuns] number of generated cases
 * @param {number} [options.seed] random seed for reproducibility
 * @param {string} [options.label] human readable name used in failure output
 */
const runProperty = (property, options = {}) => {
	const {numRuns = 500, seed, label} = options;
	const params = {numRuns};
	if (seed !== undefined) {
		params.seed = seed;
	}
	fc.assert(property, params);
	if (label) {
		// eslint-disable-next-line no-console
		console.log(`[pbt] ok: ${label} (${numRuns} runs)`);
	}
};

// A plain JSON-ish value that avoids prototype-pollution and non-serializable types.
const jsonValue = fc.letrec((tie) => fc.oneof(
	{weight: 6, arbitrary: fc.constant(null)},
	{weight: 6, arbitrary: fc.boolean()},
	{weight: 10, arbitrary: fc.integer()},
	{weight: 10, arbitrary: fc.double({noNaN: true, noDefaultInfinity: true})},
	{weight: 10, arbitrary: fc.string({maxLength: 12})},
	{weight: 4, arbitrary: fc.array(tie("jsonValue"), {maxLength: 4})},
	{weight: 4, arbitrary: fc.dictionary(fc.string({maxLength: 6}), tie("jsonValue"), {maxKeys: 4})}
));

// A safe plain object (no __proto__/constructor keys).
const plainObject = fc.dictionary(
	fc.string({minLength: 1, maxLength: 8}).filter((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype"),
	jsonValue,
	{maxKeys: 6}
);

module.exports = {fc, runProperty, jsonValue, plainObject};
