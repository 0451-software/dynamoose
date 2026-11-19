// PBT discovery: utils.merge_objects / utils.combine_objects
//
// Contracts under test, derived from the source + the existing unit tests in
// packages/dynamoose/test/utils/{merge_objects,combine_objects}.js:
//
//   C1  null nested values must not crash with an opaque TypeError.
//       merge_objects.js documents two error messages ("You can only pass objects
//       into merge_objects method." / "You can't mix value types ...") — no other
//       failure mode is documented.
//   C2  combining must not corrupt the global prototype (Object.prototype).
//   C3  merge_objects must not mutate its arguments.
//   C4  under combineMethod "array_merge_new_array" the result SHAPE must not
//       depend on the truthiness of the first operand. merge_objects.js:30-33
//       shows that method turning nested scalars into 2-element arrays.
//   C5  under the default combine method numbers are ADDED (merge_objects.js:26-27
//       expects {"b":1},{"b":2},{"b":3} -> {"b":6}); the "add" branch is selected by
//       `typeof returnObject[key] === "number"` and must therefore also apply to 0.
//
// `it.failing` blocks are expected-to-fail characterization tests: they pin the CURRENT
// (buggy) behaviour and will start failing the suite once the bug is fixed (remove the
// `.failing` then). The "characterization" tests assert the current behaviour directly.

const {fc, runProperty} = require("./_helpers");
const utils = require("../../dist/utils").default;

const AMNA = "array_merge_new_array";
const OBJ = "object_combine";

