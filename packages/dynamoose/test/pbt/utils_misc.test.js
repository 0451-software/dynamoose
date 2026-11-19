// PBT discovery: the remaining pure utilities in packages/dynamoose/lib/utils/
//
//   keyBy, unique_array_elements, array_flatten, all_elements_match,
//   capitalize_first_letter, childKey, parentKey, timeout, async_reduce,
//   type_name, and utils.dynamoose.wildcard_allowed_check.
//
// `it.failing` blocks are expected-to-fail characterization tests: they pin the CURRENT
// (buggy) behaviour and will start failing the suite once the bug is fixed.

const {fc, runProperty} = require("./_helpers");
const utils = require("../../dist/utils").default;

const jsonValue = () => fc.jsonValue().filter((v) => {
	if (v === null || typeof v !== "object" || Array.isArray(v)) {
		return true;
	}
	return !Object.getOwnPropertyNames(v).includes("__proto__");
});

const plainObject = () => fc.dictionary(fc.string({minLength: 1, maxLength: 8}), fc.jsonValue(), {maxKeys: 6});

describe("utils.keyBy", () => {
	it("characterization: keyBy loses an entry whose key is '__proto__'", () => {
		const result = utils.keyBy([{id: "__proto__"}], "id");
		expect(Object.keys(result)).toEqual([]);
	});

	it("PBT: keyBy maps every item to its key value", () => {
		runProperty(
			fc.property(fc.string({minLength: 1, maxLength: 8}).filter((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype"), fc.jsonValue(), (id, extra) => {
				const result = utils.keyBy([{id, extra}], "id");
				expect(result[id]).toEqual({id, extra});
			}),
			{"numRuns": 200, "label": "keyBy maps item to key"}
		);
	});

	it("PBT: keyBy returns an empty object for an empty array", () => {
		runProperty(
			fc.property(fc.constant(null), () => {
				expect(utils.keyBy([], "id")).toEqual({});
			}),
			{"numRuns": 50, "label": "keyBy empty array"}
		);
	});

	it("keyBy returns {} for a nullish array (documented in keyBy.js:10-12)", () => {
		expect(utils.keyBy(null, "id")).toEqual({});
		expect(utils.keyBy(undefined, "id")).toEqual({});
	});

	it("PBT: keyBy with no key uses the item itself as the key", () => {
		runProperty(
			fc.property(fc.string({minLength: 1, maxLength: 6}), (s) => {
				expect(utils.keyBy([s])).toEqual({[s]: s});
			}),
			{"numRuns": 200, "label": "keyBy without key"}
		);
	});
});

describe("utils.unique_array_elements", () => {
	it("characterization: unique_array_elements([NaN]) === [] (NaN is dropped entirely)", () => {
		expect(utils.unique_array_elements([NaN])).toEqual([]);
	});

	it("characterization: unique_array_elements([1,NaN,1]) === [1] (the NaN is dropped)", () => {
		expect(utils.unique_array_elements([1, NaN, 1])).toEqual([1]);
	});

	it("characterization: unique_array_elements([null]) throws TypeError", () => {
		expect(() => utils.unique_array_elements([null])).toThrow(TypeError);
	});

	it.failing("PBT: unique_array_elements keeps a NaN element (it is not a duplicate of anything)", () => {
		runProperty(
			fc.property(fc.constant(NaN), (nan) => {
				const result = utils.unique_array_elements([nan]);
				expect(result.length).toBe(1);
			}),
			{"numRuns": 50, "label": "unique_array_elements keeps NaN"}
		);
	});

	it.failing("PBT: unique_array_elements does not throw on a null element", () => {
		runProperty(
			fc.property(fc.constant(null), (n) => {
				expect(() => utils.unique_array_elements([n])).not.toThrow();
			}),
			{"numRuns": 50, "label": "unique_array_elements null element"}
		);
	});

	it("PBT: unique_array_elements removes duplicates but keeps the distinct values", () => {
		runProperty(
			fc.property(fc.array(fc.integer({min: -100, max: 100}), {maxLength: 8}), (values) => {
				const result = utils.unique_array_elements(values);
				expect(result.length).toBe(new Set(values).size);
				// order of first occurrence is preserved
				expect(result).toEqual([...new Set(values)]);
			}),
			{"numRuns": 300, "label": "unique_array_elements integers"}
		);
	});
});

describe("utils.array_flatten", () => {
	// array_flatten is `Array.prototype.concat.apply([], array)`: each nested array is
	// spread one level, exactly like Array.prototype.flat(). Verified against flat().
	it("PBT: array_flatten matches Array.prototype.flat()", () => {
		runProperty(
			fc.property(fc.array(fc.array(jsonValue(), {maxLength: 3}), {maxLength: 4}), (nested) => {
				expect(utils.array_flatten(nested)).toEqual(nested.flat());
			}),
			{"numRuns": 300, "label": "array_flatten matches flat()"}
		);
	});

	it("PBT: array_flatten of an empty array is empty", () => {
		runProperty(
			fc.property(fc.constant(null), () => {
				expect(utils.array_flatten([])).toEqual([]);
			}),
			{"numRuns": 50, "label": "array_flatten empty"}
		);
	});

	it("array_flatten of a flat array returns the same elements", () => {
		expect(utils.array_flatten([1, 2, 3])).toEqual([1, 2, 3]);
	});
});

describe("utils.all_elements_match", () => {
	it("PBT: all_elements_match is true iff every element equals the first", () => {
		runProperty(
			fc.property(fc.array(fc.integer({min: -10, max: 10}), {maxLength: 6}), (values) => {
				const expected = values.every((v) => v === values[0]);
				expect(utils.all_elements_match(values)).toBe(expected);
			}),
			{"numRuns": 300, "label": "all_elements_match integers"}
		);
	});

	it("all_elements_match of an empty array is true (documented in all_elements_match.js:10-12)", () => {
		expect(utils.all_elements_match([])).toBe(true);
	});

	it("PBT: all_elements_match of a constant array is true", () => {
		runProperty(
			fc.property(fc.integer(), fc.integer({min: 0, max: 6}), (v, n) => {
				expect(utils.all_elements_match(new Array(n).fill(v))).toBe(true);
			}),
			{"numRuns": 200, "label": "all_elements_match constant array"}
		);
	});
});

describe("utils.capitalize_first_letter", () => {
	it("characterization: capitalize_first_letter('') throws TypeError", () => {
		expect(() => utils.capitalize_first_letter("")).toThrow(TypeError);
	});

	it.failing("PBT: capitalize_first_letter never throws for any string", () => {
		runProperty(
			fc.property(fc.string(), (s) => {
				expect(() => utils.capitalize_first_letter(s)).not.toThrow();
			}),
			{"numRuns": 300, "label": "capitalize_first_letter never throws"}
		);
	});

	it("PBT: capitalize_first_letter upper-cases only the first character", () => {
		runProperty(
			fc.property(fc.string({minLength: 1}).filter((s) => s[0] === s[0].toUpperCase() && s[0] === s[0].toLowerCase()), (s) => {
				const result = utils.capitalize_first_letter(s);
				expect(result).toBe(s[0].toUpperCase() + s.slice(1));
			}),
			{"numRuns": 300, "label": "capitalize_first_letter first char only"}
		);
	});
});

describe("utils.childKey / utils.parentKey", () => {
	it("PBT: childKey returns the last dot-separated segment", () => {
		runProperty(
			fc.property(fc.array(fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes(".")), {minLength: 1, maxLength: 4}), (parts) => {
				const key = parts.join(".");
				expect(utils.childKey(key)).toBe(parts[parts.length - 1]);
			}),
			{"numRuns": 300, "label": "childKey last segment"}
		);
	});

	it("PBT: parentKey returns everything before the last dot", () => {
		runProperty(
			fc.property(fc.array(fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes(".")), {minLength: 2, maxLength: 4}), (parts) => {
				const key = parts.join(".");
				expect(utils.parentKey(key)).toBe(parts.slice(0, -1).join("."));
			}),
			{"numRuns": 300, "label": "parentKey all but last segment"}
		);
	});

	it("PBT: parentKey(childKey(key)) is a prefix of key (when there is a dot)", () => {
		runProperty(
			fc.property(fc.array(fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes(".")), {minLength: 2, maxLength: 4}), (parts) => {
				const key = parts.join(".");
				expect(key.startsWith(utils.parentKey(key))).toBe(true);
			}),
			{"numRuns": 300, "label": "parentKey prefix"}
		);
	});
});

