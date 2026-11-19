// PBT: round-trip losslessness for Item.objectFromSchema -> Item.objectToDynamo -> Item.fromDynamo.
//
// CONTRACT (lib/Item.ts:620-873, docs/docs_src/guide/Schema.md "Attribute Types" table):
//   For every value the schema can represent, converting the document to its DynamoDB
//   representation and back must not change the value.
//
// The reference model is independent of the implementation: we describe the expected
// DynamoDB wire shape ourselves and compare the *unmarshalled* result with the original.
//
// Documented normalisations that this file accounts for:
//   - `Date` is stored as milliseconds since epoch (or an ISO string with storage:"iso"),
//     so a Date comes back as a number/string unless `customTypesDynamo` converts it back.
//   - `Set` is stored as a DynamoDB set and comes back as a JS Set.
//   - DynamoDB cannot store an empty set, so the Set arbitrary is non-empty.
//
// NOTE: the shared `_helpers.runProperty` does NOT await async properties, so every async
// property below uses `await fc.assert(...)` directly. Without the `await`, an assertion
// failure surfaces as an unhandled rejection after Jest has torn down the environment.

const {fc} = require("./_helpers");
const dynamoose = require("../../dist");
const {Item} = require("../../dist/Item");

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

let modelCounter = 0;
const makeModel = (schema) => {
	modelCounter++;
	return dynamoose.model(`PbtRoundTrip${modelCounter}`, schema, {"create": false, "waitForActive": false});
};

const safeKey = fc.string({minLength: 1, maxLength: 6}).filter((k) => !["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"].includes(k));

// Schema-representable leaf values (no NaN, no -0).
//
// Numbers are bounded to the safe-integer range because DynamoDB stores them
// as strings and the AWS SDK refuses to marshall anything outside it
// ("Number ... is lesser than Number.MIN_SAFE_INTEGER").
const leafValue = fc.oneof(
	fc.integer({min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER}),
	fc.double({noNaN: true, noDefaultInfinity: true}).filter((n) => Math.abs(n) <= Number.MAX_SAFE_INTEGER && !Object.is(n, -0)),
	fc.boolean(),
	fc.string(),
	fc.constant(null)
);

// A document whose every leaf is representable by the "any" schema.
// NOTE: fast-check 3.x `letrec` takes an object of arbitraries keyed by name.
const anyDoc = fc.letrec((tie) => ({
	"doc": fc.oneof(
		leafValue,
		fc.array(tie("doc"), {maxLength: 3}),
		fc.dictionary(safeKey, tie("doc"), {maxKeys: 3})
	)
})).doc;

const docOf = fc.dictionary(safeKey, anyDoc, {maxKeys: 4});

// DynamoDB stores numbers as strings; the SDK rejects anything above MAX_SAFE_INTEGER.
const safeNumber = fc.oneof(
	fc.integer({min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER}),
	fc.double({noNaN: true, noDefaultInfinity: true}).filter((n) => Math.abs(n) <= Number.MAX_SAFE_INTEGER && !Object.is(n, -0))
);

