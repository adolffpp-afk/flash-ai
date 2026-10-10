// Set A of the weather routing checks (test/weather-words.test.ts, test/router.test.ts): written by the design's
// skeptic; the word lists were tuned on it. intent: weather | clock | other (anything not answered by a forecast or the clock).
export type M = { q: string; intent: "weather" | "clock" | "other"; note?: string };
const w = (q: string): M => ({ q, intent: "weather" });
const o = (q: string, note?: string): M => ({ q, intent: "other", note });

// Weather questions, phrased the way people type them (several are deliberately short or casual).
export const WEATHER: M[] = [
  "Will it rain tomorrow?", "will it rain today", "how's the weather", "weather pls", "What's tomorrow's forecast?", "forecast?",
  "is it gonna be cold tomorrow", "will it be hot tomorrow?", "temp tomorrow?", "Is it going to be windy later?",
  "Will there be thunderstorms tonight?", "Do I need a jacket?", "What's it like outside?", "rain tomorrow?", "Is it cold outside?",
  "How warm will it be on Saturday?", "Will it be sunny for the wedding on Saturday?", "Should I water my garden or is rain coming?",
  "how hot is it in Lagos", "Is it windy in Chicago?", "chance of rain in Nairobi", "do I need an umbrella", "5 day forecast for Kumasi",
  "Is it a good day for the beach in Miami?", "What should I wear tomorrow in Montreal?", "How many degrees is it in Kinshasa?",
  "what's the humidity in Dubai", "Is it going to snow this week in Boston?", "Give me the weather report for Nairobi",
  "When will the rain stop?", "Is there a storm coming to Miami?", "Can I go running this evening or will it rain?",
  "What's the temperature on Sunday?", "what's the temperature in Waterloo today", "Will it be cold in Toronto next week?",
  // other languages
  "Quel temps fera-t-il demain à Paris ?", "Il va pleuvoir demain ?", "¿Va a llover mañana en Bogotá?", "¿Cómo está el clima hoy?",
  "Vai chover amanhã em São Paulo?", "Wie wird das Wetter morgen in Berlin?", "Che tempo farà domani a Roma?", "Hoe wordt het weer morgen?",
  "Jaka będzie pogoda jutro w Warszawie?", "İstanbul'da yarın hava nasıl?", "Какая погода в Москве завтра?", "Яка погода завтра в Києві?",
  "هل ستمطر غدا في القاهرة؟", "מה מזג האוויר מחר בתל אביב?", "هوا فردا در تهران چطور است؟", "क्या कल मुंबई में बारिश होगी?",
  "কাল ঢাকায় বৃষ্টি হবে?", "کل لاہور میں موسم کیسا ہوگا؟", "北京明天天气怎么样？", "台北明天會下雨嗎？", "明日の東京の天気は？", "내일 서울 날씨 어때?",
  "Cuaca di Jakarta besok?", "Thời tiết Hà Nội ngày mai thế nào?", "พรุ่งนี้กรุงเทพฝนจะตกไหม", "Hali ya hewa Nairobi kesho?",
  "Uulan ba bukas sa Maynila?", "Θα βρέξει αύριο στην Αθήνα;", "Hur blir vädret i Stockholm imorgon?", "Va ploua mâine în București?",
  "Èske lapli ap tonbe demen nan Pòtoprens?", "¿Qué tiempo hará mañana? Quiero que sea un buen día para la boda",
].map(w);

export const CLOCK: M[] = ["what time is it in Tokyo", "what's today's date", "what day is it", "What's the date today?", "what time is it"].map(
  (q) => ({ q, intent: "clock" as const }),
);

