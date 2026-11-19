# Property-based testing investigation — dynamoose

**Target:** `https://github.com/dynamoose/dynamoose` @ `efa6c0f` (v4.2.0)
**Method:** property-based testing with `fast-check@3.23.2`, plus an adversarial review pass
**Discovery branch:** `pbt/discovery`

## How this was done

Five agents worked in parallel, each owning one subsystem and each in its own git
worktree: `utils`, `schema`, `condition` + `itemretriever`, `item` + `model`, and
`table` + `model` + `serializer`. Every candidate was then put through a sixth
agent whose only job was to **refute** it.

That last step mattered. Three candidates were refuted and dropped, and the
severity of five more was corrected downward. The final count is **16 confirmed
bugs**, not the 23 candidates that were initially reported.

Every finding below was reproduced by running the code against the real
`dynamoose` public API, not by reading it. The discovery suite lives in
`packages/dynamoose/test/pbt/` and is organised so that each confirmed bug has a
named, self-contained failing test.

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

```js
Model.query("id").eq(1).parenthesis((c) => c.where("id").eq(2)).getRequest()
// TypeError: Cannot read properties of undefined (reading 'includes')
```

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
- The `dynamoose-logger` package was not investigated.
- `Schema` custom types (`get`/`set`/`validate` modifiers) were covered only
  shallowly.

## Suggested order of work

Findings 1–3 are user-visible failures on ordinary, documented API usage. They
should come first. Findings 4–5 are silent data loss and should come next.
Findings 7, 10 and 14 are hardening items.

Per `AGENTS.md`, every change must be reviewed and approved by a human before
being submitted upstream, and any AI involvement must be disclosed in the PR
description. This work has not been submitted anywhere.