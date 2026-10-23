import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

/*
 * Every request the page makes to an automation route that changes something sends a JSON body: the
 * routes refuse a write without one as not from Flash's own page (see gate in automation-api.ts and
 * fromOwnPage in auth.ts), so a Delete without one said "Please use Flash's own page." and deleted
 * nothing. Read from the components as written, so a new button can't send one without.
 */
const dir = new URL("../src/components/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

test("every write to an automation route from the page sends JSON", () => {
  const writes: string[] = [];
  const bare: string[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, dir), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments.length >= 2) {
        const [path, init] = node.arguments;
        const address = ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path) ? path.text : ts.isTemplateExpression(path) ? path.head.text : "";
        if (address.startsWith("/api/automations") && ts.isObjectLiteralExpression(init)) {
          const names = init.properties.map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : ""));
          const method = init.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "method");
          const verb = method && ts.isStringLiteral(method.initializer) ? method.initializer.text : "GET";
          if (verb !== "GET") {
            const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${verb} ${address}`;
            writes.push(where);
            if (!names.includes("json")) bare.push(where);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(writes.some((w) => w.includes("AutomationsPanel.tsx") && w.includes("DELETE")), writes.join("\n"));
  assert.ok(writes.length >= 15, `found ${writes.length} writes`);
  assert.deepEqual(bare, []);
});
