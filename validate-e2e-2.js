// Validate F7 variant B: the `#qha0` / `:qhv0` placeholder corruption.
// Also confirm F7 variant A (client-side crash) and that a grouped SCAN still works.

const dynamoose = require("/workspace/source/dynamoose/packages/dynamoose/dist");
const {DynamoDBClient} = require("/workspace/source/dynamoose/node_modules/@aws-sdk/client-dynamodb");
const {QueryCommand, ScanCommand, CreateTableCommand, DeleteTableCommand} = require("/workspace/source/dynamoose/node_modules/@aws-sdk/client-dynamodb");

const ENDPOINT = process.env.DDB_ENDPOINT || "http://localhost:8002";
const raw = new DynamoDBClient({endpoint: ENDPOINT, region: "us-east-1", credentials: {accessKeyId: "fake", secretAccessKey: "fake"}});
dynamoose.aws.ddb.local(ENDPOINT);
dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

const TABLE = "ValidateGroup";
const Model = dynamoose.model(TABLE, {
	"id": {"type": "String", "hashKey": true},
	"sk": {"type": "String", "rangeKey": true},
	"name": {"type": "String", "index": {"type": "global"}},
	"age": Number,
	"color": String
});

(async () => {
	try { await raw.send(new DeleteTableCommand({TableName: TABLE})); } catch (e) { /* ignore */ }
	await raw.send(new CreateTableCommand({
		"TableName": TABLE,
		"AttributeDefinitions": [
			{"AttributeName": "id", "AttributeType": "S"},
			{"AttributeName": "sk", "AttributeType": "S"},
			{"AttributeName": "name", "AttributeType": "S"}
		],
		"KeySchema": [
			{"AttributeName": "id", "KeyType": "HASH"},
			{"AttributeName": "sk", "KeyType": "RANGE"}
		],
		"GlobalSecondaryIndexes": [{
			"IndexName": "nameGlobalIndex",
			"KeySchema": [{"AttributeName": "name", "KeyType": "HASH"}],
			"Projection": {"ProjectionType": "ALL"}
		}],
		"BillingMode": "PAY_PER_REQUEST"
	}));

	// ---- F7 variant A: hash key inside a group -> client-side crash
	try {
		await Model.query().parenthesis((c) => c.where("id").eq("a")).using("nameGlobalIndex").getRequest();
		console.log("F7A  NO crash (claim would be refuted)");
	} catch (e) {
		console.log("F7A  client-side crash:", e.constructor.name + ":", String(e.message).slice(0, 90));
	}

	// ---- F7 variant B: placeholder corruption, then send to the server
	const query = Model.query().where("age").eq(1).parenthesis((c) => c.where("id").eq("zzz"));
	["color", "name", "age", "color", "name", "age", "color", "name", "age"].forEach((attribute) => query.where(attribute).eq(1));
	let request = null;
	try {
		request = await query.using("nameGlobalIndex").getRequest();
	} catch (e) {
		console.log("F7B  client-side crash:", e.constructor.name + ":", String(e.message).slice(0, 90));
	}
	if (request) {
		console.log("F7B  KeyConditionExpression:", JSON.stringify(request.KeyConditionExpression));
		console.log("F7B  #qha0 defined in names?  ", Object.prototype.hasOwnProperty.call(request.ExpressionAttributeNames || {}, "#qha0"));
		console.log("F7B  :qhv0 defined in values? ", Object.prototype.hasOwnProperty.call(request.ExpressionAttributeValues || {}, ":qhv0"));
		try {
			await raw.send(new QueryCommand(request));
			console.log("F7B  SERVER ACCEPTED");
		} catch (e) {
			console.log("F7B  SERVER REJECTED:", e.name + ":", String(e.message).replace(/\s+/gu, " ").slice(0, 140));
		}
	}

	// ---- control: a grouped SCAN should still be fine
	try {
		const scanRequest = await Model.scan().parenthesis((c) => c.where("id").eq("a")).getRequest();
		console.log("\nctrl grouped scan expression:", JSON.stringify(scanRequest.FilterExpression));
		try {
			await raw.send(new ScanCommand(scanRequest));
			console.log("ctrl grouped scan            SERVER ACCEPTED");
		} catch (e) {
			console.log("ctrl grouped scan            SERVER REJECTED:", e.name + ":", String(e.message).slice(0, 110));
		}
	} catch (e) {
		console.log("ctrl grouped scan client threw:", e.message);
	}
})();