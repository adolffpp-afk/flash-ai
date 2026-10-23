import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./support/route-hooks.mjs", import.meta.url);

/*
 * The Automations editor's form (src/lib/automation-form.ts): a new form's defaults, every repeat
 * saved as a spec the server accepts and shown again as the same form, specs the form can't show left
 * alone (null), why a form can't be saved yet, and the templates the empty panel offers.
 */
const F = await import("../src/lib/automation-form.ts");
const A = await import("../src/lib/automations.ts");
const { wallClock } = await import("../src/lib/schedule.ts");
type Form = import("../src/lib/automation-form.ts").AutomationForm;
type Spec = import("../src/lib/automations.ts").Spec;

const NOW = Date.UTC(2026, 9, 23, 16, 0);
const ZONE = "America/Toronto";
const form = (more: Partial<Form>): Form => ({ ...F.blankForm(ZONE, NOW), name: "Morning note", prompt: "Write one line about the weather.", ...more });
const accepted = (spec: Spec) => {
  const parsed = A.parseSpec(JSON.parse(JSON.stringify(spec)));
  assert.ok("spec" in parsed, JSON.stringify(parsed));
  return parsed.spec;
};

test("a new form: every day at 8:00 in the browser's zone, Write at Ascend, a one-off set to tomorrow there", () => {
  const f = F.blankForm(ZONE, NOW);
  const tomorrow = wallClock(NOW + 86_400_000, ZONE);
  assert.deepEqual([f.repeat, f.at, f.mode, f.level, f.timeZone, f.data, f.onlyIfChanged], ["daily", "08:00", "write", "ascend", ZONE, false, false]);
  assert.equal(f.date, "2026-10-24");
  assert.deepEqual(f.days, [tomorrow.weekday]);
  assert.equal(F.formProblem(f), F.NEEDS_NAME, "not until it has a name");
});

test("every repeat saves as a spec the server accepts, and shows again as the same form", () => {
  const cases: [Partial<Form>, Spec["trigger"]][] = [
    [{ repeat: "once", date: "2026-11-02", at: "09:30" }, { type: "schedule", when: { kind: "once", date: "2026-11-02", at: "09:30" } }],
    [{ repeat: "daily", at: "07:15" }, { type: "schedule", when: { kind: "daily", at: "07:15" } }],
    [{ repeat: "weekdays", at: "06:00" }, { type: "schedule", when: { kind: "daily", at: "06:00", weekdays: true } }],
    [{ repeat: "weekly", days: [5, 1, 5], at: "18:00" }, { type: "schedule", when: { kind: "weekly", days: [1, 5], at: "18:00" } }],
    [{ repeat: "monthly", day: 15, at: "10:00" }, { type: "schedule", when: { kind: "monthly", day: 15, at: "10:00" } }],
    [{ repeat: "monthly", day: "last", at: "23:00" }, { type: "schedule", when: { kind: "monthly", day: "last", at: "23:00" } }],
    [{ repeat: "hourly", every: 3, from: "09:00", to: "17:00" }, { type: "schedule", when: { kind: "hourly", every: 3, from: "09:00", to: "17:00" } }],
    [{ repeat: "manual" }, { type: "manual" }],
  ];
  for (const [more, trigger] of cases) {
    const f = form({ mode: "research", level: "vision", data: true, onlyIfChanged: true, ...more });
    const spec = accepted(F.specFromForm(f, { economy: true }));
    assert.deepEqual(spec.trigger, trigger, more.repeat);
    assert.deepEqual(spec.steps, [
      { id: "a1", do: "ai", mode: "research", level: "vision", prompt: f.prompt, data: { filings: true, economy: true }, onlyIfChanged: true },
      { id: "n1", do: "notify" },
    ]);
    const back = F.formFromSpec(spec, f.name, ZONE, NOW);
    assert.ok(back, more.repeat);
    // What the spec says comes back; the rest is the new form's.
    const shown = more.repeat === "weekly" ? { ...f, days: [1, 5] } : f;
    assert.deepEqual(back, shown, more.repeat);
  }
});

