import { test } from "node:test";
import assert from "node:assert/strict";
import { RECURRING_CHARS, SCHEDULE_LANGUAGES, asksRecurring } from "../src/lib/schedule-words.ts";

// Asks for something done again and again, or later, in each language.
const ASKS: Record<string, string[]> = {
  en: [
    "Every Monday at 8, send me the news about electric cars",
    "Can you check the price of this laptop every day and tell me if it drops?",
    "remind me to call the bank on Friday",
    "Give me a weekly summary of AI news",
    "Let me know when the new iPhone is released",
    "Research my three competitors each week and sum up what changed",
  ],
  es: ["Cada lunes envíame un resumen de las noticias de tecnología", "Recuérdame pagar la renta el día 1"],
  pt: ["Todos os dias me envie as notícias do mercado", "Me lembre de ligar para o médico amanhã"],
  fr: ["Chaque matin, envoie-moi la météo et les nouvelles", "Rappelle-moi d'appeler maman dimanche"],
  de: ["Schick mir jeden Montag eine Zusammenfassung der Nachrichten", "Erinnere mich morgen an den Termin"],
  it: ["Ogni giorno mandami le notizie sul calcio", "Ricordami di pagare la bolletta"],
  nl: ["Stuur me elke ochtend het nieuws over AI", "Herinner me eraan om de huur te betalen"],
  sv: ["Skicka mig nyheterna varje morgon", "Påminn mig att ringa tandläkaren"],
  pl: ["Codziennie wyślij mi wiadomości o pogodzie", "Przypomnij mi o spotkaniu jutro"],
  ro: ["În fiecare dimineață trimite-mi știrile", "Amintește-mi să plătesc factura"],
  ru: ["Каждый понедельник присылай мне новости о криптовалюте", "Напомни мне позвонить маме завтра"],
  uk: ["Щодня надсилай мені новини про погоду", "Нагадай мені про зустріч"],
  el: ["Κάθε πρωί στείλε μου τα νέα", "Θύμισέ μου να πληρώσω το νοίκι"],
  tr: ["Her sabah bana haberleri gönder", "Yarın doktoru aramamı hatırlat"],
  ar: ["كل يوم أرسل لي ملخص الأخبار", "ذكرني بدفع الفاتورة غدا"],
  fa: ["هر روز اخبار بورس را برایم بفرست", "یادم بنداز فردا به مادرم زنگ بزنم"],
  he: ["כל בוקר שלח לי את החדשות", "תזכיר לי לשלם את החשבון"],
  hi: ["हर सुबह मुझे खबरें भेजो", "मुझे कल डॉक्टर को फोन करना याद दिलाना"],
  ur: ["ہر صبح مجھے خبریں بھیجیں", "مجھے کل ڈاکٹر کو فون کرنا یاد دلانا"],
  bn: ["প্রতিদিন সকালে আমাকে খবর পাঠাও", "আমাকে কাল বিল দেওয়ার কথা মনে করিয়ে দিও"],
  id: ["Setiap pagi kirimkan berita teknologi", "Ingatkan saya untuk bayar listrik besok"],
  sw: ["Kila asubuhi nitumie habari za soko", "Nikumbushe kulipa kodi kesho"],
  ht: ["Chak maten voye ban m nouvèl yo", "Raple m peye lwaye a demen"],
  tl: ["Araw-araw padalhan mo ako ng balita", "Ipaalala mo sa akin na magbayad ng kuryente"],
  vi: ["Mỗi sáng gửi cho tôi tin tức công nghệ", "Nhắc tôi gọi cho mẹ vào ngày mai"],
  th: ["ส่งข่าวให้ฉันทุกเช้า", "เตือนฉันจ่ายค่าไฟพรุ่งนี้"],
  ja: ["毎朝ニュースをまとめて送って", "明日の会議をリマインドして"],
  ko: ["매일 아침 뉴스를 요약해서 보내줘", "내일 회의 리마인드 해줘"],
  "zh-Hans": ["每天早上给我发科技新闻", "提醒我明天交房租"],
  "zh-Hant": ["每天早上發給我科技新聞", "提醒我明天交房租"],
};

// A schedule word in a question that wants one answer, or nothing Flash would do each time.
const NOT_ASKS = [
  "What's a good daily routine for a student?",
  "How often should I check my blood pressure, every day?",
  "Write a weekly report template for my team",
  "I go to the gym every Monday, give me a workout plan",
  "Translate 'every day' into French",
  "What happened in the news today?",
  "Make a picture of a red bicycle",
  "¿Qué rutina diaria me recomiendas?",
  "ทุกวันนี้ราคาทองเท่าไหร่",
  "Wie spät ist es?",
  "",
  "   ",
];

test("asks for something done again and again or later, in each of Flash's 30 languages", () => {
  assert.deepEqual(new Set(Object.keys(ASKS)), new Set(SCHEDULE_LANGUAGES));
  assert.equal(SCHEDULE_LANGUAGES.length, 30);
  for (const [lang, asks] of Object.entries(ASKS)) for (const ask of asks) assert.ok(asksRecurring(ask), `${lang}: ${ask}`);
});

test("a schedule word alone, or a one-off ask, isn't one", () => {
  for (const ask of NOT_ASKS) assert.equal(asksRecurring(ask), false, ask);
});

test("only the start of a message is read", () => {
  assert.ok(asksRecurring(`${"x".repeat(RECURRING_CHARS - 40)} remind me to call the bank`));
  assert.equal(asksRecurring(`${"x".repeat(RECURRING_CHARS)} remind me to call the bank`), false);
});