// Everyday messages with no weather or clock intent (no deliberate traps).
export const EVERYDAY: M[] = [
  "Write a LinkedIn post announcing our new product launch", "Draft a polite reminder to a client who hasn't paid an invoice",
  "What are some good names for a hair salon in Accra?", "Explain inflation like I'm 12", "How do I calculate compound interest?",
  "Give me 10 Instagram caption ideas for a bakery", "Fix the grammar: me and him goes to school everyday",
  "What is the difference between a sole proprietorship and an LLC?", "Help me prepare for a job interview at a bank tomorrow",
  "Create a weekly meal plan for a family of four on a budget", "What's the best way to learn French fast?", "Write a birthday message for my mom",
  "How many calories are in an egg?", "Can you explain how vaccines work?", "Write a cover letter for a nursing job",
  "How do I get a US visa from Nigeria?", "What's a good gift for a 5 year old?", "Tell me a fun fact about octopuses", "Who wrote Things Fall Apart?",
  "Explain the causes of World War 1", "Solve 3x + 7 = 22", "What's 15% tip on $86?", "Convert 5 miles to km", "How long should I boil an egg?",
  "Give me a workout plan for beginners", "How do I start a podcast?", "Is coffee bad for you?", "What are the symptoms of malaria?",
  "How can I improve my credit score?", "Recommend some books like Harry Potter", "Help me name my cat", "Plan a 3 day trip to Cape Town",
  "How do I make my house cooler without AC?", "Write a speech for my best friend's wedding", "What's the meaning of 'break a leg'?",
  "What time zone is Kenya in?", "Is it safe to eat raw cookie dough?", "Will it be expensive to fly to London in December?",
  "Is it worth learning Rust in 2026?", "Does it matter which side of the foil I use?", "How hot does a pizza oven get?",
  "What should I say in my wedding toast tomorrow?", "How do I tell my boss I'm sick today?", "Is it normal to feel tired all the time?",
  "How do I reply to this customer complaint?", "Summarise the main points of the Lean Startup", "What's the capital of Australia?",
  "How much should I charge for a logo design?", "How do I open a bank account in Ghana?", "Can you help me with my maths homework?",
  "What's a good morning routine?", "How do I get more followers on TikTok?", "Give me a recipe for jollof rice",
  "What's the difference between affect and effect?", "My laptop is slow, what can I do?", "How do I cancel my Netflix subscription?",
  "Is now a good time to buy a house?", "How do I ask for a raise?", "What does APR mean?", "Help me plan my wedding budget",
  "Écris un e-mail à mon patron pour demander un congé", "¿Cómo puedo ahorrar dinero cada mes?", "Escreva uma legenda para o Instagram",
  "Schreib mir eine Einladung zum Geburtstag", "Напиши письмо клиенту", "帮我写一封求职信", "日本語の文法を説明して", "आज के लिए एक प्रेरक उद्धरण दो",
  "Nipe mapishi ya pilau", "Viết email xin nghỉ phép", "Ano ang magandang negosyo ngayon?", "Bagaimana cara membuat CV yang bagus?",
].map((q) => o(q));

