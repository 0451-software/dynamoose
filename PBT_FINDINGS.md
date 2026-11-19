# Property-based testing investigation — dynamoose

**Target:** `https://github.com/dynamoose/dynamoose` @ `efa6c0f` (v4.2.0)
**Method:** property-based testing with `fast-check@3.23.2`, plus an adversarial review pass
**Discovery branch:** `pbt/discovery`

## How this was done

Five agents worked in parallel, each owning one subsystem and each in its own git
worktree: `utils`, `schema`, `condition` + `itemretriever`, `item` + `model`, and
`table` + `model` + `serializer`. Every candidate was then put through a sixth
agent whose only job was to **refute** it.

That last step mattered. Three candidates were refuted and dropped, one was
reclassified as a documentation inaccuracy, and the severity of five more was
corrected downward. The final count is **25 confirmed bugs**, not the 41
candidates that were initially reported.

Every finding below was reproduced by running the code against the real
`dynamoose` public API, not by reading it — and each was then re-verified
independently by a second agent that had no stake in the original claim. The
discovery suite lives in `packages/dynamoose/test/pbt/` and is organised so that
each confirmed bug has a named, self-contained failing test.

## The confirmed bugs

### 1. Any `or()` in a query crashes request construction — **HIGH**
`Model.query(...).or()...` throws `TypeError: Cannot read properties of undefined (reading '0')`.
Leading, middle and trailing `or()` all fail; scans are unaffected because
`comparisonChart` is only called for queries.

Root cause: `Condition.ts:264-266` reduces over `settings.conditions` and calls
`Object.entries(item)[0]`. The `OR` entry is a `Symbol`, so `Object.entries(OR)` is
`[]` and the destructure throws.

```js
Model.query("id").eq(1).or().where("age").eq(2).getRequest()
// TypeError: Cannot read properties of undefined (reading '0')
```

The `or()` JSDoc documents exactly this pattern, and `test/Condition.js:115` uses
it — but those tests exercise `requestObject`, not `comparisonChart`.

### 2. A key condition inside `parenthesis()` breaks the query — **HIGH**
Two distinct failures, both reachable from the public `Query` API.

*Crash* — `moveParameterNames` (`ItemRetriever.ts:197`) searches the
`FilterExpression` array with `item.includes(key)`. For a grouped condition the
entry is a nested array, and `Array.includes` is an exact match, so `findIndex`
returns `-1` and the code dereferences `undefined`.

**Scope caveat (corrected in the second pass):** this crash does *not* fire for
every grouped key condition. It did not reproduce when `.using()` named a real
index whose key schema matched the model. It needs a narrower shape — a grouped
key condition plus an index whose key cannot be resolved that way. The
corruption variant below is the reliable one, and it is what the finding rests on.

*Corruption* — `#a1` is a prefix of `#a10`, so `findIndex` matches the wrong
entry and the subsequent `replace` turns `#a10` into `#qha0`, emitting a
`KeyConditionExpression` that references placeholders which do not exist:

```
KeyConditionExpression: "#qha0 = :qhv0"
ExpressionAttributeNames: { ..., "#qha": "id" }   <-- #qha0 NOT DEFINED
```

### 3. A failed `Table` construction permanently bricks its models — **HIGH**
`new dynamoose.Table("T", [good, bad], ...)` throws `hashKey's for all models must
match.` — but the models were **already** bound to the never-created table, so
every later attempt fails with `Model X has already been assigned to a table.`

Root cause: binding happens inside `setInternalProperties` (`Table/index.ts:190-201`)
**before** the hashKey validation (`:289-294`).

The "already assigned" guard itself is intentional (`test/Table.js:50-54` asserts
it). The defect is the ordering. A user who fixes their schema and retries with
the same model objects cannot recover without a process restart.

### 4. A `required` attribute named after an `Object.prototype` member is not enforced — **MEDIUM**
Silent data loss: a required field is saved **without** a value.

```js
const M = dynamoose.model("M", {"id": Number, "toString": {"type": String, "required": true}});
await new M({"id": 1}).toDynamo({required: true});  // NO THROW
// saved item keys: ["id"]  <-- "toString" is ABSENT
```

