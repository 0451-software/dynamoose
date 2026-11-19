// Property-based discovery tests for
// `packages/dynamoose/lib/utils/dynamoose/convertConditionArrayRequestObjectToString.ts`.

const {fc} = require("./_helpers");
const {
	dynamoose,
	internalProperties,
	runAsyncProperty,
	parseExpression,
	canParseExpression
} = require("./condition_support.test.js");
const convertConditionArrayRequestObjectToString = require("../../dist/utils/dynamoose/convertConditionArrayRequestObjectToString");

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

const Model = dynamoose.model("PbtConvertCat", {
	"id": Number,
	"name": String,
	"age": Number
});
new dynamoose.Table("PbtConvertCat", [Model]);
const RealModel = Model.query().getInternalProperties(internalProperties).internalSettings.model;

const OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge", "beginsWith", "contains", "exists", "in", "between"];

const fcValue = fc.oneof(fc.integer(), fc.string({maxLength: 8}));

const fcSpec = fc.record({
	"attribute": fc.constantFrom("id", "name", "age"),
	"operator": fc.constantFrom(...OPERATORS),
	"join": fc.constantFrom("AND", "OR"),
	"group": fc.boolean(),
	"values": fc.array(fcValue, {minLength: 2, maxLength: 3})
});

const applySpec = (condition, spec) => {
	condition.where(spec.attribute);
	switch (spec.operator) {
	case "exists":
		condition.exists();
		break;
	case "in":
		condition.in(spec.values);
		break;
	case "between":
		condition.between(spec.values[0], spec.values[1]);
		break;
	default:
		condition[spec.operator](spec.values[0]);
	}
	return condition;
};

const buildCondition = (specs) => {
	const condition = new dynamoose.Condition();
	specs.forEach((spec, index) => {
		if (index > 0 && spec.join === "OR") {
			condition.or();
		}
		if (spec.group) {
			condition.parenthesis((inner) => applySpec(inner, spec));
		} else {
			applySpec(condition, spec);
		}
	});
	return condition;
};

const countConnectors = (expression) => {
	const matches = expression.match(/\b(AND|OR)\b/g) || [];
	return {"AND": matches.filter((item) => item === "AND").length, "OR": matches.filter((item) => item === "OR").length};
};

describe("pbt: convertConditionArrayRequestObjectToString", () => {
	it("preserves the logical structure of the array it is given", async () => {
		await runAsyncProperty(fc.asyncProperty(fc.array(fcSpec, {minLength: 1, maxLength: 6}), async (specs) => {
			const result = await buildCondition(specs).getInternalProperties(internalProperties).requestObject(RealModel, {"conditionString": "FilterExpression", "conditionStringType": "array"});
			const string = convertConditionArrayRequestObjectToString(result.FilterExpression);
			// The string form must be a valid DynamoDB expression ...
			expect({"expression": string, "isValid": canParseExpression(string)}).toEqual({
				"expression": expect.any(String),
				"isValid": true
			});
			// ... and it must contain the same number of AND/OR connectors as the
			// array form (a connector may never be silently dropped).
			const arrayConnectors = countConnectors(JSON.stringify(result.FilterExpression).replace(/"/g, ""));
			expect(countConnectors(string)).toEqual(arrayConnectors);
		}), {"numRuns": 200});
	});

	it("BUG: an empty parenthesised group must not produce `AND AND`", async () => {
		// `utils.object.clearEmpties` deletes the empty nested array from the
		// FilterExpression array (leaving a hole), so the group disappears but
		// the two "AND" connectors around it survive.
		const condition = new dynamoose.Condition()
			.where("name").eq(1)
			.parenthesis((inner) => inner)
			.where("id").eq(2);
		const result = await condition.getInternalProperties(internalProperties).requestObject(RealModel, {"conditionString": "FilterExpression", "conditionStringType": "array"});
		const string = convertConditionArrayRequestObjectToString(result.FilterExpression);
		expect({"expression": string, "isValid": canParseExpression(string)}).toEqual({
			"expression": expect.any(String),
			"isValid": true
		});
	});
});
