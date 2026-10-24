/*
 * The weather words, in two tiers (design §4.9). Pure, no imports.
 *
 * FIRM (weatherQuestion): a precise, question-shaped forecast ask. The router answers it with text and
 * get_weather, and skips the guess. English patterns, plus other-language phrases only when the message
 * is a question and quotes nothing (so "draw an umbrella" or "translate « il pleut »" never land here).
 * HINT (asksWeather): any weather word. The router doesn't decide on it: a guessed message stays guessed
 * (the guess has a "weather" option), a follow-up to an app or deck lets the guess through, and the
 * engine that answers gets the tool when no guess ran. Checked on three sets of messages
 * (test/fixtures/weather-messages.ts).
 */

const B = (alts: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "iu");
const SUB = (alts: string[]) => new RegExp(`(?:${alts.join("|")})`, "iu");
const HE = (alts: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])[הבולמש]?(?:${alts.join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "iu");
// A capitalised place of one to four words, matched case-sensitively ("in Port-au-Prince", "in New York"),
// never a unit ("temperature in Celsius").
const PLACE = String.raw`(?!(?:Celsius|Fahrenheit|Kelvin)(?![\p{L}]))\p{Lu}[\p{L}\p{M}'.-]+(?: (?:\p{Lu}[\p{L}\p{M}'.-]+|de|da|do|del|la|le|el|al|am|an|on|upon|sur|di|of)){0,3}`;
const WHEN = String.raw`today|tonight|tomorrow|later( today)?|now|right now|this (morning|afternoon|evening|week|weekend)|next week|the weekend|on \w+day|outside|out there`;

type Term = RegExp | { test: (s: string) => boolean; source: string };
const unless = (re: RegExp, not: RegExp): Term => ({ test: (s) => re.test(s) && !not.test(s), source: `${re.source} unless …` });

const NOT_MONEY = /\b(sales|revenue|budget|cash ?flow|demand|financial|earnings|profit|market|traffic|growth|inventory|population|template|staff\w*|election|rates?|prices?|stocks?|crypto|bitcoin|match|game|score)\b/i;
// Temperatures and humidity that aren't the air outside: cooking, the body, rooms and machines, space, conversions.
const NOT_AIR =
  /\b(body|oven|room|bedroom|indoor|house|home|water|pool|bath|sauna|core|cpu|gpu|engine|server|fridge|refrigerator|freezer|cook\w*|bak\w*|roast\w*|grill\w*|fry\w*|internal|boil\w*|melt\w*|freez(e|er|ing point)|wash\w*|laundry|dryer|sun|surface|chicken|beef|steak|pork|turkey|fish|meat|bread|cake|wine|milk|baby|fever|venus|mars|mercury|jupiter|saturn|moon|space|planet|lava|convert|conversion|ideal|optimal|best|recommended|normal|safe|should be|humidor|greenhouse|incubator|sleep\w*)\b|(?<!\d)\d+(\.\d+)? ?°? ?(f|c|fahrenheit|celsius)\b/i;

// ---------- English, firm ----------
const EN_FIRM: Term[] = [
  /\b(what'?s|what is|how'?s|how is|what will|how will|what'?ll|how'?ll) the weather\b/i,
  new RegExp(String.raw`\b[Ww]eather (forecast|report|update|outlook|looking|like|pls|please|here|${WHEN}|for (${WHEN}|${PLACE})|in ${PLACE}|at ${PLACE})`, "u"),
  /^\s*(the )?weather( (pls|please|now|today|tomorrow|tonight|update|report|forecast|here|outside))?\s*(?:[?.!]+\s*)?$/i,
  new RegExp(String.raw`^\s*[Ww]eather (in |for |at )?${PLACE}\s*(?:[?.!]+\s*)?$`, "u"),
  new RegExp(String.raw`^\s*(?!(Bad|Good|Nice|Great|Lovely|Terrible|Awful|Fair|Cold|Hot|Warm|Beautiful|Crazy|Weird|Perfect|Stormy|The|This|That|What|Such|Our|My)\b)${PLACE}('s)? weather( (forecast|${WHEN}))?\s*(?:[?.!]+\s*)?$`, "u"),
  unless(/\b(\d+[- ]?day|hourly|weekend|today'?s|tomorrow'?s|tonight'?s|weather|rain|snow) forecasts?\b/i, NOT_MONEY),
  unless(new RegExp(String.raw`\bforecasts? (for|in) (today|tomorrow|tonight|this (weekend|week|morning|afternoon|evening)|the weekend|next week)\b`, "i"), NOT_MONEY),
  unless(new RegExp(String.raw`\b[Ff]orecasts? (for|in) ${PLACE}`, "u"), NOT_MONEY),
  /^\s*(what'?s the |the )?forecasts?( (for )?(today|tomorrow|tonight|this weekend))?\s*(?:\?\s*)?$/i,
  // Temperature: "what's the temperature" alone, or with a time, "outside", or a capitalised place.
  unless(new RegExp(String.raw`\b(what('?s| is| will be) the|current|today'?s|tomorrow'?s|tonight'?s) temp(erature)?s?(\s*(?:[?.!]+\s*)?$| (${WHEN}|like|going to|gonna|in ${PLACE}|at ${PLACE}|for (${WHEN}|${PLACE})))`, "u"), NOT_AIR),
  unless(new RegExp(String.raw`\b[Tt]emp(erature)?s?( in (Celsius|Fahrenheit|°C|°F))? (${WHEN}|in ${PLACE}|at ${PLACE}|for (today|tomorrow|tonight|this \w+|${PLACE}))`, "u"), NOT_AIR),
  unless(new RegExp(String.raw`\bhow (hot|cold|warm|chilly|humid|windy|sunny|rainy|wet) (is it|will it be|is it going to be|is it gonna be|is .{1,30}(${WHEN}))`, "i"), NOT_AIR),
  /\bis it (raining|snowing|hailing|pouring|drizzling|storming)\b/i,
  unless(new RegExp(String.raw`\b[Ii]s it (windy|sunny|cloudy|cold|hot|humid|foggy|stormy|freezing|warm|chilly)( (out(side)?|there|${WHEN}|in ${PLACE}( (?:${WHEN}))?))?\s*(?:[?.!]+\s*)?$`, "u"), NOT_AIR),
  /\b(will|is|going to|gonna) it .{0,15}\b(rain|snow|storm|hail|thunder|drizzle|pour)(s|ing)?\b/i,
  new RegExp(String.raw`\b(will|is|gonna|going to) (it|there) ((gonna|going to) )?(be|get) .{0,12}\b(hot|cold|warm|chilly|windy|sunny|cloudy|rainy|snowy|stormy|humid|freezing|foggy|thunderstorms?|storms?|showers)\b.{0,30}\b(${WHEN})`, "i"),
  new RegExp(String.raw`\b(rain|snow)(ing)? (${WHEN})\b`, "i"),
  new RegExp(String.raw`^\s*(rain|snow)(ing)? (in|at) ${PLACE}( (${WHEN}))?\s*(?:[?.!]+\s*)?$`, "u"),
  /\b(rain|storm|snow)s? coming\b|\brained (off|out)\b|\b(when will|when does|has) the (rain|snow|storm) (stop|start|end|clear)/i,
  new RegExp(String.raw`\b(thunder)?storms? (${WHEN})\b`, "i"),
  /\bchance of (rain|snow|showers|storms?|thunder)\b/i,
  /\b(need|bring|take|pack) (an? |my )?umbrella\b(?! (insurance|policy|stroller|company|term|brand|organi[sz]ation|account|fund|coverage))/i,
  new RegExp(String.raw`\b(need|bring|take|wear|pack) (an? |my )?(jacket|coat|sweater|hoodie|raincoat|sunscreen)( (${WHEN}))?\s*(?:[?.!]+\s*)?$`, "i"),
  new RegExp(String.raw`\bwhat (should|do|can) i wear\b(?![^.?!]{0,60}\b((to|for|at) (an? |the |my |our |his |her |their )?(church|work|school|office|interview|wedding|party|funeral|date|dinner|gym|meeting|event|concert|job|class)|to look|professional|formal|smart|casual|stylish)\b).{0,40}\b(${WHEN})`, "i"),
  unless(new RegExp(String.raw`\b(what('?s| is) the )?(humidity|[Uu][Vv] index)\b.{0,20}\b(in ${PLACE}|today|tomorrow|now|outside)`, "u"), NOT_AIR),
  unless(/\bhow many degrees\b.{0,12}\b(is it|will it|outside|today|tomorrow|tonight)\b/i, /\b(between|angle|clock|triangle|circle|turn|rotat\w*|polygon|hands)\b/i),
  new RegExp(String.raw`\b(sunny|cloudy|windy|foggy|stormy)\b.{0,30}\b(${WHEN})\b`, "i"),
  new RegExp(String.raw`\b(heat ?wave|cold snap|blizzard)\b.{0,40}(\b(coming|expected|this week|today|tomorrow)\b|\bin ${PLACE})`, "u"),
  /\bwhat'?s it like (out(side)?|there)\b/i,
  /\b(good|nice|bad) (day|weather) (for|to) (go )?(the beach|an? (run|walk|swim|picnic|hike|bike ride|barbecue|bbq)|running|swimming|hiking|cycling|fishing|surfing|sailing|outside|out|swim|hike|sail|surf|dry (the |my )?laundry|wash (the |my )?car)\b/i,
];

// ---------- English, hint (broad: any of these words) ----------
const EN_HINT: RegExp[] = [
  /\bweather\b/i,
  /\bforecasts?\b/i,
  /\btemp(erature)?s?\b.{0,40}\b(outside|today|tonight|tomorrow|now|this (week|weekend)|in \p{Lu})/iu,
  /\b(rain(ing|y)?|snow(ing|y)?|storms?|thunder(storms?)?|drizzl\w+|hail(ing)?|showers|umbrella|raincoat|sunscreen|humid(ity)?|uv index|heat ?wave|blizzard|frost|fog(gy)?)\b/i,
  /\bhow (hot|cold|warm|chilly|windy|sunny) (is|will)\b/i,
  /\bis it (windy|sunny|cloudy|cold|hot|warm|chilly|freezing)\b/i,
  /\bhow many degrees\b/i,
  /\bwhat (should|do|can) i wear\b/i,
  /\b(jacket|coat|sweater|hoodie)\b.{0,30}\b(today|tonight|tomorrow|outside)\b/i,
];

// ---------- Other languages: forecast phrases (firm when a question, hint otherwise) ----------
export const WEATHER_TERMS: Record<string, Term[]> = {
  fr: [B(["météo", "quel temps (?:fait|fera|va|il|fera-t-il|fait-il|à|demain|aujourd'hui|ce)", "il fait (?:combien|chaud|froid)", "pleuvoir", "pleuvra", "pleut-il", "il pleut", "neiger", "neigera", "parapluie", "température (?:à|aujourd'hui|demain|ce)"]), /prévisions[\s\S]{0,60}météo/iu],
  es: [B(["el tiempo (?:hoy|mañana|para (?:hoy|mañana|el fin de semana))", "(?:qué|cómo) (?:tiempo|clima) (?:hace|hará|va a hacer|está|estará)", "(?:cómo|qué tal) (?:está|estará) el (?:tiempo|clima)", "pronóstico (?:del|de el) (?:tiempo|clima)", "pronóstico (?:para|de) (?:hoy|mañana)", "clima (?:hoy|mañana|para (?:hoy|mañana))", "llover", "lloverá", "llueve", "nevar", "nevará", "temperatura (?:hoy|mañana|ahora)", "paraguas"]), new RegExp(String.raw`(?<![\p{L}])(?:[Ee]l tiempo|[Ee]l clima|[Tt]emperatura) en ${PLACE}`, "u")],
  pt: [B(["previsão do tempo", "como (?:está|estará|vai (?:estar|ficar)) o tempo(?! de)", "vai chover", "está chovendo", "chover", "chuva (?:hoje|amanhã)", "temperatura (?:hoje|amanhã|agora)", "clima (?:hoje|amanhã)", "guarda-chuva"]), new RegExp(String.raw`(?<![\p{L}])(?:[Cc]huva|[Tt]emperatura|[Cc]lima|[Tt]empo) em ${PLACE}`, "u")],
  de: [B(["wetter", "wettervorhersage", "regnen", "regnet es", "schneien", "schneit es", "temperatur (?:in|heute|morgen|jetzt)", "wie (?:warm|kalt|heiß) (?:ist|wird) es", "regenschirm"])],
  it: [B(["meteo", "che tempo (?:fa|farà)", "previsioni del tempo", "pioverà", "piove (?:oggi|domani)", "pioggia (?:oggi|domani)", "nevicherà", "temperatura (?:oggi|domani|adesso)", "ombrello"]), new RegExp(String.raw`(?<![\p{L}])(?:[Pp]iove|[Pp]ioggia|[Tt]emperatura) a ${PLACE}`, "u")],
  nl: [B(["hoe (?:is|wordt) het weer", "weerbericht", "weersverwachting", "weersvoorspelling", "gaat het regenen", "regent het", "gaat het sneeuwen", "temperatuur (?:in|vandaag|morgen|nu)", "paraplu"])],
  pl: [B(["pogod(?:a|y|zie|ę|ą)", "prognoza pogody", "będzie padać", "pada deszcz", "deszcz (?:w|dziś|dzisiaj|jutro)", "temperatura (?:w|dziś|jutro|teraz)", "(?:wziąć|weź|zabrać|zabierz|potrzebuję|potrzebny) parasol"])],
  tr: [B(["hava durumu", "hava nasıl", "hava (?:bugün|yarın) nasıl", "yağmur yağ\\p{L}*", "kar yağ\\p{L}*", "sıcaklık (?:kaç|bugün|yarın)", "şemsiye"])],
  ru: [B(["погод(?:а|ы|е|у|ой)", "дожд\\p{L}*", "снег (?:пойд\\p{L}*|будет)", "температур\\p{L}* (?:в|сегодня|завтра|сейчас)", "зонт(?:ик)?"])],
  uk: [B(["погод(?:а|у|і|ою)", "прогноз погоди", "дощ\\p{L}*", "сніг (?:піде|буде)", "температур\\p{L}* (?:в|у|на|сьогодні|завтра|зараз|повітря)", "парасол\\p{L}*"])],
  ar: [SUB(["الطقس", "طقس (?:اليوم|غدا|الآن|في|بارد|حار|ممطر)", "حالة الجو", "ستمطر", "تمطر", "المطر (?:اليوم|غدا)", "درجة الحرارة (?:اليوم|غدا|الآن|في)", "مظلة"])],
  he: [HE(["מזג (?:ה)?אוויר", "(?:ירד|יירד|יורד) גשם", "גשם (?:היום|מחר)", "טמפרטורה (?:היום|מחר|עכשיו|ב\\p{L}+)", "תחזית (?:ה)?(?:מזג|גשם)", "תחזית ל(?:היום|מחר|סוף השבוע)", "מטרייה"])],
  fa: [SUB(["آب و هوا", "آب‌وهوا", "هوا[^؟?]{0,25}(?:چطوره|چطور است|چطور خواهد بود)", "باران (?:می‌آید|میاد|می‌بارد)", "دمای هوا", "پیش‌بینی هوا", "چتر (?:ببرم|لازم|بردارم)"])],
  hi: [B(["मौसम", "बारिश", "बरसात", "तापमान", "छाता"])],
  bn: [B(["আবহাওয়া", "বৃষ্টি", "তাপমাত্রা", "ছাতা"])],
  ur: [SUB(["موسم", "بارش", "درجہ حرارت", "چھتری"])],
  "zh-Hans": [SUB(["天气", "天气预报", "下雨", "下雪", "气温", "带伞", "(?:今天|明天|现在|外面|今晚)[^。？?]{0,4}(?:多少度|几度)"])],
  "zh-Hant": [SUB(["天氣", "天氣預報", "下雨", "下雪", "氣溫", "帶傘", "(?:今天|明天|現在|外面|今晚)[^。？?]{0,4}(?:多少度|幾度)"])],
  ja: [SUB(["天気", "天気予報", "気温", "雨が降", "雪が降", "傘(?:が|は)?(?:いる|要る|必要)"])],
  ko: [SUB(["날씨", "기온", "일기예보", "(?<![\\p{L}])비가 (?:오(?!래)|와|올)", "(?<![\\p{L}])비 (?:와|올|오나)", "(?<![\\p{L}])눈이 (?:오(?!늘)|와|올|내리)", "우산 (?:챙겨|필요|가져)"])],
  id: [B(["cuaca", "prakiraan cuaca", "(?:akan )?hujan (?:hari ini|besok|di|nanti)", "suhu (?:di (?!dalam)|hari ini|besok)", "(?:bawa|perlu|butuh) payung"])],
  vi: [B(["thời tiết", "dự báo thời tiết", "(?:có )?mưa (?:không|ở|hôm nay|ngày mai)", "nhiệt độ (?:ở|hôm nay|ngày mai|bây giờ)"])],
  th: [SUB(["สภาพอากาศ", "พยากรณ์อากาศ", "ฝนตก", "ฝนจะตก", "อุณหภูมิ(?:วันนี้|พรุ่งนี้|ที่)", "อากาศ(?:วันนี้|พรุ่งนี้)"])],
  sw: [B(["hali ya hewa", "utabiri wa hali ya hewa", "mvua (?:leo|kesho)", "itanyesha", "inanyesha", "joto (?:leo|kesho)", "mwavuli"])],
  tl: [B(["lagay ng panahon", "panahon (?:bukas|mamaya)", "(?:ano|kumusta|kamusta) ang panahon", "uulan", "umuulan", "ulan (?:bukas|ngayon)", "(?:magdala|dalhin|dala|kailangan)[\\p{L} ]{0,20}payong"])],
  el: [B(["τι καιρό", "καιρό (?:κάνει|θα κάνει)", "(?:ο|τον|του) καιρ(?:ός|ό|ού) (?:σήμερα|αύριο|στην|στο|στη|για)", "πρόγνωση (?:του )?καιρού", "καιρικ\\p{L}*", "βροχ\\p{L}*", "θα βρέξει", "βρέχει", "θερμοκρασία (?:σήμερα|αύριο|στην|στο|τώρα)", "ομπρέλα"])],
  sv: [B(["väder", "vädret", "väderprognos", "kommer det (?:att )?regna", "ska det regna", "regnar det", "snöa", "snöar det", "temperatur(?:en)? (?:i|idag|imorgon|nu)", "paraply"])],
  ro: [B(["vremea (?:azi|mâine|în|la|de)", "prognoza meteo", "meteo", "va ploua", "plouă", "ploaie (?:azi|mâine|în)", "va ninge", "ninge", "temperatura (?:în|azi|mâine|acum)", "umbrelă"])],
  ht: [B(["lapli", "meteyo", "tan an (?:jodi a|demen|kounye a)", "tanperati", "parapli"])],
  zu: [B(["isimo sezulu", "izulu (?:namuhla|kusasa)", "lizona", "kuzona", "imvula (?:namuhla|kusasa)", "kuzokhithika", "izinga lokushisa", "isambulela"])],
  am: [B(["የአየር ሁኔታ", "የአየር ትንበያ", "ዝናብ (?:ይዘንባል|ይጥላል|ይኖራል)", "ይዘንባል", "የሙቀት መጠን", "ጃንጥላ"])],
  ha: [B(["yanayin sararin samaniya", "hasashen yanayi", "yanayin? (?:yau|gobe)", "za a yi ruwa", "ruwan sama", "laima"])],
  yo: [B(["ojú ọjọ́", "ojú-ọjọ́", "oju ojo", "òjò (?:yóò|máa|á|ń) rọ̀", "ojo (?:yoo|maa|a|n) ro", "ooru (?:lónìí|lọ́la)", "agboòrùn"])],
  ig: [B(["ihu igwe", "mmiri ga-ezo", "mmiri (?:na-ezo|ozuzo)", "ọ ga-ezo mmiri", "nche anwụ"])],
  so: [B(["cimilada", "saadaasha hawada", "hawada (?:maanta|berri)", "roob ma (?:da'ayaa|di'i doonaa)", "roob (?:maanta|berri)", "heerkulka", "dallad"])],
};

// A question: ends with a question mark (Latin, CJK, Arabic, Greek, Ethiopic), or a question particle where people drop it.
const QUESTION = /[?？؟;;፧]\s*$|(?:吗|嗎|呢|怎么样|怎麼樣|如何|多少度|几度|幾度|ですか|ますか|어때|나요|까요|ไหม|มั้ย|หรือเปล่า|ยังไง|อย่างไร|เท่าไร|không|thế nào|bao nhiêu)\s*(?:[。.!]\s*)?$/u;
// Quoted words are being translated, spoken or written, not asked about.
const QUOTED = /["“”«»„「」『』]|(?<![\p{L}])'[^']{3,}'(?![\p{L}])/u;

export const NOT_FORECAST = [
  // Not a forecast: warnings, air and sea, climate, the past, how often.
  /\b(warnings?|alerts?|advisor(y|ies)|air quality|aqi|pollen|tides?|climate|average|record (high|low)|historical|history|yesterday|last (week|month|year|winter|summer)|happened|news|died|deaths?|death toll|damage|season|per (year|month)|a year|annual(ly)?|most of the year|usually|typically|generally|in general|year-?round|all year|every (year|winter|summer))\b/i,
  /\b(sea|ocean|water) (temp(erature)?s?|levels?)\b|\bdoes it (ever |usually |often )?(rain|snow)\b/i,
  // Idioms, "fair-weather", objects, and "whether" typed as "weather".
  /\bweather(ed|ing)? (the|this|a|that) (storm|crisis|downturn|recession)\b|\bunder the weather\b|\bweather or not\b|\bfair-? ?weather\b|\bweather (balloon|vane|station|map|app|widget|icon|channel|system|patterns?|proof|stripping)s?\b|\bweatherproof\b/i,
  /\bweather (i'?m|im|i|we|you|he|she|they|it'?s|its) (should|can|will|would|am|is|are|was|have|has|need|want|do|did|pregnant|ok|okay|right|wrong|good|bad)\b|\b(know|decide|deciding|wonder|wondering|unsure|sure|matter|matters|regardless of|ask|asking|choose|choosing|tell|see) (if )?weather (to|or|i'?m|i|we|it|you|he|she|they|this|that)\b/i,
  // The body, fever, cooking and indoor things, in the other languages.
  /(?:शरीर|बुखार|শরীর|জ্বর|cơ thể|sốt|الجسم|حمى|طهي|גוף|חום גוף|بدن|تب|جسم|بخار|тела|тіла|тело|жар|дитини|ребенка|ребёнка|ไข้|ร่างกาย|fièvre|fiebre|febre|fieber|febbre|koorts|gorączk|ateş|homa|lagnat|πυρετ|feber|febră|lafyèv|cuire|cuisson|cocinar|hornear|cozinhar|kochen|cuocere|koken|gotować|pişir|готов|варить|духовк|духовц|पकाने|রান্না|nấu|ปรุง|kupika|magluto|μαγειρ|găti|sauna|backofen|kühlschrank|réfrigérateur|nevera|geladeira|frigorifero|холодильник|kulkas|di dalam oven)/iu,
];
// Asks to make something else: never the firm rule (the hint still attaches the tool if a text engine answers).
export const OTHER_WORK =
  /(?<![\p{L}])(poem|story|stories|song|lyrics|essay|caption|haiku|limerick|joke|novel|script|code|python|javascript|function|api|app|website|sql|spreadsheet|excel|csv|template|worksheet|lesson|quiz|email|letter|note|poème|chanson|poema|poesía|canción|canção|gedicht|lied|canzone|poesia|wiersz|piosenk\p{L}*|şiir|şarkı|стих\p{L}*|песн\p{L}*|вірш\p{L}*|пісн\p{L}*|قصيدة|أغنية|שיר|شعر|ترانه|कविता|गीत|কবিতা|গান|نظم|مضمون|puisi|lagu|bài thơ|bài hát|shairi|wimbo|tula|kanta|ποίημα|τραγούδι|dikt|låt|poezie|cântec|powèm|chante)(?![\p{L}])|诗|詩|歌|시를|노래|บทกวี|เพลง/iu;

// The English patterns that must see a capitalised place are case-sensitive, so a capital that only starts a sentence
// ("What's", "Rain", "Heatwave") is lowered first. Places inside the sentence keep their capitals.
const lowerStarts = (m: string) => m.replace(/(^\s*|[.!?]\s+)(\p{Lu})(?=\p{Ll})/gu, (_, a: string, b: string) => a + b.toLowerCase());

const firmMatch = (m: string): string | null => {
  const lowered = lowerStarts(m);
  for (const t of EN_FIRM) if (t.test(m) || t.test(lowered)) return `en firm: ${t.source.slice(0, 50)}`;
  if (!QUESTION.test(m.trim()) || QUOTED.test(m)) return null;
  for (const [id, terms] of Object.entries(WEATHER_TERMS)) for (const t of terms) if (t.test(m)) return `${id} firm: ${t.source.slice(0, 50)}`;
  return null;
};
export function weatherMatch(m: string): string | null {
  const f = firmMatch(m);
  if (f) return f;
  for (const r of EN_HINT) if (r.test(m)) return `en hint: ${r.source.slice(0, 50)}`;
  for (const [id, terms] of Object.entries(WEATHER_TERMS)) for (const t of terms) if (t.test(m)) return `${id} hint: ${t.source.slice(0, 50)}`;
  return null;
}
const notForecast = (m: string) => NOT_FORECAST.some((r) => r.test(m));
/*
 * A forecast question is short (the longest in the message sets is 62 characters), so a longer message
 * is never one, and only the start of a long message is read for a weather word. Every check then takes
 * well under a millisecond, whatever a request holds (a message may be 100,000 characters).
 */
export const FIRM_MAX_CHARS = 300;
export const HINT_MAX_CHARS = 2000;
/** Any weather word: the engine that answers gets get_weather. Never decides the engine by itself. */
export const asksWeather = (message: string) => {
  const m = message.length > HINT_MAX_CHARS ? message.slice(0, HINT_MAX_CHARS) : message;
  return weatherMatch(m) !== null && !notForecast(m);
};
/** A precise forecast question: the router sends it to text + get_weather without the guess. */
export const weatherQuestion = (m: string) => m.length <= FIRM_MAX_CHARS && firmMatch(m) !== null && !notForecast(m) && !OTHER_WORK.test(m);
// After an app or deck, a weather word in an edit ("add a weather widget") still edits it.
// "show me", "give me" and "let me" ask for something, not a change.
export const EDITS_BUILD =
  /^\s*(please |pls |can you |could you |now |also |and |ok,? )?(add|make|show(?! me\b)|change|put|remove|move|use|set|display|fix|update|turn|replace|include|let(?! me\b)|give(?! me\b))\b|\b(widget|icon|section|header|footer|button|page|card|screen|theme|layout|slide|tab|component|chart|dashboard|font|colou?r|background)s?\b/i;