test("the spec keeps only what was asked: no data or only-if-changed unless ticked, economy only where Flash has it, the prompt trimmed to its limit", () => {
  const plain = F.specFromForm(form({ prompt: "  Hello.  " }), { economy: true }).steps[0];
  assert.deepEqual(plain, { id: "a1", do: "ai", mode: "write", level: "ascend", prompt: "Hello." });
  const filings = F.specFromForm(form({ data: true }), { economy: false }).steps[0];
  assert.deepEqual("data" in filings && filings.data, { filings: true });
  const long = F.specFromForm(form({ prompt: "x".repeat(A.MAX_PROMPT_CHARS + 50) }), { economy: false }).steps[0];
  assert.equal("prompt" in long && long.prompt.length, A.MAX_PROMPT_CHARS);
  accepted(F.specFromForm(form({ prompt: "x".repeat(A.MAX_PROMPT_CHARS + 50) }), { economy: false }));
});

test("a spec the form can't show is null, so the editor never saves it as something else", () => {
  const ai = { id: "a1", do: "ai" as const, mode: "write" as const, level: "ascend" as const, prompt: "One." };
  const two: Spec = { v: 1, trigger: { type: "manual" }, steps: [ai, { ...ai, id: "a2", prompt: "Two." }, { id: "n1", do: "notify" }] };
  const worded: Spec = { v: 1, trigger: { type: "manual" }, steps: [ai, { id: "n1", do: "notify", text: "Done: {{a1}}" }] };
  const none: Spec = { v: 1, trigger: { type: "manual" }, steps: [{ id: "n1", do: "notify" }] };
  for (const spec of [two, worded, none]) assert.equal(F.formFromSpec(spec, "x", ZONE, NOW), null);
  assert.ok(F.formFromSpec({ v: 1, trigger: { type: "manual" }, steps: [ai, { id: "n1", do: "notify" }] }, "x", ZONE, NOW));
});

test("why a form can't be saved yet", () => {
  assert.equal(F.formProblem(form({ name: "   " })), F.NEEDS_NAME);
  assert.equal(F.formProblem(form({ name: "x".repeat(A.MAX_NAME_CHARS + 1) })), F.NEEDS_NAME);
  assert.equal(F.formProblem(form({ prompt: " \n " })), F.NEEDS_PROMPT);
  assert.equal(F.formProblem(form({ repeat: "weekly", days: [] })), F.NEEDS_DAYS);
  assert.equal(F.formProblem(form({ repeat: "daily", days: [] })), "", "days only matter weekly");
  assert.equal(F.formProblem(form({ repeat: "hourly", from: "18:00", to: "09:00" })), F.HOURS_ORDER);
  assert.equal(F.formProblem(form({ repeat: "hourly", from: "09:00", to: "09:00" })), "");
  assert.equal(F.formProblem(form({})), "");
});

test("each template fills a form the server accepts, with a part in brackets for its owner to fill in", () => {
  assert.equal(new Set(F.AUTOMATION_TEMPLATES.map((x) => x.id)).size, F.AUTOMATION_TEMPLATES.length);
  for (const x of F.AUTOMATION_TEMPLATES) {
    assert.match(x.prompt, /\[[^\]]+\]/, x.id);
    const f = form({ name: x.title, prompt: x.prompt, ...x.fill });
    assert.equal(F.formProblem(f), "", x.id);
    const spec = accepted(F.specFromForm(f, { economy: Boolean(x.economy) }));
    assert.deepEqual(F.formFromSpec(spec, f.name, ZONE, NOW), f, x.id);
  }
  const economy = F.AUTOMATION_TEMPLATES.find((x) => x.economy)!;
  const step = F.specFromForm(form({ prompt: economy.prompt, ...economy.fill }), { economy: true }).steps[0];
  assert.deepEqual("data" in step && step.data, { filings: true, economy: true });
});