Root cause: `Item.ts:840` reads the value with `utils.object.get(returnObject, key)`,
a plain property lookup, so a missing key named `toString` returns the **inherited**
`Object.prototype.toString`. `Schema.requiredCheck` (`Schema.ts:1504-1509`) only
throws for `undefined`/`null`, so the check passes.

A control attribute named `normal` correctly throws. `valueOf`, `hasOwnProperty`
and `toLocaleString` behave the same way.

**Impact correction (second pass).** The failure mode is *not* "silently saved
without the value". It depends on the entry point, and I verified both:

| entry point | actual behaviour |
|---|---|
| `item.save()` (the real path) | **throws** `TypeError: Cannot destructure property 'customType' of 'typeDetails' as it is undefined` — a confused crash, not a clean `ValidationError`, and nothing is written |
| `toDynamo({required: true})` | **no throw** — the required check silently passes |

So the defect is a *misleading crash on save* plus a *silently bypassed check* on
the lower-level call — not silent data loss. Severity is correspondingly lower.

### 5. An array default containing a null element is silently dropped — **MEDIUM**
The whole attribute disappears — no error, no warning.

```js
{"arr": {"type": Array, "schema": [String], "default": () => ["a", null]}}
// => {"id": 1}          <-- "arr" is GONE
// control: default () => ["a", "b"]  =>  {"id": 1, "arr": ["a", "b"]}
```

Root cause: `Item.ts:711` computes
`isDefaultValueUndefined = Array.isArray(defaultValue) ? defaultValue.some((v) => v == null) : ...`.
A single null **element** marks the whole default as undefined, so it is discarded
at `:714`. Type checking being on does **not** help — the type check runs at
`:664`, before the defaults block at `:704`.

### 6. `comparisonChart` mis-keys parenthesised conditions — **MEDIUM**
`Condition.comparisonChart` is internal, but a grouped condition's real attribute
name is replaced by the array index `"0"`:

```js
new dynamoose.Condition("id").eq(1).parenthesis((c) => c.where("age").eq(2)))
// comparisonChart keys: ["0", "id"]   (expected ["id", "age"])
```

Root cause: `Condition.ts:264-269` calls `Object.entries(item)[0]` on every entry;
a parenthesised entry is an **array**, so the key becomes the index.

Observable effect: the hash key is not seen as an EQ constraint, so
`find_best_index` finds no index and the query is refused with
`Index can't be found for query.` The bogus `"0"` key never reaches a request.

### 7. `combine_objects` / `merge_objects` throw a raw `TypeError` on a null nested value — **LOW-MEDIUM**
```js
utils.combine_objects({a: {b: 1}}, {a: null})
// TypeError: Cannot convert undefined or null to object
```
Instead of the library's own documented error, `You can only pass objects into
combine_objects method.`

Root cause: the guard null-checks `returnObject[key]` but **not** `arg[key]`, so a
null in a later argument recurses into `Object.keys(null)`.

Reachable publicly via `dynamoose.Table.defaults.set({...: null})` and via
`new Schema({...}, {setting: null})`.

### 8. A range-key condition using an operator DynamoDB rejects — **LOW-MEDIUM**
The sort key of a `KeyConditionExpression` may only use `=`, `<`, `<=`, `>`, `>=`,
`BETWEEN` or `begins_with`
([AWS docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html)).
Dynamoose moves these into the key condition anyway:

| condition | emitted `KeyConditionExpression` | valid? |
|---|---|---|
| `.in([1,2])` | `#qha = :qhv AND #qra IN (:qrv_1, :qrv_2)` | no |
| `.not().eq(5)` | `#qha = :qhv AND #qra <> :qrv` | no |
| `.not().exists()` | `#qha = :qhv AND attribute_not_exists (#qra)` | no |

Root cause: `moveParameterNames` (`ItemRetriever.ts:199`) keeps a condition in the
`FilterExpression` only if it contains the substrings `attribute_exists` or
`contains`. `attribute_not_exists` does not contain `attribute_exists`, so it is
moved. The `exists()` and `not().contains()` cases are handled correctly.

### 9. `Table` mutates and aliases the caller's options object — **LOW-MEDIUM**
```js
const options = {throughput: {read: 5}, initialize: false};
new dynamoose.Table("T", [M], options);
options.throughput      // {read: 5, write: 1}   <-- mutated, defaults injected
options.create          // true                  <-- mutated
table.getInternalProperties(ip).options === options   // true
```

