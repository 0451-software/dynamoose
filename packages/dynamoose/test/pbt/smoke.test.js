const {fc, runProperty} = require("./_helpers");

describe("pbt harness smoke", () => {
	it("runs fast-check properties inside jest", () => {
		runProperty(fc.property(fc.integer(), (n) => n + 1 === n + 1), {"numRuns": 50, "label": "smoke"});
	});

	it("shrinks and reports counterexamples", () => {
		// Deliberately failing property, to prove failures surface (not to be committed).
		const broken = fc.property(fc.integer(), (n) => n < 100);
		expect(() => fc.assert(broken, {"numRuns": 1000})).toThrow();
	});
});
