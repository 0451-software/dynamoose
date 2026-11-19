// Consolidated, independent verification of each CONFIRMED finding.
//
// Every test in this file reproduces a bug that was independently observed by
// running the code (not by reading it). Where a finding was initially a
// hypothesis, the hypothesis was first checked against the code's own expressed
// intent (existing unit tests + JSDoc) and against the real public API.
//
// Each finding was then put through an ADVERSARIAL REVIEW that tried to refute
// it. Three candidate findings were refuted and removed (deep_copy of Map/Set
// contents, merge_objects mutating its first argument, find_best_index mutating
// its index objects) and the severity of several others was corrected. The
// surviving set is below.
//
// This file lives on the discovery branch. Confirmed bugs get a standalone
// deterministic regression test on their own fix branch.

const dynamoose = require("../../dist");
const utils = require("../../dist/utils").default;
const {Item} = require("../../dist/Item");
const Internal = require("../../dist/Internal").default;
const {internalProperties} = Internal.General;
const {fc, runProperty} = require("./_helpers");

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

describe("FINDING 1: combine_objects / merge_objects throw a raw TypeError instead of the documented error on a null nested value", () => {
	it("combine_objects throws TypeError instead of handling a null nested value", () => {
		expect(() => utils.combine_objects({"a": {"b": 1}}, {"a": null})).toThrow(TypeError);
	});

	it("merge_objects (array_merge_new_array) throws TypeError on a null nested value", () => {
		expect(() => utils.merge_objects.main({"combineMethod": "array_merge_new_array"})({"a": {"b": 1}}, {"a": null})).toThrow(TypeError);
	});

	it("root cause: the guard null-checks returnObject[key] but NOT arg[key]", () => {
		// `combine_objects` guards with
		//   `typeof returnObject[key] === "object" && typeof arg[key] === "object" && returnObject[key] !== null`
		// `arg[key]` is never null-checked, so a null in a LATER argument recurses with
		// `null` and `Object.keys(null)` throws "Cannot convert undefined or null to object".
		expect(typeof null).toBe("object");
		expect(() => Object.keys(null)).toThrow(TypeError);
		// The asymmetry: null in the FIRST argument is handled, null in a later one is not.
		expect(utils.combine_objects({"a": null}, {"a": {"b": 1}})).toEqual({"a": null});
	});
});


describe("FINDING 2: merge_objects result depends on the TRUTHINESS of the accumulated value", () => {
	it("under the DEFAULT combine method a falsy first value is numerically consistent", () => {
		// The `else if (returnObject[key])` branch IS truthiness-sensitive, so a 0
		// skips the numeric-addition path. Under the DEFAULT method this is NOT
		// observable, because 0 + 3 === 3 (overwriting with 3 gives the same number).
		expect(utils.merge_objects({"b": 0}, {"b": 3})).toEqual({"b": 3});
		expect(utils.merge_objects({"b": 1}, {"b": 3})).toEqual({"b": 4});
	});

	it("the OUTPUT SHAPE differs between a falsy and a truthy first value", () => {
		const falsy = utils.merge_objects.main({"combineMethod": "array_merge_new_array"})({"b": 0}, {"b": 3});
		const truthy = utils.merge_objects.main({"combineMethod": "array_merge_new_array"})({"b": 1}, {"b": 3});
		expect(falsy).toEqual({"b": 3});
		expect(truthy).toEqual({"b": [1, 3]});
		expect(Array.isArray(falsy.b)).toBe(Array.isArray(truthy.b));
	});

	it("property: the result shape must not depend on the truthiness of the first value", () => {
		runProperty(fc.property(
			fc.integer({min: 0, max: 1000}),
			fc.integer({min: 0, max: 1000}),
			(zero, other) => {
				const falsy = utils.merge_objects.main({"combineMethod": "array_merge_new_array"})({"b": zero}, {"b": other});
				const truthy = utils.merge_objects.main({"combineMethod": "array_merge_new_array"})({"b": zero + 1}, {"b": other});
				return Array.isArray(falsy.b) === Array.isArray(truthy.b);
			}), {"numRuns": 100});
	});
});