Because the Table holds the caller's object **by reference**, later edits to it
silently change the Table's behaviour — `options.throughput.read = 999` changes the
`CreateTable` request.

Root cause: `Table/index.ts:164` passes the caller's `options` as the first
argument to `utils.combine_objects`, which merges into its first argument.

### 10. Prototype pollution through `combine_objects` — **LOW-MEDIUM**
```js
utils.combine_objects({}, JSON.parse('{"__proto__": {"polluted": "PWNED"}}'));
({}).polluted   // "PWNED"   <-- Object.prototype is genuinely mutated
```

Reachable publicly via `dynamoose.Table.defaults.set(JSON.parse(userInput))`.

Only `combine_objects` and `merge_objects` with `array_merge_new_array` are
affected; the default `merge_objects` method assigns an array and never triggers
the `__proto__` setter.

**Severity note:** this is a real prototype-pollution primitive, but it is **not**
a remotely exploitable vulnerability in a normal Dynamoose app — it requires the
application to route untrusted JSON into a configuration setter.

### 11. An attribute named after an `Object.prototype` member never gets its default — **LOW-MEDIUM**
Same root cause as finding 4, in the defaults loop (`Item.ts:707`). The attribute
is omitted entirely from the saved item. It works correctly when a value is
supplied explicitly.

### 12. `merge_objects` output shape depends on the truthiness of the accumulated value — **LOW**
Under `array_merge_new_array`, a truthy first value yields `[value, newValue]`
while a falsy one yields the scalar `newValue` alone:

```js
merge_objects.main({combineMethod: "array_merge_new_array"})({b: 0}, {b: 3})  // {b: 3}
merge_objects.main({combineMethod: "array_merge_new_array"})({b: 1}, {b: 3})  // {b: [1, 3]}
```

Root cause: `merge_objects.ts:46` uses `else if (returnObject[key])` — a
truthiness test where an existence test is needed.

**Under the default combine method this is not a bug**: `0 + 3` and
overwrite-with-`3` are numerically identical, so it is unobservable there.

### 13. `in([])` emits the invalid expression `#a0 IN ()` — **LOW**
`IN ()` is a DynamoDB syntax error. Dynamoose performs no length validation on
the `in` array.

### 14. `between()` with fewer than two arguments emits undefined placeholders — **LOW**
```js
new dynamoose.Condition("name").between(1)
// ConditionExpression: "#a0 BETWEEN :v0_1 AND :v0_2"
// ExpressionAttributeValues: {":v0_1": {...}}   <-- :v0_2 is undefined and dropped
```
`between` is variadic (`multipleArguments: true`) with no arity validation. The
AWS SDK's low-level serializer silently drops the undefined value, so DynamoDB
receives a `BETWEEN` with a missing bound and rejects it with a service-side
validation error. Dynamoose itself does not crash.

### 16. A nested `Schema` plus a parent `saveUnknown: true` crashes on save — **MEDIUM**
```js
const inner = new dynamoose.Schema({"a": String}, {"saveUnknown": true});
const outer = new dynamoose.Schema({"nested": inner}, {"saveUnknown": true});
const M = dynamoose.model("M", outer);          // model built from the Schema INSTANCE
await new M({"id": "1", "nested": {"a": "x", "unknownKey": "y"}}).save();
// TypeError: key.split is not a function
//   at wildcard_allowed_check (dynamoose-utils/dist/wildcard_allowed_check.js:6:34)
```

Root cause: `Schema.ts:1065` merges a nested `Schema`'s settings into the parent's
with `merge_objects.main({combineMethod: "array_merge_new_array"})`. The parent's
`saveUnknown: true` is a **boolean**, and it is truthy, so the merge takes the
array-merge branch and produces the malformed `[true, ["nested.**"]]` instead of
`["nested.**"]`. `wildcard_allowed_check` then calls `key.split(...)` on the
boolean.

This is the same truthiness defect as finding 12, reached through a different
call site.

Precisely isolated — the crash needs the parent's `saveUnknown` to be `true`:

| parent `saveUnknown` | merged value | crashes? |
|---|---|---|
| `true` | `[true, ["nested.**"]]` | yes |
| `false` | `["nested.**"]` | no |
| `["x"]` | `["x", "nested.**"]` | no |