describe("utils.type_name", () => {
	it("characterization: type_name({constructor: null}) throws TypeError", () => {
		expect(() => utils.type_name({constructor: null}, [])).toThrow(TypeError);
	});

	it.failing("PBT: type_name never throws for any value", () => {
		runProperty(
			fc.property(fc.oneof(
				jsonValue(),
				// Objects whose own "constructor" property shadows Object.prototype.constructor.
				fc.constant({"constructor": null}),
				fc.constant({"constructor": "x"}),
				fc.constant({"constructor": 5}),
				fc.constant({"constructor": undefined})
			), (value) => {
				expect(() => utils.type_name(value, [])).not.toThrow();
			}),
			{"numRuns": 300, "label": "type_name never throws"}
		);
	});

	it("PBT: type_name returns a string for ordinary values", () => {
		runProperty(
			fc.property(jsonValue(), (value) => {
				expect(typeof utils.type_name(value, [])).toBe("string");
			}),
			{"numRuns": 300, "label": "type_name returns a string"}
		);
	});
});

describe("utils.timeout", () => {
	it("PBT: timeout resolves for a valid duration", async () => {
		const start = Date.now();
		await utils.timeout(5);
		expect(Date.now() - start).toBeGreaterThanOrEqual(4);
	});

	it("PBT: timeout rejects for a non-numeric duration", async () => {
		const results = await Promise.allSettled([utils.timeout("abc"), utils.timeout("def")]);
		expect(results.every((r) => r.status === "rejected")).toBe(true);
	});

	it("timeout rejects with the documented message (timeout.js:20-22)", async () => {
		await expect(utils.timeout("test")).rejects.toEqual("Invalid milliseconds passed in: test");
	});
});

