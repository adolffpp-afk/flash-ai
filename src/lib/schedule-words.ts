/*
 * The words that say a message wants something done again and again, or later ("every Monday, send me
 * the news about electric cars", "remind me to call the bank on Friday"), in Flash's 30 languages. Pure,
 * no imports. Where Automations is open to the account, the chat's answer is told Flash can do it by
 * itself (see the chat route), and the answer gets a Review automation card (see Flash.tsx).
 * A message matches with a strong phrase ("remind me to", "automatically"), or with both a schedule
 * ("every day", "weekly", "on Mondays") and something Flash would do each time ("send me", "check",
 * "sum up"), so "what's a good daily routine?" doesn't. Only the first RECURRING_CHARS characters are
 * read: the ask is at the start of a message.
 */

export const RECURRING_CHARS = 600;

// Whole words in scripts with spaces (a letter, mark or digit on neither side), and runs inside text
// for scripts without them (Chinese, Japanese, Thai) or where words take prefixes (Arabic, Hebrew).
const B = (alts: string[]) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "iu");
const SUB = (alts: string[]) => new RegExp(`(?:${alts.join("|")})`, "iu");

type Words = { recur: RegExp; act: RegExp; strong?: RegExp; not?: RegExp };

const EN_DAYS = "mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekdays?|weekends?|workdays?";