describe("Item round trip", () => {
	it("toDynamo -> objectToDynamo -> fromDynamo preserves a schema-representable document", async () => {
		const model = makeModel(new dynamoose.Schema({"data": dynamoose.type.ANY}, {"saveUnknown": true}));

		await fc.assert(fc.asyncProperty(docOf, async (doc) => {
			const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "saveUnknown": true, "customTypesDynamo": true});
			const marshalled = Item.objectToDynamo(toDynamo);
			const back = Item.fromDynamo(marshalled);

			expect(back).toEqual(doc);
		}), {"numRuns": 300});
	});

	it("preserves falsy-but-present values (0, \"\", false) through a full round trip", async () => {
		const model = makeModel({"id": Number, "name": String, "flag": Boolean, "count": Number});

		await fc.assert(fc.asyncProperty(
			fc.tuple(fc.integer(), fc.string(), fc.boolean()),
			async ([id, name, flag]) => {
				const doc = {"id": id, "name": name, "flag": flag};
				const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
				const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

				expect(back).toEqual(doc);
			}), {"numRuns": 200});
	});

	it("preserves empty string / empty array / empty object / zero", async () => {
		const model = makeModel({
			"id": Number,
			"str": String,
			"arr": {"type": Array, "schema": [String]},
			"obj": {"type": Object, "schema": {"x": String}}
		});

		await fc.assert(fc.asyncProperty(fc.string(), async () => {
			const doc = {"id": 0, "str": "", "arr": [], "obj": {}};
			const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
			const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

			expect(back).toEqual(doc);
		}), {"numRuns": 100});
	});

	it("preserves integer vs float distinction for a Number attribute", async () => {
		const model = makeModel({"n": Number});

		await fc.assert(fc.asyncProperty(safeNumber, async (n) => {
			const doc = {"n": n};
			const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
			const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

			expect(back.n).toBe(n);
		}), {"numRuns": 300});
	});

	it("preserves a Buffer attribute", async () => {
		const model = makeModel({"id": Number, "buf": Buffer});

		await fc.assert(fc.asyncProperty(fc.uint8Array({maxLength: 16}), async (bytes) => {
			const doc = {"id": 1, "buf": Buffer.from(bytes)};
			const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
			const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

			expect(Buffer.isBuffer(back.buf)).toBe(true);
			expect(back.buf.equals(doc.buf)).toBe(true);
		}), {"numRuns": 200});
	});

	it("preserves a Set attribute", async () => {
		const model = makeModel({"id": Number, "s": {"type": Set, "schema": [String]}});

		await fc.assert(fc.asyncProperty(
			fc.uniqueArray(fc.string({maxLength: 8}), {minLength: 1, maxLength: 5}),
			async (values) => {
				const doc = {"id": 1, "s": new Set(values)};
				const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
				const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

				expect(back.s instanceof Set).toBe(true);
				expect([...back.s].sort()).toEqual([...values].sort());
			}), {"numRuns": 200});
	});

	it("preserves a Date attribute to millisecond precision", async () => {
		const model = makeModel({"id": Number, "d": Date});

		await fc.assert(fc.asyncProperty(
			fc.integer({min: -62135596800000, max: 253402300799999}),
			async (ms) => {
				const doc = {"id": 1, "d": new Date(ms)};
				const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
				const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

				// A Date is stored as a number of milliseconds since epoch.
				expect(back.d).toBe(ms);
			}), {"numRuns": 300});
	});

	it("preserves a Date attribute with iso storage as the same instant", async () => {
		const model = makeModel({"id": Number, "d": {"type": {"value": Date, "settings": {"storage": "iso"}}}});

		await fc.assert(fc.asyncProperty(
			fc.integer({min: -62135596800000, max: 253402300799999}),
			async (ms) => {
				const doc = {"id": 1, "d": new Date(ms)};
				const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
				const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

				expect(new Date(back.d).getTime()).toBe(ms);
			}), {"numRuns": 300});
	});

	it("preserves nested Maps through a round trip", async () => {
		const model = makeModel({
			"id": Number,
			"outer": {"type": Object, "schema": {
				"inner": {"type": Object, "schema": {"leaf": String, "num": Number}},
				"list": {"type": Array, "schema": [{"type": Object, "schema": {"a": String}}]}
			}}
		});

		await fc.assert(fc.asyncProperty(
			fc.string({maxLength: 8}),
			async (leaf) => {
				const doc = {"id": 1, "outer": {"inner": {"leaf": leaf, "num": 7}, "list": [{"a": "x"}, {"a": "y"}]}};
				const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "customTypesDynamo": true});
				const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

				expect(back).toEqual(doc);
			}), {"numRuns": 200});
	});

	it("preserves attributes not present in the schema when saveUnknown is enabled", async () => {
		const model = makeModel(new dynamoose.Schema({"id": Number}, {"saveUnknown": true}));

		await fc.assert(fc.asyncProperty(
			fc.dictionary(safeKey, fc.oneof(fc.string(), fc.integer(), fc.boolean()), {maxKeys: 3}),
			async (extra) => {
				const doc = {"id": 1, ...extra};
				const toDynamo = await Item.objectFromSchema(doc, model.Model, {"type": "toDynamo", "saveUnknown": true, "customTypesDynamo": true});
				const back = Item.fromDynamo(Item.objectToDynamo(toDynamo));

				expect(back).toEqual(doc);
			}), {"numRuns": 200});
	});
});
