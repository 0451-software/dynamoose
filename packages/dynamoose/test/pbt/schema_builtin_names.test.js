// PBT: attributes whose names collide with `Object.prototype` members.
//
// Root cause: `utils.object.get(item, key)` (js-object-utilities) performs a plain property
// lookup, so for a path segment such as "toString" it returns the *inherited*
// `Object.prototype.toString` when the item has no own property with that name.
// Dynamoose reads attribute values with `utils.object.get` in Item.objectFromSchema, so for
// those attribute names the "value" is the prototype member instead of `undefined`.
//
// Contract sources:
//  - packages/dynamoose/lib/Schema.ts:1504 ("throw an error if the property is required and the
//     value is undefined or null")
//  - packages/dynamoose/lib/Schema.ts:438  (the default is applied when the value is absent)
//  - packages/dynamoose/lib/Schema.ts:578  ("If the value is undefined or null, the enum will not
//     be checked.")
const dynamoose = require("../../dist");
const CustomError = require("../../dist/Error").default;
const {fc} = require("./_helpers");

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
	const name = `PbtBuiltin${modelCounter++}`;
	const User = dynamoose.model(name, new dynamoose.Schema(schemaDefinition));
	new dynamoose.Table(name, [User], {"create": false, "waitForActive": false});
	return User;
};

/** Attribute names that exist on `Object.prototype`. */
const prototypeMemberNames = [
	"toString",
	"valueOf",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString"
];

const attributeNameArb = fc.oneof(
	fc.constantFrom(...prototypeMemberNames),
	fc.string({minLength: 1, maxLength: 8}).filter((name) => !name.includes(".") && !prototypeMemberNames.includes(name))
);

/**
 * Same as `attributeNameArb` but without "constructor": the AWS SDK marshaller
 * (`@aws-sdk/util-dynamodb`) refuses to marshall any object that has an own
 * "constructor" property, so a *successful* save is impossible for that name.
 * That is an upstream limitation, separate from the Schema layer.
 */
const attributeNameWithoutConstructorArb = fc.oneof(
	fc.constantFrom(...prototypeMemberNames.filter((name) => name !== "constructor")),
	fc.string({minLength: 1, maxLength: 8}).filter((name) => !name.includes(".") && !prototypeMemberNames.includes(name))
);

describe("schema attributes named after Object.prototype members", () => {
	it("a required attribute must still be rejected when it is missing", async () => {
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
			{numRuns: 100, label: "required is enforced for every attribute name"}
		);
	});

	it("the default must still be applied when the attribute is missing", async () => {
		await runAsyncProperty(
			fc.asyncProperty(attributeNameArb, async (name) => {
				const User = makeModel({"id": Number, [name]: {"type": String, "default": "D"}});
				const obj = await new User({"id": 1}).toDynamo({"defaults": true});
				return obj[name] !== undefined && obj[name].S === "D";
			}),
			{numRuns: 100, label: "default is applied for every attribute name"}
		);
	});

	it("the enum must not be checked when the attribute is missing", async () => {
		await runAsyncProperty(
			fc.asyncProperty(attributeNameArb, async (name) => {
				const User = makeModel({"id": Number, [name]: {"type": String, "enum": ["a"]}});
				try {
					await new User({"id": 1}).toDynamo({"enum": true});
					return true;
				} catch (e) {
					// Schema.ts:578 — "If the value is undefined or null, the enum will not be checked."
					return false;
				}
			}),
			{numRuns: 100, label: "enum is skipped for a missing attribute"}
		);
	});

	it("the validator must receive the attribute value when it is present", async () => {
		await runAsyncProperty(
			fc.asyncProperty(
				attributeNameWithoutConstructorArb,
				fc.constantFrom("x", "y", "zz"),
				async (name, value) => {
					let seen = "NOT CALLED";
					const User = makeModel({"id": Number, [name]: {"type": String, "validate": (v) => {
						seen = v;
						return true;
					}}});
					await new User({"id": 1, [name]: value}).toDynamo({"validate": true});
					return seen === value;
				}
			),
			{numRuns: 100, label: "validator receives the attribute value"}
		);
	});

	it("the validator must not run when the attribute is absent", async () => {
		await runAsyncProperty(
			fc.asyncProperty(attributeNameArb, async (name) => {
				let called = false;
				const User = makeModel({"id": Number, [name]: {"type": String, "validate": () => {
					called = true;
					return true;
				}}});
				await new User({"id": 1}).toDynamo({"validate": true});
				return called === false;
			}),
			{numRuns: 100, label: "validator skipped for a missing attribute"}
		);
	});

	it("saving an item with such an attribute name must not raise an unhandled TypeError", async () => {
		// With the settings `Model.create` / `Item.save` use (customTypesDynamo: true) the
		// prototype member read as the attribute value reaches
		// `const {customType} = typeDetails;` (Item.ts:732) with `typeDetails === undefined`
		// and Dynamoose crashes with a raw TypeError instead of a Dynamoose error.
		const createSettings = {"defaults": true, "validate": true, "required": true, "enum": true, "forceDefault": true, "combine": true, "saveUnknown": true, "customTypesDynamo": true, "updateTimestamps": true, "modifiers": ["set"], "mapAttributes": true};
		await runAsyncProperty(
			fc.asyncProperty(attributeNameArb, async (name) => {
				const User = makeModel({"id": Number, [name]: {"type": String, "required": true}});
				try {
					await new User({"id": 1}).toDynamo(createSettings);
					return true;
				} catch (e) {
					// A Dynamoose ValidationError is fine; a raw TypeError is not.
					return e instanceof CustomError.ValidationError;
				}
			}),
			{numRuns: 100, label: "no unhandled TypeError for prototype-named attributes"}
		);
	});
});
