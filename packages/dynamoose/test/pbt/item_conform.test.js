// PBT: Item.prototype.conformToSchema.
//
// CONTRACTS exercised here (source of truth):
//   - lib/Item.ts:883-919 `conformToSchema` "will modify the item to conform to the Schema".
//   - lib/Schema.ts:711-736 (`map`/`alias`/`aliases`):
//       "When retrieving data from DynamoDB, the attribute will be renamed to this property
//        name, or the first element of the array if it is an array."
//       "When saving to DynamoDB, the attribute name will always be used."
//   - lib/Schema.ts `defaultCheck`: a `default` is returned when the value is
//     undefined/null and `defaults` is enabled.
//   - lib/Schema.ts `requiredCheck`: throws ValidationError when a required
//     attribute has no value.
//   - lib/Item.ts:695-698: an attribute that is not in the schema is only kept
//     when BOTH `settings.saveUnknown` is true AND the schema's own
//     `saveUnknown` setting allows it. `saveUnknown` is a *schema* setting
//     (lib/Schema.ts:284), not an item-level one.
//
// NOTE: the shared `_helpers.runProperty` does NOT await async properties, so async
// properties here use `await fc.assert(...)` directly.
//
// NOTE: attribute names exclude "0", which hits a separate crash in
// `Item.attributesWithSchema` (see item_attributes.test.js).

const {fc} = require("./_helpers");
const dynamoose = require("../../dist");

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

let modelCounter = 0;
const makeModel = (schema) => {
	modelCounter++;
	return dynamoose.model(`PbtConform${modelCounter}`, schema, {"create": false, "waitForActive": false});
};

const FALSY = [0, "", false];
const typeOf = (value) => typeof value === "number" ? "Number" : (typeof value === "string" ? "String" : "Boolean");

// Schema attribute names may not contain dots (lib/Schema.ts:1149-1161), and
// "0" is excluded because it hits an unrelated crash.
const safeAttributeName = fc.string({minLength: 1, maxLength: 6}).filter((k) => !k.includes(".") && k !== "0" && !["__proto__", "constructor", "prototype"].includes(k));