describe("FINDING 3: prototype pollution through combine_objects / merge_objects", () => {
	afterEach(() => {
		delete Object.prototype.__pbtPolluted__;
	});

	it("combine_objects writes through to Object.prototype", () => {
		const malicious = JSON.parse('{"__proto__": {"__pbtPolluted__": "PWNED"}}');
		utils.combine_objects({}, malicious);
		expect(Object.prototype.__pbtPolluted__).toBe("PWNED");
	});

	it("merge_objects (array_merge_new_array) writes through to Object.prototype", () => {
		const malicious = JSON.parse('{"__proto__": {"__pbtPolluted__": "PWNED"}}');
		utils.merge_objects.main({"combineMethod": "array_merge_new_array"})({}, malicious);
		expect(Object.prototype.__pbtPolluted__).toBe("PWNED");
	});

	it("reaches the public API through dynamoose.Table.defaults.set", () => {
		dynamoose.Table.defaults.set(JSON.parse('{"__proto__": {"__pbtPolluted__": "PWNED"}}'));
		const M = dynamoose.model("PolluteCat", {"id": {"type": String, "hashKey": true}});
		new dynamoose.Table("PolluteCat", [M], {"initialize": false});
		expect(Object.prototype.__pbtPolluted__).toBe("PWNED");
		dynamoose.Table.defaults.set({});
	});
});


describe("FINDING 4: Table constructor mutates and aliases the caller's options object", () => {
	it("mutates the caller's nested options object", () => {
		const M = dynamoose.model("MutateCat", {"id": {"type": String, "hashKey": true}});
		const options = {"throughput": {"read": 5}, "initialize": false};
		new dynamoose.Table("MutateCat", [M], options);
		expect(options.throughput).toEqual({"read": 5, "write": 1});
	});

	it("mutates the caller's top-level options object by injecting the defaults", () => {
		const M = dynamoose.model("MutateCat2", {"id": {"type": String, "hashKey": true}});
		const options = {"initialize": false};
		new dynamoose.Table("MutateCat2", [M], options);
		expect(options.create).toBe(true);
		expect(options.waitForActive).toBeDefined();
	});

	it("holds the caller's options object BY REFERENCE, so later caller edits change Table behaviour", () => {
		const M = dynamoose.model("AliasCat", {"id": {"type": String, "hashKey": true}});
		const options = {"throughput": {"read": 5}, "initialize": false};
		const table = new dynamoose.Table("AliasCat", [M], options);
		options.throughput.read = 999;
		expect(table.getInternalProperties(internalProperties).options.throughput.read).toBe(999);
	});
});


describe("FINDING 5: a failed Table construction permanently bricks its models", () => {
	it("models stay bound to the half-built table after the constructor throws", () => {
		// The "already assigned" guard itself is INTENTIONAL (test/Table.js:50-54).
		// The defect is the ORDERING: binding happens inside setInternalProperties
		// (Table/index.ts:190-201) BEFORE the hashKey validation (:289-294).
		const good = dynamoose.model("BrickCat1", {"id": {"type": String, "hashKey": true}});
		const bad = dynamoose.model("BrickCat2", {"otherId": {"type": String, "hashKey": true}});

		expect(() => new dynamoose.Table("BrickCat", [good, bad], {"initialize": false})).toThrow("hashKey's for all models must match.");

		// The model is now bound to a table that never finished being constructed,
		// so it can never be attached to a working table.
		expect(() => new dynamoose.Table("BrickCat2", [good], {"initialize": false})).toThrow("Model BrickCat1 has already been assigned to a table.");
	});
});


describe("FINDING 6: comparisonChart is keyed by array index for grouped conditions", () => {
	const Model = dynamoose.model("ChartCat", {
		"id": Number,
		"name": {"type": String, "index": {"type": "global"}},
		"age": Number
	});
	new dynamoose.Table("ChartCat", [Model], {"initialize": false});

	it("a grouped condition produces a chart entry keyed by the array index", async () => {
		const condition = new dynamoose.Condition("id").eq(1).parenthesis((c) => c.where("age").eq(2));
		const chart = await condition.getInternalProperties(internalProperties).comparisonChart(Model.Model);
		expect(Object.keys(chart)).toEqual(["id", "age"]);
		expect(chart["0"]).toBeUndefined();
	});

	it("root cause: a grouped entry is an ARRAY, so Object.entries(entry)[0][0] is the index", () => {
		const condition = new dynamoose.Condition("id").eq(1).parenthesis((c) => c.where("age").eq(2));
		const conditions = condition.getInternalProperties(internalProperties).settings.conditions;
		expect(Array.isArray(conditions[1])).toBe(true);
		expect(Object.entries(conditions[1])[0][0]).toBe("0");
	});
});