Note the model must be built from the `Schema` **instance**. Building the same
shape from a plain object schema produces a different internal layout and does
not crash.

### 17. A falsy value on an aliased attribute is lost entirely — **MEDIUM**
```js
const M = dynamoose.model("M", {"id": Number, "n": {"type": Number, "alias": "nn"}});
const item = new M({"id": 1, "n": 0});
await item.conformToSchema({"type": "fromDynamo", "customTypesDynamo": true, "saveUnknown": true, "modifiers": ["get"], "mapAttributes": true});

item.n    // undefined
item.nn   // undefined   <-- the value 0 is GONE
item.toJSON()  // {"id": 1}
```

A truthy value on the same attribute is correctly renamed to the alias
(`item.nn === 5`), and the same falsy value on an attribute with **no** alias
survives untouched (`item.n === 0`). Only the combination of *alias* + *falsy
value* loses data.

Root cause: `Item.ts:653` guards the rename with
`if (returnObject[oldKey] !== undefined)`. For `0`, `""` and `false` the value
**is present** but the guard is about `undefined`, so — depending on direction —
the rename is skipped and the schema-named key is then removed by the
"not in the schema" check, taking the value with it.

No existing test covers an alias with a falsy value.

### 18. A schema-level `set` modifier makes `dynamoPropertyForAttribute` return the WRONG attribute — **HIGH**
```js
const M = dynamoose.model("M", new dynamoose.Schema(
  {"id": Number, "name": String},
  {"set": (item) => ({type: "user", ...item})}
));
await M.Model.getInternalProperties(ip).dynamoPropertyForAttribute("name");
// actual: "type"     expected: "name"
```
Root cause: `Model/index.ts:278-279` builds a probe object `{[attribute]: true}` and
returns `Object.keys(obj)[0]` — the **first** key — which a `set` modifier can reorder.

Every `Condition` on such a model silently filters on the **wrong attribute**
(`ExpressionAttributeNames: {"#a0": "type"}`). Reachable from `Model.scan`,
`Model.query`, `Model.update`, `Model.delete` with a condition.

### 19. `dynamoPropertyForAttribute` crashes on a type-specific `set` modifier — **HIGH**
```js
const M = dynamoose.model("M", {"id": Number, "name": {"type": String, "set": (v) => v.trim()}});
await M.Model.getInternalProperties(ip).dynamoPropertyForAttribute("name");
// TypeError: v.trim is not a function
```
Root cause: `Model/index.ts:278` passes the literal `true` as the attribute value
with `modifiers: ["set"]`, so the modifier receives `true` instead of the value.
`Model.scan(cond)`, `Model.query(cond)`, `Model.delete(key, {condition})` and
`Model.update(key, obj, {condition})` all throw.

### 20. `Model.update` silently drops an aliased attribute — **HIGH**
```js
const M = dynamoose.model("M", {"id": Number, "name": {"type": String, "alias": "userName"}});
await M.update({"id": 1}, {"userName": "bob"}, {"return": "request"});
// actual:   {"UpdateExpression": "", "ExpressionAttributeNames": {}}
// expected: {"UpdateExpression": "SET #a0 = :v0", "ExpressionAttributeNames": {"#a0": "name"}}
```
Root cause: `Model/index.ts:757` reads back `[subKey]` (the alias) from a result
that `objectFromSchema` already renamed to the schema attribute name, so the
value is `undefined` and the branch at `:760-765` drops the update. A silent
no-op write. The same call keyed by the schema name works.

### 21. A schema attribute literally named `"0"` crashes every schema-aware path — **MEDIUM**
```js
const M = dynamoose.model("M", {"id": Number, "0": String});
await new M({"id": 1, "0": "x"}).save();
// TypeError: node.forEach is not a function
```
Root cause: `Item.ts:577-586` assumes any node named `"0"` is an array index.
`"1"`, `"00"`, `"a0"` all work — only the exact `"0"` is broken. The Schema
constructor accepts the name (only dots are forbidden).

