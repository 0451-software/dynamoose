// PBT: Model layer — attribute-name mapping, Condition request generation,
// and Model.update request generation.
//
// CONTRACTS exercised here (source of truth):
//   - lib/Model/index.ts:276-280 `dynamoPropertyForAttribute`:
//       "This function returns the DynamoDB property name for a given attribute
//        (alias or property name). For example if you have a `pk` with an alias
//        of `userID` and pass in `userID` it will return `pk`. If you pass in
//        `pk` it will return `pk`."
//   - lib/Condition.ts:185 uses `dynamoPropertyForAttribute` to build the
//     `ExpressionAttributeNames` entry for a condition key, so the returned name
//     must be the attribute the user actually conditioned on.
//   - lib/Model/index.ts:757 `Model.update` converts the update value with
//     `Item.objectFromSchema({[subKey]: ...}, ..., {"mapAttributes": true})`,
//     and lib/Model/index.ts:781 writes `subKey` into `ExpressionAttributeNames`.
//     `subKey` must therefore be the DynamoDB-side attribute name.
//
// NOTE: the shared `_helpers.runProperty` does NOT await async properties, so
// async properties here use `await fc.assert(...)` directly.
//
// NOTE: attribute names are drawn from a fixed list rather than generated,
// because an attribute literally named "0" hits a separate, unrelated crash in
// `Item.attributesWithSchema` (see item_attributes.test.js).

const {fc} = require("./_helpers");
const dynamoose = require("../../dist");
const internal = require("../../dist/Internal").default;
const ModelStore = require("../../dist/ModelStore").default;

const ip = internal.General.internalProperties;

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

let modelCounter = 0;
const makeModel = (schema) => {
	modelCounter++;
	const name = `PbtModel${modelCounter}`;
	dynamoose.model(name, schema, {"create": false, "waitForActive": false});
	return {"model": dynamoose.model(name), "M": ModelStore(name)};
};

// Attribute names that Dynamoose accepts and that do not collide with the
// special-cased "0" path in `Item.attributesWithSchema`.
const ATTRIBUTE_NAMES = ["id2", "name", "email", "title", "count", "flag", "kind"];
const ALIAS_NAMES = ["userName", "userId", "displayName", "e_mail", "label", "total"];