describe("utils.async_reduce", () => {
	it("PBT: async_reduce sums an array", async () => {
		const values = fc.sample(fc.array(fc.integer({min: -100, max: 100}), {minLength: 1, maxLength: 8}), 1)[0];
		const result = await utils.async_reduce(values, (acc, v) => acc + v, 0);
		expect(result).toBe(values.reduce((a, b) => a + b, 0));
	});

	it("PBT: async_reduce with an async callback sums an array", async () => {
		const values = fc.sample(fc.array(fc.integer({min: -100, max: 100}), {minLength: 1, maxLength: 8}), 1)[0];
		const result = await utils.async_reduce(values, async (acc, v) => acc + v, 0);
		expect(result).toBe(values.reduce((a, b) => a + b, 0));
	});

	it("async_reduce over an empty array returns the initial value", async () => {
		expect(await utils.async_reduce([], (acc, v) => acc + v, 42)).toBe(42);
	});

	it("PBT: async_reduce visits the elements in order", async () => {
		const values = fc.sample(fc.array(fc.integer(), {minLength: 1, maxLength: 8}), 1)[0];
		const seen = [];
		await utils.async_reduce(values, (acc, v) => { seen.push(v); return acc; }, 0);
		expect(seen).toEqual(values);
	});
});

describe("utils.dynamoose.wildcard_allowed_check", () => {
	const wac = utils.dynamoose.wildcard_allowed_check;

	it("PBT: a literal pattern matches exactly its own key", () => {
		runProperty(
			fc.property(fc.array(fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes(".")), {minLength: 1, maxLength: 3}), (parts) => {
				const key = parts.join(".");
				expect(wac([key], key)).toBe(true);
			}),
			{"numRuns": 300, "label": "wildcard literal exact match"}
		);
	});

	// The documented semantics (wildcard_allowed_check.js:37-40) are PREFIX matching:
	// a pattern matches any key that starts with it, so ["random.test"] matches "random".
	// A literal pattern therefore only fails to match when the key diverges from the
	// pattern in its FIRST segment.
	it("PBT: a literal pattern does not match a key that diverges in its first segment", () => {
		runProperty(
			fc.property(
				fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes(".") && s !== "*"),
				fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes(".") && s !== "*"),
				(seg, other) => {
					if (seg !== other) {
						expect(wac([`${seg}.tail`], `${other}.tail`)).toBe(false);
					}
				}
			),
			{"numRuns": 300, "label": "wildcard literal no false match"}
		);
	});

	it("PBT: the boolean form returns the boolean unchanged", () => {
		runProperty(
			fc.property(fc.boolean(), fc.string(), (flag, key) => {
				expect(wac(flag, key)).toBe(flag);
			}),
			{"numRuns": 200, "label": "wildcard boolean passthrough"}
		);
	});

	it("PBT: '*' matches exactly one path segment", () => {
		runProperty(
			fc.property(fc.string({minLength: 1, maxLength: 4}).filter((s) => !s.includes(".") && s !== "*"), (seg) => {
				expect(wac([`*.${seg}`], `x.${seg}`)).toBe(true);
				expect(wac([`*.${seg}`], `x.y.${seg}`)).toBe(false);
			}),
			{"numRuns": 300, "label": "wildcard single star"}
		);
	});

	it("characterization: wildcard_allowed_check(['random.**.hello'], 'random.test.random') === true (trailing literal ignored)", () => {
		expect(wac(["random.**.hello"], "random.test.random")).toBe(true);
	});

	it("characterization: wildcard_allowed_check(['random.*.hello'], 'random') === true (shorter key matches)", () => {
		expect(wac(["random.*.hello"], "random")).toBe(true);
	});

	it("PBT: wildcard_allowed_check is false for a non-matching literal pattern", () => {
		runProperty(
			fc.property(fc.string({minLength: 1, maxLength: 5}).filter((s) => !s.includes(".") && s !== "*"), (seg) => {
				expect(wac([`${seg}.other`], `x.${seg}.other`)).toBe(false);
			}),
			{"numRuns": 200, "label": "wildcard no false match 2"}
		);
	});
});