**Severity correction (second pass).** `packages/dynamoose/test/Schema.js:110`
contains a **skipped** test — `it.skip("Should throw error if attribute names only
contains number", …)` — which shows the maintainers intend purely numeric attribute
names to be *rejected*, not supported. So `"0"` is arguably out of contract. The
remaining defect is that the rejection is a raw `TypeError` deep inside
`objectFromSchema` rather than a clear validation error at Schema construction.
Low severity.

### 22. The key condition can use a non-equality operator on the partition key — **MEDIUM-HIGH**
```js
Model.query("age").eq(1).where("id").gt(2).where("id").eq(3).getRequest();
// KeyConditionExpression: "#qha > :qhv"   (the real `id = 3` is stranded in the filter)
```
AWS requires the partition key to be an equality condition. Root cause:
`ItemRetriever.ts:192` picks the **first** placeholder for the hash attribute.

Related: the comparison chart keeps only the **last** comparison per attribute
(`Condition.ts:264-269` overwrites `res[key]`), so `query("id").eq(1).where("id").gt(2)`
throws `Index can't be found for query.` — the hash-key equality is invisible to
`find_best_index`.

### 23. An empty parenthesised group produces an invalid expression — **MEDIUM**
```js
new Condition().where("name").eq(1).parenthesis((c) => c).where("id").eq(2);
// ConditionExpression: "#a0 = :v0 AND () AND #a1 = :v1"

Model.scan().where("name").eq("x").parenthesis((c) => c).where("age").eq(1).getRequest();
// FilterExpression: "#a0 = :v0 AND AND #a1 = :v1"   <-- same defect, different text
```

The exact emitted text depends on the path; both forms are invalid and a DynamoDB
server rejects both.
Root cause: `utils.object.clearEmpties` deletes the empty nested array from the
`FilterExpression` array, leaving a hole, while both `AND` connectors survive
(`Condition.ts:245-255`).

### 24. Type settings leak across entries of a multi-type array — **MEDIUM**
```js
new Schema({"id": {"type": [{"value": Date, "settings": {"storage": "iso"}}, Date]}});
// getAttributeTypeDetails("id").map(d => d.dynamodbType)
// actual:   ["S", "S"]     expected: ["S", "N"]
```
The plain `Date` inherits the previous entry's `storage: "iso"`, so it is stored
as an ISO **string** instead of a number — the DynamoDB attribute type differs
from what the schema declares. Root cause: `Schema.ts:1662` declares
`typeSettings` outside the `.map()` callback and `:1711` reassigns it without
restoring. The reverse order is correct, which is the decisive evidence.

### 25. `keyBy` drops the entry whose key is `"__proto__"` — **MEDIUM**
```js
Object.keys(utils.keyBy([{id: "__proto__"}], "id"));   // => []   expected ["__proto__"]
```
Root cause: `keyBy.ts:22-25` compiles to `Object.assign`, which uses `[[Set]]`,
so assigning `"__proto__"` fires the setter instead of creating an own key.
`merge_objects.schemaAttributesMerger` keyBy's DynamoDB attribute names, so a
real attribute definition can be dropped from a create-table request.

### 26. `unique_array_elements` drops a `NaN` element — **LOW-MEDIUM**
```js
utils.unique_array_elements([NaN]);      // => []     expected [NaN]
utils.unique_array_elements([1, NaN, 2]) // => [1, 2]  (the NaN is gone)
```
Root cause: `unique_array_elements.ts:3` uses `obj.equals`, whose fast path is
`a === b` — and `NaN === NaN` is false, so `findIndex` never matches. `Set`
uses SameValueZero, so `[NaN].size === 1`.


## Server-level validation (second pass)

An earlier draft of this report validated the "DynamoDB would reject this" claims by
reading the AWS expression grammar. That is second-hand evidence. A second pass
re-ran every contested request against a **real DynamoDB server implementation**
(`dynalite`, a pure-JS DynamoDB) and let the server decide.

Scripts: `validate-e2e.js`, `validate-e2e-2.js` (need a server on `:8002`).

