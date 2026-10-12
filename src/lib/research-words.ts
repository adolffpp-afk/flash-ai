/*
 * The words that hint a message wants official data (see research.ts for the tools). Pure, no imports.
 * Like the weather words' hint tier (weather-words.ts), these never decide the engine: they only give
 * the engine that answers in words the matching tools.
 * - asksFilings: a public company's SEC filings or reported figures ("Apple's revenue", "AAPL 10-K",
 *   "Tesla net income last 3 years"), for the SEC EDGAR tools.
 * - asksEconomy: an economic indicator (inflation, CPI, unemployment, GDP, interest rates, Treasury
 *   yields, mortgage rates), for the FRED tools.
 * Every pattern reads the message once from the start (test/hostile-patterns.test.ts), and only its
 * first HINT_CHARS characters are read: the question is at the start of a message.
 */

export const HINT_CHARS = 2000;

// Filings by name: "10-K", "the latest 8-K", "SEC filings", "EDGAR", "annual report", "proxy statement".
const FILINGS =
  /\b(?:10-?[kq]s?|8-?ks?|20-?fs?|40-?f|6-?k|s-1|def 14a|sec filings?|filings? with the sec|edgar|annual reports?|quarterly reports?|earnings reports?|earnings releases?|proxy statements?|insider (?:buying|selling|trades|trading))\b/i;
// Figures a company reports: revenue, net income, earnings per share, its balance sheet.
const FIGURES = String.raw`(?:revenues?|sales|net (?:income|profit|loss|earnings)|earnings|eps|earnings per share|operating (?:income|profit|margin|cash flow)|gross (?:profit|margin)|profit margin|profits?|free cash flow|cash flow|balance sheet|income statement|total assets|total liabilities|(?:shareholders|stockholders)'? equity|long-term debt|total debt|research and development|r&d|capex|capital expenditures?|dividends? per share|shares outstanding|financials|financial (?:results|statements?|figures|data))`;
const FIGURE = new RegExp(String.raw`\b${FIGURES}\b`, "i");
// The words that make a company of a name: "Inc", "Corp", a stock exchange, "publicly traded", "$TSLA".
const LISTED = /\b(?:inc|corp|corporation|ltd|plc|nyse|nasdaq|ticker|publicly traded|public company|listed company)\b|\$[a-z]{1,5}\b/i;
// Words that own a figure in everyone's business, not a company's name ("my company's sales", "What's the revenue").
const NOT_A_NAME = String.raw`(?:what|that|it|there|here|let|he|she|who|where|how|one|everyone|someone|today|year|month|quarter|week|company|business|shop|store|restaurant|startup|firm|brand|client|customer|family|wife|husband|team|country|world|nation)`;
// A name's possessive before a figure: "Apple's revenue", "nvidia's last quarterly earnings".
const OWNED = new RegExp(
  String.raw`(?<![\p{L}\p{N}'’])(?!${NOT_A_NAME}['’]s\b)[\p{L}\p{N}&.-]{2,40}['’]s (?:(?:annual|quarterly|yearly|total|latest|last|reported|recent|q[1-4]|fy ?\d{2,4}|\d{4}) ){0,2}${FIGURES}\b`,
  "iu",
);
// Capitalised words that aren't a company's name: questions, instructions and the words around a figure.
const NOT_NAMED = String.raw`(?:What|Whats|How|Why|When|Where|Which|Who|Is|Are|Does|Do|Did|Can|Could|Should|Will|Would|Explain|Show|Give|Tell|Compare|Calculate|Define|List|Find|Get|Describe|Summari[sz]e|Compute|Estimate|Increase|Improve|Boost|Track|Analy[sz]e|Write|Create|Make|Help|Check|Plan|Project|Forecast|Report|Predict|Draft|Build|Raise|Grow|Lower|Reduce|Cut|Understand|About|And|Or|For|Of|In|On|With|Total|Annual|Net|Our|My|Your|Their|His|Her|Its|The|This|That|These|Those|Quarterly|Gross|Monthly|Yearly|Projected|Expected|Average|Daily|Weekly|Operating|Free|Cash|Last|Next|Sales|Revenue|Company|Business)`;
// A capitalised name right before a figure: "Tesla revenue", "Amazon net income".
const NAMED = new RegExp(String.raw`(?<![\p{L}\p{N}])(?!${NOT_NAMED}\b)\p{Lu}[\p{L}&.-]{1,30} ${FIGURES}\b`, "u");
// A ticker in capitals next to a figure or a filing: "AAPL revenue", "revenue of NVDA". Case-sensitive,
// so ordinary capitals ("GDP", "CEO", "USA") are left out by name.
const TICKER =
  /(?<![A-Za-z0-9])(?!(?:GDP|CPI|EPS|CEO|CFO|CTO|USA|USD|EUR|GBP|SEC|IRS|LLC|INC|LTD|PLC|FY|AI|UK|US|EU|OK|PDF|CSV|ROI|KPI|YOY|QOQ|TTM|EBIT|EBITDA|FCF|PE|IPO|ETF|API|URL|FAQ|HR|PR|IT|ASAP|FYI|TV|SUV|NGO)(?![A-Za-z0-9]))[A-Z]{2,5}(?:\.[A-Z])?(?![A-Za-z0-9])/;

/** A public company's SEC filings or reported figures: the engine that answers gets the SEC EDGAR tools. */
export function asksFilings(whole: string): boolean {
  const message = whole.length > HINT_CHARS ? whole.slice(0, HINT_CHARS) : whole;
  if (FILINGS.test(message)) return true;
  if (!FIGURE.test(message)) return false;
  return OWNED.test(message) || NAMED.test(message) || LISTED.test(message) || TICKER.test(message);
}

// Economic indicators FRED has, by the names people use.
const ECONOMY =
  /\b(?:cpi|consumer price index|inflation(?: rate)?|core inflation|pce(?: inflation| price index)?|ppi|producer price index|unemployment(?: rate)?|jobless (?:rate|claims)|initial claims|nonfarm payrolls?|payrolls|jobs report|labou?r force participation|gdp|gross domestic product|real gdp|fed(?:eral)? funds(?: rate)?|interest rates?|policy rate|prime rate|treasury (?:yields?|rates?|bills?|bonds?|notes?)|(?:2|5|10|30)[- ]year (?:treasury|yield|bond yield)|yield curve|mortgage rates?|money supply|m2 money|consumer sentiment|housing starts|retail sales|industrial production|personal saving rate|economic indicators?|recession)\b/i;

/** An economic indicator: the engine that answers gets the FRED tools (when FRED_API_KEY is set). */
export function asksEconomy(whole: string): boolean {
  const message = whole.length > HINT_CHARS ? whole.slice(0, HINT_CHARS) : whole;
  return ECONOMY.test(message);
}
