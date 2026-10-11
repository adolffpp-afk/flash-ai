import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITS_BUILD, WEATHER_TERMS, asksWeather, weatherQuestion } from "../src/lib/weather-words.ts";
import { LANGUAGES } from "../src/lib/languages.ts";
import { A, B, C, DIAGNOSIS } from "./fixtures/weather-messages.ts";

// firm: the router answers it with text and the forecast; hint: a weather word, which the guess decides on; none.
const tier = (m: string) => (weatherQuestion(m) ? "firm" : asksWeather(m) ? "hint" : "none");
const firm = (list: { q: string }[]) => list.map((m) => m.q).filter(weatherQuestion);

test("no ordinary message or trap is taken for a forecast question, except two known ones", () => {
  const ordinary = [
    ...A.EVERYDAY,
    ...A.TRAPS,
    ...A.CLOCK,
    ...B.ORDINARY_EN,
    ...B.ORDINARY_OTHER,
    ...B.BY_DESIGN,
    ...C.BLIND.filter((m) => m.intent !== "weather"),
  ];
  assert.equal(ordinary.length, 72 + 73 + 5 + 89 + 54 + 9 + 38);
  // "When does mango season come?" and "How does weather forecasting work?": known, and answered in words
  // anyway. The translation's words are a forecast question, but the translation rule comes first.
  assert.deepEqual(firm(ordinary), ["Translate 'will it rain tomorrow' into Spanish", "आम का मौसम कब आता है?", "天气预报的原理是什么？"]);
});

test("no request to draw, translate, write a song or poem, or make a document is a forecast question, in any language", () => {
  const making = [
    ...B.ORDINARY_EN.filter((m) => m.intent !== "text" && m.intent !== "search" && m.intent !== "clock"),
    ...B.ORDINARY_OTHER.filter((m) => m.intent !== "text"),
    ...C.BLIND.filter((m) => ["image", "translate", "docs", "music", "code"].includes(m.intent)),
    ...A.TRAPS.filter((m) => /song|poem|caption|template/.test(m.note ?? "")),
    ...B.ORDINARY_OTHER.filter((m) => /chanson|poema|poème|стих|कविता|কবিতা|诗|詩|shairi|Gedicht/.test(m.q)),
  ];
  assert.ok(making.length >= 40, `${making.length}`);
  // The words of this one are a forecast question, but the translation rule comes first (see router.test.ts).
  assert.deepEqual(firm(making), ["Translate 'will it rain tomorrow' into Spanish"]);
});

test("every weather question in set A gets the forecast or the hint, and the measured numbers hold", () => {
  assert.deepEqual(
    A.WEATHER.filter((m) => tier(m.q) === "none").map((m) => m.q),
    [],
  );
  const count = (list: { q: string }[]) => {
    const t = { firm: 0, hint: 0, none: 0 };
    for (const m of list) t[tier(m.q)]++;
    return t;
  };
  // Set A was tuned on; B was written by another checker; C was never tuned on (report its numbers separately).
  assert.deepEqual(count(A.WEATHER), { firm: 66, hint: 1, none: 0 });
  assert.deepEqual(count(B.WEATHER), { firm: 68, hint: 7, none: 0 });
  assert.deepEqual(count(C.BLIND.filter((m) => m.intent === "weather")), { firm: 26, hint: 1, none: 8 });
});

test("the 63 questions the design started from: 46 forecast questions, 8 hints, 9 neither", () => {
  assert.equal(DIAGNOSIS.length, 63);
  const by = (t: string) => DIAGNOSIS.filter((m) => tier(m) === t);
  assert.equal(by("firm").length, 46);
  // With 5 credits or more these go to the router's guess; below that they get the forecast tool.
  assert.deepEqual(by("hint"), [
    "Is it safe to drive to Ottawa tomorrow with the snow?",
    "Is it hot in Lagos? Answer in French",
    "Make a packing list for Paris based on this week's weather",
    "Plan my weekend in Montreal around the weather",
    "How warm is the sea in Nice?",
    "Has it stopped snowing in Toronto?",
    "météo à Montréal demain",
    "pronóstico del clima para Ciudad de México",
  ]);
  // Warnings, air quality and sunset aren't in a forecast; the email is other work; follow-ups need the earlier message.
  assert.deepEqual(by("none"), [
    "Any hurricane warnings for Florida?",
    "air quality in Delhi",
    "What time is sunset in Paris?",
    "Write an email to my team about tomorrow's snowstorm closing the office",
    "and tomorrow?",
    "what about Saturday?",
    "and in Abuja?",
    "in Fahrenheit please",
    "hourly?",
  ]);
  assert.equal(weatherQuestion("How warm is the sea in Nice?"), false);
});