describe("Item.conformToSchema", () => {
	// =====================================================================
	// CONFIRMED BUG 1
	// A mapped/aliased attribute whose value is falsy (0, "", false) is
	// dropped from the item instead of being renamed.
	// Root cause: lib/Item.ts:904 `if (expectedObjectValue)` — a truthiness
	// test where an `undefined` test is required.
	//
	// Reachable from the public API: `Model.get` (lib/Model/index.ts:1039),
	// `Model.scan`/`Model.query` (lib/ItemRetriever.ts:69) and
	// `Model.batchGet` (lib/Model/index.ts:482) all call `conformToSchema`
	// with `mapAttributes: true`.
	// =====================================================================
	it.failing("BUG: keeps a mapped attribute whose value is falsy (0, \"\", false)", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...FALSY),
			async (value) => {
				const model = makeModel({"pk": {"type": typeOf(value), "alias": "email"}});
				const item = new model.Item({"pk": value}, {"type": "fromDynamo"});

				await item.conformToSchema({"type": "fromDynamo", "mapAttributes": true});

				// The alias must be present and must hold the original value.
				expect(item.email).toBe(value);
			}), {"numRuns": 50});
	});

	it.failing("BUG: keeps a mapped attribute whose value is falsy through the public Model.get path", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(...FALSY),
			async (value) => {
				const model = makeModel({"pk": {"type": typeOf(value), "alias": "email"}});
				const wire = typeOf(value) === "Number" ? {"N": String(value)} : (typeOf(value) === "String" ? {"S": value} : {"BOOL": value});
				dynamoose.aws.ddb.set({"getItem": () => Promise.resolve({"Item": {"pk": wire}})});

				const user = await model.get(1);

				expect(user.email).toBe(value);
			}), {"numRuns": 50});
	});

	// =====================================================================
	// CONFIRMED BUG 2
	// `conformToSchema` computes the schema-conformed object (which does
	// contain the default) but never copies attributes that were absent
	// from the item onto it: lib/Item.ts:910-916 only iterates `item`'s keys.
	// `Item.objectFromSchema` with the same settings DOES return the default,
	// and `item.save()` DOES write the default, so conformToSchema is the
	// odd one out.
	// =====================================================================
	it.failing("BUG: applies a schema default to an attribute that is absent from the item", async () => {
		await fc.assert(fc.asyncProperty(
			fc.string({minLength: 1, maxLength: 6}),
			async (defaultValue) => {
				const model = makeModel({"id": Number, "name": {"type": String, "default": defaultValue}});
				const item = new model.Item({"id": 1});

				await item.conformToSchema({"type": "toDynamo", "defaults": true});

				expect(item.name).toBe(defaultValue);
			}), {"numRuns": 50});
	});

	// =====================================================================
	// Properties that hold.
	// =====================================================================
	it("does not mutate the document it was given", async () => {
		await fc.assert(fc.asyncProperty(
			fc.dictionary(
				safeAttributeName,
				fc.oneof(fc.string(), fc.integer(), fc.boolean()),
				{maxKeys: 4}
			),
			async (doc) => {
				const model = makeModel({"id": Number, "name": String});
				const item = new model.Item(doc);
				const snapshot = JSON.parse(JSON.stringify(doc));

				await item.conformToSchema({"type": "toDynamo", "defaults": true, "customTypesDynamo": true});

				expect(doc).toEqual(snapshot);
			}), {"numRuns": 200});
	});

	it("leaves an item whose attributes are all in the schema unchanged", async () => {
		await fc.assert(fc.asyncProperty(
			fc.tuple(fc.integer(), fc.string(), fc.boolean()),
			async ([id, name, flag]) => {
				const model = makeModel({"id": Number, "name": String, "flag": Boolean});
				const doc = {"id": id, "name": name, "flag": flag};
				const item = new model.Item(doc);

				await item.conformToSchema({"type": "toDynamo", "customTypesDynamo": true});

				expect({...item}).toEqual(doc);
			}), {"numRuns": 200});
	});

	it("removes attributes that are not in the schema", async () => {
		await fc.assert(fc.asyncProperty(
			safeAttributeName,
			async (extra) => {
				const model = makeModel({"id": Number});
				const item = new model.Item({"id": 1, [extra]: "value"});

				await item.conformToSchema({"type": "toDynamo"});

				expect(extra in item).toBe(false);
				expect(item.id).toBe(1);
			}), {"numRuns": 100});
	});

	it("keeps attributes that are not in the schema when the schema enables saveUnknown", async () => {
		await fc.assert(fc.asyncProperty(
			safeAttributeName,
			async (extra) => {
				const model = makeModel(new dynamoose.Schema({"id": Number}, {"saveUnknown": true}));
				const item = new model.Item({"id": 1, [extra]: "value"});

				await item.conformToSchema({"type": "toDynamo", "saveUnknown": true});

				expect(item[extra]).toBe("value");
			}), {"numRuns": 100});
	});

	it("throws a ValidationError for a missing required attribute that has no default", async () => {
		await fc.assert(fc.asyncProperty(
			safeAttributeName,
			async (attribute) => {
				const model = makeModel({"id": Number, [attribute]: {"type": String, "required": true}});
				const item = new model.Item({"id": 1});

				await expect(item.conformToSchema({"type": "toDynamo", "required": true})).rejects.toThrow(/is a required property but has no value/);
			}), {"numRuns": 50});
	});

	it("does not throw for a missing required attribute that has a default", async () => {
		await fc.assert(fc.asyncProperty(
			safeAttributeName,
			async (attribute) => {
				const model = makeModel({"id": Number, [attribute]: {"type": String, "required": true, "default": "fallback"}});
				const item = new model.Item({"id": 1});

				await expect(item.conformToSchema({"type": "toDynamo", "required": true, "defaults": true})).resolves.toBeDefined();
			}), {"numRuns": 50});
	});

	it("renames a mapped attribute to its alias when the value is truthy", async () => {
		await fc.assert(fc.asyncProperty(
			fc.integer({min: 1, max: 1000}),
			async (value) => {
				const model = makeModel({"pk": {"type": Number, "alias": "email"}});
				const item = new model.Item({"pk": value}, {"type": "fromDynamo"});

				await item.conformToSchema({"type": "fromDynamo", "mapAttributes": true});

				expect(item.email).toBe(value);
				expect("pk" in item).toBe(false);
			}), {"numRuns": 100});
	});
});