describe("FINDING 7: a hash-key condition inside a parenthesis group breaks the key condition", () => {
	const Model = dynamoose.model("GroupCat", {
		"id": Number,
		"name": {"type": String, "index": {"type": "global"}},
		"age": Number,
		"color": String
	});
	new dynamoose.Table("GroupCat", [Model], {"initialize": false});

	it("throws when the hash key lives inside a group and no other condition is present", async () => {
		const query = Model.query().parenthesis((c) => c.where("id").eq(1)).using("nameIndex");
		await expect(query.getRequest()).resolves.toBeDefined();
	});

	it("emits a KeyConditionExpression that references placeholders which do not exist", async () => {
		const query = Model.query().where("age").eq(1).parenthesis((c) => c.where("id").eq(999));
		["color", "name", "age", "color", "name", "age", "color", "name", "age"].forEach((a) => query.where(a).eq(1));
		const request = await query.using("someIndex").getRequest();

		const keyConditionExpression = request.KeyConditionExpression || "";
		const referencedNames = (keyConditionExpression.match(/#[A-Za-z0-9_]+/g) || []);
		const referencedValues = (keyConditionExpression.match(/:[A-Za-z0-9_]+/g) || []);
		expect(referencedNames.every((n) => n in request.ExpressionAttributeNames)).toBe(true);
		expect(referencedValues.every((v) => v in request.ExpressionAttributeValues)).toBe(true);
	});
});


describe("FINDING 8: ANY or() in a query crashes the request builder", () => {
	const Model = dynamoose.model("OrCat", {
		"id": Number,
		"name": {"type": String, "index": {"type": "global"}},
		"age": Number
	});
	new dynamoose.Table("OrCat", [Model], {"initialize": false});

	it("throws a TypeError instead of building a request", async () => {
		const query = Model.query("id").eq(1).or().where("age").eq(2);
		await expect(query.getRequest()).resolves.toBeDefined();
	});

	it("every or() position fails - leading, middle and trailing", async () => {
		// `comparisonChart` is only called for queries, so scans are unaffected.
		const scan = Model.scan("id").eq(1).or().where("age").eq(2);
		await expect(scan.getRequest()).resolves.toBeDefined();

		const middle = Model.query("id").eq(1).where("age").eq(2).or().where("name").eq("x");
		await expect(middle.getRequest()).resolves.toBeDefined();
	});
});


describe("FINDING 9: an empty `in([])` emits the invalid expression `#a0 IN ()`", () => {
	it("emits an expression DynamoDB cannot parse", async () => {
		const condition = new dynamoose.Condition("name").in([]);
		const request = await condition.getInternalProperties(internalProperties).requestObject(
			dynamoose.model("InCat", {"id": Number, "name": String}).Model,
			{"conditionString": "ConditionExpression", "conditionStringType": "string"}
		);
		expect(request.ConditionExpression).not.toMatch(/IN\s*\(\s*\)/);
	});
});


describe("FINDING 10: between() with one argument leaves a dangling value reference", () => {
	it("references a value placeholder that holds undefined", async () => {
		const condition = new dynamoose.Condition("name").between(1);
		const request = await condition.getInternalProperties(internalProperties).requestObject(
			dynamoose.model("BetweenCat", {"id": Number, "name": String}).Model,
			{"conditionString": "ConditionExpression", "conditionStringType": "string"}
		);
		const referenced = (request.ConditionExpression.match(/:[A-Za-z0-9_]+/g) || []);
		// The placeholder key exists, but its value is `undefined`.
		expect(referenced.every((v) => v in request.ExpressionAttributeValues)).toBe(true);
		expect(referenced.every((v) => request.ExpressionAttributeValues[v] !== undefined)).toBe(true);
	});
});


describe("FINDING 11: a schema attribute named after an Object.prototype member never gets its default", () => {
	it("the default is skipped for a `toString` attribute but applied for a normal one", async () => {
		const Weird = dynamoose.model("BuiltinNameCat", {"toString": {"type": String, "default": "D"}});
		const Normal = dynamoose.model("BuiltinNameCat2", {"normal": {"type": String, "default": "D"}});

		const weird = await Item.objectFromSchema({}, Weird.Model, {"type": "toDynamo", "typeCheck": false, "defaults": true, "mapAttributes": true});
		const normal = await Item.objectFromSchema({}, Normal.Model, {"type": "toDynamo", "typeCheck": false, "defaults": true, "mapAttributes": true});

		expect(normal).toEqual({"normal": "D"});
		expect(weird).toEqual({"toString": "D"});
	});

	it("root cause: utils.object.get returns the INHERITED function, so the value is not 'undefined'", () => {
		// `Item.objectFromSchema` reads the current value with `utils.object.get(returnObject, key)`.
		// For a key that exists on Object.prototype that read returns the inherited
		// function instead of `undefined`, so `defaultCheck` sees a defined value and
		// never applies the default.
		expect(typeof utils.object.get({}, "toString")).toBe("function");
		expect(utils.object.get({}, "toString") === undefined).toBe(false);
		expect(utils.object.get({}, "aNameThatIsNotOnObjectPrototype")).toBe(undefined);
	});
});


describe("FINDING 12: a range-key condition using an operator DynamoDB rejects in a KeyConditionExpression", () => {
	// AWS docs (Query.KeyConditionExpressions): the sort key condition must use
	// one of =, <, <=, >, >=, BETWEEN, or begins_with. IN, <> and the
	// attribute_exists family are NOT allowed.
	const RangeModel = dynamoose.model("RangeOpCat", {
		"id": Number,
		"sk": {"type": Number, "rangeKey": true}
	});
	new dynamoose.Table("RangeOpCat", [RangeModel], {"initialize": false});

	it("`in()` on the range key is moved into the KeyConditionExpression", async () => {
		const request = await RangeModel.query("id").eq(1).where("sk").in([1, 2]).getRequest();
		expect(request.KeyConditionExpression).not.toMatch(/\bIN\b/);
	});

	it("`not().eq()` (<>) on the range key is moved into the KeyConditionExpression", async () => {
		const request = await RangeModel.query("id").eq(1).where("sk").not().eq(5).getRequest();
		expect(request.KeyConditionExpression).not.toMatch(/<>/);
	});

	it("`not().exists()` (attribute_not_exists) on the range key is moved into the KeyConditionExpression", async () => {
		const request = await RangeModel.query("id").eq(1).where("sk").not().exists().getRequest();
		expect(request.KeyConditionExpression).not.toMatch(/attribute_not_exists/);
	});

	it("control: `exists()` and `not().contains()` stay in the FilterExpression", async () => {
		const exists = await RangeModel.query("id").eq(1).where("sk").exists().getRequest();
		expect(exists.KeyConditionExpression).toBe("#qha = :qhv");
		const notContains = await RangeModel.query("id").eq(1).where("sk").not().contains(2).getRequest();
		expect(notContains.KeyConditionExpression).toBe("#qha = :qhv");
	});
});


describe("FINDING 13: a required attribute named after an Object.prototype member is not enforced", () => {
	it("a missing `toString` attribute marked required does not raise a ValidationError", async () => {
		const Weird = dynamoose.model("RequiredBuiltinCat", {"id": Number, "toString": {"type": String, "required": true}});
		const Normal = dynamoose.model("RequiredBuiltinCat2", {"id": Number, "normal": {"type": String, "required": true}});

		let weirdError = null;
		try {
			await new Weird({"id": 1}).toDynamo({"required": true});
		} catch (e) {
			weirdError = e;
		}
		let normalError = null;
		try {
			await new Normal({"id": 1}).toDynamo({"required": true});
		} catch (e) {
			normalError = e;
		}

		// The control must be rejected.
		expect(normalError).not.toBe(null);
		// The builtin-named attribute must be rejected too.
		expect(weirdError).not.toBe(null);
	});
});


describe("FINDING 14: an array default containing a null element is silently dropped", () => {
	it("the whole attribute disappears instead of being defaulted", async () => {
		const WithNull = dynamoose.model("ArrayDefaultCat", {
			"id": Number,
			"arr": {"type": Array, "schema": [String], "default": () => ["a", null]}
		});
		const WithoutNull = dynamoose.model("ArrayDefaultCat2", {
			"id": Number,
			"arr": {"type": Array, "schema": [String], "default": () => ["a", "b"]}
		});

		const withNull = await Item.objectFromSchema({"id": 1}, WithNull.Model, {"type": "toDynamo", "typeCheck": false, "defaults": true, "mapAttributes": true});
		const withoutNull = await Item.objectFromSchema({"id": 1}, WithoutNull.Model, {"type": "toDynamo", "typeCheck": false, "defaults": true, "mapAttributes": true});

		expect(withoutNull).toEqual({"id": 1, "arr": ["a", "b"]});
		expect(withNull).toEqual({"id": 1, "arr": ["a", null]});
	});

	it("root cause: the 'is the default undefined' check inspects the ARRAY ELEMENTS", () => {
		// Item.objectFromSchema computes
		//   isDefaultValueUndefined = Array.isArray(defaultValue)
		//     ? defaultValue.some((v) => typeof v === "undefined" || v === null)
		//     : ...
		// so a single null element makes the whole default look undefined and it is discarded.
		const defaultValue = ["a", null];
		const isDefaultValueUndefined = Array.isArray(defaultValue)
			? defaultValue.some((v) => typeof v === "undefined" || v === null)
			: typeof defaultValue === "undefined" || defaultValue === null;
		expect(isDefaultValueUndefined).toBe(true);
	});
});


// NOT A BUG — documentation inaccuracy. Tracked here so the finding is not lost,
// but it must NOT be reported as a defect without maintainer sign-off.
//
// Schema.ts:438 says: "You can set a default value for an attribute that will be applied
// upon save if the given attribute value is `null` or `undefined`." In practice only
// `undefined` triggers the default; a `null` throws a TypeMismatch, because
// `Item.objectFromSchema` runs the type check (Item.ts:664) BEFORE the defaults block
// (Item.ts:704).
//
// The code side is the stronger one:
//  - `dynamoose.type.NULL` exists precisely to make an explicit null a first-class value,
//    so a raw `null` on a typed attribute is a type violation by design.
//  - The existing suite asserts it: test/Item.js:3263-3267 expects
//    "Expected data to be of type string, instead found type null." for a null value.
//  - No existing test exercises `default` + `null` together, so the interaction is
//    genuinely unspecified rather than contradicted.
//
// It fails loudly with a correct, attributed error and corrupts nothing.
describe("NOT A BUG (documentation inaccuracy): the JSDoc says a default applies to null", () => {
	it("a null value throws a TypeMismatch while an absent value gets the default", async () => {
		const M = dynamoose.model("NullDefaultCat", {"id": Number, "age": {"type": Number, "default": 5}});

		let error = null;
		try {
			await new M({"id": 1, "age": null}).toDynamo({"defaults": true});
		} catch (e) {
			error = e;
		}
		expect(error).not.toBe(null);
		expect(error.message).toContain("instead found type null");

		const M2 = dynamoose.model("NullDefaultCat2", {"id": Number, "age": {"type": Number, "default": 5}});
		const result = await new M2({"id": 1}).toDynamo({"defaults": true});
		expect(result).toEqual({"id": {"N": "1"}, "age": {"N": "5"}});
	});
});

describe("FINDING 16: a nested Schema plus a parent `saveUnknown: true` crashes on save", () => {
	it("saving an item built from such a Schema throws a raw TypeError", async () => {
		// `Schema.ts:1065` merges a nested Schema's settings into the parent's with
		// `merge_objects.main({combineMethod: "array_merge_new_array"})`. The parent's
		// `saveUnknown: true` (a boolean) is truthy, so the merge produces the
		// malformed `[true, ["nested.**"]]` instead of `["nested.**"]`.
		const inner = new dynamoose.Schema({"a": String}, {"saveUnknown": true});
		const outer = new dynamoose.Schema({"nested": inner}, {"saveUnknown": true});
		const M = dynamoose.model("NestedSaveUnknownCat", outer);
		new dynamoose.Table("NestedSaveUnknownCat", [M], {"initialize": false});

		let error = null;
		try {
			await new M({"id": "1", "nested": {"a": "x", "unknownKey": "y"}}).save();
		} catch (e) {
			error = e;
		}
		expect(error).toBe(null);
	});

	it("root cause: the merged saveUnknown setting is malformed", () => {
		const inner = new dynamoose.Schema({"a": String}, {"saveUnknown": true});
		const outer = new dynamoose.Schema({"nested": inner}, {"saveUnknown": true});
		const merged = outer.getSettingValue("saveUnknown");
		// The expected shape is a flat list of path patterns.
		expect(merged).toEqual(["nested.**"]);
	});

	it("control: a parent saveUnknown of false, or an array of paths, does not crash", () => {
		const utils = require("../../dist/utils").default;
		const innerOk = new dynamoose.Schema({"a": String}, {"saveUnknown": true});
		const outerOk = new dynamoose.Schema({"nested": innerOk}, {"saveUnknown": false});
		expect(outerOk.getSettingValue("saveUnknown")).toEqual(["nested.**"]);
		expect(() => utils.dynamoose.wildcard_allowed_check(outerOk.getSettingValue("saveUnknown"), "nested.x")).not.toThrow();
	});
});