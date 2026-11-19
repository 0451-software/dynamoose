
const utils = require("./packages/dynamoose/dist/utils").default;

// K1: keyBy with an item whose key value is "__proto__"
const items = [{"__proto__": "v1"}, {"id": "v2"}];
const r = utils.keyBy(items, "__proto__");
console.log("K1 keyBy result own keys:", JSON.stringify(Object.keys(r)));
console.log("K1 result:", JSON.stringify(r));
console.log("K1 expected own keys: ['__proto__','id']  (both items should be mapped)");
console.log("");
// K2: keyBy with a normal key - control
const r2 = utils.keyBy([{"id":"a"},{"id":"b"}], "id");
console.log("K2 control:", JSON.stringify(r2));
console.log("");
// K3: is this reachable? keyBy is used by merge_objects.schemaAttributesMerger
console.log("K3 schemaAttributesMerger source uses keyBy with AttributeName/IndexName");
console.log("   -> an attribute literally named __proto__ in a DynamoDB index would hit it");
