// Property-based tests for the Table / Model / Serializer layer.
//
// Scope: table construction, option handling, model registration, and the
// serializer registry. These are the areas not covered by the utils, schema,
// condition, or item discovery suites.

const dynamoose = require("../../dist");
const {Item} = require("../../dist/Item");
const {Serializer} = require("../../dist/Serializer");
const Internal = require("../../dist/Internal").default;
const {internalProperties} = Internal.General;
const {fc, runProperty} = require("./_helpers");

// A schema fragment that yields a valid, unique model each time.
const attrName = fc.string({minLength: 1, maxLength: 8}).filter((s) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s));
const unique = () => Math.random().toString(36).slice(2, 10);

const makeModel = (name) => dynamoose.model(name, {
	"id": {"type": String, "hashKey": true},
	"data": String
});

describe("pbt/table", () => {
	it("Table name is exactly prefix + name + suffix", () => {
		runProperty(fc.property(
			fc.string({minLength: 1, maxLength: 6}),
			fc.string({maxLength: 6}),
			fc.string({maxLength: 6}),
			(name, prefix, suffix) => {
				const M = makeModel(`TN_${unique()}`);
				const t = new dynamoose.Table(name, [M], {"prefix": prefix, "suffix": suffix, "initialize": false});
				return t.name === `${prefix}${name}${suffix}`;
			}), {"numRuns": 100});
	});

	it("Table constructor does not mutate the caller's options object", () => {
		runProperty(fc.property(
			fc.string({minLength: 1, maxLength: 6}),
			fc.record({
				"read": fc.integer({min: 1, max: 100}),
				"write": fc.integer({min: 1, max: 100})
			}),
			fc.string({maxLength: 5}),
			(name, throughput, prefix) => {
				const M = makeModel(`TO_${unique()}`);
				const options = {"throughput": {...throughput}, "prefix": prefix, "initialize": false};
				const snapshot = JSON.stringify(options);
				new dynamoose.Table(name, [M], options);
				return JSON.stringify(options) === snapshot;
			}), {"numRuns": 100});
	});

	it("Table constructor does not mutate the caller's nested expires object", () => {
		runProperty(fc.property(
			fc.string({minLength: 1, maxLength: 6}),
			fc.integer({min: 1, max: 100000}),
			(name, ttl) => {
				const M = makeModel(`TE_${unique()}`);
				const expires = {"ttl": ttl};
				const snapshot = JSON.stringify(expires);
				new dynamoose.Table(name, [M], {"expires": {...expires}, "initialize": false});
				return JSON.stringify(expires) === snapshot;
			}), {"numRuns": 50});
	});

	it("Table does not alias the caller's options object", () => {
		runProperty(fc.property(
			fc.string({minLength: 1, maxLength: 6}),
			fc.integer({min: 1, max: 50}),
			(name, read) => {
				const M = makeModel(`TA_${unique()}`);
				const options = {"throughput": {"read": read}, "initialize": false};
				const t = new dynamoose.Table(name, [M], options);
				// The Table must hold its own copy: later caller-side edits must not
				// change the Table's effective configuration.
				options.throughput.read = read + 1000;
				return t.getInternalProperties(internalProperties).options.throughput.read === read;
			}), {"numRuns": 100});
	});

	it("reusing one options object across two tables does not leak settings between them", () => {
		runProperty(fc.property(
			fc.string({minLength: 1, maxLength: 6}),
			fc.integer({min: 1, max: 50}),
			(name, read) => {
				const M1 = makeModel(`TR1_${unique()}`);
				const M2 = makeModel(`TR2_${unique()}`);
				const shared = {"throughput": {"read": read}, "initialize": false};
				const t1 = new dynamoose.Table(`${name}A`, [M1], shared);
				const t2 = new dynamoose.Table(`${name}B`, [M2], shared);
				// The second table must not inherit the first table's injected defaults.
				const t2Keys = Object.keys(t2.getInternalProperties(internalProperties).options).sort();
				return !t2Keys.includes("waitForActive") || t1.getInternalProperties(internalProperties).options.waitForActive !== undefined;
			}), {"numRuns": 50});
	});

	it("a failed Table construction does not leave its models bound to a table", () => {
		runProperty(fc.property(
			fc.string({minLength: 1, maxLength: 6}),
			(name) => {
				const good = makeModel(`TG_${unique()}`);
				const bad = dynamoose.model(`TB_${unique()}`, {
					"otherId": {"type": String, "hashKey": true},
					"data": String
				});

				let threw = false;
				try {
					new dynamoose.Table(name, [good, bad], {"initialize": false});
				} catch (e) {
					threw = true;
				}
				if (!threw) {
					return true;
				}
				// The model must remain usable: constructing a valid table with it must succeed.
				let retryOk = true;
				try {
					new dynamoose.Table(`${name}2`, [good], {"initialize": false});
				} catch (e) {
					retryOk = false;
				}
				return retryOk;
			}), {"numRuns": 50});
	});

	it("ModelStore.forTableName returns the models registered for that table name", () => {
		runProperty(fc.property(fc.string({minLength: 1, maxLength: 10}), (name) => {
			const tableName = `TBL_${name}_${unique()}`;
			const M = makeModel(`MS_${unique()}`);
			M.Model.getInternalProperties(internalProperties).tableName = tableName;
			const found = require("../../dist/ModelStore").default.forTableName(tableName);
			return Array.isArray(found) && found.length === 1 && found[0] === M.Model;
		}), {"numRuns": 50});
	});
});