| Finding | Request sent | Server verdict |
|---|---|---|
| F9 — `in([])` | `FilterExpression: "#a0 IN ()"` | **REJECTED** — `ValidationException: Syntax error; Expected "#", "(", ":", "_", or [a-zA-Z] but ")" found` |
| F10 — `between(1)` | `"#a0 BETWEEN :v0_1 AND :v0_2"` | **REJECTED** — `An expression attribute value used in expression is not defined; attribute value: :v0_2` |
| F12a — `in()` on sort key | `"#qha = :qhv AND #qra IN (:qrv_1, :qrv_2)"` | **REJECTED** — `Invalid operator used in KeyConditionExpression: IN` |
| F12b — `not().eq()` on sort key | `"#qha = :qhv AND #qra <> :qrv"` | **REJECTED** — `Invalid operator used in KeyConditionExpression: <>` |
| F12c — `not().exists()` on sort key | `"#qha = :qhv AND attribute_not_exists (#qra)"` | **REJECTED** — `Invalid operator used in KeyConditionExpression: attribute_not_exists` |
| F13 — `>` on the partition key | `"#qha > :qhv"` | **REJECTED** — `Query key condition not supported` |
| F23 — empty group | `"#a0 = :v0 AND AND #a1 = :v1"` | **REJECTED** — `Syntax error; Expected "(" or "NOT" but "A" found` |
| F7b — grouped hash key (≥9 extra conditions) | `KeyConditionExpression: "#qha0 = :qhv0"` with `#qha0`/`:qhv0` absent | **REJECTED** — `An expression attribute name used in the document path is not defined; attribute name: #qha0` |

**Controls — every one accepted**, which is what makes the rejections meaningful:

| Control | Verdict |
|---|---|
| `eq` on the sort key | accepted |
| `beginsWith` on the sort key | accepted |
| `between` on the sort key | accepted |
| a plain `hash = AND range =` query | accepted |
| a grouped condition in a **Scan** | accepted |

Two corrections this pass forced:

1. **F23's emitted text varies by path.** Through `Model.scan()` the expression is
   `"#a0 = :v0 AND AND #a1 = :v1"`; through a bare `Condition.requestObject` it is
   `"#a0 = :v0 AND () AND #a1 = :v1"`. Both are invalid; the report previously
   quoted only the second.
2. **F7 variant A (the client-side crash) is narrower than first stated.** It did
   *not* reproduce when `.using()` named a real index whose key schema matches the
   model. The crash needs a specific shape (a grouped key condition plus an index
   whose key is not resolvable that way). Variant B — the placeholder corruption —
   reproduces reliably and is server-rejected, so F7 stands on variant B. Variant A
   should be described as "reproduces under narrower conditions", not "any grouped
   hash key".

**Caveat:** `dynalite` is a reimplementation, not AWS. A rejection is strong
evidence of invalidity; an acceptance is weaker evidence of validity. The
accept/reject split across controls and cases is consistent with the AWS grammar,
which is the important signal.

## Refuted during the adversarial review

These were reported by an agent and then **refuted**. They are recorded here so
they are not re-investigated.