const LANGUAGES: Record<string, Words> = {
  en: {
    recur: B([
      `(?:every|each) (?:single )?(?:day|morning|afternoon|evening|night|week|month|year|hour|quarter|other (?:day|week)|few (?:hours|days)|${EN_DAYS}|\\d+ (?:minutes|hours|days|weeks|months))`,
      "daily|weekly|monthly|hourly|nightly|weeknightly|biweekly|fortnightly",
      `on (?:${EN_DAYS})`,
      "(?:once|twice) (?:a|per|each) (?:day|week|month)",
    ]),
    act: B([
      "remind|send|e-?mail|text me|message me|notify|alert|ping",
      "tell me|let me know|keep me (?:posted|updated|informed)|update me|brief me|give me (?:an? )?(?:(?:daily|weekly|monthly|short|quick) )?(?:update|summary|digest|recap|brief(?:ing)?|report)",
      "check|monitor|keep an eye on|keep track of|summari[sz]e|sum up|recap|research|look up|find (?:me )?(?:the )?(?:latest|new)",
    ]),
    strong: B([
      "remind me (?:to|about|of|every|each|daily|weekly|monthly|on|at|in|tomorrow|tonight|next|this)",
      "set (?:up )?(?:an? )?(?:reminder|automation|recurring)",
      "on a (?:schedule|regular basis)|automatically (?:every|each|send|check|tell|remind)",
      "(?:notify|alert|tell) me (?:when|whenever|as soon as)|let me know (?:when|whenever|as soon as)",
    ]),
    not: /\bhow (?:often|many times)\b/i,
  },
  es: {
    recur: B([
      "cada (?:día|dia|mañana|manana|tarde|noche|semana|mes|año|hora|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|\\d+ (?:horas|días|dias|semanas))",
      "todos los (?:días|dias|lunes|martes|miércoles|miercoles|jueves|viernes|sábados|sabados|domingos|meses)",
      "todas las (?:mañanas|mananas|tardes|noches|semanas|horas)",
      "diario|diariamente|a diario|semanal|semanalmente|mensual|mensualmente",
      "los (?:lunes|martes|miércoles|jueves|viernes|sábados|domingos|fines de semana)",
    ]),
    act: B([
      "recuérdame|recuerdame|recordarme|envíame|enviame|mándame|mandame|avísame|avisame|notifícame|notificame|infórmame|informame|dime",
      "revisa|comprueba|vigila|resume|resúmeme|resumeme|investiga|busca|manténme|mantenme",
    ]),
    strong: B(["recuérdame|recuerdame|avísame cuando|avisame cuando|automáticamente|automaticamente|de forma automática"]),
  },
  pt: {
    recur: B([
      "todo (?:dia|mês|mes|ano)|todos os (?:dias|meses|anos)",
      "toda (?:segunda|terça|terca|quarta|quinta|sexta|semana|manhã|manha|noite|tarde)(?:-feira)?",
      "todas as (?:segundas|terças|tercas|quartas|quintas|sextas|manhãs|manhas|noites|tardes|semanas)(?:-feiras)?",
      "aos (?:sábados|sabados|domingos)|a cada (?:\\d+ )?(?:horas?|dias?|semanas?)|cada (?:dia|semana|mês|mes|hora)",
      "diariamente|semanalmente|mensalmente",
    ]),
    act: B([
      "lembre(?:-me)?|me lembre|lembra-me|me lembra|envie|me envie|mande|me mande|me avise|avise-me|me notifique|notifique|me diga|diga-me",
      "verifique|confira|monitore|resuma|pesquise|me mantenha informado",
    ]),
    strong: B(["me lembre|lembre-me|lembra-me|me lembra|automaticamente"]),
  },
  fr: {
    recur: B([
      "chaque (?:jour|matin|soir|semaine|mois|année|heure|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)",
      "tous les (?:jours|matins|soirs|lundis|mardis|mercredis|jeudis|vendredis|samedis|dimanches|mois|ans|\\d+ jours)",
      "toutes les (?:semaines|heures|\\d+ heures)",
      "quotidien(?:ne)?|quotidiennement|hebdomadaire|hebdomadairement|mensuel(?:le)?|mensuellement",
    ]),
    act: B([
      "rappelle-moi|rappelez-moi|envoie-moi|envoyez-moi|préviens-moi|previens-moi|prévenez-moi|avertis-moi|notifie-moi|dis-moi|dites-moi",
      "vérifie|verifie|vérifiez|surveille|surveillez|résume|resume|résumez|recherche|recherchez|tiens-moi au courant|tenez-moi au courant",
    ]),
    strong: B(["rappelle-moi|rappelez-moi|automatiquement"]),
  },
  de: {
    recur: B([
      "jeden (?:Tag|Morgen|Abend|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Monat|Werktag)|jede (?:Woche|Stunde|Nacht)",
      "alle \\d+ (?:Stunden|Tage|Wochen)|täglich|taeglich|wöchentlich|woechentlich|monatlich|stündlich|werktags",
      "montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonntags",
    ]),
    act: B([
      "erinnere mich|erinnern Sie mich|schick(?:e)? mir|sende mir|senden Sie mir|benachrichtige mich|sag mir|sagen Sie mir|informiere mich",
      "prüfe|pruefe|prüfen Sie|überprüfe|ueberpruefe|überwache|fasse|recherchiere|halte mich auf dem Laufenden",
    ]),
    strong: B(["erinnere mich|erinnern Sie mich|automatisch"]),
  },
  it: {
    recur: B([
      "ogni (?:giorno|mattina|sera|settimana|mese|ora|lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica|\\d+ ore)",
      "tutti i (?:giorni|lunedì|martedì|mercoledì|giovedì|venerdì|sabati|mesi)|tutte le (?:mattine|sere|settimane|domeniche)",
      "quotidianamente|giornalmente|settimanalmente|mensilmente",
    ]),
    act: B(["ricordami|mandami|inviami|avvisami|notificami|dimmi|controlla|verifica|monitora|riassumi|ricerca|cerca|tienimi aggiornat[oa]"]),
    strong: B(["ricordami|automaticamente"]),
  },
  nl: {
    recur: B([
      "(?:elke|iedere) (?:dag|ochtend|avond|week|maand|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|werkdag)|(?:elk|ieder) uur",
      "om de \\d+ (?:uur|dagen)|dagelijks|wekelijks|maandelijks",
    ]),
    act: B(["herinner me|stuur me|laat me weten|waarschuw me|meld me|vertel me|controleer|check|houd|vat|onderzoek|zoek|hou me op de hoogte"]),
    strong: B(["herinner me|automatisch"]),
  },
  sv: {
    recur: B([
      "varje (?:dag|morgon|kväll|vecka|månad|timme|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|vardag)",
      "dagligen|veckovis|månadsvis|på (?:måndagar|tisdagar|onsdagar|torsdagar|fredagar|lördagar|söndagar)",
    ]),
    act: B(["påminn mig|skicka|meddela mig|säg till|berätta|kolla|kontrollera|bevaka|sammanfatta|undersök|håll mig uppdaterad"]),
    strong: B(["påminn mig|automatiskt"]),
  },
  pl: {
    recur: B([
      "codziennie|co (?:dzień|dzien|tydzień|tydzien|miesiąc|miesiac|godzinę|godzine|rano|wieczór|wieczor|poniedziałek|wtorek|środę|czwartek|piątek|sobotę|niedzielę|\\d+ godzin[y]?)",
      "każdego (?:dnia|ranka|wieczoru|tygodnia|miesiąca)|w każdy (?:poniedziałek|wtorek|czwartek|piątek)|w każdą (?:środę|sobotę|niedzielę)",
      "cotygodniowo|tygodniowo|miesięcznie|w (?:poniedziałki|wtorki|środy|czwartki|piątki|soboty|niedziele)",
    ]),
    act: B(["przypomnij mi|przypominaj mi|wyślij mi|wysyłaj mi|powiadom mnie|powiadamiaj mnie|daj mi znać|informuj mnie|powiedz mi|sprawdź|sprawdzaj|monitoruj|podsumuj|podsumowuj|wyszukaj|szukaj"]),
    strong: B(["przypomnij mi|przypominaj mi|automatycznie"]),
  },
  ro: {
    recur: B([
      "[iî]n fiecare (?:zi|dimineață|dimineata|seară|seara|săptămână|saptamana|lună|luna|oră|ora|luni|marți|marti|miercuri|joi|vineri|sâmbătă|sambata|duminică|duminica)",
      "zilnic|săptămânal|saptamanal|lunar|la fiecare \\d+ (?:ore|zile)",
    ]),
    act: B(["amintește-mi|aminteste-mi|trimite-mi|anunță-mă|anunta-ma|spune-mi|verifică|verifica|monitorizează|monitorizeaza|rezumă|rezuma|caută|cauta|ține-mă la curent|tine-ma la curent"]),
    strong: B(["amintește-mi|aminteste-mi|automat"]),
  },
  ru: {
    recur: B([
      "каждый (?:день|час|понедельник|вторник|четверг|месяц|вечер|год)|каждое (?:утро|воскресенье)|каждую (?:неделю|среду|пятницу|субботу|ночь)|каждые \\d+ (?:часа|часов|дня|дней)",
      "ежедневно|еженедельно|ежемесячно|раз в (?:день|неделю|месяц|час)",
      "по (?:понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям|утрам|вечерам|будням)",
    ]),
    act: B(["напомина\\p{L}*|напомни\\p{L}*|присыла\\p{L}*|пришли|отправля\\p{L}*|отправь|сообща\\p{L}*|сообщи|уведом\\p{L}*|скажи|говори|проверя\\p{L}*|проверь|следи|отслежива\\p{L}*|подытож\\p{L}*|резюмируй|исследуй|ищи|найди|держи меня в курсе"]),
    strong: B(["напомни\\p{L}*|напоминай|автоматически"]),
  },
  uk: {
    recur: B([
      "щодня|щоденно|щотижня|щомісяця|щоранку|щовечора|щогодини",
      "кожного (?:дня|ранку|вечора|тижня|місяця|понеділка|вівторка|четверга)|кожен (?:день|понеділок|вівторок|четвер|тиждень|місяць)|кожну (?:середу|п'ятницю|п’ятницю|суботу|неділю)",
      "по (?:понеділках|вівторках|середах|четвергах|п'ятницях|п’ятницях|суботах|неділях|буднях)|раз на (?:день|тиждень|місяць)|кожні \\d+ (?:години|годин|днів|дні)",
    ]),
    act: B(["нагада\\p{L}*|нагаду\\p{L}*|надсила\\p{L}*|надішли|повідомля\\p{L}*|повідом|сповіща\\p{L}*|скажи|кажи|перевіря\\p{L}*|перевір|стеж|відстежу\\p{L}*|підсуму\\p{L}*|досліди|шукай|знайди|тримай мене в курсі"]),
    strong: B(["нагадай|нагадуй|автоматично"]),
  },
  el: {
    recur: B([
      "κάθε (?:μέρα|ημέρα|πρωί|βράδυ|εβδομάδα|μήνα|ώρα|Δευτέρα|Τρίτη|Τετάρτη|Πέμπτη|Παρασκευή|Σάββατο|Κυριακή|\\d+ ώρες)",
      "καθε (?:μερα|ημερα|πρωι|βραδυ|εβδομαδα|μηνα|ωρα|δευτερα|τριτη|τεταρτη|πεμπτη|παρασκευη|σαββατο|κυριακη)",
      "καθημερινά|καθημερινα|εβδομαδιαία|εβδομαδιαια|μηνιαία|μηνιαια",
    ]),
    act: B(["θύμισέ μου|θύμισε μου|θυμισε μου|στείλε μου|στειλε μου|ενημέρωσέ με|ενημέρωσε με|ενημερωσε με|ειδοποίησέ με|ειδοποιησε με|πες μου|έλεγξε|ελεγξε|παρακολούθησε|παρακολουθησε|συνόψισε|συνοψισε|ψάξε|ψαξε"]),
    strong: B(["θύμισέ μου|θύμισε μου|θυμισε μου|αυτόματα|αυτοματα"]),
  },
  tr: {
    recur: B([
      "her (?:gün|gun|sabah|akşam|aksam|hafta|ay|saat|pazartesi|salı|sali|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar|\\d+ saatte)",
      "günlük|gunluk|haftalık|haftalik|aylık|aylik|günde bir|gunde bir|haftada bir|ayda bir|pazartesileri|cumaları|hafta içi",
    ]),
    act: B(["hatırlat\\p{L}*|hatirlat\\p{L}*|gönder\\p{L}*|gonder\\p{L}*|yolla\\p{L}*|bildir\\p{L}*|haber ver\\p{L}*|söyle\\p{L}*|soyle\\p{L}*|kontrol et\\p{L}*|takip et\\p{L}*|izle\\p{L}*|özetle\\p{L}*|ozetle\\p{L}*|araştır\\p{L}*|arastir\\p{L}*"]),
    strong: B(["hatırlat\\p{L}*|hatirlat\\p{L}*|otomatik(?:\\p{L}*)"]),
  },
  ar: {
    recur: SUB([
      "كل (?:يوم|صباح|مساء|ليلة|أسبوع|اسبوع|شهر|ساعة|اثنين|إثنين|ثلاثاء|أربعاء|اربعاء|خميس|جمعة|سبت|أحد|احد|\\d+ ساعات)",
      "يومياً|يوميا|أسبوعياً|أسبوعيا|اسبوعيا|شهرياً|شهريا|مرة (?:في|كل) (?:اليوم|الأسبوع|الاسبوع|الشهر)",
    ]),
    act: SUB(["ذكرني|ذكّرني|أرسل|ارسل|ابعث|أبلغني|ابلغني|أخبرني|اخبرني|نبهني|نبّهني|تحقق|راقب|تابع|لخص|لخّص|ابحث"]),
    strong: SUB(["ذكرني|ذكّرني|تلقائيا|تلقائياً"]),
  },
  fa: {
    recur: SUB([
      "هر (?:روز|صبح|شب|هفته|ماه|ساعت|دوشنبه|سه‌شنبه|سه شنبه|چهارشنبه|پنجشنبه|پنج‌شنبه|جمعه|شنبه|یکشنبه|\\d+ ساعت)",
      "روزانه|هفتگی|ماهانه",
    ]),
    act: SUB(["یادآوری|یادم بنداز|بفرست|خبرم کن|اطلاع بده|بهم بگو|به من بگو|بررسی کن|چک کن|زیر نظر|خلاصه کن|جستجو کن|تحقیق کن"]),
    strong: SUB(["یادم بنداز|یادآوری کن|خودکار"]),
  },
  he: {
    recur: SUB([
      "כל (?:יום|בוקר|ערב|לילה|שבוע|חודש|שעה|שבת|\\d+ שעות)|מדי (?:יום|בוקר|ערב|שבוע|חודש|שעה)",
      "יומי|יומית|שבועי|שבועית|חודשי|חודשית",
    ]),
    act: SUB(["תזכיר לי|תזכירי לי|הזכר לי|שלח לי|תשלח לי|תשלחי לי|תודיע לי|תודיעי לי|תגיד לי|תגידי לי|בדוק|תבדוק|תבדקי|עקוב|תעקוב|סכם|תסכם|תסכמי|חפש|תחפש"]),
    strong: SUB(["תזכיר לי|תזכירי לי|הזכר לי|אוטומטית"]),
  },
  hi: {
    recur: B([
      "हर (?:दिन|रोज़|रोज|सुबह|शाम|रात|हफ़्ते|हफ्ते|सप्ताह|महीने|घंटे|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|\\d+ घंटे)",
      "रोज़|रोज|रोजाना|रोज़ाना|प्रतिदिन|दैनिक|साप्ताहिक|मासिक",
    ]),
    act: SUB(["याद दिला|भेज|बताओ|बताना|बताएं|बताइए|बताएँ|सूचित कर|चेक कर|जाँच|जांच|नज़र रख|नजर रख|सारांश|खोज|रिसर्च"]),
    strong: SUB(["याद दिला|अपने आप|ऑटोमैटिक"]),
  },
  ur: {
    recur: SUB([
      "ہر (?:دن|روز|صبح|شام|رات|ہفتے|مہینے|گھنٹے|پیر|منگل|بدھ|جمعرات|جمعہ|اتوار|\\d+ گھنٹے)",
      "روزانہ|ہفتہ وار|ماہانہ",
    ]),
    act: SUB(["یاد دلا|بھیج|بتا|مطلع کر|چیک کر|جانچ|نظر رکھ|خلاصہ|تلاش|تحقیق"]),
    strong: SUB(["یاد دلا|خودکار"]),
  },
  bn: {
    recur: SUB([
      "প্রতিদিন|রোজ|প্রতি (?:দিন|সকাল|সকালে|সন্ধ্যা|সন্ধ্যায়|রাত|রাতে|সপ্তাহ|সপ্তাহে|মাস|মাসে|ঘণ্টা|ঘণ্টায়|সোমবার|মঙ্গলবার|বুধবার|বৃহস্পতিবার|শুক্রবার|শনিবার|রবিবার|\\d+ ঘণ্টা)",
      "দৈনিক|সাপ্তাহিক|মাসিক",
    ]),
    act: SUB(["মনে করিয়ে|পাঠাও|পাঠান|পাঠিয়ে|জানাও|জানান|জানিয়ে|বলো|বলুন|চেক কর|পরীক্ষা কর|নজর রাখ|সারসংক্ষেপ|সংক্ষেপে|খুঁজে|গবেষণা"]),
    strong: SUB(["মনে করিয়ে|স্বয়ংক্রিয়"]),
  },
  id: {
    recur: B([
      "(?:setiap|tiap) (?:hari|pagi|siang|sore|malam|minggu|pekan|bulan|jam|senin|selasa|rabu|kamis|jumat|jum'at|sabtu|\\d+ jam)",
      "harian|mingguan|bulanan|sehari sekali|seminggu sekali|sebulan sekali",
    ]),
    act: B(["ingatkan|kirimkan|kirimi|kirim|beri tahu|beritahu|kabari|kasih tahu|cek|periksa|pantau|awasi|rangkum|ringkas|ringkaskan|cari|carikan|riset|teliti"]),
    strong: B(["ingatkan|otomatis"]),
  },
  sw: {
    recur: B(["kila (?:siku|asubuhi|jioni|usiku|wiki|mwezi|saa|jumatatu|jumanne|jumatano|alhamisi|ijumaa|jumamosi|jumapili|baada ya saa \\d+)"]),
    act: B(["nikumbushe|nitumie|tuma|niarifu|nijulishe|niambie|kagua|angalia|fuatilia|fupisha|tafuta|tafiti"]),
    strong: B(["nikumbushe|kiotomatiki"]),
  },
  ht: {
    recur: B([
      "chak (?:jou|maten|aswè|aswe|swa|semèn|semen|mwa|lè|èdtan|edtan|lendi|madi|mèkredi|mekredi|jedi|vandredi|samdi|dimanch|\\d+ (?:èdtan|edtan))",
      "tout (?:jou|maten|semèn|semen)",
    ]),
    act: B(["raple m|raple mwen|fè m sonje|fe m sonje|voye ban m|voye pou mwen|voye m|di m|di mwen|fè m konnen|fe m konnen|tcheke|verifye|siveye|rezime|chèche|cheche|fè rechèch"]),
    strong: B(["raple m|raple mwen|fè m sonje|fe m sonje|otomatikman"]),
  },
  tl: {
    recur: B([
      "araw-araw|araw araw|lingguhan|buwanan",
      "(?:tuwing|bawat|kada) (?:araw|umaga|hapon|gabi|linggo|buwan|oras|lunes|martes|miyerkules|huwebes|biyernes|sabado|\\d+ oras)",
    ]),
    act: B(["paalalahanan|ipaalala|paalala|padalhan|ipadala|magpadala|sabihan|sabihin|ipaalam|abisuhan|i-check|tingnan|bantayan|subaybayan|ibuod|hanapin|magsaliksik|saliksikin"]),
    strong: B(["ipaalala|paalalahanan|awtomatiko"]),
  },
  vi: {
    recur: B([
      "mỗi (?:ngày|sáng|tối|tuần|tháng|giờ|buổi sáng|thứ hai|thứ ba|thứ tư|thứ năm|thứ sáu|thứ bảy|chủ nhật|\\d+ (?:giờ|tiếng))",
      "hằng ngày|hàng ngày|hằng tuần|hàng tuần|hằng tháng|hàng tháng|sáng nào cũng|ngày nào cũng",
    ]),
    act: B(["nhắc tôi|nhắc mình|nhắc nhở|gửi cho tôi|gửi tôi|gửi cho mình|báo cho tôi|báo tôi|thông báo|cho tôi biết|nói cho tôi|kiểm tra|theo dõi|tóm tắt|tìm kiếm|nghiên cứu"]),
    strong: B(["nhắc tôi|nhắc mình|tự động"]),
  },
  th: {
    // "ทุกวันนี้" is "these days", not "every day".
    recur: SUB(["ทุกวัน(?!นี้)|ทุกเช้า|ทุกเย็น|ทุกคืน|ทุกสัปดาห์|ทุกอาทิตย์|ทุกเดือน|ทุกชั่วโมง|ทุก ?\\d+ ?ชั่วโมง|รายวัน|รายสัปดาห์|รายเดือน"]),
    act: SUB(["เตือน|ส่ง|แจ้ง|บอก|ตรวจสอบ|เช็ค|เช็ก|ติดตาม|สรุป|ค้นหา|หาข้อมูล"]),
    strong: SUB(["เตือนฉัน|เตือนผม|เตือนหนู|เตือนด้วย|อัตโนมัติ"]),
  },
  ja: {
    recur: SUB(["毎日|毎朝|毎晩|毎夕|毎週|毎月|毎時|毎年|平日|週に?一回|週1|月に?一回|月1|時間ごと|時間おき|[月火水木金土日]曜(?:日)?ごと|毎週[月火水木金土日]曜"]),
    act: SUB(["リマインド|思い出させ|知らせて|教えて|送って|送信|通知|チェック|確認|監視|見張|まとめて|要約|調べて|リサーチ|探して"]),
    strong: SUB(["リマインド|自動で|自動的"]),
  },
  ko: {
    recur: SUB(["매일|매주|매달|매월|매시간|매년|날마다|아침마다|저녁마다|밤마다|주마다|평일마다|[월화수목금토일]요일마다|\\d+ ?시간마다|시간마다"]),
    act: SUB(["알려|알림|리마인드|상기시켜|보내|전송|확인|체크|모니터링|감시|요약|정리해|조사|찾아|검색"]),
    strong: SUB(["리마인드|상기시켜|자동으로"]),
  },
  "zh-Hans": {
    recur: SUB(["每天|每日|每晚|每早|每周|每星期|每个星期|每月|每个月|每小时|每个小时|每隔|每年|天天|工作日|每逢|每\\d+小时|每周[一二三四五六日天]"]),
    act: SUB(["提醒|发给我|发送|给我发|通知|告诉我|检查|查看|监控|盯着|总结|汇总|摘要|搜索|调研|查一下"]),
    strong: SUB(["提醒我|自动"]),
  },
  "zh-Hant": {
    recur: SUB(["每天|每日|每晚|每早|每週|每星期|每個星期|每月|每個月|每小時|每個小時|每隔|每年|天天|工作日|每逢|每\\d+小時|每週[一二三四五六日天]"]),
    act: SUB(["提醒|發給我|發送|給我發|通知|告訴我|檢查|查看|監控|盯著|總結|彙總|摘要|搜尋|調研|查一下"]),
    strong: SUB(["提醒我|自動"]),
  },
};

/** The languages listed, for the tests. */
export const SCHEDULE_LANGUAGES = Object.keys(LANGUAGES);

/**
 * Whether a message asks for something done again and again, or later, in any of the languages (a
 * message in one often has the other's words, "every day" in a Tagalog one).
 */
export function asksRecurring(whole: string): boolean {
  const s = whole.slice(0, RECURRING_CHARS);
  if (!s.trim()) return false;
  return Object.values(LANGUAGES).some((w) => !w.not?.test(s) && (Boolean(w.strong?.test(s)) || (w.recur.test(s) && w.act.test(s))));
}
