// PBT: Schema type-system properties.
//
// Contract sources:
//  - packages/dynamoose/lib/Schema.ts (attributeTypes / getAttributeTypeDetails / getTypePaths)
//  - packages/dynamoose/lib/utils/type_name.ts
//  - packages/dynamoose/lib/utils/dynamoose/getValueTypeCheckResult.ts
//  - docs/docs_src/guide/Schema.md ("In the event you have multiple types that match ... Dynamoose
//     will attempt to pick the closest matching type. However, if all types are valid, Dynamoose
//     will default to the first type in the array.")
const dynamoose = require("../../dist");
const utils = require("../../dist/utils").default;
const {fc, runProperty} = require("./_helpers");

// ---------------------------------------------------------------------------
// Independent reference models
// ---------------------------------------------------------------------------

/**
 * Reference model for "is this value a plain (JSON-ish) object?".
 * Deliberately NOT a restatement of Schema.ts's `val.constructor === Object`
 * check: that check reads the *own* `constructor` property, which an object
 * literal with a key literally named "constructor" shadows.
 */
const isPlainObject = (v) => {
	if (v === null || typeof v !== "object" || Array.isArray(v)) {
		return false;
	}
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

/**
 * Keys that collide with JS built-in property names. `__proto__` is excluded because
 * plain assignment to it mutates the prototype instead of creating an own property
 * (it is covered separately with `Object.defineProperty`).
 */
const builtinKeyArb = fc.constantFrom(
	"constructor",
	"toString",
	"valueOf",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString"
);

/** A JSON object whose keys are arbitrary, including JS built-in names. */
const jsonObjectArb = fc.dictionary(
	fc.oneof(builtinKeyArb, fc.string({minLength: 1, maxLength: 8})),
	fc.oneof(
		fc.constant(null),
		fc.boolean(),
		fc.integer(),
		fc.string({maxLength: 8}),
		fc.array(fc.integer(), {maxLength: 3})
	),
	{maxKeys: 4}
);

// ===========================================================================
// 1. The `Object` type must accept every plain JSON object.
// ===========================================================================

describe("schema types: Object type accepts plain objects", () => {
	it("should accept a plain object (incl. objects with a 'constructor' key) for type Object", () => {
		runProperty(
			fc.property(jsonObjectArb, (obj) => {
				const schema = new dynamoose.Schema({"id": Object});
				const result = utils.dynamoose.getValueTypeCheckResult(schema, obj, "id", {"type": "toDynamo"}, {});
				return result.isValidType === isPlainObject(obj);
			}),
			{numRuns: 500, label: "Object type accepts plain objects (toDynamo)"}
		);
	});

	it("should accept a plain object for type Object in the fromDynamo direction too", () => {
		runProperty(
			fc.property(jsonObjectArb, (obj) => {
				const schema = new dynamoose.Schema({"id": Object});
				const result = utils.dynamoose.getValueTypeCheckResult(schema, obj, "id", {"type": "fromDynamo"}, {});
				return result.isValidType === isPlainObject(obj);
			}),
			{numRuns: 500, label: "Object type accepts plain objects (fromDynamo)"}
		);
	});
});

// ===========================================================================
// 2. utils.type_name must produce a usable type description.
// ===========================================================================

describe("schema types: utils.type_name", () => {
	it("must never describe a defined value as 'undefined'", () => {
		runProperty(
			fc.property(
				fc.oneof(
					fc.constant(null),
					fc.boolean(),
					fc.integer(),
					fc.string(),
					fc.array(fc.integer()),
					jsonObjectArb,
					fc.date()
				),
				(value) => {
					const name = utils.type_name(value, [{"name": "Object"}]);
					// `undefined` is the only value whose type name may legitimately be "undefined".
					if (value === undefined) {
						return true;
					}
					return name !== "undefined";
				}
			),
			{numRuns: 1000, label: "type_name never returns 'undefined' for a defined value"}
		);
	});
});

// ===========================================================================
// 3. getValueTypeCheckResult internal consistency.
// ===========================================================================

describe("schema types: getValueTypeCheckResult consistency", () => {
	const schemaFor = (type) => new dynamoose.Schema({"id": type});

	it("isValidType must equal (matchedTypeDetailsIndexes.length > 0)", () => {
		const types = [String, Number, Boolean, Object, Array, Buffer, Date, dynamoose.type.ANY, dynamoose.type.NULL];
		runProperty(
			fc.property(
				fc.constantFrom(...types),
				fc.oneof(
					fc.constant(null),
					fc.constant(undefined),
					fc.boolean(),
					fc.integer(),
					fc.string(),
					fc.array(fc.integer()),
					jsonObjectArb,
					fc.date(),
					fc.constant(Buffer.from("x"))
				),
				(type, value) => {
					const schema = schemaFor(type);
					const r = utils.dynamoose.getValueTypeCheckResult(schema, value, "id", {"type": "toDynamo"}, {});
					return r.isValidType === (r.matchedTypeDetailsIndexes.length > 0);
				}
			),
			{numRuns: 800, label: "isValidType === (matchedTypeDetailsIndexes.length > 0)"}
		);
	});

	it("matchedTypeDetailsIndex must be the first matching index", () => {
		const types = [String, Number, Boolean, Object, Array, Buffer, Date, dynamoose.type.ANY, dynamoose.type.NULL];
		runProperty(
			fc.property(
				fc.constantFrom(...types),
				fc.oneof(
					fc.constant(null),
					fc.constant(undefined),
					fc.boolean(),
					fc.integer(),
					fc.string(),
					fc.array(fc.integer()),
					jsonObjectArb,
					fc.date(),
					fc.constant(Buffer.from("x"))
				),
				(type, value) => {
					const schema = schemaFor(type);
					const r = utils.dynamoose.getValueTypeCheckResult(schema, value, "id", {"type": "toDynamo"}, {});
					return r.matchedTypeDetailsIndex === r.matchedTypeDetailsIndexes[0];
				}
			),
			{numRuns: 800, label: "matchedTypeDetailsIndex === matchedTypeDetailsIndexes[0]"}
		);
	});
});

// ===========================================================================
// 4. Multi-type attributes: first matching type wins (documented).
// ===========================================================================

describe("schema types: multi-type attributes", () => {
	it("must pick the first matching type when several types match", () => {
		runProperty(
			fc.property(
				fc.constantFrom(
					[String, Number],
					[Number, String],
					[Object, dynamoose.type.ANY],
					[dynamoose.type.ANY, Object],
					[Number, Date],
					[Date, Number]
				),
				fc.oneof(fc.integer(), fc.string(), fc.date(), jsonObjectArb, fc.constant(null)),
				(types, value) => {
					const schema = new dynamoose.Schema({"id": {"type": types}});
					const r = utils.dynamoose.getValueTypeCheckResult(schema, value, "id", {"type": "toDynamo"}, {});
					if (r.matchedTypeDetailsIndexes.length === 0) {
						return true;
					}
					// docs: "if all types are valid, Dynamoose will default to the first type in the array"
					return r.matchedTypeDetailsIndex === r.matchedTypeDetailsIndexes[0];
				}
			),
			{numRuns: 800, label: "multi-type picks first matching type"}
		);
	});

	it("each type in a multi-type array must keep its own type settings (no leaking)", () => {
		// Reference model: the settings attached to a type entry apply to THAT entry only.
		// Schema.ts declares `typeSettings` outside the `.map()` callback and reassigns it inside,
		// so a settings-bearing entry leaks its settings onto later entries.
		const typeSettingsArb = fc.constantFrom(
			{"storage": "iso"},
			{"storage": "seconds"},
			{"storage": "milliseconds"}
		);
		runProperty(
			fc.property(typeSettingsArb, (settings) => {
				const schema = new dynamoose.Schema({"id": {"type": [{"value": Date, "settings": settings}, Date]}});
				const details = schema.getAttributeTypeDetails("id");
				// Entry 0 has the given settings; entry 1 (plain `Date`) must use the default
				// (milliseconds => DynamoDB type "N"), not inherit entry 0's settings.
				const expected = settings.storage === "iso" ? ["S", "N"] : ["N", "N"];
				return details.map((d) => d.dynamodbType).join(",") === expected.join(",");
			}),
			{numRuns: 200, label: "multi-type type settings do not leak between entries"}
		);
	});
});
