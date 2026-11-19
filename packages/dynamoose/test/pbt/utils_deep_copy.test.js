// PBT discovery: utils.deep_copy
//
// Contract (lib/utils/deep_copy.ts): produce a DEEP copy — mutating the copy must never
// be observable through the original, and the copy must not share mutable state with the
// original. The existing tests (packages/dynamoose/test/utils/deep_copy.js) only check
// Map/Set contents for PRIMITIVE values, so the Map/Set branches are under-tested.
//
// `it.failing` blocks are expected-to-fail characterization tests: they pin the CURRENT
// (buggy) behaviour and will start failing the suite once the bug is fixed (remove the
// `.failing` then). The "characterization" tests assert the current behaviour directly.

const {fc, runProperty} = require("./_helpers");
const utils = require("../../dist/utils").default;

const jsonValue = () => fc.jsonValue().filter((v) => {
	if (v === null || typeof v !== "object" || Array.isArray(v)) {
		return true;
	}
	return !Object.getOwnPropertyNames(v).includes("__proto__");
});

// A mutable object value (so we can attach a marker to it).
const objectValue = () => fc.dictionary(fc.string({minLength: 1, maxLength: 6}), fc.jsonValue(), {maxKeys: 4}).filter((v) => !Object.getOwnPropertyNames(v).includes("__proto__"));

describe("utils.deep_copy", () => {
	describe("Map / Set contents must be deep-copied", () => {
		it.failing("deep_copy does not deep-copy values inside a Map", () => {
			const inner = {x: 1};
			const copy = utils.deep_copy(new Map([["k", inner]]));
			expect(copy.get("k")).not.toBe(inner);
		});

		it.failing("deep_copy does not deep-copy values inside a Set", () => {
			const inner = {x: 1};
			const copy = utils.deep_copy(new Set([inner]));
			expect(copy.has(inner)).toBe(false);
		});

		it("characterization: deep_copy(new Map([['k', inner]])).get('k') === inner (same reference)", () => {
			const inner = {x: 1};
			expect(utils.deep_copy(new Map([["k", inner]])).get("k")).toBe(inner);
		});

		it("characterization: deep_copy(new Set([inner])).has(inner) === true (same reference)", () => {
			const inner = {x: 1};
			expect(utils.deep_copy(new Set([inner])).has(inner)).toBe(true);
		});

		it.failing("PBT: mutating a copied Map value must not affect the original", () => {
			runProperty(
				fc.property(objectValue(), (value) => {
					const original = new Map([["k", value]]);
					const copy = utils.deep_copy(original);
					copy.get("k").mutated = true;
					expect(original.get("k").mutated).toBeUndefined();
				}),
				{"numRuns": 200, "label": "deep_copy Map values are independent"}
			);
		});

		it.failing("PBT: mutating a copied Set value must not affect the original", () => {
			runProperty(
				fc.property(objectValue(), (value) => {
					const original = new Set([value]);
					const copy = utils.deep_copy(original);
					[...copy][0].mutated = true;
					expect([...original][0].mutated).toBeUndefined();
				}),
				{"numRuns": 200, "label": "deep_copy Set values are independent"}
			);
		});
	});

	describe("no prototype hijacking", () => {
		it("characterization: deep_copy of an own '__proto__' key loses the key and sets the prototype", () => {
			const parsed = JSON.parse('{"__proto__": {"p": 1}, "safe": 2}');
			const copy = utils.deep_copy(parsed);
			expect(Object.keys(copy)).toEqual(["safe"]);
			expect(Object.getPrototypeOf(copy)).toEqual({"p": 1});
		});
	});

	describe("Properties that hold", () => {
		it("deep_copy of a plain object is structurally equal to the original", () => {
			runProperty(
				fc.property(jsonValue(), (value) => {
					expect(utils.deep_copy(value)).toEqual(value);
				}),
				{"numRuns": 300, "label": "deep_copy structural equality"}
			);
		});

		it("PBT: deep_copy of an object never returns the same reference", () => {
			runProperty(
				fc.property(objectValue(), fc.array(fc.jsonValue(), {maxLength: 3}), (value, arr) => {
					expect(utils.deep_copy(value)).not.toBe(value);
					expect(utils.deep_copy(arr)).not.toBe(arr);
				}),
				{"numRuns": 300, "label": "deep_copy identity"}
			);
		});

		it("deep_copy is idempotent", () => {
			runProperty(
				fc.property(jsonValue(), (value) => {
					expect(utils.deep_copy(utils.deep_copy(value))).toEqual(utils.deep_copy(value));
				}),
				{"numRuns": 300, "label": "deep_copy idempotent"}
			);
		});

		it("deep_copy preserves Date / Buffer / Uint8Array types and contents", () => {
			runProperty(
				fc.property(fc.integer({min: -1e12, max: 1e12}), (ms) => {
					const d = new Date(ms);
					const c = utils.deep_copy(d);
					expect(c).toBeInstanceOf(Date);
					expect(c.getTime()).toBe(d.getTime());

					const b = Buffer.from([1, 2, 3]);
					const cb = utils.deep_copy(b);
					expect(Buffer.isBuffer(cb)).toBe(true);
					expect([...cb]).toEqual([1, 2, 3]);

					const u = Uint8Array.from([4, 5]);
					const cu = utils.deep_copy(u);
					expect(cu).toBeInstanceOf(Uint8Array);
					expect([...cu]).toEqual([4, 5]);
				}),
				{"numRuns": 200, "label": "deep_copy typed values"}
			);
		});

		it("deep_copy handles circular references without throwing", () => {
			const a = {name: "a"};
			a.self = a;
			const b = {name: "b", parent: a};
			a.child = b;
			expect(() => utils.deep_copy(a)).not.toThrow();
			const copy = utils.deep_copy(a);
			expect(copy.name).toBe("a");
			expect(copy.self).toBeUndefined();
		});
	});
});
