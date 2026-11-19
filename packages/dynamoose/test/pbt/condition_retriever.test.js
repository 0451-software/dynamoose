// Property-based discovery tests for `packages/dynamoose/lib/ItemRetriever.ts`
// (`Scan`/`Query` request building, `moveParameterNames`) and for
// `packages/dynamoose/lib/utils/find_best_index.ts`.
//
// These are DISCOVERY tests: they encode the contract that the existing
// `packages/dynamoose/test/Query.js` / `Scan.js` suites imply. Confirmed
// failures are listed in the accompanying write-up.

const {fc} = require("./_helpers");
const {
	dynamoose,
	internalProperties,
	runAsyncProperty,
	parseExpression,
	canParseExpression,
	placeholderProblems
} = require("./condition_support.test.js");
const utils = require("../../dist/utils").default;

dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

const Model = dynamoose.model("PbtRetrieverCat", {
	"id": Number,
	"name": {"type": String, "index": {"type": "global"}},
	"age": Number,
	"color": String
});
new dynamoose.Table("PbtRetrieverCat", [Model]);

const OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge", "beginsWith", "contains", "exists", "in", "between"];

const fcValue = fc.oneof(fc.integer(), fc.string({maxLength: 8}));

const fcSpec = fc.record({
	"attribute": fc.constantFrom("name", "age", "color"),
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

/**
 * Builds a query. The first condition is always an equality on the table hash
 * key so that `find_best_index` can resolve an index (a query without a hash
 * key constraint legitimately fails with "Index can't be found for query.").
 */
const buildQuery = (specs, options = {}) => {
	const query = Model.query();
	query.where("id").eq(1);
	specs.forEach((spec, index) => {
		if (index > 0 && spec.join === "OR" && !options.noOr) {
			query.or();
		}
		if (spec.group) {
			query.parenthesis((condition) => applySpec(condition, spec));
		} else {
			applySpec(query, spec);
		}
	});
	return query;
};

const getRequest = async (query) => query.getRequest();

describe("pbt: ItemRetriever", () => {
	it("never emits an expression that references an undefined placeholder", async () => {
		await runAsyncProperty(fc.asyncProperty(fc.array(fcSpec, {minLength: 1, maxLength: 8}), async (specs) => {
			const request = await getRequest(buildQuery(specs, {"noOr": true}));
			expect(placeholderProblems(request)).toEqual([]);
		}), {"numRuns": 200});
	});

	it("never emits a syntactically invalid FilterExpression / KeyConditionExpression", async () => {
		await runAsyncProperty(fc.asyncProperty(fc.array(fcSpec, {minLength: 1, maxLength: 8}), async (specs) => {
			const request = await getRequest(buildQuery(specs, {"noOr": true}));
			["FilterExpression", "KeyConditionExpression"].forEach((key) => {
				if (typeof request[key] === "string") {
					expect({key, "expression": request[key], "isValid": canParseExpression(request[key])}).toEqual({
						"key": key,
						"expression": expect.any(String),
						"isValid": true
					});
				}
			});
		}), {"numRuns": 200});
	});

	it("BUG: the `#a1` / `:v1` placeholders must not be corrupted by `#a10` / `:v10` (property)", async () => {
		// Property version: the number of additional conditions is shrunk by
		// fast-check. The minimum number of conditions that triggers the
		// corruption is 11 (condition indices 0..10 - the hash key condition is
		// index 1 inside the group and index 10 produces the "#a10" placeholder
		// that "#a1" is a prefix of).
		await runAsyncProperty(fc.asyncProperty(fc.integer({min: 0, max: 15}), async (extra) => {
			const query = Model.query()
				.where("age").eq(1)
				.parenthesis((condition) => condition.where("id").eq(1));
			for (let i = 0; i < extra; i++) {
				query.where("color").eq(i);
			}
			let request = null;
			let error = null;
			try {
				request = await getRequest(query.using("someIndex"));
			} catch (e) {
				error = e;
			}
			expect({
				"extraConditions": extra,
				"error": error && error.message,
				"problems": request ? placeholderProblems(request) : ["threw"],
				"KeyConditionExpression": request && request.KeyConditionExpression
			}).toEqual({
				"extraConditions": extra,
				"error": null,
				"problems": [],
				"KeyConditionExpression": "#qha = :qhv"
			});
		}), {"numRuns": 50});
	});

	it("BUG: the `#a1` / `:v1` placeholders must not be corrupted by `#a10` / `:v10`", async () => {
		// `moveParameterNames` locates the condition belonging to the index hash
		// key with `FilterExpression.findIndex((item) => item.includes(key))`.
		// "#a1" is a *prefix* of "#a10", and ":v1" is a prefix of ":v10", so a
		// hash key condition that lives inside a parenthesised group is matched
		// against the wrong condition and the key condition ends up referencing
		// "#qha0" / ":qhv0", which do not exist.
		const query = Model.query()
			.where("age").eq(1)
			.parenthesis((condition) => condition.where("id").eq(1));
		["color", "name", "age", "color", "name", "age", "color", "name", "age"].forEach((attribute) => {
			query.where(attribute).eq(1);
		});
		const request = await getRequest(query.using("someIndex"));
		expect({
			"problems": placeholderProblems(request),
			"KeyConditionExpression": request.KeyConditionExpression
		}).toEqual({
			"problems": [],
			"KeyConditionExpression": "#qha = :qhv"
		});
	});

	it("BUG: a hash key inside a parenthesised group must not crash `moveParameterNames`", async () => {
		// The condition of the index hash key lives inside a group, so its entry
		// in `FilterExpression` is a nested array. `findIndex((item) =>
		// item.includes(key))` therefore never matches it, `findIndex` returns
		// -1 and `moveParameterNames` dereferences `undefined`.
		const query = Model.query().parenthesis((condition) => condition.where("id").eq(1));
		let error = null;
		try {
			await getRequest(query.using("someIndex"));
		} catch (e) {
			error = e;
		}
		expect({"error": error && error.message}).toEqual({"error": null});
	});

	it("BUG: a top level `or()` must not crash `comparisonChart`", async () => {
		const query = Model.query("id").eq(1).or().where("age").eq(2);
		let error = null;
		let request = null;
		try {
			request = await getRequest(query);
		} catch (e) {
			error = e;
		}
		expect({"error": error && error.message, "KeyConditionExpression": request && request.KeyConditionExpression}).toEqual({
			"error": null,
			"KeyConditionExpression": expect.any(String)
		});
	});

	it("BUG: a top level `or()` must not leave a dangling OR in the FilterExpression", async () => {
		// `moveParameterNames` removes the connector that precedes the condition
		// it moves into the KeyConditionExpression, but only when that connector
		// is "AND" (ItemRetriever.ts:216). With "OR" the connector is left behind
		// and the FilterExpression starts with a dangling `OR`.
		const query = Model.query("name").eq("a").or().where("age").eq(1);
		const request = await getRequest(query.using("nameGlobalIndex"));
		expect({"FilterExpression": request.FilterExpression, "isValid": canParseExpression(request.FilterExpression)}).toEqual({
			"FilterExpression": expect.any(String),
			"isValid": true
		});
	});

	it("BUG: a hash key inside a parenthesised group must still be found", async () => {
		// `comparisonChart` does not recurse into nested condition groups, so the
		// hash key is invisible to `find_best_index` and the query fails with
		// "Index can't be found for query." even though the hash key *is*
		// constrained with an equality comparison.
		const query = Model.query().parenthesis((condition) => condition.where("id").eq(1));
		let error = null;
		try {
			await getRequest(query);
		} catch (e) {
			error = e;
		}
		expect({"error": error && error.message}).toEqual({"error": null});
	});

	it("BUG: an equality on the hash key must be enough to find an index", async () => {
		// `comparisonChart` keeps only the *last* comparison type per attribute,
		// so `id = 1 AND id > 2` makes the hash key look like it is only
		// constrained with ">" and no index is found.
		let error = null;
		let request = null;
		try {
			request = await getRequest(Model.query("id").eq(1).where("id").gt(2));
		} catch (e) {
			error = e;
		}
		expect({"error": error && error.message, "KeyConditionExpression": request && request.KeyConditionExpression}).toEqual({
			"error": null,
			"KeyConditionExpression": expect.any(String)
		});
	});

	it("BUG: the index hash key must be compared with `=` inside the KeyConditionExpression", async () => {
		// DynamoDB only allows `=` on the partition key of a key condition.
		const request = await getRequest(Model.query("age").eq(1).where("id").gt(2).where("id").eq(3));
		const parsed = parseExpression(request.KeyConditionExpression);
		expect({"kind": parsed.tree.kind, "operator": parsed.tree.operator}).toEqual({"kind": "compare", "operator": "="});
	});

	it("BUG: the index range key must only use operators DynamoDB allows in a key condition", async () => {
		// DynamoDB allows =, <, <=, >, >=, BETWEEN and begins_with on the sort key
		// of a key condition. `<>` (not().eq()) and IN are not allowed.
		const rangeModel = dynamoose.model("PbtRetrieverRangeCat", {
			"id": Number,
			"sk": {"type": Number, "rangeKey": true}
		});
		new dynamoose.Table("PbtRetrieverRangeCat", [rangeModel]);
		const inRequest = await rangeModel.query("id").eq(1).where("sk").in([1, 2]).getRequest();
		expect({"KeyConditionExpression": inRequest.KeyConditionExpression, "containsDisallowedOperator": /(<>|IN)/.test(inRequest.KeyConditionExpression)}).toEqual({
			"KeyConditionExpression": expect.any(String),
			"containsDisallowedOperator": false
		});
	});

	it("BUG: `not().exists()` on the index range key must not be moved into the KeyConditionExpression", async () => {
		// `moveParameterNames` keeps a condition in the FilterExpression when the
		// expression contains "attribute_exists" or "contains". The check is a
		// substring match, so "attribute_not_exists" (produced by not().exists())
		// is NOT matched and the condition is moved into the KeyConditionExpression
		// where DynamoDB does not allow it.
		const rangeModel = dynamoose.model("PbtRetrieverRangeCat2", {
			"id": Number,
			"sk": {"type": Number, "rangeKey": true}
		});
		new dynamoose.Table("PbtRetrieverRangeCat2", [rangeModel]);
		const request = await rangeModel.query("id").eq(1).where("sk").not().exists().getRequest();
		expect({"KeyConditionExpression": request.KeyConditionExpression, "FilterExpression": request.FilterExpression}).toEqual({
			"KeyConditionExpression": "#qha = :qhv",
			"FilterExpression": "attribute_not_exists (#a1)"
		});
	});

	it("holds: `not().contains()` on the index range key stays in the FilterExpression", async () => {
		const rangeModel = dynamoose.model("PbtRetrieverRangeCat3", {
			"id": Number,
			"sk": {"type": Number, "rangeKey": true}
		});
		new dynamoose.Table("PbtRetrieverRangeCat3", [rangeModel]);
		const request = await rangeModel.query("id").eq(1).where("sk").not().contains(2).getRequest();
		expect({"KeyConditionExpression": request.KeyConditionExpression, "FilterExpression": request.FilterExpression}).toEqual({
			"KeyConditionExpression": "#qha = :qhv",
			"FilterExpression": "NOT contains (#a1, :v1)"
		});
	});
});

describe("pbt: utils.find_best_index", () => {
	const fcIndex = fc.record({
		"hash": fc.constantFrom("a", "b", "c"),
		"range": fc.constantFrom("r1", "r2"),
		"name": fc.constantFrom("IndexA", "IndexB")
	});

	const fcIndexes = fc.record({
		"table": fcIndex,
		"global": fc.array(fcIndex, {minLength: 0, maxLength: 3})
	});

	const toModelIndexes = (spec) => ({
		"TableIndex": {"KeySchema": [{"AttributeName": spec.table.hash, "KeyType": "HASH"}, {"AttributeName": spec.table.range, "KeyType": "RANGE"}]},
		"GlobalSecondaryIndexes": spec.global.map((index) => ({
			"IndexName": index.name,
			"KeySchema": [{"AttributeName": index.hash, "KeyType": "HASH"}, {"AttributeName": index.range, "KeyType": "RANGE"}]
		}))
	});

	const fcChart = fc.dictionary(fc.constantFrom("a", "b", "c", "r1", "r2"), fc.constantFrom("EQ", "NE", "LT", "GT"), {maxKeys: 5});

	it("only ever picks an index whose hash key is constrained with EQ", async () => {
		await runAsyncProperty(fc.asyncProperty(fcIndexes, fcChart, async (indexSpec, chart) => {
			const indexes = toModelIndexes(indexSpec);
			const result = utils.find_best_index(indexes, chart);
			if (result.indexName) {
				const chosen = indexes.GlobalSecondaryIndexes.find((index) => index.IndexName === result.indexName);
				expect(chart[chosen.KeySchema[0].AttributeName]).toEqual({"type": "EQ"});
			} else {
				expect(result.tableIndex).toBe(false);
			}
		}), {"numRuns": 300});
	});

	it("returns `{tableIndex: false, indexName: null}` when no index qualifies", async () => {
		await runAsyncProperty(fc.asyncProperty(fcIndexes, fc.dictionary(fc.string({minLength: 1, maxLength: 4}), fc.constantFrom("NE", "LT", "GT", "GE", "LE"), {maxKeys: 5}), async (indexSpec, chart) => {
			const indexes = toModelIndexes(indexSpec);
			const result = utils.find_best_index(indexes, chart);
			if (result.indexName === null) {
				expect(result).toEqual({"tableIndex": false, "indexName": null});
			} else {
				const chosen = [...indexes.GlobalSecondaryIndexes, indexes.TableIndex].find((index) => index.IndexName === result.indexName || (!result.tableIndex && index === indexes.TableIndex));
				expect(chart[chosen.KeySchema[0].AttributeName]?.type).toBe("EQ");
			}
		}), {"numRuns": 200});
	});

	it("is deterministic", async () => {
		await runAsyncProperty(fc.asyncProperty(fcIndexes, fcChart, async (indexSpec, chart) => {
			const first = utils.find_best_index(toModelIndexes(indexSpec), chart);
			const second = utils.find_best_index(toModelIndexes(indexSpec), chart);
			expect(first).toEqual(second);
		}), {"numRuns": 200});
	});

	it("BUG: `find_best_index` mutates the caller's index objects", async () => {
		const indexes = {
			"TableIndex": {"KeySchema": [{"AttributeName": "tableHashKey", "KeyType": "HASH"}]},
			"GlobalSecondaryIndexes": [
				{"IndexName": "MyGSI1", "KeySchema": [{"AttributeName": "attr1", "KeyType": "HASH"}]}
			]
		};
		const before = JSON.parse(JSON.stringify(indexes));
		utils.find_best_index(indexes, {"attr1": {"type": "EQ"}});
		expect(indexes).toEqual(before);
	});
});
