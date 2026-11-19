// PBT: Schema default / required / enum validation.
//
// Contract sources:
//  - packages/dynamoose/lib/Schema.ts:438  ("You can set a default value for an attribute that will
//     be applied upon save if the given attribute value is `null` or `undefined`.")
//  - packages/dynamoose/lib/Schema.ts:1395 (`defaultCheck`: `typeof value === "undefined" || value === null`)
//  - packages/dynamoose/lib/Schema.ts:578  ("This property is not a replacement for `required`. If the
//     value is undefined or null, the enum will not be checked.")
//  - packages/dynamoose/lib/Schema.ts:1506 (`requiredCheck`: `typeof value === "undefined" || value === null`)
//  - packages/dynamoose/test/Item.js (existing expectations for defaults / required / enum)
const dynamoose = require("../../dist");
const CustomError = require("../../dist/Error").default;
const {fc, runProperty} = require("./_helpers");

/**
 * Async counterpart of the shared `runProperty` helper.
 * The shared helper calls `fc.assert` synchronously, which cannot observe the
 * result of an `fc.asyncProperty`; this awaits the assertion instead.
 */
const runAsyncProperty = async (property, options = {}) => {
	const {numRuns = 500, seed, label} = options;
	const params = {numRuns};
	if (seed !== undefined) {
		params.seed = seed;
	}
	await fc.assert(property, params);
	if (label) {
		// eslint-disable-next-line no-console
		console.log(`[pbt] ok: ${label} (${numRuns} runs)`);
	}
};

let modelCounter = 0;
const makeModel = (schemaDefinition) => {
	const name = `PbtUser${modelCounter++}`;
	const User = dynamoose.model(name, new dynamoose.Schema(schemaDefinition));
	new dynamoose.Table(name, [User], {"create": false, "waitForActive": false});
	return User;
};

// ---------------------------------------------------------------------------
// Generators / reference models
// ---------------------------------------------------------------------------

/**
 * A value together with the schema type that accepts it and the expected DynamoDB
 * representation of that value (used as the independent expectation).
 */
const typedValueArb = fc.oneof(
	fc.integer({min: -100000, max: 100000}).map((value) => ({"type": Number, "value": value, "ddb": {"N": String(value)}})),
	fc.string({maxLength: 8}).map((value) => ({"type": String, "value": value, "ddb": {"S": value}})),
	fc.boolean().map((value) => ({"type": Boolean, "value": value, "ddb": {"BOOL": value}}))
);

describe("schema defaults", () => {
	it("applies the default when the attribute is absent", async () => {
		await runAsyncProperty(
			fc.asyncProperty(typedValueArb, async ({type, value, ddb}) => {
				const User = makeModel({"id": Number, "v": {"type": type, "default": value}});
				const obj = await new User({"id": 1}).toDynamo({"defaults": true});
				return JSON.stringify(obj.v) === JSON.stringify(ddb);
			}),
			{numRuns: 150, label: "default applied when attribute absent"}
		);
	});

	it("does NOT apply the default when a (falsy but present) value is given", async () => {
		await runAsyncProperty(
			fc.asyncProperty(
				fc.oneof(
					fc.constant(0),
					fc.constant(""),
					fc.constant(false)
				).map((value) => ({"type": typeof value === "string" ? String : (typeof value === "number" ? Number : Boolean), "value": value})),
				async ({type, value}) => {
					const User = makeModel({"id": Number, "v": {"type": type, "default": type === Number ? 5 : (type === String ? "d" : true)}});
					const obj = await new User({"id": 1, "v": value}).toDynamo({"defaults": true});
					// The default must not have replaced the present value.
					const present = type === Number ? obj.v.N === "0" : (type === String ? obj.v.S === "" : obj.v.BOOL === false);
					return present;
				}
			),
			{numRuns: 60, label: "default not applied for present falsy values"}
		);
	});

	it("applies the default when the attribute value is null (documented behaviour)", async () => {
		// Schema.ts:438 — "will be applied upon save if the given attribute value is `null` or `undefined`"
		await runAsyncProperty(
			fc.asyncProperty(typedValueArb, async ({type, value, ddb}) => {
				const User = makeModel({"id": Number, "v": {"type": type, "default": value}});
				const obj = await new User({"id": 1, "v": null}).toDynamo({"defaults": true});
				return JSON.stringify(obj.v) === JSON.stringify(ddb);
			}),
			{numRuns: 150, label: "default applied when value is null"}
		);
	});

	it("applies the default exactly once per save", async () => {
		await runAsyncProperty(
			fc.asyncProperty(fc.integer({min: 0, max: 1000}), async () => {
				let calls = 0;
				const User = makeModel({"id": Number, "v": {"type": Number, "default": () => {
					calls++;
					return 5;
				}}});
				await new User({"id": 1}).toDynamo({"defaults": true});
				return calls === 1;
			}),
			{numRuns: 50, label: "default function called exactly once"}
		);
	});

	it("applies an array default", async () => {
		await runAsyncProperty(
			fc.asyncProperty(fc.array(fc.integer(), {maxLength: 3}), async (defaultValue) => {
				const User = makeModel({"id": Number, "v": {"type": Array, "default": defaultValue}});
				const obj = await new User({"id": 1}).toDynamo({"defaults": true});
				return obj.v !== undefined && obj.v.L !== undefined && obj.v.L.length === defaultValue.length;
			}),
			{numRuns: 100, label: "array default applied"}
		);
	});

	it("applies an array default that contains a null element", async () => {
		// The default value itself is present and well formed (null is a legal DynamoDB NULL),
		// so it must be applied. Item.ts:711 decides "is the default undefined?" with
		// `Array.isArray(defaultValue) ? defaultValue.some(...) : ...` — i.e. it asks whether
		// *any element* is null/undefined instead of whether the default value itself is.
		await runAsyncProperty(
			fc.asyncProperty(
				fc.array(fc.oneof(fc.integer(), fc.constant(null)), {minLength: 1, maxLength: 3}),
				async (defaultValue) => {
					const User = makeModel({"id": Number, "v": {"type": Array, "default": defaultValue}});
					const obj = await new User({"id": 1}).toDynamo({"defaults": true});
					return obj.v !== undefined && obj.v.L !== undefined && obj.v.L.length === defaultValue.length;
				}
			),
			{numRuns: 100, label: "array default containing null applied"}
		);
	});
});

