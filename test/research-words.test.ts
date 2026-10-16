import { test } from "node:test";
import assert from "node:assert/strict";
import { asksEconomy, asksFilings, HINT_CHARS } from "../src/lib/research-words.ts";

test("a public company's filings or reported figures hint the SEC EDGAR tools", () => {
  for (const message of [
    "What was Apple's revenue for the last 3 years?",
    "AAPL 10-K",
    "Summarise Tesla's latest 10-Q",
    "Tesla revenue 2024",
    "revenue of NVDA",
    "What's Alphabet's EPS?",
    "Microsoft's quarterly earnings",
    "Show me Amazon net income",
    "Find Nvidia's annual report",
    "Coca-Cola's dividends per share",
    "Any insider selling at Meta?",
    "Pull the SEC filings for Palantir",
    "How much cash does Berkshire Hathaway Inc have on its balance sheet?",
  ]) {
    assert.equal(asksFilings(message), true, message);
  }
});

test("figures about everyone's business, or a word alone, don't", () => {
  for (const message of [
    "How can I grow my company's revenue?",
    "What is EPS?",
    "Our Q3 sales dropped, what should I do?",
    "last year's sales were bad, write an email to the team",
    "Write a poem about the sea",
    "What's the revenue model of a SaaS business?",
    "Explain gross margin like I'm five",
    "How do I read an income statement?",
    "My shop's profits are down",
  ]) {
    assert.equal(asksFilings(message), false, message);
  }
});

test("economic indicators hint the FRED tools", () => {
  for (const message of [
    "Show me the US unemployment rate trend",
    "What is the latest CPI inflation?",
    "How has GDP grown since 2020?",
    "What's the fed funds rate now?",
    "10-year Treasury yield this month",
    "Are mortgage rates going down?",
    "Is the US in a recession?",
  ]) {
    assert.equal(asksEconomy(message), true, message);
  }
  for (const message of ["Write a story about a dragon", "How do I bake bread?", "Translate 'good morning' into French"]) {
    assert.equal(asksEconomy(message), false, message);
  }
});

test("only the start of a long message is read", () => {
  const long = `${"a ".repeat(HINT_CHARS)} What was Apple's revenue? unemployment rate`;
  assert.equal(asksFilings(long), false);
  assert.equal(asksEconomy(long), false);
});