// Realistic messages that use weather-like words but don't ask for a forecast, plus the new search patterns' neighbours.
export const TRAPS: M[] = [
  // English idioms, typos and other senses
  o("I'm feeling under the weather, what should I eat?", "idiom"), o("I don't know weather to quit my job or not", "whether typo"),
  o("weather or not I should take the job", "whether typo"), o("How do I tell if weather I'm pregnant", "whether typo"),
  o("What should I wear to my job interview tomorrow?", "outfit, not weather"), o("What should I wear to a wedding on Saturday?", "outfit"),
  o("Do I need umbrella insurance for my rental property?", "insurance"), o("Is it a good time to run ads on Facebook?", "marketing"),
  o("Is now a good time to fly to Europe or will prices drop?", "prices"), o("Is it a good time to walk away from my business partner?", "life advice"),
  o("What's the temperature for baking chicken breast?", "cooking"), o("What's the temperature in Celsius if it's 98.6 F?", "conversion"),
  o("What is the temperature on Venus?", "astronomy"), o("How cold is it in space?", "science"), o("How hot is it on the surface of Mercury?", "science"),
  o("Does it snow in Dubai?", "climate"), o("Does it rain a lot in London?", "climate"), o("How much rain does Seattle get in a year?", "climate"),
  o("What happened during Hurricane Katrina in New Orleans?", "history"), o("Latest news on the hurricane in Jamaica", "news: Research"),
  o("How many people died in the tornado in Kentucky?", "news"), o("Hurricane season in Florida, when is it?", "climate"),
  o("Make a forecast for the election this year", "not weather"), o("Forecast my revenue for next year", "finance"),
  o("Give me a 3 day forecast template for my cafe's staffing", "business"), o("What's the forecast for the Fed rate decision next week?", "finance"),
  o("Is it cold to wear shorts to the office?", "etiquette"), o("Is it hot sauce or chili oil in this recipe?", "cooking"),
  o("What time is it best to post on Instagram?", "marketing, clock false positive"), o("What day is it on the Hebrew calendar?", "clock?"),
  o("Best snacks for a rainy day movie night", "snacks"), o("Write a caption for a sunny day at the beach today", "caption"),
  o("How do I install a light fixture?", "DIY, new search pattern"), o("Which bathroom fixtures are best for a small flat?", "DIY"),
  o("How much is a pound of rice in kg?", "conversion, new search pattern"), o("How much is a dollar store franchise?", "business"),
  o("Who is the king of pop?", "static fact, new search pattern"), o("Who is the queen of hearts in Alice in Wonderland?", "fiction"),
  o("who is the CEO in my story? make up a name", "fiction"), o("What's closing time at most banks in Nigeria?", "fine for search"),
  o("Help me write a song about the rain", "song"), o("Is it raining men a good karaoke song?", "music"),
  o("What should I wear on Sunday for church?", "outfit"), o("Plan an outdoor birthday party for Saturday", "planning"),
  // other languages
  o("Quel temps utiliser après 'si' en français ?", "fr: tense"), o("Quel temps faut-il pour cuire un poulet ?", "fr: time"),
  o("Cómo administrar el tiempo en el trabajo", "es: time management"), o("No tengo el tiempo para estudiar, ¿qué hago?", "es: time"),
  o("¿Cuál es el pronóstico de la final de la Champions?", "es: prediction"), o("Pronóstico de ventas para mi tienda", "es: sales forecast"),
  o("El pronóstico de mi enfermedad es bueno?", "es: prognosis"), o("Jak się pogodzić z dziewczyną po kłótni?", "pl: reconcile"),
  o("Napisz pogodną piosenkę na urodziny", "pl: cheerful song"), o("Погоди, я не понял, объясни ещё раз", "ru: wait"),
  o("Я не погоджуюсь з цим рішенням, як написати листа?", "uk: I disagree"), o("У дитини температура 38, що робити?", "uk: fever"),
  o("Πόσο καιρό χρειάζεται για να μάθω ελληνικά;", "el: how long"), o("Έχω πολύ καιρό να γράψω CV, βοήθησέ με", "el: long time"),
  o("Sa panahon ngayon, paano makaipon ng pera?", "tl: nowadays"), o("Ano ang payong mo sa bagong negosyo?", "tl: advice"),
  o("Apa payung hukum untuk UMKM di Indonesia?", "id: legal basis"), o("शरीर का तापमान कितना होना चाहिए?", "hi: body temperature"),
  o("बारिश पर एक कविता लिखो", "hi: poem about rain"), o("写一首关于下雨的诗", "zh: poem about rain"), o("Напиши стихотворение про дождь", "ru: poem about rain"),
  o("Escribe un poema sobre la lluvia que va a llover", "es: poem"), o("מה התחזית למכירות ברבעון הבא?", "he: sales forecast"),
  o("ما هي درجة الحرارة المناسبة لطهي الدجاج؟", "ar: cooking temperature"), o("Nhiệt độ cơ thể bình thường là bao nhiêu?", "vi: body temperature"),
  o("Ki tan pou m pran pou m aprann angle?", "ht: how much time"), o("Che tempo verbale si usa dopo 'se'?", "it: verb tense"),
  o("Quale re regna in Spagna oggi?", "it: reigns (sv regna)"), o("¿Qué es mejor, que sea barato o bueno?", "es: subjunctive 'sea' (no weather)"),
];

// Follow-ups to an app the user just built (previous = "app"): edits to that app.
export const AFTER_APP: M[] = [
  o("make the weather icon bigger", "edit"), o("add a weather widget to the header", "edit"), o("show the temperature in Celsius", "edit"),
  o("the forecast section is broken", "edit"), o("add a 5 day forecast for the selected city", "edit"), o("make it look like a rainy day theme", "edit"),
  w("how hot is it in Lagos"), w("Will it rain tomorrow?"), o("make the header blue", "edit"),
];