| Candidate | Why it was refuted |
|---|---|
| `deep_copy` does not deep-copy `Map`/`Set` contents | The behaviour is real, but the contract (per the function's own tests) is container-copy, and DynamoDB-backed data cannot contain a `Map` or a `Set` of mutable objects — such values are rejected upstream by the type check. Unreachable. |
| `merge_objects` mutates its first argument | By design: the first argument *is* the accumulator (`merge_objects.ts:26-27`). No call site depends on non-mutation. |
| `find_best_index` mutates the caller's index objects | Real, but the objects are freshly built by `Schema.getIndexes()` on every call, never shared between models, never serialized into a `CreateTable`/`UpdateTable` payload, and the only consumer recomputes the hash/range itself. Unobservable. |
| A null value defeats the documented "default applies to null" | A **documentation** inaccuracy, not a bug. `dynamoose.type.NULL` exists precisely to make an explicit null a first-class value, and `test/Item.js:3263-3267` asserts that a null against a typed attribute throws `TypeMismatch`. The `Schema.ts:438` JSDoc sentence is the loose part. |
| `type_name` crashes on an own `constructor: null` | The crash is real, but rejecting such documents is correct: Dynamoose's `Object` type requires `val.constructor === undefined \|\| val.constructor === Object` (`Schema.ts:176`), and the AWS SDK's `marshall` independently refuses them. Only the error *message* is wrong. |
| `merge_objects` mutates its first argument (re-raised by the utils agent) | Re-confirmed as by-design: the first argument *is* the accumulator (`merge_objects.ts:26-27`). No call site depends on non-mutation, and `Condition.ts:178` defensively spreads both operands where it matters. |
| `deep_copy` does not deep-copy `Map`/`Set` contents (re-raised by the utils agent) | Same verdict as above: real behaviour, but the contract (per the function's own tests) is container-copy, and DynamoDB-backed data cannot contain a `Map` or a `Set` of mutable objects. |
| A `null` value defeats the documented "default applies to null" | A **documentation** inaccuracy, not a bug. `dynamoose.type.NULL` exists precisely to make an explicit null a first-class value, and `test/Item.js:3263-3267` asserts that a null against a typed attribute throws `TypeMismatch`. The `Schema.ts:438` JSDoc sentence is the loose part. |
| `find_best_index` mutates the caller's index objects (re-raised) | Real, but the objects are freshly built by `Schema.getIndexes()` on every call, never shared, never serialized into a `CreateTable`/`UpdateTable` payload, and the only consumer recomputes the hash/range itself. Unobservable. |

## Properties that held

These are as valuable as the bugs — they pin down intended behaviour:

- `merge_objects` is associative for numeric keys under the default combine method.
- `combine_objects` keeps the first value for a conflicting scalar key, deep-merges
  conflicting object keys, and concatenates array-valued keys. It is idempotent.
- `not()` produces the opposite comparison type for every comparison that has an
  opposite, and throws for `in` / `between` / `begins_with`.
- `and()` is a no-op and `or()` produces an OR join in the emitted expression.
- `comparisonChart` stays in sync with the comparison actually emitted.
- `in()` uses one value placeholder per element; `between()` uses exactly two.
- The emitted expressions are always syntactically valid and every referenced
  placeholder is defined — except in the specific corruptions above.
- `wildcard_allowed_check` matches the documented semantics: `**` matches zero or
  more trailing segments, `*` matches exactly one and never two, a literal
  pattern matches only itself.
- Nested defaults and required attributes behave consistently with top-level ones,
  including inside array elements.
- `conformToSchema` is idempotent and does not mutate its input.

## Coverage gaps

- The full runtime suite needs DynamoDB Local on port 8000; it was not available
  here, so all findings were verified at the **request-construction** boundary
  (`getRequest`, `toDynamo`, `objectFromSchema`) rather than against a live
  DynamoDB. The AWS SDK's serialisation of the malformed requests was checked
  directly.
- `Item.save` / `Model.create` against a live table were not exercised.
- The `dynamoose-logger` package was not investigated (it shares
  `wildcard_allowed_check` with the core, so its semantics are inherited).
- The `Schema` `Combine` type, `Model`-typed attributes and `dynamoose.type.THIS`
  were not property-tested — they need a live model/table.
- `Item` `set`/`get` modifiers, custom types and multi-schema models were only
  probed by hand, not fuzzed exhaustively.
- Duplicate explicit index names were flagged by one agent but left unresolved:
  `getIndexes()` and `getCreateTableAttributeParams()` disagree on the count.
- `conformToSchema` is not idempotent when a `get` modifier is present
  (`"bob"` → `"bob!"` → `"bob!!"`). No documented contract states idempotence,
  and no internal path double-applies it, so this is listed but not confirmed.
- `Schema` custom types (`get`/`set`/`validate` modifiers) were covered only
  shallowly.

## Suggested order of work

Findings 1–3, 18–20 and 22 are user-visible failures on ordinary, documented
API usage — they should come first. Findings 4–5, 17 and 26 are silent data
loss and should come next. Findings 7, 10 and 14 are hardening items.

Findings 18–20 share a theme worth calling out: **a modifier or alias silently
changes which attribute is targeted**. In each case the request is still
well-formed, so nothing errors — it just operates on the wrong data. These are
the ones most likely to cause real harm in production, because nothing in the
logs looks wrong.

Findings 1, 2, 9, 10, 15, 21–23 all produce requests that DynamoDB will
reject. They are loud failures rather than silent ones, which makes them easier
to triage — but they are still bugs, and 1, 2 and 3 are on the most ordinary
query patterns there are.

Per `AGENTS.md`, every change must be reviewed and approved by a human before
being submitted upstream, and any AI involvement must be disclosed in the PR
description. This work has not been submitted anywhere.