describe("schema required", () => {
	it("rejects a missing required attribute", async () => {
		// The attribute name generator deliberately includes names that collide with
		// `Object.prototype` members (see schema_builtin_names.test.js) so this property
		// fails deterministically rather than only when the random generator happens to
		// produce such a name.
		const attributeNameArb = fc.oneof(
			fc.constantFrom("toString", "valueOf", "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"),
			fc.string({minLength: 1, maxLength: 8}).filter((name) => !name.includes("."))
		);
		await runAsyncProperty(
			fc.asyncProperty(attributeNameArb, async (name) => {
				const User = makeModel({"id": Number, [name]: {"type": String, "required": true}});
				try {
					await new User({"id": 1}).toDynamo({"required": true});
					return false;
				} catch (e) {
					return e instanceof CustomError.ValidationError && e.message.includes("required property");
				}
			}),
			{numRuns: 100, label: "required rejects missing attribute"}
		);
	});

	it("accepts a present required attribute (including falsy values)", async () => {
		await runAsyncProperty(
			fc.asyncProperty(
				fc.oneof(fc.constant(""), fc.constant(0), fc.constant(false)).map((value) => ({"type": typeof value === "string" ? String : (typeof value === "number" ? Number : Boolean), "value": value})),
				async ({type, value}) => {
					const User = makeModel({"id": Number, "v": {"type": type, "required": true}});
					await new User({"id": 1, "v": value}).toDynamo({"required": true});
					return true;
				}
			),
			{numRuns: 60, label: "required accepts present falsy value"}
		);
	});
});

describe("schema enum", () => {
	it("accepts every value listed in the enum", async () => {
		await runAsyncProperty(
			fc.asyncProperty(
				fc.uniqueArray(fc.oneof(fc.string({minLength: 1}), fc.integer()), {minLength: 1, maxLength: 6}),
				async (enumValues) => {
					const User = makeModel({"id": Number, "v": {"type": dynamoose.type.ANY, "enum": enumValues}});
					for (const value of enumValues) {
						try {
							await new User({"id": 1, "v": value}).toDynamo({"enum": true});
						} catch (e) {
							return false;
						}
					}
					return true;
				}
			),
			{numRuns: 100, label: "enum accepts every listed value"}
		);
	});

	it("rejects a value outside the enum", async () => {
		await runAsyncProperty(
			fc.asyncProperty(
				fc.uniqueArray(fc.string({minLength: 1}), {minLength: 1, maxLength: 4}),
				fc.string({minLength: 1}),
				async (enumValues, otherValue) => {
					if (enumValues.includes(otherValue)) {
						return true;
					}
					const User = makeModel({"id": Number, "v": {"type": String, "enum": enumValues}});
					try {
						await new User({"id": 1, "v": otherValue}).toDynamo({"enum": true});
						return false;
					} catch (e) {
						return e instanceof CustomError.ValidationError;
					}
				}
			),
			{numRuns: 100, label: "enum rejects value outside the list"}
		);
	});
});
