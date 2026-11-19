// Property-based discovery tests for `packages/dynamoose/lib/Condition.ts`.
//
// These are DISCOVERY tests: they encode the contract that the existing
// `packages/dynamoose/test/Condition.js` suite implies, and they are expected
// to FAIL wherever a real bug exists. Confirmed failures are reported in the
// accompanying write-up; the failure messages below name the bug.

const {fc, runProperty} = require("./_helpers");
const {
	dynamoose,
	internalProperties,
	parseExpression,
	canParseExpression,
	treeToComparisonType,
	placeholderProblems
} = require("./condition_support.test.js");

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

const Model = dynamoose.model("PbtConditionCat", {
	"id": Number,
	"name": String,
	"age": Number,
	"color": String
});
new dynamoose.Table("PbtConditionCat", [Model]);
// The public `dynamoose.model()` returns a wrapper; the internal `Model`
// instance is the one the `Condition`/`ItemRetriever` code operates on.
const RealModel = Model.query().getInternalProperties(internalProperties).internalSettings.model;

const ATTRIBUTES = ["id", "name", "age", "color"];
const OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge", "beginsWith", "contains", "exists", "in", "between"];
// `not()` has no opposite for these (documented in the `not()` JSDoc table).
const NO_OPPOSITE = ["in", "between", "beginsWith"];

const fcValue = fc.oneof(fc.integer(), fc.string({maxLength: 8}), fc.boolean());

const fcSpec = fc.record({
	"attribute": fc.constantFrom(...ATTRIBUTES),
	"operator": fc.constantFrom(...OPERATORS),
	"not": fc.boolean(),
	"join": fc.constantFrom("AND", "OR"),
	"values": fc.array(fcValue, {minLength: 2, maxLength: 4})
});

const applySpec = (condition, spec) => {
	condition.where(spec.attribute);
	if (spec.not && !NO_OPPOSITE.includes(spec.operator)) {
		condition.not();
	}
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
		if (index > 0 && spec.explicitAnd) {
			condition.and();
		}
		applySpec(condition, spec);
	});
	return condition;
};

const requestObject = async (condition, settings) => condition.getInternalProperties(internalProperties).requestObject(RealModel, settings);

