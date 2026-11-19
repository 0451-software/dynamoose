// PBT discovery: how the utility-layer bugs surface through the PUBLIC API.
//
// These tests exercise the documented public entry points (`dynamoose.Table`,
// `dynamoose.Table.defaults`, `model.Item#save`) to establish REACHABILITY for the
// utility-layer defects found in utils_merge_combine.test.js / utils_misc.test.js.
//
// `it.failing` blocks are expected-to-fail characterization tests.

const {fc, runProperty} = require("./_helpers");
const dynamoose = require("../../dist");
const utils = require("../../dist/utils").default;

const Internal = require("../../dist/Internal").default;
const ip = Internal.General.internalProperties;

const newModel = (name) => dynamoose.model(name, new dynamoose.Schema({"id": String}));

// Run `fn` with a clean Object.prototype; return the property names it added.
// The cleanup happens before returning, so callers must capture any polluted VALUE
// from inside the callback.
function withCleanPrototype (fn) {
	const before = Object.getOwnPropertyNames(Object.prototype);
	let added = [];
	try {
		fn();
	} finally {
		added = Object.getOwnPropertyNames(Object.prototype).filter((k) => !before.includes(k));
		for (const key of added) {
			delete Object.prototype[key];
		}
	}
	return added;
}

describe("public API reachability of the utility-layer defects", () => {
	describe("dynamoose.Table mutates and aliases the caller's options object", () => {
		it("characterization: new Table(...) writes defaults into the caller's options object", () => {
			const options = {"create": false};
			options.initialize = false;
			new dynamoose.Table("mutates-options", [newModel("MutatesOptions")], options);
			expect(Object.keys(options)).toContain("throughput");
			expect(Object.keys(options)).toContain("prefix");
		});

		it("characterization: the Table's stored options ARE the caller's options object", () => {
			const options = {};
			options.initialize = false;
			const table = new dynamoose.Table("aliases-options", [newModel("AliasesOptions")], options);
			expect(table.getInternalProperties(ip).options).toBe(options);
		});

		it.failing("new Table(...) must not mutate the caller's options object", () => {
			const options = {"create": false};
			const before = JSON.stringify(options);
			options.initialize = false;
			new dynamoose.Table("no-mutate-options", [newModel("NoMutateOptions")], options);
			expect(JSON.stringify(options)).toEqual(before);
		});

		it.failing("reusing an options object for a second Table must apply the current defaults", () => {
			dynamoose.Table.defaults.set({"prefix": "FIRST-"});
			const shared = {};
			shared.initialize = false;
			new dynamoose.Table("stale-a", [newModel("StaleA")], shared);
			dynamoose.Table.defaults.set({"prefix": "SECOND-"});
			const second = new dynamoose.Table("stale-b", [newModel("StaleB")], shared);
			expect(second.getInternalProperties(ip).options.prefix).toBe("SECOND-");
			dynamoose.Table.defaults.set({});
		});

		it("characterization: reusing an options object leaks the FIRST table's custom defaults", () => {
			dynamoose.Table.defaults.set({"prefix": "FIRST-"});
			const shared = {};
			shared.initialize = false;
			new dynamoose.Table("leak-a", [newModel("LeakA")], shared);
			dynamoose.Table.defaults.set({"prefix": "SECOND-"});
			const second = new dynamoose.Table("leak-b", [newModel("LeakB")], shared);
			expect(second.getInternalProperties(ip).options.prefix).toBe("FIRST-");
			dynamoose.Table.defaults.set({});
		});
	});

	describe("dynamoose.Table.defaults can pollute Object.prototype", () => {
		it("characterization: Table.defaults.set + new Table() pollutes Object.prototype", () => {
			const marker = "__pbt_table_pollution__";
			let observed;
			const added = withCleanPrototype(() => {
				dynamoose.Table.defaults.set(JSON.parse(`{"__proto__": {"${marker}": "PWNED"}}`));
				new dynamoose.Table("pollutes", [newModel("Pollutes")], {"initialize": false});
				observed = Object.prototype[marker];
			});
			dynamoose.Table.defaults.set({});
			expect(added).toContain(marker);
			expect(observed).toBe("PWNED");
		});

		it.failing("PBT: Table.defaults.set + new Table() must not pollute Object.prototype", () => {
			runProperty(
				fc.property(fc.string({minLength: 1, maxLength: 6}).filter((k) => k !== "__proto__" && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(k)), (prop) => {
					const added = withCleanPrototype(() => {
						dynamoose.Table.defaults.set(JSON.parse(`{"__proto__": {"${prop}": "PWNED"}}`));
						new dynamoose.Table(`pollutes-${prop}`, [newModel(`Pollutes${prop}`)], {"initialize": false});
					});
					dynamoose.Table.defaults.set({});
					expect(added).toEqual([]);
				}),
				{"numRuns": 50, "label": "Table.defaults no prototype pollution"}
			);
		});
	});

	describe("utils.type_name crash surfaces as an opaque error from Item#save", () => {
		// Attach the model to a Table with initialize:false so that Item#save (which
		// lazily creates a Table when the model has none) does not start a setup flow.
		const modelWithTable = (name) => {
			const model = dynamoose.model(name, new dynamoose.Schema({"id": String, "name": String}));
			new dynamoose.Table(name.toLowerCase(), [model], {"initialize": false});
			return model;
		};

		it("characterization: saving a value with a null constructor throws a raw TypeError", async () => {
			const model = modelWithTable("TypeNameCrash");
			let threw = null;
			try {
				await new model.Item({"id": "a", "name": {"constructor": null}}).save({"return": "request"});
			} catch (e) {
				threw = e;
			}
			expect(threw).not.toBeNull();
			expect(threw.constructor.name).toBe("TypeError");
			expect(threw.message).toBe("Cannot read properties of null (reading 'name')");
		});

		it("characterization: an ordinary type mismatch raises the clean CustomError", async () => {
			const model = modelWithTable("TypeNameClean");
			let threw = null;
			try {
				await new model.Item({"id": "a", "name": {"x": 1}}).save({"return": "request"});
			} catch (e) {
				threw = e;
			}
			expect(threw).not.toBeNull();
			expect(threw.message).toContain("Expected name to be of type string");
		});

		it.failing("PBT: Item#save must never fail with an opaque TypeError from type_name", async () => {
			const model = modelWithTable("TypeNamePbt");
			const values = fc.sample(fc.dictionary(fc.string({minLength: 1, maxLength: 4}), fc.jsonValue(), {maxKeys: 2}), 1)[0];
			const candidates = [values, {"constructor": null}, {"constructor": "x"}, {"constructor": 5}];
			for (const candidate of candidates) {
				let threw = null;
				try {
					await new model.Item({"id": "a", "name": candidate}).save({"return": "request"});
				} catch (e) {
					threw = e;
				}
				if (threw && threw.constructor === TypeError) {
					throw new Error(`Item#save threw TypeError: ${threw.message}`);
				}
			}
		});
	});

	describe("utils.dynamoose.index_changes mutates the schema's project array", () => {
		it("characterization: index_changes sorts the user's schema 'project' array in place", async () => {
			const project = ["zz", "aa"];
			const schema = new dynamoose.Schema({"id": String, "nm": {"type": String, "index": {"type": "global", "project": project}}});
			const model = dynamoose.model("IndexChangesMutates", schema);
			const table = new dynamoose.Table("icm", [model], {"initialize": false});
			const existing = [{
				"IndexName": "nmGlobalIndex",
				"KeySchema": [{"AttributeName": "nm", "KeyType": "HASH"}],
				"Projection": {"ProjectionType": "INCLUDE", "NonKeyAttributes": ["q"]},
				"ProvisionedThroughput": {"ReadCapacityUnits": 1, "WriteCapacityUnits": 1}
			}];
			await utils.dynamoose.index_changes(table, existing);
			expect(project).toEqual(["aa", "zz"]);
		});
	});
});
