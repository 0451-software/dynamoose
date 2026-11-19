// Shared support code for the `condition_*` property-based discovery suites.
//
// NOTE: this file lives under `packages/dynamoose/test/` so jest's `testMatch`
// (`**/test/**/*.[jt]s?(x)`) treats it as a test suite. It therefore contains one
// real test (a self-check of the parser) so jest does not complain about an
// empty suite. Other suites `require("./condition_support.test.js")` to reuse
// the independent expression parser.

const dynamoose = require("../../dist");
const {internalProperties} = require("../../dist/Internal").default.General;
const {fc} = require("./_helpers");

/**
 * `runProperty` from `_helpers.js` is synchronous, so it cannot be used with
 * `fc.asyncProperty` (the returned promise is not awaited and the rejection
 * escapes the test runner). This is the awaited equivalent.
 */
const runAsyncProperty = async (property, options = {}) => {
	const {numRuns = 200, seed} = options;
	const params = {numRuns};
	if (seed !== undefined) {
		params.seed = seed;
	}
	await fc.assert(property, params);
};

const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Tokenize a DynamoDB expression into an independent token stream.
 * This deliberately does NOT reuse any of dynamoose's own regexes.
 */
const tokenize = (expression) => {
	const tokens = [];
	let i = 0;
	while (i < expression.length) {
		const c = expression[i];
		if (/\s/.test(c)) {
			i += 1;
			continue;
		}
		if (c === "(" || c === ")" || c === ",") {
			tokens.push({"kind": c, "value": c});
			i += 1;
			continue;
		}
		if (c === "#" || c === ":") {
			let j = i + 1;
			while (j < expression.length && WORD_CHAR.test(expression[j])) {
				j += 1;
			}
			if (j === i + 1) {
				throw new Error(`Dangling placeholder '${c}' at index ${i} of: ${expression}`);
			}
			tokens.push({"kind": c === "#" ? "name" : "value", "value": expression.slice(i, j)});
			i = j;
			continue;
		}
		if ("<>=".includes(c)) {
			let j = i;
			while (j < expression.length && "<>=".includes(expression[j])) {
				j += 1;
			}
			tokens.push({"kind": "comparator", "value": expression.slice(i, j)});
			i = j;
			continue;
		}
		let j = i;
		while (j < expression.length && WORD_CHAR.test(expression[j])) {
			j += 1;
		}
		if (j === i) {
			throw new Error(`Unexpected character '${c}' at index ${i} of: ${expression}`);
		}
		tokens.push({"kind": "word", "value": expression.slice(i, j)});
		i = j;
	}
	return tokens;
};

/**
 * A recursive-descent parser for the DynamoDB condition-expression grammar.
 *
 *   expression := andExpr (OR andExpr)*
 *   andExpr    := condition (AND condition)*
 *   condition  := NOT condition
 *               | '(' expression ')'
 *               | 'attribute_exists' '(' operand ')'
 *               | 'attribute_not_exists' '(' operand ')'
 *               | 'contains' '(' operand ',' operand ')'
 *               | 'begins_with' '(' operand ',' operand ')'
 *               | operand ('='|'<>'|'<'|'<='|'>'|'>=') operand
 *               | operand BETWEEN operand AND operand
 *               | operand IN '(' operand (',' operand)* ')'
 *   operand    := '#name' | ':value'
 */
class ConditionExpressionParser {
	constructor (expression) {
		this.expression = expression;
		this.tokens = tokenize(expression);
		this.pos = 0;
		this.names = [];
		this.values = [];
	}

	peek () {
		return this.tokens[this.pos];
	}

	consume () {
		const token = this.tokens[this.pos];
		this.pos += 1;
		return token;
	}

	expect (kind, value) {
		const token = this.peek();
		if (!token || token.kind !== kind || (value !== undefined && token.value !== value)) {
			throw new Error(`Expected ${kind}${value === undefined ? "" : ` '${value}'`} but got ${JSON.stringify(token)} in: ${this.expression}`);
		}
		return this.consume();
	}

	parse () {
		const tree = this.parseOr();
		if (this.pos !== this.tokens.length) {
			throw new Error(`Trailing tokens ${JSON.stringify(this.tokens.slice(this.pos))} in: ${this.expression}`);
		}
		return tree;
	}