// Two questions in each of Flash's 30 languages, from sets A and B; where those share their one
// question for a language, the second was written for this test (and not tuned on).
const BY_LANGUAGE: Record<string, [string, string]> = {
  en: ["Will it rain tomorrow?", "how's the weather"],
  fr: ["Quel temps fait-il à Paris ?", "Est-ce qu'il va pleuvoir demain ?"],
  es: ["¿Va a llover mañana en Bogotá?", "¿Qué tiempo hace en Madrid?"],
  pt: ["Vai chover amanhã em São Paulo?", "Está chovendo no Rio agora?"],
  de: ["Wie wird das Wetter morgen in Berlin?", "Regnet es gerade in Hamburg?"],
  it: ["Che tempo farà domani a Roma?", "Domani piove a Milano?"],
  nl: ["Hoe wordt het weer morgen?", "Hoe wordt het weer morgen in Amsterdam?"],
  pl: ["Jaka będzie pogoda jutro w Warszawie?", "Czy jutro będzie padać w Krakowie?"],
  tr: ["İstanbul'da yarın hava nasıl?", "Bugün Ankara'da hava nasıl?"],
  ru: ["Какая погода в Москве завтра?", "Завтра будет дождь в Петербурге?"],
  uk: ["Яка погода завтра в Києві?", "Чи буде дощ у Львові завтра?"],
  ar: ["هل ستمطر غدا في القاهرة؟", "ما هو الطقس في دبي اليوم؟"],
  he: ["מה מזג האוויר מחר בתל אביב?", "יירד גשם מחר בירושלים?"],
  fa: ["هوا فردا در تهران چطور است؟", "آب و هوای شیراز امروز چطوره؟"],
  hi: ["क्या कल मुंबई में बारिश होगी?", "आज दिल्ली में मौसम कैसा है?"],
  bn: ["কাল ঢাকায় বৃষ্টি হবে?", "আজ চট্টগ্রামের আবহাওয়া কেমন?"],
  ur: ["کل لاہور میں موسم کیسا ہوگا؟", "کیا آج کراچی میں بارش ہوگی؟"],
  "zh-Hans": ["北京明天天气怎么样？", "上海今天会下雨吗？"],
  "zh-Hant": ["台北明天會下雨嗎？", "高雄今天天氣如何？"],
  ja: ["明日の東京の天気は？", "明日は雨が降りますか？"],
  ko: ["내일 서울 날씨 어때?", "부산 오늘 비 와?"],
  id: ["Cuaca di Jakarta besok?", "Apakah besok akan hujan di Bandung?"],
  vi: ["Thời tiết Hà Nội ngày mai thế nào?", "Hôm nay ở Sài Gòn có mưa không?"],
  th: ["พรุ่งนี้กรุงเทพฝนจะตกไหม", "วันนี้เชียงใหม่สภาพอากาศเป็นยังไง"],
  sw: ["Hali ya hewa Nairobi kesho?", "Itanyesha leo Dar es Salaam?"],
  tl: ["Uulan ba bukas sa Maynila?", "Ano ang panahon sa Davao bukas?"],
  el: ["Θα βρέξει αύριο στην Αθήνα;", "Τι καιρό θα κάνει αύριο στη Θεσσαλονίκη;"],
  sv: ["Hur blir vädret i Stockholm imorgon?", "Kommer det snöa i Göteborg i helgen?"],
  ro: ["Va ploua mâine în București?", "Cum e vremea azi în Iași?"],
  ht: ["Èske lapli ap tonbe demen nan Pòtoprens?", "Èske l ap fè lapli jodi a?"],
};

test("each of Flash's 30 languages has its weather words, and two questions in each are forecast questions", () => {
  const ids = LANGUAGES.map((l) => l.id);
  assert.equal(ids.length, 30);
  // English has its own patterns; every other language has a list.
  assert.deepEqual(Object.keys(WEATHER_TERMS).sort(), ids.filter((id) => id !== "en").sort());
  assert.deepEqual(Object.keys(BY_LANGUAGE).sort(), [...ids].sort());
  for (const [id, questions] of Object.entries(BY_LANGUAGE)) {
    for (const q of questions) assert.ok(weatherQuestion(q), `${id}: ${q}`);
  }
  // Without the question, the words are a hint; in quotes they're being translated, so a hint too.
  assert.equal(tier("météo à Montréal demain"), "hint");
  assert.equal(tier("Comment dit-on « il pleut » en anglais ?"), "hint");
});

test("writing, pictures, code, other temperatures and forecasts, idioms and look-alike words aren't forecast questions", () => {
  for (const m of [
    "write a poem about the rain",
    "Is Purple Rain a good song?",
    "draw a stormy sky",
    "build a weather app",
    "write a python function that gets the weather",
    "what's the temperature of the sun",
    "normal body temperature",
    "oven temperature for chicken",
    "sales forecast for next quarter",
    "how to weather the storm of a layoff",
    // Dutch "again", Spanish and Portuguese "time", Korean "booking", Japanese "a poem about rain", Hebrew "rainy".
    "Ik doe het weer morgen",
    "¿cuánto tiempo hace que vives aquí?",
    "não tenho tempo hoje",
    "비행기 표 예약",
    "雨の詩を書いて",
    "גשמי",
  ]) {
    assert.equal(weatherQuestion(m), false, m);
  }
  // Some are still hints: a text engine that answers them may get the forecast tool when no guess ran.
  assert.equal(asksWeather("write a python function that gets the weather"), true);
  assert.equal(asksWeather("normal body temperature"), false);
});

test("changes to an app or deck that mention the weather are still changes", () => {
  for (const m of ["add a weather widget to the header", "show the temperature in Celsius", "add a 5 day forecast for the selected city", "make the forecast card bigger"]) {
    assert.ok(EDITS_BUILD.test(m), m);
  }
  for (const m of ["how hot is it in Lagos", "Will it rain tomorrow?"]) assert.equal(EDITS_BUILD.test(m), false, m);
});
