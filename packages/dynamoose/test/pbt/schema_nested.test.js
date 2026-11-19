// PBT: nested schemas (Object / Array sub-schemas).
//
// Contract sources:
//  - packages/dynamoose/lib/Schema.ts:440 ("Default values will only be applied if the parent object
//     exists. ... for values where you apply a `default` value to a nested attribute, it will only
//     be applied if the parent object exists.")
//  - packages/dynamoose/lib/Schema.ts:548 ("In the event the parent object is undefined and `required`
//     is set to `false` on that parent attribute, the required check will not be run on child
//     attributes.")
//  - packages/dynamoose/test/Item.js:474-508 (existing expectations for nested defaults)
//  - packages/dynamoose/test/Item.js:510 (existing expectation: nested required property must throw)
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
	const name = `PbtNested${modelCounter++}`;
	const User = dynamoose.model(name, new dynamoose.Schema(schemaDefinition));
	new dynamoose.Table(name, [User], {"create": false, "waitForActive": false});
	return User;
};

const stringValueArb = fc.string({minLength: 1, maxLength: 6});

describe("nested schemas", () => {
	it("a nested required attribute is rejected when the parent exists", async () => {
		await runAsyncProperty(
			fc.asyncProperty(stringValueArb, async (value) => {
				const User = makeModel({"id": Number, "o": {"type": Object, "schema": {"v": {"type": String, "required": true}}}});
				try {
					await new User({"id": 1, "o": {"other": value}}).toDynamo({"required": true});
					return false;
				} catch (e) {
					return e instanceof CustomError.ValidationError;
				}
			}),
			{numRuns: 100, label: "nested required rejected when parent present"}
		);
	});

	it("a nested required attribute is NOT rejected when the parent is missing (documented)", async () => {
		await runAsyncProperty(
			fc.asyncProperty(stringValueArb, async (value) => {
				const User = makeModel({"id": Number, "o": {"type": Object, "schema": {"v": {"type": String, "required": true}}}});
				await new User({"id": 1, "other": value}).toDynamo({"required": true});
				return true;
			}),
			{numRuns: 100, label: "nested required skipped when parent missing"}
		);
	});

	it("a nested default is applied when the parent exists", async () => {
		await runAsyncProperty(
			fc.asyncProperty(stringValueArb, async (value) => {
				const User = makeModel({"id": Number, "o": {"type": Object, "schema": {"v": {"type": String, "default": value}}}});
				const obj = await new User({"id": 1, "o": {"other": "x"}}).toDynamo({"defaults": true});
				return obj.o.M.v !== undefined && obj.o.M.v.S === value;
			}),
			{numRuns: 100, label: "nested default applied when parent present"}
		);
	});

	it("a nested default is NOT applied when the parent is missing (documented)", async () => {
		await runAsyncProperty(
			fc.asyncProperty(stringValueArb, async (value) => {
				const User = makeModel({"id": Number, "o": {"type": Object, "schema": {"v": {"type": String, "default": value}}}});
				const obj = await new User({"id": 1}).toDynamo({"defaults": true});
				return obj.o === undefined;
			}),
			{numRuns: 100, label: "nested default skipped when parent missing"}
		);
	});

	it("a nested required attribute inside an array element is rejected", async () => {
		await runAsyncProperty(
			fc.asyncProperty(stringValueArb, async (value) => {
				const User = makeModel({"id": Number, "arr": {"type": Array, "schema": [{"type": Object, "schema": {"v": {"type": String, "required": true}}}]}});
				try {
					await new User({"id": 1, "arr": [{"other": value}]}).toDynamo({"required": true});
					return false;
				} catch (e) {
					return e instanceof CustomError.ValidationError;
				}
			}),
			{numRuns: 100, label: "nested required inside array rejected"}
		);
	});

	it("a nested default inside an array element is applied", async () => {
		await runAsyncProperty(
			fc.asyncProperty(stringValueArb, async (value) => {
				const User = makeModel({"id": Number, "arr": {"type": Array, "schema": [{"type": Object, "schema": {"v": {"type": String, "default": value}}}]}});
				const obj = await new User({"id": 1, "arr": [{"other": "x"}]}).toDynamo({"defaults": true});
				return obj.arr.L !== undefined && obj.arr.L.length === 1 &&
					obj.arr.L[0].M.v !== undefined && obj.arr.L[0].M.v.S === value;
			}),
			{numRuns: 100, label: "nested default inside array applied"}
		);
	});

	it("a nested type mismatch is rejected", async () => {
		await runAsyncProperty(
			fc.asyncProperty(fc.integer(), async (value) => {
				const User = makeModel({"id": Number, "o": {"type": Object, "schema": {"v": {"type": String}}}});
				try {
					await new User({"id": 1, "o": {"v": value}}).toDynamo({});
					return false;
				} catch (e) {
					return e instanceof CustomError.TypeMismatch;
				}
			}),
			{numRuns: 100, label: "nested type mismatch rejected"}
		);
	});

	it("a nested enum is enforced", async () => {
		await runAsyncProperty(
			fc.asyncProperty(
				fc.uniqueArray(fc.string({minLength: 1}), {minLength: 1, maxLength: 4}),
				fc.string({minLength: 1}),
				async (enumValues, otherValue) => {
					if (enumValues.includes(otherValue)) {
						return true;
					}
					const User = makeModel({"id": Number, "o": {"type": Object, "schema": {"v": {"type": String, "enum": enumValues}}}});
					try {
						await new User({"id": 1, "o": {"v": otherValue}}).toDynamo({"enum": true});
						return false;
					} catch (e) {
						return e instanceof CustomError.ValidationError;
					}
				}
			),
			{numRuns: 100, label: "nested enum enforced"}
		);
	});

	it("nested attributes are listed by Schema.attributes()", async () => {
		await runAsyncProperty(
			fc.asyncProperty(stringValueArb, stringValueArb, async (a, b) => {
				const schema = new dynamoose.Schema({"id": Number, "o": {"type": Object, "schema": {"a": String, "b": {"type": Object, "schema": {"c": String}}}}});
				const attributes = schema.attributes();
				return attributes.includes("o") && attributes.includes("o.a") && attributes.includes("o.b") && attributes.includes("o.b.c");
			}),
			{numRuns: 100, label: "nested attributes listed"}
		);
	});
});