describe("pbt: Condition", () => {
	it("emits a syntactically valid DynamoDB expression with consistent placeholders", async () => {
		await runProperty(fc.asyncProperty(fc.array(fcSpec, {minLength: 1, maxLength: 6}), async (specs) => {
			const result = await requestObject(buildCondition(specs));
			const expression = result.ConditionExpression;
			expect(typeof expression).toBe("string");
			// Independent parser: throws when the expression is not valid DynamoDB.
			const parsed = parseExpression(expression);
			// Every referenced placeholder must exist, and nothing may be orphaned.
			expect(placeholderProblems({"ExpressionAttributeNames": result.ExpressionAttributeNames, "ExpressionAttributeValues": result.ExpressionAttributeValues, "ConditionExpression": expression})).toEqual([]);
			expect(parsed.names.length).toBeGreaterThan(0);
		}), {"numRuns": 200});
	});

	it("emits a valid expression for the array (FilterExpression) form too", async () => {
		await runProperty(fc.asyncProperty(fc.array(fcSpec, {minLength: 1, maxLength: 6}), async (specs) => {
			const result = await requestObject(buildCondition(specs), {"conditionString": "FilterExpression", "conditionStringType": "array"});
			expect(Array.isArray(result.FilterExpression)).toBe(true);
			expect(placeholderProblems({"ExpressionAttributeNames": result.ExpressionAttributeNames, "ExpressionAttributeValues": result.ExpressionAttributeValues, "FilterExpression": result.FilterExpression.join(" ").replace(/\(/g, "( ").replace(/\)/g, ")")})).toEqual([]);
		}), {"numRuns": 200});
	});

	it("uses one value placeholder per `in()` element and exactly two for `between()`", async () => {
		await runProperty(fc.asyncProperty(fc.array(fcValue, {minLength: 1, maxLength: 12}), async (values) => {
			const inResult = await requestObject(new dynamoose.Condition("name").in(values));
			const inParsed = parseExpression(inResult.ConditionExpression);
			expect(inParsed.values.length).toBe(values.length);
			expect(inParsed.tree.kind).toBe("in");
			expect(inParsed.tree.items.length).toBe(values.length);
			expect(Object.keys(inResult.ExpressionAttributeValues).length).toBe(values.length);

			const betweenResult = await requestObject(new dynamoose.Condition("age").between(1, 2));
			const betweenParsed = parseExpression(betweenResult.ConditionExpression);
			expect(betweenParsed.values.length).toBe(2);
			expect(betweenParsed.tree.kind).toBe("between");
			expect(Object.keys(betweenResult.ExpressionAttributeValues).length).toBe(2);
		}), {"numRuns": 150});
	});

	it("not() produces the opposite comparison type, and throws for in/between/beginsWith", async () => {
		const OPPOSITE = {"EQ": "NE", "NE": "EQ", "LT": "GE", "GE": "LT", "LE": "GT", "GT": "LE", "CONTAINS": "NOT_CONTAINS", "NOT_CONTAINS": "CONTAINS", "EXISTS": "NOT_EXISTS", "NOT_EXISTS": "EXISTS"};

		await runProperty(fc.asyncProperty(fc.constantFrom(...OPERATORS), async (operator) => {
			const condition = new dynamoose.Condition("name");
			condition.not();
			let error = null;
			try {
				switch (operator) {
				case "exists":
					condition.exists();
					break;
				case "in":
					condition.in([1, 2]);
					break;
				case "between":
					condition.between(1, 2);
					break;
				default:
					condition[operator]("x");
				}
			} catch (e) {
				error = e;
			}

			if (NO_OPPOSITE.includes(operator)) {
				// Documented in the `not()` JSDoc: these have no opposite and must throw.
				expect(error).not.toBe(null);
				expect(error.message).toBe(`${operator === "in" ? "IN" : operator === "between" ? "BETWEEN" : "BEGINS_WITH"} can not follow not()`);
				return;
			}

			expect(error).toBe(null);
			const chart = await condition.getInternalProperties(internalProperties).comparisonChart(RealModel);
			const plain = new dynamoose.Condition("name");
			switch (operator) {
			case "exists":
				plain.exists();
				break;
			default:
				plain[operator]("x");
			}
			const plainChart = await plain.getInternalProperties(internalProperties).comparisonChart(RealModel);
			expect(chart.name.type).toBe(OPPOSITE[plainChart.name.type]);
		}), {"numRuns": 100});
	});

	it("keeps comparisonChart in sync with the comparison actually emitted", async () => {
		await runProperty(fc.asyncProperty(fcSpec, async (spec) => {
			const condition = new dynamoose.Condition();
			applySpec(condition, spec);
			const result = await requestObject(condition);
			const parsed = parseExpression(result.ConditionExpression);
			const chart = await condition.getInternalProperties(internalProperties).comparisonChart(RealModel);
			expect(chart[spec.attribute].type).toBe(treeToComparisonType(parsed.tree));
		}), {"numRuns": 300});
	});

	it("treats `and()` as a no-op and `or()` as an OR join", async () => {
		await runProperty(fc.asyncProperty(fcSpec, fcSpec, async (first, second) => {
			const withoutAnd = await requestObject(buildCondition([{...first, "join": "AND"}, {...second, "join": "AND"}]));
			const withAnd = await requestObject(buildCondition([{...first, "join": "AND"}, {...second, "join": "AND", "explicitAnd": true}]));
			expect(withAnd.ConditionExpression).toBe(withoutAnd.ConditionExpression);

			const withOr = await requestObject(buildCondition([{...first, "join": "OR"}, {...second, "join": "OR"}]));
			const parsed = parseExpression(withOr.ConditionExpression);
			expect(parsed.tree.kind).toBe("or");
		}), {"numRuns": 150});
	});

	it("BUG: `in([])` must not emit the invalid expression `#a0 IN ()`", async () => {
		const emptyIn = await requestObject(new dynamoose.Condition("name").in([]));
		expect({"expression": emptyIn.ConditionExpression, "isValidDynamoExpression": canParseExpression(emptyIn.ConditionExpression)}).toEqual({
			"expression": expect.any(String),
			"isValidDynamoExpression": true
		});
	});

	it("BUG: `between()` with a single argument must not leave a dangling value reference", async () => {
		// `between(1)` currently produces "#a0 BETWEEN :v0_1 AND :v0_2" while
		// ":v0_2" is undefined in ExpressionAttributeValues -> dangling reference.
		const shortBetween = await requestObject(new dynamoose.Condition("age").between(1));
		expect(placeholderProblems({
			"ExpressionAttributeNames": shortBetween.ExpressionAttributeNames,
			"ExpressionAttributeValues": shortBetween.ExpressionAttributeValues,
			"ConditionExpression": shortBetween.ConditionExpression
		})).toEqual([]);
	});

	it("BUG: `comparisonChart` must be keyed by attribute name, not by array index", async () => {
		// `comparisonChart` reduces over `settings.conditions` and does not
		// recurse into nested condition groups, so a group is indexed by its
		// position in the conditions array ("0", "1", ...) instead of by the
		// attribute it constrains.
		const condition = new dynamoose.Condition().parenthesis((inner) => inner.where("id").eq(1));
		const chart = await condition.getInternalProperties(internalProperties).comparisonChart(RealModel);
		expect({"chart": chart, "keys": Object.keys(chart)}).toEqual({
			"chart": expect.any(Object),
			"keys": ["id"]
		});
	});

	it("wraps a parenthesised group in parentheses", async () => {
		await runProperty(fc.asyncProperty(fcSpec, async (spec) => {
			const result = await requestObject(new dynamoose.Condition().parenthesis((condition) => applySpec(condition, spec)));
			const parsed = parseExpression(result.ConditionExpression);
			expect(parsed.tree.kind).toBe("group");
			expect(result.ConditionExpression.startsWith("(")).toBe(true);
			expect(result.ConditionExpression.endsWith(")")).toBe(true);
		}), {"numRuns": 150});
	});
});