	parseOr () {
		let left = this.parseAnd();
		while (this.peek() && this.peek().kind === "word" && this.peek().value === "OR") {
			this.consume();
			left = {"kind": "or", "left": left, "right": this.parseAnd()};
		}
		return left;
	}

	parseAnd () {
		let left = this.parseCondition();
		while (this.peek() && this.peek().kind === "word" && this.peek().value === "AND") {
			this.consume();
			left = {"kind": "and", "left": left, "right": this.parseCondition()};
		}
		return left;
	}

	parseCondition () {
		const token = this.peek();
		if (!token) {
			throw new Error(`Unexpected end of expression: ${this.expression}`);
		}
		if (token.kind === "word" && token.value === "NOT") {
			this.consume();
			return {"kind": "not", "operand": this.parseCondition()};
		}
		if (token.kind === "(") {
			this.consume();
			const inner = this.parseOr();
			this.expect(")");
			return {"kind": "group", "operand": inner};
		}
		if (token.kind === "word" && ["attribute_exists", "attribute_not_exists"].includes(token.value)) {
			this.consume();
			this.expect("(");
			const arg = this.parseOperand();
			this.expect(")");
			return {"kind": "function", "name": token.value, "args": [arg]};
		}
		if (token.kind === "word" && ["contains", "begins_with"].includes(token.value)) {
			this.consume();
			this.expect("(");
			const first = this.parseOperand();
			this.expect(",");
			const second = this.parseOperand();
			this.expect(")");
			return {"kind": "function", "name": token.value, "args": [first, second]};
		}
		const left = this.parseOperand();
		const next = this.peek();
		if (next && next.kind === "word" && next.value === "BETWEEN") {
			this.consume();
			const lower = this.parseOperand();
			this.expect("word", "AND");
			const upper = this.parseOperand();
			return {"kind": "between", "operand": left, "lower": lower, "upper": upper};
		}
		if (next && next.kind === "word" && next.value === "IN") {
			this.consume();
			this.expect("(");
			const items = [this.parseOperand()];
			while (this.peek() && this.peek().kind === ",") {
				this.consume();
				items.push(this.parseOperand());
			}
			this.expect(")");
			return {"kind": "in", "operand": left, "items": items};
		}
		if (next && next.kind === "comparator") {
			this.consume();
			return {"kind": "compare", "operator": next.value, "left": left, "right": this.parseOperand()};
		}
		throw new Error(`Unexpected token ${JSON.stringify(next)} in: ${this.expression}`);
	}

	parseOperand () {
		const token = this.peek();
		if (!token || (token.kind !== "name" && token.kind !== "value")) {
			throw new Error(`Expected a placeholder but got ${JSON.stringify(token)} in: ${this.expression}`);
		}
		this.consume();
		if (token.kind === "name") {
			this.names.push(token.value);
		} else {
			this.values.push(token.value);
		}
		return token;
	}
}

/**
 * Parse an expression. Throws (with a descriptive message) when the expression
 * is not a syntactically valid DynamoDB condition expression.
 */
const parseExpression = (expression) => {
	const parser = new ConditionExpressionParser(expression);
	const tree = parser.parse();
	return {"tree": tree, "names": parser.names, "values": parser.values};
};

/**
 * Map a parsed expression tree back onto the dynamoose "comparison type"
 * names (EQ / NE / LT / ... / BETWEEN / IN / CONTAINS / ...).
 */
const treeToComparisonType = (tree) => {
	switch (tree.kind) {
	case "compare":
		return {"=": "EQ", "<>": "NE", "<": "LT", "<=": "LE", ">": "GT", ">=": "GE"}[tree.operator];
	case "between":
		return "BETWEEN";
	case "in":
		return "IN";
	case "function":
		return {"contains": "CONTAINS", "attribute_exists": "EXISTS", "attribute_not_exists": "NOT_EXISTS", "begins_with": "BEGINS_WITH"}[tree.name];
	case "not": {
		const inner = treeToComparisonType(tree.operand);
		return {"EQ": "NE", "NE": "EQ", "LT": "GE", "GE": "LT", "LE": "GT", "GT": "LE", "CONTAINS": "NOT_CONTAINS", "NOT_CONTAINS": "CONTAINS", "EXISTS": "NOT_EXISTS", "NOT_EXISTS": "EXISTS"}[inner];
	}
	default:
		return undefined;
	}
};

