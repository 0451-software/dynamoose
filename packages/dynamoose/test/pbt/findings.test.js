// Consolidated, independent verification of each CONFIRMED finding.
//
// Every test in this file reproduces a bug that was independently observed by
// running the code (not by reading it). Where a finding was initially a
// hypothesis, the hypothesis was first checked against the code's own expressed
// intent (existing unit tests + JSDoc) and against the real public API.
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

describe("FINDING 1: combine_objects / merge_objects throw a raw TypeError on a null nested value", () => {
	it("combine_objects throws TypeError instead of handling a null nested value", () => {
		expect(() => utils.combine_objects({"a": {"b": 1}}, {"a": null})).toThrow(TypeError);
	});

	it("merge_objects (array_merge_new_array) throws TypeError on a null nested value", () => {
		expect(() => utils.merge_objects.main({"combineMethod": "array_merge_new_array"})({"a": {"b": 1}}, {"a": null})).toThrow(TypeError);
	});

	it("root cause: typeof null === 'object' passes the guard, then Object.keys(null) throws", () => {
		// `combine_objects` guards with `typeof returnObject[key] === "object" && typeof arg[key] === "object"`.
		// For a null value the second check still passes, so it recurses with `null`
		// and `Object.keys(null)` throws "Cannot convert undefined or null to object".
		expect(typeof null).toBe("object");
		expect(() => Object.keys(null)).toThrow(TypeError);
	});
});

describe("FINDING 2: deep_copy does not deep-copy values inside a Map or a Set", () => {
	it("a Map value is shared between the original and the copy", () => {
		const inner = {"n": 1};
		const original = new Map([["k", inner]]);
		const copy = utils.deep_copy(original);
		expect(copy.get("k")).toBe(inner);
	});

	it("a Set element is shared between the original and the copy", () => {
		const inner = {"n": 1};
		const original = new Set([inner]);
		const copy = utils.deep_copy(original);
		expect([...copy][0]).toBe(inner);
	});

	it("mutating the copy's nested value is visible through the original", () => {
		const inner = {"n": 1};
		const original = new Map([["k", inner]]);
		const copy = utils.deep_copy(original);
		copy.get("k").n = 999;
		expect(inner.n).toBe(999);
	});

	it("control: a nested plain object IS deep copied", () => {
		const inner = {"n": 1};
		const copy = utils.deep_copy({"x": inner});
		copy.x.n = 999;
		expect(inner.n).toBe(1);
	});

	it("root cause: the Map/Set branches use the shallow `new Map(obj)` / `new Set(obj)`", () => {
		// Every other branch recurses into its children; Map and Set do not.
		const inner = {"n": 1};
		expect(new Map([["k", inner]]).get("k")).toBe(inner);
		expect(new Set([inner])[Symbol.iterator]().next().value).toBe(inner);
	});
});

describe("FINDING 3: merge_objects mutates its first argument", () => {
	it("merge_objects mutates the first argument it is given", () => {
		const first = {"x": 1};
		utils.merge_objects(first, {"x": 2, "y": 3});
		expect(first).toEqual({"x": 3, "y": 3});
	});

	it("merge_objects returns the first argument by reference", () => {
		const first = {"x": 1};
		expect(utils.merge_objects(first, {"y": 2})).toBe(first);
	});
});

describe("FINDING 4: merge_objects result depends on the TRUTHINESS of the accumulated value", () => {
	it("a numeric 0 is overwritten instead of added", () => {
		// The `else if (returnObject[key])` branch is truthiness-sensitive, so a 0
		// skips the numeric-addition path and is replaced instead.
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

describe("FINDING 5: prototype pollution through combine_objects / merge_objects", () => {
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

describe("FINDING 6: Table constructor mutates and aliases the caller's options object", () => {
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

describe("FINDING 7: a failed Table construction permanently bricks its models", () => {
	it("models stay bound to the half-built table after the constructor throws", () => {
		const good = dynamoose.model("BrickCat1", {"id": {"type": String, "hashKey": true}});
		const bad = dynamoose.model("BrickCat2", {"otherId": {"type": String, "hashKey": true}});

		expect(() => new dynamoose.Table("BrickCat", [good, bad], {"initialize": false})).toThrow("hashKey's for all models must match.");

		// The model is now bound to a table that never finished being constructed,
		// so it can never be attached to a working table.
		expect(() => new dynamoose.Table("BrickCat2", [good], {"initialize": false})).toThrow("Model BrickCat1 has already been assigned to a table.");
	});
});

describe("FINDING 8: comparisonChart is keyed by array index for grouped conditions", () => {
	const Model = dynamoose.model("ChartCat", {
		"id": Number,
		"name": {"type": String, "index": {"type": "global"}},
		"age": Number
	});
	new dynamoose.Table("ChartCat", [Model]);

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

describe("FINDING 9: a hash-key condition inside a parenthesis group breaks the key condition", () => {
	const Model = dynamoose.model("GroupCat", {
		"id": Number,
		"name": {"type": String, "index": {"type": "global"}},
		"age": Number,
		"color": String
	});
	new dynamoose.Table("GroupCat", [Model]);

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

describe("FINDING 10: a top-level or() crashes the request builder", () => {
	const Model = dynamoose.model("OrCat", {
		"id": Number,
		"name": {"type": String, "index": {"type": "global"}},
		"age": Number
	});
	new dynamoose.Table("OrCat", [Model]);

	it("throws a TypeError instead of building a request", async () => {
		const query = Model.query("id").eq(1).or().where("age").eq(2);
		await expect(query.getRequest()).resolves.toBeDefined();
	});
});

describe("FINDING 11: an empty `in([])` emits the invalid expression `#a0 IN ()`", () => {
	it("emits an expression DynamoDB cannot parse", async () => {
		const condition = new dynamoose.Condition("name").in([]);
		const request = await condition.getInternalProperties(internalProperties).requestObject(
			dynamoose.model("InCat", {"id": Number, "name": String}).Model,
			{"conditionString": "ConditionExpression", "conditionStringType": "string"}
		);
		expect(request.ConditionExpression).not.toMatch(/IN\s*\(\s*\)/);
	});
});

describe("FINDING 12: between() with one argument leaves a dangling value reference", () => {
	it("references a value placeholder that holds undefined, which the AWS SDK rejects", async () => {
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

describe("FINDING 13: find_best_index mutates the caller's index objects", () => {
	it("adds internal properties to the index objects it is given", () => {
		const indexes = {"TableIndex": {"IndexName": "T", "KeySchema": [{"AttributeName": "id", "KeyType": "HASH"}]}};
		const snapshot = JSON.stringify(indexes);
		utils.find_best_index(indexes, {"id": {"type": "EQ"}});
		expect(JSON.stringify(indexes)).toBe(snapshot);
	});
});
