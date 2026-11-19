// PBT: schema attribute names.
//
// CONTRACT:
//   lib/Schema.ts:1149-1161 `checkAttributeNameDots` is the ONLY validation
//   Dynamoose performs on attribute names: it rejects names containing ".".
//   Any other name — including "0" — is accepted by the Schema constructor
//   and must therefore work end to end.
//
//   lib/Item.ts:560-601 `Item.attributesWithSchema` builds a tree of schema
//   attribute names and walks it. The special case at lib/Item.ts:577
//   (`if (attr === "0")`) exists to model array indices, but it is applied to
//   ANY node named "0", including a top-level schema attribute named "0".
//   The `node` in that branch is the raw item (a plain object), not an array,
//   so `node.forEach` is not a function.
//
//   Result: a schema with an attribute named "0" throws
//   `TypeError: node.forEach is not a function` from every code path that
//   calls `Item.attributesWithSchema` — i.e. `Item.objectFromSchema` with
//   `modifiers`, `defaults`, `required` or `enum` enabled, which includes
//   `Item.prototype.save()` and `Model.get`.

const {fc} = require("./_helpers");
const dynamoose = require("../../dist");
const {Item} = require("../../dist/Item");
const ModelStore = require("../../dist/ModelStore").default;

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

let modelCounter = 0;
const makeModel = (schema) => {
	modelCounter++;
	const name = `PbtAttr${modelCounter}`;
	dynamoose.model(name, schema, {"create": false, "waitForActive": false});
	return {"model": dynamoose.model(name), "M": ModelStore(name)};
};

describe("schema attribute names", () => {
	// =====================================================================
	// CONFIRMED BUG 6
	// An attribute named "0" is accepted by the Schema constructor but makes
	// `Item.attributesWithSchema` throw `TypeError: node.forEach is not a
	// function`, because lib/Item.ts:577 treats any node named "0" as an
	// array index.
	// Root cause: lib/Item.ts:577-586.
	// =====================================================================
	it.failing("BUG: a schema attribute named \"0\" does not crash Item.objectFromSchema", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constant("0"),
			async (attribute) => {
				const {M} = makeModel({"id": Number, [attribute]: String});

				const result = await Item.objectFromSchema(
					{"id": 1, [attribute]: "x"},
					M,
					{"type": "toDynamo", "modifiers": ["set"]}
				);

				expect(result[attribute]).toBe("x");
			}), {"numRuns": 10});
	});

	it.failing("BUG: Item.prototype.save does not throw for a schema attribute named \"0\"", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constant("0"),
			async (attribute) => {
				const {model} = makeModel({"id": Number, [attribute]: String});
				dynamoose.aws.ddb.set({"putItem": () => Promise.resolve({})});

				const request = await new model({"id": 1, [attribute]: "x"}).save({"return": "request"});

				expect(request.Item[attribute]).toEqual({"S": "x"});
			}), {"numRuns": 10});
	});

	it.failing("BUG: Model.get does not throw for a schema attribute named \"0\"", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constant("0"),
			async (attribute) => {
				const {model} = makeModel({"id": Number, [attribute]: String});
				dynamoose.aws.ddb.set({"getItem": () => Promise.resolve({"Item": {"id": {"N": "1"}, [attribute]: {"S": "x"}}})});

				const item = await model.get(1);

				expect(item[attribute]).toBe("x");
			}), {"numRuns": 10});
	});

	// =====================================================================
	// Properties that hold.
	// =====================================================================

	// "1" is not special-cased (only the exact string "0" is), so it works.
	it("supports an attribute named \"1\"", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constant("1"),
			async (attribute) => {
				const {model} = makeModel({"id": Number, [attribute]: String});
				dynamoose.aws.ddb.set({"putItem": () => Promise.resolve({})});

				const request = await new model({"id": 1, [attribute]: "x"}).save({"return": "request"});

				expect(request.Item[attribute]).toEqual({"S": "x"});
			}), {"numRuns": 10});
	});

	it("supports attribute names that merely contain a digit", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constantFrom(["a0", "0a", "id0", "x1y", "00"]),
			async (attribute) => {
				const {model} = makeModel({"id": Number, [attribute]: String});
				dynamoose.aws.ddb.set({"putItem": () => Promise.resolve({})});

				const request = await new model({"id": 1, [attribute]: "x"}).save({"return": "request"});

				expect(request.Item[attribute]).toEqual({"S": "x"});
			}), {"numRuns": 50});
	});

	it("round-trips an attribute named \"0\" through objectFromSchema without modifiers", async () => {
		await fc.assert(fc.asyncProperty(
			fc.constant("0"),
			async (attribute) => {
				const {M} = makeModel({"id": Number, [attribute]: String});

				const result = await Item.objectFromSchema({"id": 1, [attribute]: "x"}, M, {"type": "toDynamo"});

				expect(result[attribute]).toBe("x");
			}), {"numRuns": 10});
	});
});
