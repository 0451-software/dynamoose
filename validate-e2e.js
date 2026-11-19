// End-to-end validation of the Condition/Query findings against a real DynamoDB
// server implementation (dynalite). This settles "would DynamoDB reject this?"
// by asking a server, instead of by reading the grammar.
//
// CAVEAT: dynalite is a pure-JS reimplementation. It is not AWS. A rejection here
// is strong evidence the request is invalid; an acceptance is weaker evidence
// that AWS would accept it.

const dynamoose = require("/workspace/source/dynamoose/packages/dynamoose/dist");
const {DynamoDBClient, CreateTableCommand, DeleteTableCommand} = require("/workspace/source/dynamoose/node_modules/@aws-sdk/client-dynamodb");

const ENDPOINT = "http://localhost:8002";
const raw = new DynamoDBClient({
	endpoint: ENDPOINT,
	region: "us-east-1",
	credentials: {accessKeyId: "fake", secretAccessKey: "fake"}
});

dynamoose.aws.ddb.local(ENDPOINT);
dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

const TABLE = "ValidateTable";
const Model = dynamoose.model(TABLE, {
	"id": {"type": String, "hashKey": true},
	"sk": {"type": String, "rangeKey": true},
	"age": Number,
	"name": String
});

// Send a built request straight at the server and report the verdict.
const send = async (label, operation, request) => {
	try {
		const res = await raw.send(operation === "query" ? new (require("/workspace/source/dynamoose/node_modules/@aws-sdk/client-dynamodb").QueryCommand)(request) : new (require("/workspace/source/dynamoose/node_modules/@aws-sdk/client-dynamodb").ScanCommand)(request));
		console.log(`${label.padEnd(46)} SERVER ACCEPTED (${(res.Count ?? 0)} items)`);
		return "accepted";
	} catch (e) {
		const msg = String(e.message || e).replace(/\s+/gu, " ").slice(0, 130);
		console.log(`${label.padEnd(46)} SERVER REJECTED: ${e.name}: ${msg}`);
		return "rejected";
	}
};

(async () => {
	try { await raw.send(new DeleteTableCommand({TableName: TABLE})); } catch (e) { /* ignore */ }
	await raw.send(new CreateTableCommand({
		"TableName": TABLE,
		"AttributeDefinitions": [
			{"AttributeName": "id", "AttributeType": "S"},
			{"AttributeName": "sk", "AttributeType": "S"}
		],
		"KeySchema": [
			{"AttributeName": "id", "KeyType": "HASH"},
			{"AttributeName": "sk", "KeyType": "RANGE"}
		],
		"BillingMode": "PAY_PER_REQUEST"
	}));
	console.log("table created\n");

	const results = {};

	// ---- F9: in([]) -> "#a0 IN ()"
	try {
		const req = await Model.scan("name").in([]).getRequest();
		console.log("F9  built expression:", JSON.stringify(req.FilterExpression));
		results.F9 = await send("F9  scan with IN ()", "scan", req);
	} catch (e) { console.log("F9  client threw:", e.message); results.F9 = "client-threw"; }

	// ---- F10: between(1) -> ":v0_2" undefined
	try {
		const req = await Model.scan("name").between(1).getRequest();
		console.log("F10 built expression:", JSON.stringify(req.FilterExpression));
		results.F10 = await send("F10 scan with BETWEEN one bound", "scan", req);
	} catch (e) { console.log("F10 client threw:", e.message); results.F10 = "client-threw"; }

	// ---- F12: range-key operators in KeyConditionExpression
	const rangeCases = [
		["F12a in() on sort key", (q) => q.where("sk").in(["a", "b"])],
		["F12b not().eq() (<>) on sort key", (q) => q.where("sk").not().eq("a")],
		["F12c not().exists() on sort key", (q) => q.where("sk").not().exists()]
	];
	for (const [label, apply] of rangeCases) {
		try {
			const q = Model.query("id").eq("x");
			apply(q);
			const req = await q.getRequest();
			console.log(`\n${label} KCE:`, JSON.stringify(req.KeyConditionExpression));
			results[label] = await send(label, "query", req);
		} catch (e) { console.log(`${label} client threw:`, e.message); results[label] = "client-threw"; }
	}

	// ---- controls: operators DynamoDB DOES allow on the sort key
	for (const [label, apply] of [
		["ctrl eq on sort key", (q) => q.where("sk").eq("a")],
		["ctrl beginsWith on sort key", (q) => q.where("sk").beginsWith("a")],
		["ctrl between on sort key", (q) => q.where("sk").between("a", "b")]
	]) {
		try {
			const q = Model.query("id").eq("x");
			apply(q);
			const req = await q.getRequest();
			results[label] = await send(label, "query", req);
		} catch (e) { console.log(`${label} client threw:`, e.message); results[label] = "client-threw"; }
	}

	// ---- F13: non-equality on the partition key
	try {
		const req = await Model.query("age").eq(1).where("id").gt("a").where("id").eq("b").getRequest();
		console.log("\nF13 KCE:", JSON.stringify(req.KeyConditionExpression));
		results.F13 = await send("F13 `>` on partition key", "query", req);
	} catch (e) { console.log("F13 client threw:", e.message); results.F13 = "client-threw"; }

	// ---- F23: empty parenthesised group -> "AND ()"
	try {
		const req = await Model.scan().where("name").eq("x").parenthesis((c) => c).where("age").eq(1).getRequest();
		console.log("\nF23 built expression:", JSON.stringify(req.FilterExpression));
		results.F23 = await send("F23 empty group (AND ())", "scan", req);
	} catch (e) { console.log("F23 client threw:", e.message); results.F23 = "client-threw"; }

	// ---- control: a perfectly ordinary query must be accepted
	try {
		const req = await Model.query("id").eq("x").where("sk").eq("y").getRequest();
		results["ctrl ordinary query"] = await send("ctrl ordinary query", "query", req);
	} catch (e) { console.log("ctrl client threw:", e.message); results["ctrl ordinary query"] = "client-threw"; }

	console.log("\n==== SUMMARY ====");
	for (const [k, v] of Object.entries(results)) console.log(`${v.padEnd(14)} ${k}`);
})();
