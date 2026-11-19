
const utils = require("./packages/dynamoose/dist/utils").default;

// K4: JSON.parse path - own "__proto__" data property
const items = JSON.parse('[{"__proto__":"v1"},{"id":"v2"}]');
console.log("K4 item0 own __proto__?", Object.prototype.hasOwnProperty.call(items[0], "__proto__"));
console.log("K4 item0['__proto__'] =", items[0]["__proto__"]);

const r4 = utils.keyBy(items, "__proto__");
console.log("K4 keyBy own keys:", JSON.stringify(Object.keys(r4)));
console.log("K4 result:", JSON.stringify(r4));

// K5: does keyBy pollute Object.prototype?
console.log("");
console.log("K5 ({}).pollutedByKeyBy =", ({}).pollutedByKeyBy);
const items2 = JSON.parse('[{"__proto__":{"pollutedByKeyBy":"PWNED"}}]');
const r5 = utils.keyBy(items2, "__proto__");
console.log("K5 after keyBy, ({}).pollutedByKeyBy =", ({}).pollutedByKeyBy);
console.log("K5 keyBy result own keys:", JSON.stringify(Object.keys(r5)));
console.log("K5 result proto polluted?", Object.getPrototypeOf(r5) && Object.getPrototypeOf(r5).pollutedByKeyBy);
