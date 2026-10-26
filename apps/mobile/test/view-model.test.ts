import test from "node:test";
import assert from "node:assert/strict";
import { formula, inputValues, resolve, scope } from "../src/logic/view-model.ts";

test("view formulas use only scoped inputs and resolve calculated values", () => {
  const view = { type: "stack", let: { subtotal: "price * amount" }, children: [
    { type: "number", id: "price", value: 12 },
    { type: "slider", id: "amount", min: 1, value: 3 },
    { type: "metric", label: "Total", value: { "=": "format(subtotal * 1.1, 2)" } },
  ] };
  const values = inputValues(view);
  assert.deepEqual({ ...values }, { price: 12, amount: 3 });
  assert.equal(resolve(view.children[2].value, scope(view, values)), "39.60");
  assert.equal(formula("amount > 2 ? 'many' : 'one'", scope(view, values)), "many");
});

test("expressions cannot reach JavaScript properties, globals or constructors", () => {
  for (const expression of ["globalThis", "price.constructor", "price['secret']", "eval(1)", "(function(){})()", "price; 42"]) {
    assert.equal(formula(expression, { price: 12 }), undefined, expression);
  }
  assert.equal(formula("1 / 0", {}), undefined);
  assert.equal(formula("10 % 3 + 2 * 4", {}), 9);
});