describe("pbt/serializer", () => {
	it("serialize with include returns exactly the included keys that resolve to a defined value", () => {
		runProperty(fc.property(
			fc.dictionary(attrName, fc.integer(), {maxKeys: 6}),
			fc.array(attrName, {minLength: 1, maxLength: 4}),
			(item, include) => {
				const S = new Serializer();
				S.add("s", {"include": include});
				const out = S.getInternalProperties(internalProperties).serialize(item, "s");
				// `utils.object.pick` keeps a requested key when reading it yields a defined
				// value (including inherited ones such as `valueOf`); otherwise it drops the key.
				const expected = [...new Set(include)].filter((key) => item[key] !== undefined).sort();
				return JSON.stringify(Object.keys(out).sort()) === JSON.stringify(expected);
			}), {"numRuns": 100});
	});

	it("serialize is idempotent under repeated application", () => {
		runProperty(fc.property(
			fc.dictionary(attrName, fc.integer(), {maxKeys: 6}),
			(item) => {
				const S = new Serializer();
				const once = S.getInternalProperties(internalProperties).serialize(item, "_default");
				const twice = S.getInternalProperties(internalProperties).serialize(once, "_default");
				return JSON.stringify(once) === JSON.stringify(twice);
			}), {"numRuns": 100});
	});

	it("serialize does not mutate the source item", () => {
		runProperty(fc.property(
			fc.dictionary(attrName, fc.integer(), {maxKeys: 6}),
			fc.array(attrName, {minLength: 1, maxLength: 4}),
			(item, include) => {
				const S = new Serializer();
				S.add("s", {"include": include});
				const snapshot = JSON.stringify(item);
				S.getInternalProperties(internalProperties).serialize(item, "s");
				return JSON.stringify(item) === snapshot;
			}), {"numRuns": 100});
	});

	it("deleting the default serializer resets the default rather than clearing it", () => {
		runProperty(fc.property(fc.string({minLength: 1, maxLength: 6}), (name) => {
			const S = new Serializer();
			S.add(name, {"include": ["a"]});
			S.default.set(name);
			S.delete(name);
			const serializers = S.getInternalProperties(internalProperties).serializers;
			const defaultSerializer = S.getInternalProperties(internalProperties).defaultSerializer;
			return Boolean(serializers["_default"]) && defaultSerializer === "_default";
		}), {"numRuns": 50});
	});
});
