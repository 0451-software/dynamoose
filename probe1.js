
const utils = require("./packages/dynamoose/dist/utils").default;

// H1: combine_objects crashes on null nested value
try {
  const r = utils.combine_objects({a: {b: 1}}, {a: null});
  console.log("H1 combine_objects null ->", JSON.stringify(r));
} catch (e) {
  console.log("H1 combine_objects null -> THROWS:", e.constructor.name, e.message);
}

// H2: merge_objects array_merge_new_array crashes on null nested value
try {
  const r = utils.merge_objects.main({combineMethod: "array_merge_new_array"})({a: {b: 1}}, {a: null});
  console.log("H2 merge amn null ->", JSON.stringify(r));
} catch (e) {
  console.log("H2 merge amn null -> THROWS:", e.constructor.name, e.message);
}

// H3: merge_objects default with null nested value
try {
  const r = utils.merge_objects({a: {b: 1}}, {a: null});
  console.log("H3 merge default null ->", JSON.stringify(r));
} catch (e) {
  console.log("H3 merge default null -> THROWS:", e.constructor.name, e.message);
}

// H4: deep_copy does NOT deep copy values inside Map/Set
const inner = {n: 1};
const m = new Map([["k", inner]]);
const mc = utils.deep_copy(m);
console.log("H4 map value shared?", mc.get("k") === inner);
const s = new Set([inner]);
const sc = utils.deep_copy(s);
console.log("H4 set elem shared?", [...sc][0] === inner);

// H5: merge_objects truthiness inconsistency (0 vs 1) under array_merge_new_array
console.log("H5 zero ->", JSON.stringify(utils.merge_objects.main({combineMethod:"array_merge_new_array"})({b: 0}, {b: 3})));
console.log("H5 one  ->", JSON.stringify(utils.merge_objects.main({combineMethod:"array_merge_new_array"})({b: 1}, {b: 3})));
console.log("H5 default zero ->", JSON.stringify(utils.merge_objects({b: 0}, {b: 3})));
console.log("H5 default one  ->", JSON.stringify(utils.merge_objects({b: 1}, {b: 3})));

// H6: merge_objects mutates its first argument
const a0 = {x: 1};
utils.merge_objects(a0, {x: 2, y: 3});
console.log("H6 first arg mutated?", JSON.stringify(a0));

// H7: combine_objects mutates its first argument
const c0 = {x: 1};
utils.combine_objects(c0, {y: 2});
console.log("H7 first arg mutated?", JSON.stringify(c0));

// H8: wildcard ** early-return ignores required trailing literal
console.log("H8 random.**.hello vs random.test.random ->",
  utils.dynamoose.wildcard_allowed_check(["random.**.hello"], "random.test.random"));
console.log("H8 random.*.hello vs random ->",
  utils.dynamoose.wildcard_allowed_check(["random.*.hello"], "random"));