describe("Model attribute-name mapping", () => {
	// =====================================================================
	// CONFIRMED BUG 3
	// `dynamoPropertyForAttribute` builds a probe object `{[attribute]: true}`
	// and then reads `Object.keys(obj)[0]` — the FIRST key of the result.
	// A schema-level `set` modifier may prepend other attributes, so the
	// first key is not necessarily the requested attribute.
	// Root cause: lib/Model/index.ts:278-279.
	//
	// This corrupts every Condition built against such a model: the
	// condition silently filters on the WRONG attribute.
	// =====================================================================
	it.failing("BUG: dynamoPropertyForAttribute returns the requested attribute, not the first key of the probe object", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ATTRIBUTE_NAMES),
			async (attribute) => {
				const {M} = makeModel(new dynamoose.Schema(
					{"id": Number, [attribute]: String},
					{"set": (item) => ({type: "user", ...item})}
				));

				const resolved = await M.getInternalProperties(ip).dynamoPropertyForAttribute(attribute);

				expect(resolved).toBe(attribute);
			}), {"numRuns": 50});
	});

	it.failing("BUG: a Condition on a schema with a schema-level `set` modifier targets the requested attribute", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ATTRIBUTE_NAMES),
			async (attribute) => {
				const {M} = makeModel(new dynamoose.Schema(
					{"id": Number, [attribute]: String},
					{"set": (item) => ({type: "user", ...item})}
				));

				const condition = new dynamoose.Condition().where(attribute).eq("bob");
				const request = await condition.getInternalProperties(ip).requestObject(M);

				expect(Object.values(request.ExpressionAttributeNames)).toContain(attribute);
			}), {"numRuns": 50});
	});

	// =====================================================================
	// CONFIRMED BUG 4
	// `dynamoPropertyForAttribute` passes the literal `true` as the
	// attribute value with `modifiers: ["set"]`. An attribute-level `set`
	// modifier therefore receives `true` instead of a value of the
	// attribute's declared type, and throws for any modifier that calls a
	// type-specific method.
	// Root cause: lib/Model/index.ts:278.
	//
	// Reachable from the public API: `Model.scan(cond)`, `Model.query(cond)`,
	// `Model.delete(key, {condition})` and `Model.update(key, obj, {condition})`
	// all build a Condition request, which calls this function.
	// =====================================================================
	it.failing("BUG: dynamoPropertyForAttribute does not crash on an attribute with a type-specific `set` modifier", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ATTRIBUTE_NAMES),
			async (attribute) => {
				const {M} = makeModel({
					"id": Number,
					[attribute]: {"type": String, "set": (value) => value.trim()}
				});

				const resolved = await M.getInternalProperties(ip).dynamoPropertyForAttribute(attribute);

				expect(resolved).toBe(attribute);
			}), {"numRuns": 50});
	});

	it.failing("BUG: Model.scan with a Condition does not throw for an attribute with a type-specific `set` modifier", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ATTRIBUTE_NAMES),
			async (attribute) => {
				const {model} = makeModel({
					"id": Number,
					[attribute]: {"type": String, "set": (value) => value.trim()}
				});
				dynamoose.aws.ddb.set({"scan": () => Promise.resolve({"Items": [], "Count": 0, "ScannedCount": 0})});

				const condition = new dynamoose.Condition().where(attribute).eq("bob");

				await expect(model.scan(condition).exec()).resolves.toBeDefined();
			}), {"numRuns": 50});
	});

	// =====================================================================
	// CONFIRMED BUG 5
	// `Model.update` converts the update value with
	// `Item.objectFromSchema({[subKey]: ...}, ..., {"mapAttributes": true})`.
	// With `mapAttributes: true` and `type: "toDynamo"`, `objectFromSchema`
	// RENAMES the key from the alias to the schema attribute name
	// (lib/Item.ts:630-658), so the returned object is keyed by the schema
	// attribute name — but lib/Model/index.ts:757 then reads `[subKey]`, i.e.
	// the ALIAS key, which is now gone. `subValue` becomes `undefined` and the
	// update is silently dropped (empty UpdateExpression).
	// Root cause: lib/Model/index.ts:757 (read key) vs. lib/Item.ts:630-658.
	//
	// The same `Model.update` call keyed by the raw schema attribute name
	// works, so the alias path is the broken one.
	// =====================================================================
	it.failing("BUG: Model.update with an aliased attribute name in the update object is not silently dropped", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ALIAS_NAMES),
			async (alias) => {
				const {model} = makeModel({"id": Number, "name": {"type": String, "alias": alias}});
				dynamoose.aws.ddb.set({"updateItem": () => Promise.resolve({})});

				const request = await model.update({"id": 1}, {[alias]: "bob"}, {"return": "request"});

				expect(request.UpdateExpression).not.toBe("");
				expect(Object.values(request.ExpressionAttributeNames)).toContain("name");
			}), {"numRuns": 50});
	});

	it.failing("BUG: Model.update with a `map`ped attribute name in the update object is not silently dropped", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ALIAS_NAMES),
			async (mapped) => {
				const {model} = makeModel({"id": Number, "name": {"type": String, "map": mapped}});
				dynamoose.aws.ddb.set({"updateItem": () => Promise.resolve({})});

				const request = await model.update({"id": 1}, {[mapped]: "bob"}, {"return": "request"});

				expect(request.UpdateExpression).not.toBe("");
				expect(Object.values(request.ExpressionAttributeNames)).toContain("name");
			}), {"numRuns": 50});
	});

	// =====================================================================
	// Properties that hold.
	// =====================================================================
	it("maps an attribute to its DynamoDB property name", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ATTRIBUTE_NAMES),
			async (attribute) => {
				const {M} = makeModel({"id": Number, [attribute]: String});

				const resolved = await M.getInternalProperties(ip).dynamoPropertyForAttribute(attribute);

				expect(resolved).toBe(attribute);
			}), {"numRuns": 100});
	});

	it("maps an alias to its DynamoDB property name", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ALIAS_NAMES),
			async (alias) => {
				const {M} = makeModel({"id": Number, "name": {"type": String, "alias": alias}});

				const resolved = await M.getInternalProperties(ip).dynamoPropertyForAttribute(alias);

				expect(resolved).toBe("name");
			}), {"numRuns": 100});
	});

	it("builds a Condition whose ExpressionAttributeNames contains the conditioned attribute", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ATTRIBUTE_NAMES),
			async (attribute) => {
				const {M} = makeModel({"id": Number, [attribute]: String});

				const condition = new dynamoose.Condition().where(attribute).eq("bob");
				const request = await condition.getInternalProperties(ip).requestObject(M);

				expect(Object.values(request.ExpressionAttributeNames)).toContain(attribute);
				expect(request.ConditionExpression).toBe("#a0 = :v0");
			}), {"numRuns": 100});
	});

	it("does not throw when a Condition targets an attribute with a `set` modifier that works on any value", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...ATTRIBUTE_NAMES),
			async (attribute) => {
				const {M} = makeModel({
					"id": Number,
					[attribute]: {"type": String, "set": (value) => `${value}!`}
				});

				const condition = new dynamoose.Condition().where(attribute).eq("bob");
				const request = await condition.getInternalProperties(ip).requestObject(M);

				expect(Object.values(request.ExpressionAttributeNames)).toContain(attribute);
			}), {"numRuns": 100});
	});
});