/**
 * Collect every `#name` / `:value` reference that appears anywhere inside the
 * given request object (KeyConditionExpression, FilterExpression,
 * ProjectionExpression, ...).
 */
const collectReferences = (request) => {
	const names = new Set();
	const values = new Set();
	["KeyConditionExpression", "FilterExpression", "ProjectionExpression", "ConditionExpression"].forEach((key) => {
		const expression = request[key];
		if (typeof expression !== "string") {
			return;
		}
		tokenize(expression).forEach((token) => {
			if (token.kind === "name") {
				names.add(token.value);
			} else if (token.kind === "value") {
				values.add(token.value);
			}
		});
	});
	return {"names": [...names], "values": [...values]};
};

/**
 * Compare the placeholders referenced by an expression against the
 * ExpressionAttributeNames / ExpressionAttributeValues maps of a request.
 * Returns a list of human readable problems (empty list == consistent).
 */
const placeholderProblems = (request) => {
	const problems = [];
	const names = request.ExpressionAttributeNames || {};
	const values = request.ExpressionAttributeValues || {};
	const references = collectReferences(request);

	references.names.forEach((name) => {
		if (!Object.prototype.hasOwnProperty.call(names, name)) {
			problems.push(`referenced name ${name} is missing from ExpressionAttributeNames`);
		}
	});
	references.values.forEach((value) => {
		if (!Object.prototype.hasOwnProperty.call(values, value)) {
			problems.push(`referenced value ${value} is missing from ExpressionAttributeValues`);
		} else if (values[value] === undefined) {
			problems.push(`referenced value ${value} is undefined in ExpressionAttributeValues`);
		}
	});
	Object.keys(names).forEach((name) => {
		if (!references.names.includes(name)) {
			problems.push(`ExpressionAttributeNames entry ${name} is never referenced`);
		}
	});
	Object.keys(values).forEach((value) => {
		if (!references.values.includes(value)) {
			problems.push(`ExpressionAttributeValues entry ${value} is never referenced`);
		}
	});
	return problems;
};

/**
 * Returns true when the expression is a syntactically valid DynamoDB
 * condition expression.
 */
const canParseExpression = (expression) => {
	try {
		parseExpression(expression);
		return true;
	} catch (e) {
		return false;
	}
};

describe("pbt: support (independent DynamoDB expression parser)", () => {
	it("parses valid expressions and rejects invalid ones", () => {
		expect(canParseExpression("#a0 = :v0")).toBe(true);
		expect(canParseExpression("#a0 = :v0 AND #a1 = :v1")).toBe(true);
		expect(canParseExpression("#a0 = :v0 OR (#a1 = :v1 AND #a2 = :v2)")).toBe(true);
		expect(canParseExpression("#a0 BETWEEN :v0_1 AND :v0_2")).toBe(true);
		expect(canParseExpression("#a0 IN (:v0_1, :v0_2)")).toBe(true);
		expect(canParseExpression("attribute_exists (#a0)")).toBe(true);
		expect(canParseExpression("attribute_not_exists (#a0)")).toBe(true);
		expect(canParseExpression("NOT contains (#a0, :v0)")).toBe(true);
		expect(canParseExpression("begins_with (#a0, :v0)")).toBe(true);

		expect(canParseExpression("#a0 IN ()")).toBe(false);
		expect(canParseExpression("#a0 = :v0 AND AND #a1 = :v1")).toBe(false);
		expect(canParseExpression("OR #a0 = :v0")).toBe(false);
		expect(canParseExpression("#a0 = ")).toBe(false);
		expect(canParseExpression("()")).toBe(false);
	});

	it("extracts the referenced placeholders", () => {
		const parsed = parseExpression("#a0 BETWEEN :v0_1 AND :v0_2");
		expect(parsed.names).toEqual(["#a0"]);
		expect(parsed.values).toEqual([":v0_1", ":v0_2"]);
	});
});

module.exports = {
	dynamoose,
	internalProperties,
	runAsyncProperty,
	tokenize,
	parseExpression,
	canParseExpression,
	treeToComparisonType,
	collectReferences,
	placeholderProblems
};