// Keys that are safe to use as plain object keys.
const safeKey = fc.string({minLength: 1, maxLength: 6}).filter((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype");

// A JSON value that is safe to use as an ordinary object property (no "__proto__" key).
const safeJsonValue = () => fc.jsonValue().filter((v) => {
	if (v === null || typeof v !== "object" || Array.isArray(v)) {
		return true;
	}
	return !Object.getOwnPropertyNames(v).includes("__proto__");
});

const plainObject = () => fc.dictionary(fc.string({minLength: 1, maxLength: 8}), fc.jsonValue(), {maxKeys: 6});

// Run `fn` with a clean Object.prototype and report any key it polluted.
function withCleanPrototype (fn) {
	const before = Object.getOwnPropertyNames(Object.prototype);
	try {
		return fn();
	} finally {
		for (const key of Object.getOwnPropertyNames(Object.prototype)) {
			if (!before.includes(key)) {
				delete Object.prototype[key];
			}
		}
	}
}

describe("utils.merge_objects / utils.combine_objects", () => {
	describe("C1: nested null values must not raise an opaque TypeError", () => {
		it.failing("combine_objects({a:{b:1}}, {a:null}) throws TypeError", () => {
			expect(() => utils.combine_objects({a: {b: 1}}, {a: null})).not.toThrow(TypeError);
		});

		it.failing("merge_objects array_merge_new_array({a:{b:1}}, {a:null}) throws TypeError", () => {
			expect(() => utils.merge_objects.main({"combineMethod": AMNA})({a: {b: 1}}, {a: null})).not.toThrow(TypeError);
		});

		it("characterization: combine_objects({a:{b:1}}, {a:null}) throws 'Cannot convert undefined or null to object'", () => {
			expect(() => utils.combine_objects({a: {b: 1}}, {a: null})).toThrow("Cannot convert undefined or null to object");
		});

		it("characterization: merge_objects array_merge_new_array({a:{b:1}}, {a:null}) throws 'Cannot convert undefined or null to object'", () => {
			expect(() => utils.merge_objects.main({"combineMethod": AMNA})({a: {b: 1}}, {a: null})).toThrow("Cannot convert undefined or null to object");
		});

		it.failing("combine_objects({a:[]}, {a:null}) throws the 'mix value types' error instead of merging", () => {
			expect(() => utils.combine_objects({a: []}, {a: null})).not.toThrow("You can't mix value types for the combine_objects method.");
		});

		it("characterization: combine_objects({a:[]}, {a:null}) throws 'You can't mix value types'", () => {
			expect(() => utils.combine_objects({a: []}, {a: null})).toThrow("You can't mix value types for the combine_objects method.");
		});

		it.failing("PBT: combine_objects never raises an opaque TypeError for a null nested value", () => {
			runProperty(
				fc.property(safeKey, (key) => {
					const first = {[key]: {inner: 1}};
					const second = {[key]: null};
					let threw = null;
					try {
						utils.combine_objects(first, second);
					} catch (e) {
						threw = e;
					}
					if (threw && threw.constructor === TypeError) {
						throw new Error(`combine_objects threw TypeError for key ${JSON.stringify(key)}: ${threw.message}`);
					}
				}),
				{"numRuns": 200, "label": "combine_objects null-nested no TypeError"}
			);
		});

		it.failing("PBT: merge_objects array_merge_new_array never raises an opaque TypeError for a null nested value", () => {
			runProperty(
				fc.property(safeKey, (key) => {
					const first = {[key]: {inner: 1}};
					const second = {[key]: null};
					let threw = null;
					try {
						utils.merge_objects.main({"combineMethod": AMNA})(first, second);
					} catch (e) {
						threw = e;
					}
					if (threw && threw.constructor === TypeError) {
						throw new Error(`merge_objects threw TypeError for key ${JSON.stringify(key)}: ${threw.message}`);
					}
				}),
				{"numRuns": 200, "label": "merge_objects null-nested no TypeError"}
			);
		});
	});

	describe("C2: no prototype pollution", () => {
		it.failing("PBT: combine_objects must not add properties to Object.prototype", () => {
			runProperty(
				fc.property(fc.string({maxLength: 5}).filter((k) => k !== "__proto__"), (prop) => {
					const polluted = withCleanPrototype(() => {
						// JSON.parse creates an OWN enumerable "__proto__" key, unlike an object literal.
						const hostile = JSON.parse(`{"__proto__": {"${prop.replace(/[^a-zA-Z0-9_$]/gu, "")}": "polluted"}}`);
						utils.combine_objects({}, hostile);
						return Object.prototype[prop];
					});
					expect(polluted).toBeUndefined();
				}),
				{"numRuns": 100, "label": "combine_objects no prototype pollution"}
			);
		});

		it.failing("PBT: merge_objects array_merge_new_array must not add properties to Object.prototype", () => {
			runProperty(
				fc.property(fc.string({maxLength: 5}).filter((k) => k !== "__proto__"), (prop) => {
					const polluted = withCleanPrototype(() => {
						const hostile = JSON.parse(`{"__proto__": {"${prop.replace(/[^a-zA-Z0-9_$]/gu, "")}": "polluted"}}`);
						utils.merge_objects.main({"combineMethod": AMNA})({}, hostile);
						return Object.prototype[prop];
					});
					expect(polluted).toBeUndefined();
				}),
				{"numRuns": 100, "label": "merge_objects no prototype pollution"}
			);
		});

		it("characterization: combine_objects({}, JSON.parse('{\"__proto__\":{\"polluted\":1}}')) pollutes Object.prototype", () => {
			withCleanPrototype(() => {
				utils.combine_objects({}, JSON.parse('{"__proto__":{"polluted":1}}'));
				expect(Object.prototype.polluted).toBe(1);
			});
		});
	});

	describe("C3: arguments are not mutated", () => {
		it.failing("merge_objects mutates its first argument", () => {
			const first = {x: 1};
			utils.merge_objects(first, {x: 2, y: 3});
			expect(first).toEqual({x: 1});
		});

		it.failing("combine_objects mutates its first argument", () => {
			const first = {x: 1};
			utils.combine_objects(first, {y: 2});
			expect(first).toEqual({x: 1});
		});

		it.failing("PBT: merge_objects leaves its input objects untouched", () => {
			runProperty(
				fc.property(plainObject(), plainObject(), (a, b) => {
					const before = JSON.stringify([a, b]);
					utils.merge_objects(a, b);
					expect(JSON.stringify([a, b])).toEqual(before);
				}),
				{"numRuns": 300, "label": "merge_objects no input mutation"}
			);
		});

		it.failing("PBT: combine_objects leaves its input objects untouched", () => {
			runProperty(
				fc.property(plainObject(), plainObject(), (a, b) => {
					const before = JSON.stringify([a, b]);
					utils.combine_objects(a, b);
					expect(JSON.stringify([a, b])).toEqual(before);
				}),
				{"numRuns": 300, "label": "combine_objects no input mutation"}
			);
		});
	});

	describe("C4: array_merge_new_array result shape must not depend on truthiness", () => {
		it.failing("array_merge_new_array({b:0},{b:3}) yields a number while ({b:1},{b:3}) yields an array", () => {
			const withZero = utils.merge_objects.main({"combineMethod": AMNA})({b: 0}, {b: 3});
			const withOne = utils.merge_objects.main({"combineMethod": AMNA})({b: 1}, {b: 3});
			expect(Array.isArray(withZero.b)).toBe(true);
			expect(Array.isArray(withOne.b)).toBe(true);
		});

		it("characterization: array_merge_new_array({b:0},{b:3}) === {b:3} (value lost, not wrapped)", () => {
			expect(utils.merge_objects.main({"combineMethod": AMNA})({b: 0}, {b: 3})).toEqual({b: 3});
		});

		it("characterization: array_merge_new_array({b:1},{b:3}) === {b:[1,3]}", () => {
			expect(utils.merge_objects.main({"combineMethod": AMNA})({b: 1}, {b: 3})).toEqual({b: [1, 3]});
		});

		it.failing("PBT: array_merge_new_array always returns an array for scalar operands", () => {
			runProperty(
				fc.property(safeJsonValue(), safeJsonValue(), (x, y) => {
					const result = utils.merge_objects.main({"combineMethod": AMNA})({b: x}, {b: y});
					expect(Array.isArray(result.b)).toBe(true);
				}),
				{"numRuns": 300, "label": "merge_objects array_merge_new_array shape"}
			);
		});

		it.failing("PBT: array_merge_new_array keeps the first operand even when it is falsy", () => {
			runProperty(
				fc.property(fc.oneof(fc.constant(0), fc.constant(""), fc.constant(false), fc.constant(null)), safeJsonValue(), (falsy, y) => {
					const result = utils.merge_objects.main({"combineMethod": AMNA})({b: falsy}, {b: y});
					expect(result.b).toEqual([falsy, y]);
				}),
				{"numRuns": 200, "label": "merge_objects array_merge_new_array keeps falsy first operand"}
			);
		});
	});

	describe("C5: the numeric-add branch must not be applied to a non-number second operand", () => {
		it("characterization: merge_objects adds numbers ({b:1},{b:3}) === {b:4}", () => {
			expect(utils.merge_objects({b: 1}, {b: 3})).toEqual({b: 4});
		});

		it("characterization: merge_objects overwrites strings ({b:'a'},{b:'x'}) === {b:'x'}", () => {
			expect(utils.merge_objects({b: "a"}, {b: "x"})).toEqual({b: "x"});
		});

		it("characterization: merge_objects({b:1},{b:'x'}) === {b:'1x'} (number + string is concatenated)", () => {
			expect(utils.merge_objects({b: 1}, {b: "x"})).toEqual({b: "1x"});
		});

		it("characterization: merge_objects({b:0},{b:'x'}) === {b:'x'} (0 is falsy -> overwrite branch)", () => {
			expect(utils.merge_objects({b: 0}, {b: "x"})).toEqual({b: "x"});
		});

		it("characterization: merge_objects({b:1},{b:{x:1}}) === {b:'1[object Object]'}", () => {
			expect(utils.merge_objects({b: 1}, {b: {x: 1}})).toEqual({b: "1[object Object]"});
		});

		it.failing("PBT: a non-number second operand must overwrite, not be summed into the number", () => {
			runProperty(
				fc.property(fc.integer({min: -1000, max: 1000}), safeJsonValue().filter((v) => typeof v !== "number"), (x, y) => {
					const result = utils.merge_objects({b: x}, {b: y});
					expect(result.b).toEqual(y);
				}),
				{"numRuns": 200, "label": "merge_objects non-number operand overwrites"}
			);
		});

		it.failing("PBT: the merge result must not depend on the truthiness of the first operand", () => {
			runProperty(
				fc.property(safeJsonValue().filter((v) => typeof v !== "number"), (y) => {
					const withZero = utils.merge_objects({b: 0}, {b: y});
					const withOne = utils.merge_objects({b: 1}, {b: y});
					expect(typeof withZero.b).toBe(typeof withOne.b);
				}),
				{"numRuns": 200, "label": "merge_objects result independent of first-operand truthiness"}
			);
		});
	});

	describe("Properties that hold", () => {
		// combine_objects.js:37-39 shows that OBJECT values are deep-merged, not
		// first-wins. First-wins is only guaranteed for scalar values.
		it("combine_objects keeps the FIRST value for a conflicting scalar key", () => {
			runProperty(
				fc.property(
					safeJsonValue().filter((v) => typeof v !== "object"),
					safeJsonValue().filter((v) => typeof v !== "object"),
					(x, y) => {
						const result = utils.combine_objects({a: x}, {a: y});
						expect(result.a).toEqual(x);
					}
				),
				{"numRuns": 300, "label": "combine_objects first-wins (scalars)"}
			);
		});

		it("combine_objects deep-merges conflicting object keys (first wins per leaf)", () => {
			runProperty(
				fc.property(
					safeKey,
					safeJsonValue().filter((v) => typeof v !== "object"),
					safeJsonValue().filter((v) => typeof v !== "object"),
					(key, x, y) => {
						const result = utils.combine_objects({[key]: {a: x}}, {[key]: {b: y}});
						expect(result[key]).toEqual({a: x, b: y});
					}
				),
				{"numRuns": 200, "label": "combine_objects deep merge"}
			);
		});

		it("combine_objects concatenates array-valued keys", () => {
			runProperty(
				fc.property(fc.array(safeJsonValue(), {maxLength: 3}), fc.array(safeJsonValue(), {maxLength: 3}), (x, y) => {
					const result = utils.combine_objects({a: x}, {a: y});
					expect(result.a).toEqual([...x, ...y]);
				}),
				{"numRuns": 200, "label": "combine_objects array concat"}
			);
		});

		it("combine_objects is idempotent", () => {
			runProperty(
				fc.property(plainObject(), (a) => {
					const once = utils.combine_objects(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(a)));
					const twice = utils.combine_objects(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(a)));
					expect(once).toEqual(twice);
				}),
				{"numRuns": 200, "label": "combine_objects idempotent"}
			);
		});

		it("PBT: merge_objects adds two numbers", () => {
			runProperty(
				fc.property(fc.integer({min: -1000, max: 1000}), fc.integer({min: -1000, max: 1000}), (x, y) => {
					const result = utils.merge_objects({b: x}, {b: y});
					expect(result.b).toEqual(x + y);
				}),
				{"numRuns": 300, "label": "merge_objects numeric addition"}
			);
		});

		it("merge_objects is associative for numeric keys under the default combine method", () => {
			runProperty(
				fc.property(fc.integer(), fc.integer(), fc.integer(), (x, y, z) => {
					const left = utils.merge_objects(utils.merge_objects({b: x}, {b: y}), {b: z});
					const right = utils.merge_objects({b: x}, utils.merge_objects({b: y}, {b: z}));
					expect(left).toEqual(right);
				}),
				{"numRuns": 200, "label": "merge_objects associative (numbers)"}
			);
		});

		it("merge_objects concatenates arrays from both sides", () => {
			runProperty(
				fc.property(fc.array(safeJsonValue(), {maxLength: 3}), fc.array(safeJsonValue(), {maxLength: 3}), (a, b) => {
					const result = utils.merge_objects({a}, {a: b});
					expect(result.a).toEqual([...a, ...b]);
				}),
				{"numRuns": 200, "label": "merge_objects array concat"}
			);
		});

		it("merge_objects object_combine shallow-merges nested objects", () => {
			runProperty(
				fc.property(safeKey, safeJsonValue(), (key, value) => {
					const result = utils.merge_objects.main({"combineMethod": OBJ})({[key]: {a: 1}}, {[key]: {b: value}});
					expect(result[key]).toEqual({a: 1, b: value});
				}),
				{"numRuns": 200, "label": "merge_objects object_combine"}
			);
		});

		it("both functions throw the documented errors for bad input", () => {
			expect(() => utils.merge_objects(1)).toThrow("You can only pass objects into merge_objects method.");
			expect(() => utils.merge_objects([1, 2], {"a": "b"})).toThrow("You can't mix value types for the merge_objects method.");
			expect(() => utils.combine_objects(1)).toThrow("You can only pass objects into combine_objects method.");
			expect(() => utils.combine_objects([1, 2], {"a": "b"})).toThrow("You can't mix value types for the combine_objects method.");
		});
	});
});
