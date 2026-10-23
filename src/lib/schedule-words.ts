/*
 * The words that say a message wants something done again and again, or later ("every Monday, send me
 * the news about electric cars", "remind me to call the bank on Friday"), in Flash's 30 languages. Pure,
 * no imports. Where Automations is open to the account, the chat's answer is told Flash can do it by
 * itself (see the chat route), and the answer gets a Review automation card (see Flash.tsx).
 *
 * A sentence asks with a strong phrase ("remind me to", "notify me when … drops"), or with a schedule
 * ("every Monday", "each morning", "on Fridays", "daily" where it says when) and a request Flash would do
 * each time ("send me", "check", "sum up") close together in it. So a schedule in one sentence and "tell
 * me" in the next don't ask, nor do a habit ("I go to the gym every Monday, give me a plan"), a question
 * about one ("How often should I…"), a thing named after one ("a weekly report", "a daily routine") or
 * quoted words ("Translate 'every day'"). Only the first RECURRING_CHARS characters are read: the ask is
 * at the start of a message.
 *
 * The tables' patterns are built only when a message could match them (see pattern below): built all at
 * once, they took over a second the first time, on the chat route, before the answer.
 */

export const RECURRING_CHARS = 600;
// At most this many characters between the schedule and the request in a sentence.
const NEAR = 80;

// Whole words in scripts with spaces (a letter, mark or digit on neither side), and runs inside text
// for scripts without them (Chinese, Japanese, Thai) or where words take prefixes (Arabic, Hebrew).
const B = (alts: string[]): Source => ({ source: `(?<![\\p{L}\\p{M}\\p{N}])(?:${alts.join("|")})(?![\\p{L}\\p{M}\\p{N}])`, flags: "iu" });
const SUB = (alts: string[]): Source => ({ source: `(?:${alts.join("|")})`, flags: "iu" });

// A pattern as written, built when it's first needed (a RegExp written out is one too).
type Source = { source: string; flags: string };
type Words = {
  // A time that repeats, said of the request: "every Monday", "each morning", "twice a week".
  recur: Source;
  // A request Flash would do each time, in the forms people ask with: "send me", "check", "sum up".
  act: Source;
  // A request on its own: "remind me to", "notify me when … drops".
  strong?: Source;
  // In the same sentence, it's a question or a habit, not a request: "how often", "is it bad to".
  not?: Source;
  // Between the request and the schedule, someone else does it: "a routine I can do every day".
  between?: Source;
  // What comes right before a request where its words could be something else ("check" in "I check",
  // "a heart rate monitor"): the start of the sentence or part, "please", "can you", a schedule.
  lead?: Source;
};

// Quoted words and code are what a message is about, not what it asks. A quote mark between letters is
// part of a word (Hebrew דו"ח, ת"א), not a quote.
const QUOTED =
  /```[\s\S]{0,600}?(?:```|$)|`[^`\n]{0,200}`|(?<![\p{L}\p{N}])"[^"\n]{0,200}"(?![\p{L}\p{N}])|“[^”\n]{0,200}”|«[^»\n]{0,200}»|„[^“”\n]{0,200}[“”]|「[^」\n]{0,200}」|『[^』\n]{0,200}』|(?<![\p{L}\p{N}])['‘][^'’\n]{1,200}['’](?![\p{L}\p{N}])/gu;
// Where a sentence ends, and where a part of one does.
const SENTENCE = /[.!?;:…]{1,8}(?=\s|$)|[。！？；：؟۔।\n]{1,8}/u;
const PART = /[,，、،]|\s[-–—]\s/u;
const PARTS = /[,，、،]|\s[-–—]\s/gu;

const EN_DAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const EN_DAYS = "mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays";
const EN_TIME = "\\d{1,2}(?:[:.]\\d{2})?(?:\\s?(?:am|pm|a\\.m\\.|p\\.m\\.))?";
// The schedules said with words of their own ("daily" only below, where it says when).
const EN_EVERY = [
  `(?<!\\bfor )(?:every|each) (?:single )?(?:day|morning|afternoon|evening|night|week|month|year|hour|quarter|weekday|weekend|workday|weeknight|other (?:day|week|month)|few (?:hours|days|weeks)|couple of (?:hours|days|weeks)|half hour|${EN_DAY}|\\d{1,3} (?:minutes|mins|hours|hrs|days|weeks|months))(?! of\\b)`,
  `on (?:${EN_DAYS}|weekdays|weekends|workdays|weeknights)`,
  "(?:once|twice|three times|\\d{1,2} times) (?:a|per|each|every) (?:day|week|month|hour|year)",
  "on a (?:schedule|regular basis|daily basis|weekly basis|monthly basis|recurring basis)",
  // "Mondays at 8, send me…"
  `(?<=^|,\\s{0,2})(?:${EN_DAYS}|weekdays|weekends|mornings|evenings)(?=\\s{0,3}(?:,|at\\b))`,
];
// The requests, each counted only after EN lead below.
const EN_ACTS = [
  "remind|send|e-?mail|text|message|notify|alert|ping|tell|let me know|keep me (?:posted|updated|informed|in the loop)|update me|brief me",
  "give|get|bring|show|find|search|look up|look for|fetch|pull|check|monitor|watch|track|keep (?:an eye on|track of|tabs on)",
  "summari[sz]e|sum up|recap|research|compile|collect|gather|list|compare|scan|review|analy[sz]e|report|translate",
  "write|draft|make|create|generate|prepare|post|share|suggest|recommend|pick|plan|do|run|repeat",
];

const LANGUAGES: Record<string, Words> = {
  en: {
    recur: B([
      ...EN_EVERY,
      // "daily" says when only with nothing after it that it could describe: "send me the news daily",
      // "check it weekly and…", never "a daily routine", "the weekly report" or "the Daily Mail".
      "(?:daily|weekly|monthly|hourly|nightly|biweekly|fortnightly|quarterly|yearly|annually|everyday|regularly|periodically)(?=\\s{0,3}(?:$|[,.!?;:)]|(?:at|on|in|by|before|after|until|till|from|for|and|or|so|then|please|starting|via|with|if|unless|around|about|to|through|during|while|instead|as)\\b))",
    ]),
    act: B(EN_ACTS),
    strong: B([
      `remind me (?:to|that|every|each|daily|weekly|monthly|tomorrow|tonight|today|later|in \\d{1,3}|in an? (?:hour|minute|week|month)|on (?:${EN_DAY}|${EN_DAYS}|the \\d{1,2})|at ${EN_TIME}|at noon|at midnight|next|this (?:morning|afternoon|evening|weekend)|before|after|once)`,
      `remind me (?:about|of) [^.?!\\n]{1,60}?(?:tomorrow|tonight|today|later|at ${EN_TIME}|on (?:${EN_DAY}|${EN_DAYS})|next (?:week|month|year|${EN_DAY})|every|each|in \\d{1,3} (?:minutes?|hours?|days?|weeks?))`,
      "(?:set (?:up )?|create|schedule|make|add) (?:me )?(?:an? |my |a new )?(?:daily |weekly |monthly |recurring |scheduled )?(?:reminder|automation|recurring task|scheduled task)",
      "(?:notify|alert|ping|text|e-?mail|message) me (?:when(?:ever)?|as soon as|if|once|the moment|the minute|the day)",
      "(?:let me know|tell me|keep me posted) (?:as soon as|whenever|the moment|the minute|the day)",
      // "Let me know when the new iPhone is released", not "Tell me when World War II ended".
      "(?:let me know|tell me) when (?!to\\b)[^.?!\\n]{0,60}?(?:drops?|falls?|rises?|goes (?:up|down|on sale|live|back)|changes?|comes? out|(?:is|are|'s|’s|gets?) (?:released|out|announced|available|back|published|listed|cheaper|discounted)|launch(?:es)?|hits?|reaches|in stock|on sale|below|above|under \\$\\d{1,9}|over \\$\\d{1,9})",
      "automatically (?:every|each|send|check|tell|remind|e-?mail|text|notify|update|post|run|do|track)",
      "(?:send|give|e-?mail|text|get|bring|deliver)(?: me| us)? (?:an? |some )?(?:daily|weekly|monthly|hourly|nightly|biweekly|fortnightly|quarterly) (?:[\\w-]{1,20} ){0,2}?(?:update|summary|digest|recap|brief(?:ing)?|report|roundup|round-up|newsletter|reminder|news|e-?mail|alert|overview|list|tip|quote|forecast|check-in|horoscope|joke)s?",
      "automate (?:this|that|it)(?: for me)?(?: please)?$",
    ]),
    // A question ("Is it bad to check your phone every hour?", "What should I post every day?") or how often.
    not: /^(?:is|are|was|were|does|did|should|shall|how|why|what|which|who|where)\b|^do (?:you|i|we|they|people)\b|\bhow (?:often|many times)\b/i,
    between:
      /\b(?:I|we|you|they|he|she|people|kids|one|it)\s{1,3}(?:can|could|should|must|might|may|will|would|need to|have to|usually|always|often|sometimes|normally|go|do|eat|drink|take|get|have|walk|run|work|die|sleep|spend|make|earn|lose|gain|burn|read|watch|use|feel|pay|meet|exercise|study|train)\b|\b(?:if|when) I\b/i,
    lead: new RegExp(
      `(?:^|[,;(]\\s{0,3}|(?<![\\p{L}])(?:please|pls|plz|kindly|and|then|also|just|so|now|ok|okay|hey|hi|yes|can you|could you|would you|will you|can u|could u|you can|you could|i want you to|i'd like you to|i’d like you to|i would like you to|i need you to|help me|go ahead and|hey flash|flash|try to|remember to|don't forget to|don’t forget to)\\s{1,3}|(?:${EN_EVERY.join("|")})(?:\\s{1,3}(?:morning|afternoon|evening|night))?(?:\\s{1,3}(?:at|around|by|before|after|from)\\s{1,3}${EN_TIME})?\\s{1,3})$`,
      "iu",
    ),
  },
  es: {
    recur: B([
      // "un menú para cada día de la semana", "mis gastos de cada mes", "cuántos días tiene cada mes": not schedules.
      "(?<!(?<![\\p{L}])(?:para|por|de|tiene|tienen) )(?:cada|todos los|todas las) (?:santos? )?(?:d[ií]as?|ma[nñ]anas?|tardes?|noches?|madrugadas|semanas?|mes|meses|a[nñ]os?|horas?|media hora|quincenas?|fin(?:es)? de semana|findes?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|\\d{1,3} (?:minutos|horas|d[ií]as|semanas|meses)|(?:dos|tres|cuatro|cinco|seis|diez|doce|quince|veinte|treinta) (?:horas|d[ií]as|semanas|meses)|pocas horas|par de (?:horas|d[ií]as))(?: y (?:los )?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?))?(?! de (?:la|el|cada|esta|este)(?![\\p{L}])| del(?![\\p{L}]))(?: (?:a|hacia|sobre|antes de|despu[eé]s de|desde) las? \\d{1,2}(?:[:.h]\\d{2})?(?: ?(?:am|pm|h|hs|hrs))?| (?:a|al) (?:la una|mediod[ií]a|medianoche)| (?:por|en|de) la (?:ma[nñ]ana|tarde|noche)| temprano| a primera hora| en punto){0,3}",
      // "Los lunes mándame…", "Los lunes a las 8, …" or "… los lunes." says when; "Dame un plan, los lunes pecho"
      // doesn't.
      "(?<=^[¿¡]?)los (?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados|domingos|fines de semana|findes)",
      "(?<!para |de |en |hasta |desde )los (?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados|domingos|fines de semana|findes)(?=\\s{0,3}(?:$|[,.!?;:)]|(?:a|hacia|sobre) las?(?![\\p{L}])|(?:por|en) la (?:ma[nñ]ana|tarde|noche)|temprano))(?: (?:a|hacia|sobre) las? \\d{1,2}(?:[:.h]\\d{2})?(?: ?(?:am|pm|h|hs|hrs))?| (?:por|en|de) la (?:ma[nñ]ana|tarde|noche)| temprano){0,2}",
      "(?<=^|[,;¿¡]\\s{0,2})(?:de lunes a (?:viernes|s[aá]bado|domingo)|entre semana)",
      "diariamente|a diario|semanalmente|mensualmente|quincenalmente",
      "(?:una|dos|tres|cuatro|\\d{1,2}) (?:vez|veces) (?:al|por|a la|cada) (?:d[ií]a|semana|mes|hora|a[nñ]o)",
      // "Every morning mándame las noticias".
      EN_EVERY[0],
    ]),
    act: B([
      "(?:env[ií][ae]|m[aá]nd[ae]|d[ae]|p[aá]s[ae]|tr[aá]e|tr[aá]iga|d[ií]|d[ií]ga|dec[ií]|av[ií]s[ae]|recu[eé]rd[ae]|record[aá]|escr[ií]b[aei]|h[aá]z|h[aá]ga|hac[eé]|b[uú]sc[ae]|b[uú]sque|prep[aá]r[ae]|mu[eé]str[ae]|mostr[aá]|res[uú]m[aei]|cu[eé]nt[ae]|cont[aá]|notif[ií]c[ae]|notif[ií]que|inf[oó]rm[ae]|actual[ií]z[ae]|actual[ií]ce|sugi[eé]r[ae]|suger[ií]|recom[ií]end[ae]|recomend[aá]|gen[eé]r[ae]|red[aá]ct[ae]|al[eé]rt[ae]|mant[eé]n|mant[eé]nga|cons[ií]gue|cons[ií]ga|ens[eé][nñ][ae]|expl[ií]c[ae]|expl[ií]que)(?:me|nos)(?:lo|la|los|las)?(?! (?:by|a dozen)(?![\\p{L}]))",
      "env[ií][ae]|manda|mande|revisa|revise|comprueba|compruebe|chequea|chequee|checa|verifica|verifique|vigila|vigile|monitorea|monitoree|rastrea|rastree|busca|busque|investiga|investigue|resume|resuma|escribe|escriba|redacta|redacte|haz|haga|prepara|prepare|genera|genere|crea|compila|compile|recopila|recopile|compara|compare|analiza|analice|publica|publique|recomienda|recomiende|sugiere|sugiera|elige|elija|controla|controle|sigue (?:el|la|los|las)|h[aá]zlo|h[aá]galo|rep[ií]te(?:lo)?|rep[ií]ta(?:lo)?",
      "(?:me|nos) (?:mand[aá]s|env[ií][aá]s|d[aá]s|dices|dec[ií]s|avis[aá]s|recuerdas|record[aá]s|escribes|escrib[ií]s|haces|hac[eé]s|pas[aá]s|busc[aá]s|prepar[aá]s|resumes|resum[ií]s|cuentas|cont[aá]s|traes|tra[eé]s|muestras|mostr[aá]s|mantienes|manten[eé]s|notific[aá]s|inform[aá]s|sugieres|suger[ií]s|recomiendas|recomend[aá]s|gener[aá]s|actualiz[aá]s)",
      "(?:me|nos) (?:mandes|env[ií]es|des|digas|avises|recuerdes|escribas|hagas|pases|busques|prepares|resumas|cuentes|traigas|muestres|mantengas|notifiques|informes|sugieras|recomiendes|generes|actualices|mandaras|enviaras|dieras|dijeras|avisaras|recordaras|escribieras|hicieras|pasaras|buscaras|prepararas|resumieras|contaras)",
      "revises|compruebes|verifiques|vigiles|monitorees|busques|investigues|escribas|redactes|hagas|prepares|generes|compares|analices|publiques|revisaras|buscaras|hicieras|escribieras",
      "(?:(?:me|nos) )?(?:puedes|pod[eé]s|podr[ií]as|puede|podr[ií]a|pudieras|pueden|podr[ií]an|quieres|quer[eé]s|te animas a|te importar[ií]a|ser[ií]as capaz de)(?: por favor| porfa)? (?:(?:me|nos) )?(?:enviar|mandar|dar|pasar|traer|decir|avisar|recordar|escribir|hacer|buscar|preparar|mostrar|resumir|contar|notificar|informar|actualizar|sugerir|recomendar|generar|redactar|crear|revisar|comprobar|chequear|checar|verificar|vigilar|monitorear|rastrear|investigar|compilar|recopilar|comparar|analizar|publicar|elegir|repetir|seguir|mantener|ense[nñ]ar|explicar|alertar|conseguir)(?:me|nos)?(?:lo|la|los|las)?",
      "(?:enviar|mandar|dar|pasar|traer|decir|avisar|recordar|escribir|hacer|buscar|preparar|mostrar|resumir|contar|notificar|informar|actualizar|sugerir|recomendar|generar|mantener|ense[nñ]ar|explicar|alertar|conseguir)(?:me|nos)(?:lo|la|los|las)?",
      // "Quiero recibir las noticias…", not "Quiero recibir clases de piano todos los sábados".
      "(?:quiero|quisiera|me gustar[ií]a|necesito|me encantar[ií]a|deseo) (?:recibir(?! (?:clases|lecciones|cursos|terapia|tratamientos?|visitas|masajes|sesiones|ayuda|atenci[oó]n|formaci[oó]n|entrenamientos?|cuidados|asesor[ií]a)(?![\\p{L}]))|que me lleguen?|que me llegaran?)",
      "(?:quiero|quisiera|necesito|me gustar[ií]a (?:recibir|tener)) (?:un|una|unos|unas|las|los|el|la|mis|mi) (?:\\p{L}{1,15} )?(?:noticias|res[uú]men(?:es)?|informe|reporte|bolet[ií]n|actualizaci[oó]n|recordatorio|alerta|novedades|chiste|frase|consejo|mensaje|correo|titulares|clima|pron[oó]stico|hor[oó]scopo|cotizaci[oó]n)",
    ]),
    strong: B([
      // "Recuérdame pagar la renta", not "¿Quién canta Recuérdame?" or "Recuérdame la trama de Hamlet".
      "(?:(?:recu[eé]rd[ae]|record[aá])(?:me|nos)(?:lo)?|(?:me|nos) (?:recuerdas|record[aá]s|recordar[ií]as)|(?:(?:me|nos) )?(?:puedes|pod[eé]s|podr[ií]as|puede|podr[ií]a) (?:(?:me|nos) )?recordar(?:me|nos)?)(?: por favor| porfa)? (?:que|q|de \\p{L}{2,15}(?:ar|er|ir)(?:me|te|le|lo|la|nos|se)?(?![\\p{L}])|\\p{L}{2,15}(?:ar|er|ir)(?:me|te|le|lo|la|nos|se|les|los|las)?(?![\\p{L}])|(?<!(?:de|por|en|la) )ma[nñ]ana|hoy|esta (?:noche|tarde|ma[nñ]ana|semana)|luego|m[aá]s tarde|pasado ma[nñ]ana|en \\d{1,3}|en (?:una|media) hora|en un (?:rato|mes|a[nñ]o)|dentro de|el (?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|pr[oó]ximo|d[ií]a \\d{1,2}|\\d{1,2})|la (?:pr[oó]xima|semana que viene)|a las \\d|al mediod[ií]a|cada|todos|todas|a diario|diariamente|antes de|despu[eé]s de|una vez)",
      "(?:recu[eé]rd[ae]|record[aá])(?:me|nos) (?:el|la|lo|los|las|del|de la|de|sobre|mi|mis) (?!(?:lo )?qu[eé] [^.?!\\n]{0,30}?\\p{L}(?:ó|aste|iste|aron|ieron|[ií]a|[ií]an|aba|aban)(?![\\p{L}])|qui[eé]n|c[oó]mo |cu[aá]l)[^.?!\\n]{1,50}? (?:(?<!(?:de|por|en|la) )ma[nñ]ana|hoy|esta (?:noche|tarde)|el (?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|pr[oó]ximo|d[ií]a \\d{1,2}|\\d{1,2})|la pr[oó]xima|a las \\d|en \\d{1,3}|cada|todos los|todas las|pasado ma[nñ]ana)",
      "(?:p[oó]n|p[oó]nme|crea|cr[eé]ame|configura|config[uú]rame|programa|progr[aá]mame|agenda|ag[eé]ndame|h[aá]zme|haz|a[nñ]ade|a[nñ][aá]deme|agrega|agr[eé]game|activa|establece|fija)(?: por favor)? (?:un |una |el |mi )?(?:nuevo |nueva )?(?:recordatorio|alarma|automatizaci[oó]n|tarea (?:programada|recurrente|autom[aá]tica))",
      "(?:(?:me|nos) )?(?:puedes|pod[eé]s|podr[ií]as|puede|podr[ií]a) (?:poner|crear|configurar|programar|agendar|hacer|a[nñ]adir|agregar|activar)(?:me|nos)? (?:un |una )?(?:recordatorio|alarma|automatizaci[oó]n)",
      // "Avísame cuando salga el nuevo iPhone / si el bitcoin baja de 50 mil", not "avísame si necesitas algo".
      "(?:av[ií]s[ae]me|av[ií]sanos|notif[ií]c[ae]me|notif[ií]queme|al[eé]rt[ae]me|(?:me|nos) (?:avisas|avis[aá]s|avises|notificas|notifiques|alertas)|(?:(?:me|nos) )?(?:puedes|pod[eé]s|podr[ií]as|puede|podr[ií]a) (?:(?:me|nos) )?(?:avisar|notificar|alertar)(?:me|nos)?|(?:m[aá]nd[ae]me|env[ií][ae]me|escr[ií]b[ae]me) (?:un |una )?(?:mensaje|aviso|correo|alerta|notificaci[oó]n|email|whatsapp)) (?:cuando|cu[aá]ndo|en cuanto|apenas|tan pronto como|si|el d[ií]a (?:en )?que|en el momento (?:en )?que|siempre que|cada vez que)[^.?!\\n]{0,60}? (?:baje|bajen|suba|suban|caiga|caigan|salga|salgan|lancen|lance|se lance|publiquen|se publique|anuncien|se anuncie|estrenen|se estrene|est[eé]n? (?:disponibles?|a la venta|en oferta|en stock|por debajo|por encima|m[aá]s barat[oa]s?|rebajad[oa]s?)|vuelvan? a (?:estar|haber|subir|bajar)|haya (?:stock|existencias|ofertas?|descuentos?|rebajas|noticias|novedades|entradas)|lleguen? a|superen?|pase de|baje de|cambien?|se agoten?|se pueda (?:comprar|reservar|descargar)|cueste menos|abran (?:las|la|el|los)|baja|bajan|sube|suben|cae|caen|sale|salen|lanzan|se lanza|cambia|cambian|llega a|supera|est[aá] (?:disponible|a la venta|en oferta|en stock|por debajo|por encima|m[aá]s barat[oa]|rebajad[oa])|hay (?:stock|existencias|ofertas?|descuentos?|rebajas|entradas)|vuelve a (?:estar|haber)|se agota|por debajo de|por encima de|cuesta menos)",
      "(?:d[ií]me|d[ií]game|dec[ií]me|inf[oó]rm[ae]me|cu[eé]ntame|(?:me|nos) (?:dices|dec[ií]s|informas|inform[aá]s)) (?:cuando|cu[aá]ndo|en cuanto|apenas|tan pronto como|el d[ií]a (?:en )?que)[^.?!\\n]{0,60}? (?:baje|bajen|suba|suban|caiga|caigan|salga|salgan|lancen|se lance|publiquen|se publique|anuncien|se anuncie|estrenen|se estrene|est[eé]n? (?:disponibles?|a la venta|en oferta|en stock|por debajo|por encima|m[aá]s barat[oa]s?|rebajad[oa]s?)|vuelvan? a (?:estar|haber)|haya (?:stock|existencias|ofertas?|descuentos?|rebajas|entradas)|lleguen? a|superen?|se agoten?|se pueda (?:comprar|reservar|descargar)|cueste menos)",
      "(?:autom[aá]ticamente|de (?:forma|manera) autom[aá]tica) (?:cada|todos los|todas las|a diario|diariamente|semanalmente|env[ií]ame|m[aá]ndame|av[ií]same|recu[eé]rdame|revisa|dame|d[ií]me)",
      "(?:env[ií][ae]me|m[aá]nd[ae]me|av[ií]s[ae]me|recu[eé]rd[ae]me|h[aá]zlo|haz esto|rev[ií]salo|(?:me|nos) lo (?:mandas|env[ií]as))(?: [^\\s.?!,]{1,15}){0,3}? (?:autom[aá]ticamente|de (?:forma|manera) autom[aá]tica)",
      "automat[ií]za(?:lo|la|me|nos| esto| eso| esta tarea| este proceso)(?: por favor| porfa)?$",
      "(?:puedes|pod[eé]s|podr[ií]as) automatizar(?:lo|la| esto| eso| esta tarea| este proceso)(?: por favor| porfa)?$",
      // "Envíame un resumen semanal", not "Dame el informe mensual" or "Necesito un informe mensual para mañana".
      "(?:env[ií][ae]me|m[aá]nd[ae]me)(?: (?:un|una|unos|unas))?(?: (?!(?:el|la|los|las|mi|mis|tu|su|este|esta|ese|esa)\\s)\\p{L}{1,15})? (?:res[uú]men(?:es)?|informes?|reportes?|bolet[ií]n|actualizaci[oó]n(?:es)?|recordatorios?|alertas?|correos?|emails?|mensajes?|newsletter|digest|recap|briefing|repaso|pron[oó]stico|hor[oó]scopo|chistes?|frases?|consejos?|tips?|noticias|novedades|titulares) (?:diari[oa]s?|semanal(?:es)?|mensual(?:es)?|quincenal(?:es)?)(?! de (?:ejemplo|muestra|prueba)| modelo| (?:de )?plantilla)",
      "(?:d[ae]me|p[aá]s[ae]me|tr[aá]eme|h[aá]zme|prep[aá]rame|quiero|quisiera|necesito|me gustar[ií]a (?:recibir|tener)|quiero recibir)(?: (?:un|una|unos|unas))?(?: (?!(?:el|la|los|las|mi|mis|tu|su|este|esta|ese|esa)\\s)\\p{L}{1,15})? (?:res[uú]men(?:es)?|bolet[ií]n|recap|repaso|digest|newsletter|briefing|recordatorios?|alertas?|chistes?|frases?|consejos?|tips?|hor[oó]scopo|noticias|novedades|titulares) (?:diari[oa]s?|semanal(?:es)?|mensual(?:es)?|quincenal(?:es)?)(?! de (?:ejemplo|muestra|prueba)| modelo| (?:de )?plantilla)",
    ]),
    // How often, why, how much should one, benefits, is it good to, how do I, what happens if, a habit.
    not: B([
      "cada cu[aá]nto|con qu[eé] frecuencia|cu[aá]ntas veces|qu[eé] tan (?:seguido|a menudo|frecuente(?:mente)?)",
      "por qu[eé]|(?<=^[¿¡]?)(?:porque|por que|pq|xq)",
      "cu[aá]nt[oa]s? [^.?!]{0,40}?(?:debo|debe|deben|deber[ií]a|deber[ií]an|debemos|tengo que|hay que|se recomienda|es recomendable|necesita|conviene)",
      "beneficios|ventajas|desventajas|pros y contras|efectos|consecuencias|riesgos",
      "(?:es|ser[aá]|ser[ií]a) (?:bueno|buena|malo|mala|normal|sano|saludable|recomendable|necesario|peligroso|seguro|mejor|peor|grave|raro|verdad|cierto)",
      "c[oó]mo (?:puedo|podr[ií]a|hago|hacer|se|dejo|dejar|evito|evitar|configuro|configurar|pongo|poner|creo|crear|consigo|activo|activar|programo|programar|desactivo|desactivar|quito|quitar|paro|parar|logro)",
      "qu[eé] (?:pasa|pasar[ií]a|sucede|ocurre) si",
      // "Cada lunes voy al gimnasio, dame un plan": a habit, then a one-off ask.
      "(?:cada|todos los|todas las|los) (?:\\p{L}{3,12}|fin(?:es)? de semana)(?: y (?:los )?\\p{L}{3,10})?(?: (?:a|de|por|en) (?:la|las) (?:\\d{1,2}(?:[:.]\\d{2})?|\\p{L}{3,8}))?(?: (?:temprano|antes de \\p{L}{2,10}|despu[eé]s del? \\p{L}{2,10}))?,? (?:yo |nosotros |siempre )?(?:me |nos |se |le |les |lo |la )?(?:voy|vamos|hago|hacemos|como|comemos|bebo|tomo|salgo|leo|veo|uso|gasto|gano|duermo|corro|camino|trabajo|trabajamos|estudio|entreno|reviso|miro|checo|compruebo|juego|nado|cocino|desayuno|almuerzo|ceno|escribo|publico|llamo|recibo|pago|tengo|tenemos|levanto|despierto|acuesto|ducho|peso|reunimos|siento|duele|quemo|invierto|practico|medito|mando|env[ií]o|escribo|llamo|hablo|visito|limpio|riego|saco|paseo|llevo|compro|pido|preparo)",
      // "Mi jefe llega y revisa el correo cada mañana", "Cada noche mi hijo se despierta a las 3, dame consejos":
      // someone else's habit.
      "(?<=^[¿¡]?)(?:mi|mis|tu|tus|su|sus|nuestr[oa]s?|[eé]l|ella|ellos|ellas)(?= \\p{L})",
      "(?<=^[¿¡]?)(?:cada|todos los|todas las|los) (?:\\p{L}{3,12}|fin(?:es)? de semana)(?: (?:a|de|por|en) (?:la|las) (?:\\d{1,2}(?:[:.]\\d{2})?|\\p{L}{3,8}))?,? (?:mi|mis|tu|tus|su|sus|nuestr[oa]s?)(?= \\p{L})",
      // "Dime si todos los años hay que pagar el IBI", "Dime quién publica cada año…": a question.
      "(?<=^[¿¡]?)(?:d[ií]me|d[ií]game|dec[ií]me|cu[eé]ntame|expl[ií]came|(?:me )?(?:puedes|podr[ií]as) decir(?:me)?) (?:si|qui[eé]n(?:es)?)",
      // "Dime qué significa a diario": the words themselves.
      "(?:significa|quiere decir|se dice|traduce|traducir) (?:la palabra |la expresi[oó]n )?(?:a diario|diariamente|semanalmente|mensualmente|cada \\p{L}{3,10}|tod[oa]s l[oa]s \\p{L}{3,10})",
    ]),
    // "Dime cuántas calorías quemo cada día", "una rutina que pueda hacer cada día", a past habit.
    between: B([
      "yo|nosotros|voy|vamos|hago|hacemos|bebo|tomo|salgo|veo|duermo|corro|nado|cocino|reviso|checo|compruebo|quemo|invierto|medito|practico|ceno|puedo|debo|deber[ií]a|me (?:levanto|despierto|acuesto|ducho|peso|ejercito)|mando|escribo|llamo|visito|hablo",
      // "un cuento sobre un niño que visita a su abuela todos los domingos", "una farmacia abierta los domingos", "una
      // rutina para hacer cada mañana": the schedule belongs to someone or something else.
      "(?<!(?<![\\p{L}])(?:lo|d[ií]me|dec[ií]me|d[ií]game|cu[eé]ntame|expl[ií]came|av[ií]same|saber) )(?:que|quien|quienes) (?:(?:me|te|se|le|les|lo|la|nos) )?(?!(?:yo|t[uú]|usted|nosotros|cada|todos|todas|el|la|los|las|un|una|mi|mis|tu|tus|su|sus|nada)(?![\\p{L}]))(?!(?:sal[ge]|aparec|aparezc|public|publiqu|hay|surj|surg|lanc|lanz|cambi|baj|sub|pas|ocurr|lleg|encuentr|sea)\\p{L}{0,3}(?![\\p{L}]))\\p{L}{1,15}(?:a|e|an|en)",
      "abiert[oa]s?|cerrad[oa]s?",
      "(?<!(?:recordatorios?|avisos?|mensajes?|alertas?|notificaci[oó]n|notificaciones|alarmas?) )para (?:poder )?(?:\\p{L}{1,15}(?:ar|er|ir)|ir)(?:l[oa]s?|te|se)?",
      "(?:que|para que|si|cuando|donde) (?:yo |nosotros |me |nos |lo |la |le )?(?:pueda|puedo|podamos|podemos|deba|debo|tenga|tengo|haga|hago|coma|como|beba|bebo|tome|tomo|vaya|voy|use|uso|gaste|gasto|gane|gano|pague|pago|duerma|duermo|camine|camino|corra|corro|estudie|estudio|trabaje|trabajo|ahorre|ahorro|invierta|invierto|queme|quemo|lea|leo|vea|veo)",
      "qu[eé] (?:comer|desayunar|almorzar|cenar|hacer|leer|ver|estudiar|entrenar|beber|tomar|ponerme|cocinar)",
      // "Recuérdame cuando íbamos a la playa cada domingo": a past habit.
      "era|eran|[ií]bamos|sol[ií]a|sol[ií]amos|cuando (?:yo |nosotros )?(?:iba|ten[ií]a|viv[ií]a|hac[ií]a)",
    ]),
    // A bare verb ("revisa", "busca") is also "he checks": a request counts at the start of the sentence or
    // part, after "por favor / puedes / quiero que", or right after a schedule ("Cada lunes revisa…").
    lead: new RegExp(
      `(?:^|[,;(¿¡]\\s{0,3}|(?<![\\p{L}])(?:por favor|porfa|porfavor|porfis|plis|pls|xfa|please|y|e|as[ií] que|por eso|luego|despu[eé]s|tambi[eé]n|adem[aá]s|ahora|oye|oiga|hola|buenas|ok|okay|vale|bueno|venga|anda|flash|entonces|pues|solo|s[oó]lo|simplemente|yo|t[uú]|usted|puedes|pod[eé]s|podr[ií]as|puede|podr[ií]a|pudieras|(?:me|nos) (?:puedes|pod[eé]s|podr[ií]as|puede|podr[ií]a)|(?:quiero|quisiera|necesito|me gustar[ií]a|me encantar[ií]a|te pido|le pido|prefiero) que|no olvides|olvides|no te olvides de|acu[eé]rdate de|recuerda|ay[uú]dame a|enc[aá]rgate de|me haces el favor de|hazme el favor de|ser[ií]as tan amable de|a partir de (?:hoy|ahora|ma[nñ]ana)|desde (?:hoy|ahora|ma[nñ]ana)(?: en adelante)?|de ahora en adelante|siempre|sin falta)\\s{1,3})(?:(?:(?:cada|todos los|todas las) (?:santos? )?(?:\\p{L}{3,12}|(?:\\d{1,3}|dos|tres|cuatro|cinco|seis|diez|doce|quince|veinte|treinta|par de) \\p{L}{3,8}|fin(?:es)? de semana|media hora)|${EN_EVERY[0]}|los (?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados|domingos|fines de semana)|de lunes a (?:viernes|s[aá]bado|domingo)|entre semana|a diario|diariamente|semanalmente|mensualmente|(?:una|dos|tres|\\d{1,2}) (?:vez|veces) (?:al|por|a la) \\p{L}{3,6})(?: y (?:los )?\\p{L}{3,10})?(?:\\s{1,3}(?:(?:a|hacia|sobre|como a|antes de|despu[eé]s de|desde) las? \\d{1,2}(?:[:.h]\\d{2})?(?:\\s?(?:am|pm|h|hs|hrs))?|a la una|al mediod[ií]a|a mediod[ií]a|a medianoche|(?:por|en|de) la (?:ma[nñ]ana|tarde|noche)|temprano|a primera hora|en punto|sin falta)){0,3}\\s{1,3})?$`,
      "iu",
    ),
  },
  pt: {
    recur: B([
      // "todo dia", "toda segunda de manhã", "a cada 2 horas"; not "todo o dia" (all day), "um cardápio para cada dia
      // da semana", "a missa de todo domingo" or "quantos dias tem cada mês".
      "(?<!(?<![\\p{L}])(?:para|pra|por|de|da|do|tem|t[eê]m) )(?:tod[oa]s? (?:[oa]s )?|a cada |cada )(?:santo )?(?:dias?|m[eê]s|meses|anos?|semanas?|manh[aã]s?|tardes?|noites?|madrugadas?|horas?|meia hora|fins? de semana|finais de semana|final de semana|segundas?|ter[cç]as?|quartas?|quintas?|sextas?|s[aá]bados?|domingos?|dias [uú]teis|\\d{1,3} (?:minutos|horas|dias|semanas|meses)|(?:duas|tr[eê]s|quatro|cinco|seis|dez|doze|vinte) (?:horas|semanas)|(?:dois|tr[eê]s|quatro|cinco|dez|quinze|vinte|trinta) (?:dias|meses))(?:-feiras?| feiras?)?(?: e (?:segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(?:-feiras?)?)?(?! d[ao]s?(?![\\p{L}])| inteir[oa])(?: (?:[aà]s?|por volta d[ae]s?|antes d[ae]s?|depois d[ae]s?|a partir d[ae]s?) \\d{1,2}(?:[:h.]\\d{2})?(?: ?(?:h|hs|horas|am|pm))?| ao meio-dia| [aà] meia-noite| (?:de|pela|[aà]|na) (?:manh[aã]|tarde|noite|madrugada)| cedo| em ponto| logo cedo){0,3}",
      "(?<!para |pra |de |em )(?:(?:[aà]s|nas) (?:segundas|ter[cç]as|quartas|quintas|sextas)(?:-feiras| feiras)?|(?:aos|nos) (?:s[aá]bados|domingos|fins de semana|finais de semana))(?: (?:[aà]s?|por volta d[ae]s?) \\d{1,2}(?:[:h.]\\d{2})?(?: ?(?:h|hs|horas))?| (?:de|pela|[aà]|na) (?:manh[aã]|tarde|noite)| cedo){0,2}",
      "(?<=^|[,;]\\s{0,2})de segunda a (?:sexta|s[aá]bado|domingo)(?:-feira)?",
      "diariamente|semanalmente|mensalmente|quinzenalmente|de hora em hora|dia sim,? dia n[aã]o",
      "(?:uma|duas|tr[eê]s|\\d{1,2}) vez(?:es)? (?:por|ao|na|no|a cada) (?:dia|semana|m[eê]s|hora|ano)",
      // "Every morning me manda as notícias".
      EN_EVERY[0],
    ]),
    act: B([
      "(?:me|nos) (?:manda|envia|d[aá]|diz|fala|avisa|lembra|mostra|passa|traz|escreve|faz|conta|notifica|informa|mant[eé]m|atualiza|sugere|recomenda|prepara|resume|busca|procura|arruma|arranja|gera|cria|ensina|explica|alerta|indica|envie|mande|d[eê]|diga|fale|avise|lembre|mostre|passe|traga|escreva|fa[cç]a|conte|notifique|informe|mantenha|atualize|sugira|recomende|prepare|resuma|busque|procure|arrume|arranje|gere|crie|ensine|explique|alerte|indique|enviasse|mandasse|desse|dissesse|falasse|avisasse|lembrasse|mostrasse|passasse|trouxesse|escrevesse|fizesse|contasse|informasse|mantivesse|preparasse|resumisse)",
      "(?:envie|envia|mande|manda|d[eê]|d[aá]|diga|diz|fale|fala|avise|avisa|lembre|lembra|mostre|mostra|passe|passa|traga|traz|escreva|escreve|fa[cç]a|faz|conte|conta|notifique|notifica|informe|informa|mantenha|mant[eé]m|atualize|atualiza|sugira|sugere|recomende|recomenda|prepare|prepara|resuma|resume|busque|busca|procure|procura|ensine|ensina|explique|explica|alerte|alerta|indique|indica)(?:-me|-nos| me)",
      "(?:envie|envia|mande|manda|fala|fale|diga|conta|conte|escreve|escreva|mostra|mostre|passa|passe|traz|traga|fa[cç]a|faz|prepara|prepare|busca|busque|procura|procure|pesquisa|pesquise) (?:pra|para) (?:mim|n[oó]s)",
      "envie|envia|mande|manda|verifique|verifica|confira|confere|cheque|checa|monitore|monitora|acompanhe|acompanha|pesquise|pesquisa|procure|procura|busque|busca|resuma|resume|escreva|escreve|redija|prepare|prepara|crie|cria|gere|gera|compile|compila|re[uú]na|junte|junta|compare|compara|analise|analisa|publique|publica|poste|posta|sugira|sugere|recomende|recomenda|escolha|escolhe|repita|repete|atualize|atualiza|rastreie|rastreia|vigie|vigia|selecione|seleciona|fique de olho|d[eê] uma olhada|fa[cç]a (?:um|uma|uns|umas|isso|isto|o|a|os|as)|faz (?:um|uma|uns|umas|isso|isto|o|a|os|as)",
      "(?:(?:me|nos) )?(?:pode|poderia|podia|consegue|conseguiria|d[aá] pra|d[aá] para|tem como|seria poss[ií]vel)(?: por favor)? (?:(?:me|nos) )?(?:mandar|enviar|dar|dizer|falar|avisar|lembrar|mostrar|passar|trazer|escrever|fazer|contar|notificar|informar|manter|atualizar|verificar|conferir|checar|monitorar|acompanhar|pesquisar|procurar|buscar|resumir|preparar|criar|gerar|compilar|reunir|juntar|comparar|analisar|listar|publicar|postar|sugerir|recomendar|escolher|repetir|ensinar|explicar|alertar|indicar|rastrear|vigiar|selecionar|redigir)(?:-me|-nos)?",
      // "Quero receber as notícias…", not "Quero receber aulas de violão toda semana".
      "(?:quero|queria|gostaria de|preciso|necessito|desejo) receber(?! (?:aulas|li[cç][oõ]es|cursos?|terapia|tratamentos?|visitas?|massage(?:m|ns)|sess[oõ]es|ajuda|atendimento|treinos?|cuidados|consultas?)(?![\\p{L}]))",
      "(?:quero|queria|gostaria de receber|preciso de|preciso) (?:um|uma|uns|umas|as|os|o|a|minhas|meus|meu|minha) (?:\\p{L}{1,15} )?(?:not[ií]cias|resumo|relat[oó]rio|boletim|atualiza[cç][aã]o|lembrete|alerta|novidades|piada|frase|dica|mensagem|e-?mail|manchetes|previs[aã]o|hor[oó]scopo|cota[cç][aã]o)",
    ]),
    strong: B([
      // "Me lembra de ligar pro médico amanhã", not "Essa música me lembra minha infância" or "Me lembra da trama de
      // Hamlet".
      "(?:(?:me|nos) (?:lembr[ae]|relembr[ae])|(?:lembr[ae]|relembr[ae])-(?:me|nos)|(?:(?:me|nos) )?(?:pode|poderia|consegue|d[aá] pra|tem como) (?:(?:me|nos) )?lembrar(?:-me|-nos)?)(?: por favor)? (?:de \\p{L}{2,15}(?:ar|er|ir|or)(?:-(?:me|te|lo|la|los|las|nos))?(?![\\p{L}])|que|q|amanh[aã]|hoje|mais tarde|daqui a|daqui \\d|em \\d{1,3}|em (?:uma|meia) hora|[aà]s \\d|ao meio-dia|[aà] noite|na (?:segunda|ter[cç]a|quarta|quinta|sexta|pr[oó]xima)|no (?:s[aá]bado|domingo|dia \\d{1,2}|fim de semana|pr[oó]ximo)|dia \\d{1,2}|tod[oa]s?|a cada|cada|diariamente|semana que vem|m[eê]s que vem|antes d[aoe]|depois d[aoe])",
      "(?:(?:me|nos) (?:lembr[ae]|relembr[ae])|(?:lembr[ae]|relembr[ae])-(?:me|nos)) (?:d[aoe]s?|sobre) (?!(?:o )?que [^.?!\\n]{0,30}?\\p{L}(?:ou|ei|aram|eram|iram|ava|avam|ia|iam)(?![\\p{L}])|quem |como |qual )[^.?!\\n]{1,50}? (?:amanh[aã]|hoje|[aà]s \\d|na (?:segunda|ter[cç]a|quarta|quinta|sexta|pr[oó]xima)|no (?:s[aá]bado|domingo|dia \\d{1,2}|pr[oó]ximo)|dia \\d{1,2}|tod[oa]s?|a cada|semana que vem|daqui a)",
      "(?:crie|cria|configure|configura|programe|programa|coloque|coloca|ponha|p[oõ]e|bota|agende|agenda|fa[cç]a|faz|adicione|adiciona|ative|ativa|marque|marca)(?:-me)?(?: por favor)? (?:um |uma |o |meu )?(?:novo |nova )?(?:lembrete|alarme|automa[cç][aã]o|tarefa (?:agendada|recorrente|autom[aá]tica))",
      "(?:(?:me|nos) )?(?:pode|poderia|consegue|d[aá] pra|tem como) (?:(?:me|nos) )?(?:criar|configurar|programar|colocar|p[oô]r|botar|agendar|fazer|adicionar|ativar|marcar) (?:um |uma )?(?:lembrete|alarme|automa[cç][aã]o)",
      // "Me avisa quando lançarem o novo iPhone / se o bitcoin cair", not "me avisa se precisar de algo" or "Me diga
      // quando o Muro de Berlim caiu".
      "(?:(?:me|nos) (?:avis[ae]|notifi(?:ca|que)|alert[ae])|(?:avis[ae]|notifi(?:ca|que)|alert[ae])-(?:me|nos)|(?:(?:me|nos) )?(?:pode|poderia|consegue|d[aá] pra|tem como) (?:(?:me|nos) )?(?:avisar|notificar|alertar)(?:-me|-nos)?|(?:me|nos) (?:mand[ae]|envi[ae]) (?:um |uma )?(?:mensagem|aviso|alerta|notifica[cç][aã]o|e-?mail|zap)) (?:quando|qd|qdo|qnd|assim que|logo que|se|caso|no dia (?:em )?que|no momento (?:em )?que|sempre que|toda vez que)[^.?!\\n]{0,60}? (?:ca[ií]rem|cair|baixar(?:em)?|subir(?:em)?|sa[ií]rem|sair|lan[cç]arem|for(?:em)? (?:lan[cç]ad|anunciad|publicad|liberad|divulgad)[oa]s?|estiver(?:em)? (?:dispon[ií]ve(?:l|is)|[aà] venda|em promo[cç][aã]o|em oferta|abaixo|acima|mais barat[oa]s?)|entrar(?:em)? em promo[cç][aã]o|tiver (?:promo[cç][aã]o|desconto|estoque|novidades?|not[ií]cias?|ingressos?)|voltar(?:em)?|chegar(?:em)? a|passar(?:em)? de|ficar(?:em)? (?:abaixo|acima|mais barat[oa]s?)|estrear(?:em)?|ultrapassar(?:em)?|atingir(?:em)?|esgotar(?:em)?|anunciarem|publicarem|liberarem|mudar(?:em)?|abrir(?:em)? (?:as|a|o|os)|cai|caem|baixa|baixam|sobe|sobem|sai|saem|lan[cç]a|lan[cç]am|muda|mudam|chega a|passa de|ultrapassa|abaixo de|acima de|est[aá] (?:dispon[ií]vel|[aà] venda|em promo[cç][aã]o|mais barat[oa])|tem (?:promo[cç][aã]o|desconto|estoque))",
      "(?:(?:me|nos) (?:diga|diz|fala|fale|conta|conte|informa|informe)|(?:diga|diz|informa|informe)-(?:me|nos)) (?:quando|qd|qdo|qnd|assim que|logo que)[^.?!\\n]{0,60}? (?:ca[ií]rem|(?<!quando )(?:cair|baixar|subir)|baixarem|subirem|sa[ií]rem|sair (?:o|a|os|as|um|uma)|lan[cç]arem|for(?:em)? (?:lan[cç]ad|anunciad|publicad|liberad|divulgad)[oa]s?|estiver(?:em)? (?:dispon[ií]ve(?:l|is)|[aà] venda|em promo[cç][aã]o|em oferta|abaixo|acima|mais barat[oa]s?)|entrar(?:em)? em promo[cç][aã]o|tiver (?:promo[cç][aã]o|desconto|estoque)|voltar(?:em)? (?:ao|pro|para o) estoque|ficar(?:em)? (?:abaixo|acima|mais barat[oa]s?)|ultrapassar(?:em)?|esgotar(?:em)?|anunciarem|publicarem|liberarem)",
      "automaticamente (?:tod[oa]s?|a cada|cada|diariamente|semanalmente|(?:me|nos) (?:mand[ae]|envi[ae]|avis[ae]|lembr[ae]))",
      "(?:(?:me|nos) (?:mand[ae]|envi[ae]|avis[ae]|lembr[ae])|(?:mand[ae]|envi[ae]|avis[ae]|lembr[ae])-(?:me|nos)|fa[cç]a isso|faz isso|verifique|verifica|confira|confere|publique|publica|poste|posta)(?: [^\\s.?!,]{1,15}){0,3}? automaticamente",
      "automatiz[ae](?: isso| isto|-o|-a)?(?: pra mim| para mim)?(?: por favor| pfv)?$",
      "(?:(?:me|nos) )?(?:pode|poderia|consegue|d[aá] pra|d[aá] para|tem como) automatizar(?: isso| isto)?(?: pra mim| para mim)?(?: por favor)?$",
      // "Me envie um resumo diário", not "Me dá o relatório mensal".
      "(?:(?:me|nos) (?:envi[ae]|mand[ae])|(?:envi[ae]|mand[ae])-(?:me|nos))(?: (?:um|uma|uns|umas))?(?: (?!(?:o|a|os|as|meu|minha|meus|minhas|seu|sua|esse|essa|este|esta)\\s)\\p{L}{1,15})? (?:resumos?|relat[oó]rios?|boletim|boletins|atualiza[cç](?:[aã]o|[oõ]es)|lembretes?|alertas?|e-?mails?|mensage(?:m|ns)|newsletter|digest|briefing|panorama|not[ií]cias|novidades|manchetes|previs[aã]o|hor[oó]scopo|piadas?|frases?|cita[cç](?:[aã]o|[oõ]es)|dicas?|an[aá]lises?) (?:di[aá]ri[oa]s?|semana(?:l|is)|mensa(?:l|is)|quinzena(?:l|is))(?! de (?:exemplo|modelo|teste)| modelo)",
      "(?:(?:me|nos) (?:d[aáeê]|passa|passe|traz|traga|fa[cç]a|faz|prepara|prepare)|(?:d[aáeê]|passa|passe|traz|traga|prepara|prepare)-(?:me|nos)|quero(?: receber)?|queria(?: receber)?|gostaria de(?: receber| ter)?|preciso de)(?: (?:um|uma|uns|umas))?(?: (?!(?:o|a|os|as|meu|minha|meus|minhas|seu|sua|esse|essa|este|esta)\\s)\\p{L}{1,15})? (?:resumos?|boletim|newsletter|digest|briefing|panorama|not[ií]cias|novidades|manchetes|lembretes?|alertas?|piadas?|frases?|dicas?|hor[oó]scopo|previs[aã]o) (?:di[aá]ri[oa]s?|semana(?:l|is)|mensa(?:l|is)|quinzena(?:l|is))(?! de (?:exemplo|modelo|teste)| modelo)",
    ]),
    // How often, why, how much should one, benefits, is it good to, how do I, what happens if, "research shows", a
    // habit.
    not: B([
      "com que frequ[eê]ncia|com qual frequ[eê]ncia|de quanto em quanto tempo|quantas vezes|(?:a )?cada quanto tempo",
      "por qu[eê]|porqu[eê]|(?<=^)(?:porque|pq)",
      "quant[oa]s? [^.?!]{0,40}?(?:devo|deve|devem|deveria|deveriam|devemos|preciso|precisa|tenho que|tem que|se deve|[eé] recomendado|[eé] ideal|recomenda-se)",
      "benef[ií]cios|vantagens|desvantagens|pr[oó]s e contras|efeitos|riscos|faz bem|faz mal",
      "(?:[eé]|seria|ser[aá]) (?:bom|boa|ruim|normal|saud[aá]vel|seguro|recomendado|necess[aá]rio|perigoso|melhor|pior|verdade|errado|certo)",
      "como (?:fa[cç]o|fazer|posso|consigo|configuro|configurar|coloco|colocar|crio|criar|ativo|ativar|desativo|desativar|paro|parar|evito|evitar|deixo|deixar|programo|programar|se faz|se cria|se configura|se diz|tiro|tirar)",
      "o que acontece(?:ria)? se",
      "(?:pesquisas?|estudos?|dados) (?:mostra|mostram|indica|indicam|comprova|comprovam|revela|revelam|aponta|apontam|diz|dizem|sugere|sugerem)",
      // "Toda segunda vou à academia, me dá um plano": a habit, then a one-off ask.
      "(?:tod[oa]s? (?:[oa]s )?|a cada |cada |[aà]s |nas |aos |nos )(?:\\p{L}{3,12}|fins? de semana)(?:-feiras?)?(?: e \\p{L}{3,10}(?:-feiras?)?)?(?: (?:[aà]s|de|pela|[aà]|na) (?:\\d{1,2}(?:[:h]\\d{2})?h?|\\p{L}{3,8}))?(?: (?:cedo|antes d[oa] \\p{L}{2,10}|depois d[oa] \\p{L}{2,10}))?,? (?:eu |a gente |n[oó]s |sempre )?(?:me |nos |se |lhe |lhes |a |o )?(?:vou|vamos|vai|fa[cç]o|fazemos|como|bebo|tomo|saio|leio|vejo|uso|gasto|ganho|pago|durmo|corro|caminho|treino|malho|estudo|trabalho|acordo|levanto|checo|verifico|confiro|olho|tenho|temos|nado|cozinho|rezo|medito|dirijo|pratico|janto|almo[cç]o|recebo|sinto|d[oó]i|d[oó]em|queimo|invisto|reunimos|re[uú]ne|encontro|mando|envio|escrevo|ligo|falo|visito|limpo|rego|levo|posto|compro|pe[cç]o|preparo|passeio)",
      // "Meu chefe chega e verifica o e-mail toda manhã", "Toda noite meu filho acorda às 3, me dá umas dicas":
      // someone else's habit.
      "(?<=^)(?:(?:o|a|os|as) )?(?:meu|minha|meus|minhas|seu|sua|seus|suas|nosso|nossa|nossos|nossas)(?= \\p{L})|(?<=^)(?:ele|ela|eles|elas)(?= \\p{L})",
      "(?<=^)(?:tod[oa]s? (?:[oa]s )?|a cada |cada |[aà]s |nas |aos |nos )(?:\\p{L}{3,12}|fins? de semana)(?:-feiras?)?(?: (?:[aà]s|de|pela|[aà]|na) (?:\\d{1,2}(?:[:h]\\d{2})?h?|\\p{L}{3,8}))?,? (?:(?:o|a|os|as) )?(?:meu|minha|meus|minhas|seu|sua|seus|suas|nosso|nossa)(?= \\p{L})",
      // "Me diz se todo ano tem que pagar o IPVA": a question.
      "(?<=^)(?:me )?(?:diz|diga|fala|fale|conta|conte|explica|explique)(?:-me)? (?:se|quem)",
      // "Me diz o que significa diariamente": the words themselves.
      "(?:significa|quer dizer|se diz|traduz(?:a|ir)?) (?:a palavra |a express[aã]o )?(?:diariamente|semanalmente|mensalmente|tod[oa]s? (?:[oa]s )?\\p{L}{3,10}|a cada \\p{L}{3,10}|cada \\p{L}{3,10})",
    ]),
    // "Me diga quantas calorias eu queimo todo dia", "uma rotina que eu possa fazer todo dia", a past habit.
    between: B([
      "eu (?:vou|fa[cç]o|como|bebo|tomo|saio|leio|vejo|uso|gasto|ganho|pago|durmo|corro|caminho|treino|malho|estudo|trabalho|acordo|checo|verifico|confiro|olho|posso|consigo|devo|tenho|queimo|invisto)|a gente|n[oó]s|vou|vamos|fa[cç]o|fazemos|bebo|tomo|saio|vejo|durmo|corro|malho|acordo|nado|queimo|invisto|posso|devo|deveria|me (?:levanto|acordo|peso|exercito)|mando|escrevo|ligo|visito|falo",
      // "um filme que passa toda sexta", "uma farmácia aberta todos os domingos", "exercícios pra fazer toda manhã": the
      // schedule belongs to someone or something else.
      "(?<!(?<![\\p{L}])(?:o|me diz|me diga|me fala|me fale|me conta|me conte|saber) )(?:que|quem) (?:(?:me|te|se|lhe|nos) )?(?!(?:eu|voc[eê]|vc|tu|n[oó]s|a gente|cada|tod[oa]s?|o|a|os|as|um|uma|meu|minha|seu|sua|nada)(?![\\p{L}]))(?!(?:sa[ií]|saem|aparec|public|lan[cç]|mud|acontec|cheg|surg|baix|sub|houv|tiv|t[eê]m)\\p{L}{0,4}(?![\\p{L}]))\\p{L}{1,15}(?:a|e|am|(?<!r)em)",
      "abert[oa]s?|fechad[oa]s?|h[aá]bitos? de|costume de",
      "(?<!(?:lembretes?|avisos?|alertas?|mensage(?:m|ns)|notifica[cç](?:[aã]o|[oõ]es)|alarmes?) )(?:pra|para) (?:poder )?(?:\\p{L}{1,15}(?:ar|er|ir|or)|ir)(?:-(?:lo|la|los|las|se))?",
      "(?:que|pra que|para que|se|quando) (?:eu |a gente |n[oó]s |me )?(?:possa|posso|possamos|podemos|deva|devo|tenha|tenho|fa[cç]a|fa[cç]o|coma|como|beba|bebo|tome|tomo|v[aá]|vou|use|uso|gaste|gasto|ganhe|ganho|pague|pago|durma|durmo|corra|corro|caminhe|estude|trabalhe|economize|economizo|invista|invisto|queime|queimo|guarde|guardo|aplique|aplico)",
      "o que (?:comer|fazer|ler|ver|vestir|estudar|treinar|beber|tomar|cozinhar|postar|escrever)",
      // "Me lembra quando a gente ia à praia todo domingo": a past habit.
      "era|eram|[ií]amos|costumava|costum[aá]vamos|quando (?:eu |a gente |n[oó]s )?(?:ia|tinha|morava|fazia)",
    ]),
    // "manda", "verifica" is also "he sends / checks": a request counts at the start of the sentence or part, after
    // "por favor / você pode / quero que", or right after a schedule ("Toda segunda me manda…").
    lead: new RegExp(
      `(?:^|[,;(]\\s{0,3}|(?<![\\p{L}])(?:por favor|por gentileza|pfv|pf|pls|plis|please|e|a[ií]|depois|tamb[eé]m|al[eé]m disso|agora|oi|ol[aá]|ei|opa|ok|okay|beleza|blz|flash|ent[aã]o|por isso|s[oó]|apenas|eu|voc[eê]|vc|tu|pode|poderia|podia|consegue|conseguiria|d[aá] pra|d[aá] para|tem como|(?:voc[eê]|vc) (?:pode|poderia|consegue)|(?:quero|queria|gostaria|preciso|necessito|prefiro) que(?: voc[eê]| vc| tu)?|n[aã]o (?:se )?esque[cç]a de|lembre de|lembra de|lembre-se de|a partir de (?:hoje|agora|amanh[aã])|de agora em diante|daqui (?:pra|para a) frente|sempre|sem falta|bom dia|boa tarde|boa noite)\\s{1,3})(?:(?:(?:tod[oa]s? (?:[oa]s )?|a cada |cada )(?:santo )?(?:\\p{L}{3,13}(?:-feiras?)?|(?:\\d{1,3}|duas|dois|tr[eê]s|quatro|cinco|seis|dez|doze|quinze|vinte|trinta) \\p{L}{3,8}|fins? de semana|finais? de semana|meia hora|dias [uú]teis)|${EN_EVERY[0]}|(?:[aà]s|nas|aos|nos) (?:segundas|ter[cç]as|quartas|quintas|sextas|s[aá]bados|domingos|fins de semana)(?:-feiras)?|de segunda a sexta(?:-feira)?|diariamente|semanalmente|mensalmente|de hora em hora|(?:uma|duas|tr[eê]s|\\d{1,2}) vez(?:es)? (?:por|ao|na|no) \\p{L}{3,6})(?: e \\p{L}{3,10}(?:-feiras?)?)?(?:\\s{1,3}(?:(?:[aà]s?|por volta d[ae]s?|antes d[ae]s?|depois d[ae]s?|a partir d[ae]s?) \\d{1,2}(?:[:h.]\\d{2})?(?:\\s?(?:h|hs|horas|am|pm))?|ao meio-dia|[aà] meia-noite|(?:de|pela|[aà]|na) (?:manh[aã]|tarde|noite|madrugada)|cedo|em ponto|logo cedo|sem falta)){0,3}\\s{1,3})?$`,
      "iu",
    ),
  },
  fr: {
    recur: B([
      // "chaque jour", not "pour chaque jour", "les ventes de chaque mois" or "chaque jour de la semaine" (a plan). The
      // time goes with it, so "Chaque soir à 20 heures : envoie-moi …" is a schedule on its own.
      "(?<!pour |de |du |des |avec |ouvert |ouverte |ouverts |ouvertes |fermé |fermée |ferme |fermee |dispo |disponible |disponibles )chaque (?:jour(?: ouvré| ouvrable)?|matin|soir|soirée|soiree|nuit|midi|après-midi|apres-midi|aprem|semaine|mois|année|annee|an|heure|demi-heure|trimestre|week-end|weekend|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|\\d{1,3} ?(?:minutes|min|heures|h|jours|semaines))(?: matin| soir| midi)?(?! de (?:la semaine|ma|mon|mes|notre|nos|ton|ta|tes|votre|vos|cette|ce|cet|son|sa|ses|leur|leurs|20\\d\\d)(?![\\p{L}])| de l['’](?:année|annee|an)| du (?:mois|voyage|séjour|sejour|stage|calendrier)| cette (?:année|annee)| l['’](?:an|année|annee) (?:dernier|dernière|derniere|passé|passée)| depuis| en 20\\d\\d)(?: (?:à|a|vers|dès|des) (?:\\d{1,2}(?: ?(?:h|heures?)(?: ?\\d{2})?|[:.]\\d{2})?(?: et demie?| et quart)?|(?:une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze) heures?(?: et demie?| et quart| moins le quart)?|midi(?: et demi)?|minuit))?",
      // "tout les jours" and "ts les jours" are how many write it.
      "(?<!pour |de |du |des |avec |ouvert |ouverte |ouverts |ouvertes |fermé |fermée |ferme |fermee |dispo |disponible |disponibles )(?:tous|tout|tou|ts|toutes|toute|ttes) les (?:jours(?: ouvrés| ouvrables)?|matins|soirs|nuits|midis|après-midi|apres-midi|semaines|mois|ans|week-ends|weekends|heures|demi-heures|lundis?|mardis?|mercredis?|jeudis?|vendredis?|samedis?|dimanches?|(?:\\d{1,3}|deux|trois|quatre|six|douze|quinze) ?(?:minutes|min|heures|h|jours|semaines|mois))(?: matin| soir| midi)?(?! de (?:la semaine|ma|mon|mes|notre|nos|ton|ta|tes|votre|vos|cette|ce|cet|son|sa|ses|leur|leurs|20\\d\\d)(?![\\p{L}])| de l['’](?:année|annee|an)| du (?:mois|voyage|séjour|sejour|stage|calendrier)| cette (?:année|annee)| l['’](?:an|année|annee) (?:dernier|dernière|derniere|passé|passée)| depuis| en 20\\d\\d| fériés| feries| férié| ferie| en (?:anglais|espagnol|allemand|italien|portugais|chinois|japonais|arabe|russe|néerlandais|neerlandais|suédois|suedois|polonais|français|francais|chiffres|lettres|latin)| de (?:janvier|février|fevrier|mars|mai|juin|juillet|septembre|novembre|décembre|decembre)| d['’](?:avril|août|aout|octobre)| (?:où|qui|que|dont|restants)(?![\\p{L}]))(?: (?:à|a|vers|dès|des) (?:\\d{1,2}(?: ?(?:h|heures?)(?: ?\\d{2})?|[:.]\\d{2})?(?: et demie?| et quart)?|(?:une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze) heures?(?: et demie?| et quart| moins le quart)?|midi(?: et demi)?|minuit))?",
      "(?:à la |a la |au |en )?(?:fin|début|debut) de chaque (?:semaine|mois|année|annee|journée|journee)|le (?:1er|premier|\\d{1,2}) de chaque mois|chaque (?:fin|début|debut) de (?:semaine|mois|année|annee|journée|journee|trimestre)",
      "(?:une|deux|trois|\\d{1,2}) fois par (?:jour|semaine|mois|heure|an)",
      // "les lundis", not "une blague sur les lundis".
      "(?<!pour |sur |de |des |contre |avec |aime |adore |déteste |deteste )les (?:lundis|mardis|mercredis|jeudis|vendredis|samedis|dimanches|week-ends|weekends)(?!,?\\s(?:(?:sont|étaient|etaient|ça|ca|je|on|il|elle|ils|elles|me|ne|y|en)(?![\\p{L}])|c['’]|j['’]|m['’]|n['’]))",
      "quotidiennement|quotidienement|journellement|hebdomadairement|mensuellement|régulièrement|regulierement|périodiquement|periodiquement",
    ]),
    act: B([
      // Commands with "moi", with or without the hyphen: "envoie-moi", "envoie moi", "envoi moi".
      "(?:envoie|envoi|envoies|envoyez|envoyer|donne|donnes|donnez|donner|dis|dit|dites|fais|fait|faites|écris|ecris|écrit|ecrit|écrivez|ecrivez|rédige|redige|rédigez|redigez|prépare|prepare|préparez|preparez|trouve|trouvez|cherche|cherchez|propose|proposez|montre|montrez|résume|resume|résumez|resumez|file|balance|transmets|transmettez|rappelle|rapelle|rappel|rappelez|rappeler|préviens|previens|prévenez|prevenez|avertis|avertissez|notifie|notifiez|alerte|alertez|informe|informez|sors|liste|listez|compile|génère|genere|générez|recommande|recommandez|suggère|suggere|partage|partagez|traduis|traduisez)(?:-|\\s)(?:moi|nous)",
      "(?:tiens|tenez|garde|gardez)(?:-|\\s)(?:moi|nous) (?:au courant|informée?s?|à jour|a jour)",
      // Commands on their own, counted only where a command stands (see lead): "vérifie", not "il vérifie".
      "(?:envoie|envoyez|vérifie|verifie|vérifiez|verifiez|contrôle|controle|contrôlez|controlez|surveille|surveillez|regarde|regardez|checke?|résume|resume|résumez|resumez|recherche|recherchez|cherche|cherchez|trouve|trouvez|compare|comparez|listez|fais|faites|refais|refaites|répète|repete|répétez|repetez|écris|ecris|écrivez|ecrivez|rédige|redige|rédigez|redigez|prépare|prepare|préparez|preparez|génère|genere|générez|generez|crée|cree|créez|creez|traduis|traduisez|publie|publiez|poste|postez|propose|proposez|suggère|suggere|suggérez|analyse|analysez|compile|compilez|suivez|fais le point|fais un point|garde un (?:œil|oeil) sur|gardez un (?:œil|oeil) sur)(?!\\s{0,2},)",
      // "Tu peux m'envoyer …", "pourriez-vous chaque matin vérifier …": the request and its verb.
      "(?:peux-tu|peux tu|pourrais-tu|pourrais tu|veux-tu|tu peux|tu pourrais|tu veux bien|tu voudrais bien|pouvez-vous|pouvez vous|pourriez-vous|pourriez vous|voulez-vous|vous pouvez|vous pourriez|vous voulez bien|est-ce que tu peux|est-ce que tu pourrais|est ce que tu peux|est-ce que vous pouvez|est-ce que vous pourriez|merci de|merci d['’]|n['’]oublie pas de|n['’]oublie pas d['’]|oublie pas de|pense à|pense a)(?:[^.?!,;\\n]{0,40}?[\\s'’])?(?:envoyer|donner|dire|écrire|ecrire|rédiger|rediger|préparer|preparer|faire|refaire|trouver|chercher|rechercher|proposer|montrer|résumer|resumer|rappeler|prévenir|prevenir|avertir|notifier|alerter|informer|tenir au courant|tenir informée?s?|tenir à jour|tenir a jour|vérifier|verifier|contrôler|controler|surveiller|regarder|checker|comparer|lister|générer|generer|créer|creer|traduire|publier|poster|suggérer|suggerer|analyser|compiler|suivre|répéter|repeter|transmettre|partager|recommander)",
      // "Est-il possible de m'envoyer …", not "est-il possible de faire du sport chaque jour ?".
      "(?:serait-il|est-il|est-ce|ce serait|c['’]est|ça serait|ca serait) possible (?:de (?:me |nous )|de m['’])(?:envoyer|donner|dire|écrire|ecrire|rédiger|rediger|préparer|preparer|faire|refaire|trouver|chercher|rechercher|proposer|montrer|résumer|resumer|rappeler|prévenir|prevenir|avertir|notifier|alerter|informer|tenir au courant|tenir informée?s?|tenir à jour|tenir a jour|vérifier|verifier|contrôler|controler|surveiller|regarder|checker|comparer|lister|générer|generer|créer|creer|traduire|publier|poster|suggérer|suggerer|analyser|compiler|suivre|répéter|repeter|transmettre|partager|recommander)",
      "(?:serait-il|est-il|est-ce|ce serait|c['’]est|ça serait|ca serait) possible de recevoir",
      // "J'aimerais que tu m'envoies …", "tu me rappelles … ?".
      "(?:je veux|je voudrais|j['’]aimerais|je souhaite|je souhaiterais|j['’]ai besoin) que tu(?:[^.?!,;\\n]{0,40}?[\\s'’])?(?:envoies|donnes|dises|écrives|ecrives|prépares|prepares|trouves|cherches|proposes|montres|résumes|resumes|rappelles|préviennes|previennes|avertisses|notifies|alertes|informes|tiennes|vérifies|verifies|contrôles|controles|surveilles|regardes|compares|fasses|refasses|rédiges|rediges|génères|generes|crées|crees|traduises|publies|postes|suggères|analyses|compiles|suives|transmettes|partages)",
      "tu (?:me |m['’]|nous )(?:envoies|donnes|dis|écris|ecris|prépares|prepares|trouves|cherches|proposes|montres|résumes|resumes|rappelles|préviens|previens|fais|fais|tiens au courant)",
      "(?:je veux|je voudrais|j['’]aimerais|je souhaite|je souhaiterais) (?:recevoir|(?:un|une|des) (?:petit |petite |court |courte )?(?:résumé|resume|récap|recap|récapitulatif|point|bulletin|briefing|brief|digest|rapport|rappel|newsletter|revue de presse|synthèse|synthese|sélection|selection|alerte|mise à jour|mise a jour|update|actu|news|nouvelle|info|notification|notif|message|citation|blague|conseil|astuce|liste|idée|idee|recette|suggestion|poème|poeme|playlist|mot|question|quiz|défi|defi|exercice)s?)",
    ]),
    strong: B([
      // Reminders aimed at Flash, with a task or a time after: "rappelle-moi d'appeler maman", not "rappelle-moi l'intrigue de Hamlet".
      "(?:rappelle|rapelle|rappel|rappelles|rappelez|rappellez|rappeler)(?:-|\\s)(?:moi|nous) (?:de\\s|d['’])(?!quoi|qui\\s|où|ou\\s|ce\\s|quel|combien|comment)\\p{L}{1,25}",
      "(?:rappelle|rapelle|rappel|rappelles|rappelez|rappellez|rappeler)(?:-|\\s)(?:moi|nous) (?:que\\s|qu['’])(?!veut|veulent|signifie|vaut|valent|dit|disent)\\p{L}{1,25}",
      "(?:rappelle|rapelle|rappel|rappelles|rappelez|rappellez|rappeler)(?:-|\\s)(?:moi|nous) (?:demain|ce soir|cet après-midi|cet apres-midi|cet aprem|aujourd['’]hui|tout à l['’]heure|tout a l['’]heure|plus tard|dans (?:\\d{1,3}|une|un|deux|trois|quelques)|à \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|a \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|vers \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)|le \\d{1,2}(?:er)?|la semaine prochaine|le mois prochain|chaque|tous les|toutes les|tout les|avant|après|apres|une fois(?! de plus| encore| pour toutes)|ce week-end|ce weekend|cette semaine)",
      "(?:rappelle|rapelle|rappel|rappelles|rappelez|rappellez|rappeler)(?:-|\\s)(?:moi|nous) (?:le|la|les|mon|ma|mes|l['’]|notre|nos) (?!(?:nom|noms|titre|titres|prénom|prenom|date|dates|formule|règle|regle|règles|regles|paroles|définition|definition|sens|signification|histoire|intrigue|résumé|resume|capitale|auteur|réalisateur|realisateur|chanteur|chanteuse|acteur|actrice|numéro|numero|mot|mots|différence|difference|recette|principe|théorème|theoreme|âge|age|origine|nombre|code|adresse|chiffre|score|résultat|resultat)(?![\\p{L}]))(?:(?!où |dont )[^.?!\\n]){1,60}?(?:demain|ce soir|plus tard|à \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|a \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|vers \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|chaque|tous les|toutes les|dans \\d{1,3} (?:minutes|heures|jours)|la semaine prochaine)",
      // The same after "tu peux", "pourriez-vous", "n'oublie pas de" … (see lead), or "tu me rappelles … ?".
      "(?:me|nous) rappeler (?:(?:de\\s|d['’]|que\\s|qu['’])(?!quoi|qui\\s|où|ou\\s|ce\\s|quel|combien|comment)\\p{L}{1,25}|demain|ce soir|plus tard|dans \\d{1,3}|à \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|a \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|chaque|tous les|toutes les)",
      "(?:tu|vous) (?:me|nous) (?:rappelles|rappelez|rappelleras|rappellerez) (?:(?:de\\s|d['’])\\p{L}{1,25}|demain|ce soir|plus tard|à \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|a \\d{1,2}(?:\\s?h(?:\\s?\\d{2})?|[:.]\\d{2})?|chaque|tous les)",
      "(?:je veux|je voudrais|j['’]aimerais|j['’]ai besoin) que tu me rappelles",
      "(?:fais|fait|faites)(?:-|\\s)moi penser (?:à|a) (?:\\p{L}{1,3}['’ ])?\\p{L}{1,20}(?:er|ir|re)(?![\\p{L}])",
      // Setting one up: "crée-moi un rappel", not "comment créer un rappel" (see lead).
      "(?:me |m['’])?(?:crée|cree|créer|creer|programme|programmer|planifie|planifier|mets|met|mettre|ajoute|ajouter|configure|configurer)(?:-moi|\\smoi)? (?:un|une) (?:rappel|alarme|automatisation)",
      // "Préviens-moi quand / dès que …", the moment something happens, not "préviens-moi quand tu as fini".
      "(?:préviens|previens|prévenez|prevenez|avertis|avertissez|alerte|alertez|notifie|notifiez|informe|informez|tiens|tenez)(?:-|\\s)moi(?: au courant)?,? (?:quand|dès que|dès qu['’]|des que|des qu['’]|lorsque|lorsqu['’]|aussitôt que|aussitot que|au moment où|le jour où)(?! (?:tu|vous)(?![\\p{L}])| t['’])",
      "(?:me prévenir|me prevenir|m['’]avertir|me notifier|m['’]alerter|m['’]informer|me tenir au courant|me faire signe|me dire|me faire savoir),? (?:dès que|dès qu['’]|des que|aussitôt que|au moment où|le jour où)(?! (?:tu|vous)(?![\\p{L}])| t['’])",
      "(?:me prévenir|me prevenir|m['’]avertir|me notifier|m['’]alerter),? (?:quand|lorsque|lorsqu['’])(?! (?:tu|vous)(?![\\p{L}])| t['’])",
      "(?:dis|dit|dites|fais|fait|faites)(?:-|\\s)moi(?: savoir| signe)?,? (?:dès que|dès qu['’]|des que|des qu['’]|aussitôt que|aussitot que|au moment où|le jour où)(?! (?:tu|vous)(?![\\p{L}])| t['’])",
      "(?:fais|fait|faites)(?:-|\\s)moi signe,? (?:quand|lorsque|lorsqu['’])(?! (?:tu|vous)(?![\\p{L}])| t['’])",
      "(?:envoie|envoi|envoyez)(?:-|\\s)moi (?:un (?:message|mail|e-mail|sms|texto)|une (?:notif|notification|alerte)),? (?:quand|dès que|des que|lorsque|lorsqu['’])(?! (?:tu|vous)(?![\\p{L}])| t['’])",
      // "Tu peux surveiller le prix et me prévenir quand il baisse": the request, then "et".
      "(?:peux-tu|peux tu|pourrais-tu|pourrais tu|tu peux|tu pourrais|tu veux bien|pouvez-vous|pouvez vous|pourriez-vous|pourriez vous|vous pouvez|vous pourriez|est-ce que tu peux|est-ce que tu pourrais|est-ce que vous pouvez|merci de)[^.?!;\\n]{1,80}? et (?:me prévenir|me prevenir|m['’]avertir|me notifier|m['’]alerter|me faire signe),? (?:quand|lorsque|lorsqu['’]|dès que|dès qu['’]|des que|au moment où|le jour où)(?! (?:tu|vous)(?![\\p{L}])| t['’])",
      "(?:peux-tu|peux tu|pourrais-tu|pourrais tu|tu peux|tu pourrais|tu veux bien|pouvez-vous|pouvez vous|pourriez-vous|pourriez vous|vous pouvez|vous pourriez|est-ce que tu peux|est-ce que tu pourrais|est-ce que vous pouvez|merci de)[^.?!;\\n]{1,80}? et (?:me prévenir|me prevenir|m['’]avertir|me notifier|m['’]alerter|me dire|me faire savoir),? (?:quand|lorsque|lorsqu['’]|si|s['’]) [^.?!\\n]{0,60}?(?:sort|sortira|sortent|sortiront|sera dispo|sera disponible|est dispo|est disponible|sont dispo|sont disponibles|seront disponibles|redevient disponible|revient en stock|est en stock|est de retour en stock|est en promo|sera en promo|en promo|en solde|en soldes|baisse|baissera|baissent|chute|chutera|passe sous|passera sous|passe en dessous|passe au-dessus|passe au dessus|tombe sous|descend sous|est annoncée?|sera annoncée?|est publiée?|sera publiée?|sera lancée?|paraît|parait|paraîtra|paraitra|sera en ligne|est en vente|sera en vente)",
      // "Dis-moi quand le nouvel iPhone sortira", not "dis-moi quand Napoléon est mort" or "dis-moi si l'avoine baisse le cholestérol".
      "(?:dis|dit|dites|me dire)(?:(?:-|\\s)moi)?,? (?:si|s['’]) [^.?!\\n]{0,60}?(?:passe sous|passera sous|passe en dessous|passe au-dessus|passe au dessus|repasse sous|tombe sous|descend sous|revient en stock|est de retour en stock|redevient disponible|sera dispo|sera disponible|sortira|sera en promo|est en promo|sera en vente)",
      "(?:dis|dit|dites)(?:-|\\s)moi,? (?:quand|lorsque|lorsqu['’]) [^.?!\\n]{0,60}?(?:sort|sortira|sortent|sortiront|sera dispo|sera disponible|est dispo|est disponible|sont dispo|sont disponibles|seront disponibles|redevient disponible|revient en stock|est en stock|est de retour en stock|est en promo|sera en promo|en promo|en solde|en soldes|baisse|baissera|baissent|chute|chutera|passe sous|passera sous|passe en dessous|passe au-dessus|passe au dessus|tombe sous|descend sous|est annoncée?|sera annoncée?|est publiée?|sera publiée?|sera lancée?|paraît|parait|paraîtra|paraitra|sera en ligne|est en vente|sera en vente)",
      "(?:(?:fais|fait|faites)(?:-|\\s)moi (?:savoir|signe)|(?:préviens|previens|prévenez|prevenez|avertis|avertissez|alerte|alertez|notifie|notifiez|informe|informez)(?:-|\\s)moi),? (?:quand|lorsque|lorsqu['’]|si|s['’]) [^.?!\\n]{0,60}?(?:sort|sortira|sortent|sortiront|sera dispo|sera disponible|est dispo|est disponible|sont dispo|sont disponibles|seront disponibles|redevient disponible|revient en stock|est en stock|est de retour en stock|est en promo|sera en promo|en promo|en solde|en soldes|baisse|baissera|baissent|chute|chutera|passe sous|passera sous|passe en dessous|passe au-dessus|passe au dessus|tombe sous|descend sous|est annoncée?|sera annoncée?|est publiée?|sera publiée?|sera lancée?|paraît|parait|paraîtra|paraitra|sera en ligne|est en vente|sera en vente)",
      "(?:me dire|me faire savoir),? (?:quand|lorsque|lorsqu['’]) [^.?!\\n]{0,60}?(?:sort|sortira|sortent|sortiront|sera dispo|sera disponible|est dispo|est disponible|sont dispo|sont disponibles|seront disponibles|redevient disponible|revient en stock|est en stock|est de retour en stock|est en promo|sera en promo|en promo|en solde|en soldes|baisse|baissera|baissent|chute|chutera|passe sous|passera sous|passe en dessous|passe au-dessus|passe au dessus|tombe sous|descend sous|est annoncée?|sera annoncée?|est publiée?|sera publiée?|sera lancée?|paraît|parait|paraîtra|paraitra|sera en ligne|est en vente|sera en vente)",
      "(?:me faire savoir|me prévenir|me prevenir|m['’]avertir|m['’]alerter|me notifier),? (?:si|s['’]) [^.?!\\n]{0,60}?(?:sort|sortira|sortent|sortiront|sera dispo|sera disponible|est dispo|est disponible|sont dispo|sont disponibles|seront disponibles|redevient disponible|revient en stock|est en stock|est de retour en stock|est en promo|sera en promo|en promo|en solde|en soldes|baisse|baissera|baissent|chute|chutera|passe sous|passera sous|passe en dessous|passe au-dessus|passe au dessus|tombe sous|descend sous|est annoncée?|sera annoncée?|est publiée?|sera publiée?|sera lancée?|paraît|parait|paraîtra|paraitra|sera en ligne|est en vente|sera en vente)",
      // "Quand le nouvel iPhone sortira, préviens-moi", not "si le dollar baisse, dis-moi ce qui arrive à l'or".
      "(?:quand|lorsque|lorsqu['’]|dès que|des que|si|s['’]) [^,.?!\\n]{1,60}?(?:sort|sortira|sortent|sortiront|sera dispo|sera disponible|est dispo|est disponible|sont dispo|sont disponibles|seront disponibles|redevient disponible|revient en stock|est en stock|est de retour en stock|est en promo|sera en promo|en promo|en solde|en soldes|baisse|baissera|baissent|chute|chutera|passe sous|passera sous|passe en dessous|passe au-dessus|passe au dessus|tombe sous|descend sous|est annoncée?|sera annoncée?|est publiée?|sera publiée?|sera lancée?|paraît|parait|paraîtra|paraitra|sera en ligne|est en vente|sera en vente)[^,.?!\\n]{0,30}?,\\s{0,2}(?:préviens|previens|prévenez|avertis|avertissez|alerte|alertez|notifie|notifiez|dis|dit|dites|fais|écris|ecris|envoie|envoi)(?:-|\\s)moi(?![\\s,]{1,3}(?:(?:ce que|ce qui|comment|pourquoi|quel|quelle|quels|quelles|combien|si|qui|où|lequel|laquelle)(?![\\p{L}])|ce qu['’]|s['’]|à quel|a quel))",
      "automatiquement (?:chaque|tous les|toutes les|tout les|m['’]envoyer|me rappeler|me prévenir|me prevenir|vérifier|verifier|envoyer)",
      "automatiser? (?:ça|ca|cela|ceci|cette tâche|cette tache|ce truc|tout ça|tout ca)(?: pour moi)?(?:,? (?:stp|svp|s['’]il te pla[iî]t|s['’]il vous pla[iî]t))?$",
      // "Envoie-moi un résumé hebdomadaire", not "fais-moi une liste de courses hebdomadaire" (a list made once).
      "(?:envoie|envoi|envoies|envoyez|donne|donnes|donnez|file|transmets|transmettez)(?:-|\\s)moi (?:un|une|des) (?:petit |petite |petits |petites |court |courte |bref |brève |breve )?(?:résumé|resume|récap|recap|récapitulatif|recapitulatif|point|bulletin|briefing|brief|digest|rapport|compte rendu|compte-rendu|rappel|newsletter|revue de presse|synthèse|synthese|sélection|selection|alerte|mise à jour|mise a jour|update|actu|news|nouvelle|info|horoscope|citation|blague|conseil|astuce|notification|notif|message)s? (?:(?!de\\s|d['’]|du\\s|des\\s)\\p{L}{1,12} )?(?:quotidien(?:ne)?s?|hebdomadaires?|hebdos?|mensuel(?:le)?s?|journali(?:er|ère|ere)s?)",
      "(?:m['’]envoyer|me donner|me faire parvenir|(?:je veux|je voudrais|j['’]aimerais|je souhaite|je souhaiterais) recevoir) (?:un|une|des) (?:petit |petite |court |courte )?(?:résumé|resume|récap|recap|récapitulatif|point|bulletin|briefing|brief|digest|rapport|compte rendu|rappel|newsletter|revue de presse|synthèse|synthese|sélection|selection|alerte|mise à jour|mise a jour|update|actu|news|nouvelle|info|horoscope|citation|blague|conseil|astuce|notification|notif|message)s? (?:(?!de\\s|d['’]|du\\s|des\\s)\\p{L}{1,12} )?(?:quotidien(?:ne)?s?|hebdomadaires?|hebdos?|mensuel(?:le)?s?|journali(?:er|ère|ere)s?)",
    ]),
    // A question ("Combien d'eau dois-je boire chaque jour ?", "Est-ce bon de courir tous les jours ?") or how often.
    not: /^(?:(?:salut|bonjour|bonsoir|coucou|hello|hey|dis|dites|stp|svp)[,! ]{1,3})?(?:(?:combien|pourquoi|comment|quel|quelle|quels|quelles|lequel|laquelle|lesquels|quand|où|qui|que|quoi|est-il(?! possible)|est-elle|sont-ils|sont-elles|dois-je|devrais-je|faut-il|peut-on|puis-je|y a-t-il|vaut-il|c['’]est quoi|à quoi|a quoi|à quelle|a quelle)(?![\p{L}])|qu['’]|est[- ]ce qu(?:e\s|['’])(?!\s{0,2}(?:tu|vous)(?![\p{L}])|t['’]))|à quelle fréquence|a quelle frequence|combien de fois|tous les combien|bienfaits|bénéfices|benefices|avantages|inconvénients|inconvenients|effets? (?:de|du|des|sur)(?![\p{L}])|(?:est-ce|c['’]est|est-il|serait-il|il est|s['’]il est|ce n['’]est pas) (?:trop |vraiment |très |tres |si )?(?:bon|bien|mauvais|normal|anormal|grave|dangereux|sain|nocif|conseillé|conseille|recommandé|recommande|utile|bizarre|étrange|etrange|exagéré|exagere|abusé|abuse|égoïste|egoiste|raisonnable|demander)(?![\p{L}])|(?:bon|mauvais) pour la santé|dois-je|devrais-je|faut-il|(?:[,;]|\s[-–—])\s{0,3}(?:qui (?:a dit|l['’]a dit|disait)(?![\p{L}])|c['’]est de qui|de qui est (?:cette|la) (?:citation|phrase)|d['’]où vient (?:cette|la) (?:citation|phrase|expression)|comment (?:faire|je fais|on fait|dois-je|puis-je|je peux|je dois|on peut)(?![\p{L}])|quel(?:le)?s? (?:\p{L}{1,20} )?(?:choisir|prendre|acheter)(?![\p{L}]))|quel(?:le)?s? \p{L}{1,20} (?:me )?(?:conseilles|conseillez|recommandes|recommandez)|(?:que|quoi) (?:me )?(?:conseilles|conseillez|recommandes|recommandez)|(?:conseilles|conseillez|recommandes|recommandez)[- ](?:tu|vous) quoi|qu['’]en penses-tu|tu en penses quoi|vous en pensez quoi/iu,
    // Between the request and the schedule, an embedded question or someone else's habit: "dis-moi combien d'eau
    // boire chaque jour", "donne-moi une routine que je peux faire chaque matin", "des exercices à faire chaque jour",
    // "mon habitude de lire chaque matin", "un mail disant que la réunion a lieu chaque lundi".
    between:
      /(?<![\p{L}'’])(?:combien|pourquoi|comment|quand|lorsque|quel|quelle|quels|quelles|lequel|laquelle|quoi|où|qui|ce que|ce qu['’]|ce qui|qu['’]est-ce|à quelle|a quelle|si (?:je|j['’]|on|c['’]est|ça|ca|il faut)|s['’]il faut)(?![\p{L}])|(?<![\p{L}'’])(?:que|qu['’]|qui)\s{0,2}(?:je|j['’]|on|nous|il|elle|ils|elles)(?![\p{L}])|(?<![\p{L}'’])(?:je|j['’]|on|nous|il|elle|ils|elles)\s{0,2}(?!(?:veux|voudrais|aimerais|aimerai|souhaite|souhaiterais|ai besoin)(?![\p{L}]))\p{L}|(?<![\p{L}'’])(?:pour|à|a)\s(?:l['’])?(?!partir|venir)\p{L}{2,20}(?:er|ir|re|oir)(?![\p{L}])|(?<![\p{L}'’])(?:(?:car|parce que|puisque|vu que|bien que|alors que|même si|meme si|depuis que|ce sont)(?![\p{L}])|parce qu['’]|puisqu['’]|vu qu['’]|bien qu['’]|alors qu['’]|depuis qu['’]|(?:c['’]est|c['’]était|c['’]etait|ce n['’]est)(?![\p{L}]))|(?<![\p{L}])(?:importance|intérêt|interet|fait|nécessité|necessite|habitude|routine|rituel|objectif|but|résolution|resolution|projet|envie|plaisir) (?:de|d['’])\s?\p{L}{2,20}(?:er|ir|re|oir)(?![\p{L}])|(?<![\p{L}])(?:disant|annonçant|annoncant|expliquant|précisant|precisant|indiquant|signalant|leur dire|lui dire) (?:que|qu['’])/iu,
    // Before a request whose words could be something else ("vérifie" in "il vérifie", "faire du sport chaque
    // jour, c'est bien ?"): the start of the sentence or part, "stp", "tu peux", a schedule.
    lead: /(?:^|[,;(]\s{0,3}|(?<![\p{L}'’])(?:stp|svp|s['’]il te pla[iî]t|s['’]il vous pla[iî]t|puis|ensuite|alors|donc|ok|okay|d['’]accord|salut|bonjour|bonsoir|coucou|hello|hey|flash|oui|juste|maintenant|désormais|desormais|dorénavant|dorenavant|à partir de maintenant|a partir de maintenant|à partir de demain|a partir de demain|dès demain|des demain|dès maintenant|est-ce que|est ce que|(?:peux-tu|peux tu|pourrais-tu|pourrais tu|veux-tu|tu peux|tu pourrais|tu veux bien|pouvez-vous|pouvez vous|pourriez-vous|pourriez vous|voulez-vous|vous pouvez|vous pourriez|merci de|n['’]oublie pas de|oublie pas de|pense à|pense a)(?:\s{1,3}(?:bien|stp|svp|aussi|juste|vraiment))?(?:\s{1,3}(?:me|nous)|\s{0,3}m['’])?)\s{0,3}|(?<![\p{L}])(?:chaque|tous|tout|tou|ts|toutes|toute|ttes|les) (?:les )?(?:jours?|matins?|soirs?|soirées?|nuits?|midis?|semaines?|mois|ans?|années?|heures?|week-ends?|weekends?|lundis?|mardis?|mercredis?|jeudis?|vendredis?|samedis?|dimanches?|\d{1,3} ?(?:minutes|min|heures|h|jours|semaines))(?:\s(?:matin|soir|midi))?(?:\s{1,3}(?:à|a|vers|dès|des)\s{1,3}(?:\d{1,2}(?:\s?h(?:\s?\d{2})?|[:.]\d{2})?|(?:une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze)\sheures?|midi|minuit))?\s{1,3}|(?<![\p{L}])(?:quotidiennement|hebdomadairement|mensuellement|régulièrement|regulierement)\s{1,3})$/iu,
  },
  de: {
    recur: B([
      // "jeden Tag", not "für jeden Tag" or "jeden Tag der Woche" (a plan for each day). The time goes with it, so
      // "Jeden Abend um 20 Uhr: schick mir …" is a schedule on its own.
      "(?<!für |fuer |an )jeden (?:einzelnen )?(?:Tag|Morgen|Vormittag|Mittag|Nachmittag|Abend|Werktag|Wochentag|Arbeitstag|Monat|Monatsersten|Ersten|zweiten (?:Tag|Monat)|(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonnabend|Sonntag)(?:morgen|vormittag|mittag|nachmittag|abend)?)(?! (?:der|des|meines|meiner|unserer|unseres|deiner|deines|eurer|eures|ihrer|ihres|seiner|seines|dieser|dieses)(?![\\p{L}])| im (?:Monat|Jahr|Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)(?![\\p{L}])| in (?:der Woche|diesem Jahr|20\\d\\d)| 20\\d\\d)(?: (?:um|gegen|ab) (?:\\d{1,2}(?:[:.]\\d{2})?|halb \\d{1,2}|(?:viertel )?(?:vor|nach) \\d{1,2}|(?:halb |viertel (?:vor|nach) )?(?:eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf)(?![\\p{L}]))(?: ?Uhr)?)?",
      "(?<!für |fuer )jede (?:Woche|Stunde|halbe Stunde|Viertelstunde|Nacht|Minute|zweite (?:Woche|Stunde))(?! der| des)|(?<!für |fuer )jedes (?:Jahr|Wochenende|Quartal|Halbjahr)",
      "alle (?:\\d{1,3}|zwei|drei|vier|fünf|fuenf|sechs|acht|zehn|zwölf|zwoelf|vierzehn|paar) (?:Minuten|Stunden|Tage|Wochen|Monate)|alle (?:halbe )?Stunde",
      "(?:einmal|zweimal|dreimal|\\d{1,2} ?(?:mal|x)) (?:am Tag|pro Tag|täglich|taeglich|die Woche|pro Woche|in der Woche|im Monat|pro Monat|pro Stunde|die Stunde|in der Stunde|im Jahr)",
      // Uninflected, so said of the request: "täglich", never "die tägliche Routine" or "mit täglich frischem Brot".
      "(?<!mit |für |fuer |von |bei |über |ueber |zum |zur |ein |eine |einen |einem |einer |als )(?:täglich|taeglich|tagtäglich|wöchentlich|woechentlich|zweiwöchentlich|monatlich|stündlich|stuendlich|halbstündlich|vierteljährlich|jährlich|jaehrlich|werktags|wochentags|regelmäßig|regelmaessig|regelmässig)(?! (?:geöffnet|geoeffnet|offen|wechselnde[nmrs]?|zubereitete[nmrs]?|gelieferte[nmrs]?|aktualisierte[nmrs]?)(?![\\p{L}]))(?: (?:um|gegen|ab) (?:\\d{1,2}(?:[:.]\\d{2})?|halb \\d{1,2}|(?:viertel )?(?:vor|nach) \\d{1,2}|(?:halb |viertel (?:vor|nach) )?(?:eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf)(?![\\p{L}]))(?: ?Uhr)?)?",
      "(?<!für |fuer |bis |['’]s |['’]s|^s |\\ss )(?:morgens|abends|nachts|vormittags|nachmittags|montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonnabends|sonntags|wochenends|(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)(?:morgens|abends|vormittags|nachmittags|mittags))(?: (?:um|gegen|ab) (?:\\d{1,2}(?:[:.]\\d{2})?|halb \\d{1,2}|(?:viertel )?(?:vor|nach) \\d{1,2}|(?:halb |viertel (?:vor|nach) )?(?:eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf)(?![\\p{L}]))(?: ?Uhr)?)?",
    ]),
    act: B([
      // Commands with "mir" / "mich": "schick mir", "erinnere mich", "gib mir Bescheid".
      "(?:schick|schicke|send|sende|gib|schreib|schreibe|sag|sage|mach|mache|such|suche|zeig|zeige|nenn|nenne|stell|stelle|fass|fasse|erstell|erstelle|liefer|liefere|empfiehl|bring|bringe|übersetz|übersetze|uebersetze|hol|hole|besorg|besorge) (?:mir|uns)",
      "(?:erinner|erinnere|benachrichtige|benachrichtig|informier|informiere|halt|halte|update|ping|warne|warn|alarmier|alarmiere) (?:mich|uns)",
      "(?:sag|gib|sagt|gebt) (?:mir |uns )?Bescheid",
      "lass (?:mich|uns) (?:[^.?!,;\\n]{0,30}? )?wissen",
      // "Ist es möglich, mir jeden Morgen … zu schicken?", not "ist es möglich, jeden Tag zu trainieren?".
      "(?:ist|wäre|waere) es (?:möglich|moeglich),? (?:mir|uns|mich)(?: [^.?!;\\n]{0,80}?)? (?:zu (?:schicken|senden|geben|sagen|schreiben|zeigen|nennen|empfehlen|liefern|erzählen|erzaehlen|erinnern|benachrichtigen|informieren|melden)|zuzuschicken|zuzusenden|zusammenzufassen|mitzuteilen|vorzuschlagen|vorzulesen)",
      // Polite commands where a command stands: "Schicken Sie mir …", not "jeden Tag schicken sie mir Werbung".
      "(?<=^|[,;]\\s{0,3}|bitte\\s{1,3})(?:schicken|senden|geben|schreiben|sagen|machen|suchen|zeigen|nennen|erstellen|liefern|empfehlen|melden|übersetzen|recherchieren|erinnern|benachrichtigen|informieren|prüfen|pruefen|überprüfen|checken|kontrollieren|überwachen|beobachten|verfolgen|vergleichen|fassen|halten) Sie",
      // Commands on their own, not before their subject: "prüf jeden Tag …", not "jeden Tag prüfe ich …".
      "(?:prüf|prüfe|pruef|pruefe|überprüf|überprüfe|ueberpruefe|check|checke|kontrollier|kontrolliere|überwach|überwache|ueberwache|beobachte|verfolg|verfolge|schau nach|schau mal|schau dir|guck nach|guck mal|sieh nach|recherchier|recherchiere|such|suche|find|finde|vergleich|vergleiche|schreib|schreibe|verfass|verfasse|erstell|erstelle|mach|mache|übersetz|übersetze|schick|schicke|send|sende|poste|analysier|analysiere|sammel|sammle|wiederhol|wiederhole|gib|nenn|nenne|fass|fasse)(?!\\s{1,3}(?:ich|wir|er|man|ihr|du|ik|we|je|jij|hij)(?![\\p{L}])|\\s{0,2},)",
      // "Kannst du mir jeden Morgen die Nachrichten schicken?": the request, its verb at the end.
      "(?:(?:kannst|könntest|koenntest|würdest|wuerdest|magst|willst) du|kannste)[^.?!;,\\n]{0,80}? (?:schicken|zuschicken|senden|zusenden|geben|sagen|mitteilen|schreiben|erzählen|erzaehlen|erinnern|benachrichtigen|informieren|melden|prüfen|pruefen|überprüfen|ueberpruefen|checken|kontrollieren|überwachen|ueberwachen|beobachten|verfolgen|nachschauen|nachsehen|nachgucken|zusammenfassen|recherchieren|suchen|raussuchen|heraussuchen|finden|vergleichen|auflisten|erstellen|verfassen|machen|übersetzen|uebersetzen|posten|vorschlagen|empfehlen|liefern|aktualisieren|zusammenstellen|sammeln|analysieren|durchsuchen|updaten|wiederholen|generieren|zeigen|nennen|tun|vorlesen|beibringen|erklären|erklaeren|ausdenken|überlegen|ueberlegen)",
      "(?<=^|[,;]\\s{0,3}|bitte\\s{1,3})(?:können|koennen|könnten|koennten|würden|wuerden) Sie[^.?!;,\\n]{0,80}? (?:schicken|zuschicken|senden|zusenden|geben|sagen|mitteilen|schreiben|erinnern|benachrichtigen|informieren|melden|prüfen|überprüfen|checken|kontrollieren|überwachen|beobachten|verfolgen|nachschauen|zusammenfassen|recherchieren|suchen|heraussuchen|finden|vergleichen|auflisten|erstellen|verfassen|machen|übersetzen|posten|vorschlagen|empfehlen|liefern|aktualisieren|zusammenstellen|sammeln|analysieren|zeigen|nennen|tun|beibringen|erklären|erklaeren|ausdenken)",
      "ich (?:möchte|moechte|will|wünsche mir|wuensche mir|hätte gern|hätte gerne|haette gern|haette gerne|würde mich freuen|wuerde mich freuen),? (?:dass|wenn) (?:du|Sie)",
      "ich (?:möchte|moechte|will|würde gern|würde gerne|wuerde gern|wuerde gerne|hätte gern|hätte gerne)[^.?!;,\\n]{0,60}? (?:bekommen|erhalten|kriegen)",
      "ich (?:möchte|moechte|will|hätte gern|hätte gerne|haette gern|haette gerne|brauche|wünsche mir|wuensche mir)[^.?!;,\\n]{0,40}? (?:eine|einen|ein|ne) (?:(?:kurze[nms]?|paar|neue[nmrs]?|kleine[nmrs]?|aktuelle[nmrs]?) )?\\p{L}{0,14}(?:zusammenfassung|übersicht|uebersicht|überblick|ueberblick|update|bericht|briefing|newsletter|erinnerung|nachricht|meldung|info|tipp|zitat|witz|horoskop|liste|tipps|empfehlung|empfehlungen|vorschläge|vorschlaege|ideen|idee|rezept|rezepte|gedicht|news|nachrichten|übung|uebung|frage|quiz|vokabel|wort)(?![^.?!;,\\n]{0,40}? (?:kochen|machen|schreiben|lernen|lesen|beantworten|essen|trinken|erstellen|führen|fuehren|abarbeiten|schaffen|üben|ueben|ausprobieren|probieren|backen|zubereiten|lösen|loesen|aufsagen|singen|malen|zeichnen|spielen)(?![\\p{L}]))",
      // "Bitte jeden Morgen die Schlagzeilen schicken."
      "(?<=^|[,;]\\s{0,3})bitte[^.?!;,\\n]{0,60}? (?:schicken|zuschicken|senden|zusenden|zusammenfassen|prüfen|pruefen|checken|recherchieren|erinnern)",
    ]),
    strong: B([
      // Reminders aimed at Flash with a task or time: "erinnere mich morgen an den Termin", "erinnere mich daran, … zu
      // …", not "ich erinnere mich an …" or "erinnere mich an die Handlung von Hamlet".
      "(?<!ich )(?:erinnere|erinner|erinnern Sie) (?:mich|uns) (?:bitte )?(?:daran(?!,? (?:wie|was|wer|wo|wann|warum|welche))|dran|morgen|übermorgen|uebermorgen|heute|heut|später|spaeter|nachher|gleich|in \\d{1,3}|in (?:einer|einem|zwei|drei|ein paar)|um \\d{1,2}|gegen \\d{1,2}|am (?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Wochenende|\\d{1,2})|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|jeden|jede|jedes|täglich|taeglich|wöchentlich|woechentlich|monatlich|nächste[nrs]?|naechste[nrs]?|diese[nrs]? (?:Woche|Monat|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)|vor (?:dem|der|meinem|meiner)|nach (?:dem|der|meinem|meiner)|zweimal|einmal|alle \\d{1,3}|ab morgen|ab heute|immer)",
      "(?<!ich )(?:erinnere|erinner|erinnern Sie) (?:mich|uns) (?:bitte )?an [^.?!\\n]{1,60}?(?:morgen|übermorgen|uebermorgen|heute Abend|heute Nachmittag|heute Mittag|später|spaeter|nachher|um \\d{1,2}|gegen \\d{1,2}|am (?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)|nächste Woche|naechste Woche|jeden|jede|täglich|taeglich|in \\d{1,3} (?:Minuten|Stunden|Tagen)|in einer Stunde)",
      "(?:(?:kannst|könntest|koenntest|würdest|wuerdest|magst) du|kannste|(?:können|könnten|koennten|würden|wuerden) Sie) (?:mich|uns) (?:[^.?!;\\n]{0,40}? )?(?:daran|dran|morgen|übermorgen|uebermorgen|heute|später|spaeter|nachher|gleich|in \\d{1,3}|in (?:einer|einem)|um \\d{1,2}|am (?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|\\d{1,2})|jeden|jede|täglich|taeglich|nächste[nrs]?|naechste[nrs]?)(?: [^.?!;\\n]{0,40}?)? erinnern(?!,? (?:wie|was|wer|wo|wann|warum|welche))",
      // Setting one up: "erstell mir eine Erinnerung", not "wie erstelle ich eine Erinnerung" (see lead).
      "(?:erstell|erstelle|stell|stelle|setz|setze|mach|mache|leg|lege|richte|richt|plane|plan)(?: (?:mir|uns))?(?: bitte)? (?:eine|einen|ne) (?:Erinnerung|Reminder|Wecker|Automatisierung|Automation)",
      "(?:schick|schicke|send|sende|gib)(?: (?:mir|uns))?(?: (?:morgen|heute|übermorgen|bitte|um \\d{1,2}(?:[:.]\\d{2})?(?: Uhr)?)){0,3} (?:eine|ne) Erinnerung",
      // "Benachrichtige mich, wenn …", "sag mir Bescheid, sobald …": the moment something happens.
      "(?:benachrichtige|benachrichtig|benachrichtigen Sie|warne|warn|warnen Sie|alarmiere|alarmier|ping|pinge) (?:mich|uns),? (?:wenn|sobald|sowie|falls)(?! (?:du|ihr)(?![\\p{L}]))",
      "(?:sag|sage|gib|sagt|gebt|sagen Sie|geben Sie|informiere|informier|informieren Sie|schreib|schreibe|schreiben Sie)(?: (?:mir|mich|uns))?(?: bitte)?(?: Bescheid)?,? (?:sobald|sowie|sofort wenn|gleich wenn)(?! (?:du|ihr)(?![\\p{L}]))",
      "(?:melde dich|meld dich|melden Sie sich|lass (?:es )?(?:mich|uns) (?:es )?wissen),? (?:sobald|sowie)(?! (?:du|ihr)(?![\\p{L}]))",
      "(?:(?:kannst|könntest|koenntest|würdest|wuerdest) du|kannste|(?:können|könnten|koennten|würden|wuerden) Sie)(?:[^.?!;\\n]{1,60}? und)? (?:mich|mir|uns) (?:bitte )?(?:benachrichtigen|informieren|warnen),? (?:wenn|sobald|falls|sowie)(?! (?:du|ihr)(?![\\p{L}]))",
      // "… und mir Bescheid geben, wenn er unter 50k fällt", not "kannst du mir Bescheid sagen, wenn du fertig bist".
      "(?:(?:kannst|könntest|koenntest|würdest|wuerdest) du|kannste|(?:können|könnten|koennten|würden|wuerden) Sie)(?:[^.?!;\\n]{1,60}? und)? (?:mir|uns) (?:bitte )?Bescheid (?:geben|sagen),? (?:sobald|sowie|(?:wenn|falls) [^.?!\\n]{0,60}?(?:erscheint|erscheinen|rauskommt|rauskommen|herauskommt|raus ist|veröffentlicht wird|veroeffentlicht wird|angekündigt wird|angekuendigt wird|vorgestellt wird|(?:verfügbar|verfuegbar|erhältlich|erhaeltlich|lieferbar|auf Lager|im Angebot|reduziert|wieder da) (?:ist|sind|wird|werden)|wieder verfügbar|wieder lieferbar|wieder auf Lager|billiger wird|günstiger wird|guenstiger wird|fällt|faellt|sinkt|sinken|steigt|startet|live geht|online geht|in den Verkauf geht))(?! (?:du|ihr)(?![\\p{L}]))",
      // "Sag mir Bescheid, wenn das neue iPhone erscheint", not "sag mir, wann der Krieg endete" or "… wenn ich falsch liege".
      "(?:sag|sage|gib|sagt|gebt|sagen Sie|geben Sie|informiere|informier|informieren Sie|schreib|schreibe|melde dich|meld dich|lass (?:es )?(?:mich|uns) (?:es )?wissen)(?: (?:mir|mich|uns))?(?: bitte)?(?: Bescheid)?,? (?:wenn|falls) [^.?!\\n]{0,60}?(?:erscheint|erscheinen|rauskommt|rauskommen|herauskommt|raus ist|veröffentlicht wird|veroeffentlicht wird|angekündigt wird|angekuendigt wird|vorgestellt wird|(?:verfügbar|verfuegbar|erhältlich|erhaeltlich|lieferbar|auf Lager|im Angebot|reduziert|wieder da) (?:ist|sind|wird|werden)|wieder verfügbar|wieder lieferbar|wieder auf Lager|billiger wird|günstiger wird|guenstiger wird|fällt|faellt|sinkt|sinken|steigt|startet|live geht|online geht|in den Verkauf geht)",
      // "Wenn das neue iPhone vorgestellt wird, sag mir Bescheid", not "wenn der Ölpreis steigt, sag mir, welche Aktien …".
      "(?:sobald|wenn|falls) [^,.?!\\n]{1,60}?(?:erscheint|erscheinen|rauskommt|rauskommen|herauskommt|raus ist|veröffentlicht wird|veroeffentlicht wird|angekündigt wird|angekuendigt wird|vorgestellt wird|(?:verfügbar|verfuegbar|erhältlich|erhaeltlich|lieferbar|auf Lager|im Angebot|reduziert|wieder da) (?:ist|sind|wird|werden)|wieder verfügbar|wieder lieferbar|wieder auf Lager|billiger wird|günstiger wird|guenstiger wird|fällt|faellt|sinkt|sinken|steigt|startet|live geht|online geht|in den Verkauf geht|vorgestellt werden|angekündigt werden|veröffentlicht werden)[^,.?!\\n]{0,20}?,\\s{0,2}(?:sag|sage|gib|schreib|schreibe|benachrichtige|informiere|ping|melde)(?: (?:mir|mich|dich))(?![\\s,]{1,3}(?:was|wie|welche[rsmn]?|warum|wieso|weshalb|ob|wer|wo|wann)(?![\\p{L}]))",
      "automatisch (?:jeden|jede|jedes|täglich|taeglich|wöchentlich|woechentlich|monatlich|stündlich|stuendlich|alle \\d{1,3}|schicken|senden|prüfen|erinnern|benachrichtigen)",
      "(?:automatisiere|automatisier|automatisieren Sie) (?:das|es|dies|diese Aufgabe)(?: für mich)?(?: bitte)?$",
      "(?:(?:kannst|könntest|koenntest|würdest|wuerdest) du|kannste|(?:können|könnten|koennten|würden|wuerden) Sie) (?:das|es|dies) (?:bitte )?(?:für mich )?automatisieren$",
      // "Schick mir eine tägliche Zusammenfassung", "gib mir einen Wochenbericht", not "einen täglichen Trainingsplan".
      "(?:schick|schicke|send|sende|gib|schicken Sie|senden Sie|geben Sie) (?:mir|uns) (?:bitte )?(?:eine|einen|ein|ne) (?:kurze[nms]? )?(?:(?:täglich|taeglich|wöchentlich|woechentlich|monatlich|stündlich|stuendlich|morgendlich)e[nms]? \\p{L}{0,20}|(?:Tages|Wochen|Monats|Morgen)\\p{L}{0,12})(?:zusammenfassung|übersicht|uebersicht|überblick|ueberblick|update|bericht|report|briefing|newsletter|nachrichten|news|erinnerung|info|infos|meldung|digest|tipp|tipps|zitat|witz|horoskop|rückblick|rueckblick|mail|auswertung|nachricht)",
    ]),
    // A question ("Wie viel Wasser sollte ich täglich trinken?", "Ist es schlecht, jeden Tag …") or how often.
    not: /^(?:(?:hallo|hi|hey|moin|servus|sag mal)[,! ]{1,3})?(?:wie|warum|wieso|weshalb|weswegen|was|wann|wo|woher|wohin|welche[rsmn]?|wer|wem|wen|wieviel|ist(?! es (?:möglich|moeglich))|sind|war|waren|soll|sollte|sollten|darf|muss|müssen|gibt es|hat|habe|bin|kann (?:ich|man|es)|könnte (?:ich|man)|lohnt|bringt|stimmt|macht es)(?![\p{L}])|wie oft|wie häufig|wie haeufig|wievielmal|vorteile|nachteile|ist es (?:gut|schlecht|okay|ok|normal|gesund|ungesund|schlimm|schädlich|sinnvoll|gefährlich)|(?:ist|sind|wäre|waere) (?:das|es) (?:zu viel|zuviel|übertrieben|uebertrieben|komisch|seltsam|merkwürdig|merkwuerdig|verrückt|verrueckt|egoistisch|normal|gesund|ungesund|schlimm|schädlich|gefährlich)(?![\p{L}])|soll(?:te)? (?:ich|man)(?![\p{L}])|muss ich|darf ich|wirkung von|auswirkungen|hilft (?:das|es)(?![\p{L}])|bringt (?:das|es)(?![\p{L}])|reicht (?:das|es)(?![\p{L}])|lohnt sich das|macht das sinn|was empfiehlst du|welche[rsmn]? empfiehlst du|was (?:würdest|wuerdest) du empfehlen|was (?:rätst|raetst) du|welche[rsmn]? \p{L}{1,25} (?:ist|wäre|waere) (?:gut|besser|am besten|empfehlenswert|zu empfehlen|günstig|guenstig)|(?:[,;]|\s[-–—])\s{0,3}(?:von wem (?:ist|stammt)|wer hat das gesagt|wer sagte das)/iu,
    // Between the request and the schedule, an embedded question or someone's habit: "sag mir, wie viel Wasser ich
    // jeden Tag …", "gib mir eine Routine, die ich jeden Morgen …", "gib mir Tipps um morgens fit zu sein",
    // "meine Gewohnheit, jeden Morgen zu lesen", "das Meeting findet jetzt jeden Montag statt".
    between:
      /(?<![\p{L}])(?:wie|warum|wieso|weshalb|wann|wo|welche[rsmn]?|wieviel|ob|ich|wir|man|er|leute|menschen|kinder|was (?:ich|man|wir|er|sie|es|der|die|das|soll|kann|muss|ist|sind)|dass (?:ich|man|wir))(?![\p{L}])|(?<![\p{L}])um\s(?!\d|halb|viertel)|(?<![\p{L}])(?:der|die|das|dem|den|denen|deren|dessen|welche[rsmn]?|wer|wo)\s{0,2}$|(?<![\p{L}])(?:ist|sind|bin|bist|war|waren|hab|habe|hat|haben|weil|denn|obwohl|dass|daß|seit|seitdem|nachdem|während|waehrend|wichtigkeit|wie wichtig|bedeutung|gewohnheit|gewohnheiten|angewohnheit|routine|ritual|vorsatz|findet|stattfindet|wird|werden|kommt|kommen|geht|gehen|läuft|laeuft)(?![\p{L}])/iu,
    // Before a request whose words could be something else ("such" in "ich such", "mach" in "ich mach jeden Tag
    // Sport"): the start of the sentence or part, "bitte", "kannst du", a schedule.
    lead: /(?:^|[,;(]\s{0,3}|(?<![\p{L}])(?:bitte|dann|danach|anschließend|anschliessend|auch|außerdem|ausserdem|also|jetzt|nun|ok|okay|hey|hi|hallo|moin|servus|ja|flash|einfach|noch|mal|doch|ab jetzt|ab sofort|von nun an|ab morgen|ab heute|kannst du|könntest du|koenntest du|kannste|würdest du|wuerdest du)\s{1,3}|(?<![\p{L}])(?:(?:jeden|jede|jedes) (?:\p{L}{1,14})|alle (?:\d{1,3}|zwei|drei|vier|paar|halbe) \p{L}{1,10}|täglich|taeglich|wöchentlich|woechentlich|monatlich|stündlich|stuendlich|morgens|abends|montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonntags|werktags|regelmäßig)(?:\s{1,3}(?:um|gegen|ab|vor|nach)\s{1,3}(?:\d{1,2}(?:[:.]\d{2})?|halb\s\d{1,2}|(?:halb\s|viertel\s(?:vor|nach)\s)?(?:eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf))(?:\s?Uhr)?)?(?:\s{1,3}(?:morgens|abends|früh|frueh))?\s{1,3})$/iu,
  },
  it: {
    recur: B([
      // "un menù per ogni giorno della settimana", "le spese di ogni mese", "quanti giorni ha ogni mese": not schedules.
      "(?<!(?<![\\p{L}])(?:per|di|ha|hanno) )(?:ogni|tutti i|tutte le) (?:santo |santi )?(?:giorn[oi]|gg|mattin[aeoi]|pomeriggi(?:o)?|ser[ae]|nott[ei]|settiman[ae]|mes[ei]|ann[oi]|or[ae]|mezz'?ora|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabat[oi]|domenic(?:a|he)|weekend|fine settimana|giorni (?:feriali|lavorativi)|giorno (?:feriale|lavorativo)|\\d{1,3} (?:minuti|ore|giorni|settimane|mesi)|(?:due|tre|quattro|cinque|sei|dieci|dodici|quindici|venti|trenta) (?:ore|giorni|gg|settimane|mesi)|paio d'?(?:ore|giorni))(?: e (?:luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica))?(?! dell[ae'’]?(?![\\p{L}])| del(?![\\p{L}])| di (?:questa|questo|quest'|ogni))(?: (?:alle|verso le|entro le|dopo le|prima delle|dalle) \\d{1,2}(?:[:.]\\d{2})?| all'una| a mezzogiorno| a mezzanotte| (?:di|al|la|in) (?:mattina|mattino|pomeriggio|sera|notte)| mattina| pomeriggio| sera| presto| in punto){0,3}",
      // "Il lunedì alle 8, …" says when; "il lunedì" alone is also "on Monday".
      "(?<=^)(?:(?:il|di) (?:luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato)|(?:la|di) domenica)(?=\\s{0,3}(?:,|(?:alle|verso le) \\d|mattina|sera|pomeriggio))(?: (?:alle|verso le) \\d{1,2}(?:[:.]\\d{2})?| mattina| pomeriggio| sera){0,2}",
      "(?<=^|[,;]\\s{0,2})dal luned[iì] al (?:venerd[iì]|sabato)",
      "quotidianamente|giornalmente|settimanalmente|mensilmente|a giorni alterni",
      "(?:una|due|tre|\\d{1,2}) volt[ae] (?:al|alla|a|ogni|per) (?:giorno|settimana|mese|ora|anno)",
      // "Every morning mandami le notizie".
      EN_EVERY[0],
    ]),
    act: B([
      "(?:manda|invia|spedisci|avvisa|avverti|ricorda|scrivi|mostra|aggiorna|notifica|informa|cerca|trova|prepara|riassumi|racconta|suggerisci|consiglia|porta|passa|segnala|elenca|spiega|insegna|genera|crea|controlla|verifica|tieni)(?:mi|ci|me(?:lo|la|li|le)|ce(?:lo|la|li|le))|dammi|dacci|dammel[oaie]|dimmi|dicci|dimmel[oaie]|fammi|facci|fammel[oaie]",
      "manda|invia|controlla|verifica|monitora|tieni d'occhio|cerca|trova|riassumi|scrivi|prepara|crea|genera|compila|raccogli|confronta|analizza|elenca|pubblica|posta|suggerisci|consiglia|scegli|ripeti|aggiorna|segnala|fai (?:un|una|uno|un'|il|la|lo|l'|i|le|gli|questo|questa|ci[oò])|fallo|rifallo|ripetilo|controlli|verifichi|cerchi|prepari|scriva|mandi|invii|riassuma",
      "(?:mi|ci) (?:mandi|invii|dai|dia|dici|dica|fai|faccia|scrivi|scriva|avvisi|ricordi|prepari|trovi|cerchi|riassumi|riassuma|mostri|aggiorni|segnali|spieghi|consigli|suggerisci|racconti|mandassi|inviassi|dessi|dicessi|ricordassi|avvisassi|facessi|scrivessi|preparassi|cercassi|aggiornassi|mostrassi)",
      "(?:(?:mi|ci) )?(?:puoi|potresti|riesci a|ti va di|pu[oò]|potrebbe|potete|potreste)(?: per favore)? (?:(?:mi|ci) )?(?:mandar|inviar|spedir|dar|dir|avvisar|ricordar|scriver|far|mostrar|aggiornar|notificar|informar|cercar|trovar|preparar|riassumer|raccontar|suggerir|consigliar|segnalar|elencar|spiegar|controllar|verificar|monitorar|crear|generar|confrontar|analizzar|pubblicar|ripeter|tener)(?:e|mi|ci|me(?:lo|la|li|le)|ce(?:lo|la|li|le)|lo|la)",
      "(?:mandar|inviar|spedir|dar|dir|avvisar|ricordar|scriver|far|mostrar|aggiornar|cercar|trovar|preparar|riassumer|segnalar|tener)(?:mi|ci|me(?:lo|la|li|le)|ce(?:lo|la|li|le))",
      // "Vorrei ricevere le notizie…", not "Vorrei ricevere lezioni di chitarra ogni settimana".
      "(?:vorrei|voglio|mi piacerebbe|preferirei) che (?:tu )?(?:mi |ci )?(?:controllassi|verificassi|cercassi|scrivessi|preparassi|facessi|mandassi|inviassi|mostrassi|riassumessi|aggiornassi|monitorassi|controlli|verifichi|cerchi|prepari)",
      "(?:vorrei|voglio|mi piacerebbe|desidero|ho bisogno di) ricevere(?! (?:lezioni|corsi|terapi[ae]|trattament[oi]|visite|massaggi|sedute|aiuto|cure|assistenza)(?![\\p{L}]))",
      "(?:vorrei|voglio|mi serve|mi servono|ho bisogno di)(?: ricevere)? (?:un|una|il|la|le|i|gli|dei|delle) (?:\\p{L}{1,15} )?(?:notizie|news|riepilogo|riassunto|resoconto|aggiornamento|aggiornamenti|promemoria|avviso|barzelletta|frase|citazione|consiglio|meteo|previsioni|oroscopo|quotazione|titoli)",
    ]),
    strong: B([
      // "Ricordami di pagare la bolletta", not "Ricordami la trama di Amleto" or "Mi ricordi mio padre".
      "(?:ricorda(?:mi|ci)|ricordamelo|(?:mi|ci|me lo) ricordi|(?:(?:mi|ci) )?(?:puoi|potresti|pu[oò]|potrebbe) (?:(?:mi|ci) )?ricordar(?:mi|ci|e))(?: per favore)? (?:di \\p{L}{2,15}(?:are|ere|ire|rre)(?:mi|ti|lo|la|li|le|ci|gli|ne|si)?(?![\\p{L}])|che|domani|stasera|oggi|stamattina|stanotte|pi[uù] tardi|dopodomani|tra \\d|fra \\d|tra (?:un|una|mezz)|fra (?:un|una|mezz)|alle \\d|a mezzogiorno|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|il \\d{1,2}|ogni|tutti|tutte|la prossima|il prossimo|questo pomeriggio|questa sera|prima di|dopo)",
      "ricorda(?:mi|ci) (?:il|la|lo|l'|i|gli|le|del|della|dello|dei|delle|di) (?!che |cosa |chi |come |quando |quello |ci[oò] )[^.?!\\n]{1,50}? (?:domani|stasera|oggi|alle \\d|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|ogni|il prossimo|la prossima|dopodomani|tra \\d|fra \\d)",
      "(?:imposta|crea|metti|programma|aggiungi|fissa|attiva)(?:mi)?(?: per favore)? (?:un |una |il |la |mio |mia )?(?:nuovo |nuova )?(?:promemoria|sveglia|allarme|automazione|attivit[aà] (?:ricorrente|programmata))",
      "(?:(?:mi|ci) )?(?:puoi|potresti) (?:(?:mi|ci) )?(?:impostar|crear|metter|programmar|aggiunger|fissar|attivar)(?:e|mi|ci) (?:un |una )?(?:promemoria|sveglia|automazione)",
      // "Avvisami quando esce il nuovo iPhone / se il bitcoin scende sotto i 50.000", not "avvisami se hai bisogno"
      // or "Dimmi quando è caduto il muro di Berlino".
      "(?:avvisa(?:mi|ci)|avverti(?:mi|ci)|notifica(?:mi|ci)|segnala(?:mi|ci)|scrivi(?:mi|ci)|fa(?:mmi|cci) sapere|tieni(?:mi|ci) (?:aggiornat[oaie]|informat[oaie])|(?:mi|ci) (?:avvisi|avverti|fai sapere|scrivi|segnali)|(?:(?:mi|ci) )?(?:puoi|potresti|pu[oò]|potrebbe) (?:(?:mi|ci) )?(?:avvisar|avvertir|notificar|segnalar)(?:mi|ci|e)) (?:quando|appena|non appena|se|nel momento in cui|il giorno in cui|ogni volta che)[^.?!\\n]{0,60}? (?:esce|escono|uscir[aà]|usciranno|scende|scendono|scender[aà]|sale|salgono|salir[aà]|cala|calano|caler[aà]|crolla|cambia|cambiano|cambier[aà]|arriva a|arriver[aà] a|supera|superer[aà]|(?:[eè]|sar[aà]|torna) disponibile|(?:tornano|sono|saranno) disponibili|torna in (?:stock|vendita)|(?:[eè]|va|sar[aà]|sono|vanno|saranno|andranno) in (?:offerta|sconto|saldo|vendita)|lanciano|lanceranno|viene lanciat[oa]|verr[aà] lanciat[oa]|annunciano|annunceranno|viene annunciat[oa]|pubblicano|pubblicheranno|viene pubblicat[oa]|costa meno|si abbassa|ci sono (?:offerte|sconti|novit[aà])|gioca|giocano|giocher[aà]|giocheranno|inizia|iniziano|inizier[aà]|comincia|cominciano|apre|aprono|riapre|riaprono)",
      "(?:dimmi|dicci|(?:mi|ci) dici) (?:quando|appena|non appena)[^.?!\\n]{0,60}? (?:esce|escono|uscir[aà]|usciranno|(?:[eè]|sar[aà]|torna) disponibile|(?:saranno|torneranno) disponibili|torna in (?:stock|vendita)|(?:va|sar[aà]|saranno|andranno) in (?:offerta|sconto|saldo|vendita)|scende sotto|sale sopra|supera|superer[aà]|lanceranno|verr[aà] lanciat[oa]|annunceranno|pubblicheranno)",
      "(?:automaticamente|in automatico) (?:ogni|tutti i|tutte le|mandami|inviami|avvisami|ricordami|controlla)",
      "(?:mandami|inviami|avvisami|ricordami|fallo|controlla|controllalo|pubblica|pubblicalo|mandamel[oaie])(?: [^\\s.?!,]{1,15}){0,3}? (?:automaticamente|in automatico)",
      "automatizza(?:lo|la| questo| questa cosa| questo processo)(?: per me)?(?: per favore| pls)?$",
      "(?:(?:mi|ci) )?(?:puoi|potresti) automatizzar(?:lo|la|e questo|e questa cosa|e questo processo)(?: per me)?(?: per favore)?$",
      // "Mandami un riepilogo settimanale", not "Dammi il report mensile".
      "(?:mandami|inviami|spediscimi)(?: (?:un|una|uno|dei|delle|degli))?(?: (?!(?:il|la|lo|i|gli|le|mio|mia|miei|mie|questo|questa)\\s)\\p{L}{1,15})? (?:riepiloghi|riepilogo|riassunt[oi]|resocont[oi]|report|rapport[oi]|aggiornament[oi]|notiziari(?:o)?|bollettin[oi]|promemoria|notizie|news|newsletter|digest|briefing|e-?mail|mail|messaggi(?:o)?|consigli(?:o)?|fras[ei]|citazion[ei]|barzellett[ae]|oroscopo|previsioni|avvis[oi]) (?:giornalier[oaie]|quotidian[oaie]|settimanal[ei]|mensil[ei])(?! di (?:esempio|prova)| (?:modello|tipo))",
      "(?:dammi|fammi|preparami|vorrei(?: ricevere)?|voglio(?: ricevere)?|mi piacerebbe ricevere)(?: (?:un|una|uno|dei|delle|degli))?(?: (?!(?:il|la|lo|i|gli|le|mio|mia|miei|mie|questo|questa)\\s)\\p{L}{1,15})? (?:riepiloghi|riepilogo|riassunt[oi]|notiziari(?:o)?|bollettin[oi]|promemoria|notizie|news|newsletter|digest|briefing|consigli(?:o)?|fras[ei]|citazion[ei]|barzellett[ae]|oroscopo|previsioni) (?:giornalier[oaie]|quotidian[oaie]|settimanal[ei]|mensil[ei])(?! di (?:esempio|prova)| (?:modello|tipo))",
    ]),
    // How often, why, how much should one, benefits, is it good to, how do I, what happens if, a habit.
    not: B([
      "ogni quanto|quanto spesso|con che frequenza|con quale frequenza|quante volte",
      "perch[eé]|come mai",
      "quant[oaie] [^.?!]{0,40}?(?:devo|deve|devono|dovrei|dovrebbe|dovremmo|bisogna|serve|servono|si deve|si dovrebbe|[eè] consigliat[oa]|conviene)",
      "benefici|vantaggi|svantaggi|pro e contro|effetti|rischi|fa bene|fa male",
      "(?:[eè]|sarebbe|sar[aà]) (?:bene|male|normale|sano|salutare|consigliato|necessario|pericoloso|meglio|peggio|vero|giusto|sbagliato|grave)",
      "come (?:faccio|posso|si fa|si imposta|si crea|si dice|imposto|creo|smetto|smettere|evito|evitare|attivo|attivare|disattivo|disattivare|metto|tolgo|fermo|programmo)",
      "(?:cosa|che) (?:succede|succederebbe|accade) se",
      // "Ogni lunedì vado in palestra, dammi un programma": a habit, then a one-off ask.
      "(?:ogni|tutti i|tutte le|il|la|di) (?:\\p{L}{3,12}|fine settimana)(?: (?:alle|di|la|al) (?:\\d{1,2}(?:[:.]\\d{2})?|\\p{L}{3,9}))?(?: (?:presto|prima di \\p{L}{2,10}|dopo (?:il |la |l')?\\p{L}{2,10}))?,? (?:io |noi |sempre )?(?:mi |ci |si |le |gli |la |lo )?(?:vado|andiamo|faccio|facciamo|mangio|bevo|prendo|esco|leggo|guardo|uso|spendo|guadagno|pago|dormo|corro|cammino|studio|lavoro|alleno|sveglio|alzo|controllo|nuoto|cucino|prego|medito|guido|pratico|ceno|pranzo|ricevo|sento|brucio|investo|vediamo|incontro|incontriamo|riuniamo|peso|scrivo|mando|invio|chiamo|telefono|visito|pulisco|porto|posto|compro|ordino|preparo|annaffio)",
      // "Il mio capo arriva e controlla la posta ogni mattina", "Ogni notte mio figlio si sveglia alle 3, consigliami
      // cosa fare": someone else's habit.
      "(?<=^)(?:(?:il|la|i|le) )?(?:mio|mia|miei|mie|tuo|tua|tuoi|tue|suo|sua|suoi|sue|nostro|nostra|nostri|nostre)(?= \\p{L})|(?<=^)(?:lui|loro)(?= \\p{L})",
      "(?<=^)(?:ogni|tutti i|tutte le) \\p{L}{3,12}(?: (?:alle|di|la|al) (?:\\d{1,2}(?:[:.]\\d{2})?|\\p{L}{3,9}))?,? (?:(?:il|la|i|le) )?(?:mio|mia|miei|mie|tuo|tua|suo|sua|nostro|nostra)(?= \\p{L})",
      // "Dimmi se ogni anno bisogna pagare il bollo", "Dimmi chi vince ogni anno…": a question.
      "(?<=^)(?:dimmi|dicci|mi (?:dici|sai dire)|sai dirmi|spiegami) (?:se|chi)",
      // "Dimmi cosa vuol dire quotidianamente": the words themselves.
      "(?:vuol dire|significa|si dice|tradu(?:ci|rre)) (?:la parola )?(?:quotidianamente|giornalmente|settimanalmente|mensilmente|ogni \\p{L}{3,10}|tutti i \\p{L}{3,10}|tutte le \\p{L}{3,10})",
    ]),
    // "Dimmi quante calorie brucio ogni giorno", "una routine che io possa fare ogni giorno", a past habit.
    between: B([
      "io|noi|vado|andiamo|faccio|facciamo|mangio|bevo|prendo|esco|dormo|corro|nuoto|brucio|investo|posso|devo|dovrei|mi (?:alleno|sveglio|alzo|peso)|scrivo|mando|chiamo|visito|sento",
      // "quel film che danno ogni domenica", "un ristorante aperto tutte le domeniche", "esercizi da fare ogni mattina": the
      // schedule belongs to someone or something else.
      "(?<!(?<![\\p{L}])(?:quello|quel|ci[oò]|dimmi|dirmi|dicci|sapere|mostrami|spiegami|ricordami) )che (?:(?:mi|ti|si|ci|gli|le|lo|la|ne) )?(?!(?:io|tu|noi|voi|lei|lui|ogni|tutti|tutte|il|la|lo|i|gli|le|un|una|uno|mio|mia|tuo|tua|suo|sua|cosa|ora|ore|tempo|giorno)(?![\\p{L}]))(?!(?:esc|usc|arriv|compa|appa|succed|cambi|pubblic|vien|veng|esist)\\p{L}{0,5}(?![\\p{L}]))\\p{L}{1,15}(?:a|e|no)",
      "apert[oaie]|chius[oaie]",
      "(?<!(?<![\\p{L}])(?:promemoria|avvisi|avviso|messaggi|messaggio|notifica|notifiche|sveglia) )(?:da|per) \\p{L}{1,15}(?:are|ere|ire|rre)(?:l[oaie]|si)?",
      "(?:che|perch[eé]|se|quando|dove) (?:io |noi |mi |ci )?(?:possa|posso|possiamo|debba|devo|dobbiamo|faccia|faccio|mangi|mangio|beva|bevo|prenda|prendo|vada|vado|usi|uso|spenda|spendo|guadagni|guadagno|paghi|pago|dorma|dormo|corra|corro|cammini|cammino|studi|studio|lavori|lavoro|risparmi|risparmio|investa|investo|bruci|brucio|legga|leggo)",
      "cosa (?:mangiare|fare|leggere|vedere|guardare|studiare|bere|prendere|mettermi|cucinare|scrivere|postare)",
      "ero|eravamo|andavo|andavamo|facevo|facevamo|avevo|vivevo|abitavo",
    ]),
    // "manda", "controlla" is also "he sends / checks": a request counts at the start of the sentence or part, after
    // "per favore / puoi / vorrei che", or right after a schedule ("Ogni lunedì controlla…").
    lead: new RegExp(
      `(?:^|[,;(]\\s{0,3}|(?<![\\p{L}])(?:per favore|per piacere|perfavore|per cortesia|pf|pls|please|e|poi|anche|inoltre|ora|adesso|ciao|ehi|hey|ok|okay|allora|dai|flash|quindi|solo|soltanto|tu|lei|puoi|potresti|pu[oò]|potrebbe|riesci a|ti va di|(?:mi|ci) (?:puoi|potresti|pu[oò]|potrebbe)|(?:vorrei|voglio|ho bisogno|preferisco|mi piacerebbe) che|non dimenticare di|non scordarti di|ricordati di|da (?:oggi|ora|adesso|domani)(?: in poi)?|d'ora in poi|sempre|senza fallo|buongiorno|buonasera|grazie)\\s{1,3})(?:(?:(?:ogni|tutti i|tutte le) (?:santo |santi )?(?:\\p{L}{2,12}|(?:\\d{1,3}|due|tre|quattro|cinque|sei|dieci|dodici|quindici|venti|trenta) \\p{L}{2,9}|mezz'?ora|fine settimana|giorni (?:feriali|lavorativi))|${EN_EVERY[0]}|(?:il|di) (?:luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato)|(?:la|di) domenica|dal luned[iì] al venerd[iì]|quotidianamente|giornalmente|settimanalmente|mensilmente|(?:una|due|tre|\\d{1,2}) volt[ae] (?:al|alla|a|ogni|per) \\p{L}{3,9})(?: e \\p{L}{3,10})?(?:\\s{1,3}(?:(?:alle|verso le|entro le|dopo le|prima delle|dalle) \\d{1,2}(?:[:.]\\d{2})?|all'una|a mezzogiorno|a mezzanotte|(?:di|al|la|in) (?:mattina|mattino|pomeriggio|sera|notte)|mattina|pomeriggio|sera|presto|in punto|senza fallo)){0,3}\\s{1,3})?$`,
      "iu",
    ),
  },
  nl: {
    recur: B([
      // "elke dag", not "voor elke dag", "elke dag van de week" (a plan for each day) or "ik ga elke maandag naar de
      // sportschool, geef me een schema" (too short a start for the part rule). The time goes with it, so "Elke avond
      // om 8 uur: stuur me …" is a schedule on its own.
      "(?<!voor |van |met |ik ga |we gaan )(?:elke|iedere|elk|ieder) (?:dag|ochtend|morgen|middag|avond|nacht|week|maand|jaar|uur|kwartier|half uur|halfuur|werkdag|weekdag|weekend|kwartaal|(?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)(?:ochtend|morgen|middag|avond)?|(?:\\d{1,3}|twee|drie|vier|zes|twaalf) (?:uur|dagen|weken|minuten|maanden))(?! van (?:de week|de maand|het jaar|de reis|de vakantie|mijn|m['’]n|onze|ons|je|jouw|uw|deze|dit|zijn|haar|hun)(?![\\p{L}])| in (?:de week|20\\d\\d|januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)(?![\\p{L}])| (?:dit|vorig|volgend) jaar)(?: (?:om|rond|vanaf) (?:\\d{1,2}(?:[:.]\\d{2})?|half \\d{1,2}|kwart (?:over|voor) \\d{1,2}|(?:half |kwart over |kwart voor )(?:één|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf)|(?:één|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf)(?= uur(?![\\p{L}])))(?: ?uur)?)?",
      "om de (?:\\d{1,3}|twee|drie|vier|paar) (?:uur|dagen|weken|maanden|minuten)|om de (?:dag|week|maand)(?! (?:goed|door|beter|lekker|fijn|rustig|productief|positief|energiek|gezond|af|mee|in|uit|op|aan|te|zo|wat|nog|vrolijk|actief|bewust|zonder|met|tot|vol)(?![\\p{L}]))",
      "(?:één|een|1|twee|2|drie|3|\\d{1,2}) ?(?:keer|maal|x) (?:per|in de) (?:dag|week|maand|uur|jaar)",
      // "dagelijks" says when only before nothing it could describe: "stuur me dagelijks het nieuws", never "een
      // dagelijks overzicht".
      "(?:dagelijks|wekelijks|maandelijks|jaarlijks|tweewekelijks|regelmatig|periodiek)(?=\\s{0,3}(?:$|[,.!?;:)]|(?:het|de|een|om|op|in|voor|na|tot|vanaf|en|of|zodat|met|via|als|rond|over|mijn|m'n|me|mij|ons|wat|alle|alles|dit|dat|deze|die|je|jouw|graag|alsjeblieft|alstublieft|aub|even|weer|nog|bij|aan|naar|van|te|zo|dan|ook|door)(?![\\p{L}])))",
      // After a pronoun it says when too: "kan je dagelijks checken …", never "ons dagelijks brood".
      "(?<=(?:^|[^\\p{L}])(?:je|jij|u|jullie|me|mij|graag|even|alsjeblieft|alstublieft|aub|ook|nog) )(?:dagelijks|wekelijks|maandelijks|jaarlijks|tweewekelijks|regelmatig|periodiek)(?! (?:leven|brood|bestuur|gebruik)(?![\\p{L}]))",
      "(?<!(?:voor|van|over|tot|na|naar) ['’]?)['’]?s['’]? ?(?:maandags|dinsdags|woensdags|donderdags|vrijdags|zaterdags|zondags|ochtends|morgens|avonds|middags|nachts)(?: (?:om|rond|vanaf) (?:\\d{1,2}(?:[:.]\\d{2})?|half \\d{1,2}|kwart (?:over|voor) \\d{1,2}|(?:half |kwart over |kwart voor )(?:één|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf)|(?:één|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf)(?= uur(?![\\p{L}])))(?: ?uur)?)?",
      "op (?:maandagen|dinsdagen|woensdagen|donderdagen|vrijdagen|zaterdagen|zondagen|werkdagen|weekdagen|doordeweekse dagen)",
    ]),
    act: B([
      // Commands with "me": "stuur me", "geef me", "laat me weten", "hou me op de hoogte".
      "(?:stuur|zend|geef|vertel|zeg|mail|app|sms|ping|schrijf|maak|zoek|toon|bezorg|waarschuw|informeer|update|meld|verwittig|breng|herinner|tip) (?:me|mij|ons)",
      "laat (?:me|mij|ons|het me|het mij) (?:[^.?!,;\\n]{0,30}? )?(?:weten|zien)",
      "(?:hou|houd) (?:me|mij|ons) (?:op de hoogte|op hoogte|up-to-date|up to date|geïnformeerd|geinformeerd)",
      // Polite commands: "stuurt u mij …".
      "(?:stuurt|geeft|vertelt|zegt|mailt|laat|schrijft|maakt|zoekt|toont|herinnert|waarschuwt|informeert|controleert|checkt|houdt|vergelijkt|bekijkt) u",
      // Commands on their own, not before their subject: "check elke dag …", not "elke dag check ik …".
      "(?:stuur|zend|geef|check|controleer|bekijk|kijk|houd|hou|volg|vat|zoek|vergelijk|schrijf|maak|stel|vertaal|plaats|herhaal|doe|verzamel|analyseer|monitor|meld|mail|noem|toon|update)(?!\\s{1,3}(?:ik|we|wij|hij|zij|men|jij|u)(?![\\p{L}])|\\s{1,3}je\\s{1,3}(?!me|mij|ons)\\p{L}|\\s{0,2},)",
      // "Kun je me elke ochtend het nieuws sturen?": the request, its verb at the end.
      "(?:(?:kun|kan|kunt|zou|zoudt|wil|wilt) (?:je|jij|u)|(?:kunnen|zouden|willen) jullie)[^.?!;,\\n]{0,80}? (?:sturen|toesturen|opsturen|doorsturen|sms'en|smsen|mailen|appen|geven|zeggen|vertellen|laten weten|herinneren|melden|waarschuwen|informeren|op de hoogte houden|op de hoogte brengen|checken|controleren|nakijken|bekijken|in de gaten houden|bijhouden|volgen|samenvatten|opzoeken|zoeken|onderzoeken|uitzoeken|vergelijken|schrijven|maken|opstellen|verzamelen|vertalen|posten|plaatsen|tonen|laten zien|bezorgen|voorstellen|aanraden|bijwerken|updaten|doen|herhalen|monitoren|analyseren)",
      // "Is het mogelijk om me elke ochtend … te sturen?", not "is het mogelijk om elke dag te sporten?".
      "(?:is|zou) het mogelijk (?:zijn )?om (?:me|mij|ons)(?: [^.?!;\\n]{0,80}?)? (?:toe |door |op )?te (?:sturen|mailen|appen|sms'en|smsen|geven|laten weten|herinneren|informeren|waarschuwen|vertellen|tonen|laten zien|melden)",
      "ik (?:wil|wil graag|zou (?:graag )?willen|zou het fijn vinden|wou),? dat (?:je|jij|u)",
      "ik (?:wil|wil graag|zou graag|zou graag willen|wou)[^.?!;,\\n]{0,60}? (?:ontvangen|krijgen|binnenkrijgen)",
      "ik (?:wil|wil graag|zou graag|zou graag willen|wou|heb graag)[^.?!;,\\n]{0,40}? (?:een|'n) (?:kort |korte )?\\p{L}{0,12}(?:samenvatting|overzicht|update|rapport|verslag|briefing|nieuwsbrief|herinnering|melding|bericht|berichtje|tip|citaat|quote|grap|mop|lijst|lijstje|recept|recepten|gedicht|ideeën|ideeen|idee|suggesties|suggestie|filmtips|tips|woord|vraag|quiz|oefening)(?![^.?!;,\\n]{0,40}? (?:koken|maken|schrijven|leren|lezen|beantwoorden|eten|doen|oefenen|volgen|proberen|bedenken|bakken|oplossen|zingen|spelen|tekenen)(?![\\p{L}]))",
      "graag(?= (?:een|het|de|elke|iedere|dagelijks|wekelijks)(?![\\p{L}]))",
    ]),
    strong: B([
      // Reminders aimed at Flash with a task or time: "herinner me eraan om …", not "ik herinner me een liedje" or
      // "herinner me aan de plot van Hamlet".
      "(?<!ik |je |jij |we |wij )(?:herinner|herinnert u|herinneren) (?:me|mij|ons) (?:alsjeblieft |aub |even )?(?:er )?(?:eraan(?!,? (?:wat|hoe|wie|waar|waarom|welke|wanneer))|er aan|dat|om [^.?!\\n]{1,50}? te(?= \\p{L})|morgen|overmorgen|vandaag|vanavond|vanmiddag|vannacht|straks|later|over \\d{1,3}|over (?:een|twee|drie|een paar|vijf|tien)|om \\d{1,2}(?:[:.]\\d{2})?|op (?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|\\d{1,2})|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|elke|iedere|elk|ieder|dagelijks|wekelijks|maandelijks|volgende|aanstaande|komende|deze (?:week|maand|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)|voor (?:de|het|mijn)|na (?:de|het|mijn)|om de)",
      "(?<!ik |je |jij |we |wij )(?:herinner|herinnert u) (?:me|mij|ons) (?:alsjeblieft |aub |even )?aan (?!(?:de|het) (?:naam|namen|titel|datum|formule|regel|regels|tekst|plot|verhaal|betekenis|definitie|hoofdstad|schrijver|auteur|zanger|zangeres|acteur|actrice|nummer|recept|uitslag)(?![\\p{L}]))(?:(?!waarin |waarop |waar |wie )[^.?!\\n]){1,60}?(?:morgen|overmorgen|vanavond|vanmiddag|straks|later|om \\d{1,2}|op (?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)|volgende week|elke|iedere|dagelijks|over \\d{1,3} (?:minuten|uur|dagen)|over een uur)",
      "(?:(?:kun|kan|kunt|zou|wil|wilt) (?:je|jij|u)|(?:kunnen|zouden|willen) jullie) (?:me|mij|ons) (?:[^.?!;\\n]{0,40}? )?(?:eraan|er aan|morgen|overmorgen|vandaag|vanavond|straks|later|over \\d{1,3}|over een|om \\d{1,2}|op (?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|\\d{1,2})|elke|iedere|dagelijks|volgende|deze)(?: [^.?!;\\n]{0,40}?)? (?:herinneren|aan herinneren)(?!,? (?:wat|hoe|wie|waar|waarom|welke|wanneer))",
      // Setting one up: "zet een herinnering", not "hoe zet ik een herinnering" (see lead).
      "(?:zet|maak|plan|stel|plaats)(?: (?:voor )?(?:me|mij))?(?: even| alsjeblieft| aub)? (?:een|'n) (?:herinnering|reminder|wekker|alarm|automatisering)",
      "(?:stuur|geef|stuurt u) (?:me|mij|ons)(?: (?:morgen|vandaag|vanavond|om \\d{1,2}(?:[:.]\\d{2})?(?: uur)?)){0,2} (?:een|'n) (?:herinnering|reminder)",
      // "Waarschuw me als …", "laat me weten zodra …": the moment something happens.
      "(?:waarschuw|verwittig|notificeer|alarmeer|ping|waarschuwt u) (?:me|mij|ons),? (?:als|wanneer|zodra|indien|zo gauw)(?! (?:je|jij|u)(?![\\p{L}]))",
      "(?:geef|stuur|geeft u|stuurt u) (?:me|mij|ons) (?:even )?(?:een )?(?:seintje|melding|bericht|berichtje|notificatie|mailtje|appje|sms(?:'je|je)?|signaal),? (?:als|wanneer|zodra|indien|zo gauw)(?! (?:je|jij|u)(?![\\p{L}]))",
      "(?:laat|laten|laat u) (?:het )?(?:me|mij|ons)(?: het)? (?:even |alsjeblieft |aub )?weten,? (?:zodra|zo gauw|meteen als|direct als|zo snel)(?! (?:je|jij|u)(?![\\p{L}]))",
      "(?:informeer|mail|app|sms|vertel|zeg|meld) (?:het )?(?:me|mij|ons),? (?:zodra|zo gauw|meteen als)(?! (?:je|jij|u)(?![\\p{L}]))",
      "(?:(?:kun|kan|kunt|zou|wil|wilt) (?:je|jij|u)|(?:kunnen|zouden|willen) jullie)(?:[^.?!;\\n]{1,60}? en)? (?:me|mij|het me|het mij|ons) (?:even |alsjeblieft )?(?:waarschuwen|informeren|een seintje geven|verwittigen),? (?:als|wanneer|zodra|indien)(?! (?:je|jij|u)(?![\\p{L}]))",
      // "… en me laten weten als hij daalt", not "kun je me laten weten als je klaar bent".
      "(?:(?:kun|kan|kunt|zou|wil|wilt) (?:je|jij|u)|(?:kunnen|zouden|willen) jullie)(?:[^.?!;\\n]{1,60}? en)? (?:me|mij|het me|het mij|ons) (?:even |alsjeblieft )?(?:laten weten|melden|berichten|vertellen),? (?:zodra|zo gauw|(?:als|wanneer|of) [^.?!\\n]{0,60}?(?:uitkomt|uit komt|uitkomen|verschijnt|verschijnen|uit is|uit zijn|beschikbaar wordt|verkrijgbaar wordt|gelanceerd wordt|wordt gelanceerd|aangekondigd wordt|wordt aangekondigd|(?:beschikbaar|verkrijgbaar|op voorraad|in de aanbieding|in de uitverkoop|te koop) (?:is|zijn|komt|komen|wordt)|weer beschikbaar|weer op voorraad|afgeprijsd|goedkoper wordt|daalt|dalen|zakt|stijgt|live gaat|online komt|terug is|uitgebracht wordt|wordt uitgebracht|in de verkoop gaat|(?:boven|onder) (?:de |het )?[^\\s.?!]{1,15} (?:komt|gaat|zakt|uitkomt|staat)))(?! (?:je|jij|u)(?![\\p{L}]))",
      // "Laat me weten wanneer de nieuwe iPhone uitkomt", not "vertel me wanneer de oorlog eindigde".
      "(?:laat (?:het )?(?:me|mij|ons)(?: het)? (?:even )?weten|informeer (?:me|mij)|mail (?:me|mij)|app (?:me|mij)|meld (?:het )?(?:me|mij)),? (?:als|wanneer|of) [^.?!\\n]{0,60}?(?:uitkomt|uit komt|uitkomen|verschijnt|verschijnen|uit is|uit zijn|beschikbaar wordt|verkrijgbaar wordt|gelanceerd wordt|wordt gelanceerd|aangekondigd wordt|wordt aangekondigd|(?:beschikbaar|verkrijgbaar|op voorraad|in de aanbieding|in de uitverkoop|te koop) (?:is|zijn|komt|komen|wordt)|weer beschikbaar|weer op voorraad|afgeprijsd|goedkoper wordt|daalt|dalen|zakt|stijgt|live gaat|online komt|terug is|uitgebracht wordt|wordt uitgebracht|in de verkoop gaat|(?:boven|onder) (?:de |het )?[^\\s.?!]{1,15} (?:komt|gaat|zakt|uitkomt|staat))",
      // "Vertel me wanneer …", not "vertel me of de huizenprijzen dalen" (a forecast).
      "(?:vertel (?:het )?(?:me|mij)|zeg (?:het )?(?:me|mij)),? (?:als|wanneer) [^.?!\\n]{0,60}?(?:uitkomt|uit komt|uitkomen|verschijnt|verschijnen|uit is|uit zijn|beschikbaar wordt|verkrijgbaar wordt|gelanceerd wordt|wordt gelanceerd|aangekondigd wordt|wordt aangekondigd|(?:beschikbaar|verkrijgbaar|op voorraad|in de aanbieding|in de uitverkoop|te koop) (?:is|zijn|komt|komen|wordt)|weer beschikbaar|weer op voorraad|afgeprijsd|goedkoper wordt|daalt|dalen|zakt|stijgt|live gaat|online komt|terug is|uitgebracht wordt|wordt uitgebracht|in de verkoop gaat|(?:boven|onder) (?:de |het )?[^\\s.?!]{1,15} (?:komt|gaat|zakt|uitkomt|staat))",
      // "Zodra de nieuwe iPhone uit is, laat het me weten", not "als de dollar daalt, vertel me wat er met goud gebeurt".
      "(?:zodra|als|wanneer) [^,.?!\\n]{1,60}?(?:uitkomt|uit komt|uitkomen|verschijnt|verschijnen|uit is|uit zijn|beschikbaar wordt|verkrijgbaar wordt|gelanceerd wordt|wordt gelanceerd|aangekondigd wordt|wordt aangekondigd|(?:beschikbaar|verkrijgbaar|op voorraad|in de aanbieding|in de uitverkoop|te koop) (?:is|zijn|komt|komen|wordt)|weer beschikbaar|weer op voorraad|afgeprijsd|goedkoper wordt|daalt|dalen|zakt|stijgt|live gaat|online komt|terug is|uitgebracht wordt|wordt uitgebracht|in de verkoop gaat|(?:boven|onder) (?:de |het )?[^\\s.?!]{1,15} (?:komt|gaat|zakt|uitkomt|staat))[^,.?!\\n]{0,20}?,\\s{0,2}(?:laat|stuur|geef|waarschuw|meld|vertel|zeg|ping|app|mail)(?: het)? (?:me|mij)(?![\\s,]{1,3}(?:wat|hoe|welke|welk|waarom|of|wie|waar|wanneer)(?![\\p{L}]))",
      "automatisch (?:elke|iedere|dagelijks|wekelijks|sturen|checken|controleren|herinneren)",
      "automatiseer (?:dit|dat|het|deze taak)(?: voor (?:me|mij))?(?: alsjeblieft| aub)?$",
      "(?:kun|kan|kunt|zou|wil|wilt) (?:je|jij|u) (?:dit|dat|het) (?:voor (?:me|mij) )?automatiseren$",
      // "Stuur me een wekelijks overzicht", "een weekoverzicht", not "maak een wekelijks schema".
      "(?:stuur|geef|mail|stuurt u|geeft u) (?:me|mij|ons) (?:elke dag |iedere dag )?(?:een|'n) (?:kort |korte )?(?:(?:dagelijks|dagelijkse|wekelijks|wekelijkse|weekelijkse|maandelijks|maandelijkse|tweewekelijks|tweewekelijkse) (?:\\p{L}{1,15} )?|(?:dag|week|maand))(?:overzicht|samenvatting|update|rapport|rapportage|verslag|briefing|nieuwsbrief|herinnering|nieuwsoverzicht|nieuwsupdate|tip|citaat|quote|grap|mop|horoscoop|weerbericht|digest|melding|recap)",
    ]),
    // A question ("Hoeveel water moet ik elke dag drinken?", "Is het slecht om elke dag …") or how often.
    not: /^(?:(?:hoi|hallo|hey|hé|goedemorgen|goedemiddag)[,! ]{1,3})?(?:hoe|waarom|wat|wanneer|welke|welk|wie|waar|hoeveel|hoelang|is(?! het mogelijk)|zijn|was|waren|moet|moeten|mag|mogen|heb|heeft|hebben|ben|klopt|bestaat|helpt|zal (?:ik|je|het)|zou (?:ik|het(?! mogelijk)|men)|kan (?:ik|men|het)|kun ik|kunnen (?:we|ze))(?![\p{L}])|hoe vaak|hoeveel keer|hoeveel maal|voordelen|nadelen|is het (?:goed|slecht|gezond|ongezond|normaal|erg|gevaarlijk|verstandig|oké|oke|ok)(?![\p{L}])|is dat (?:te veel|teveel|raar|vreemd|gek|normaal|gezond|ongezond|erg|slecht|overdreven|slim|verstandig)(?![\p{L}])|(?:gezond|ongezond|gevaarlijk) om(?![\p{L}])|moet ik|zou ik moeten|mag ik|(?:[,;]|\s[-–—])\s{0,3}(?:wie (?:zei|zegt) (?:dat|dit|het)|wie heeft (?:dat|dit) gezegd|van wie is (?:dit|dat|deze|die) (?:citaat|uitspraak|quote))|,\s{0,3}(?:welke|welk|wat)\s(?:\p{L}{1,20}\s)?(?:raad je|raadt u|is (?:het |de )?(?:beste|goed)|zijn (?:de |het )?(?:beste|goed))|wat raad je (?:me )?aan|wat vind je ervan|wat denk je ervan/iu,
    // Between the request and the schedule, an embedded question or someone's habit: "vertel me hoeveel water ik elke
    // dag …", "geef me een routine die ik elke ochtend …", "geef me tips om elke dag fit te zijn", "een kaart voor
    // oma die me elke zondag belt" (but "doe dat elke maandag" and "en dat elke ochtend" still ask).
    between:
      /(?<![\p{L}])(?:hoe|waarom|wanneer|welke|welk|hoeveel|ik|we|wij|men|hij|mensen|kinderen|wat (?:ik|je|we|men|er|het|de|moet|kan|zijn|is|mensen)|of (?:ik|het|je|dat|er|we)|dat (?:ik|we|wij|men|hij|zij|ze|mijn|m['’]n|zijn|haar|onze|ons|je|jij|u|de|het|er)|die (?:ik|je|men|we))(?![\p{L}])|(?<![\p{L}])om(?:\s(?!\d|de\s|het\s)|\s?$)|\p{L}(?<!(?<![\p{L}])(?:en|maar|of|ook))\s{1,3}(?:die|dat|wie|wat)(?:\s{1,3}(?:me|mij|ons|je|hem|haar|ze|zij|hij|er|het))?\s{0,2}$|(?<![\p{L}])(?:omdat|want|hoewel|terwijl|nadat|voordat|sinds|waarin|waarop|waarbij|waarmee|waar|is|zijn|ben|bent|was|waren|heb|hebt|heeft|hebben|wordt|worden)(?![\p{L}])/iu,
    // Before a request whose words could be something else ("check" in "ik check", "stuur" in "ik stuur"): the
    // start of the sentence or part, "alsjeblieft", "kun je", a schedule.
    lead: /(?:^|[,;(]\s{0,3}|(?<![\p{L}])(?:alsjeblieft|alstublieft|aub|a\.u\.b\.|pls|plz|dan|daarna|ook|verder|nu|oké|oke|ok|okay|hoi|hallo|hey|hé|ja|flash|gewoon|even|graag|vanaf nu|voortaan|vanaf morgen|vanaf vandaag|kun je|kan je|kunt u|zou je|zou u|wil je|wilt u|kun jij|kan jij|wil jij|vergeet niet|vergeet niet om)\s{1,3}|(?<![\p{L}])(?:(?:elke|iedere|elk|ieder|om de) (?:\p{L}{1,14}|\d{1,3} \p{L}{1,8})|dagelijks|wekelijks|maandelijks|['’]?s['’]? ?\p{L}{3,10}s)(?:\s{1,3}om\s{1,3}(?:\d{1,2}(?:[:.]\d{2})?|half\s\d{1,2}|kwart\s(?:over|voor)\s\d{1,2}|(?:half\s|kwart\s(?:over|voor)\s)?(?:één|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf))(?:\s?uur)?)?\s{1,3})$/iu,
  },
  sv: {
    recur: B([
      // "varje dag", not "för varje dag" or "varje dag i veckan" (a plan for each day). The time goes with it, so
      // "Varje kväll klockan 20: skicka …" is a schedule on its own.
      "(?<!för |for |med |öppet |öppen |öppna |oppet |oppen |oppna |stängt |stangt |stängd |stangd )(?:varje|varenda) (?:dag|morgon|förmiddag|formiddag|eftermiddag|kväll|kvall|natt|vecka|månad|manad|år|timme|kvart|halvtimme|vardag|helg|veckodag|arbetsdag|(?:måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|mandag|lordag|sondag)(?:s?morgon|s?kväll|s?kvall|s?eftermiddag)?|(?:\\d{1,3}|två|tva|tre|fyra|sex|tolv) (?:timmar|minuter|dagar|veckor))(?! i (?:veckan|månaden|manaden|år|ar|fjol)(?![\\p{L}])| av | under | förra| forra| sedan| 20\\d\\d| på (?:resan|semestern|lägret|lagret)(?![\\p{L}]))(?: (?:kl\\.?|klockan|vid) ?(?:\\d{1,2}(?:[:.]\\d{2})?|halv \\d{1,2}|kvart (?:över|over|i) \\d{1,2}|(?:halv |kvart (?:över|over|i) )?(?:ett|två|tva|tre|fyra|fem|sex|sju|åtta|atta|nio|tio|elva|tolv)(?![\\p{L}])))?",
      "var (?:\\d{1,2}:?e|annan|tredje|fjärde|fjarde|femte|sjätte|sjatte|åttonde|attonde|tionde|tolfte) (?:minut|timme|dag|vecka|månad|manad)",
      "varannan (?:dag|vecka|månad|manad|timme|morgon|kväll|kvall|helg)|varannat år",
      "(?:en|ett|två|tva|tre|\\d{1,2}) gång(?:er)? (?:per|i|om|varje|på|pa) (?:dag|dagen|vecka|veckan|månad|månaden|manad|manaden|timme|timmen|år|året)",
      "dagligen|veckovis|månadsvis|manadsvis|timvis|regelbundet",
      "(?:på|pa) (?:måndagar|tisdagar|onsdagar|torsdagar|fredagar|lördagar|söndagar|mandagar|lordagar|sondagar|vardagar|helger|helgerna|morgnarna|kvällarna|kvallarna|veckodagar)(?: (?:kl\\.?|klockan|vid) ?(?:\\d{1,2}(?:[:.]\\d{2})?|halv \\d{1,2}|kvart (?:över|over|i) \\d{1,2}|(?:halv |kvart (?:över|over|i) )?(?:ett|två|tva|tre|fyra|fem|sex|sju|åtta|atta|nio|tio|elva|tolv)(?![\\p{L}])))?",
    ]),
    act: B([
      // Commands ("skicka", "påminn mig"), told from the present ("skickar") by their form; "gör", "kör" and
      // "jämför" are both, so none counts before its subject ("varje dag gör jag …").
      "(?:skicka|sänd|sand|maila|mejla|messa|sms:a|smsa|pinga|meddela|berätta|beratta|säg|sag|ge|påminn|paminn|kolla|kontrollera|bevaka|övervaka|overvaka|följ|folj|sammanfatta|summera|sammanställ|sammanstall|sök|sok|leta|hitta|ta fram|jämför|jamfor|skriv|skapa|gör|gor|generera|förbered|forbered|föreslå|foresla|rekommendera|översätt|oversatt|posta|publicera|undersök|undersok|analysera|researcha|kör|kor|upprepa|uppdatera|notifiera|informera|underrätta|underratta|varna)(?!\\s{1,3}(?:jag|vi|han|hon|man|du|ni)(?![\\p{L}])|\\s{0,2},)",
      // "Visa mig", not "visa till USA"; "lista nya jobb", not "lista över saker att göra".
      "visa(?! till| för| for| ansökan| ansokan)(?!\\s{1,3}(?:jag|vi|han|hon|man)(?![\\p{L}]))|lista(?! över| over| med| på| pa| av)",
      "(?:håll|hall) (?:mig|oss) (?:uppdaterad|uppdaterade|informerad|informerade|underrättad|underrattad)|(?:håll|hall) koll på|hall koll pa|(?:håll|hall) ett (?:öga|oga) (?:på|pa)|(?:hör|hor) av dig",
      // After "kan du", "skulle du kunna" …: "kan du göra det varje vecka?" (the "-a" verbs above count there too).
      "(?:kan du|kan ni|kunde du|skulle du kunna|skulle ni kunna|vill du|orkar du|du kan|du får gärna|du far garna|var snäll och|var snall och|var vänlig och|var vanlig och|glöm inte att|glom inte att)(?:[^.?!,;\\n]{0,40}?\\s)?(?:göra|gora|skriva|söka|soka|säga till|saga till|säga|saga|ge|hålla koll på|hålla|halla|påminna|paminna|jämföra|jamfora|följa|folja|undersöka|undersoka|sammanställa|sammanstalla|översätta|oversatta|köra|kora|föreslå|foresla|sända|sanda|ta fram|höra av dig)",
      "(?:jag vill|jag skulle vilja|jag önskar|jag onskar)(?: gärna| garna)? att du (?:skickar|påminner|paminner|kollar|ger|berättar|berattar|meddelar|sammanfattar|skriver|gör|gor|söker|soker|bevakar|håller|haller|letar|hittar|visar|kontrollerar|uppdaterar|mejlar|mailar|säger|sager|varnar)",
      "(?:jag vill|jag skulle vilja|jag önskar|jag onskar)(?: gärna| garna)? (?:få|fa|ha (?:en|ett) \\p{L}{0,12}(?:sammanfattning|uppdatering|rapport|påminnelse|paminnelse|översikt|oversikt|lista|tips|recept|dikt|citat|skämt|skamt|nyhetsbrev))",
      // "Går det att skicka mig …", "är det möjligt att få vädret …", not "går det att göra armhävningar varje dag?".
      "(?:går det att|gar det att|är det möjligt att|ar det mojligt att|vore det möjligt att|vore det mojligt att)(?: du| ni)? (?:skicka|skickar|ge|ger|mejla|mejlar|maila|mailar|påminna|påminner|paminna|paminner|meddela|meddelar|sms:a|smsa|pinga) (?:mig|oss)",
      "(?:går det att|gar det att|är det möjligt att|ar det mojligt att|vore det möjligt att|vore det mojligt att) få (?:\\p{L}{1,20} ){0,2}?(?:vädret|vadret|nyheterna|sammanfattning|sammanfattningen|påminnelse|paminnelse|uppdatering|uppdateringar|rapport|lista|mejl|sms|notis|notiser|tips|väderprognos|vaderprognos|nyhetsbrev)",
    ]),
    strong: B([
      // Reminders with a task or a time: "påminn mig att ringa", not "påminn mig om handlingen i Hamlet".
      "(?:påminn|paminn|påmin|pamin|påminna|paminna) (?:mig|oss) (?:gärna |garna |snälla |snalla )?(?:om att|att|i morgon|imorgon|imorn|i morn|ikväll|ikvall|i kväll|i kvall|idag|i dag|i eftermiddag|senare|sen|om (?:en|ett) (?:timme|halvtimme|kvart|minut|vecka|månad|manad|dag)|om (?:\\d{1,3}|två|tva|tre|några|nagra) (?:minuter|timmar|dagar|veckor)|kl\\.? ?\\d{1,2}(?:[:.]\\d{2})?|klockan \\d{1,2}(?:[:.]\\d{2})?|(?:på|pa) (?:måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|mandag|lordag|sondag)|måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag|varje|varannan|var (?:\\d{1,2}:?e|annan|tredje)|nästa|nasta|innan|före|fore|efter|en gång|dagligen|i helgen)",
      "(?:påminn|paminn|påmin|pamin|påminna|paminna) (?:mig|oss) om (?!(?:namnet|titeln|datumet|formeln|regeln|texten|handlingen|betydelsen|definitionen|huvudstaden|författaren|forfattaren|sångaren|sangaren|skådespelaren|skadespelaren|vad|vem|hur|vilken|vilket|vilka)(?![\\p{L}]))(?:(?!där |dar |vad |vem )[^.?!\\n]){1,60}?(?:i morgon|imorgon|imorn|ikväll|ikvall|i kväll|kl\\.? ?\\d{1,2}(?:[:.]\\d{2})?|klockan \\d{1,2}|(?:på|pa) (?:måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)|nästa vecka|nasta vecka|varje|om \\d{1,3} (?:minuter|timmar|dagar)|om en timme)",
      // Setting one up: "skapa en påminnelse", not "hur skapar jag en påminnelse" (see lead).
      "(?:skapa|sätt|satt|lägg till|lagg till|lägg in|lagg in|ställ in|stall in|gör|gor|fixa|schemalägg|schemalagg)(?: gärna| garna| snälla| snalla)?(?: (?:en|ett))? (?:påminnelse|paminnelse|larm|alarm|automatisering)",
      "(?:skicka|ge) (?:mig )?(?:(?:i morgon|imorgon|imorn|ikväll|ikvall|kl\\.? ?\\d{1,2}(?:[:.]\\d{2})?|klockan \\d{1,2}(?:[:.]\\d{2})?) )?en (?:påminnelse|paminnelse)",
      // "Meddela mig när …", "säg till så fort …": the moment something happens.
      "(?:meddela|notifiera|varna|pinga|sms:a|smsa|mejla|maila|underrätta|underratta|skriv till) (?:mig|oss),? (?:när|nar|så fort|sa fort|så snart|sa snart)(?! (?:du|ni)(?![\\p{L}]))",
      "(?:(?:säg|sag|säga|saga) till|(?:hör|hor|höra|hora) av dig),? (?:när|nar|så fort|sa fort|så snart|sa snart)(?! (?:du|ni)(?![\\p{L}]))",
      "(?:ge|skicka) (?:mig|oss) (?:en )?(?:signal|besked|notis|varning|avisering|pling|notifikation),? (?:när|nar|så fort|sa fort|så snart)(?! (?:du|ni)(?![\\p{L}]))",
      "(?:berätta|beratta|låt mig veta|lat mig veta|säg|sag)(?: för mig| det)?,? (?:så fort|sa fort|så snart|sa snart)(?! (?:du|ni)(?![\\p{L}]))",
      // "Berätta när nya iPhone släpps", not "berätta när andra världskriget slutade" or "säg till om texten har fel".
      "(?:berätta|beratta|säg|sag)(?: för mig| det)?,? (?:när|nar) [^.?!\\n]{0,60}?(?:släpps|slapps|kommer ut|lanseras|är ute|ar ute|blir tillgänglig|blir tillganglig|finns i lager|finns tillgänglig|finns tillganglig|är tillgänglig|ar tillganglig|är tillbaka i lager|är i lager|går ner|gar ner|sjunker|stiger|går upp|gar upp|går under|gar under|går över|gar over|blir billigare|är på rea|ar pa rea|reas|publiceras|tillkännages|annonseras|börjar säljas|borjar saljas)",
      // "Meddela mig om bitcoin går under 50k", not "berätta om varför bensinpriset stiger" or "säg om aktien stiger imorgon".
      "(?:låt mig veta|lat mig veta|säg till|sag till|meddela(?: mig)?|hör av dig|hor av dig|varna mig|notifiera mig),? (?:när|nar|om|ifall) [^.?!\\n]{0,60}?(?:släpps|slapps|kommer ut|lanseras|är ute|ar ute|blir tillgänglig|blir tillganglig|finns i lager|finns tillgänglig|finns tillganglig|är tillgänglig|ar tillganglig|är tillbaka i lager|är i lager|går ner|gar ner|sjunker|stiger|går upp|gar upp|går under|gar under|går över|gar over|blir billigare|är på rea|ar pa rea|reas|publiceras|tillkännages|annonseras|börjar säljas|borjar saljas)",
      // "Om bitcoin går under 50k, meddela mig", not "om dollarn sjunker, berätta vad som händer med guldet".
      "(?:när|nar|så fort|sa fort|om) [^,.?!\\n]{1,60}?(?:släpps|slapps|kommer ut|lanseras|är ute|ar ute|blir tillgänglig|blir tillganglig|finns i lager|finns tillgänglig|finns tillganglig|är tillgänglig|ar tillganglig|är tillbaka i lager|är i lager|går ner|gar ner|sjunker|stiger|går upp|gar upp|går under|gar under|går över|gar over|blir billigare|är på rea|ar pa rea|reas|publiceras|tillkännages|annonseras|börjar säljas|borjar saljas)[^,.?!\\n]{0,20}?,\\s{0,2}(?:meddela|säg till|sag till|skicka|varna|pinga|hör av dig|berätta|beratta)(?![\\s,]{1,3}(?:vad|hur|vilka|vilken|vilket|varför|varfor|om|vem|var|när|nar)(?![\\p{L}]))",
      // "Kan du bevaka priset och säga till när det blir billigare", not "… och säga till om något är fel".
      "(?:kan du|kan ni|kunde du|skulle du kunna|skulle ni kunna|vill du)[^.?!;\\n]{1,60}? och (?:meddela|notifiera|varna|pinga|sms:a|smsa|mejla|maila) (?:mig|oss),? (?:(?:när|nar|så fort|sa fort|så snart|sa snart)(?! (?:du|ni)(?![\\p{L}]))|(?:om|ifall) [^.?!\\n]{0,60}?(?:släpps|slapps|kommer ut|lanseras|är ute|ar ute|blir tillgänglig|blir tillganglig|finns i lager|finns tillgänglig|finns tillganglig|är tillgänglig|ar tillganglig|är tillbaka i lager|är i lager|går ner|gar ner|sjunker|stiger|går upp|gar upp|går under|gar under|går över|gar over|blir billigare|är på rea|ar pa rea|reas|publiceras|tillkännages|annonseras|börjar säljas|borjar saljas))",
      "(?:kan du|kan ni|kunde du|skulle du kunna|skulle ni kunna|vill du)[^.?!;\\n]{1,60}? och (?:säga till|saga till|höra av dig|hora av dig),? (?:så fort|sa fort|så snart|sa snart|(?:när|nar|om|ifall) [^.?!\\n]{0,60}?(?:släpps|slapps|kommer ut|lanseras|är ute|ar ute|blir tillgänglig|blir tillganglig|finns i lager|finns tillgänglig|finns tillganglig|är tillgänglig|ar tillganglig|är tillbaka i lager|är i lager|går ner|gar ner|sjunker|stiger|går upp|gar upp|går under|gar under|går över|gar over|blir billigare|är på rea|ar pa rea|reas|publiceras|tillkännages|annonseras|börjar säljas|borjar saljas))",
      "automatiskt (?:varje|varannan|dagligen|skicka|kolla|påminna|påminn|meddela|bevaka)",
      "automatisera (?:detta|det här|det har|det|den här uppgiften)(?: åt mig| at mig)?$",
      // "Skicka mig en daglig sammanfattning", "en veckosammanfattning", not "gör ett dagligt schema".
      "(?:skicka|ge|maila|mejla|sänd)(?: mig| oss| till mig)? (?:en|ett) (?:kort |kortfattad )?(?:(?:daglig|dagligt|veckovis|veckovist|månatlig|månatligt|manatlig|manatligt) (?:\\p{L}{1,15} )?|(?:dags|vecko|månads|manads|morgon))(?:sammanfattning|översikt|oversikt|uppdatering|rapport|briefing|brief|nyhetsbrev|påminnelse|paminnelse|sammanställning|sammanstallning|tips|citat|skämt|skamt|horoskop|väderprognos|vaderprognos|nyhetsöversikt|digest|notis|summering|nyheter)",
    ]),
    // A question ("Hur mycket vatten ska jag dricka varje dag?", "Är det dåligt att …") or how often.
    not: /^(?:(?:hej|hallå|halla|tja|hejsan)[,! ]{1,3})?(?:hur|varför|varfor|vad|vilken|vilket|vilka|när|nar|vem|är(?! det möjligt| det mojligt)|ar(?! det mojligt)|har (?:jag|man)|ska jag|bör jag|bor jag|borde jag|kan jag|kan man|får jag|far jag|måste jag|maste jag|finns det|stämmer det|stammer det|blir det|behöver jag|behover jag)(?![\p{L}])|hur ofta|hur många gånger|hur manga ganger|fördelar|fordelar|nackdelar|(?:är|ar) det (?:bra|dåligt|daligt|nyttigt|onyttigt|farligt|normalt|skadligt|för mycket|for mycket|konstigt|fel|rimligt|överdrivet|overdrivet|själviskt|sjalviskt)(?![\p{L}])|ska jag|bör jag|borde jag|behöver jag|behover jag|måste jag|maste jag|(?:[,;]|\s[-–—])\s{0,3}(?:vem (?:sa|sade|skrev) (?:det|så|sa)(?![\p{L}])|vem har sagt|vems citat)|,\s{0,3}(?:vilken|vilket|vilka|vad)\s(?:\p{L}{1,20}\s)?(?:är (?:bäst|bra|bättre)|ar (?:bast|bra|battre)|rekommenderar du|föreslår du|foreslar du|tycker du)|vad rekommenderar du|vad tycker du/iu,
    // Between the request and the schedule, an embedded question or someone's habit: "berätta hur mycket vatten jag
    // ska dricka varje dag", "ge mig en rutin som jag kan göra varje morgon", "ge mig övningar att göra varje dag".
    between:
      /(?<![\p{L}])(?:hur|varför|varfor|vad|vilken|vilket|vilka|när|nar|jag|vi|man|han|hon|folk|människor|manniskor|barn|om (?:jag|det|man|du)|som)(?![\p{L}])|(?<![\p{L}])(?:för att|for att|att)\s(?!\d)|(?<![\p{L}])(?:eftersom|därför att|darfor att|trots att|medan|där|dar)(?![\p{L}])|(?<![\p{L}])(?:är|ar|blir|känns|kanns|var|finns|har) (?:det|den|de)(?![\p{L}])/iu,
    // Before a request whose words are also an infinitive ("jag brukar kolla mobilen varje timme"): the start of the
    // sentence or part, "snälla", "kan du", a schedule.
    lead: /(?:^|[,;(]\s{0,3}|(?<![\p{L}])(?:snälla|snalla|vänligen|vanligen|sen|sedan|också|ocksa|bara|nu|ok|okej|okay|hej|hallå|halla|tja|hejsan|ja|flash|gärna|garna|från och med nu|fran och med nu|framöver|framover|kan du|kan ni|kunde du|skulle du kunna|skulle ni kunna|vill du|orkar du|du kan|du får gärna|du far garna|var snäll och|var snall och|var vänlig och|var vanlig och|glöm inte att|glom inte att)(?:\s{1,3}(?:gärna|garna|snälla|snalla|också|ocksa|bara))?\s{1,3}|(?<![\p{L}])(?:(?:varje|varenda|varannan) (?:\p{L}{1,14}|\d{1,3} \p{L}{1,8})|var \d{1,2}:?e \p{L}{1,8}|dagligen|veckovis|månadsvis)(?:\s{1,3}(?:kl\.?|klockan|vid|runt)\s{0,3}(?:\d{1,2}(?:[:.]\d{2})?|halv\s\d{1,2}|(?:halv\s|kvart\s(?:över|over|i)\s)?(?:ett|två|tva|tre|fyra|fem|sex|sju|åtta|atta|nio|tio|elva|tolv)))?\s{1,3})$/iu,
  },
  pl: {
    recur: B([
      // "co rano" only where it can't be "what … in the morning" ("Opowiedz mi o tym, co rano robią
      // Japończycy"), and "każdego miesiąca 2024 roku" is "of each month".
      "(?:codziennie|(?<!(?:^|[^\\p{L}])(?:z|ze|dla|od|do|na|za) )ka[żz]dego (?:dnia|ranka|poranka|wieczoru|wieczora|tygodnia|miesi[ąa]ca|roku|poniedzia[łl]ku|wtorku|czwartku|pi[ąa]tku)(?! (?:\\d|roku|ubieg[łl]ego|zesz[łl]ego|poprzedniego|tego roku|w (?:roku|\\d|zesz[łl]ym|tym|ubieg[łl]ym)))|(?<!(?:^|[^\\p{L}])(?:z|ze|dla|od|do|na|za) )ka[żz]dej (?:nocy|godziny|[śs]rody|soboty|niedzieli)(?! (?:\\d|roku|ubieg[łl]ego|zesz[łl]ego|poprzedniego|tego roku|w (?:roku|\\d|zesz[łl]ym|tym|ubieg[łl]ym)))|w ka[żz]dy (?:poniedzia[łl]ek|wtorek|czwartek|pi[ąa]tek|weekend|dzie[ńn] roboczy)|w ka[żz]d[ąa] (?:[śs]rod[ęe]|sobot[ęe]|niedziel[ęe]|noc)|(?<!(?:^|[^\\p{L}])na )co (?:dzie[ńn]|tydzie[ńn]|miesi[ąa]c|roku|wiecz[óo]r|noc|godzin[ęe]|p[óo][łl] godziny|weekend|poniedzia[łl]ek|wtorek|[śs]rod[ęe]|czwartek|pi[ąa]tek|sobot[ęe]|niedziel[ęe]|(?:\\d{1,3}|dwa|dwie|trzy|cztery|pi[ęe][ćc]|sze[śs][ćc]|kilka|par[ęe]) (?:minut|minuty|godziny|godzin|dni|tygodnie|tygodni|miesi[ąa]ce|miesi[ęe]cy)|\\d{1,3} ?(?:h|godz|min))|(?<=^|^\\p{L}{1,10},?\\s{1,2}|(?:prosz[ęe]|i|a|oraz|potem|te[żz])\\s{1,2})co rano|co rano(?=\\s{0,2}(?:$|[,.!?;:)]|o \\d|o godz|i(?![\\p{L}])))|w (?:poniedzia[łl]ki|wtorki|[śs]rody|czwartki|pi[ąa]tki|soboty|niedziele|weekendy|dni robocze|dni powszednie)|(?:raz|dwa razy|trzy razy|\\d{1,2} razy) (?:dziennie|tygodniowo|miesi[ęe]cznie|w tygodniu|w miesi[ąa]cu|na dzie[ńn]|na tydzie[ńn]|na miesi[ąa]c|na godzin[ęe]|w roku))(?: (?:rano|wieczorem|w nocy|po po[łl]udniu|o (?:godz(?:inie|\\.)?(?: ?\\d{1,2}(?:[:.]\\d{2})?)?|\\d{1,2}(?:[:.]\\d{2})?)(?: rano| wieczorem)?)){0,2}",
    ]),
    act: B([
      "wy[śs]lij|wysy[łl]aj|przy[śs]lij|przysy[łl]aj|prze[śs]lij|przesy[łl]aj|pode[śs]lij|podsy[łl]aj|wrzucaj",
      "przypomnij|przypominaj|powiadom|powiadamiaj|poinformuj|informuj|zawiadom|zawiadamiaj|daj (?:mi )?zna[ćc]|dawaj (?:mi )?zna[ćc]|trzymaj mnie na bie[żz][ąa]co|powiedz|m[óo]w|opowiedz|opowiadaj|napisz|pisz|podaj|podawaj|daj mi|dawaj mi|poka[żz]|pokazuj",
      "sprawd[źz]|sprawdzaj|monitoruj|obserwuj|[śs]led[źz]|pilnuj|kontroluj|przejrzyj|przegl[ąa]daj|zerknij|zagl[ąa]daj",
      "podsumuj|podsumowuj|stre[śs][ćc]|streszczaj|zbierz|zbieraj|wyszukaj|wyszukuj|szukaj|poszukaj|znajd[źz]|znajduj|zbadaj|przeanalizuj|analizuj|por[óo]wnaj|por[óo]wnuj|przet[łl]umacz|t[łl]umacz|wymie[ńn]|wypisz",
      "przygotuj|przygotowuj|stw[óo]rz|tw[óo]rz|wygeneruj|generuj|zr[óo]b|r[óo]b|u[łl][óo][żz]|uk[łl]adaj|wymy[śs]l|zaproponuj|proponuj|pole[ćc]|polecaj|opublikuj|publikuj|wybierz|wybieraj|powtarzaj|powt[óo]rz",
      // "Czy możesz codziennie wysyłać mi…", "Chcę, żebyś mi przypominał…", "Chciałbym codziennie
      // dostawać…".
      "(?:mo[żz]esz|mo[żz]ecie|m[óo]g[łl]by[śs]|mog[łl]aby[śs]|m[óo]g[łl]by pan|mog[łl]aby pani|mogliby[śs]cie|dasz rad[ęe]|potrafisz|b[ęe]dziesz|prosz[ęe])(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,6}? (?:wysy[łl]a[ćc]|wys[łl]a[ćc]|przesy[łl]a[ćc]|przes[łl]a[ćc]|przysy[łl]a[ćc]|przys[łl]a[ćc]|podsy[łl]a[ćc]|podes[łl]a[ćc]|przypomina[ćc]|przypomnie[ćc]|informowa[ćc]|poinformowa[ćc]|powiadamia[ćc]|powiadomi[ćc]|dawa[ćc] zna[ćc]|da[ćc] zna[ćc]|m[óo]wi[ćc]|powiedzie[ćc]|pisa[ćc]|napisa[ćc]|podawa[ćc]|poda[ćc]|dawa[ćc]|da[ćc]|pokazywa[ćc]|pokaza[ćc]|sprawdza[ćc]|sprawdzi[ćc]|monitorowa[ćc]|obserwowa[ćc]|[śs]ledzi[ćc]|pilnowa[ćc]|podsumowywa[ćc]|podsumowa[ćc]|streszcza[ćc]|zbiera[ćc]|zebra[ćc]|wyszukiwa[ćc]|wyszuka[ćc]|szuka[ćc]|poszuka[ćc]|znajdowa[ćc]|znale[źz][ćc]|analizowa[ćc]|por[óo]wnywa[ćc]|t[łl]umaczy[ćc]|przygotowywa[ćc]|przygotowa[ćc]|tworzy[ćc]|stworzy[ćc]|generowa[ćc]|wygenerowa[ćc]|robi[ćc]|zrobi[ćc]|uk[łl]ada[ćc]|proponowa[ćc]|poleca[ćc]|publikowa[ćc]|wrzuca[ćc])",
      "(?:[żz]eby[śs]|aby[śs])(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,5}? (?:wysy[łl]a[łl]|przysy[łl]a[łl]|przesy[łl]a[łl]|podsy[łl]a[łl]|przypomina[łl]|informowa[łl]|powiadamia[łl]|dawa[łl]|m[óo]wi[łl]|pisa[łl]|podawa[łl]|pokazywa[łl]|sprawdza[łl]|monitorowa[łl]|[śs]ledzi[łl]|pilnowa[łl]|podsumowywa[łl]|zbiera[łl]|szuka[łl]|wyszukiwa[łl]|przygotowywa[łl]|robi[łl]|tworzy[łl]|generowa[łl]|publikowa[łl])a?",
      "(?:chc[ęe]|chcia[łl]bym|chcia[łl]abym|chcieliby[śs]my|chcemy)(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,4}? (?:dostawa[ćc]|otrzymywa[ćc])",
    ]),
    strong: B([
      // "Przypomnij mi jutro o spotkaniu", "…, żebym zadzwonił", "… zapłacić czynsz", not "Przypomnij mi
      // fabułę Hamleta", "… treść ustawy", "…, przed jaką bitwą…", "… o serialu, który oglądaliśmy w każdą
      // niedzielę" or "Mama mi przypomniała".
      "(?:przypomnij|przypominaj|przypomnisz|przypomnijcie|(?:mo[żz]esz|m[óo]g[łl]by[śs]|mog[łl]aby[śs]|prosz[ęe]|nie zapomnij|b[ęe]dziesz)(?: [^\\s.,!?;:]{1,15}){0,2}? (?:przypomnie[ćc]|przypomina[ćc]))(?: mi| nam)?(?: prosz[ęe])?,? (?:[żz]ebym|[żz]eby|abym|aby|[żz]e|o tym,? [żz]e|o tym,? [żz]eby|(?!(?:tre[śs][ćc]|cz[ęe][śs][ćc]|cze[śs][ćc]|powie[śs][ćc]|opowie[śs][ćc]|wie[śs][ćc]|te[śs][ćc]|pi[ęe][śs][ćc]|przepa[śs][ćc]|napa[śs][ćc]|p[łl]e[ćc]|ch[ęe][ćc]|pami[ęe][ćc]|[śs]mier[ćc]|ni[ćc])(?![\\p{L}]))\\p{L}{1,20}(?:[aiyuą][ćc]|eć|(?<!o)ś[ćc]|(?<!o)sc)(?: si[ęe])?|jutro|pojutrze|dzi[śs]|dzisiaj|wieczorem|rano|po po[łl]udniu|w nocy|o \\d{1,2}|o (?:p[óo][łl]nocy|godzinie|godz)|za (?:\\d{1,3}|godzin[ęe]|tydzie[ńn]|miesi[ąa]c|chwil[ęe]|minut[ęe]|kwadrans|kilka|par[ęe]|p[óo][łl]|dwie|dwa|trzy|pi[ęe][ćc]|dziesi[ęe][ćc])|w (?:poniedzia[łl]ek|wtorek|[śs]rod[ęe]|czwartek|pi[ąa]tek|sobot[ęe]|niedziel[ęe]|weekend|przysz[łl]\\p{L}{1,3})|we (?:wtorek|[śs]rod[ęe]|czwartek)|codziennie|co (?:dzie[ńn]|tydzie[ńn]|miesi[ąa]c|rano|wiecz[óo]r|godzin[ęe]|\\d{1,3})|ka[żz]dego|ka[żz]dej|w ka[żz]d\\p{L}{1,2}|przed(?! (?:jak\\p{L}{1,3}|kt[óo]r\\p{L}{1,3}|czym|kim|kiedy|ilu))|p[óo][źz]niej|wkr[óo]tce|nied[łl]ugo|nast[ęe]pnego|na jutro|\\d{1,2}[./]\\d{1,2}|o (?:spotkaniu|wizycie|terminie|p[łl]atno[śs]ci|rachunku|rachunkach|lekach|leku|tabletkach|urodzinach|imieninach|rocznicy|telefonie|egzaminie|kolokwium|zebraniu|deadlinie|op[łl]acie|racie|czynszu|przelewie|fakturze|podatku|treningu|zaj[ęe]ciach|lekcji|wydarzeniu|webinarze|rozmowie|odbiorze|przegl[ąa]dzie|ubezpieczeniu|denty[śs]cie|lekarzu)|o (?:(?!kt[óo]r\\p{L}{1,3}(?![\\p{L}]))[^.?!\\n]|(?<=\\d)[.,](?=\\d)){1,60}?(?:jutro|pojutrze|dzi[śs]|dzisiaj|wieczorem|rano|po po[łl]udniu|o \\d{1,2}|za \\d{1,3}|za (?:godzin[ęe]|tydzie[ńn]|miesi[ąa]c)|w (?:poniedzia[łl]ek|wtorek|[śs]rod[ęe]|czwartek|pi[ąa]tek|sobot[ęe]|niedziel[ęe]|weekend|przysz[łl]\\p{L}{1,3})|codziennie|co (?:dzie[ńn]|tydzie[ńn]|miesi[ąa]c|rano)|ka[żz]dego|w ka[żz]d\\p{L}{1,2}|\\d{1,2}[./]\\d{1,2}))",
      "(?:ustaw|dodaj|stw[óo]rz|utw[óo]rz|zr[óo]b|zaplanuj|za[łl][óo][żz]|(?:mo[żz]esz|m[óo]g[łl]by[śs]|mog[łl]aby[śs]|prosz[ęe]) (?:mi )?(?:ustawi[ćc]|doda[ćc]|stworzy[ćc]|utworzy[ćc]|zrobi[ćc]|zaplanowa[ćc]))(?: mi)? (?:codzienne |cotygodniowe |comiesi[ęe]czne |cykliczne |nowe |sta[łl]e )?(?:przypomnienie|automatyzacj[ęe]|zadanie cykliczne|cykliczne zadanie)",
      "(?:powiadom|powiadamiaj|zawiadom|zawiadamiaj|(?:mo[żz]esz|m[óo]g[łl]by[śs]|mog[łl]aby[śs]|prosz[ęe]) (?:mnie )?(?:powiadomi[ćc]|powiadamia[ćc]|zawiadomi[ćc]))(?: mnie| nas)?,? (?:gdy|gdyby|kiedy|jak|je[śs]li|je[żz]eli|jakby|w momencie|natychmiast|od razu)",
      // "Daj mi znać, gdy bitcoin spadnie poniżej…", not "Daj mi znać, jeśli masz pytania", "Powiedz mi,
      // kiedy upadł mur berliński" or "Napisz mi, kiedy wyjdzie GTA 6" (a date: "napisz mi, kiedy" only
      // with a price to watch).
      "(?:(?:daj|dawaj|dajcie) (?:mi |nam )?zna[ćc]|poinformuj mnie|informuj mnie|napisz do mnie|napisz mi(?=,? (?:prosz[ęe],? )?(?!kiedy(?! tylko)(?![\\p{L}])))|wy[śs]lij mi (?:wiadomo[śs][ćc]|powiadomienie|maila)|(?:mo[żz]esz|m[óo]g[łl]by[śs]|mog[łl]aby[śs]|prosz[ęe]) (?:mi )?(?:da[ćc] zna[ćc]|dawa[ćc] zna[ćc])|powiedz mi,? (?=gdy|jak tylko|kiedy tylko|w momencie))(?: prosz[ęe])?,? (?:gdy|gdyby|jak|kiedy tylko|kiedy|je[śs]li|je[żz]eli|w momencie,? gdy)(?![\\p{L}])(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:spadnie|spadn[ąa]|wzro[śs]nie|wzrosn[ąa]|przekroczy|przebije|osi[ąa]gnie|wyjdzie|wyjd[ąa]|pojawi si[ęe]|pojawi[ąa] si[ęe]|b[ęe]dzie (?:dost[ęe]pn\\p{L}{1,3}|w sprzeda[żz]y|na promocji|w promocji|taniej|ta[ńn]sz\\p{L}{1,3}|ni[żz]sz\\p{L}{1,3}|wy[żz]sz\\p{L}{1,3}|mo[żz]na (?:kupi[ćc]|zam[óo]wi[ćc]))|b[ęe]d[ąa] (?:dost[ęe]pne|w sprzeda[żz]y|na promocji|ta[ńn]sze)|zostanie (?:wydan|og[łl]oszon|opublikowan|wypuszczon|zaprezentowan)\\p{L}{1,2}|zostan[ąa] (?:wydane|og[łl]oszone|opublikowane)|uka[żz]e si[ęe]|uka[żz][ąa] si[ęe]|(?:trafi|trafi[ąa]|wr[óo]ci|wr[óo]c[ąa]) do sprzeda[żz]y|(?:wejdzie|wejd[ąa]) (?:do sprzeda[żz]y|na rynek)|stanieje|staniej[ąa]|potanieje|potaniej[ąa]|podro[żz]eje|podro[żz]ej[ąa]|ruszy|rusz[ąa]|wystartuje|wystartuj[ąa]|zacznie si[ęe]|zaczn[ąa] si[ęe]|rozpocznie si[ęe]|rozpoczn[ąa] si[ęe]|premiera|poni[żz]ej|powy[żz]ej|ponad \\d{1,9}|pod \\d{1,9}|na stanie|og[łl]osz[ąa]|og[łl]osi|opublikuj[ąa]|opublikuje|wypuszcz[ąa]|wypu[śs]ci|obni[żz][ąa]|obni[żz]y)",
      "napisz mi(?: prosz[ęe])?,? kiedy (?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:spadnie|spadn[ąa]|wzro[śs]nie|wzrosn[ąa]|przekroczy|przebije|osi[ąa]gnie|stanieje|staniej[ąa]|potanieje|potaniej[ąa]|podro[żz]eje|podro[żz]ej[ąa]|b[ęe]dzie (?:taniej|ta[ńn]sz\\p{L}{1,3}|ni[żz]sz\\p{L}{1,3}|wy[żz]sz\\p{L}{1,3}|na promocji|w promocji)|poni[żz]ej|powy[żz]ej|ponad \\d{1,9}|pod \\d{1,9}|obni[żz][ąa]|obni[żz]y)",
      "(?<=^|,\\s{0,2})(?:gdy|kiedy|jak tylko|jak|je[śs]li|je[żz]eli|gdyby) (?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:spadnie|spadn[ąa]|wzro[śs]nie|wzrosn[ąa]|przekroczy|przebije|osi[ąa]gnie|wyjdzie|wyjd[ąa]|pojawi si[ęe]|pojawi[ąa] si[ęe]|b[ęe]dzie (?:dost[ęe]pn\\p{L}{1,3}|w sprzeda[żz]y|na promocji|w promocji|taniej|ta[ńn]sz\\p{L}{1,3}|ni[żz]sz\\p{L}{1,3}|wy[żz]sz\\p{L}{1,3}|mo[żz]na (?:kupi[ćc]|zam[óo]wi[ćc]))|b[ęe]d[ąa] (?:dost[ęe]pne|w sprzeda[żz]y|na promocji|ta[ńn]sze)|zostanie (?:wydan|og[łl]oszon|opublikowan|wypuszczon|zaprezentowan)\\p{L}{1,2}|zostan[ąa] (?:wydane|og[łl]oszone|opublikowane)|uka[żz]e si[ęe]|uka[żz][ąa] si[ęe]|(?:trafi|trafi[ąa]|wr[óo]ci|wr[óo]c[ąa]) do sprzeda[żz]y|(?:wejdzie|wejd[ąa]) (?:do sprzeda[żz]y|na rynek)|stanieje|staniej[ąa]|potanieje|potaniej[ąa]|podro[żz]eje|podro[żz]ej[ąa]|ruszy|rusz[ąa]|wystartuje|wystartuj[ąa]|zacznie si[ęe]|zaczn[ąa] si[ęe]|rozpocznie si[ęe]|rozpoczn[ąa] si[ęe]|premiera|poni[żz]ej|powy[żz]ej|ponad \\d{1,9}|pod \\d{1,9}|na stanie|og[łl]osz[ąa]|og[łl]osi|opublikuj[ąa]|opublikuje|wypuszcz[ąa]|wypu[śs]ci|obni[żz][ąa]|obni[żz]y)(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,30}?(?:daj (?:mi )?zna[ćc]|powiadom|poinformuj|napisz (?:do mnie|mi)|wy[śs]lij mi)",
      "automatycznie (?:codziennie|co (?:dzie[ńn]|tydzie[ńn]|miesi[ąa]c|rano|wiecz[óo]r|godzin[ęe]|\\d{1,3})|ka[żz]dego|w ka[żz]d\\p{L}{1,2}|wysy[łl]aj|przysy[łl]aj|sprawdzaj|przypominaj|informuj|powiadamiaj|r[óo]b|tw[óo]rz|generuj|publikuj|aktualizuj|zbieraj|monitoruj|pisz)",
      "(?:zautomatyzuj|automatyzuj)(?: (?:to|t[ęe]|ten|go|je))?(?: dla mnie)?(?: prosz[ęe])?$",
      "(?:mo[żz]esz|m[óo]g[łl]by[śs]|mog[łl]aby[śs]|dasz rad[ęe]|prosz[ęe])(?: mi)?(?: to)? zautomatyzowa[ćc](?: to)?$",
      "(?:wysy[łl]aj|przysy[łl]aj|podsy[łl]aj|przesy[łl]aj|wy[śs]lij|przy[śs]lij|prze[śs]lij|pode[śs]lij|dawaj|r[óo]b|przygotowuj|tw[óo]rz|pisz)(?: mi| nam)? (?:codzienn|cotygodniow|comiesi[ęe]czn|tygodniow|miesi[ęe]czn|dzienn|porann|wieczorn|regularn|cykliczn)\\p{L}{1,3} (?:[\\p{L}-]{1,20} )?(?:podsumowani|raport|przegl[ąa]d|zestawieni|newsletter|wiadomo[śs]|informacj|aktualizacj|powiadomieni|przypomnieni|prognoz|horoskop|cytat|news|briefing|streszczeni|alert|porad|wskaz[óo]wk|[żz]art|ciekawostk|s[łl][óo]wk|motywacj)\\p{L}{0,4}",
    ]),
    // A question ("Ile wody pić codziennie?", "Powiedz mi, co jeść codziennie") or how often.
    not: new RegExp(
      "^(?:ile|dlaczego|czemu|po co|jak(?! tylko)|jaki|jaka|jakie|jakich|jakim|kiedy|gdzie|kto|kt[óo]ry|kt[óo]ra|kt[óo]re|co(?! (?:dzie[ńn]|tydzie[ńn]|miesi[ąa]c|roku|rano|wiecz[óo]r|noc|godzin[ęe]|p[óo][łl]|weekend|poniedzia[łl]ek|wtorek|[śs]rod[ęe]|czwartek|pi[ąa]tek|sobot[ęe]|niedziel[ęe]|\\d|dwa|dwie|trzy|cztery|pi[ęe][ćc]|sze[śs][ćc]|kilka|par[ęe])))(?![\\p{L}\\p{N}])|^czy(?! (?:mo[żz]esz|mo[żz]ecie|m[óo]g[łl]by[śs]|mog[łl]aby[śs]|m[óo]g[łl]by|mog[łl]aby|mogliby[śs]cie|dasz|potrafisz|b[ęe]dziesz|zechcesz))(?![\\p{L}])|(?<![\\p{L}])(?:jak cz[ęe]sto|ile razy|(?:dobry|z[łl]y|g[łl]upi|dobrym|z[łl]ym) pomys[łl]|dlaczego|czemu|korzy[śs]ci|korzy[śs][ćc]|zalety|wady|plusy i minusy|skutki|wp[łl]yw|powinienem|powinnam|powinno si[ęe]|powinni[śs]my|czy (?:to )?(?:jest )?(?:dobrze|[źz]le|zdrowo|normalne|normalnie|bezpiecznie|bezpieczne|warto|mo[żz]na|trzeba|nale[żz]y|szkodliwe|zdrowe|dobre|z[łl]e)|jak (?:mog[ęe]|mo[żz]na|mam|przesta[ćc]|ustawi[ćc]|zrobi[ćc]|nauczy[ćc]|zmusi[ćc]|zacz[ąa][ćc]|pozby[ćc]|ograniczy[ćc])|jak (?:\\p{L}{1,12} ){0,2}\\p{L}{1,20}(?:[aiyuą][ćc]|eć|[eaąęj](?:ść|sc)|[ie](?:źć|zc)|[óo]c|iec)|ile (?:\\p{L}{1,15} ){0,3}?(?:trzeba|nale[żz]y|mog[ęe]|mo[żz]na|pi[ćc]|je[śs][ćc]|spalam|spali[ćc]|kalorii|wody|bia[łl]ka|krok[óo]w)|co (?!(?:dzie[ńn]|tydzie[ńn]|miesi[ąa]c|roku|rano|wiecz[óo]r|noc|godzin[ęe]|p[óo][łl]|weekend|poniedzia[łl]ek|wtorek|[śs]rod[ęe]|czwartek|pi[ąa]tek|sobot[ęe]|niedziel[ęe]|\\d{1,3})(?![\\p{L}]))(?:\\p{L}{1,12} )?(?:je[śs][ćc]|zje[śs][ćc]|pi[ćc]|wypi[ćc]|[ćc]wiczy[ćc]|robi[ćc]|ugotowa[ćc]|gotowa[ćc]|ubra[ćc]|za[łl]o[żz]y[ćc]))(?![\\p{L}])",
      "iu",
    ),
    // A habit between them ("W każdy poniedziałek chodzę na siłownię, daj mi plan", "Mąż codziennie gra
    // na konsoli, napisz…", "ciasto które piekę w każdą niedzielę"), a plan, code or translation the
    // schedule is part of ("Ułóż mi plan treningowy w poniedziałki", "Napisz skrypt do backupu co noc",
    // "Przetłumacz na angielski codziennie piję kawę"), the schedule in a clause of what to write ("Napisz
    // post o tym, jak codziennie medytować") or a statement ("Codziennie to samo, pokaż mi…").
    between: new RegExp(
      "(?<![\\p{L}])(?<!(?:^|[^\\p{L}])(?:gdy|kiedy|jak|zanim|p[óo]ki|dop[óo]ki|a[żz]|je[śs]li|je[żz]eli|bo)(?: \\p{L}{1,10})? )(?:sprawdzam|[ćc]wicz[ęe]|biegam|chodz[ęe]|jem|pij[ęe]|pracuj[ęe]|ucz[ęe] si[ęe]|wstaj[ęe]|budz[ęe] si[ęe]|[śs]pi[ęe]|czytam|ogl[ąa]dam|robi[ęe]|mam|jestem|musz[ęe]|chc[ęe]|lubi[ęe]|staram si[ęe]|pr[óo]buj[ęe]|je[żz]d[żz][ęe]|bior[ęe]|wydaj[ęe]|zarabiam|czuj[ęe]|p[łl]ac[ęe]|pisz[ęe]|dostaj[ęe]|pal[ęe]|gotuj[ęe]|medytuj[ęe]|trenuj[ęe]|spaceruj[ęe]|chodzimy|je[źz]dzimy|jemy|pijemy|mamy|robimy|idziemy|jedziemy|gramy|[ćc]wiczymy|biegamy|pracujemy|uczymy si[ęe]|ogl[ąa]damy|gotujemy|spotykamy si[ęe]|wydajemy|mog[ęe]|zwykle|zazwyczaj|zawsze|cz[ęe]sto|plan|planu|grafik|harmonogram|rozk[łl]ad|jad[łl]ospis|menu|diet[ęe]|program|godziny otwarcia|otwarte|otwarty|otwarta|czynne|czynny|czynna|zamkni[ęe]te|zamkni[ęe]ty|jest|s[ąa]|u nas|u mnie|odbywa si[ęe]|odbywaj[ąa] si[ęe]|ogl[ąa]da|ogl[ąa]daj[ąa]|chodzi|chodz[ąa]|pije|pij[ąa]|[śs]pi|[śs]pi[ąa]|pracuje|pracuj[ąa]|dzwoni|dzwoni[ąa]|pisze|pisz[ąa]|m[óo]wi|m[óo]wi[ąa]|robi|robi[ąa]|wstaje|wstaj[ąa]|biega|biegaj[ąa]|czyta|czytaj[ąa]|je[źz]dzi|je[żz]d[żz][ąa]|spaceruje|p[łl]acze|choruje|prosi|narzeka|narzekaj[ąa]|przychodzi|przychodz[ąa]|jedz[ąa]|budzi|budz[ąa]|krzyczy|gotuje|gotuj[ąa]|[ćc]wiczy|[ćc]wicz[ąa]|trenuje|trenuj[ąa]|uczy si[ęe]|ucz[ąa] si[ęe]|sp[óo][źz]nia si[ęe]|pyta|pytaj[ąa]|gra|graj[ąa]|kt[óo]r(?:y|a|e|ego|ej|emu|ym|[ąa]|ych|zy|ymi)|skrypt|skryptu|kod|kodu|funkcj[ęe]|funkcji|crona?|bota?|makro|zapytanie|na (?:angielski|polski|niemiecki|francuski|hiszpa[ńn]ski|w[łl]oski|rosyjski|ukrai[ńn]ski|czeski|japo[ńn]ski|chi[ńn]ski|portugalski)|po (?:angielsku|polsku|niemiecku|francusku|hiszpa[ńn]sku|w[łl]osku|rosyjsku|ukrai[ńn]sku))(?![\\p{L}])|^\\s{1,3}(?:nowy|nowa|nowe|nowi|ten sam|ta sama|to samo|te same)(?![\\p{L}])[^,–—]{0,40}(?:,|\\s[-–—]\\s)|(?<![\\p{L}])(?:[żz]e|[żz]eby|aby|bo|poniewa[żz]|kt[óo]ry|kt[óo]ra|kt[óo]re|kt[óo]rzy|kt[óo]rych|gdzie|jak|jakie|jaki|jaka|czy|kiedy|gdy|je[śs]li|je[żz]eli|ile)(?: (?:ja|my|ty|on|ona|oni|si[ęe]|mi|mnie))?\\s{1,3}$",
      "iu",
    ),
  },
  ro: {
    recur: B([
      // "un meniu pentru fiecare zi a săptămânii", "câte zile are fiecare lună", "Fiecare zi contează": not schedules.
      "(?<!(?<![\\p{L}])(?:pentru|pt|are|au|din) )(?:(?:[iî]n )?fiecare|la fiecare) (?:zi|diminea[tțţ][aă]|dup[aă][- ]amiaz[aă]|sear[aă]|noapte|s[aă]pt[aă]m[aâ]n[aă]|lun[aă]|an|or[aă]|jum[aă]tate de or[aă]|luni|mar[tțţ]i|miercuri|joi|vineri|s[aâ]mb[aă]t[aă]|duminic[aă]|weekend|zi lucr[aă]toare|\\d{1,3} (?:minute|ore|zile|s[aă]pt[aă]m[aâ]ni|luni)|(?:dou[aă]|trei|patru|cinci|[sșş]ase|zece|cincisprezece) (?:ore|zile|s[aă]pt[aă]m[aâ]ni|luni)|c[aâ]teva (?:ore|zile))(?: [sșş]i (?:luni|mar[tțţ]i|miercuri|joi|vineri|s[aâ]mb[aă]t[aă]|duminic[aă]))?(?! a (?:s[aă]pt[aă]m[aâ]nii|lunii)(?![\\p{L}])| din(?![\\p{L}])| (?:conteaz[aă]|este|aduce|[iî]nseamn[aă])(?![\\p{L}]))(?: (?:la|pe la|[iî]nainte de|dup[aă]|de la) (?:ora )?\\d{1,2}(?:[:.]\\d{2})?| la pr[aâ]nz| la miezul nop[tțţ]ii| diminea[tțţ]a| seara| (?:de|la) diminea[tțţ][aă]| devreme| fix){0,3}",
      // "Zilnic la 8, …" or "trimite-mi știrile zilnic", never "raportul zilnic" or "bugetul meu lunar".
      "(?<=^|[,;]\\s{0,2})(?:zilnic|s[aă]pt[aă]m[aâ]nal)(?: (?:la|pe la) (?:ora )?\\d{1,2}(?:[:.]\\d{2})?| diminea[tțţ]a| seara){0,2}",
      "(?<=\\p{L}(?:le|ea|ia) )(?:zilnic|s[aă]pt[aă]m[aâ]nal)(?=\\s{0,3}(?:$|[,.!?;)]|(?:la|pe|[iî]n|[sșş]i|te rog|diminea[tțţ]a|seara)(?![\\p{L}])))",
      // "Lunea la 8, …": on Mondays, said where it says when.
      "(?<=^|[,;]\\s{0,2})(?:lunea|mar[tțţ]ea|miercurea|joia|vinerea|s[aâ]mb[aă]ta|duminica)(?=\\s{0,3}(?:,|la (?:ora )?\\d|diminea[tțţ]a|seara|devreme))(?: (?:la|pe la) (?:ora )?\\d{1,2}(?:[:.]\\d{2})?| diminea[tțţ]a| seara){0,2}",
      "(?<=^|[,;]\\s{0,2})de luni p[aâ]n[aă] vineri",
      "o dat[aă] pe (?:zi|s[aă]pt[aă]m[aâ]n[aă]|lun[aă]|or[aă])|de (?:dou[aă]|trei|\\d{1,2}) ori pe (?:zi|s[aă]pt[aă]m[aâ]n[aă]|lun[aă])",
      // "Every morning trimite-mi știrile".
      EN_EVERY[0],
    ]),
    act: B([
      "(?:trimite|trimite[tțţ]i|spune|spune[tțţ]i|aminte[sșş]te|aminti[tțţ]i|reaminte[sșş]te|scrie|scrie[tțţ]i|face[tțţ]i|arat[aă]|ar[aă]ta[tțţ]i|caut[aă]|c[aă]uta[tțţ]i|g[aă]se[sșş]te|preg[aă]te[sșş]te|rezum[aă]|recomand[aă]|sugereaz[aă]|poveste[sșş]te|adu|explic[aă])(?:-|\\s)?(?:mi|ne)|(?:d[aă]|da[tțţ]i|f[aă]|zi)-(?:mi|ne)|d[aă]mi|f[aă]mi|zimi",
      "(?:anun[tțţ][aă]|anun[tțţ]a[tțţ]i|notific[aă]|notifica[tțţ]i|informeaz[aă]|informa[tțţ]i|[tțţ]ine|[tțţ]ine[tțţ]i|alerteaz[aă]|avertizeaz[aă])(?:-|\\s)?(?:m[aă]|ne)",
      "trimite|trimite[tțţ]i|verific[aă]|verifica[tțţ]i|caut[aă]|c[aă]uta[tțţ]i|rezum[aă]|scrie|scrie[tțţ]i|preg[aă]te[sșş]te|creeaz[aă]|genereaz[aă]|compar[aă]|analizeaz[aă]|monitorizeaz[aă]|urm[aă]re[sșş]te|listeaz[aă]|public[aă]|posteaz[aă]|repet[aă]|alege|g[aă]se[sșş]te|recomand[aă]|sugereaz[aă]|compileaz[aă]|adun[aă]|f[aă] (?:un|o|asta|acest|lista|aceea[sșş]i)|f[aă]-(?:o|l)",
      "s[aă]-?(?:mi|ne) (?:trimi[tțţ]i|trimite[tțţ]i|dai|da[tțţ]i|spui|spune[tțţ]i|aminte[sșş]ti|aminti[tțţ]i|scrii|scrie[tțţ]i|faci|face[tțţ]i|ar[aă][tțţ]i|ar[aă]ta[tțţ]i|cau[tțţ]i|g[aă]se[sșş]ti|preg[aă]te[sșş]ti|rezumi|recomanzi|aduci)|s[aă] (?:m[aă]|ne) (?:anun[tțţ]i|anun[tțţ]a[tțţ]i|notifici|informezi|[tțţ]ii la curent)",
      "s[aă] (?:verifici|verifica[tțţ]i|cau[tțţ]i|rezumi|scrii|faci|preg[aă]te[sșş]ti|creezi|generezi|compari|analizezi|monitorizezi|urm[aă]re[sșş]ti|publici|postezi|repe[tțţ]i|alegi|g[aă]se[sșş]ti|trimi[tțţ]i)",
      "[iî]mi (?:trimi[tțţ]i|dai|spui|aminte[sșş]ti|scrii|faci|ar[aă][tțţ]i|preg[aă]te[sșş]ti|g[aă]se[sșş]ti|recomanzi|cau[tțţ]i)|m[aă] (?:anun[tțţ]i|notifici|informezi|[tțţ]ii la curent)",
      "(?:(?:[iî]mi|ne|m[aă]) )?(?:po[tțţ]i|pute[tțţ]i|ai putea|a[tțţ]i putea) (?:trimite|da|spune|aminti|scrie|face|ar[aă]ta|c[aă]uta|g[aă]si|preg[aă]ti|rezuma|verifica|crea|genera|compara|analiza|monitoriza|urm[aă]ri|publica|posta|repeta|alege|anun[tțţ]a|notifica|[tțţ]ine|recomanda)",
      // "Vreau să primesc știrile…", not "Vreau să primesc lecții de chitară în fiecare săptămână".
      "(?:vreau|a[sș] vrea|a[sș] dori|doresc|mi-ar pl[aă]cea) s[aă] primesc(?! (?:lec[tțţ]ii|cursuri|terapie|tratament|tratamente|vizite|masaj|masaje|ajutor|[sșş]edin[tțţ]e|medita[tțţ]ii)(?![\\p{L}]))",
    ]),
    strong: B([
      // "Amintește-mi să plătesc factura", not "Amintește-mi intriga din Hamlet" or "Melodia asta îmi amintește de
      // copilărie".
      "(?:(?:aminte[sșş]te|aminti[tțţ]i|reaminte[sșş]te|reaminti[tțţ]i)(?:-|\\s)?(?:mi|ne)|adu-?mi aminte|s[aă]-?mi (?:aminte[sșş]ti|aminti[tțţ]i|reaminte[sșş]ti)|[iî]mi (?:aminte[sșş]ti|po[tțţ]i aminti|pute[tțţ]i aminti|ai putea aminti)) (?:s[aă]|c[aă]|(?:de|despre) (?!ce |cine |cum |c[aâ]nd |care )[^.?!\\n]{1,50}? (?:m[aâ]ine|poim[aâ]ine|disear[aă]|ast[aă]zi|azi|la ora|la \\d|(?<!\\d )luni|mar[tțţ]i|miercuri|joi|vineri|s[aâ]mb[aă]t[aă]|duminic[aă]|[iî]n fiecare|s[aă]pt[aă]m[aâ]na viitoare|peste \\d)|m[aâ]ine|poim[aâ]ine|disear[aă]|ast[aă]zi|azi|ast[aă] sear[aă]|peste \\d|peste o (?:or[aă]|zi|s[aă]pt[aă]m[aâ]n[aă])|[iî]n \\d{1,3} (?:minute|ore|zile)|la ora|la \\d|luni|mar[tțţ]i|miercuri|joi|vineri|s[aâ]mb[aă]t[aă]|duminic[aă]|[iî]n fiecare|la fiecare|zilnic|s[aă]pt[aă]m[aâ]na viitoare|luna viitoare|mai t[aâ]rziu|diminea[tțţ][aă]|[iî]nainte de|dup[aă])",
      "(?:seteaz[aă]|seta[tțţ]i|creeaz[aă]|crea[tțţ]i|pune|pune[tțţ]i|f[aă]|programeaz[aă]|adaug[aă]|activeaz[aă])(?:-mi)?(?: te rog)? (?:un |o )?(?:nou |nou[aă] )?(?:memento|reminder|alarm[aă]|automatizare|sarcin[aă] recurent[aă])",
      // "Trimite-mi un memento să beau apă la fiecare oră".
      "trimite(?:-|\\s)?(?:mi|ne)(?: te rog)? (?:un |o )?(?:memento|reminder|alarm[aă]) (?:s[aă]|c[aă]|[iî]n fiecare|la fiecare|zilnic|m[aâ]ine|disear[aă]|la ora|peste)",
      "(?:po[tțţ]i|pute[tțţ]i|ai putea) (?:s[aă](?:-mi)? )?(?:setezi|seta|creezi|crea|pui|pune|faci|face|programezi|programa|adaugi|ad[aă]uga) (?:un |o )?(?:memento|reminder|alarm[aă]|automatizare)",
      // "Anunță-mă când apare noul iPhone / dacă bitcoin scade sub 50.000", not "anunță-mă dacă ai nevoie de ceva" or
      // "Spune-mi când a căzut Zidul Berlinului".
      "(?:(?:anun[tțţ][aă]|anun[tțţ]a[tțţ]i|notific[aă]|notifica[tțţ]i|alerteaz[aă]|avertizeaz[aă])(?:-|\\s)?(?:m[aă]|ne)|scrie(?:-|\\s)?mi|s[aă] (?:m[aă]|ne) (?:anun[tțţ]i|anun[tțţ]a[tțţ]i|notifici|alertezi)|m[aă] (?:anun[tțţ]i|notifici)|(?:m[aă] )?(?:po[tțţ]i|pute[tțţ]i|ai putea) (?:anun[tțţ]a|notifica)|d[aă]-?mi de [sșş]tire) (?:c[aâ]nd|imediat ce|de [iî]ndat[aă] ce|cum|dac[aă]|[iî]n momentul [iî]n care|oric[aâ]nd)[^.?!\\n]{0,60}? (?:scade|scad|cre[sșş]te|cresc|coboar[aă]|apare|apar|iese|ies|se lanseaz[aă]|lanseaz[aă]|(?:e|este|va fi|devine) disponibil[aăe]?|revine [iî]n stoc|(?:e|este) (?:[iî]n stoc|la reducere|mai ieftin[aă]?)|intr[aă] la reducere|ajunge (?:la|sub|peste)|dep[aă][sșş]e[sșş]te|se ieftine[sșş]te|se schimb[aă]|va ap[aă]rea|va ie[sșş]i|va sc[aă]dea|va cre[sșş]te|se anun[tțţ][aă]|(?:e|este|va fi) (?:anun[tțţ]at|lansat|publicat)[aă]?|se public[aă]|o s[aă] (?:apar[aă]|ias[aă]|scad[aă]|creasc[aă])|se pun? [iî]n v[aâ]nzare|(?:e|este|sunt|vor fi|va fi) [iî]n v[aâ]nzare|[iî]ncepe|va [iî]ncepe|joac[aă]|va juca)",
      "(?:(?:spune|spune[tțţ]i)(?:-|\\s)?(?:mi|ne)|zi-?mi|s[aă]-?mi spui|[iî]mi spui) (?:c[aâ]nd|imediat ce|de [iî]ndat[aă] ce)[^.?!\\n]{0,60}? (?:apare|iese|se lanseaz[aă]|va ap[aă]rea|va ie[sșş]i|va fi (?:disponibil|lansat|anun[tțţ]at)[aă]?|va sc[aă]dea|va cre[sșş]te|o s[aă] (?:apar[aă]|ias[aă]|scad[aă]|creasc[aă])|(?:e|este|devine) disponibil[aăe]?|revine [iî]n stoc|intr[aă] la reducere|scade sub|cre[sșş]te peste|ajunge (?:la|sub|peste)|dep[aă][sșş]e[sșş]te|se ieftine[sșş]te)",
      // "automat" is also a vending machine ("automat de cafea"): only with a request.
      "(?:trimite(?:-|\\s)?(?:mi|ne)|aminte[sșş]te(?:-|\\s)?mi|verific[aă]|f[aă] asta|f[aă]-(?:o|l)|ruleaz[aă]|public[aă]|posteaz[aă])(?: [^\\s.?!,]{1,15}){0,3}? (?<!\\s(?:e|este|sunt|fi|era|devine) )(?:automat|[iî]n mod automat)(?! de(?![\\p{L}]))",
      "(?:automat|[iî]n mod automat) (?:[iî]n fiecare|la fiecare|zilnic|s[aă]pt[aă]m[aâ]nal|trimite(?:-|\\s)?mi|aminte[sșş]te(?:-|\\s)?mi)",
      "automatizeaz[aă](?: asta| acest lucru| procesul| sarcina asta|-o|-l)?(?: pentru mine)?(?: te rog)?$",
      "(?:po[tțţ]i|pute[tțţ]i|ai putea) (?:s[aă] )?automatiz(?:a|ezi|a[tțţ]i)(?: asta| acest lucru| procesul|-o)?(?: pentru mine)?(?: te rog)?$",
      // "Trimite-mi știrile zilnic", "verifică săptămânal prețul": the adverb right after the request.
      "(?:(?:trimite|spune|aminte[sșş]te|scrie|arat[aă]|caut[aă]|preg[aă]te[sșş]te|rezum[aă])(?:-|\\s)?(?:mi|ne)|(?:d[aă]|f[aă]|zi)-?(?:mi|ne)|verific[aă]|caut[aă]|rezum[aă]|monitorizeaz[aă]|urm[aă]re[sșş]te|trimite|scrie|posteaz[aă]|public[aă]|s[aă]-?(?:mi|ne) (?:trimi[tțţ]i|trimite[tțţ]i|spui|spune[tțţ]i|scrii|scrie[tțţ]i|faci|face[tțţ]i|dai|da[tțţ]i|ar[aă][tțţ]i|aminte[sșş]ti)|[iî]mi (?:trimi[tțţ]i|spui|scrii|faci|dai)|s[aă] (?:verifici|verifica[tțţ]i|cau[tțţ]i|monitorizezi|urm[aă]re[sșş]ti|trimi[tțţ]i|postezi)) (?:zilnic|s[aă]pt[aă]m[aâ]nal|lunar)(?![\\p{L}])",
      // "Trimite-mi un rezumat săptămânal", not "Dă-mi raportul lunar".
      "(?:trimite(?:-|\\s)?(?:mi|ne))(?: (?:un|o|ni[sșş]te))?(?: (?!(?:raportul|rezumatul|buletinul|bugetul|programul)\\s)\\p{L}{1,15})? (?:rezumat|rezumate|raport|rapoarte|buletin|update|actualizare|actualiz[aă]ri|newsletter|digest|sintez[aă]|memento|reminder|[sșş]tiri|nout[aă][tțţ]i|sfat|sfaturi|citat|citate|banc|glum[aă]|horoscop|prognoz[aă]|alert[aă]|alerte|e-?mail|mesaj) (?:zilnic[aăe]?|s[aă]pt[aă]m[aâ]nal[aăe]?|lunar[aăe]?)(?! de (?:exemplu|prob[aă]|test)| model)",
      "(?:(?:d[aă]|f[aă])-?(?:mi|ne)|preg[aă]te[sșş]te(?:-|\\s)?mi|vreau|a[sș] vrea|a[sș] dori|doresc)(?: (?:un|o|ni[sșş]te))?(?: (?!(?:raportul|rezumatul|buletinul|bugetul|programul)\\s)\\p{L}{1,15})? (?:rezumat|buletin|newsletter|digest|sintez[aă]|memento|reminder|[sșş]tiri|nout[aă][tțţ]i|sfat|sfaturi|citat|citate|banc|glum[aă]|horoscop|prognoz[aă]|alert[aă]|alerte) (?:zilnic[aăe]?|s[aă]pt[aă]m[aâ]nal[aăe]?|lunar[aăe]?)(?! de (?:exemplu|prob[aă]|test)| model)",
    ]),
    // How often, why, benefits, is it good to, how do I, what happens if, a habit.
    not: B([
      "c[aâ]t de des|de c[aâ]te ori|la c[aâ]t timp|c[aâ]t de frecvent",
      "de ce",
      "beneficii(?:le)?|avantaje(?:le)?|dezavantaje(?:le)?|pro [sșş]i contra|efecte(?:le)?|riscuri(?:le)?",
      "(?:e|este|ar fi|va fi) (?:bine|r[aă]u|normal|s[aă]n[aă]tos|recomandat|necesar|periculos|mai bine|adev[aă]rat|corect|gre[sșş]it|grav)",
      "cum (?:pot|fac|s[aă]|se|setez|opresc|renun[tțţ]|creez|activez|dezactivez|scap|evit|pun)",
      "ce se (?:[iî]nt[aâ]mpl[aă]|va [iî]nt[aâ]mpla) dac[aă]",
      // "În fiecare luni merg la sală, dă-mi un program": a habit, then a one-off ask.
      "(?:(?:[iî]n )?fiecare|la fiecare|zilnic|lunea|mar[tțţ]ea|miercurea|joia|vinerea|s[aâ]mb[aă]ta|duminica) (?:\\p{L}{1,14} ){0,2}(?:(?:la|pe la|dup[aă]|[iî]nainte de) (?:ora )?(?:\\d{1,2}(?:[:.]\\d{2})?|\\p{L}{2,12}) )?(?:eu |noi |mereu )?(?:m[aă] |ne |[iî]mi |[iî]i |le |o |[iî]l )?(?:merg|mergem|duc|fac|facem|m[aă]n[aâ]nc|beau|iau|ies|citesc|uit|folosesc|cheltui|c[aâ][sșş]tig|pl[aă]tesc|ard|dorm|alerg|lucrez|lucr[aă]m|[iî]nv[aă][tțţ]|antrenez|trezesc|scol|verific|[iî]not|g[aă]tesc|rog|meditez|conduc|practic|primesc|simt|doare|[iî]nt[aâ]lnim|v[aă]d|vedem|scriu|trimit|sun|vorbesc|vizitez|cur[aă][tțţ]|duc|postez|cump[aă]r|preg[aă]tesc|ud)",
      // "Tata vine și verifică e-mailul în fiecare dimineață", "În fiecare noapte fiul meu se trezește la 3, dă-mi
      // niște sfaturi": someone else's habit.
      "(?<=^)(?:fiul|fiica|copilul|copiii|b[aă]iatul|fata|mama|tata|fratele|sora|so[tțţ]ul|so[tțţ]ia|[sșş]eful|[sșş]efa|bunica|bunicul|vecinul|vecina|prietenul|prietena|iubitul|iubita|colegul|colega|el|ea|ei|ele)(?= \\p{L})",
      "(?<=^)(?:(?:[iî]n )?fiecare|la fiecare) \\p{L}{2,12}(?: (?:la|pe la) (?:ora )?\\d{1,2}(?:[:.]\\d{2})?| diminea[tțţ]a| seara)?,? (?:fiul|fiica|copilul|copiii|b[aă]iatul|fata|mama|tata|fratele|sora|so[tțţ]ul|so[tțţ]ia|[sșş]eful|[sșş]efa|bunica|bunicul|vecinul|vecina|prietenul|prietena|iubitul|iubita|colegul|colega|c[aâ]inele|pisica|bebelu[sșş]ul)(?= \\p{L})",
      // "Spune-mi dacă în fiecare an trebuie să plătesc impozitul", "Spune-mi cine câștigă în fiecare an…": a question.
      "(?<=^)(?:spune(?:-|\\s)?mi|spune[tțţ]i(?:-|\\s)?mi|zi(?:-|\\s)?mi|[sșş]tii) (?:dac[aă]|cine)",
      // "Spune-mi ce înseamnă zilnic": the words themselves.
      "(?:[iî]nseamn[aă]|se spune|tradu(?:ce)?) (?:cuv[aâ]ntul )?(?:zilnic|s[aă]pt[aă]m[aâ]nal|lunar|[iî]n fiecare \\p{L}{2,10}|la fiecare \\p{L}{2,10})",
    ]),
    // "Spune-mi câte calorii ard în fiecare zi", "o rutină pe care s-o pot face", a past habit.
    between: B([
      "eu|noi|merg|mergem|m[aă] duc|fac|facem|m[aă]n[aâ]nc|beau|ies|dorm|alerg|ard|pot|trebuie s[aă]|ar trebui|m[aă] (?:trezesc|antrenez)|sun|scriu|trimit|vizitez|vorbesc|citesc",
      // "un medic care lucrează în fiecare noapte", "o farmacie deschisă în fiecare duminică", "exerciții de făcut în
      // fiecare dimineață": the schedule belongs to someone or something else.
      "(?<!(?<![\\p{L}])(?:spune-?mi|zi-?mi|spune[tțţ]i-?mi|arat[aă]-?mi|explic[aă]-?mi) )care (?:(?:se|m[aă]|te|ne|[iî]l|o|le|[iî]i) )?(?!(?:e|este|sunt|eu|tu|noi|voi|ei|ele)(?![\\p{L}]))(?!(?:apar|ies|public|schimb|cre[sșş]t|scad|lanseaz|vin)\\p{L}{0,4}(?![\\p{L}]))\\p{L}{1,15}(?:[aă]|e)",
      "deschis(?:[aă]|e|i)?|[iî]nchis(?:[aă]|e|i)?",
      "de (?:f[aă]cut|citit|m[aâ]ncat|v[aă]zut|b[aă]ut|ascultat|g[aă]tit|lucrat|[iî]nv[aă][tțţ]at|practicat|scris|repetat)|pentru a \\p{L}{2,15}",
      "(?:c[aă]|s[aă]|dac[aă]|c[aâ]nd|unde) (?:eu |noi |m[aă] |[iî]mi )?(?:pot|putem|trebuie|fac|facem|m[aă]n[aâ]nc|beau|iau|merg|folosesc|cheltui|c[aâ][sșş]tig|pl[aă]tesc|ard|dorm|alerg|lucrez|[iî]nv[aă][tțţ]|economisesc|investesc|citesc)",
      "eram|mergeam|f[aă]ceam|aveam|locuiam|obi[sșş]nuiam",
    ]),
    // "trimite", "verifică" is also "he sends / checks": a request counts at the start of the sentence or part,
    // after "te rog / poți / vreau să", or right after a schedule ("În fiecare luni verifică…").
    lead: new RegExp(
      `(?:^|[,;(]\\s{0,3}|(?<![\\p{L}])(?:te rog|v[aă] rog|pls|please|[sșş]i|apoi|de asemenea|acum|salut|bun[aă]|hei|hey|ok|okay|flash|deci|a[sșş]a c[aă]|doar|tu|dumneavoastr[aă]|po[tțţ]i|pute[tțţ]i|ai putea|a[tțţ]i putea|vreau|a[sș] vrea|a[sș] dori|doresc|mi-ar pl[aă]cea|[iî]ncearc[aă]|(?:po[tțţ]i|pute[tțţ]i|ai putea|a[tțţ]i putea|vreau|a[sș] vrea|a[sș] dori|doresc|te rog|v[aă] rog|mi-ar pl[aă]cea|[iî]ncearc[aă]|nu uita) s[aă]|nu uita|de azi(?: [iî]nainte)?|de acum (?:[iî]nainte|[iî]ncolo)|mereu|neap[aă]rat|(?:[iî]mi|ne|m[aă]) (?:po[tțţ]i|pute[tțţ]i|ai putea))\\s{1,3})(?:(?:(?:(?:[iî]n )?fiecare|la fiecare) (?:\\p{L}{2,12}|(?:\\d{1,3}|dou[aă]|trei|patru|cinci|[sșş]ase|zece|cincisprezece) \\p{L}{3,10}|jum[aă]tate de or[aă]|zi lucr[aă]toare)|${EN_EVERY[0]}|zilnic|s[aă]pt[aă]m[aâ]nal|lunar|lunea|mar[tțţ]ea|miercurea|joia|vinerea|s[aâ]mb[aă]ta|duminica|de luni p[aâ]n[aă] vineri|o dat[aă] pe \\p{L}{2,10}|de (?:dou[aă]|trei|\\d{1,2}) ori pe \\p{L}{2,10})(?: [sșş]i \\p{L}{3,10})?(?:\\s{1,3}(?:(?:la|pe la|[iî]nainte de|dup[aă]|de la) (?:ora )?\\d{1,2}(?:[:.]\\d{2})?|la pr[aâ]nz|la miezul nop[tțţ]ii|diminea[tțţ]a|seara|(?:de|la) diminea[tțţ][aă]|devreme|fix|neap[aă]rat)){0,3}\\s{1,3})?$`,
      "iu",
    ),
  },
  ru: {
    recur: B([
      // Not "за каждую неделю марта" or "на каждую неделю программы" (for each week).
      "(?:(?<!(?:^|[^\\p{L}])(?:на|для|за|по) )каждый (?:день|час|вечер|понедельник|вторник|четверг|месяц|год|будний день|рабочий день)(?! (?:рождения|недели|месяца|года|квартала|программы|курса|марафона|челленджа|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|этого|прошлого|текущего|\\d))|(?<!(?:^|[^\\p{L}])(?:на|для|за|по) )каждое (?:утро|воскресенье)(?! (?:рождения|недели|месяца|года|квартала|программы|курса|марафона|челленджа|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|этого|прошлого|текущего|\\d))|(?<!(?:^|[^\\p{L}])(?:на|для|за|по) )каждую (?:неделю|среду|пятницу|субботу|ночь|минуту)(?! (?:рождения|недели|месяца|года|квартала|программы|курса|марафона|челленджа|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|этого|прошлого|текущего|\\d))|(?<!(?:^|[^\\p{L}])(?:на|для|за|по) )каждые (?:\\d{1,3}|два|две|три|четыре|пять|шесть|несколько|пару)(?: (?:минут|минуты|часа|часов|дня|дней|недели|недель|месяца|месяцев|ч|мин))?|(?<!(?:^|[^\\p{L}])(?:на|для|за|по) )каждые (?:полчаса|выходные)|(?<!(?:^|[^\\p{L}])(?:на|для|за|по) )каждого месяца(?! (?:рождения|недели|месяца|года|квартала|программы|курса|марафона|челленджа|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|этого|прошлого|текущего|\\d))|ежедневно|еженедельно|ежемесячно|ежечасно|ежегодно|(?:раз|один раз|два раза|три раза|\\d{1,2} раза?) в (?:день(?! рожд)|неделю|месяц|час|год|сутки|полчаса|(?:два|три|\\d{1,2}) (?:дня|часа|недели))|по (?:понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям|утрам|вечерам|ночам|будням|выходным|будним дням|рабочим дням))(?: (?:в|к) \\d{1,2}(?:[:.]\\d{2})?(?: (?:утра|вечера|часов|ч))?| утром| вечером| дн[её]м| ночью| в обед| в полдень){0,2}",
    ]),
    act: B([
      // "пришли", "вышли", "перешли" and "шли" are also past tenses ("пришли новости"): only before "мне".
      "пришлите|пришли(?= (?:мне|нам|пожалуйста))|присылай(?:те)?|отправь(?:те)?|отправляй(?:те)?|скинь(?:те)?|скидывай(?:те)?|кидай(?:те)?|вышлите|вышли(?= (?:мне|нам))|высылай(?:те)?|шлите|шли(?= (?:мне|нам))|перешлите|перешли(?= (?:мне|нам))|пересылай(?:те)?",
      "напомни(?:те)?|напоминай(?:те)?|сообщи(?:те)?|сообщай(?:те)?|уведоми(?:те)?|уведомляй(?:те)?|оповести(?:те)?|оповещай(?:те)?|информируй(?:те)?|скажи(?:те)?|говори|расскажи(?:те)?|рассказывай(?:те)?|напиши(?:те)?|пиши(?:те)?|дай(?:те)? (?:мне |нам )?знать|давай(?:те)? (?:мне |нам )?знать|держи(?:те)? (?:меня |нас )?в курсе|дай(?:те)?|давай(?:те)? (?:мне|нам)|покажи(?:те)?|показывай(?:те)?|подбери(?:те)?|подбирай(?:те)?|предложи(?:те)?|предлагай(?:те)?|посоветуй(?:те)?|советуй(?:те)?|порекомендуй(?:те)?|рекомендуй(?:те)?",
      "проверь(?:те)?|проверяй(?:те)?|следи|отслеживай(?:те)?|отследи(?:те)?|мониторь(?:те)?|посмотри(?:те)?|чекай|чекни",
      "перечисли(?:те)?|подытожь(?:те)?|подытоживай(?:те)?|резюмируй(?:те)?|суммируй(?:те)?|обобщи(?:те)?|обобщай(?:те)?|перескажи(?:те)?|составь(?:те)?|составляй(?:те)?|собери(?:те)?|собирай(?:те)?",
      "найди(?:те)?|находи|ищи(?:те)?|поищи(?:те)?|исследуй(?:те)?|изучи(?:те)?|изучай(?:те)?|проанализируй(?:те)?|анализируй(?:те)?|сравни(?:те)?|сравнивай(?:те)?|переведи(?:те)?|переводи",
      "сочини(?:те)?|сочиняй(?:те)?|придумай(?:те)?|придумывай(?:те)?|создай(?:те)?|создавай(?:те)?|сгенерируй(?:те)?|генерируй(?:те)?|сделай(?:те)?|делай(?:те)?|подготовь(?:те)?|готовь(?:те)?|опубликуй(?:те)?|публикуй(?:те)?|выкладывай(?:те)?|выложи(?:те)?|повтори(?:те)?|повторяй(?:те)?",
      // "Можешь каждый день присылать мне…", "Хочу, чтобы ты напоминал мне…", "Хочу каждое утро получать…".
      "(?:можешь|можете|сможешь|сможете|мог бы|могла бы|могли бы|будешь|будете|прошу|будь (?:добр|добра|любезен|любезна)|будьте добры)(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,6}? (?:присылать|прислать|отправлять|отправить|скидывать|скинуть|кидать|кинуть|высылать|выслать|напоминать|напомнить|сообщать|сообщить|уведомлять|уведомить|оповещать|говорить|сказать|рассказывать|рассказать|писать|написать|проверять|проверить|следить|отслеживать|мониторить|делать|сделать|составлять|составить|собирать|собрать|искать|найти|давать|дать|показывать|показать|готовить|подготовить|генерировать|создавать|подбирать|подобрать|публиковать|переводить|анализировать|держать меня в курсе)",
      "(?:хочу|хотел бы|хотела бы|хотелось бы|нужно|надо),? чтобы? ты(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,5}? (?:присылал|отправлял|скидывал|кидал|высылал|напоминал|сообщал|уведомлял|говорил|рассказывал|писал|проверял|следил|отслеживал|делал|составлял|собирал|искал|давал|показывал|готовил|прислал|напомнил|проверил|сделал)а?",
      "(?:хочу|хотел бы|хотела бы|хотелось бы|хотим)(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,4}? получать",
    ]),
    strong: B([
      // "Напомни мне завтра позвонить маме", "… о встрече", not "Мама напомнила мне…", "Напомни сюжет
      // «Гамлета»", "… пять стадий…", "…, после какой битвы…", "…, раз в сколько лет…", "… про сериал,
      // который мы смотрели каждое воскресенье" or "Напомни, что такое фотосинтез" ("что" only before a
      // time, and not before a past tense: "…, что мы обсуждали сегодня").
      "(?:напомни(?:те)?|напоминай(?:те)?|напомнишь|не забудь(?:те)? напомнить|(?:можешь|можете|сможешь|сможете|мог бы|могла бы|могли бы|прошу|будешь|будете)(?: [^\\s.,!?;:]{1,15}){0,2}? (?:напомнить|напоминать))(?: мне| нам)?(?:,? пожалуйста)?,? (?:чтобы|о том,? чтобы|(?:что|о том,? что|про то,? что) (?!(?:я|мы|ты|вы|он|она|они)(?: \\p{L}{1,10})? \\p{L}{2,15}(?:л|ла|ли|ло|лся|лась|лись)(?![\\p{L}]))(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:завтра|сегодня|послезавтра|вечером|утром|через|в \\d{1,2}|в (?:понедельник|среду|пятницу|субботу|воскресенье|четверг)|во вторник|каждый|каждое|каждую)|(?!(?:суть|путь|мать|память|печать|кровать|благодать|сеть|треть|нить|пять|опять|девять|десять|зять|жуть|ртуть|муть|рать|\\p{L}{2,6}дцать)(?![\\p{L}]))\\p{L}{1,20}[аеиоуяыэю]ть(?:ся)?|\\p{L}{0,4}(?:йти|нести|вести|везти)(?:сь)?|лечь|испечь|завтра|сегодня|послезавтра|вечером|утром|дн[её]м|ночью|в обед|через (?:\\d{1,3}|час|минуту|неделю|месяц|день|год|пару|несколько|полчаса|два|две|три|пять|десять)|(?:в|к) \\d{1,2}|в (?:понедельник|среду|пятницу|субботу|воскресенье|четверг|полдень|полночь|выходные|конце|начале|следующ\\p{L}{1,3})|во вторник|на (?:следующ\\p{L}{1,3}|этой неделе|выходных)|(?:каждый|каждое|каждую|каждые)(?! сколько| ли)|ежедневно|еженедельно|ежемесячно|по (?:утрам|вечерам|понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям|будням)|раз в(?! сколько)|(?:перед|после)(?! (?:какого|какой|каких|каким|какими|чего|кого|того,? как|которого|которой|которых))|позже|потом|попозже|\\d{1,2}[./]\\d{1,2}|\\d{1,2} (?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|(?:о|об|про) (?:встрече|встречу|созвоне|созвон|при[её]ме|при[её]м|записи|запись|оплате|оплату|платеже|плат[её]ж|таблетках|таблетки|лекарствах|лекарства|лекарстве|дне рождения|день рождения|дедлайне|дедлайн|звонке|звонок|экзамене|экзамен|собрании|собрание|совещании|совещание|мероприятии|сч[её]те|сч[её]т|визите|визит|тренировке|тренировку|занятии|уроке|урок|вебинаре|собеседовании|собеседование|поездке|рейсе|аренде|квартплате|налогах|кредите)|(?:о|об|про) (?:(?!котор|(?:что|я|мы|ты|вы|он|она|они) \\p{L}{1,15}(?:л|ла|ли|ло|лся|лась|лись)(?![\\p{L}]))[^.?!\\n]|(?<=\\d)[.,](?=\\d)){1,60}?(?:завтра|сегодня|послезавтра|вечером|утром|через \\d{1,3}|через (?:час|неделю|месяц)|в \\d{1,2}|в (?:понедельник|среду|пятницу|субботу|воскресенье|четверг|следующ\\p{L}{1,3})|во вторник|каждый|каждое|каждую|ежедневно|\\d{1,2}[./]\\d{1,2}))",
      "(?:поставь(?:те)?|установи(?:те)?|создай(?:те)?|сделай(?:те)?|заведи(?:те)?|добавь(?:те)?|настрой(?:те)?)(?: мне)? (?:ежедневное |еженедельное |ежемесячное |регулярное |новое |повторяющееся )?(?:напоминание|напоминалку|автоматизацию|регулярную задачу|повторяющуюся задачу)",
      "(?:уведоми(?:те)?|уведомляй(?:те)?|оповести(?:те)?|оповещай(?:те)?|(?:можешь|можете|сможешь|сможете) (?:меня )?(?:уведомить|оповестить|уведомлять))(?: меня| нас)?,? (?:когда|как только|если|в случае,? если|в тот момент,? когда)",
      // "Дай знать, когда выйдет новый айфон", not "Скажи, когда закончилась война" or "Сообщи, если
      // что-то непонятно".
      "(?:дай(?:те)? (?:мне |нам )?знать|давай(?:те)? (?:мне |нам )?знать|сообщи(?:те)?(?: мне| нам)?|сообщай(?:те)?(?: мне| нам)?|напиши(?:те)? (?:мне|нам)|маякни(?:те)?|(?:можешь|можете|сможешь|сможете) (?:мне )?(?:сообщить|написать|дать знать))(?:,? пожалуйста)?,? (?:когда|как только|если|в случае,? если|в тот момент,? когда)(?![\\p{L}])(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:выйдет|выйдут|появится|появятся|упад[её]т|упадут|опустится|снизится|подешевеет|подешевеют|подорожает|вырастет|вырастут|поднимется|превысит|достигнет|пробь[её]т|станет (?:дешевле|доступн\\p{L}{1,3}|ниже|выше|меньше|больше)|будет (?:доступ\\p{L}{1,4}|в продаже|в наличии|выпущен\\p{L}{0,2}|объявлен\\p{L}{0,2}|опубликован\\p{L}{0,2}|дешевле|скидк\\p{L}{1,2})|будут (?:доступны|в продаже|в наличии|дешевле)|поступит в продажу|поступят в продажу|начн[её]тся|начнутся|стартует|стартуют|откроется|откроются|откроют|выпустят|объявят|опубликуют|анонсируют|релиз|ниже \\d{1,9}|выше \\d{1,9}|меньше \\d{1,9}|больше \\d{1,9}|в наличии|снова в продаже|верн[её]тся в продажу|скидк\\p{L}{1,2})",
      "(?<=^|,\\s{0,2})(?:когда|как только|как|если) (?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:выйдет|выйдут|появится|появятся|упад[её]т|упадут|опустится|снизится|подешевеет|подешевеют|подорожает|подорожают|вырастет|вырастут|превысит|достигнет|пробь[её]т|будет (?:доступ\\p{L}{1,4}|в продаже|в наличии)|будут (?:доступны|в продаже|в наличии)|поступит в продажу|поступят в продажу|начн[её]тся|начнутся|стартует|откроется|откроются|релиз|ниже \\d{1,9}|выше \\d{1,9}|в наличии|скидк\\p{L}{1,2})(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,30}?(?:дай(?:те)? (?:мне |нам )?знать|сообщи|уведоми|оповести|напиши(?:те)? (?:мне|нам)|маякни)",
      "автоматически (?:каждый|каждое|каждую|каждые|ежедневно|еженедельно|ежемесячно|присылай|отправляй|проверяй|напоминай|сообщай|делай|публикуй|собирай|обновляй|скидывай|пиши)",
      "автоматизируй(?:те)?(?: это| этот процесс)?(?: для меня)?(?:,? пожалуйста)?$",
      "(?:можешь|можете|сможешь|сможете|мог бы|могла бы|могли бы)(?: это)? автоматизировать(?: это)?$",
      "(?:присылай(?:те)?|пришлите|пришли мне|отправляй(?:те)?|отправь(?:те)?|скидывай(?:те)?|высылай(?:те)?|вышлите|вышли мне|давай(?:те)?|делай(?:те)?|готовь(?:те)?|составляй(?:те)?)(?: мне| нам)? (?:ежедневн|еженедельн|ежемесячн|утренн|вечерн|регулярн)\\p{L}{1,3} (?:[\\p{L}-]{1,20} )?(?:сводк|отч[её]т|дайджест|обзор|новост|рассылк|напоминани|уведомлени|резюме|выжимк|подборк|прогноз|гороскоп|цитат|совет|апдейт|обновлени|брифинг|шутк|анекдот)\\p{L}{0,3}",
    ]),
    // A question ("Сколько воды пить каждый день?", "Скажи, что есть каждый день"), a habit, or how often.
    not: new RegExp(
      "^(?:почему|зачем|сколько|как(?! только)|какой|какая|какое|какие|каких|каким|что|чем|когда|где|кто|правда ли|стоит ли|нужно ли|надо ли|можно ли|полезно ли|вредно ли|нормально ли|плохо ли|хорошо ли|есть ли)(?![\\p{L}\\p{N}-])|(?<![\\p{L}])(?:как часто|сколько раз|хорош(?:ая|ей) (?:ли )?иде(?:я|ей)|плох(?:ая|ой) иде(?:я|ей)|почему|зачем|польз[аыуе]|плюсы|минусы|вред(?:но|а|ит)?|полезно|нормально ли|можно ли|стоит ли|нужно ли|надо ли|как (?:\\p{L}{1,12} ){0,2}\\p{L}{2,20}(?:ть|ться|ти|чь)|как (?:мне )?(?:перестать|бросить|избавиться|научиться|заставить|настроить|поставить|установить|сделать так|отучиться)|сколько (?:\\p{L}{1,15} ){0,3}?(?:нужно|надо|следует|можно|должен|должна|пить|выпивать|есть|съедать|спать|сжигаю|сжигать|калорий|воды|белка|шагов)|что (?:мне )?(?:съесть|кушать|пить|выпить|готовить|приготовить|надеть|делать)|что (?:мне )?есть (?:каждый|на|утром|вечером|ежедневно|по|чтобы|для|при|перед|после)|(?:я|мы) (?!хочу|хотел|хотела|хотим|прошу|бы)(?:\\p{L}{1,15} )?(?:каждый|каждое|каждую|каждые|ежедневно|еженедельно|по (?:утрам|вечерам|понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям|будням|выходным)))(?![\\p{L}])",
      "iu",
    ),
    // A habit between them ("Каждый день я проверяю почту, скажи, как перестать", "Мой муж каждый вечер
    // смотрит футбол…", "витамины которые можно пить каждый день"), a plan, code or translation the
    // schedule is part of ("Составь расписание тренировок по понедельникам", "Напиши код для бэкапа каждую
    // ночь", "Переведи на английский каждое утро пью кофе"), the schedule in a clause of what to write
    // ("Напиши начальнику, что я каждый день работаю допоздна", "Расскажи что едят японцы каждое утро") or
    // a statement ("Каждый год одно и то же, напиши…").
    between: new RegExp(
      "(?<![\\p{L}])(?<!(?:^|[^\\p{L}])(?:пока|когда|если|как только)(?: \\p{L}{1,10})? )(?:проверяю|хожу|бегаю|пью|ем|встаю|просыпаюсь|ложусь|занимаюсь|тренируюсь|читаю|смотрю|работаю|учусь|сплю|трачу|делаю|гуляю|езжу|получаю|плачу|курю|готовлю|зарабатываю|чувствую|могу|должен|должна|стараюсь|пытаюсь|начинаю|у меня|ходим|ездим|едим|пь[её]м|делаем|играем|работаем|готовим|(?:я|мы|ты|вы|он|она|они) \\p{L}{1,15}|план|плана|расписание|программу|график|меню|рацион|распорядок|режим|часы работы|работает|открыт|открыта|открыто|закрыт|закрыта|закрыто|у (?:нас|них|него|не[её]|нее|мужа|жены|детей|реб[её]нка|сына|дочки|дочери|мамы|папы)|смотрит|смотрят|ходит|ходят|ест|едят|пь[её]т|пьют|спит|спят|работают|играет|играют|звонит|звонят|пишет|пишут|говорит|говорят|делает|делают|вста[её]т|встают|бегает|бегают|читает|читают|ездит|ездят|гуляет|гуляют|опаздывает|опаздывают|ругается|ругаются|плачет|болеет|просит|просят|жалуется|жалуются|приходит|приходят|будит|будят|кричит|кричат|проходит|проходят|бывает|бывают|(?:что|как|где|чем|куда|почему|зачем) (?:\\p{L}{1,15} )?\\p{L}{2,15}(?:ют|ят|ут)|котор\\p{L}{1,3}|скрипт|скрипта|скрипты|код|кода|функцию|функции|бота?|крон|cron|макрос|на (?:английский|русский|украинский|немецкий|французский|испанский|итальянский|китайский|японский|польский|турецкий)|по-(?:английски|русски|украински|немецки|французски|испански))(?![\\p{L}])|^\\s{1,3}(?:новый|новая|новое|новые|одно и то же|одно и тоже|то же самое)(?![\\p{L}])[^,–—]{0,40}(?:,|\\s[-–—]\\s)|(?<![\\p{L}])(?:что|чтобы|чтоб|потому что|который|которая|которое|которые|где|если|когда|как|сколько|ли)(?: (?:я|мы|ты|он|она|они|мне|нам|можно|нужно|надо))?\\s{1,3}$",
      "iu",
    ),
  },
  uk: {
    recur: B([
      // Not "продажі кожного місяця 2024 року" (of each month).
      "(?:щодня|щоденно|щотижня|щомісяця|щоранку|щовечора|щоночі|щогодини|щороку|щопонеділка|щовівторка|щосереди|щочетверга|щоп['’ʼ]ятниці|щосуботи|щонеділі|(?<!(?:^|[^\\p{L}])(?:на|для|за) )(?:кожен|кожний) (?:день|понеділок|вівторок|четвер|тиждень|місяць|рік|вечір|ранок|будній день|робочий день)(?! (?:народження|тижня|місяця|року|кварталу|програми|курсу|марафону|січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня|цього|минулого|поточного|\\d))|(?<!(?:^|[^\\p{L}])(?:з|із|зі|для|до|від|на|за) )(?:кожного (?:дня|ранку|вечора|тижня|місяця|року|понеділка|вівторка|четверга)(?! (?:народження|тижня|місяця|року|кварталу|програми|курсу|марафону|січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня|цього|минулого|поточного|\\d))|кожної (?:середи|п['’ʼ]ятниці|суботи|неділі|ночі|години)(?! (?:народження|тижня|місяця|року|кварталу|програми|курсу|марафону|січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня|цього|минулого|поточного|\\d)))|(?<!(?:^|[^\\p{L}])(?:на|за) )кожну (?:середу|п['’ʼ]ятницю|суботу|неділю|ніч|годину|хвилину)(?! (?:народження|тижня|місяця|року|кварталу|програми|курсу|марафону|січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня|цього|минулого|поточного|\\d))|кожні (?:\\d{1,3}|два|дві|три|чотири|п['’ʼ]ять|шість|кілька|пару|пів)(?: (?:хвилин|хвилини|годин|години|годину|дні|днів|тижні|тижнів|місяці|місяців|год|хв))?|кожні вихідні|(?:раз|один раз|два рази|три рази|\\d{1,2} рази?) на (?:день(?! народж)|тиждень|місяць|годину|рік|добу|(?:два|три|\\d{1,2}) (?:дні|години|тижні))|по (?:понеділках|вівторках|середах|четвергах|п['’ʼ]ятницях|суботах|неділях|буднях|вихідних|робочих днях|ранках|вечорах))(?: (?:о|об|на) \\d{1,2}(?:[:.]\\d{2})?(?: (?:ранку|вечора|годині))?| вранці| зранку| ввечері| увечері| вдень| вночі| в обід){0,2}",
    ]),
    act: B([
      // "пришли", "вишли" and "перешли" are also past tenses: only before "мені".
      "надішли|надішліть|надсилай(?:те)?|пришли(?= (?:мені|нам))|присилай(?:те)?|відправ(?:те)?|відправляй(?:те)?|скинь(?:те)?|скидай(?:те)?|кидай(?:те)?|вишліть|вишли(?= (?:мені|нам))|висилай(?:те)?|перешліть|перешли(?= (?:мені|нам))|пересилай(?:те)?",
      "нагадай(?:те)?|нагадуй(?:те)?|повідом(?:те)?|повідомляй(?:те)?|сповісти|сповістіть|сповіщай(?:те)?|інформуй(?:те)?|скажи|скажіть|кажи|кажіть|розкажи|розкажіть|розповідай(?:те)?|напиши|напишіть|пиши|пишіть|дай(?:те)? (?:мені |нам )?знати|давай(?:те)? (?:мені |нам )?знати|тримай(?:те)? (?:мене |нас )?в курсі|дай(?:те)?|давай(?:те)? (?:мені|нам)|покажи|покажіть|показуй(?:те)?|підбери|підберіть|підбирай(?:те)?|запропонуй(?:те)?|пропонуй(?:те)?|порадь(?:те)?|радь(?:те)?|порекомендуй(?:те)?|рекомендуй(?:те)?",
      "перевір(?:те)?|перевіряй(?:те)?|стеж(?:те)?|відстежуй(?:те)?|відслідковуй(?:те)?|моніторь(?:те)?|подивись|подивися|подивіться|глянь(?:те)?",
      "перелічи|перелічіть|перерахуй(?:те)?|підсумуй(?:те)?|підсумовуй(?:те)?|узагальни|узагальнюй(?:те)?|резюмуй(?:те)?|перекажи|перекажіть|склади|складіть|складай(?:те)?|збери|зберіть|збирай(?:те)?",
      "знайди|знайдіть|знаходь(?:те)?|шукай(?:те)?|пошукай(?:те)?|досліди|досліджуй(?:те)?|вивчи|вивчай(?:те)?|проаналізуй(?:те)?|аналізуй(?:те)?|порівняй(?:те)?|порівнюй(?:те)?|переклади|перекладіть|перекладай(?:те)?",
      "створи|створіть|створюй(?:те)?|згенеруй(?:те)?|генеруй(?:те)?|зроби|зробіть|роби|робіть|підготуй(?:те)?|готуй(?:те)?|вигадай(?:те)?|вигадуй(?:те)?|придумай(?:те)?|придумуй(?:те)?|опублікуй(?:те)?|публікуй(?:те)?|викладай(?:те)?|повтори|повторіть|повторюй(?:те)?",
      // "Можеш щодня надсилати мені…", "Хочу, щоб ти нагадував мені…", "Хочу щоранку отримувати…".
      "(?:можеш|можете|зможеш|зможете|міг би|могла б|могла би|могли б|могли би|будеш|будете|прошу)(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,6}? (?:надсилати|надіслати|присилати|відправляти|відправити|скидати|скинути|висилати|нагадувати|нагадати|повідомляти|повідомити|сповіщати|сповістити|казати|сказати|розповідати|розповісти|писати|написати|перевіряти|перевірити|стежити|відстежувати|робити|зробити|складати|скласти|збирати|зібрати|шукати|знайти|давати|дати|показувати|показати|готувати|підготувати|генерувати|створювати|підбирати|публікувати|перекладати|аналізувати|тримати мене в курсі)",
      "(?:хочу|хотів би|хотіла б|хотіла би|треба|потрібно),? щоби? ти(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,5}? (?:надсила|присила|відправля|скида|нагадува|повідомля|сповіща|каза|розповіда|писа|перевіря|стежи|відстежува|роби|склада|збира|шука|дава|показува|готува|надісла|нагада|перевіри|зроби)(?:в|ла)",
      "(?:хочу|хотів би|хотіла б|хотіла би|хочемо)(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,4}? отримувати",
    ]),
    strong: B([
      // "Нагадай мені завтра зателефонувати мамі", "… про зустріч", not "Мама нагадала мені…", "Нагадай
      // мені сюжет «Гамлета»", "… суть теореми", "…, після якої битви…", "…, кожні скільки годин…" or
      // "Нагадай, що таке фотосинтез" ("що" only before a time, and not before a past tense: "…, що ми
      // обговорювали в понеділок").
      "(?:нагадай(?:те)?|нагадуй(?:те)?|нагадаєш|не забудь(?:те)? нагадати|(?:можеш|можете|зможеш|зможете|міг би|могла б|могли б|прошу|будеш|будете)(?: [^\\s.,!?;:]{1,15}){0,2}? (?:нагадати|нагадувати))(?: мені| нам)?(?:,? будь ласка)?,? (?:щоб|щоби|про те,? щоб|(?:що|про те,? що) (?!(?:я|ми|ти|ви|він|вона|вони)(?: \\p{L}{1,10})? \\p{L}{2,15}(?:в|ла|ли|ло|лася|лись|лися)(?![\\p{L}]))(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:завтра|сьогодні|післязавтра|ввечері|увечері|вранці|зранку|через|о \\d{1,2}|об \\d{1,2}|(?:в|у) (?:понеділок|вівторок|середу|четвер|п['’ʼ]ятницю|суботу|неділю)|кожн\\p{L}{1,3}(?! скільки| чи)|щодня)|(?!(?:цитати|кімнати|зарплати|оплати|дати|хати|палати|роботи|теми|ноти|квіти|діти|мати|результати|кандидати|формати|дебати|депутати|штати|автомати|суть|мить|путь|ртуть|десять|\\p{L}{2,6}дцять)(?![\\p{L}]))\\p{L}{1,20}(?:[аиіїоуяю]ти(?:ся|сь)?|[аиіоуя]ть(?:ся)?)|\\p{L}{0,4}(?:йти|нести|вести|везти|помогти)|завтра|сьогодні|післязавтра|ввечері|увечері|вранці|зранку|вдень|вночі|в обід|через (?:\\d{1,3}|годину|хвилину|тиждень|місяць|день|рік|пару|кілька|пів|два|дві|три|п['’ʼ]ять|десять)|(?:о|об|на) \\d{1,2}|(?:в|у) (?:понеділок|вівторок|середу|четвер|п['’ʼ]ятницю|суботу|неділю|полудень|північ|вихідні|кінці|наступн\\p{L}{1,3})|наступн\\p{L}{1,3}|кожн\\p{L}{1,3}(?! скільки| чи)|щодня|щотижня|щомісяця|щоранку|щовечора|по (?:ранках|вечорах|понеділках|вівторках|середах|четвергах|п['’ʼ]ятницях|суботах|неділях|буднях)|раз на(?! скільки)|(?:перед|після)(?! (?:як\\p{L}{1,3}|котр\\p{L}{1,3}|чого|кого|того,? як))|пізніше|потім|згодом|\\d{1,2}[./]\\d{1,2}|\\d{1,2} (?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)|про (?:зустріч|нараду|прийом|візит|дедлайн|оплату|платіж|ліки|таблетки|день народження|дзвінок|запис|подію|збори|іспит|екзамен|рахунок|рахунки|тренування|заняття|урок|вебінар|співбесіду|поїздку|рейс|оренду|квартплату|податки|кредит|комуналку)|про (?:(?!котр|як(?:ий|а|е|і|ого|ої|их) |(?:що|я|ми|ти|ви|він|вона|вони) \\p{L}{1,15}(?:в|ла|ли|ло|лася|лись|лися)(?![\\p{L}]))[^.?!\\n]|(?<=\\d)[.,](?=\\d)){1,60}?(?:завтра|сьогодні|післязавтра|ввечері|вранці|зранку|через \\d{1,3}|через (?:годину|тиждень|місяць)|о \\d{1,2}|(?:в|у) (?:понеділок|вівторок|середу|четвер|п['’ʼ]ятницю|суботу|неділю|наступн\\p{L}{1,3})|кожн\\p{L}{1,3}(?! скільки| чи)|щодня|\\d{1,2}[./]\\d{1,2}))",
      "(?:постав(?:те)?|встанови|встановіть|створи|створіть|зроби|зробіть|додай(?:те)?|налаштуй(?:те)?|заведи)(?: мені)? (?:щоденне |щотижневе |щомісячне |регулярне |нове |повторюване )?(?:нагадування|нагадувалку|автоматизацію|регулярне завдання|повторюване завдання)",
      "(?:сповісти|сповістіть|сповіщай(?:те)?|(?:можеш|можете|зможеш|зможете) (?:мене )?(?:сповістити|сповіщати))(?: мене| нас)?,? (?:коли|щойно|як тільки|якщо|у разі,? якщо|в разі,? якщо|тільки-но)",
      // "Дай знати, коли вийде новий айфон", not "Скажи, коли закінчилася війна" or "Повідом, якщо щось
      // незрозуміло".
      "(?:дай(?:те)? (?:мені |нам )?знати|давай(?:те)? (?:мені |нам )?знати|повідом(?:те)?(?: мене| мені| нам)?|повідомляй(?:те)?(?: мене| мені| нам)?|напиши (?:мені|нам)|напишіть (?:мені|нам)|(?:можеш|можете|зможеш|зможете) (?:мені |мене )?(?:повідомити|написати|дати знати))(?:,? будь ласка)?,? (?:коли|щойно|як тільки|якщо|у разі,? якщо|в разі,? якщо|тільки-но)(?![\\p{L}])(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:вийде|вийдуть|з['’ʼ]явиться|з['’ʼ]являться|впаде|впадуть|опуститься|знизиться|подешевшає|подешевшають|подорожчає|зросте|зростуть|підніметься|перевищить|досягне|проб['’ʼ]є|стан(?:е|уть) (?:дешевш\\p{L}{1,3}|доступн\\p{L}{1,3}|нижч\\p{L}{1,3}|вищ\\p{L}{1,3})|буде (?:доступн\\p{L}{1,3}|у продажу|в продажу|в наявності|у наявності|випущен\\p{L}{1,3}|оголошен\\p{L}{1,3}|опублікован\\p{L}{1,3}|дешевш\\p{L}{1,3}|знижк\\p{L}{1,2})|будуть (?:доступні|у продажу|в продажу|в наявності|дешевші)|надійде в продаж|надійдуть у продаж|почнеться|почнуться|стартує|відкриється|відкриються|відкриють|випустять|оголосять|опублікують|анонсують|реліз|нижче \\d{1,9}|вище \\d{1,9}|менше \\d{1,9}|більше \\d{1,9}|знову в наявності|повернеться в продаж|знижк\\p{L}{1,2})",
      "(?<=^|,\\s{0,2})(?:коли|щойно|як тільки|як|якщо) (?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:вийде|вийдуть|з['’ʼ]явиться|з['’ʼ]являться|впаде|впадуть|опуститься|знизиться|подешевшає|подешевшають|подорожчає|подорожчають|зросте|зростуть|перевищить|досягне|проб['’ʼ]є|буде (?:доступн\\p{L}{1,3}|у продажу|в продажу|в наявності|у наявності)|будуть (?:доступні|у продажу|в продажу|в наявності|у наявності)|надійде в продаж|надійдуть у продаж|надійдуть в продаж|почнеться|почнуться|стартує|відкриється|відкриються|реліз|нижче \\d{1,9}|вище \\d{1,9}|знижк\\p{L}{1,2})(?:[^.?!\\n]|(?<=\\d)[.,](?=\\d)){0,30}?(?:дай(?:те)? (?:мені |нам )?знати|повідом|сповісти|напиши (?:мені|нам)|напишіть (?:мені|нам))",
      "автоматично (?:кожн\\p{L}{1,3}(?! скільки| чи)|щодня|щотижня|щомісяця|щоранку|надсилай|перевіряй|нагадуй|повідомляй|роби|публікуй|збирай|оновлюй|скидай|пиши)",
      "автоматизуй(?:те)?(?: це| цей процес)?(?: для мене)?(?:,? будь ласка)?$",
      "(?:можеш|можете|зможеш|зможете|міг би|могла б|могли б)(?: це)? автоматизувати(?: це)?$",
      "(?:надсилай(?:те)?|надішли|надішліть|присилай(?:те)?|відправляй(?:те)?|відправ(?:те)?|скидай(?:те)?|давай(?:те)?|роби|робіть|готуй(?:те)?|складай(?:те)?)(?: мені| нам)? (?:щоденн|щотижнев|щомісячн|ранков|вечірн|регулярн)\\p{L}{1,3} (?:[\\p{L}'’ʼ-]{1,20} )?(?:зведенн|звіт|дайджест|огляд|новин|розсилк|нагадуванн|сповіщенн|підсум|добірк|прогноз|гороскоп|цитат|порад|оновленн|брифінг|жарт|анекдот|вижимк)\\p{L}{0,3}",
    ]),
    // A question ("Скільки води пити щодня?", "Скажи, що їсти щодня"), a habit, or how often.
    not: new RegExp(
      "^(?:чому|навіщо|нащо|скільки|як(?! тільки)|який|яка|яке|які|яких|яким|що|чим|коли|де|хто|чи(?! (?:можеш|можете|міг би|могла б|могла би|могли б|могли би|не міг би|не могла б|не могли б|зможеш|зможете|будеш|будете|не (?:можеш|можете|зможеш|зможете))))(?![\\p{L}\\p{N}'’ʼ-])|(?<![\\p{L}])(?:як часто|скільки разів|(?:гарна|погана|добра|хороша) ідея|чому|навіщо|корист[ьі]|переваги|плюси|мінуси|шкода|шкідливо|корисно|нормально|чи (?:можна|варто|треба|потрібно|нормально|шкідливо|корисно|погано|добре|безпечно)|як (?:\\p{L}{1,12} ){0,2}\\p{L}{2,20}(?:ти|тися|тись|ть)|як (?:мені )?(?:перестати|кинути|позбутися|навчитися|змусити|налаштувати|поставити|встановити|зробити так|відучитися)|скільки (?:\\p{L}{1,15} ){0,3}?(?:треба|потрібно|слід|можна|маю|повинен|повинна|пити|їсти|спати|спалюю|калорій|води|білка|кроків)|що (?:мені )?(?:їсти|з['’ʼ]їсти|пити|випити|робити|приготувати|готувати|вдягнути|одягнути)|(?:я|ми) (?!хочу|хотів|хотіла|хочемо|прошу|би|б )(?:\\p{L}{1,15} )?(?:що(?:дня|тижня|місяця|ранку|вечора|ночі|години|року|понеділка|вівторка|середи|четверга|п['’ʼ]ятниці|суботи|неділі)|кожн\\p{L}{1,3}(?! скільки| чи)|по (?:ранках|вечорах|понеділках|вівторках|середах|четвергах|п['’ʼ]ятницях|суботах|неділях|буднях|вихідних)))(?![\\p{L}])",
      "iu",
    ),
    // A habit between them ("Щодня я перевіряю пошту, скажи, як перестати", "Мій син щодня грає…",
    // "вітаміни які можна пити щодня"), a plan, code or translation the schedule is part of ("Склади
    // розклад тренувань по понеділках", "Напиши скрипт для бекапу щоночі", "Переклади англійською щоранку
    // п'ю каву"), the schedule in a clause of what to write ("Напиши начальнику, що я щодня працюю
    // допізна", "Скажи що їдять японці щоранку") or a statement ("Щороку одне й те саме, напиши…").
    between: new RegExp(
      "(?<![\\p{L}])(?<!(?:^|[^\\p{L}])(?:поки|коли|доки|щойно|якщо|як тільки)(?: \\p{L}{1,10})? )(?:перевіряю|ходжу|бігаю|п['’ʼ]ю|їм|встаю|прокидаюся|прокидаюсь|лягаю|займаюся|займаюсь|тренуюся|тренуюсь|читаю|дивлюся|дивлюсь|працюю|вчуся|вчусь|навчаюся|сплю|витрачаю|роблю|гуляю|їжджу|отримую|плачу|палю|курю|готую|заробляю|відчуваю|можу|мушу|маю|повинен|повинна|намагаюся|намагаюсь|у мене|в мене|ходимо|їздимо|їмо|п['’ʼ]ємо|робимо|граємо|працюємо|готуємо|(?:я|ми|ти|ви|він|вона|вони) \\p{L}{1,15}|план|плану|розклад|програму|графік|меню|раціон|режим|години роботи|працює|відкритий|відкрита|відкрито|зачинений|зачинена|зачинено|(?:у|в) (?:нас|них|нього|неї|чоловіка|дружини|дітей|сина|доньки|дочки|мами|тата)|дивиться|дивляться|ходить|ходять|їсть|їдять|п['’ʼ]є|п['’ʼ]ють|спить|сплять|працюють|грає|грають|дзвонить|дзвонять|пише|пишуть|каже|кажуть|говорить|говорять|робить|роблять|встає|встають|бігає|бігають|читає|читають|їздить|їздять|гуляє|гуляють|запізнюється|запізнюються|свариться|плаче|хворіє|просить|просять|скаржиться|приходить|приходять|будить|будять|кричить|кричать|відбувається|відбуваються|буває|бувають|проходить|проходять|(?:що|як|де|чим|куди|чому|навіщо) (?:\\p{L}{1,15} )?[\\p{L}'’ʼ]{2,15}(?:ють|ять|уть|ать)|котр\\p{L}{1,3}|(?:який|яка|яке|які|якого|якої|яких|яким|якою)(?: \\p{L}{1,15})? (?:можна|треба|потрібно|варто|слід|\\p{L}{2,15}(?:ла|ли|в))|скрипт|скрипта|код|коду|функцію|функції|бота?|крон|cron|макрос|(?:англійською|українською|німецькою|французькою|іспанською|італійською|польською|російською|китайською|японською)|на (?:англійську|українську|німецьку|французьку|іспанську|польську))(?![\\p{L}])|^\\s{1,3}(?:новий|нова|нове|нові|той самий|та сама|те саме|одне й те саме|одне і те саме|одне й те ж)(?![\\p{L}])[^,–—]{0,40}(?:,|\\s[-–—]\\s)|(?<![\\p{L}])(?:що|щоб|щоби|бо|тому що|який|яка|яке|які|де|якщо|коли|як|скільки|чи)(?: (?:я|ми|ти|він|вона|вони|мені|нам|можна|треба|потрібно))?\\s{1,3}$",
      "iu",
    ),
  },
  el: {
    recur: B([
      // "καθημερινά" said of a request, not of a thing ("καθημερινά παπούτσια", "τα καθημερινά έξοδα").
      "(?:(?<!(?:^|[^\\p{L}])(?:για|απ[όο]) )κ[άα]θε (?:μ[έε]ρα|ημ[έε]ρα|πρω[ίι]|μεσημ[έε]ρι|απ[όο]γευμα|βρ[άα]δυ|ν[ύυ]χτα|εβδομ[άα]δα|βδομ[άα]δα|μ[ήη]να|χρ[όο]νο|[ώω]ρα|μισ[ήη] [ώω]ρα|Δευτ[έε]ρα|Τρ[ίι]τη|Τετ[άα]ρτη|Π[έε]μπτη|Παρασκευ[ήη]|Σ[άα]ββατο|Κυριακ[ήη]|Σαββατοκ[ύυ]ριακο|εργ[άα]σιμη|(?:\\d{1,3}|δ[ύυ]ο|δυο|τρεις|τ[έε]σσερις|π[έε]ντε|[έε]ξι|λ[ίι]γες|μερικ[έε]ς) (?:λεπτ[άα]|[ώω]ρες|μ[έε]ρες|ημ[έε]ρες|εβδομ[άα]δες|μ[ήη]νες))(?! της εβδομ[άα]δας| του μ[ήη]να)|(?<!(?:^|[^\\p{L}])(?:τα|στα|των|τις|οι|με) )καθημεριν[άα](?! (?:προβλ[ήη]ματα|θ[έε]ματα|[έε]ξοδα|γε[ύυ]ματα|πρ[άα]γματα|καθ[ήη]κοντα|ψ[ώω]νια|μαθ[ήη]ματα|ρο[ύυ]χα|παπο[ύυ]τσια|φαγητ[άα]|σνακ|ποτ[άα]|ροφ[ήη]ματα|τρ[όο]φιμα|συμπληρ[ώω]ματα|καλλυντικ[άα]|αρ[ώω]ματα|αξεσου[άα]ρ|αντικε[ίι]μενα|ε[ίι]δη|προ[ϊι][όο]ντα|εργαλε[ίι]α|λ[όο]για|λ[άα]θη|[έε]θιμα|παραδε[ίι]γματα|σεν[άα]ρια|γυαλι[άα]|αθλητικ[άα]|φορ[έε]ματα|παντελ[όο]νια|μπλουζ[άα]κια|αγγλικ[άα]|ελληνικ[άα]|γαλλικ[άα]|γερμανικ[άα]|ισπανικ[άα]|ιταλικ[άα])(?![\\p{L}]))|καθημεριν[ώω]ς|ημερησ[ίι]ως|εβδομαδια[ίι]ως|μηνια[ίι]ως|(?:μ[ίι]α|μια|δ[ύυ]ο|δυο|τρεις|\\d{1,2}) φορ(?:[άα]|[έε]ς) (?:τη|την|το|τον|αν[άα]) (?:μ[έε]ρα|ημ[έε]ρα|εβδομ[άα]δα|βδομ[άα]δα|μ[ήη]να|[ώω]ρα|χρ[όο]νο)|αν[άα] (?:\\d{1,3}|δ[ύυ]ο|δυο|τρεις|τ[έε]σσερις|[έε]ξι) (?:λεπτ[άα]|[ώω]ρες|μ[έε]ρες|ημ[έε]ρες|εβδομ[άα]δες|μ[ήη]νες)|τις (?:Δευτ[έε]ρες|Τρ[ίι]τες|Τετ[άα]ρτες|Π[έε]μπτες|Παρασκευ[έε]ς|Κυριακ[έε]ς)|τα (?:Σ[άα]ββατα|Σαββατοκ[ύυ]ριακα))(?: (?:στις|κατ[άα] τις|γ[ύυ]ρω στις) \\d{1,2}(?:[:.]\\d{2})?(?: (?:το πρω[ίι]|το απ[όο]γευμα|το βρ[άα]δυ|πμ|μμ))?| το πρω[ίι]| το μεσημ[έε]ρι| το απ[όο]γευμα| το βρ[άα]δυ){0,2}",
    ]),
    act: B([
      // An order, not a past tense: "έλεγξε", "πρότεινε", "ανέβασε" are both, so they count with "μου" after
      // them, or at the start, after "και / σε παρακαλώ" or after a schedule ("Κάθε μέρα έλεγξε τις τιμές"),
      // not in "Ο γιατρός πρότεινε περπάτημα κάθε μέρα".
      "(?<!(?:^|[^\\p{L}])(?:μου|μας|σου|σας|με|σε|τον|την|το|τα|τους|τις|του|της|ο|η|οι|δεν|δε|θα|να|που) )(?:στε[ίι]λε|στε[ίι]λτε|στ[έε]λνε|στ[έε]λνετ[έε] μου|θ[ύυ]μισ[έε] (?:μου|μας)|θυμ[ίι]στε (?:μου|μας)|θ[ύυ]μιζ[έε] (?:μου|μας)|ενημ[έε]ρωσ[έε] (?:με|μας)|ενημερ[ώω]στε (?:με|μας)|ενημ[έε]ρων[έε] (?:με|μας)|ειδοπο[ίι]ησ[έε] (?:με|μας)|ειδοποι[ήη]στε (?:με|μας)|πες|πε[ίι]τε|λ[έε]γε|γρ[άα]ψε|γρ[άα]ψτε|γρ[άα]φε|δ[ώω]σε|δ[ώω]στε|δ[ίι]νε|δε[ίι]ξε|δε[ίι]ξτε|δε[ίι]χνε|φ[έε]ρε|φ[έε]ρτε|προτε[ίι]νετ[έε] μου|ελ[έε]γξτε|τσεκ[άα]ρετε|κοιτ[άα]ξτε|παρακολουθ[ήη]στε|παρακολο[ύυ]θα|συνοψ[ίι]στε|κ[άα]νε|κ[άα]ντε|φτι[άα]ξε|φτι[άα]ξτε|φτι[άα]χνε|ετοιμ[άα]στε|μαζ[έε]ψτε|συγκεντρ[ώω]στε|ψ[άα]ξε|ψ[άα]ξτε|ψ[άα]χνε|βρες|βρε[ίι]τε|βρ[ίι]σκε|ερευν[ήη]στε|αναζητ[ήη]στε|αναλ[ύυ]στε|συγκρ[ίι]νετε|μεταφρ[άα]στε|δημιουργ[ήη]στε|σκ[έε]ψου|βγ[άα]λε|δημοσιε[ύυ]στε|επαν[άα]λαβε|(?:πρ[όο]τειν[έε]|[έε]λεγξ[έε]|τσ[έε]καρ[έε]|κο[ίι]ταξ[έε]|παρακολο[ύυ]θησ[έε]|συν[όο]ψισ[έε]|ετο[ίι]μασ[έε]|ετο[ίι]μαζ[έε]|μ[άα]ζεψ[έε]|συγκ[έε]ντρωσ[έε]|ερε[ύυ]νησ[έε]|αναζ[ήη]τησ[έε]|αν[άα]λυσ[έε]|σ[ύυ]γκριν[έε]|μετ[άα]φρασ[έε]|δημιο[ύυ]ργησ[έε]|δημοσ[ίι]ευσ[έε]|αν[έε]βασ[έε]|αν[έε]βαζ[έε]|[έε]λεγχ[έε]|επαναλ[άα]μβαν[έε]) (?:μου|μας))",
      "(?<=^|[,;:(]\\s{0,2}|(?:^|[^\\p{L}])(?:παρακαλ[ώω]|και|επ[ίι]σης|μετ[άα]|απλ[άα]|απλ[ώω]ς|[έε]λα|ρε|λοιπ[όο]ν|τ[ώω]ρα|π[άα]ντα)\\s{1,2}|(?:^|[^\\p{L}])(?:(?:κ[άα]θε|αν[άα]) [^\\s,.;:!?]{1,15}(?: [^\\s,.;:!?]{1,15}){0,3}|καθημεριν[άα](?: [^\\s,.;:!?]{1,15}){0,3}|(?:τις|τα) [^\\s,.;:!?]{4,15}(?: [^\\s,.;:!?]{1,15}){0,3}|φορ(?:[άα]|[έε]ς) (?:τη|την|το|τον|αν[άα]) [^\\s,.;:!?]{3,12}(?: [^\\s,.;:!?]{1,15}){0,2})\\s{1,2})(?:πρ[όο]τεινε|[έε]λεγξε|τσ[έε]καρε|κο[ίι]ταξε|παρακολο[ύυ]θησε|συν[όο]ψισε|ετο[ίι]μασε|ετο[ίι]μαζε|μ[άα]ζεψε|συγκ[έε]ντρωσε|ερε[ύυ]νησε|αναζ[ήη]τησε|αν[άα]λυσε|σ[ύυ]γκρινε|μετ[άα]φρασε|δημιο[ύυ]ργησε|δημοσ[ίι]ευσε|αν[έε]βασε|αν[έε]βαζε|[έε]λεγχε|επαναλ[άα]μβανε)",
      // "Μπορείς κάθε πρωί να μου στέλνεις…", "Θέλω να μου θυμίζεις…", "Να μου στέλνεις…".
      "(?:(?:μπορε[ίι]ς|μπορε[ίι]τε|θα μπορο[ύυ]σες|θα μπορο[ύυ]σατε|γ[ίι]νεται|θ[έε]λω|θα [ήη]θελα|σε παρακαλ[ώω]|παρακαλ[ώω])(?: (?:\\d{1,2}[:.]\\d{2}|[^\\s.,!?;:]{1,20})){0,6}? να (?:μου |μας |με )?|να (?:μου|μας|με) )(?:στ[έε]λνεις|στε[ίι]λεις|στ[έε]λνετε|στε[ίι]λετε|θυμ[ίι]ζεις|θυμ[ίι]σεις|θυμ[ίι]ζετε|θυμ[ίι]σετε|ενημερ[ώω]νεις|ενημερ[ώω]σεις|ενημερ[ώω]νετε|ενημερ[ώω]σετε|ειδοποιε[ίι]ς|ειδοποι[ήη]σεις|ειδοποιε[ίι]τε|ειδοποι[ήη]σετε|λες|πεις|λ[έε]τε|πε[ίι]τε|γρ[άα]φεις|γρ[άα]ψεις|γρ[άα]φετε|γρ[άα]ψετε|δ[ίι]νεις|δ[ώω]σεις|δ[ίι]νετε|δ[ώω]σετε|δε[ίι]χνεις|δε[ίι]ξεις|ελ[έε]γχεις|ελ[έε]γξεις|ελ[έε]γχετε|ελ[έε]γξετε|τσεκ[άα]ρεις|τσεκ[άα]ρετε|παρακολουθε[ίι]ς|παρακολουθ[ήη]σεις|ψ[άα]χνεις|ψ[άα]ξεις|βρ[ίι]σκεις|βρεις|φτι[άα]χνεις|φτι[άα]ξεις|κ[άα]νεις|κ[άα]νετε|ετοιμ[άα]ζεις|ετοιμ[άα]σεις|συνοψ[ίι]ζεις|συνοψ[ίι]σεις|μαζε[ύυ]εις|μαζ[έε]ψεις|δημοσιε[ύυ]εις|προτε[ίι]νεις|προτε[ίι]νετε|μεταφρ[άα]ζεις|συγκρ[ίι]νεις|αναλ[ύυ]εις)",
    ]),
    strong: B([
      // "Θύμισέ μου να πληρώσω το νοίκι", "… αύριο", "… το ραντεβού", not "Μου θύμισε τα παιδικά μου
      // χρόνια", "Θύμισέ μου την πλοκή του Άμλετ", "… το όνομα της εκπομπής που βλέπαμε κάθε Κυριακή",
      // "…, κάθε πόσες ώρες…" or "Θύμισέ μου πως λέγεται…" ("πως" only before a time).
      "(?:(?:θ[ύυ]μισ[έε]|θυμ[ίι]στε|θ[ύυ]μιζ[έε]|θυμ[ίι]ζετ[έε]) (?:μου|μας)|(?:(?:μπορε[ίι]ς|μπορε[ίι]τε|θα μπορο[ύυ]σες|θα μπορο[ύυ]σατε|θ[έε]λω|θα [ήη]θελα|σε παρακαλ[ώω]|μην ξεχ[άα]σεις|μην ξεχ[άα]σετε)(?: [^\\s.,!?;:]{1,15}){0,2}? )?(?:να|θα) (?:μου|μας) (?:θυμ[ίι]σεις|θυμ[ίι]ζεις|θυμ[ίι]σετε|θυμ[ίι]ζετε))(?:,? σε παρακαλ[ώω])?,? (?:να|[όο]τι|(?:πως|για) (?:[^.?!;\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:α[ύυ]ριο|απ[όο]ψε|μεθα[ύυ]ριο|στις \\d{1,2}|κ[άα]θε|καθημεριν[άα])|α[ύυ]ριο|σ[ήη]μερα|απ[όο]ψε|μεθα[ύυ]ριο|το πρω[ίι]|το βρ[άα]δυ|το απ[όο]γευμα|το μεσημ[έε]ρι|στις \\d{1,2}|σε (?:\\d{1,3}|μια|μ[ίι]α|μισ[ήη]|δ[ύυ]ο|δυο|λ[ίι]γα|λ[ίι]γες|π[έε]ντε|δ[έε]κα) (?:[ώω]ρα|[ώω]ρες|λεπτ[άα]|λεπτ[όο]|μ[έε]ρες|μ[έε]ρα|εβδομ[άα]δα|εβδομ[άα]δες|μ[ήη]να)|σε λ[ίι]γο|την (?:Δευτ[έε]ρα|Τρ[ίι]τη|Τετ[άα]ρτη|Π[έε]μπτη|Παρασκευ[ήη]|Κυριακ[ήη]|επ[όο]μενη|[άα]λλη|ερχ[όο]μενη)|το (?:Σ[άα]ββατο|Σαββατοκ[ύυ]ριακο)|κ[άα]θε(?! π[όο]σ)|καθημεριν[άα]|μετ[άα]|πριν|αργ[όο]τερα|\\d{1,2}[./]\\d{1,2}|(?:για )?(?:τη συν[άα]ντηση|την συν[άα]ντηση|το ραντεβο[ύυ]|την πληρωμ[ήη]|τον λογαριασμ[όο]|το λογαριασμ[όο]|το νο[ίι]κι|το ενο[ίι]κιο|τα φ[άα]ρμακα|το φ[άα]ρμακο|τα χ[άα]πια|τα γεν[έε]θλια|τη γιορτ[ήη]|το τηλεφ[ώω]νημα|την εξ[έε]ταση|τις εξετ[άα]σεις|τη δ[όο]ση|την προθεσμ[ίι]α|τη σ[ύυ]σκεψη|το μ[άα]θημα|την προπ[όο]νηση|την πτ[ήη]ση|τον γιατρ[όο]|το γιατρ[όο]|τον οδοντ[ίι]ατρο|την επ[έε]τειο)|(?!(?:τι|π[ώω]ς|ποιο|ποια|ποιος|πο[ύυ]|π[όο]τε|π[όο]σο)(?![\\p{L}]))(?:(?!που (?:(?:με|μου|μας|σε|σου|τον|την|τη|το|τα|τους|τις) )?\\p{L}{2,15}(?:αμε|ατε|ανε|αν|ε)(?<!ουμε|ούμε|ετε|έτε|είτε|ουνε|ούνε)(?![\\p{L}]))[^.?!;\\n]|(?<=\\d)[.,](?=\\d)){1,40}?(?:α[ύυ]ριο|απ[όο]ψε|μεθα[ύυ]ριο|στις \\d{1,2}|σε (?:\\d{1,3}|μια|μ[ίι]α|μισ[ήη]|δ[ύυ]ο|δυο) (?:[ώω]ρα|[ώω]ρες|λεπτ[άα]|μ[έε]ρες|μ[έε]ρα|εβδομ[άα]δα|μ[ήη]να)|την (?:Δευτ[έε]ρα|Τρ[ίι]τη|Τετ[άα]ρτη|Π[έε]μπτη|Παρασκευ[ήη]|Κυριακ[ήη]|επ[όο]μενη|ερχ[όο]μενη)|το (?:Σ[άα]ββατο|Σαββατοκ[ύυ]ριακο)|κ[άα]θε (?:μ[έε]ρα|πρω[ίι]|βρ[άα]δυ|εβδομ[άα]δα|μ[ήη]να|Δευτ[έε]ρα|Τρ[ίι]τη|Τετ[άα]ρτη|Π[έε]μπτη|Παρασκευ[ήη]|Σ[άα]ββατο|Κυριακ[ήη])|καθημεριν[άα]|\\d{1,2}[./]\\d{1,2}))",
      "(?<!(?:^|[^\\p{L}])(?:μου|μας|σου|του|της|τον|την|το|ο|η|θα|να|δεν) )(?:β[άα]λε|κ[άα]νε|φτι[άα]ξε|ρ[ύυ]θμισε|δημιο[ύυ]ργησε|[όο]ρισε|πρ[όο]σθεσε|στ[ήη]σε)(?: μου)? (?:μια |μ[ίι]α |[έε]να )?(?:καθημεριν[ήη] |εβδομαδια[ίι]α |μηνια[ίι]α |επαναλαμβαν[όο]μενη |ν[έε]α )?(?:υπενθ[ύυ]μιση|αυτοματοπο[ίι]ηση|αυτοματισμ[όο]|επαναλαμβαν[όο]μενη εργασ[ίι]α)",
      "(?:ειδοπο[ίι]ησ[έε] (?:με|μας)|ειδοποι[ήη]στε (?:με|μας)|(?:να|θα) (?:με|μας) (?:ειδοποι[ήη]σεις|ειδοποιε[ίι]ς|ειδοποι[ήη]σετε))(?:,? σε παρακαλ[ώω])?,? (?:[όο]ταν|μ[όο]λις|αν|ε[άα]ν|[άα]μα|τη στιγμ[ήη] που|[όο]ποτε|σε περ[ίι]πτωση που)",
      // "Ενημέρωσέ με όταν βγει το νέο iPhone", not "Πες μου πότε τελείωσε ο πόλεμος" or "Πες μου αν θα
      // πέσει η τιμή".
      "(?:ενημ[έε]ρωσ[έε] (?:με|μας)|ενημερ[ώω]στε (?:με|μας)|στε[ίι]λε μου|στε[ίι]λτε μου|γρ[άα]ψε μου|(?:να|θα) (?:με|μας) ενημερ[ώω]σεις|να μου (?:στε[ίι]λεις|γρ[άα]ψεις))(?:,? σε παρακαλ[ώω])?,? (?:[όο]ταν|μ[όο]λις|αν|ε[άα]ν|[άα]μα|τη στιγμ[ήη] που|[όο]ποτε)(?![\\p{L}])(?:[^.?!;\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:βγει|βγουν|κυκλοφορ[ήη]σει|κυκλοφορ[ήη]σουν|π[έε]σει|π[έε]σουν|αν[έε]βει|αν[έε]βουν|ξεπερ[άα]σει|ξεπερ[άα]σουν|φτ[άα]σει|φθ[άα]σει|γ[ίι]νει (?:διαθ[έε]σιμ|φθην[όο]τερ|φτην[όο]τερ|φθην|φτην)\\p{L}{0,3}|γ[ίι]νουν διαθ[έε]σιμ\\p{L}{1,2}|ε[ίι]ναι (?:ξαν[άα] )?διαθ[έε]σιμ\\p{L}{1,2}|ανακοινωθε[ίι]|ανακοινωθο[ύυ]ν|δημοσιευτε[ίι]|δημοσιευθε[ίι]|ξεκιν[ήη]σει|αρχ[ίι]σει|ανο[ίι]ξει|επιστρ[έε]ψει|ξαναμπε[ίι]|μπει (?:σε|στις) (?:προσφορ[άα]|[έε]κπτωση|εκπτ[ώω]σεις)|[έε]χει (?:[έε]κπτωση|προσφορ[άα])|κατ[έε]βει|μειωθε[ίι]|αυξηθε[ίι]|κ[άα]τω απ[όο] \\d{1,9}|π[άα]νω απ[όο] \\d{1,9}|σε απ[όο]θεμα|στο απ[όο]θεμα|σε προσφορ[άα]|φτην[ύυ]νει|ακριβ[ύυ]νει)",
      "(?:πες μου|πε[ίι]τε μου|να μου πεις)(?:,? σε παρακαλ[ώω])?,? (?:[όο]ταν|μ[όο]λις|τη στιγμ[ήη] που)(?![\\p{L}])(?:[^.?!;\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:βγει|βγουν|κυκλοφορ[ήη]σει|κυκλοφορ[ήη]σουν|π[έε]σει|π[έε]σουν|αν[έε]βει|ξεπερ[άα]σει|φτ[άα]σει|γ[ίι]νει διαθ[έε]σιμ\\p{L}{1,2}|ε[ίι]ναι (?:ξαν[άα] )?διαθ[έε]σιμ\\p{L}{1,2}|ανακοινωθε[ίι]|δημοσιευτε[ίι]|ξεκιν[ήη]σει|ανο[ίι]ξει|επιστρ[έε]ψει|μπει σε (?:προσφορ[άα]|[έε]κπτωση)|κατ[έε]βει|κ[άα]τω απ[όο] \\d{1,9}|π[άα]νω απ[όο] \\d{1,9}|σε απ[όο]θεμα)",
      "(?<=^|,\\s{0,2})(?:[όο]ταν|μ[όο]λις|αν|[άα]μα) (?:[^.?!;\\n]|(?<=\\d)[.,](?=\\d)){0,60}?(?:βγει|βγουν|κυκλοφορ[ήη]σει|π[έε]σει|π[έε]σουν|αν[έε]βει|ξεπερ[άα]σει|φτ[άα]σει|γ[ίι]νει διαθ[έε]σιμ\\p{L}{1,2}|ε[ίι]ναι (?:ξαν[άα] )?διαθ[έε]σιμ\\p{L}{1,2}|ανακοινωθε[ίι]|ξεκιν[ήη]σει|μπει σε (?:προσφορ[άα]|[έε]κπτωση)|κατ[έε]βει|κ[άα]τω απ[όο] \\d{1,9}|π[άα]νω απ[όο] \\d{1,9}|σε απ[όο]θεμα)(?:[^.?!;\\n]|(?<=\\d)[.,](?=\\d)){0,30}?(?:ειδοπο[ίι]ησ[έε] με|ειδοποι[ήη]στε με|ενημ[έε]ρωσ[έε] με|ενημερ[ώω]στε με|πες μου|στε[ίι]λε μου|γρ[άα]ψε μου)",
      "αυτ[όο]ματα (?:κ[άα]θε|καθημεριν[άα]|στε[ίι]λε|στ[έε]λνε|[έε]λεγχε|[έε]λεγξε|θ[ύυ]μιζε|ενημ[έε]ρωνε|ειδοπο[ίι]ησε|κ[άα]νε|φτι[άα]ξε|φτι[άα]χνε|γρ[άα]ψε|γρ[άα]φε|δημοσ[ίι]ευε|μ[άα]ζευε|ψ[άα]χνε)",
      "αυτοματοπο[ίι]ησ[έε] (?:το|τα)(?: για μ[έε]να)?(?:,? σε παρακαλ[ώω])?$",
      "(?:μπορε[ίι]ς|μπορε[ίι]τε|θα μπορο[ύυ]σες|θα μπορο[ύυ]σατε) να (?:το |τα )?(?:αυτοματοποι[ήη]σεις|αυτοματοποι[ήη]σετε)(?: αυτ[όο])?$",
      "(?:στε[ίι]λε|στε[ίι]λτε|στ[έε]λνε|στ[έε]λνετε|δ[ίι]νε|φτι[άα]χνε|ετο[ίι]μαζε|γρ[άα]φε) (?:μου|μας) (?:μια |μ[ίι]α |[έε]να |τη |την |το |τα |τις )?(?:καθημεριν|εβδομαδια[ίι]|μηνια[ίι]|πρωιν|βραδιν|ημερ[ήη]σι)\\p{L}{1,2} (?:[\\p{L}-]{1,20} )?(?:σ[ύυ]νοψη|περ[ίι]ληψη|ενημ[έε]ρωση|αναφορ[άα]|ειδ[ήη]σεις|ν[έε]α|ανασκ[όο]πηση|υπενθ[ύυ]μιση|ειδοπο[ίι]ηση|πρ[όο]γνωση|ωροσκ[όο]πιο|απ[όο]φθεγμα|ρητ[όο]|συμβουλ[ήη]|συμβουλ[έε]ς|newsletter|ενημερωτικ[όο]|briefing|λ[ίι]στα|αν[έε]κδοτο|αστε[ίι]ο)",
    ]),
    // A question ("Πόσο νερό να πίνω κάθε μέρα;", "Πες μου τι να τρώω κάθε μέρα"), how to, or how often.
    not: new RegExp(
      "^(?:γιατ[ίι]|π[όο]σο|π[όο]ση|π[όο]σα|π[όο]σες|π[όο]σους|π[όο]σοι|π[ώω]ς|τι|ποιο|ποια|ποιος|ποιες|ποιους|π[όο]τε|πο[ύυ]|ε[ίι]ναι|[έε]χει|πρ[έε]πει|μπορ[ώω]|αξ[ίι]ζει|κ[άα]νει|ισχ[ύυ]ει|υπ[άα]ρχει)(?![\\p{L}\\p{N}])|(?<![\\p{L}])(?:π[όο]σο συχν[άα]|π[όο]σες φορ[έε]ς|(?:καλ[ήη]|κακ[ήη]) ιδ[έε]α|γιατ[ίι]|οφ[έε]λη|[όο]φελος|πλεονεκτ[ήη]ματα|μειονεκτ[ήη]ματα|υπ[έε]ρ και κατ[άα]|συν[έε]πειες|επιπτ[ώω]σεις|ε[ίι]ναι (?:καλ[όο]|κακ[όο]|φυσιολογικ[όο]|υγιειν[όο]|επικ[ίι]νδυνο|σωστ[όο]|ασφαλ[έε]ς|επιβλαβ[έε]ς|ωφ[έε]λιμο)|κ[άα]νει (?:καλ[όο]|κακ[όο])|π[ώω]ς να|π[ώω]ς (?:μπορ[ώω] να |θα )?(?:σταματ[ήη]σω|κ[όο]ψω|ρυθμ[ίι]σω|β[άα]λω|φτι[άα]ξω|μ[άα]θω|αποφ[ύυ]γω|ξεκιν[ήη]σω)|π[όο]σο (?:\\p{L}{1,15} ){0,3}?(?:πρ[έε]πει|χρει[άα]ζεται|να)|π[όο]σες θερμ[ίι]δες|π[όο]σο νερ[όο]|τι (?:να |πρ[έε]πει να )?(?:τρ[ώω]ω|φ[άα]ω|π[ίι]νω|πιω|κ[άα]νω|μαγειρ[έε]ψω|μαγειρε[ύυ]ω|φορ[έε]σω)|(?:πρ[έε]πει|χρει[άα]ζεται|καλ[όο] ε[ίι]ναι) να (?:\\p{L}{1,15} )?(?:τρ[ώω]ω|π[ίι]νω|κ[άα]νω|κοιμ[άα]μαι|γυμν[άα]ζομαι|περπατ[άα]ω|περπατ[ώω]|τρ[έε]χω|ελ[έε]γχω|τσεκ[άα]ρω|πα[ίι]ρνω))(?![\\p{L}])",
      "iu",
    ),
    // A habit or a statement between them ("Κάθε Δευτέρα πάω γυμναστήριο, δώσε μου πρόγραμμα", "Κάθε μέρα
    // με βοηθάς, γράψε…", "Γράψε μια ιστορία για ένα παιδί που πηγαίνει κάθε μέρα…", "Κάθε Σάββατο έχει
    // λαϊκή, πες μου…", "Κάθε χρόνο τα ίδια, γράψε…"), a plan, code or translation the schedule is part of
    // ("Φτιάξε μου πρόγραμμα τις Δευτέρες", "Βρες μου κώδικα που κάνει backup κάθε βράδυ", "Μετάφρασε στα
    // αγγλικά κάθε πρωί πίνω καφέ"), or the schedule in a clause of what to write ("Γράψε στον
    // προϊστάμενο ότι κάθε μέρα δουλεύω ως αργά", "Πες μου τι τρώνε οι Ιάπωνες κάθε πρωί"). A "που" clause
    // right after the schedule says when ("Κάθε πρωί που ανοίγει το χρηματιστήριο, στείλε μου…").
    between: new RegExp(
      "(?<![\\p{L}])(?<!(?:^|[^\\p{L}])(?:[όο]ταν|μ[όο]λις|εν[ώω]|καθ[ώω]ς|πριν|αφο[ύυ]|αν|που)(?: \\p{L}{1,10})? )(?:ελ[έε]γχω|τσεκ[άα]ρω|πηγα[ίι]νω|π[άα]ω|τρ[έε]χω|π[ίι]νω|τρ[ώω]ω|ξυπν[άα]ω|ξυπν[ώω]|κοιμ[άα]μαι|γυμν[άα]ζομαι|διαβ[άα]ζω|βλ[έε]πω|δουλε[ύυ]ω|εργ[άα]ζομαι|μαθα[ίι]νω|ξοδε[ύυ]ω|κ[άα]νω|περπατ[άα]ω|περπατ[ώω]|πα[ίι]ρνω|πληρ[ώω]νω|καπν[ίι]ζω|μαγειρε[ύυ]ω|νι[ώω]θω|μπορ[ώω]|πρ[έε]πει|προσπαθ[ώω]|[έε]χω|ξεκιν[άα]ω|πηγα[ίι]νουμε|π[άα]με|κ[άα]νουμε|τρ[ώω]με|π[ίι]νουμε|εγ[ώω]|εμε[ίι]ς|(?:με|μου|μας|σε|σου|σας) \\p{L}{2,15}(?:ω|[ώω]|[άα]ω|[άα]ς|ει|ε[ίι]|[άα]ει|ουμε|ο[ύυ]με|[άα]με|ουν|ο[ύυ]ν|[άα]νε)|(?<!^\\s{0,3})που (?:\\p{L}{1,10} )?\\p{L}{2,15}(?:ει|ε[ίι]|[άα]ει|ουν|ο[ύυ]ν|[άα]νε)|πρ[όο]γραμμα|πλ[άα]νο|μενο[ύυ]|διατροφ[ήη]|ρουτ[ίι]να|ωρ[άα]ριο|ανοιχτ[όο]|ανοιχτ[άα]|ανοιχτ[ήη]|κλειστ[όο]|κλειστ[άα]|κλειστ[ήη]|βλ[έε]πει|βλ[έε]πουν|πηγα[ίι]νει|π[άα]ει|π[άα]νε|τρ[ώω]ει|τρ[ώω]νε|π[ίι]νει|π[ίι]νουν|κοιμ[άα]ται|κοιμο[ύυ]νται|δουλε[ύυ]ει|δουλε[ύυ]ουν|πα[ίι]ζει|πα[ίι]ζουν|τηλεφωνε[ίι]|γρ[άα]φει|γρ[άα]φουν|λ[έε]ει|λ[έε]νε|ξυπν[άα]ει|ξυπν[άα]|ξυπνο[ύυ]ν|τρ[έε]χει|τρ[έε]χουν|διαβ[άα]ζει|διαβ[άα]ζουν|ζητ[άα]ει|ζητ[άα]|φων[άα]ζει|κλα[ίι]ει|αργε[ίι]|[έε]ρχεται|[έε]ρχονται|γ[ίι]νεται|γ[ίι]νονται|[έε]χει|[έε]χουμε|[έε]χουν|υπ[άα]ρχει|υπ[άα]ρχουν|ε[ίι]ναι|ε[ίι]μαστε|(?<!^\\s{0,3})που (?:(?:με|μου|μας|σε|σου|τον|την|τη|το|τα|τους|τις) )?\\p{L}{2,15}(?:ε|αν|ανε|α)|(?:τι|π[ώω]ς|πο[ύυ]|π[όο]σο|π[όο]σα|γιατ[ίι]|π[όο]τε) (?:\\p{L}{1,15} )?\\p{L}{2,15}(?:ουν|ουνε|νε)|κ[ώω]δικα|κ[ώω]δικας|σκριπτ|script|συν[άα]ρτηση|bot|cron|λογισμικ[όο]|εφαρμογ[ήη]|(?:στα|σε) (?:αγγλικ[άα]|ελληνικ[άα]|γαλλικ[άα]|γερμανικ[άα]|ισπανικ[άα]|ιταλικ[άα]|ρωσικ[άα]|κιν[έε]ζικα|το[ύυ]ρκικα|ιαπωνικ[άα]|πορτογαλικ[άα]))(?![\\p{L}])|^\\s{1,3}(?:ν[έε]ο|ν[έε]α|ν[έε]ος|ν[έε]ες|καινο[ύυ]ργι\\p{L}{1,2}|τα [ίι]δια|το [ίι]διο)(?![\\p{L}])[^,–—]{0,40}(?:,|\\s[-–—]\\s)|(?<![\\p{L}])(?:[όο]τι|πως|που|γιατ[ίι]|επειδ[ήη]|αν|[όο]ταν|π[ώω]ς|π[όο]σο|τι)(?: (?:εγ[ώω]|εμε[ίι]ς|μου|μας|να))?\\s{1,3}$",
      "iu",
    ),
  },
  tr: {
    recur: B([
      // Not "için her gün" ("for every day"): "Haftanın her günü için bir plan ver". "Benim için her hafta" is "for me".
      "(?<!(?<![\\p{L}])(?<!(?:benim|bizim|senin) )(?:için|icin) )(?:her ?(?:gün|gun)|her ay[ıi]n (?:\\d{1,2}['’]?\\p{L}{1,4}|ilk|son|baş[ıi]nda|basinda|sonunda|ortas[ıi]nda)|her (?:sabah|akşam|aksam|gece|öğlen|oglen|hafta|ay|saat|saat baş[ıi]|saat basi|dakika|hafta sonu|hafta içi|hafta ici|ay baş[ıi]|ay basi|pazartesi|sal[ıi]|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar|(?:\\d{1,3}|iki|üç|uc|dört|dort|beş|bes|alt[ıi]) (?:saatte|günde|gunde|dakikada|haftada) bir))(?! için| icin)",
      "(?:günde|gunde|haftada|ayda|saatte|(?:\\d{1,2}|iki|üç|uc) (?:saatte|günde|gunde|dakikada)) bir(?: (?:kez|kere|defa))?",
      "(?:günde|gunde|haftada|ayda) (?:iki|üç|uc|\\d{1,2}) (?:kez|kere|defa)",
      "(?:pazartesi|sal[ıi]|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar) günleri|pazartesileri|sal[ıi]lar[ıi]|çarşambalar[ıi]|carsambalari|perşembeleri|persembeleri|cumalar[ıi]|cumartesileri|hafta sonlar[ıi]|hafta i[çc]leri|saat baş[ıi]|saat basi",
      // "günlük" alone is "daily life", "günlük rapor": only as an adverb.
      "(?:günlük|gunluk|haftal[ıi]k|ayl[ıi]k|düzenli|duzenli) olarak",
      // "Sabahları bana … gönder" only where it starts the sentence or part.
      "(?<=^\\s{0,3}|[,;]\\s{0,3})(?:(?:pazartesi|sal[ıi]|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar|hafta sonu|hafta içi|hafta ici) )?(?:sabahlar[ıi]|akşamlar[ıi]|aksamlari|geceleri|öğlenleri|oglenleri)",
    ]),
    act: B([
      "(?:gönder|gonder|yolla|hat[ıi]rlat|bildir|söyle|soyle|özetle|ozetle|araşt[ıi]r|arast[ıi]r|haz[ıi]rla|listele|oluştur|olustur|karş[ıi]laşt[ıi]r|karsilastir|paylaş|paylas|derle|getir|öner|oner|izle|tekrarla|öğret|ogret|anlat)(?:y?[ıiuü]n(?:[ıiuü]z)?|[ıiuüae]?r ?m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?|y?[ae]bil[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|s[ae]n[ae]|m[ae]n[ıi] (?:istiyorum|rica ediyorum))?",
      "(?:kontrol|takip|teyit) (?:et(?:sene)?|edin(?:iz)?|eder ?m[ıi]s[ıi]n(?:[ıi]z)?|edebilir ?m[ıi]s[ıi]n(?:[ıi]z)?|etmeni istiyorum)",
      // Bare "ver/yaz/bul/yap" only at the end of a clause: not "Bu yaz her gün…" (this summer).
      "(?:ver|yaz|bul|yap|ara)(?:[ıiuü]n(?:[ıiuü]z)?|s[ae]n[ae])?(?=\\s{0,3}(?:$|[,.!?;:)]|(?:lütfen|lutfen|bana|bize|hemen)(?![\\p{L}])))",
      "(?:ver|yaz|bul|yap)(?:[ıiuüae]r ?m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?|[ae]bil[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|m[ae]n[ıi] istiyorum)|ara(?:r ?m[ıi]s[ıi]n(?:[ıi]z)?|yabilir ?m[ıi]s[ıi]n(?:[ıi]z)?|y[ıi]n(?:[ıi]z)?)",
      "(?:mesaj(?:[ıi]|lar[ıi])?|bildirim(?:i|leri)?|e-?posta(?:s[ıi]|lar[ıi])?|mail(?:i|leri)?|sms(?:['’]?(?:i|leri))?) at(?:[ıi]n|ar ?m[ıi]s[ıi]n(?:[ıi]z)?|abilir ?m[ıi]s[ıi]n(?:[ıi]z)?|sana)?",
      "bakar ?m[ıi]s[ıi]n(?:[ıi]z)?|bakabilir ?m[ıi]s[ıi]n(?:[ıi]z)?|(?:özet|ozet|özetini|ozetini) (?:geç|gec|çıkar|cikar)(?:in|[ıi]n|[ae]r ?m[ıi]s[ıi]n|[ıi]r ?m[ıi]s[ıi]n|[ae]bilir ?m[ıi]s[ıi]n)?",
    ]),
    strong: B([
      // "Yarın doktoru aramamı hatırlat", never "Bu şarkı bana çocukluğumu hatırlattı" or "Hamlet'in konusunu hatırlat".
      "\\p{L}{2,20}(?:m[ae]m[ıi]|m[ae]y[ıi]|m[ae]m[ıi]z[ıi]|[ae]ce[ğg]imi|[ae]ca[ğg][ıi]m[ıi]|m[ae]m gerekti[ğg]ini) (?:(?:bana|bize|lütfen|lutfen|da|de) ){0,2}hat[ıi]rlat(?:[ıi]n(?:[ıi]z)?|[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|abilir ?m[ıi]s[ıi]n(?:[ıi]z)?|sana)?",
      "(?:yar[ıi]n|bug[üu]n|bu (?:akşam|aksam|gece|sabah|öğlen|oglen|hafta sonu)|(?:sabah|akşam|aksam|öğlen|oglen|gece) (?:saat )?\\d{1,2}|haftaya|gelecek hafta|saat \\d{1,2}|\\d{1,2}[:.]\\d{2}|(?:pazartesi|sal[ıi]|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar)(?: günü| gunu)?|\\d{1,3} (?:dakika|saat|gün|gun|hafta) sonra|her (?:gün|gun|sabah|akşam|aksam|gece|hafta|ay|saat|pazartesi|sal[ıi]|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar))(?![\\p{L}])[^.?!\\n]{0,60}?hat[ıi]rlat(?:[ıi]n(?:[ıi]z)?|[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|abilir ?m[ıi]s[ıi]n(?:[ıi]z)?|sana)?",
      // The request first, at the start: "Hatırlatır mısın, yarın saat 3'te …", "Haber ver bana, yeni model çıkınca".
      "(?<=^\\s{0,3}(?:(?:bana|bize|lütfen|lutfen) ){0,2})hat[ıi]rlat(?:[ıi]n(?:[ıi]z)?|[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|abilir ?m[ıi]s[ıi]n(?:[ıi]z)?|sana)?(?: (?:bana|bize|lütfen|lutfen)){0,2},?\\s{1,3}(?:yar[ıi]n|bug[üu]n|bu (?:akşam|aksam|gece|sabah|öğlen|oglen|hafta sonu)|haftaya|gelecek hafta|saat \\d{1,2}|\\d{1,2}[:.]\\d{2}|(?:pazartesi|sal[ıi]|çarşamba|carsamba|perşembe|persembe|cuma|cumartesi|pazar)(?: günü| gunu)?|\\d{1,3} (?:dakika|saat|gün|gun|hafta) sonra|her (?:gün|gun|sabah|akşam|aksam|gece|hafta|ay))(?![\\p{L}])",
      "(?:bir |yeni )?(?:hat[ıi]rlat[ıi]c[ıi]|hat[ıi]rlatma|otomasyon) (?:kur|ayarla|oluştur|olustur|ekle)(?:y?[ıiuü]n(?:[ıiuü]z)?|[ıiuüae]?r ?m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?|y?[ae]bil[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|s[ae]n[ae])?",
      // "Yeni iPhone çıkınca bana haber ver", "50 binin altına düşerse bildir": a future event, then the request.
      "(?<=(?<![\\p{L}\\p{M}\\p{N}])(?:çık|cik|düş|dus|in|yüksel|yuksel|art|gir|gel|açıklan|aciklan|yay[ıi]nlan|yay[ıi]mlan|ucuzla|aş|geç|gec|ulaş|ulas|başla|basla|ol)\\p{L}{0,3}?(?:y?[ıiuü]nc[ae]|[dt][ıiuü][ğg][ıiuü]nda|[dt][ıiuü][ğg][ıiuü] (?:zaman|an)|[ıiuüae]?rs[ae]|[ıiuüae]r \\p{L}{2,8}m[ae]z) (?:(?:bana|bize|hemen|lütfen|lutfen|an[ıi]nda|aninda|derhal) ){0,3})(?:haber ver|bildir|söyle|soyle|bildirim gönder|bildirim gonder|mesaj at|yaz)(?:y?[ıiuü]n(?:[ıiuü]z)?|[ıiuüae]?r ?m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?|y?[ae]bil[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|s[ae]n[ae])?",
      "(?<=^\\s{0,3}(?:(?:lütfen|lutfen|hemen|bana|bize) ){0,2})(?:haber ver|bildir)(?:y?[ıiuü]n(?:[ıiuü]z)?|[ıiuüae]?r ?m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?|y?[ae]bil[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|s[ae]n[ae])?(?: (?:bana|bize|lütfen|lutfen|hemen)){0,2},?\\s{1,3}[^.?!\\n]{0,60}?(?<![\\p{L}])(?:çık|cik|düş|dus|in|yüksel|yuksel|art|gir|gel|açıklan|aciklan|yay[ıi]nlan|yay[ıi]mlan|ucuzla|aş|geç|gec|ulaş|ulas|başla|basla)\\p{L}{0,3}?(?:y?[ıiuü]nc[ae]|[dt][ıiuü][ğg][ıiuü]nda|[dt][ıiuü][ğg][ıiuü] (?:zaman|an)|[ıiuüae]?rs[ae])",
      "(?:bunu|şunu|sunu|bu işi|bu isi|bu görevi|bu gorevi) (?:otomatikleştir|otomatiklestir|otomatik hale getir|otomatiğe bağla|otomatige bagla)(?:[ıi]n|[ıi]r ?m[ıi]s[ıi]n|ebilir ?m[ıi]s[ıi]n)?",
      "(?:günlük|gunluk|haftal[ıi]k|ayl[ıi]k) (?:bir )?(?:\\p{L}{2,15} ){0,2}?(?:özet|ozet|özeti|ozeti|rapor|bülten|bulten|güncelleme|guncelleme|hat[ıi]rlatma|bildirim)(?: ?l[ae]r)? (?:(?:bana|bize|lütfen|lutfen) ){0,2}(?:gönder|gonder|yolla|at|ver|getir)(?:y?[ıiuü]n(?:[ıiuü]z)?|[ıiuüae]?r ?m[ıiuü]s[ıiuü]n(?:[ıiuü]z)?|y?[ae]bil[ıi]r ?m[ıi]s[ıi]n(?:[ıi]z)?|s[ae]n[ae])?",
    ]),
    // A question ("ne sıklıkla", "faydaları", "kötü mü", "içmeliyim"), a first-person habit ("gidiyorum", "kontrol ederim")
    // or a fact ("toplantımız var,").
    not: B([
      "ne s[ıi]kl[ıi]kla|ne s[ıi]kl[ıi]kta|ne kadar s[ıi]k|kaç (?:kez|kere|defa|saat|bardak|litre|kalori|adım|adim|dakika)|kac (?:kez|kere|defa|saat|bardak|litre|kalori|adim|dakika)|ne kadar (?:su|süre|sure|uyku|kalori|protein|zaman|para)",
      "neden|niye|niçin|nicin|nas[ıi]l(?! (?:olaca[ğg][ıi]n[ıi]|oldu[ğg]unu|gitti[ğg]ini|geçti[ğg]ini|gecti[ğg]ini))|nedir|ne demek|ne anlama|anlam[ıi] ne",
      "fayda\\p{L}{0,6}|yarar\\p{L}{0,6}|zarar\\p{L}{0,6}|etkileri\\p{L}{0,3}|etkisi\\p{L}{0,3}|avantaj\\p{L}{0,6}|dezavantaj\\p{L}{0,6}|art[ıi]lar[ıi]|eksileri",
      "(?:iyi|kötü|kotu|normal|sağl[ıi]kl[ıi]|saglikli|zararl[ıi]|faydal[ıi]|doğru|dogru|gerekli|yeterli|mant[ıi]kl[ıi]|güvenli|guvenli|sorun|tehlikeli|sak[ıi]ncal[ıi]) (?:mu|m[ıi]|mü|mudur|m[ıi]d[ıi]r|müdür)",
      "\\p{L}{2,20}(?:meli|mal[ıi])(?:y[ıi]m|y[ıi]z|d[ıi]r|s[ıi]n)?",
      "(?<!rica )(?!ist|dil|bekl|unut|rica)\\p{L}{2,20}yor(?:um|uz)",
      "(?<!teşekkür |tesekkur |rica |memnun |minnettar |mutlu )(?!sevin|olur)\\p{L}{2,20}(?:[ae]r[ıi]m|[ıiuü]r[ıiuü]m)",
      "\\p{L}{2,20}(?:[ae]rs[ae]m|[ıiuü]rs[ae]m|m[ae]s[ae]m|ys[ae]m)|\\p{L}{2,20}(?:[ae]ce[ğg]im|[ae]ca[ğg][ıi]m)",
      // A fact about the schedule, then a one-off request: "Her pazartesi toplantımız var, gündem hazırla", "… var mı, kontrol et".
      "(?:var|yok|vard[ıi]r|olur|oluyor)(?: m[ıi]| mu)?(?=\\s{0,3}[,;])",
      // What happens on the schedule, then a one-off request: "Her sabah otobüs geç geliyor, başka bir yol bul".
      "(?:her|hergün|hergun|sabahlar[ıi]|akşamlar[ıi]|aksamlari|geceleri|günleri|gunleri)(?: [\\p{L}\\d'’]{1,20}){0,5}? \\p{L}{1,20}yor(?:lar)?(?=\\s{0,3}[,;])",
      "ne (?:\\p{L}{1,15} ){0,2}\\p{L}{1,15}s[ae](?:m|k)|(?:günleri|gunleri|sabahlar[ıi]|akşamlar[ıi]|geceleri|sonlar[ıi]) (?:\\p{L}{1,15} ){0,2}(?:aç[ıi]k|acik|kapal[ıi]) m[ıi]",
    ]),
    // Between them, a thing named by the schedule: "her gün yapabileceğim bir egzersiz", "pazar günleri açık olan eczaneler",
    // "her gün spor yapmak için".
    between:
      /^\s{0,3}(?:(?!bana|bize)\p{L}{1,15} ){0,3}\p{L}{2,20}m[ae]k (?:için|icin|hakkında|hakkinda|üzerine|uzerine|istiyorum|istiyoruz|isterim|lazım|lazim|gerek|zorunda)(?![\p{L}])|(?<![\p{L}])(?:olan|olanlar\p{L}{0,3}|yap[ıi]lan|çal[ıi]şan|calisan|aç[ıi]lan|acilan|oynanan|gerçekleşen|gerceklesen|düzenlenen|duzenlenen|kullan[ıi]lan|tüketilen|tuketilen|\p{L}{1,20}(?:m[ae]y[ae]n|[aeıioöuü]y[ae]n)|\p{L}{2,20}(?:[ae]bilece[ğg]\p{L}{0,4}|[ae]bil[ıi]r[ıi]m|[dt][ıiuü][ğg][ıiuü]m\p{L}{0,3}))(?![\p{L}])/iu,
  },
  ar: {
    recur: B([
      // "كل يوم", "كل صباح", "كل يوم اثنين الساعة 8"; not "لكل يوم" (for each day), "كل أحد" (everyone) or the greeting "كل عام وأنتم بخير".
      "(?:و|ف)?(?:في )?كل (?:يوم(?: (?:ال)?(?:[اإأ]ثنين|ثلاثاء|[اأ]ربعاء|خميس|جمع[ةه]|سبت|[اأ]حد))?|صباح|صبح|مساء|مسا|ليل[ةه]|[اأإ]سبوع|شهر|ساع[ةه]|سن[ةه](?!\\s{0,2}و)|عام(?!\\s{0,2}و)|يومين|ساعتين|[اأ]سبوعين|شهرين|(?:نص|نصف|ربع) ساع[ةه]|ثلاثاء|[اأ]ربعاء|خميس|جمع[ةه]|سبت|[\\d٠-٩]{1,3} (?:ساعات|ساع[ةه]|[اأ]يام|يوم|دقيق[ةه]|دقائق|دقايق|[اأ]سابيع))(?: (?:على |ع )?(?:ال)?ساع[ةه] [\\d٠-٩]{1,2}(?:[:.][\\d٠-٩]{2})?)?",
      // "يوميا", "يومياً", "يوميًا" (tanwin before or after the alif), never "يوميات" (diaries).
      "(?:يومي|[اأإ]سبوعي|شهري|سنوي|دوري)[\\u064B\\u0651]{0,2}ا\\u064B?",
      "ب(?:شكل|صف[ةه]|صور[ةه]) (?:يومي|[اأإ]سبوعي|شهري|دوري|منتظم)[ةه]?",
      "(?:مر[ةه](?: واحد[ةه])?|مرتين|ثلاث مرات|[\\d٠-٩]{1,2} مرات) (?:في |كل |ب)(?:ال)?(?:يوم|[اأإ]سبوع|شهر)",
      "كل [اأ]يام (?:ال[اأإ]سبوع|العمل|الدوام)",
    ]),
    act: B([
      // Imperatives aimed at the asker ("ابعتلي", "أعطني", "قولي", "ذكرني"), not "أرسل" or "أكتب" on their own (also "I send", "I write").
      "(?:و|ف)?(?:[اأإ]رسل|[اأإ]بع[ثت])(?:ها|ه|هم|ي|يها|يه|وا|و)? ?ل(?:ي|نا)",
      "(?:و|ف)?(?:ارسل(?:ي)?|[اإ]بع[ثت](?:ي)?|[اإ]بحث عن|[اإ]كتب(?:ي)?|[اإ]جمع)",
      "(?:و|ف)?(?:[اأ]?عط(?:ي)?(?:ني|نا)|[اإ]د\\u0651?(?:يني|ينا)|هات(?:ي|و)? ?ل(?:ي|نا)|جيب(?:ي|و)? ?ل(?:ي|نا)|[اأ]حضر(?:ي)? ?ل(?:ي|نا)|زو\\u0651?د(?:ني|نا)|واف(?:ي)?(?:ني|نا)|[اأ]ر(?:ي)?ني|ور\\u0651?يني|فرجيني)",
      "(?:و|ف)?(?:قل\\u0651? ?ل(?:ي|نا)|قول(?:ي)? ?ل(?:ي|نا)|قول\\u0651?ي|[اأ]?خب\\u0651?رني|[اأ]?بل\\u0651?غني|[اأ]علمني|نب\\u0651?ه(?:ي)?ني|[اأ]طلعني|ذك\\u0651?ر(?:ي)?ني|فك\\u0651?ر(?:ي)?ني)",
      "(?:و|ف)?(?:[اأإ]كتب|[اإ]عمل|سو\\u0651?ي?|جه\\u0651?ز|حض\\u0651?ر|[اإ]بحث|دو\\u0651?ر|شوف|[اإ]جمع|[اإ]ختر|[اإ]ختار|[اإ]قترح|[اإ]شرح|ترجم|[اأ]نشئ|صمم|[اإ]عرض|لخ\\u0651?ص|[اإ]ختصر|قارن|حل\\u0651?ل|تابع|راقب)(?:ي|وا|و)?(?:ها|ه)? ?ل(?:ي|نا)",
      // Imperatives that aren't also "I …" (أتابع, ألخص are): "تابع سعر الذهب", "لخص", "قارن".
      "(?:و|ف)?(?:لخ\\u0651?ص|تابع|راقب|تحق\\u0651?ق|ت[اأ]ك\\u0651?د|[اإ]فحص|قارن|حل\\u0651?ل|[اإ]نصحني|شي\\u0651?ك (?:على|ع)|شيكلي|دو\\u0651?ر (?:على|ع)|كر\\u0651?ر|[اإ]قترح (?:علي|علي\\u0651|علينا))(?:ه|ها|هم)?",
      "(?:و|ف)?(?:[اإ]عمل|سو\\u0651?ي?|نف\\u0651?ذ|كر\\u0651?ر) (?:هذا|هذه|هاد|هادا|هيك|ده|دي|كده|كدا|ذلك|نفس الشي|نفس الشيء)(?!\\s{0,2}ال)",
      "(?:و|ف)?(?:[اإ]عمل|سو\\u0651?ي|نف\\u0651?ذ|كر\\u0651?ر)(?:ه|ها)",
      // "ممكن تبعتلي", "هل يمكنك أن ترسل لي", "بدي ياك تذكرني", "هل يمكنك إرسال".
      "(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: (?:(?:و|ف)?(?:في )?كل (?:يوم(?: (?:ال)?(?:[اإأ]ثنين|ثلاثاء|[اأ]ربعاء|خميس|جمع[ةه]|سبت|[اأ]حد))?|صباح|صبح|مساء|مسا|ليل[ةه]|[اأإ]سبوع|شهر|ساع[ةه]|ساعتين|جمع[ةه]|خميس|سبت)(?: (?:الصبح|الصباح|المسا|المساء|بالليل|الظهر|العصر|(?:على |ع )?(?:ال)?ساع[ةه] [\\d٠-٩]{1,2}(?:[:.][\\d٠-٩]{2})?)){0,2}|يومي[\\u064B\\u0651]{0,2}ا\\u064B?))?(?: [اأ]ن)? ت(?:رسل|بع[ثت]|كتب|عمل|سو\\u0651?ي|جيب|قول|لخ\\u0651?ص|تابع|راقب|تحق\\u0651?ق|بحث|دو\\u0651?ر|شوف|جمع|قارن|حل\\u0651?ل|جه\\u0651?ز|حض\\u0651?ر|ختار|قترح|شرح|ترجم|عرض)(?:ين|ي|وا|و)?(?:ها|ه|هم)?(?: ?ل(?:ي|نا))?",
      "(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: (?:(?:و|ف)?(?:في )?كل (?:يوم(?: (?:ال)?(?:[اإأ]ثنين|ثلاثاء|[اأ]ربعاء|خميس|جمع[ةه]|سبت|[اأ]حد))?|صباح|صبح|مساء|مسا|ليل[ةه]|[اأإ]سبوع|شهر|ساع[ةه]|ساعتين|جمع[ةه]|خميس|سبت)(?: (?:الصبح|الصباح|المسا|المساء|بالليل|الظهر|العصر|(?:على |ع )?(?:ال)?ساع[ةه] [\\d٠-٩]{1,2}(?:[:.][\\d٠-٩]{2})?)){0,2}|يومي[\\u064B\\u0651]{0,2}ا\\u064B?))?(?: [اأ]ن)? ت(?:ذك\\u0651?ر|فك\\u0651?ر|نب\\u0651?ه|خب\\u0651?ر|بل\\u0651?غ|عطي|دي|زو\\u0651?د|وافي|وري|فرجي)(?:ين|ي)?(?:ني|نا)",
      "(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن)|يمكنك|بإمكانك|بامكانك|تستطيع|الرجاء|رجاء|[اأ]رجو|[اأ]ريد منك|[اأ]طلب منك) (?:[اإ]رسال|تذكيري|تنبيهي|[اإ]خباري|[اإ]بلاغي|[اإ]علامي|كتاب[ةه]|تلخيص|متابع[ةه]|مراقب[ةه]|البحث|التحقق|[اإ]عطائي|تزويدي|موافاتي|[اإ]عداد|تجهيز|تحضير|جمع|مقارن[ةه]|تحليل)",
      // "أبغى ملخص الأخبار كل صباح", "عايز تقرير كل أسبوع": a thing to send, wanted.
      "(?:[اأ]ريد|[اأ]بي|[اأ]بغى|[اأ]بغا|عايز|عاوز|عايز[ةه]|عاوز[ةه]|بد\\u0651?ي|محتاج|محتاج[ةه]|[اأ]حتاج|حاب|حابب|[اأ]ود)(?: منك)? (?:ملخص|تقرير|موجز|نشر[ةه]|تحديث|تحديثات|[اأ]خبار|ال[اأ]خبار|تذكير|تنبيه|[اإ]شعار|قائم[ةه]|اقتباس|نصيح[ةه]|نصائح|نكت[ةه]|خلاص[ةه]|رسال[ةه])(?:ا|ا\\u064B|\\u064Bا)?",
    ]),
    strong: B([
      // A reminder with a time or a task: "ذكرني بكرة الساعة 9", "ذكرني أن أتصل بأمي", "فكرني اكلم ماما",
      // not "ذكرني بطفولتي" (it reminded me of my childhood) or "ذكرني بأحداث هاملت".
      "(?:و|ف)?(?:ذك\\u0651?ر(?:ي)?ني|فك\\u0651?ر(?:ي)?ني|نب\\u0651?ه(?:ي)?ني|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:ذك\\u0651?ر|فك\\u0651?ر|نب\\u0651?ه)(?:ي)?ني|تذكيري|تنبيهي))(?:(?!(?<!\\p{L})(?:اللي|الذي|التي|الذين|اللى|يلي|[اإ]للي|كيف|شو|ايش|إيش|ماذا|متى|وين|فين|مين|ليش|لماذا|ليه|كان|كانت|كنا|كنت|كانوا|اسم|باسم|[اأ]مس|امبارح|مبارح)(?!\\p{L}))[^.?!؟\\n]){0,60}?(?<!\\p{L})(?:غد(?:ا|ا\\u064B|\\u064Bا)?|بكر[ةها]|الليل[ةه]|بالليل|(?:على |ع |في )?الساع[ةه] [\\d٠-٩]{1,2}|الساع[ةه] (?:واحد[ةه]|اثن|ثنت|ثلاث|[اأ]ربع|خمس|ست|سبع|ثمان|تسع|عشر)\\p{L}{0,6}|بعد (?:ساع[ةه]|ساعتين|ربع|نص|نصف|يومين|[اأ]سبوع|شهر|[\\d٠-٩]{1,3})|يوم (?:ال)?(?:[اإأ]ثنين|ثلاثاء|[اأ]ربعاء|خميس|جمع[ةه]|سبت|[اأ]حد)|كل (?:يوم|صباح|صبح|مساء|مسا|ليل[ةه]|[اأ]سبوع|شهر|ساع[ةه]|سن[ةه]|جمع[ةه]|خميس|سبت|[\\d٠-٩]{1,3})|يومي[\\u064B\\u0651]{0,2}ا|صباح(?:ا|ا\\u064B)|مساء(?:ا|ا\\u064B|\\u064B)?|الصبح|المسا|ال[اأ]سبوع (?:الجاي|القادم|المقبل)|الشهر (?:الجاي|القادم|المقبل)|نهاي[ةه] (?:الشهر|ال[اأ]سبوع)|[اآ]خر الشهر|[اأ]ول الشهر|قبل (?:الاجتماع|الموعد|موعد|المحاضر[ةه]|الامتحان|ما))",
      "(?:و|ف)?(?:ذك\\u0651?ر(?:ي)?ني|فك\\u0651?ر(?:ي)?ني|نب\\u0651?ه(?:ي)?ني|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:ذك\\u0651?ر|فك\\u0651?ر|نب\\u0651?ه)(?:ي)?ني|تذكيري|تنبيهي)) (?:[اأإ]ن|بأن|بان) ?[اأآ](?!ل)\\p{L}{1,12}",
      "(?:و|ف)?(?:ذك\\u0651?ر(?:ي)?ني|فك\\u0651?ر(?:ي)?ني|نب\\u0651?ه(?:ي)?ني|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:ذك\\u0651?ر|فك\\u0651?ر|نب\\u0651?ه)(?:ي)?ني|تذكيري|تنبيهي)) [اأ](?:تصل|كلم|شرب|دفع|خذ|روح|شتري|رد|جدد|حجز|ذاكر|صلي|تمرن|نام|صحى|قوم|طفي|بعت|بعث|رسل|كتب|جيب|سجل|طلب|زور|سقي|خلص|سدد|شحن|رجع)",
      "(?:و|ف)?(?:ذك\\u0651?ر(?:ي)?ني|فك\\u0651?ر(?:ي)?ني|نب\\u0651?ه(?:ي)?ني|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:ذك\\u0651?ر|فك\\u0651?ر|نب\\u0651?ه)(?:ي)?ني|تذكيري|تنبيهي)) ب(?:موعد|ميعاد|الموعد|الميعاد|اجتماع|الاجتماع|دفع|سداد|تجديد|حجز|[اأ]خذ|شرب|الاتصال|[اإ]تصال|مكالم[ةه]|عيد ميلاد|الدواء|دوائي|الفاتور[ةه]|فاتور[ةه])",
      // "Tell me when" only with a future event: "أخبرني عندما ينزل الآيفون الجديد", "لو نزل البيتكوين تحت 50 ألف نبهني",
      // not "أخبرني متى انتهت الحرب". The question check runs only once a condition word follows.
      "(?:و|ف)?(?:نب\\u0651?ه(?:ي)?ني|[اأ]?خب\\u0651?ر(?:ي)?ني|[اأ]?بل\\u0651?غ(?:ي)?ني|[اأ]علم(?:ي)?ني|قوليلي|قل\\u0651? ?لي|قول(?:ي)? ?لي|قول\\u0651?ي|عر\\u0651?فني|خل\\u0651?يني [اأ]عرف|دعني [اأ]عرف|[اأإ]رسل ?لي|[اإ]بع[ثت] ?لي|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:نب\\u0651?ه|خب\\u0651?ر|بل\\u0651?غ|عر\\u0651?ف)(?:ي)?ني|تقول(?:ي)? ?لي|تقولي))(?= (?:[اإ]ذا(?! سمح| تكرم)|لو(?! سمح| تكرم)|[اأ]ول ما|بمجرد(?: ما| [اأ]ن)?|فور(?: ما| [اأ]ن)|حالما|عندما|عند ما|لما|لم\\u0651ا|حين|حينما|متى ما|وقت ما) )(?![^.?!؟\\n]{0,80}?(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L})) (?:[اإ]ذا(?! سمح| تكرم)|لو(?! سمح| تكرم)|[اأ]ول ما|بمجرد(?: ما| [اأ]ن)?|فور(?: ما| [اأ]ن)|حالما|عندما|عند ما|لما|لم\\u0651ا|حين|حينما|متى ما|وقت ما) [^.?!؟\\n]{0,60}?(?<!\\p{L})(?:(?:[سحه]|ب)?[يت](?:نزل|صدر|طلع|نخفض|رتفع|قل|زيد|توفر|تاح|وصل|بد[أا]|تغي\\u0651?ر|نطلق|علن|طرح|نشر|رخص|هبط|تجاوز|تخطى|صير|صبح|رجع|عود|فتح|ظهر|كون (?:متاح|متوفر|موجود|[اأ]قل|[اأ]رخص|تحت|فوق))(?:ون|ين|وا)?|متوفر[ةه]?|متاح[ةه]?|في المخزون|بالمخزون|[اأ]قل من|[اأ]رخص من|تحت [\\d٠-٩]{1,9}|فوق [\\d٠-٩]{1,9}|[اأ]كثر من [\\d٠-٩]{1,9}|للبيع|في ال[اأ]سواق|بال[اأ]سواق)(?![\\p{L}\\p{N}])",
      "(?:و|ف)?(?:نب\\u0651?ه(?:ي)?ني|[اأ]?خب\\u0651?ر(?:ي)?ني|[اأ]?بل\\u0651?غ(?:ي)?ني|[اأ]علم(?:ي)?ني|قوليلي|قل\\u0651? ?لي|قول(?:ي)? ?لي|قول\\u0651?ي|عر\\u0651?فني|خل\\u0651?يني [اأ]عرف|دعني [اأ]عرف|[اأإ]رسل ?لي|[اإ]بع[ثت] ?لي|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:نب\\u0651?ه|خب\\u0651?ر|بل\\u0651?غ|عر\\u0651?ف)(?:ي)?ني|تقول(?:ي)? ?لي|تقولي))(?= (?:[اإ]ذا(?! سمح| تكرم)|لو(?! سمح| تكرم)|[اأ]ول ما|بمجرد(?: ما| [اأ]ن)?|فور(?: ما| [اأ]ن)|حالما) )(?![^.?!؟\\n]{0,80}?(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L})) (?:[اإ]ذا(?! سمح| تكرم)|لو(?! سمح| تكرم)|[اأ]ول ما|بمجرد(?: ما| [اأ]ن)?|فور(?: ما| [اأ]ن)|حالما) [^.?!؟\\n]{0,60}?(?<!\\p{L})(?:نزل|صدر|طلع|انخفض|ارتفع|قل|زاد|توفر|وصل|بد[أا]|تغي\\u0651?ر|انطلق|[اأ]علن|رخص|هبط|تجاوز|تخطى|صار|[اأ]صبح|رجع|فتح|ظهر)(?:ت)?(?!\\p{L})",
      // "أعلمني فور صدور النتائج", "عند انخفاض سعر التذكرة أرسل لي تنبيها".
      "(?:و|ف)?(?:نب\\u0651?ه(?:ي)?ني|[اأ]?خب\\u0651?ر(?:ي)?ني|[اأ]?بل\\u0651?غ(?:ي)?ني|[اأ]علم(?:ي)?ني|قوليلي|قل\\u0651? ?لي|قول(?:ي)? ?لي|قول\\u0651?ي|عر\\u0651?فني|خل\\u0651?يني [اأ]عرف|دعني [اأ]عرف|[اأإ]رسل ?لي|[اإ]بع[ثت] ?لي|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:نب\\u0651?ه|خب\\u0651?ر|بل\\u0651?غ|عر\\u0651?ف)(?:ي)?ني|تقول(?:ي)? ?لي|تقولي))(?= (?:فور|عند|بمجرد|حال|لحظ[ةه]) )(?![^.?!؟\\n]{0,80}?(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L})) (?:فور|عند|بمجرد|حال|لحظ[ةه]) (?:صدور|نزول|انخفاض|ارتفاع|هبوط|تراجع|صعود|توف\\u0651?ر|طرح|[اإ]طلاق|[اإ]صدار|[اإ]علان|وصول|تغي\\u0651?ر|بدء|بداي[ةه]|فتح|افتتاح|عود[ةه]|رجوع|ظهور|نشر|تخفيض)(?= )",
      // The condition first, matched from the request back once a condition word is near (cheap where "لو" or "لما" are everywhere).
      "(?=(?:و|ف)?(?:نب\\u0651?ه(?:ي)?ني|[اأ]?خب\\u0651?ر(?:ي)?ني|[اأ]?بل\\u0651?غ(?:ي)?ني|[اأ]علم(?:ي)?ني|قوليلي|قل\\u0651? ?لي|قول(?:ي)? ?لي|قول\\u0651?ي|عر\\u0651?فني|خل\\u0651?يني [اأ]عرف|دعني [اأ]عرف|[اأإ]رسل ?لي|[اإ]بع[ثت] ?لي|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:نب\\u0651?ه|خب\\u0651?ر|بل\\u0651?غ|عر\\u0651?ف)(?:ي)?ني|تقول(?:ي)? ?لي|تقولي)))(?<=(?<![\\p{L}\\p{M}\\p{N}])(?:[اإ]ذا|لو|[اأ]ول ما|بمجرد|فور|حال|عند|لم\\u0651?ا|حين|متى ما|وقت ما|لحظ)[^.?!؟\\n]{0,140})(?<=(?<![\\p{L}\\p{M}\\p{N}])(?:(?:(?:[اإ]ذا(?! سمح| تكرم)|لو(?! سمح| تكرم)|[اأ]ول ما|بمجرد(?: ما| [اأ]ن)?|فور(?: ما| [اأ]ن)|حالما|عندما|عند ما|لما|لم\\u0651ا|حين|حينما|متى ما|وقت ما) (?:(?!(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L}))[^.?!؟\\n]){0,60}?(?<!\\p{L})(?:(?:[سحه]|ب)?[يت](?:نزل|صدر|طلع|نخفض|رتفع|قل|زيد|توفر|تاح|وصل|بد[أا]|تغي\\u0651?ر|نطلق|علن|طرح|نشر|رخص|هبط|تجاوز|تخطى|صير|صبح|رجع|عود|فتح|ظهر|كون (?:متاح|متوفر|موجود|[اأ]قل|[اأ]رخص|تحت|فوق))(?:ون|ين|وا)?|متوفر[ةه]?|متاح[ةه]?|في المخزون|بالمخزون|[اأ]قل من|[اأ]رخص من|تحت [\\d٠-٩]{1,9}|فوق [\\d٠-٩]{1,9}|[اأ]كثر من [\\d٠-٩]{1,9}|للبيع|في ال[اأ]سواق|بال[اأ]سواق)(?![\\p{L}\\p{N}])|(?:[اإ]ذا(?! سمح| تكرم)|لو(?! سمح| تكرم)|[اأ]ول ما|بمجرد(?: ما| [اأ]ن)?|فور(?: ما| [اأ]ن)|حالما) (?:(?!(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L}))[^.?!؟\\n]){0,60}?(?<!\\p{L})(?:نزل|صدر|طلع|انخفض|ارتفع|قل|زاد|توفر|وصل|بد[أا]|تغي\\u0651?ر|انطلق|[اأ]علن|رخص|هبط|تجاوز|تخطى|صار|[اأ]صبح|رجع|فتح|ظهر)(?:ت)?(?!\\p{L}))(?:(?!(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L}))[^.?!؟\\n]){0,40}?|(?:فور|عند|بمجرد|حال|لحظ[ةه]) (?:صدور|نزول|انخفاض|ارتفاع|هبوط|تراجع|صعود|توف\\u0651?ر|طرح|[اإ]طلاق|[اإ]صدار|[اإ]علان|وصول|تغي\\u0651?ر|بدء|بداي[ةه]|فتح|افتتاح|عود[ةه]|رجوع|ظهور|نشر|تخفيض)(?= )(?:(?!(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L}))[^.?!؟\\n]){0,60}?))(?<!\\p{L})(?:و|ف)?(?:نب\\u0651?ه(?:ي)?ني|[اأ]?خب\\u0651?ر(?:ي)?ني|[اأ]?بل\\u0651?غ(?:ي)?ني|[اأ]علم(?:ي)?ني|قوليلي|قل\\u0651? ?لي|قول(?:ي)? ?لي|قول\\u0651?ي|عر\\u0651?فني|خل\\u0651?يني [اأ]عرف|دعني [اأ]عرف|[اأإ]رسل ?لي|[اإ]بع[ثت] ?لي|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? (?:ت(?:نب\\u0651?ه|خب\\u0651?ر|بل\\u0651?غ|عر\\u0651?ف)(?:ي)?ني|تقول(?:ي)? ?لي|تقولي))(?![^.?!؟\\n]{0,80}?(?<!\\p{L})(?:ماذا|ايش|إيش|شو|كيف|ليش|لماذا|ليه|هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن|تقدر|تقدري))|كم|متى|وين|[اأ]ين)(?!\\p{L}))",
      // "حطلي تذكير", "هل يمكنك ضبط تذكير", not "كيف اضبط تذكير على الآيفون".
      "(?<!(?:كيف|ازاي|إزاي|شلون|كيفي[ةه]|طريق[ةه])[^.?!؟\\n]{0,20})(?:[اإ]ضبط|ضع|حط|[اإ]عمل|سو\\u0651?ي?|جه\\u0651?ز|[اأ]نشئ|سج\\u0651?ل|فع\\u0651?ل) ?ل(?:ي|نا) (?:تذكير|منب[ةه]|تنبيه)",
      "(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? ت(?:ضبط|حط|عمل|سوي|نشئ|سجل)(?: ?ل(?:ي|نا))? (?:تذكير|منب[ةه]|تنبيه)",
      "(?:ممكن|هل يمكنك|يمكنك|بإمكانك|هل تستطيع|الرجاء|رجاء|[اأ]رجو) (?:ضبط|وضع|[اإ]عداد|[اإ]نشاء|عمل|تفعيل) (?:تذكير|منب[ةه]|تنبيه)",
      // "ابعتلي ملخص يومي", "أعطني تقرير أسبوعي": a regular thing sent, though "يومي" alone is also "my day".
      "(?:و|ف)?(?:[اأإ]رسل(?:ي)?|[اإ]بع[ثت](?:ي)?|[اأ]?عط(?:ي)?ني|[اإ]د\\u0651?يني|هات(?:ي)?|جيب(?:ي)?|(?:ممكن|هل (?:يمكنك|تستطيع|بإمكانك|بامكانك|ممكن|تقدر)|يمكنك|بإمكانك|بامكانك|تقدر|تقدري|تقدرين|بتقدر|بتقدري|تستطيع|تستطيعين|[اأ]ريدك|[اأ]ريد|عايزك|عاوزك|عايزاك|عاوزاك|عايز[ةه]?|عاوز[ةه]?|بد\\u0651?ي(?: (?:ياك|[اإ]ياك))?|[اأ]بيك|[اأ]بغاك|[اأ]بغيك|[اأ]بغى|[اأ]بي|حاب|حابب|لو سمحت|لو سمحتي|من فضلك|رجاء|الرجاء|[اأ]رجو|[اأ]رجوك|يا ?ريت|لا تنس(?:ى)?|ما ?تنسى|متنساش)(?: منك| يا فلاش)?(?: [اأ]ن)? ت(?:رسل|بع[ثت]|عطيني|ديني|جيب)(?:ي)?)(?: ?ل(?:ي|نا))? (?:ملخص|تقرير|موجز|نشر[ةه]|تحديث|[اأ]خبار|تذكير|تنبيه|قائم[ةه]|نصيح[ةه]|اقتباس|خلاص[ةه]|رسال[ةه])(?:ا|ا\\u064B|\\u064Bا)? (?:يومي|[اأإ]سبوعي|شهري|صباحي|مسائي)(?:[ةه]|ا|ا\\u064B|\\u064Bا)?",
    ]),
    not: B([
      // Questions ("كم كوب ماء أشرب كل يوم", "هل من الطبيعي…", "كيف أتوقف"), but not "هل يمكنك…" or "كل صباح قل لي ماذا يحدث".
      "^(?:كيف|ازاي|إزاي|شلون|[اإ]شلون|كيفاش|ليش|ليه|لماذا|كم|كام|قديش|قد\\u0651?يش|متى|[اأ]ين|وين|ما هو|ما هي|ماهو|ماهي)",
      "هل(?! (?:يمكنك|تستطيع|تستطيعين|بإمكانك|بامكانك|ممكن ت|من الممكن [اأ]ن ت|تقدر|تقدري|بتقدر))",
      "(?:قل\\u0651? ?لي|قولي|[اأ]?خبرني|[اأ]عرف|بد\\u0651?ي [اأ]عرف|عايز [اأ]عرف|[اأ]ريد [اأ]ن [اأ]عرف|احسب(?: ?لي)?|وضح ?لي|[اإ]شرح ?لي|تعرف) (?:كم|كام|قديش|لماذا|ليش|ليه|كيف|ازاي|شلون|متى)",
      "(?:كم|كام) (?:مر[ةه]|مرات|يجب|ينبغي|لازم|المفروض)",
      "(?:كيف|ازاي|إزاي|شلون|[اإ]شلون|كيفاش|كيفي[ةه]) (?:[اأإآن]\\p{L}{1,12}|ممكن|يمكن|بقدر|نقدر)",
      "لماذا|ليش|ليه",
      "ما (?:هو|هي|معنى|الفرق|[اأ]فضل|[اأ]حسن)|ماهو|ماهي|(?:شو|ايش|إيش|إيه|ايه) (?:هو|هي|الفرق|[اأ]فضل|[اأ]حسن|معنى)",
      "فوائد|[اأ]همي[ةه]|مميزات|عيوب|[اإ]يجابيات|سلبيات|[اأ]ضرار|مضار|[اأآ]ثار|تأثير|تاثير|مزايا|محاسن|(?:من ال)?طبيعي|مضر|ضار|سيئ|سيء",
      "(?:يجب|ينبغي|لازم|المفروض)(?: علي\\u0651?)? (?:[اأإ]ن )?[اأآ](?!ن ?ت)\\p{L}{1,12}",
      "ممكن (?:[اأ](?!ن(?: |$))|ن)\\p{L}{1,12}",
      // "قل لي ماذا آكل كل يوم", not "كل يوم الصبح قولي شو ألبس" (every morning, tell me what to wear).
      "(?=(?:ماذا|ايش|إيش|شو|وش|إيه|ايه) )(?<!^(?:و|ف)?(?:في )?كل [^.?!؟\\n]{0,40}?(?:قل\\u0651? ?لي|قول(?:ي)? ?لي|قولي|[اأ]?خبرني|اقترح ?لي|[اأ]عطني|اعطني)[^.?!؟\\n]{0,20})(?:ماذا|ايش|إيش|شو|وش|إيه|ايه) (?:آكل|اكل|[اأ]عمل|[اأ]فعل|[اأ]سوي|[اأ]شرب|[اأ]لبس|[اأ]طبخ|[اأ]قرأ|اقرا|[اأ]كتب|نعمل|نسوي|نفعل|ناكل|نطبخ)",
      // A habit of mine: "أنا أتحقق من هاتفي كل ساعة", "انا كل يوم بروح الجيم", not "أنا أريدك أن…".
      "(?:أنا|انا)(?: (?:كل|دائما|دايما|عاد[ةه]|غالبا)[^.?!؟\\n]{0,15}?)? (?:عم )?(?:ب(?!د)|[اأ](?!ريد|بي|بغ|حتاج|تمنى|رجو|ود|طلب|نا|ن ت))\\p{L}{1,12}",
      "عاد[ةه]\\u064B? ما|عادتي|من عادتي",
      // A habit of mine right after the schedule: "كل يوم بصحى الساعة 6", "كل شهر أدخر 500", not "كل يوم أرسل لي" or "كل يوم أكتب لي".
      "(?:و|ف)?(?:في )?كل (?:يوم(?: (?:ال)?(?:[اإأ]ثنين|ثلاثاء|[اأ]ربعاء|خميس|جمع[ةه]|سبت|[اأ]حد))?|صباح|صبح|مساء|مسا|ليل[ةه]|[اأإ]سبوع|شهر|ساع[ةه]|سن[ةه]|جمع[ةه]|خميس|سبت)(?: (?:الصبح|الصباح|المسا|المساء|بالليل|الظهر|العصر|تقريبا|تقريب\\u064Bا|تقريبا\\u064B))?(?: [اأ]نا)? (?:عم )?(?:(?:أ(?:ستيقظ|صحو|صحى|ذهب|روح|نام|مشي|ركض|جري|تمرن|تدرب|شرب|دخن|درس|ذاكر|صلي|قر[أا]|شتغل|قضي|شاهد|حس|شعر|تعب|ستخدم|فتح|قوم|خرج|رجع|عود|لعب|طبخ|سوق|ركب|تصل|كلم|ت[أا]خر|نسى|فكر|حاول|ستحم|تابع|كتب|عمل|دفع|صرف|وفر|دخر|عتذر|طبق|مارس|لتزم|تناول)|آكل|آخذ)|ب(?:صحى|صحا|قوم|روح|نام|مشي|ركض|جري|تمرن|شرب|دخن|اكل|درس|ذاكر|صلي|قرا|شتغل|قضي|شوف|حس|تعب|ستخدم|فتح|طلع|رجع|وصل|لعب|طبخ|سوق|ركب|كلم|ت[أا]خر|نسى|فكر|حاول|كتب|شيك|تابع|ضل|ظل|صرف|دفع|حوش|جمع))(?!\\s{0,2}ل(?:ي|نا)(?!\\p{L}))",
      // "ذكرني كيف كنا نلعب", "ذكرني باسم المسلسل": a question about the past, not a reminder.
      "(?:ذك\\u0651?ر(?:ي)?ني|فك\\u0651?ر(?:ي)?ني) (?:كيف|شو|ايش|إيش|ماذا|متى|وين|مين|ليش|لماذا|باسم|اسم|ب[اأ]حداث|بقص[ةه]|بكلمات)",
      // What if I did it: "لو شربت قهوة كل يوم قولي شو بيصير", not "لو سمحت كل يوم ابعتلي".
      "(?:لو|[اإ]ذا) (?!سمحت|تكرمت)(?:[اأ]نا )?(?:\\p{L}{2,8}ت|(?:(?:أ(?:ستيقظ|صحو|صحى|ذهب|روح|نام|مشي|ركض|جري|تمرن|تدرب|شرب|دخن|درس|ذاكر|صلي|قر[أا]|شتغل|قضي|شاهد|حس|شعر|تعب|ستخدم|فتح|قوم|خرج|رجع|عود|لعب|طبخ|سوق|ركب|تصل|كلم|ت[أا]خر|نسى|فكر|حاول|ستحم|تابع|كتب|عمل|دفع|صرف|وفر|دخر|عتذر|طبق|مارس|لتزم|تناول)|آكل|آخذ)|ب(?:صحى|صحا|قوم|روح|نام|مشي|ركض|جري|تمرن|شرب|دخن|اكل|درس|ذاكر|صلي|قرا|شتغل|قضي|شوف|حس|تعب|ستخدم|فتح|طلع|رجع|وصل|لعب|طبخ|سوق|ركب|كلم|ت[أا]خر|نسى|فكر|حاول|كتب|شيك|تابع|ضل|ظل|صرف|دفع|حوش|جمع)))(?!\\p{L})[^.?!؟\\n]{0,30}?(?<!\\p{L})كل(?= )",
      // Comparing habits: "قارن بين المشي كل يوم والجري".
      "بين (?:ال)?\\p{L}{2,12}(?: \\p{L}{2,10})? (?:كل|يومي[\\u064B\\u0651]{0,2}ا\\u064B?|مر[ةه]|مرتين)",
    ]),
    between: B([
      // Someone else does it, or it's a thing to do myself: "أعطني روتين أطبقه كل يوم", "أخبرني صديقي أنه يركض كل صباح",
      // "ابحث عن مطعم مفتوح كل يوم", "دواء آخذه مرة في اليوم", "اكتب لي خطة لقراءة القرآن يوميا".
      "روتين|عاد[ةه]|[اأ]طبق(?:ه|ها)?|[اأ]قدر|[اأ]ستطيع|يمكنني|[اأ]مارس(?:ه|ها)?|[اأ]فعل(?:ه|ها)?|[اأ]قوم|[اأ]لتزم|نقدر|يقدر|يستطيع|[اأ]نه|[اأ]نها|[اإ]نه|[اإ]نها|[اأإ]ني|[اأ]نني|[اإ]نو|انو|[اأ]نا|نحن|[اإ]حنا|[اإ]ذا(?! (?:سمحت|تكرمت|ممكن|[اأ]مكن))|لو(?! (?:سمحت|سمحتي|تكرمت))|عندما|لما|صديقي|صاحبي",
      "كان|كانت|كنا|كنت|كانوا|مفتوح[ةه]?|يفتح|تفتح|يشتغل|تشتغل|يعمل|تعمل|يداوم|تداوم|يؤخذ|تؤخذ|تناوله|تناولها|(?:أ(?:ستيقظ|صحو|صحى|ذهب|روح|نام|مشي|ركض|جري|تمرن|تدرب|شرب|دخن|درس|ذاكر|صلي|قر[أا]|شتغل|قضي|شاهد|حس|شعر|تعب|ستخدم|فتح|قوم|خرج|رجع|عود|لعب|طبخ|سوق|ركب|تصل|كلم|ت[أا]خر|نسى|فكر|حاول|ستحم|تابع|كتب|عمل|دفع|صرف|وفر|دخر|عتذر|طبق|مارس|لتزم|تناول)|آكل|آخذ)(?:ه|ها|هم|ين)?",
      "(?:خط[ةه]|برنامج|جدول|نظام|طريق[ةه])(?: \\p{L}{1,10})? (?:ل|لل)(?:قراء|حفظ|ممارس|تعلم|مذاكر|دراس|شرب|[اأ]كل|خسار|تخسيس|نزول|زياد|تحسين|تمرين|جري|مشي)\\p{L}{0,4}",
    ]),
  },
  fa: {
    recur: B([
      // "هر روز", "هرروز", "هر دوشنبه ساعت ۸", never inside "مهر ماه" (the month Mehr) or "ظهر روز" (noon); "هر روزی که" (any day that)
      // and "برای هر روز هفته" (for each day of the week) aren't one.
      "(?<!(?:برای|برا|واسه|مال|از)[\\s\\u200C])هر[\\s\\u200C]?(?:روز(?:ه)?|صبح|شب|عصر|ظهر|بعد[\\s\\u200C]?از[\\s\\u200C]?ظهر|هفته|ماه|سال|ساعت|دقیقه|(?:(?:یک|دو|سه|س|چهار|پنج)[\\s\\u200C]?شنبه|شنبه|جمعه)|[\\d۰-۹٠-٩]{1,3}[\\s\\u200C](?:ساعت|روز|هفته|دقیقه|ماه)|(?:چند|دو|سه)[\\s\\u200C](?:ساعت|روز|هفته)|نیم[\\s\\u200C]?ساعت|ربع[\\s\\u200C]ساعت)(?:[\\s\\u200C](?:صبح|عصر|شب|ظهر))?(?:[\\s\\u200C]ساعت[\\s\\u200C][\\d۰-۹٠-٩]{1,2}(?:[:.][\\d۰-۹٠-٩]{2})?)?",
      // "روزانه" says when only as an adverb ("روزانه برام بفرست", "اخبار رو روزانه بفرست", "به صورت روزانه"),
      // not after the thing it describes ("گزارش روزانه", "بودجه ماهانه").
      "(?<=(?:^|[،,])\\s{0,2}|(?<!\\p{L})(?:رو|را|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)|لطفا|لطفا\\u064B|به[\\s\\u200C]?صورت|بصورت|به[\\s\\u200C]?طور|بطور)[\\s\\u200C]{1,2})(?:روزانه|هفتگی|ماهانه|ماهیانه|سالانه)",
      "(?:روزی|هفته[\\s\\u200C]?ای|ماهی|سالی)[\\s\\u200C](?:یک|یه|دو|سه|[\\d۰-۹٠-٩]{1,2})[\\s\\u200C]?(?:بار|دفعه|مرتبه)",
      "(?:یک|یه)[\\s\\u200C]?بار[\\s\\u200C](?:در|تو)[\\s\\u200C](?:روز|هفته|ماه|سال)",
      "(?:(?:یک|دو|سه|س|چهار|پنج)[\\s\\u200C]?شنبه|شنبه|جمعه)[\\s\\u200C]?ها",
      "(?:به[\\s\\u200C]?طور|بطور|به[\\s\\u200C]?صورت|بصورت)[\\s\\u200C](?:منظم|مرتب|دوره[\\s\\u200C]?ای)|مرتبا|مرتبا\\u064B",
    ]),
    act: B([
      // Imperatives and "can you …" verbs ("بفرست", "بفرستی", "خلاصه کن"); "بده" only with whom or what ("بهم بده", "رو بده"),
      // since "بده" alone is also "it's bad".
      "بفرست(?:ید|ین|ی|ش|یدش|ینش)?|می[\\s\\u200C]?فرستی|ارسال[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)",
      "(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)|رو|را)[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی|بدهی|می[\\s\\u200C]?دی)|بدهید",
      "بگو|بگید|بگین|بگویید|بگی|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C]می[\\s\\u200C]?گی",
      "یادم[\\s\\u200C](?:بنداز|بندازید|بندازین|بندازی|بیار|بیارید|بیاری)|یاد[\\s\\u200C]?آوری(?:م)?[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)",
      "خبرم[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C])?(?:خبر|اطلاع|پیام)[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)|آگاهم[\\s\\u200C]کن|باخبرم[\\s\\u200C]کن|مطلعم[\\s\\u200C]کن|(?:منو[\\s\\u200C])?در[\\s\\u200C]جریان(?:م)?[\\s\\u200C](?:بذار|بزار|بگذار|بذارید|بگذارید)|نوتیف[\\s\\u200C](?:بده|بفرست)",
      "(?:چک|بررسی|دنبال|دنبالش|پیگیری|جمع|جمع[\\s\\u200C]?آوری|گردآوری|رصد|مانیتور|کنترل|ردیابی|پیدا|جست[\\s\\u200C]?و?[\\s\\u200C]?جو|سرچ|تحقیق|پژوهش|درست|آماده|تهیه|تولید|لیست|فهرست|مقایسه|تحلیل|آنالیز|معرفی|تکرار|تکرارش|خلاصه|خلاصه[\\s\\u200C]?ش|جمع[\\s\\u200C]?بندی)[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)",
      "زیر[\\s\\u200C]نظر[\\s\\u200C](?:بگیر|بگیرید|داشته[\\s\\u200C]باش)|سر[\\s\\u200C]بزن|(?:خلاصه|جمع[\\s\\u200C]?بندی)[\\s\\u200C](?:بگو|بنویس|بفرست)",
      "بنویس(?:ید|ین|ی)?|بگرد(?:ید|ین|ی)?|بیار(?:ید|ین|ی)?|بساز(?:ید|ین|ی)?|(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)|فال)[\\s\\u200C](?:بگیر|بگیرید|بگیرین|بگیری)",
      "(?:پیشنهاد|لیست|نشون|نشونم|نشان|نشانم|انجام|انجامش|یادم|آموزش)[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)",
      // "یه نقل قول انگیزشی می‌خوام": wanting a thing, not "می‌خوام هر روز ورزش کنم" (I want to exercise every day).
      "می[\\s\\u200C]?(?:خوام|خواهم)(?=[\\s\\u200C]{0,2}(?:$|[،,.!؟?]|لطفا|لطفا\\u064B|ممنون))",
    ]),
    strong: B([
      // A reminder with a task or a time: "یادم بنداز فردا به مادرم زنگ بزنم", "هر شب ساعت ۱۰ یادم بنداز", "یادآوری کن که…",
      // not "داستان هملت رو یادم بنداز" (remind me of the plot of Hamlet).
      "(?:یادم[\\s\\u200C](?:بنداز|بندازید|بندازین|بندازی|بیار|بیارید|بیاری)|(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C])?یاد[\\s\\u200C]?آوری(?:م)?[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|یادت[\\s\\u200C](?:باشه|نره)[\\s\\u200C](?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:بگی|یاد[\\s\\u200C]?آوری[\\s\\u200C]کنی))[\\s\\u200C]که(?![^.?!؟\\n]{0,40}?(?<!\\p{L})(?:دیروز|پریروز|دیشب|قبلا|قبلا\\u064B|چی|چه|کی|کجا|چرا|چطور|کدوم|بود|بودیم|بودم|زدیم|گفتم|گفتی|کردیم)(?!\\p{L}))",
      // Not a question about the past: "یادم بنداز اسم اون سریالی که هر شب پخش می‌شد چی بود".
      "(?:یادم[\\s\\u200C](?:بنداز|بندازید|بندازین|بندازی|بیار|بیارید|بیاری)|(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C])?یاد[\\s\\u200C]?آوری(?:م)?[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|یادت[\\s\\u200C](?:باشه|نره)[\\s\\u200C](?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:بگی|یاد[\\s\\u200C]?آوری[\\s\\u200C]کنی))(?:(?!(?<!\\p{L})(?:که|چی|چه|کی|کدوم|کجا|اسم|بود|بودیم|می[\\s\\u200C]?شد|دیروز|دیشب)(?!\\p{L}))[^.?!؟\\n]){0,60}?(?<!\\p{L})(?:فردا|پس[\\s\\u200C]?فردا|امشب|امروز[\\s\\u200C](?:عصر|ساعت|بعدازظهر|شب)|ساعت[\\s\\u200C][\\d۰-۹٠-٩]{1,2}|هر[\\s\\u200C]?(?:روز|صبح|شب|هفته|ماه|ساعت|(?:(?:یک|دو|سه|س|چهار|پنج)[\\s\\u200C]?شنبه|شنبه|جمعه))|[\\d۰-۹٠-٩]{1,3}[\\s\\u200C](?:ساعت|دقیقه|روز)[\\s\\u200C](?:دیگه|دیگر|بعد)|(?:یه|یک|نیم|دو|سه)[\\s\\u200C](?:ساعت|روز|هفته)[\\s\\u200C](?:دیگه|دیگر|بعد)|(?:هفته|ماه)[\\s\\u200C](?:بعد|دیگه|آینده)|(?:آخر|اول)[\\s\\u200C](?:ماه|هفته)|صبح|عصر|شب|ظهر|(?:(?:یک|دو|سه|س|چهار|پنج)[\\s\\u200C]?شنبه|شنبه|جمعه))(?![\\p{L}\\p{N}])",
      "(?<!\\p{L})(?:فردا|پس[\\s\\u200C]?فردا|امشب|امروز[\\s\\u200C](?:عصر|ساعت|بعدازظهر|شب)|ساعت[\\s\\u200C][\\d۰-۹٠-٩]{1,2}|هر[\\s\\u200C]?(?:روز|صبح|شب|هفته|ماه|ساعت|(?:(?:یک|دو|سه|س|چهار|پنج)[\\s\\u200C]?شنبه|شنبه|جمعه))|[\\d۰-۹٠-٩]{1,3}[\\s\\u200C](?:ساعت|دقیقه|روز)[\\s\\u200C](?:دیگه|دیگر|بعد)|(?:یه|یک|نیم|دو|سه)[\\s\\u200C](?:ساعت|روز|هفته)[\\s\\u200C](?:دیگه|دیگر|بعد)|(?:هفته|ماه)[\\s\\u200C](?:بعد|دیگه|آینده)|(?:آخر|اول)[\\s\\u200C](?:ماه|هفته)|صبح|عصر|شب|ظهر|(?:(?:یک|دو|سه|س|چهار|پنج)[\\s\\u200C]?شنبه|شنبه|جمعه))(?![\\p{L}\\p{N}])[^.?!؟\\n]{0,40}?(?:یادم[\\s\\u200C](?:بنداز|بندازید|بندازین|بندازی|بیار|بیارید|بیاری)|(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C])?یاد[\\s\\u200C]?آوری(?:م)?[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|یادت[\\s\\u200C](?:باشه|نره)[\\s\\u200C](?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:بگی|یاد[\\s\\u200C]?آوری[\\s\\u200C]کنی))",
      "(?:یادم[\\s\\u200C](?:بنداز|بندازید|بندازین|بندازی|بیار|بیارید|بیاری)|(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C])?یاد[\\s\\u200C]?آوری(?:م)?[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|یادت[\\s\\u200C](?:باشه|نره)[\\s\\u200C](?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:بگی|یاد[\\s\\u200C]?آوری[\\s\\u200C]کنی))[^.?!؟\\n]{0,50}?(?<!\\p{L})(?:کنم|بکنم|بخورم|بنوشم|بخوابم|بزنم|برم|بدم|بگیرم|بخونم|بخوانم|بشم|باشم|بخرم|ببینم|بنویسم|بپوشم|بپزم|بذارم|بگذارم|بمونم|بیام|بیارم|بفرستم|بپردازم)",
      // "Tell me when" with a future event: "هر وقت آیفون جدید اومد خبرم کن", "اگه بیت‌کوین زیر ۵۰ هزار رفت بهم بگو",
      // not "بهم بگو جنگ کی تموم شد" or "اگه دلار بالا بره بهم بگو چی میشه".
      "(?=(?:خبرم[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:خبر|اطلاع|پیام)[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)|اطلاع[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:بگو|بگید|بگین|بگی)|آگاهم[\\s\\u200C]کن|باخبرم[\\s\\u200C]کن|مطلعم[\\s\\u200C]کن|نوتیف[\\s\\u200C](?:بده|بفرست)|در[\\s\\u200C]جریانم[\\s\\u200C](?:بذار|بزار|بگذار)))(?<=(?<![\\p{L}\\p{M}\\p{N}])(?:هر[\\s\\u200C]?وقت|هر[\\s\\u200C]بار(?:[\\s\\u200C]که)?|وقتی(?:[\\s\\u200C]?که)?|اگه|اگر|به[\\s\\u200C]محض[\\s\\u200C](?:اینکه|این[\\s\\u200C]که)|همین[\\s\\u200C]که|زمانی[\\s\\u200C]که|موقعی[\\s\\u200C]که)[\\s\\u200C](?:(?!(?<!\\p{L})(?:چی|چه|چرا|چطور|چطوری|چند|کدوم|کدام|آیا|کی|چیکار|چکار|کجا)(?!\\p{L}))[^.?!؟\\n]){0,60}(?<!\\p{L})(?:اومد|آمد|بیاد|بیاید|اومدن|رسید|برسه|برسد|(?:منتشر|عرضه|رونمایی|کم|زیاد|ارزون|ارزان|گرون|گران|موجود|باز|شروع|اعلام|عوض)[\\s\\u200C](?:شد|بشه|شود|شدن|میشه|می[\\s\\u200C]?شه)|(?:پایین|بالا)(?:[\\s\\u200C]?تر)?[\\s\\u200C](?:اومد|آمد|بیاد|بیاید|رفت|بره|برود|شد|بشه)|(?:کمتر|بیشتر|ارزون[\\s\\u200C]?تر|ارزانتر|گرون[\\s\\u200C]?تر|گرانتر)[\\s\\u200C](?:شد|بشه|شود)|تغییر[\\s\\u200C](?:کرد|کنه|کند)|(?:کمتر|بیشتر|پایین[\\s\\u200C]?تر|بالاتر)[\\s\\u200C]از|زیر[\\s\\u200C][\\d۰-۹٠-٩]{1,9}|بالای[\\s\\u200C][\\d۰-۹٠-٩]{1,9})(?![\\p{L}\\p{N}])(?:(?!(?<!\\p{L})(?:چی|چه|چرا|چطور|چطوری|چند|کدوم|کدام|آیا|کی|چیکار|چکار|کجا)(?!\\p{L}))[^.?!؟\\n]){0,40})(?:خبرم[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:خبر|اطلاع|پیام)[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)|اطلاع[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:بگو|بگید|بگین|بگی)|آگاهم[\\s\\u200C]کن|باخبرم[\\s\\u200C]کن|مطلعم[\\s\\u200C]کن|نوتیف[\\s\\u200C](?:بده|بفرست)|در[\\s\\u200C]جریانم[\\s\\u200C](?:بذار|بزار|بگذار))(?![^.?!؟\\n]{0,80}?(?<!\\p{L})(?:چی|چه|چرا|چطور|چطوری|چند|کدوم|کدام|آیا|کی|چیکار|چکار|کجا)(?!\\p{L}))",
      "(?:خبرم[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:خبر|اطلاع|پیام)[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)|اطلاع[\\s\\u200C](?:بده|بدید|بدین|بدهید|بدی)|(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C](?:بگو|بگید|بگین|بگی)|آگاهم[\\s\\u200C]کن|باخبرم[\\s\\u200C]کن|مطلعم[\\s\\u200C]کن|نوتیف[\\s\\u200C](?:بده|بفرست)|در[\\s\\u200C]جریانم[\\s\\u200C](?:بذار|بزار|بگذار))(?![^.?!؟\\n]{0,80}?(?<!\\p{L})(?:چی|چه|چرا|چطور|چطوری|چند|کدوم|کدام|آیا|کی|چیکار|چکار|کجا)(?!\\p{L}))(?:[\\s\\u200C]که)?[\\s\\u200C](?:هر[\\s\\u200C]?وقت|هر[\\s\\u200C]بار(?:[\\s\\u200C]که)?|وقتی(?:[\\s\\u200C]?که)?|اگه|اگر|به[\\s\\u200C]محض[\\s\\u200C](?:اینکه|این[\\s\\u200C]که)|همین[\\s\\u200C]که|زمانی[\\s\\u200C]که|موقعی[\\s\\u200C]که)[\\s\\u200C][^.?!؟\\n]{0,60}?(?<!\\p{L})(?:اومد|آمد|بیاد|بیاید|اومدن|رسید|برسه|برسد|(?:منتشر|عرضه|رونمایی|کم|زیاد|ارزون|ارزان|گرون|گران|موجود|باز|شروع|اعلام|عوض)[\\s\\u200C](?:شد|بشه|شود|شدن|میشه|می[\\s\\u200C]?شه)|(?:پایین|بالا)(?:[\\s\\u200C]?تر)?[\\s\\u200C](?:اومد|آمد|بیاد|بیاید|رفت|بره|برود|شد|بشه)|(?:کمتر|بیشتر|ارزون[\\s\\u200C]?تر|ارزانتر|گرون[\\s\\u200C]?تر|گرانتر)[\\s\\u200C](?:شد|بشه|شود)|تغییر[\\s\\u200C](?:کرد|کنه|کند)|(?:کمتر|بیشتر|پایین[\\s\\u200C]?تر|بالاتر)[\\s\\u200C]از|زیر[\\s\\u200C][\\d۰-۹٠-٩]{1,9}|بالای[\\s\\u200C][\\d۰-۹٠-٩]{1,9})(?![\\p{L}\\p{N}])",
      // "یه یادآور برام بذار", not "چطور یادآور بذارم".
      "(?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C])?(?:یه|یک)?[\\s\\u200C]?(?:یادآور|یادآوری|ریمایندر|آلارم)[\\s\\u200C](?:(?:بهم|به[\\s\\u200C]من|بم|برام|برایم|برای[\\s\\u200C]من|واسم|واسه[\\s\\u200C]من|به[\\s\\u200C]ما|بهمون|برامون)[\\s\\u200C])?(?:بذار|بزار|بگذار|بذارید|بگذارید|تنظیم[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|بساز|بسازید|ست[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید))",
      // "یه خلاصه روزانه از اخبار برام بفرست", "یه گزارش هفتگی می‌خوام".
      "(?:یه|یک)[\\s\\u200C](?:خلاصه|گزارش|خبرنامه|آپدیت|به[\\s\\u200C]?روزرسانی|یادآوری|لیست|فهرست|نکته|نقل[\\s\\u200C]?قول|جمله|پیام|فال|جوک)(?:[\\s\\u200C]?ی)?[\\s\\u200C](?:روزانه|هفتگی|ماهانه|ماهیانه)[^.?!؟\\n]{0,50}?(?<!\\p{L})(?:بفرست|بفرستید|بفرستین|بفرستی|ارسال[\\s\\u200C](?:کن|کنید|کنین|کنی|بکن|بکنید)|(?:بده|بدید|بدین|بدهید|بدی)|می[\\s\\u200C]?(?:خوام|خواهم)|بگو)",
    ]),
    not: B([
      // Questions ("چرا", "چقدر", "روزی چند بار", "چی بخورم", "خوبه؟"), but not "آیا می‌تونی…" or "هوا چطوره".
      "چرا|چقدر|چه[\\s\\u200C]?قدر|چند[\\s\\u200C]?(?:بار|مرتبه|دفعه|لیوان|کالری)|چند[\\s\\u200C]وقت[\\s\\u200C](?:یک|یه)[\\s\\u200C]?بار|هر[\\s\\u200C]چند[\\s\\u200C]وقت",
      "چطور|چطوری|چگونه|چجوری|چه[\\s\\u200C]?جوری",
      // "معنی «هر روز» چیه", not "هر روز یه لغت با معنی برام بفرست".
      "چیه|چیست|چی[\\s\\u200C]هست|یعنی[\\s\\u200C](?:چی|چه)|(?=معنی|معنای)(?<!(?:با|و|همراه)[\\s\\u200C])(?:معنی|معنای)|فرق|تفاوت",
      "فواید|فوائد|اهمیت|فایده|فایده[\\s\\u200C]?های|مزایا|مزایای|معایب|عوارض|ضرر|ضررهای|مضرات|خواص|اثرات|تاثیر|تأثیر",
      "[آا]یا(?![\\s\\u200C](?:می[\\s\\u200C]?(?:تونی|توانی|تونید|توانید)|میشه|می[\\s\\u200C]شه|ممکنه|ممکن[\\s\\u200C]است|امکانش|امکان[\\s\\u200C]دار))",
      "خوبه|طبیعیه|عادیه|(?:طبیعی|عادی|خوب|بد|مضر|مفید|لازم|کافی)[\\s\\u200C](?:است|هست)|درسته|ضرر[\\s\\u200C]دار(?:ه|د)|مضره|مفیده|لازمه|کافیه|اشکال[\\s\\u200C]دار(?:ه|د)|ایرادی[\\s\\u200C]دار(?:ه|د)",
      "باید[^.?!؟\\n]{0,40}?(?<!\\p{L})(?:کنم|بکنم|بخورم|بنوشم|بخوابم|بزنم|برم|بدم|بگیرم|بخونم|بخوانم|بشم|باشم|بخرم|ببینم|بنویسم|بپوشم|بپزم|بذارم|بگذارم|بمونم|بیام|بیارم|بفرستم|بپردازم)",
      // "بهم بگو هر روز چی بخورم", not "هر روز صبح بهم بگو چی بپوشم" (every morning, tell me what to wear).
      "(?=چی|چه|کدوم|کدام)(?<!^(?:لطفا|لطفا\\u064B)?[\\s\\u200C]?هر[\\s\\u200C]?\\p{L}{2,8}[^.?!؟\\n]{0,40}?(?:بگو|بگید|بگین|بگی)[^.?!؟\\n]{0,20})(?:چی|چه|کدوم|کدام)[\\s\\u200C](?:\\p{L}{1,10}[\\s\\u200C]){0,2}?(?:کنم|بکنم|بخورم|بنوشم|بخوابم|بزنم|برم|بدم|بگیرم|بخونم|بخوانم|بشم|باشم|بخرم|ببینم|بنویسم|بپوشم|بپزم|بذارم|بگذارم|بمونم|بیام|بیارم|بفرستم|بپردازم)|چیکار|چکار|چه[\\s\\u200C]?کار",
      // A habit of mine: "هر ساعت گوشیمو چک می‌کنم", "هر دوشنبه باشگاه می‌رم", not "خواهش می‌کنم" or "ممنون می‌شم".
      "(?=ن?می)(?<!(?:که|وقتی|موقعی|زمانی)[^.?!؟\\n]{0,20})(?<!(?:خواهش|تشکر)[\\s\\u200C]{1,2})ن?می[\\s\\u200C]?(?!خوا|شم|شوم)\\p{L}{1,10}م",
      // "هر روز ساعت ۶ بیدار میشم، …", not "ممنون میشم" or "هر روز ساعت ۸ که پا میشم …".
      "(?=می)(?<!(?:که|وقتی|موقعی|زمانی)[^.?!؟\\n]{0,20})(?<!(?:ممنون|ممنونت|ممنونتون|خوشحال|سپاسگزار|متشکر|مچکر)[\\s\\u200C]{1,2})می[\\s\\u200C]?شم(?=\\s{0,2}[،,])",
      // Something I'd do each time: "یه برنامه بهم بده که هر روز انجام بدم", not "اخبار رو بفرست که بخونم".
      "(?:که|تا)[\\s\\u200C][^.?!؟\\n]{0,20}?(?<!\\p{L})هر[\\s\\u200C]?\\p{L}{2,8}[^.?!؟\\n]{0,30}?(?<!\\p{L})(?:کنم|بکنم|بخورم|بنوشم|بخوابم|بزنم|برم|بدم|بگیرم|بخونم|بخوانم|بشم|باشم|بخرم|ببینم|بنویسم|بپوشم|بپزم|بذارم|بگذارم|بمونم|بیام|بیارم|بفرستم|بپردازم)",
      "(?:عبارت|اصطلاح)[\\s\\u200C](?:ی[\\s\\u200C])?(?:«|هر)",
      // What if I did it: "اگه هر روز قهوه بخورم بهم بگو چی میشه".
      "(?:اگه|اگر)[\\s\\u200C][^.?!؟\\n]{0,40}?(?<!\\p{L})(?:کنم|بکنم|بخورم|بنوشم|بخوابم|بزنم|برم|بدم|بگیرم|بخونم|بخوانم|بشم|باشم|بخرم|ببینم|بنویسم|بپوشم|بپزم|بذارم|بگذارم|بمونم|بیام|بیارم|بفرستم|بپردازم)",
      // "یادم بنداز اسم اون سریال چی بود": a question, not a reminder.
      "یادم[\\s\\u200C](?:بنداز|بندازید|بندازین|بندازی|بیار|بیارید|بیاری)[\\s\\u200C](?:اسم|چی|چه|کی|کدوم|کدام|کجا|چطور|چرا)",
      // A thing that runs or is done each day, asked for once: "یه رستوران پیدا کن که هر روز تا ۲ بازه", "یه دارو معرفی کن که روزی یه بار بخورم".
      "(?:کن|کنید|کنین|بده|بدید|بدین|بنویس|بنویسید|بگو|بگید|بفرست|بساز|بسازید)[\\s\\u200C]که[\\s\\u200C](?:\\p{L}{1,12}[\\s\\u200C]){0,3}?(?:هر[\\s\\u200C]?\\p{L}{2,8}|روزی|هفته[\\s\\u200C]?ای|ماهی)(?!\\p{L})",
      // "یه برنامه برای خوندن قرآن هر روز بنویس": the schedule of what I do.
      "(?:برای|برا|واسه)[\\s\\u200C]\\p{L}{1,10}(?:دن|تن)(?:[\\s\\u200C]\\p{L}{1,10}){0,2}[\\s\\u200C]هر[\\s\\u200C]?\\p{L}{2,8}",
    ]),
    between: B([
      // Something to do myself: "یه روتین بهم بده که بتونم هر روز انجامش بدم".
      "بتونم|بتوانم|می[\\s\\u200C]?(?:تونم|توانم)|اگه|اگر|وقتی|روتین|عادت|خودم",
    ]),
  },
  he: {
    recur: B([
      // "כל בוקר", "בכל יום", "מדי שבוע", "כל יום שני ב-8"; never "כל היום" (all day) or "לכל יום" (for each day).
      "(?:ו|ב|וב|ש|שב)?(?:כל|מדי|מידי) (?:יום(?: (?:ראשון|שני|שלישי|רביעי|חמישי|שישי))?|בוקר|ערב|לילה|צהריים|שבוע|חודש|שעה|שנה|שבת|יומיים|שבועיים|חודשיים|שעתיים|חצי שעה|רבע שעה|\\d{1,3} (?:שעות|ימים|דקות|שבועות|חודשים)|כמה (?:שעות|ימים|שבועות|דקות))(?: ב(?:שעה )?-?\\d{1,2}(?::\\d{2})?(?: (?:בבוקר|בערב|בלילה|בצהריים))?| בבוקר| בערב| בלילה)?",
      "(?:פעם|פעמיים|\\d{1,2} פעמים) ב(?:יום|שבוע|חודש|שנה|שעה|יומיים|שבועיים|חודשיים|\\d{1,3} (?:ימים|שעות|שבועות))",
      // "יומי", "שבועי" describe a thing ("דוח שבועי") and sit inside "יומיים", "חודשיים" (two days, two months): only as "באופן יומי".
      "באופן (?:יומי|שבועי|חודשי|קבוע|שוטף)|על בסיס (?:יומי|שבועי|חודשי|קבוע)",
      "בימי (?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|בשבתות|בסופי שבוע",
    ]),
    act: B([
      // Imperatives, and the future used as one ("תשלח לי", "תבדקי"); "שלח", "עדכן" not after a subject ("החבר שלי שלח לי": he sent).
      "(?:ו|ש|וש)?(?:תשלח|תשלחי|תשלחו|תעביר|תעבירי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))(?:ו)?(?:שלח|שלחי|שלחו|העבר)(?: לי| לנו| אליי| אלי| אותי| אותנו)?",
      "(?:ו)?(?:תן|תני|תנו) (?:לי|לנו)|(?:ו|ש)?(?:תביא|תביאי|תביאו|תספק|תספקי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?|(?:הבא|הביאי) לי",
      "(?:ו|ש)?(?:תגיד|תגידי|תגידו|תספר|תספרי|תספרו) (?:לי|לנו)|(?:ו|ש)?(?:תודיע|תודיעי|תודיעו|תעדכן|תעדכני|תעדכנו|תיידע|תיידעי|תתריע|תתריעי|תדווח|תדווחי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?",
      "(?:אמור|אמרי|ספר|ספרי|הודע|הודיעי|התרע|דווח) לי|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))(?:עדכן|עדכני|עדכנו|יידע|ידע) אותי",
      "(?:ו|ש)?(?:תזכיר|תזכירי|תזכירו) (?:לי|לנו)|(?:הזכר|הזכירי) לי",
      // Check, follow, look up, sum up; "סכם" never inside "הסכם" (a contract).
      "(?:ו|ש)?(?:תבדוק|תבדקי|תבדקו|תעקוב|תעקבי|תעקבו|תחפש|תחפשי|תחפשו|תמצא|תמצאי|תמצאו|תסרוק|תסרקי|תנטר|תנטרי|תשגיח|תשגיחי|תסכם|תסכמי|תסכמו|תמצת|תמצתי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?",
      "(?:ו)?(?:בדוק|בדקי|בדקו|עקוב|עקבי|עקבו|חפש|חפשי|חפשו|סרוק|נטר|סכם|סכמי|סכמו)(?: לי| לנו| אליי| אלי| אותי| אותנו)?",
      "(?:ו|ש)?(?:תכתוב|תכתבי|תכתבו|תנסח|תנסחי|תכין|תכיני|תכינו|תיצור|תיצרי|תייצר|תייצרי|תבנה|תבני|תרכיב|תרכיבי|תארגן|תארגני|תשווה|תשווי|תנתח|תנתחי|תפרט|תפרטי|תרשום|תרשמי|תמליץ|תמליצי|תציע|תציעי|תאסוף|תאספי|תרכז|תרכזי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?",
      "(?:ו)?(?:כתוב|כתבי|כתבו|נסח|נסחי|הכן|הכיני|צור|צרי|ארגן|הראה|הראי) (?:לי|לנו)|(?:ו|ש)?(?:תראה|תראי) (?:לי|לנו)|(?:המלץ|הצע) (?:לי|על)",
      "(?:ו|ש)?(?:תעשה|תעשי|תעשו) (?:לי|את זה|זאת|את אותו דבר)|(?:ו|ש)?(?:תחזור|תחזרי) על זה",
      // "אתה יכול לשלוח לי…", "תוכלי לבדוק…", "אפשר לשלוח לי…" ("אפשר לבדוק…" alone also asks whether one may).
      "(?:אתה יכול|את יכולה|אתם יכולים|תוכל|תוכלי|תוכלו|בבקשה|נא|אל תשכח|אל תשכחי|תדאג|תדאגי|תזכור|תזכרי) (?:בבקשה )?(?:לשלוח|לתת|לספר|להגיד|לעדכן|להודיע|להזכיר|לבדוק|לעקוב|לחפש|למצוא|לסכם|לתמצת|לכתוב|לנסח|להכין|לנטר|להשוות|לנתח|להמליץ|להציע|להביא|להראות|לרכז|לאסוף|לדווח|להתריע|ליידע|לרשום|לפרט)|אפשר (?:לשלוח|לתת|לספר|להגיד|לעדכן|להודיע|להזכיר|לבדוק|לעקוב|לחפש|למצוא|לסכם|לתמצת|לכתוב|לנסח|להכין|לנטר|להשוות|לנתח|להמליץ|להציע|להביא|להראות|לרכז|לאסוף|לדווח|להתריע|ליידע|לרשום|לפרט)(?: לי| לנו| אותי)",
      "(?:אני )?(?:רוצה|רוצים|מעוניין|מעוניינת|צריך|צריכה|אשמח|הייתי רוצה) לקבל|(?:אני )?(?:רוצה|רוצים|מבקש|מבקשת|צריך|צריכה) (?:סיכום|דוח|דו\"ח|עדכון|עדכונים|תזכורת|התראה|חדשות|רשימה|ציטוט|טיפ|בדיחה|תקציר)",
    ]),
    strong: B([
      // A reminder with a task or a time: "תזכיר לי לשלם", "תזכיר לי מחר ב-8", "מחר בבוקר תזכירי לי",
      // not "תזכיר לי מה העלילה של המלט".
      "(?:(?:ו|ש|וש)?(?:תזכיר|תזכירי|תזכירו) (?:לי|לנו)|הזכר לי|הזכירי לי|(?:אתה יכול|את יכולה|אתם יכולים|תוכל|תוכלי|תוכלו|בבקשה|נא|אל תשכח|אל תשכחי|תדאג|תדאגי|תזכור|תזכרי) (?:בבקשה )?להזכיר (?:לי|לנו)|אפשר להזכיר (?:לי|לנו)) ל(?!מה|גבי|פי|אן|כן|ך|כם|איזה|איזו|אילו|מי(?!\\p{L}))\\p{L}{2,12}",
      "(?:(?:ו|ש|וש)?(?:תזכיר|תזכירי|תזכירו) (?:לי|לנו)|הזכר לי|הזכירי לי|(?:אתה יכול|את יכולה|אתם יכולים|תוכל|תוכלי|תוכלו|בבקשה|נא|אל תשכח|אל תשכחי|תדאג|תדאגי|תזכור|תזכרי) (?:בבקשה )?להזכיר (?:לי|לנו)|אפשר להזכיר (?:לי|לנו)) ש(?:אני|אנחנו|יש לי|צריך|צריכה|מחר|היום|בעוד|ב\\p{L}{1,12}|ל\\p{L}{1,12})",
      // Not a question about the past: "תזכיר לי איך קראו לתוכנית שהייתה משודרת כל ערב".
      "(?:(?:ו|ש|וש)?(?:תזכיר|תזכירי|תזכירו) (?:לי|לנו)|הזכר לי|הזכירי לי|(?:אתה יכול|את יכולה|אתם יכולים|תוכל|תוכלי|תוכלו|בבקשה|נא|אל תשכח|אל תשכחי|תדאג|תדאגי|תזכור|תזכרי) (?:בבקשה )?להזכיר (?:לי|לנו)|אפשר להזכיר (?:לי|לנו))(?:(?!(?<!\\p{L})(?:איך|מה|מי|מתי|למה|איפה|איזה|איזו|היה|הייתה|היו|שהיה|שהייתה|שהיו|קראו|אתמול|שעבר)(?!\\p{L}))[^.?!\\n]){0,60}?(?<!\\p{L})(?:מחר|מחרתיים|הערב|הלילה|בעוד (?:שעה|שעתיים|יום|יומיים|שבוע|חודש|רבע שעה|חצי שעה|\\d{1,3})|בשעה \\d{1,2}|ב-?\\d{1,2}(?::\\d{2})?|ביום (?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|בשבת|בשבוע הבא|שבוע הבא|בחודש הבא|בסוף (?:החודש|השבוע)|בתחילת (?:החודש|השבוע)|(?:ו|ב|וב)?(?:כל|מדי) (?:יום|בוקר|ערב|לילה|שבוע|חודש|שעה|שנה)|בבוקר|בערב|בצהריים|בלילה)(?![\\p{L}\\p{N}])",
      "(?<!\\p{L})(?:מחר|מחרתיים|הערב|הלילה|בעוד (?:שעה|שעתיים|יום|יומיים|שבוע|חודש|רבע שעה|חצי שעה|\\d{1,3})|בשעה \\d{1,2}|ב-?\\d{1,2}(?::\\d{2})?|ביום (?:ראשון|שני|שלישי|רביעי|חמישי|שישי)|בשבת|בשבוע הבא|שבוע הבא|בחודש הבא|בסוף (?:החודש|השבוע)|בתחילת (?:החודש|השבוע)|(?:ו|ב|וב)?(?:כל|מדי) (?:יום|בוקר|ערב|לילה|שבוע|חודש|שעה|שנה)|בבוקר|בערב|בצהריים|בלילה)(?![\\p{L}\\p{N}])[^.?!\\n]{0,40}?(?<!\\p{L})(?:(?:ו|ש|וש)?(?:תזכיר|תזכירי|תזכירו) (?:לי|לנו)|הזכר לי|הזכירי לי|(?:אתה יכול|את יכולה|אתם יכולים|תוכל|תוכלי|תוכלו|בבקשה|נא|אל תשכח|אל תשכחי|תדאג|תדאגי|תזכור|תזכרי) (?:בבקשה )?להזכיר (?:לי|לנו)|אפשר להזכיר (?:לי|לנו))",
      // "Tell me when" with a future event: "תודיע לי כשהאייפון החדש יוצא", "אם הביטקוין יורד מתחת ל-50 אלף תעדכן אותי",
      // not "תגיד לי מתי נגמרה המלחמה".
      "(?:(?:ו|ש)?(?:תודיע|תודיעי|תודיעו|תעדכן|תעדכני|תעדכנו|תתריע|תתריעי|תגיד|תגידי|תגידו|תשלח|תשלחי|תיידע|תיידעי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?|הודע לי|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))עדכן אותי|עדכני אותי|התרע לי|אמור לי|אמרי לי|ספר לי|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))שלח לי)(?![^.?!\\n]{0,80}?(?<!\\p{L})(?:מה|איך|למה|כמה|האם|מתי|איזה|איזו|כבר)(?!\\p{L})) (?:כש|כאשר |ברגע ש|מיד כש|אם (?!אפשר)|מתי ש|אחרי ש)(?:[^.?!\\n]{0,60}?(?<!\\p{L}))?(?:ש|ה|כש|כשה|ו)?(?:יוצא|יוצאת|יוצאים|יצא|תצא|ייצא|ירד|יורד|יורדת|תרד|ירדו|יעלה|עולה|תעלה|עלה|ישתנה|תשתנה|השתנה|משתנה|יגיע|מגיע|תגיע|הגיע|יתפרסם|מתפרסם|תתפרסם|פורסם|יושק|מושק|תושק|הושק|ייפתח|נפתח|תיפתח|יוכרז|הוכרז|מוכרז|יחזור|חוזר|תחזור|חזר|יוזל|הוזל|מוזל|יתחיל|מתחיל|תתחיל|התחיל|ישוחרר|שוחרר|יהיה זמין|תהיה זמינה|יהיו זמינים|זמין|זמינה|זמינים|זמינות|במלאי|במבצע|בהנחה|מתחת ל-?\\d{0,9}|מעל ל-?\\d{0,9}|פחות מ-?\\d{0,9}|יותר מ-?\\d{0,9}|זול יותר|יקר יותר)(?![\\p{L}\\p{N}])",
      "(?=(?:(?:ו|ש)?(?:תודיע|תודיעי|תודיעו|תעדכן|תעדכני|תעדכנו|תתריע|תתריעי|תגיד|תגידי|תגידו|תשלח|תשלחי|תיידע|תיידעי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?|הודע לי|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))עדכן אותי|עדכני אותי|התרע לי|אמור לי|אמרי לי|ספר לי|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))שלח לי))(?<=(?<![\\p{L}\\p{M}\\p{N}])(?:כש|כאשר |ברגע ש|מיד כש|אם (?!אפשר)|מתי ש|אחרי ש)(?:(?:(?!(?<!\\p{L})(?:מה|איך|למה|כמה|האם|מתי|איזה|איזו|כבר)(?!\\p{L}))[^.?!\\n]){0,60}(?<!\\p{L}))?(?:ש|ה|כש|כשה|ו)?(?:יוצא|יוצאת|יוצאים|יצא|תצא|ייצא|ירד|יורד|יורדת|תרד|ירדו|יעלה|עולה|תעלה|עלה|ישתנה|תשתנה|השתנה|משתנה|יגיע|מגיע|תגיע|הגיע|יתפרסם|מתפרסם|תתפרסם|פורסם|יושק|מושק|תושק|הושק|ייפתח|נפתח|תיפתח|יוכרז|הוכרז|מוכרז|יחזור|חוזר|תחזור|חזר|יוזל|הוזל|מוזל|יתחיל|מתחיל|תתחיל|התחיל|ישוחרר|שוחרר|יהיה זמין|תהיה זמינה|יהיו זמינים|זמין|זמינה|זמינים|זמינות|במלאי|במבצע|בהנחה|מתחת ל-?\\d{0,9}|מעל ל-?\\d{0,9}|פחות מ-?\\d{0,9}|יותר מ-?\\d{0,9}|זול יותר|יקר יותר)(?![\\p{L}\\p{N}])(?:(?!(?<!\\p{L})(?:מה|איך|למה|כמה|האם|מתי|איזה|איזו|כבר)(?!\\p{L}))[^.?!\\n]){0,40})(?<!\\p{L})(?:(?:ו|ש)?(?:תודיע|תודיעי|תודיעו|תעדכן|תעדכני|תעדכנו|תתריע|תתריעי|תגיד|תגידי|תגידו|תשלח|תשלחי|תיידע|תיידעי)(?: לי| לנו| אליי| אלי| אותי| אותנו)?|הודע לי|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))עדכן אותי|עדכני אותי|התרע לי|אמור לי|אמרי לי|ספר לי|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))שלח לי)(?![^.?!\\n]{0,80}?(?<!\\p{L})(?:מה|איך|למה|כמה|האם|מתי|איזה|איזו|כבר)(?!\\p{L}))",
      // "תגדיר לי תזכורת", not "איך אפשר להגדיר תזכורת".
      "(?:ו|ש)?(?:תגדיר|תגדירי|תקבע|תקבעי|תיצור|תצרי|תשים|תשימי|תעשה|תעשי|תכין|תכיני)(?: לי)? (?:תזכורת|התראה)|(?:הגדר|קבע|צור|שים) (?:לי )?(?:תזכורת|התראה)",
      "(?<!(?:איך|כיצד) )(?:(?:אתה יכול|את יכולה|אתם יכולים|תוכל|תוכלי|תוכלו|בבקשה|נא|אל תשכח|אל תשכחי|תדאג|תדאגי|תזכור|תזכרי) (?:בבקשה )?|אפשר )(?:להגדיר|לקבוע|ליצור|לשים) לי (?:תזכורת|התראה)|(?<!(?:איך|כיצד) )(?:אתה יכול|את יכולה|אתם יכולים|תוכל|תוכלי|תוכלו|בבקשה|נא|אל תשכח|אל תשכחי|תדאג|תדאגי|תזכור|תזכרי) (?:בבקשה )?(?:להגדיר|לקבוע|ליצור|לשים) (?:תזכורת|התראה)",
      // "שלח לי סיכום שבועי", "אני רוצה לקבל דוח יומי": a regular thing sent, not "תשלח לי את הדוח השבועי".
      "(?:(?:ו|ש)?(?:תשלח|תשלחי|תשלחו|תן|תני|תביא|תביאי)(?: לי| לנו)?|(?=ו?(?:שלח|העבר|עדכן|יידע|ידע))(?:(?<=^|[,،]\\s{0,2}|(?<!\\p{L})(?:בבקשה|אנא|נא|פשוט|רק|גם|אז|עכשיו|מעכשיו|מהיום|היי|הי|תודה|יאללה|יאלה|אפשר|פלאש|בוקר|ערב|לילה|יום|שבוע|חודש|שעה|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|בבוקר|בערב|בלילה|בצהריים|צהריים|מחר|היום|הערב|הלילה|שעות|ימים|דקות|שבועות|חודשים|יומיים|שבועיים|שעתיים|קבוע|יומי|שבועי|חודשי|\\d{1,2}(?::\\d{2})?|ב-?\\d{1,2}(?::\\d{2})?) )|(?=ו(?:שלח|עדכן)))(?:שלח|שלחי)(?: לי| לנו)?|(?:רוצה|מעוניין|מעוניינת|אשמח) לקבל) (?:סיכום|דוח|דו\"ח|עדכון|תזכורת|התראה|ניוזלטר|תקציר|ציטוט|טיפ|רשימה|מבזק)(?: חדשות)? (?:יומי|שבועי|חודשי)",
    ]),
    not: B([
      // Questions ("כמה מים לשתות כל יום", "למה", "איך אני מפסיק", "מה לאכול"), but not "האם תוכל…" or "כל ערב תגיד לי מה מזג האוויר".
      "^(?:כמה|למה|מדוע|איך|כיצד|מה|מהו|מהי|האם|מתי|איפה|איזה|איזו|היכן)",
      "למה|מדוע|(?:תגיד|תגידי|ספר|תספר|תספרי|אמור|אמרי|תסביר|הסבר) לי (?:כמה|איך|כיצד|מה זה|מהו|מהי|האם)",
      "כמה (?:פעמים|זמן|מים|שעות|כוסות|קלוריות|כסף|עולה|צריך|אני|אמור|מומלץ|יש|ליטר)",
      // "תגיד לי מה לאכול כל יום", not "כל בוקר תגיד לי מה ללבוש" (every morning, tell me what to wear).
      "(?:איך|כיצד) (?:אני|אנחנו|אפשר|עושים|מגדירים|קובעים|יוצרים|מפסיקים|ל\\p{L}{2,12})|(?=מה ל)(?<!^(?:ו|ב|וב)?(?:כל|מדי) [^.?!\\n]{0,40}?(?:תגיד|תגידי|תספר|תספרי|תמליץ|תמליצי|תציע|תציעי)(?: לי)?[^.?!\\n]{0,10})מה ל\\p{L}{2,12}",
      "מה זה|מהו|מהי|מה ההבדל|מה הם|מה הן|מה היתרונות|מה החסרונות|מה התועלת|מה ההשפעה|מה עדיף",
      "חשיבות|החשיבות|יתרונות|חסרונות|היתרונות|החסרונות|יתרון|תועלת|התועלת|השפעה|השפעות|ההשפעה|ההשפעות|נזק|נזקים|מזיק|מזיקה",
      "זה (?:רע|טוב|בסדר|נורמלי|תקין|בריא|מזיק|מסוכן|הגיוני)|(?:רע|נורמלי|תקין|מסוכן|מזיק) (?:ל|ש)\\p{L}{1,12}",
      "האם(?! (?:תוכל|תוכלי|תוכלו|אתה יכול|את יכולה|אתם יכולים|אפשר (?:לשלוח|לתת|לספר|להגיד|לעדכן|להודיע|להזכיר|לבדוק|לעקוב|לחפש|למצוא|לסכם|לתמצת|לכתוב|לנסח|להכין|לנטר|להשוות|לנתח|להמליץ|להציע|להביא|להראות|לרכז|לאסוף|לדווח|להתריע|ליידע|לרשום|לפרט) (?:לי|לנו|אותי)))",
      "כדאי|(?:צריך|צריכה|חייב|חייבת) ל(?!קבל)\\p{L}{2,12}",
      // A habit of mine: "אני בודק את הטלפון כל שעה", "כל בוקר אני רץ", not "אני רוצה לקבל כל בוקר…".
      "אני (?!רוצה|רוצים|צריך|צריכה|מעוניין|מעוניינת|מבקש|מבקשת|אשמח)\\p{L}{2,10}(?: \\p{L}{1,10}){0,3}? (?:ו|ב|וב)?(?:כל|מדי) (?:יום|בוקר|ערב|לילה|שבוע|חודש|שעה|שבת)",
      "(?:ו|ב|וב)?(?:כל|מדי) (?:יום|בוקר|ערב|לילה|שבוע|חודש|שעה|שבת) אני (?!רוצה|רוצים|צריך|צריכה|מעוניין|מעוניינת|מבקש|מבקשת|אשמח)\\p{L}{2,10}",
      // Someone's habit right after the schedule: "כל בוקר יש לי פקק", "כל בוקר הבוס שלי שולח לי…".
      "(?:ו|ב|וב)?(?:כל|מדי) (?:יום(?: (?:ראשון|שני|שלישי|רביעי|חמישי|שישי))?|בוקר|ערב|לילה|צהריים|שבוע|חודש|שעה|שנה|שבת|יומיים|שבועיים|חודשיים|שעתיים|חצי שעה|רבע שעה|\\d{1,3} (?:שעות|ימים|דקות|שבועות|חודשים)|כמה (?:שעות|ימים|שבועות|דקות)) (?:יש לי|יש לנו|היה לי|היו לי|אנחנו|הוא|היא|הם|הן|ה\\p{L}{1,10}(?: \\p{L}{1,10})? (?:שלי|שלנו))(?!\\p{L})",
      // "פוסט על זה שכל יום הוא הזדמנות".
      "(?:ש|שב)(?:כל|מדי) (?:יום(?: (?:ראשון|שני|שלישי|רביעי|חמישי|שישי))?|בוקר|ערב|לילה|צהריים|שבוע|חודש|שעה|שנה|שבת|יומיים|שבועיים|חודשיים|שעתיים|חצי שעה|רבע שעה|\\d{1,3} (?:שעות|ימים|דקות|שבועות|חודשים)|כמה (?:שעות|ימים|שבועות|דקות)) (?:הוא|היא|זה|הם|הן|יש|אין)(?!\\p{L})",
      // "תזכיר לי איך קראו לתוכנית": a question, not a reminder.
      "(?:תזכיר|תזכירי|הזכר|הזכירי) לי (?:איך|מה|מי|מתי|למה|איפה|איזה|איזו|את השם|שם)(?!\\p{L})",
    ]),
    between: B([
      // Someone else does it, or a routine of mine: "תן לי שגרת בוקר שאוכל לעשות כל יום", "מסעדה שפתוחה כל יום",
      // "אפליקציה שמזכירה לשתות מים כל שעה".
      "שאוכל|שנוכל|שאני (?:יכול|יכולה|אוכל)|אני (?:יכול|יכולה)|שגרה|שגרת|השגרה|הוא|היא|הם|אם(?! אפשר| ניתן)|כש\\p{L}{1,10}|כאשר|אפליקציה|אפליקציית|אפליקציות|היה|הייתה|היו|שהיה|שהייתה|שהיו|(?:ש)?(?:פתוח|פתוחה|פתוחים|פתוחות)|ש(?:מזכיר|מזכירה|שולח|שולחת|בודק|בודקת|מתריע|מתריעה|מודיע|מודיעה|עושה|עושים|לוקח|לוקחת|לוקחים|נפתח|נפתחת|עובד|עובדת|עובדים|פועל|פועלת|יוצא|יוצאת|יוצאים|משודר|משודרת|משודרים|מתקיים|מתקיימת|מתפרסם|מתפרסמת|מתעדכן|מתעדכנת|קורה|קורים)",
    ]),
  },
  hi: {
    recur: B([
      // Not "हर दिन के लिए" (for each day) or "रोज़ की दिनचर्या" (the daily routine), but "हर महीने की 1 तारीख"
      // and "हर हफ़्ते की खबरें".
      "(?:हर(?:\\s{1,2}एक)?\\s{1,2}(?:दिन|रो[ज\\u095B]\\u093C?|सुबह|दोपहर|शाम|रात|ह[फ\\u095E]\\u093C?्ते|ह[फ\\u095E]\\u093C?्ता|सप्ताह|महीने|महीना|माह|साल|वर्ष|घंटे|घंटा|घण्टे|सोमवार|मंगलवार|बुधवार|गुरुवार|बृहस्पतिवार|शुक्रवार|शनिवार|रविवार|इतवार|वीकेंड|वीकएंड|(?:[0-9०-९]{1,3}|दो|तीन|चार|पाँच|पांच|छह|दस|बारह|कुछ)\\s{1,2}(?:घंटे|घंटों|घण्टे|मिनट|दिन|दिनों|ह[फ\\u095E]\\u093C?्ते|ह[फ\\u095E]\\u093C?्तों|महीने))|रो[ज\\u095B]\\u093C?|रो[ज\\u095B]\\u093C?ाना|प्रतिदिन|प्रति\\s{1,2}दिन|(?:दिन|ह[फ\\u095E]\\u093C?्ते|सप्ताह|महीने)\\s{1,2}में\\s{1,2}(?:एक|दो|तीन|[0-9०-९]{1,2})\\s{1,2}बार)(?:\\s{1,2}को)?(?:\\s{1,2}(?:की\\s{1,2})?(?:सुबह|दोपहर|शाम|रात))?(?:\\s{1,2}[0-9०-९]{1,2}(?:[:.][0-9०-९]{2})?\\s{0,2}बजे)?(?!\\s{1,2}(?:का|की|के)(?![\\p{L}\\p{M}])(?!\\s{1,2}(?:पहल|आ[ख\\u0959]\\u093C?िर|अंत|शुरू|शुरु|बीच|सुबह|दोपहर|शाम|रात|[0-9०-९]|(?:[\\p{L}\\p{M}]{1,10}\\s{1,2}){0,2}(?:[ख\\u0959]\\u093C?बर|न्यू[ज\\u095B]\\u093C?|अपडेट|हेडलाइन|सुर्[ख\\u0959]\\u093C?ियाँ|सुर्[ख\\u0959]\\u093C?ियां))))",
      // "every morning मुझे … भेजो" (an English schedule in a Hindi request).
      "(?:every|each)\\s{1,2}(?:day|morning|afternoon|evening|night|week|month|hour|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[0-9]{1,3}\\s{1,2}(?:minutes|mins|hours|hrs|days|weeks))",
    ]),
    act: B([
      "(?:भेज|लिख|ढूँढ|ढूंढ|ढूढ|खोज)(?:ो|िए|िये|ें|ेँ|िएगा|ियेगा|ोगे|ोगी)",
      "(?:बता|दिखा|सुना|बना|सुझा|याद\\s{1,2}दिला)(?:ओ|[इई]ए|[इई]ये|एं|एँ|ें|यें|[इई]एगा|[इई]येगा|ओगे|ओगी)",
      "(?:चेक|ट्रैक|मॉनिटर|सर्च|रिसर्च|अपडेट|सूचित|नोटि[फ\\u095E]\\u093C?ाई|शेयर|पोस्ट|समराइ[ज\\u095B]\\u093C?|सारांशित|जाँच|जांच|तुलना|कंपेयर|ईमेल|मैसेज|रिमाइंड|तैयार)\\s{1,2}(?:करो|करिए|करिये|क[ीि]जिए|क[ीि]जिये|करें|क[ीि]जिएगा|करोगे|करोगी)",
      // "दो" is also "two" ("हर दो घंटे" = every two hours): only where its sentence or part ends.
      "दो(?=\\s{0,2}(?:$|[,.!।]|(?:ना|न|प्ली[ज\\u095B]\\u093C?|यार|भाई|जी)(?![\\p{L}\\p{M}])))|द[ीि]जिए|द[ीि]जिये|दें|द[ीि]जिएगा|दोगे|दोगी",
      "(?=[दस])(?<=(?<![\\p{L}\\p{M}])(?:भेज|लिख|ढूँढ|ढूंढ|ढूढ|खोज|बता|दिखा|सुना|बना|सुझा|दिला|दे|(?:चेक|ट्रैक|मॉनिटर|सर्च|रिसर्च|अपडेट|सूचित|नोटि[फ\\u095E]\\u093C?ाई|शेयर|पोस्ट|समराइ[ज\\u095B]\\u093C?|जाँच|जांच|तुलना|ईमेल|मैसेज|रिमाइंड|तैयार)\\s{1,2}कर)\\s{1,2})(?:दो|द[ीि]जिए|द[ीि]जिये|दें|देना|द[ीि]जिएगा|दे|दोगे|दोगी|दिया\\s{1,2}(?:करो|करें|करना|क[ीि]जिए|क[ीि]जिये)|(?:दे\\s{1,2})?(?:सकते\\s{1,2}(?:हो|हैं)|सकती\\s{1,2}(?:हो|हैं)|सकोगे|सकोगी|सकेंगे|सकेंगी))",
      "(?=रह)(?<=(?<![\\p{L}\\p{M}])(?:भेजते|लिखते|बताते|सुनाते|दिखाते|दिलाते|देते|(?:चेक|ट्रैक|अपडेट|सूचित)\\s{1,2}करते)\\s{1,2})(?:रहना|रहो|रहिए|रहिये|रहें|रहिएगा)",
      "(?=क[रीि])(?<=(?<![\\p{L}\\p{M}])(?:भेजा|लिखा|बताया|सुनाया|दिखाया|दिलाया|दिया|(?:चेक|ट्रैक|अपडेट|सूचित)\\s{1,2}किया)\\s{1,2})(?:करो|करें|करना|क[ीि]जिए|क[ीि]जिये)",
      // The infinitive asks ("मुझे खबरें भेजना"), not in "भेजना है / भेजना चाहिए" (have to, should).
      "(?:भेज|लिख|ढूँढ|ढूंढ|खोज|बता|दिखा|सुना|दिला|दे|(?:चेक|ट्रैक|मॉनिटर|अपडेट|सूचित|नोटि[फ\\u095E]\\u093C?ाई|ईमेल|मैसेज|रिमाइंड|तैयार)\\s{1,2}कर|(?:भेज|बता|चेक\\s{1,2}कर)\\s{1,2}दे)ना(?!\\s{0,2}(?:चाहि|प[ड\\u095C]\\u093C?|(?:है|हैं|था|थी|थे|होगा|होगी|होता|होती|[ज\\u095B]\\u093C?रूरी|सही|ठीक|अच्छा|कैसे|का|की|के)(?![\\p{L}\\p{M}])))",
      // "आप … भेजेंगे?" (will you send), not "हम भेजेंगे" (we will).
      "(?:(?:भेज|लिख|ढूँढ|ढूंढ|खोज)ेंगे|(?:बता|दिखा|सुना|दिला)(?:एंगे|एँगे|येंगे)|देंगे|(?:चेक|ट्रैक|अपडेट|सूचित)\\s{1,2}करेंगे)(?<=(?<![\\p{L}\\p{M}])आप(?![\\p{L}\\p{M}])[^।?!\\n]{0,80})",
      // "ये हर हफ़्ते करो" (do this every week).
      "(?=क[रीि])(?<=(?<![\\p{L}\\p{M}])(?:ये|यह|इसे|इसको|यही)\\s{1,2}(?:[\\p{L}\\p{M}0-9]{1,12}\\s{1,2}){0,3})(?:करो|क[ीि]जिए|क[ीि]जिये|करोगे|कर\\s{1,2}(?:दो|द[ीि]जिए|दें|देना|दिया\\s{1,2}करो|सकते\\s{1,2}(?:हो|हैं)|सकती\\s{1,2}(?:हो|हैं)|सकोगे)|किया\\s{1,2}(?:करो|करें|क[ीि]जिए))",
    ]),
    strong: B([
      // A reminder with a time or a task ("कल … याद दिलाना", "दवा लेना याद दिलाओ", "याद करा देना"), not "हैमलेट की
      // कहानी याद दिलाओ" (remind me of the plot) or "याद दिला दी" (reminded me).
      "(?=याद\\s{1,2}(?:दिला|करा|करवा)|रिमाइंड\\s{1,2}क)(?:(?<=(?<![\\p{L}\\p{M}])(?:कल|परसों|आज|बजे|सुबह|दोपहर|शाम|रात|हर|रो[ज\\u095B]\\u093C?|रो[ज\\u095B]\\u093C?ाना|प्रतिदिन|मिनट|घंटे|घंटा|ह[फ\\u095E]\\u093C?्ते|महीने|तारी[ख\\u0959]\\u093C?|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|इतवार|वीकेंड|से\\s{1,2}पहले|बाद\\s{1,2}में|के\\s{1,2}बाद)(?![\\p{L}\\p{M}])(?:(?!क्या|था|थी|थे|मैंने)[^।?!\\n]){0,60})|(?<=(?<![\\p{L}\\p{M}])(?:कर|ले|दे|पी|खा|जा|ला|भर|भेज|[ख\\u0959]\\u093C?रीद|प[ढ\\u095D]\\u093C?|लिख|बोल|मिल|रख|उठ|सो|चल|बदल|डाल|निकल|लगा|बुला)(?:ना|नी|ने\\s{1,2}(?:की|का))\\s{1,2}(?:मुझे\\s{1,2})?)|(?=(?:याद\\s{1,2}(?:दिला|करा|करवा)|रिमाइंड)(?:(?!क्या|कौन|कहाँ|किस)[^।?!\\n]){0,50}?(?<![\\p{L}\\p{M}])(?:कल|परसों|आज|बजे|सुबह|शाम|रात|हर|रो[ज\\u095B]\\u093C?|मिनट|घंटे|ह[फ\\u095E]\\u093C?्ते|तारी[ख\\u0959]\\u093C?|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार)(?![\\p{L}\\p{M}])(?![^।?!\\n]{0,30}?(?:क्या|था|थी|थे)(?![\\p{L}\\p{M}]))))(?:याद\\s{1,2}दिला(?:ओ|[इई]ए|[इई]ये|एं|एँ|[इई]एगा|[इई]येगा|ओगे|ओगी|ना(?!\\s{0,2}(?:चाहि|प[ड\\u095C]\\u093C?|(?:है|हैं|था|थी|होगा)(?![\\p{L}\\p{M}])))|या\\s{1,2}(?:करो|करें|करना|क[ीि]जिए|क[ीि]जिये)|ते\\s{1,2}(?:रहना|रहो|रहिए|रहिये|रहें))|(?:याद\\s{1,2}दिला|रिमाइंड\\s{1,2}कर)(?:\\s{1,2}(?:दो|द[ीि]जिए|द[ीि]जिये|दें|देना|द[ीि]जिएगा|दे|दिया\\s{1,2}(?:करो|करें|करना|क[ीि]जिए|क[ीि]जिये))|(?:\\s{1,2}दे)?\\s{1,2}(?:सकते\\s{1,2}(?:हो|हैं)|सकती\\s{1,2}(?:हो|हैं)|सकोगे|सकोगी|सकेंगे|सकेंगी))|रिमाइंड\\s{1,2}(?:करो|करिए|क[ीि]जिए|क[ीि]जिये|करें|करना|क[ीि]जिएगा|करते\\s{1,2}रहना|किया\\s{1,2}करो)|याद\\s{1,2}(?:करा|करवा)(?:ओ|[इई]ए|[इई]ये|[इई]एगा|[इई]येगा|ना(?!\\s{0,2}(?:चाहि|प[ड\\u095C]\\u093C?|(?:है|हैं|था|थी|होगा)(?![\\p{L}\\p{M}])))|\\s{1,2}(?:दो|द[ीि]जिए|द[ीि]जिये|दें|देना|द[ीि]जिएगा|दे)))",
      "(?:रिमाइंडर|रिमाइन्डर|अलर्ट)\\s{1,2}(?:भेज(?:ो|िए|िये|ें|िएगा|ते\\s{1,2}रहना|\\s{1,2}(?:दो|द[ीि]जिए|द[ीि]जिये|दें|देना|दिया\\s{1,2}करो))|(?:सेट|लगा|बना)\\s{1,2}(?:कर\\s{1,2})?(?:दो|द[ीि]जिए|द[ीि]जिये|दें|देना|द[ीि]जिएगा)|सेट\\s{1,2}(?:करो|क[ीि]जिए|क[ीि]जिये)|लगाओ|लगा[इई]ए|बनाओ|बना[इई]ए)",
      // "जब नया आईफ़ोन लॉन्च हो तो मुझे बताना" (a future event), not "कब खत्म हुआ", "अगर … कितना मिलेगा, बताओ",
      // "जब से दाम बढ़े हैं" (since) or "अगर कल मेरा दोस्त आए" ("comes" only of something new or awaited).
      "(?=[रलआउअसनऊकगबघपजख])(?<![\\p{L}\\p{M}])(?:रिली[ज\\u095B]\\u093C?|लॉन्च|लांच|आउट|उपलब्ध|अवेलेबल|स्टॉक\\s{1,2}में|सेल\\s{1,2}(?:पर|में)|सस्ता|सस्ती|सस्ते|नीचे|ऊपर|से\\s{1,2}कम|से\\s{1,2}[ज\\u095B]\\u093C?्यादा|के\\s{1,2}पार|गिर|ब[ढ\\u095D]\\u093C?|घट|पहुँच|पहुंच|घोषित|अनाउंस|जारी|(?:आ\\s{1,2}जा|आए|आये|आएगा|आएगी)(?<=(?<![\\p{L}\\p{M}])(?:नया|नई|नए|नयी|रि[ज\\u095B]\\u093C?ल्ट|रिजल्ट|नतीजे|परिणाम|ऑ[फ\\u095E]\\u093C?र|डील|[ख\\u0959]\\u093C?बर|[ख\\u0959]\\u093C?बरें|अपडेट|सी[ज\\u095B]\\u093C?न|एपिसोड|बा[ज\\u095B]\\u093C?ार\\s{1,2}में|मार्केट\\s{1,2}में)\\s{1,2}(?:[\\p{L}\\p{M}A-Za-z0-9]{1,15}\\s{1,2}){0,3}(?:आ\\s{1,2}जा|आए|आये|आएगा|आएगी))|खुल)(?:(?<=(?<![\\p{L}\\p{M}])(?:जब(?!\\s{1,2}से)|जैसे\\s{1,2}ही|अगर|यदि|जिस\\s{1,2}दिन)\\s(?:(?!कितन|क्या|क्यों|कैसे|कब|गया|गई|गए|था|थी|थे|हुआ|हुई|हुए)[^।?!\\n]){0,75})(?:(?!कितन|क्या|क्यों|कैसे|कब|गया|गई|गए|था|थी|थे|हुआ|हुई|हुए)[^।?!\\n]){0,25}?|(?:(?!कितन|क्या|क्यों|कैसे|कब|गया|गई|गए|था|थी|थे|हुआ|हुई|हुए)[^।?!\\n]){0,20}?(?:(?<![\\p{L}\\p{M}])(?:तो|तब)|(?:ते|ती)\\s{1,2}ही)\\s{1,2})(?:मुझे\\s{1,2}|हमें\\s{1,2})?(?:तुरंत\\s{1,2}|[फ\\u095E]\\u093C?ौरन\\s{1,2})?(?:बता(?:ना|ओ|[इई]ए|[इई]ये|एं|एँ|[इई]एगा|\\s{1,2}(?:देना|दो|द[ीि]जिए|द[ीि]जिये|दें|द[ीि]जिएगा))|(?:सूचित|नोटि[फ\\u095E]\\u093C?ाई|अलर्ट|मैसेज|ईमेल)\\s{1,2}(?:करना|करो|करें|क[ीि]जिए|क[ीि]जिएगा|कर\\s{1,2}(?:देना|दो|द[ीि]जिए|दें))|[ख\\u0959]\\u093C?बर\\s{1,2}(?:करना|देना|दो|द[ीि]जिए|दें|कर\\s{1,2}देना)|भेज(?:ना|ो|िए|िये|ें|िएगा|\\s{1,2}(?:देना|दो|द[ीि]जिए|द[ीि]जिये|दें|द[ीि]जिएगा)))(?!\\s{0,2}(?:कि\\s{1,2})?(?:क्या|कैसे|क्यों|कितन|कौन))",
      "(?:मुझे|हमें)\\s{1,2}(?:बता(?:ना|ओ|[इई]ए|[इई]ये|एं|एँ|[इई]एगा|\\s{1,2}(?:देना|दो|द[ीि]जिए|द[ीि]जिये|दें|द[ीि]जिएगा))|(?:सूचित|नोटि[फ\\u095E]\\u093C?ाई|अलर्ट|मैसेज|ईमेल)\\s{1,2}(?:करना|करो|करें|क[ीि]जिए|क[ीि]जिएगा|कर\\s{1,2}(?:देना|दो|द[ीि]जिए|दें)))\\s{1,2}(?:जब|जैसे\\s{1,2}ही|अगर|यदि|जिस\\s{1,2}दिन)\\s{1,2}(?:(?!कितन|क्या|क्यों|कैसे|कब|गया|गई|गए|था|थी|थे|हुआ|हुई|हुए)[^।?!\\n]){0,60}?(?<![\\p{L}\\p{M}])(?:रिली[ज\\u095B]\\u093C?|लॉन्च|लांच|आउट|उपलब्ध|अवेलेबल|स्टॉक\\s{1,2}में|सेल\\s{1,2}(?:पर|में)|सस्ता|सस्ती|सस्ते|नीचे|ऊपर|से\\s{1,2}कम|से\\s{1,2}[ज\\u095B]\\u093C?्यादा|के\\s{1,2}पार|गिर|ब[ढ\\u095D]\\u093C?|घट|पहुँच|पहुंच|घोषित|अनाउंस|जारी|(?:आ\\s{1,2}जा|आए|आये|आएगा|आएगी)(?<=(?<![\\p{L}\\p{M}])(?:नया|नई|नए|नयी|रि[ज\\u095B]\\u093C?ल्ट|रिजल्ट|नतीजे|परिणाम|ऑ[फ\\u095E]\\u093C?र|डील|[ख\\u0959]\\u093C?बर|[ख\\u0959]\\u093C?बरें|अपडेट|सी[ज\\u095B]\\u093C?न|एपिसोड|बा[ज\\u095B]\\u093C?ार\\s{1,2}में|मार्केट\\s{1,2}में)\\s{1,2}(?:[\\p{L}\\p{M}A-Za-z0-9]{1,15}\\s{1,2}){0,3}(?:आ\\s{1,2}जा|आए|आये|आएगा|आएगी))|खुल)",
      "(?:इसे|इसको|यह|ये|यह\\s{1,2}काम|इस\\s{1,2}काम\\s{1,2}को)\\s{1,2}(?:ऑटोमेट|ऑटोमैट)\\s{1,2}(?:कर\\s{1,2}(?:दो|द[ीि]जिए|द[ीि]जिये|दें|देना|सकते\\s{1,2}(?:हो|हैं)|सकती\\s{1,2}(?:हो|हैं)|सकोगे)|करो|क[ीि]जिए|क[ीि]जिये|करें)",
      // "मुझे साप्ताहिक सारांश भेजो" (send me a weekly summary), not "मेरी मासिक रिपोर्ट" or "मासिक धर्म".
      "(?:मुझे|हमें)\\s{1,2}(?:(?!(?:मेरी|मेरा|मेरे|इस|उस|अपनी|अपना|अपने|हमारी|हमारा|हमारे)\\s)[\\p{L}\\p{M}A-Za-z0-9]{1,15}\\s{1,2}){0,3}?(?:दैनिक|साप्ताहिक|मासिक|डेली|वीकली|मंथली|रो[ज\\u095B]\\u093C?ाना)\\s{1,2}(?:अपडेट|सारांश|समरी|रिपोर्ट|[ख\\u0959]\\u093C?बरें|[ख\\u0959]\\u093C?बर|न्यू[ज\\u095B]\\u093C?|डाइजेस्ट|ब्री[फ\\u095E]\\u093C?िंग|रिमाइंडर|अलर्ट|टिप्स|सुझाव|कोट)\\s{1,2}(?:भेज(?:ो|िए|िये|ें|िएगा|ना|ते\\s{1,2}(?:रहना|रहो|रहिए|रहें)|\\s{1,2}(?:दो|द[ीि]जिए|द[ीि]जिये|दें|देना|दिया\\s{1,2}करो))|दो(?=\\s{0,2}(?:$|[,.!।]|(?:ना|न|प्ली[ज\\u095B]\\u093C?|यार|भाई|जी)(?![\\p{L}\\p{M}])))|द[ीि]जिए|द[ीि]जिये|दें|देना|देते\\s{1,2}(?:रहना|रहो|रहिए|रहें)|दिया\\s{1,2}करो)",
    ]),
    // How much, why, how, should or have to, benefits, is it good/normal, a habit of mine ("करता हूँ") or anyone's
    // ("दादी रोज़ मंदिर जाती हैं", "क्या होता है"), "क्या मैं …", "what should I give", "ways to cope", "make a timetable",
    // "a plan with 2 GB a day", and translating or a word's meaning.
    not: /कितन[ाीे]|(?<![\p{L}\p{M}])(?:क्यों|क्यूँ|क्यूं|कैसे|किस\s{1,2}तरह)(?![\p{L}\p{M}])|(?:ना|नी|ने)\s{1,2}(?:चाहि(?:ए|ये)|प[ड\u095C]\u093C?(?:ता|ती|ते|ेगा|ेगी)|(?:है|हैं|था|थी|थे)(?![\p{L}\p{M}]))|[फ\u095E]\u093C?ायद|(?<![\p{L}\p{M}])(?:लाभ|हानि|नु[क\u0958]\u093C?सान)|(?:अच्छा|अच्छी|अच्छे|बुरा|बुरी|ठीक|सही|सामान्य|नॉर्मल|नार्मल|सुरक्षित|[ज\u095B]\u093C?रूरी)\s{1,2}(?:है|हैं|होता|होती|रहेगा|रहता)(?![\p{L}\p{M}])|(?<!चाह)(?:ता|ती)\s{1,2}(?:हूँ|हूं)(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?:मैं|हम)\s(?:(?!चाह|कि\s)[^।?!\n]){0,60}?(?:ूँ|ूं|ऊँ|ऊं|(?:ते|ती)\s{1,2}हैं)(?![\p{L}\p{M}])|^क्या\s(?!\s{0,2}(?:आप|तुम|तू)(?![\p{L}\p{M}]))(?![^।?!\n]{0,100}?(?:सकत[ेी]\s{1,2}(?:हो|हैं)|सकोग[ेी]|सकेंग[ेी]|[ओो]ग[ेी](?![\p{L}\p{M}])|िएगा|[इई]एगा))|क्या\s{1,2}(?:[\p{L}\p{M}]{1,10}\s{1,2}){0,2}?(?:करें|करूँ|करूं|करना|खाएं|खाएँ|खाऊँ|खाऊं|बनाएं|बनाएँ|बनाऊँ|बनाऊं|दें|दूँ|दूं|लें|लूँ|लूं|लिखें|लिखूँ|लिखूं|पहनें|पहनूँ|पहनूं|प[ढ\u095D]\u093C?ें|प[ढ\u095D]\u093C?ूँ|प[ढ\u095D]\u093C?ूं|देखें|देखूँ|देखूं|जाएं|जाऊँ|जाऊं)(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?:होता|होती|होते|करता|करती|करते|जाता|जाती|जाते|आता|आती|आते|रहता|रहती|रहते|मिलता|मिलती|मिलते|देता|देती|देते|लेता|लेती|लेते|खाता|खाती|खाते|पीता|पीती|पीते|चलता|चलती|चलते|भेजता|भेजती|भेजते|सोता|सोती|सोते|उठता|उठती|उठते)\s{1,2}(?:है|हैं)(?![\p{L}\p{M}])|(?:ने|ना)\s{1,2}के\s{1,2}(?:उपाय|तरी[क\u0958]\u093C?े|तरीके|नुस्[ख\u0959]\u093C?े|नुस्खे)(?![\p{L}\p{M}])|(?:टाइमटेबल|टाइम\s{1,2}टेबल|रूटीन|रुटीन|शेड्यूल|प्लान|योजना|चार्ट)\s{1,2}(?:बना|तैयार)|(?<![\p{L}\p{M}])(?:रो[ज\u095B]\u093C?|रो[ज\u095B]\u093C?ाना|प्रतिदिन|हर\s{1,2}दिन)\s{1,2}(?:[\p{L}\p{M}A-Za-z0-9.]{1,10}\s{1,2}){0,3}(?<!ने\s{1,2})(?:वाला|वाली|वाले)(?![\p{L}\p{M}])|अनुवाद|ट्रांसलेट|ट्रान्सलेट|(?:का|के|की)\s{1,2}(?:मतलब|अर्थ)\s{1,2}(?:क्या|बताओ|बता[इई]ए|बताएं|समझाओ)|(?:में|को)\s{1,2}क्या\s{1,2}(?:कहते|बोलते|लिखते)/u,
    // "हर सुबह करने के लिए रूटीन बताओ" (a routine to do each morning), "… जो मैं हर दिन कर सकूँ".
    between: /(?:ने|ना)\s{1,2}(?:के\s{1,2}लिए|को)(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?:जो|जिसे|जिसको|जिससे|जिन्हें|ताकि|सकूँ|सकूं|सकें)(?![\p{L}\p{M}])/u,
  },
  ur: {
    recur: B([
      // "ہر روز", "ہر پیر کو صبح 8 بجے", never inside "مہر" or "ظہر", nor "ہفتے کے ہر دن کے لیے" (for every day of the week).
      "(?<!(?<!کر )کے )[ہه]ر (?:روز|دن|صبح|شام|رات|دوپہر|ہفتے|ہفتہ|مہینے|مہینہ|سال|گھنٹے|گھنٹہ|منٹ|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار)|[\\d۰-۹٠-٩]{1,3} (?:گھنٹے|گھنٹوں|دن|دنوں|منٹ|ہفتے)|(?:دو|تین|چند|کچھ) (?:گھنٹے|گھنٹوں|دن|دنوں|ہفتے)|آدھے گھنٹے)(?: کو)?(?: (?:صبح|شام|رات|دوپہر))?(?: [\\d۰-۹٠-٩]{1,2}(?:[:.][\\d۰-۹٠-٩]{2})? بجے)?(?! کے (?:لیے|لئے|لیئے)| کی | کا )",
      // "روزانہ" says when only before the request ("روزانہ مجھے بھیجیں", "روزانہ صبح"), not before what it describes ("روزانہ اخبار", "روزانہ کا معمول").
      "(?:روزانہ|ہفتہ وار|ماہانہ)(?=\\s{0,3}(?:$|[،,.!؟?]|[\\d۰-۹٠-٩]|مجھے|ہمیں|مجھ|میرے|میری|صبح|شام|رات|دوپہر|ایک |کوئی|کچھ|یہ |وہ |اس |ان |کی بنیاد|ب[ھه]یج|بتا|یاد|چیک|اپ ?ڈیٹ|لک[ھه]|دیں|دو |دو$|کریں|کرو|نئی|نیا|نئے|اہم|تازہ))",
      // Right after "مجھے" it's the adverb: "مجھے روزانہ خبریں بھیجیں", but not "روزانہ کا".
      "(?<=(?:مجھے|ہمیں|مجھ کو) )روزانہ(?! (?:کا|کی|کے)(?!\\p{L}))",
      // Bare "روز" (daily) only as "روز صبح" or "روز مجھے", never "روز مرہ" or "روزہ".
      "(?<!(?:کے|اس|ا\\u064Fس|اسی|جس|کس|اگلے|پچھلے|پہلے|ایک) )روز(?: (?:صبح|شام|رات|دوپہر)(?: [\\d۰-۹٠-٩]{1,2}(?:[:.][\\d۰-۹٠-٩]{2})? بجے)?|(?= (?:مجھے|ہمیں)(?!\\p{L})))",
      "(?:دن|ہفتے|مہینے) میں (?:ایک|دو|تین|[\\d۰-۹٠-٩]{1,2}) (?:بار|دفعہ|مرتبہ)|باقاعدگی سے",
    ]),
    act: B([
      // Requests, polite and informal ("بھیجیں", "بھیجو", "بھیجا کریں", "بتا دیں"); not "بھیجا" (sent) or "بھیجتا ہے" (sends).
      "ب[ھه]یج(?:و|یں|ئے|یے|یئے| دو| دیں| دیجئے| دیجیے| دینا|نا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|ا کریں|ا کرو|تے رہیں|تے رہو|تے رہنا)",
      "(?:بتا|سکھا)(?:ؤ|و|ئیں|یئے|ئیے|ییں| دو| دیں| دیجئے| دیجیے| دینا|نا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|یا کریں|یا کرو|تے رہیں|تے رہنا)|سنا(?:ؤ|ئیں| دو| دیں|یا کریں|یا کرو)",
      "(?:کر|بتا|ب[ھه]یج|دے|لا|بنا|لک[ھه]|سنا|دک[ھه]ا|ڈ[ھه]ونڈ|نکال|سمج[ھه]ا|ترجمہ کر|چیک کر|تلاش کر) (?:دو|دیں|دیجئے|دیجیے|دیجیئے|دینا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|دیا کریں|دیا کرو|دیتے رہیں|دیتے رہنا)",
      // "دیں" (give, polite) on its own; "دو" (give) only at the end, since it's also "two" ("ایک یا دو", Persian "یک یا دو").
      "دیں(?! گے| گی)|دیجئے|دیجیے|دیجیئے|(?<!(?:یا|تا|سے|اور|یک|ایک|یکی|ساعت|بجے|یا) )دو(?=\\s{0,2}$)",
      "(?:یاد دلا(?:ؤ|و|ئیں|یئے|ئیے| دو| دیں| دیجئے| دیجیے|نا|یا کریں|یا کرو|تے رہیں|تے رہنا| دینا)|یاد (?:کرا|کروا)(?:نا| دیں| دو| دینا)|ریمائنڈ (?:کرو|کریں|کر دیں|کرانا))(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)",
      "(?:اطلاع|خبر|اپ ?ڈیٹ|مشورہ) (?:دو|دیں|دیجئے|دینا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|دیتے رہیں|دے دیں|دے دو|دے دینا|دے دیجئے)|(?:مطلع|آگاہ|نوٹیفائی|الرٹ|میسج|سینڈ|ارسال) (?:کرو|کریں|کر دیں|کر دو|کرنا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ))",
      "(?:چیک|جانچ|مانیٹر|ٹریک|تلاش|سرچ|تحقیق|ریسرچ|تجویز|موازنہ|تجزیہ|تیار|خلاصہ|پتا|پتہ|معلوم) (?:کرو|کریں|کر دیں|کر دو|کرنا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|کیا کریں|کیا کرو|کرتے رہیں|کرتے رہنا)",
      "نظر رک[ھه](?:یں|و|نا|ا کریں)|(?:پتا|پتہ) لگائیں|ڈ[ھه]ونڈ(?:و|یں)|جانچیں|دہرائیں|دوہرائیں|دہراؤ|سمج[ھه]ائیں|سمج[ھه]اؤ",
      "لک[ھه](?:و|یں|ئے|یے|یئے|نا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|ا کریں|ا کرو|تے رہیں)|بنا(?:ؤ|ئیں|یئے|ئیے|نا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|یا کریں)|(?:خلاصہ|سمری|فہرست|لسٹ) (?:بنائیں|بنا دیں|ب[ھه]یجیں|دیں|دو)",
      "(?:یہ|ایسا)(?: کام| ہی)? (?:کرو|کریں|کر دیں|کیا کریں|کیا کرو)",
      // "کیا آپ ہر روز … بھیج سکتے ہیں".
      "(?:آپ|تم)[^.?!؟۔\\n]{0,60}?(?:ب[ھه]یج|بتا|لک[ھه]|بنا|یاد دلا|یاد کرا|یاد کروا|چیک کر|تلاش کر|ڈ[ھه]ونڈ|دے|سنا|اطلاع دے|مطلع کر|خلاصہ کر|خلاصہ بنا|جمع کر|تیار کر|نظر رک[ھه]|ٹریک کر|مانیٹر کر|میسج کر|سرچ کر|دک[ھه]ا|سک[ھه]ا) (?:سکتے|سکتی|سکو|سکیں)",
      // "مجھے ہر ہفتے خلاصہ چاہیے" (I want), not "پینا چاہیے" (should drink).
      "(?<!(?:نا|نی|نے) )(?:چاہیے|چاہئے|چاہیئے)(?! کہ)",
    ]),
    strong: B([
      // A reminder with a task or a time: "کل ڈاکٹر کو فون کرنا یاد دلانا", "کل صبح 9 بجے یاد دلا دیں",
      // not "ہیملٹ کی کہانی یاد دلائیں" or "اس گانے نے مجھے بچپن یاد دلایا" (it reminded me).
      "(?!(?:کہانی|کہانیاں|پانی|جوانی|نانا|نانی|گانا|گانے|پرانا|پرانی|پرانے|زمانہ|زمانے|سامنے|اپنا|اپنی|اپنے|ٹھکانے|بہانے|افسانے|ترانے) )\\p{L}{1,10}(?:نا|نی|نے) (?:مجھے |ہمیں )?(?:یاد دلا(?:ؤ|و|ئیں|یئے|ئیے| دو| دیں| دیجئے| دیجیے|نا|یا کریں|یا کرو|تے رہیں|تے رہنا| دینا)|یاد (?:کرا|کروا)(?:نا| دیں| دو| دینا)|ریمائنڈ (?:کرو|کریں|کر دیں|کرانا))(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)",
      "(?<!\\p{L})(?:کل|آج (?:رات|شام|صبح|دوپہر)|پرسوں|صبح|شام|رات|دوپہر|[\\d۰-۹٠-٩]{1,2}(?:[:.][\\d۰-۹٠-٩]{2})? بجے|[ہه]ر (?:روز|دن|صبح|شام|رات|ہفتے|مہینے|گھنٹے)|(?:ایک|دو|آدھے|[\\d۰-۹٠-٩]{1,3}) (?:گھنٹے|منٹ|دن) (?:بعد|میں)|اگلے (?:ہفتے|مہینے|سال|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار))|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار) (?:کو|کے دن)|روزانہ|مہینے (?:کی|کے) (?:شروع|آخر|پہلی))(?![\\p{L}\\p{N}])(?:(?!(?<!\\p{L})(?:کیا|کون|کب|کہاں|کیسے|کس|جو|جس|تھا|تھی|تھے|پچھلی|پچھلے|گزشتہ)(?!\\p{L}))[^.?!؟۔\\n]){0,60}?(?<!\\p{L})(?:یاد دلا(?:ؤ|و|ئیں|یئے|ئیے| دو| دیں| دیجئے| دیجیے|نا|یا کریں|یا کرو|تے رہیں|تے رہنا| دینا)|یاد (?:کرا|کروا)(?:نا| دیں| دو| دینا)|ریمائنڈ (?:کرو|کریں|کر دیں|کرانا))(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)",
      "(?:یاد دلا(?:ؤ|و|ئیں|یئے|ئیے| دو| دیں| دیجئے| دیجیے|نا|یا کریں|یا کرو|تے رہیں|تے رہنا| دینا)|یاد (?:کرا|کروا)(?:نا| دیں| دو| دینا)|ریمائنڈ (?:کرو|کریں|کر دیں|کرانا))(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)(?:(?!(?<!\\p{L})(?:کیا|کون|کب|کہاں|کیسے|کس|جو|جس|تھا|تھی|تھے|پچھلی|پچھلے|گزشتہ)(?!\\p{L}))[^.?!؟۔\\n]){0,40}?(?<!\\p{L})(?:کل|آج (?:رات|شام|صبح|دوپہر)|پرسوں|صبح|شام|رات|دوپہر|[\\d۰-۹٠-٩]{1,2}(?:[:.][\\d۰-۹٠-٩]{2})? بجے|[ہه]ر (?:روز|دن|صبح|شام|رات|ہفتے|مہینے|گھنٹے)|(?:ایک|دو|آدھے|[\\d۰-۹٠-٩]{1,3}) (?:گھنٹے|منٹ|دن) (?:بعد|میں)|اگلے (?:ہفتے|مہینے|سال|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار))|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار) (?:کو|کے دن)|روزانہ|مہینے (?:کی|کے) (?:شروع|آخر|پہلی))(?![\\p{L}\\p{N}])",
      "(?:یاد دلا(?:ؤ|و|ئیں|یئے|ئیے| دو| دیں| دیجئے| دیجیے|نا|یا کریں|یا کرو|تے رہیں|تے رہنا| دینا)|یاد (?:کرا|کروا)(?:نا| دیں| دو| دینا)|ریمائنڈ (?:کرو|کریں|کر دیں|کرانا))(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ) کہ(?![^.?!؟۔\\n]{0,60}?(?<!\\p{L})(?:کیا|کون|کب|کہاں|کیسے|کس|جو|جس|تھا|تھی|تھے|پچھلی|پچھلے|گزشتہ)(?!\\p{L}))",
      // "Tell me when" with a future event: "جب نیا آئی فون آئے تو مجھے بتانا", not "بتائیں جنگ کب ختم ہوئی".
      "(?=(?:مجھے |ہمیں )?(?:بتانا|بتا دینا|بتائیں|بتا دیں|بتاؤ|بتا دو|بتایئے|بتائیے|بتا دیجئے|بتا دیجیے|اطلاع (?:دیں|دو|دینا|دیجئے|کر دیں|کر دینا|دے دیں|دے دو|دے دینا|دے دیجئے)|مطلع (?:کریں|کرو|کر دیں|کرنا|کر دینا)|خبر (?:دیں|دو|دینا|کر دینا|کرنا)|آگاہ (?:کریں|کرو|کرنا|کر دینا)|میسج (?:کریں|کرو|کر دیں|کر دینا|کرنا)|نوٹیفائی (?:کریں|کرو|کرنا)|الرٹ (?:کریں|کرو|کر دیں|کرنا)))(?<=(?<![\\p{L}\\p{M}\\p{N}])(?:جب|جیسے ہی|جونہی|جوں ہی|اگر) (?:(?!(?<!\\p{L})(?:کیا(?! آپ| تم)|کیوں|کیسے|کتنا|کتنی|کتنے|کب|کون|کہاں)(?!\\p{L}))[^.?!؟۔\\n]){0,60}(?<!\\p{L})(?:آئے|آ جائے|آجائے|آئیں|آ جائیں|(?:ریلیز|لانچ|جاری|دستیاب|شروع) ہو(?:ں)?|مارکیٹ میں آئے|(?:نیچے|اوپر) (?:جائے|آئے|چلا جائے|چلی جائے)|گر جائے|گرے|بڑھ جائے|بڑھے|(?:کم|زیادہ|سستا|سستی|مہنگا|مہنگی|سستے|مہنگے) ہو(?:ں)?|بدل جائے|بدلے|ک[ھه]ل جائے|ک[ھه]لے|اعلان ہو|اسٹاک میں|سٹاک میں|سے (?:کم|نیچے|زیادہ|اوپر))(?![\\p{L}])(?:(?!(?<!\\p{L})(?:کیا(?! آپ| تم)|کیوں|کیسے|کتنا|کتنی|کتنے|کب|کون|کہاں)(?!\\p{L}))[^.?!؟۔\\n]){0,40})(?<!\\p{L})(?:مجھے |ہمیں )?(?:بتانا|بتا دینا|بتائیں|بتا دیں|بتاؤ|بتا دو|بتایئے|بتائیے|بتا دیجئے|بتا دیجیے|اطلاع (?:دیں|دو|دینا|دیجئے|کر دیں|کر دینا|دے دیں|دے دو|دے دینا|دے دیجئے)|مطلع (?:کریں|کرو|کر دیں|کرنا|کر دینا)|خبر (?:دیں|دو|دینا|کر دینا|کرنا)|آگاہ (?:کریں|کرو|کرنا|کر دینا)|میسج (?:کریں|کرو|کر دیں|کر دینا|کرنا)|نوٹیفائی (?:کریں|کرو|کرنا)|الرٹ (?:کریں|کرو|کر دیں|کرنا))(?![^.?!؟۔\\n]{0,80}?(?<!\\p{L})(?:کیا(?! آپ| تم)|کیوں|کیسے|کتنا|کتنی|کتنے|کب|کون|کہاں)(?!\\p{L}))",
      "(?:مجھے |ہمیں )?(?:بتانا|بتا دینا|بتائیں|بتا دیں|بتاؤ|بتا دو|بتایئے|بتائیے|بتا دیجئے|بتا دیجیے|اطلاع (?:دیں|دو|دینا|دیجئے|کر دیں|کر دینا|دے دیں|دے دو|دے دینا|دے دیجئے)|مطلع (?:کریں|کرو|کر دیں|کرنا|کر دینا)|خبر (?:دیں|دو|دینا|کر دینا|کرنا)|آگاہ (?:کریں|کرو|کرنا|کر دینا)|میسج (?:کریں|کرو|کر دیں|کر دینا|کرنا)|نوٹیفائی (?:کریں|کرو|کرنا)|الرٹ (?:کریں|کرو|کر دیں|کرنا))(?![^.?!؟۔\\n]{0,80}?(?<!\\p{L})(?:کیا(?! آپ| تم)|کیوں|کیسے|کتنا|کتنی|کتنے|کب|کون|کہاں)(?!\\p{L})) (?:جب|جیسے ہی|جونہی|جوں ہی|اگر) [^.?!؟۔\\n]{0,60}?(?<!\\p{L})(?:آئے|آ جائے|آجائے|آئیں|آ جائیں|(?:ریلیز|لانچ|جاری|دستیاب|شروع) ہو(?:ں)?|مارکیٹ میں آئے|(?:نیچے|اوپر) (?:جائے|آئے|چلا جائے|چلی جائے)|گر جائے|گرے|بڑھ جائے|بڑھے|(?:کم|زیادہ|سستا|سستی|مہنگا|مہنگی|سستے|مہنگے) ہو(?:ں)?|بدل جائے|بدلے|ک[ھه]ل جائے|ک[ھه]لے|اعلان ہو|اسٹاک میں|سٹاک میں|سے (?:کم|نیچے|زیادہ|اوپر))(?![\\p{L}])",
      "(?:ریمائنڈر|الارم|یاد دہانی) (?:لگا|سیٹ کر|بنا) (?:دیں|دو|دینا)",
      // "مجھے روزانہ خبروں کا خلاصہ بھیجیں", not "اس ہفتہ وار رپورٹ کا خلاصہ بھیجیں".
      "(?<!(?:اس|یہ|وہ|میری|میرا|میرے|ہماری|ہمارا|ہمارے|اپنی|اپنا|اپنے|کی|کا|کے) )(?:روزانہ|ہفتہ وار|ماہانہ) [^.?!؟۔\\n]{0,30}?(?:خلاصہ|رپورٹ|اپ ?ڈیٹ|خبریں|نیوز|ریمائنڈر|یاد دہانی|سمری|ٹپس|اقتباس)[^.?!؟۔\\n]{0,30}?(?:ب[ھه]یج(?:و|یں|ئے|یے|یئے| دو| دیں| دیجئے| دیجیے| دینا|نا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|ا کریں|ا کرو|تے رہیں|تے رہو|تے رہنا)|(?:بتا|سکھا)(?:ؤ|و|ئیں|یئے|ئیے|ییں| دو| دیں| دیجئے| دیجیے| دینا|نا(?! ہے| ہو| ہیں| تھا| تھی| چاہ| پڑ)|یا کریں|یا کرو|تے رہیں|تے رہنا)|سنا(?:ؤ|ئیں| دو| دیں|یا کریں|یا کرو)|دیں|دو|دیجئے|چاہیے|چاہئے)",
    ]),
    not: B([
      // Questions ("کتنا پانی", "کیوں", "کیسے چھوڑوں", "کیا ہر روز کافی پینا ٹھیک ہے", "… کا مطلب"), but not "کیا آپ…", "موسم کیسا ہے"
      // or "لفظ اور اس کا مطلب بھیجیں".
      "کتنا|کتنی|کتنے|کیوں|کیسے|کس طرح|(?=مطلب|معنی)(?<!(?:اس|ان|جس) (?:کا|کے|کی) )(?<!(?:اور|ساتھ) )(?:مطلب|معنی)|فرق",
      // "کیا" asks, unless the schedule and "tell me" come first: "ہر صبح مجھے بتائیں کہ کیا پہنوں".
      "(?=کیا)(?<!^[ہه]ر [^.?!؟۔\\n]{0,40}?(?:بتائیں|بتاؤ|بتا دیں|بتا دو|بتانا|بتایا کریں|بتا دیا کریں|بتا دیا کرو)[^.?!؟۔\\n]{0,40})کیا(?! (?:آپ|تم|کریں|کرو|کرنا|کرتے|کیجئے)(?!\\p{L}))",
      "فائدے|فوائد|فائدہ|نقصان|نقصانات|اثرات|خوبیاں|خامیاں|نارمل|برا ہے|بری بات|صحیح ہے|درست ہے|بہتر ہے|بہتر رہے گا|یا نہیں|کہ نہیں",
      "\\p{L}{1,10}(?:نا|نی|نے) (?:چاہیے|چاہئے|چاہیئے|چاہئیں)",
      // A habit: "میں ہر گھنٹے فون چیک کرتا ہوں", "وہ ہر روز پیغام بھیجتا ہے", "تنگ آ گیا ہوں", not "بھیج سکتے ہیں" or "میں چاہتا ہوں".
      "\\p{L}{1,10}(?<!سک)(?<!چاہ)(?:تا|تی|تے) (?:ہوں|ہیں|ہو|تھا|تھی|تھے)|(?<!چاہ )(?:گیا|گئی|گئے|چکا|چکی|رہا|رہی) ہوں",
      // What the schedule describes: "ہر روز صبح اٹھنے کے لیے ٹپس", "دن میں دو بار لینے والی دوائی", "ہر روز بارش ہو رہی ہے".
      "(?:[ہه]ر (?:روز|دن|صبح|شام|رات|دوپہر|ہفتے|ہفتہ|مہینے|مہینہ|سال|گھنٹے|گھنٹہ|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار))|روزانہ|(?:دن|ہفتے|مہینے) میں (?:ایک|دو|تین|[\\d۰-۹٠-٩]{1,2}) (?:بار|دفعہ|مرتبہ))(?: (?!مجھے|ہمیں)\\p{L}{1,10}){0,2}? \\p{L}{1,10}نے کے (?:لیے|لئے|لیئے)",
      "(?:[ہه]ر (?:روز|دن|صبح|شام|رات|دوپہر|ہفتے|ہفتہ|مہینے|مہینہ|سال|گھنٹے|گھنٹہ|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار))|روزانہ|(?:دن|ہفتے|مہینے) میں (?:ایک|دو|تین|[\\d۰-۹٠-٩]{1,2}) (?:بار|دفعہ|مرتبہ)) \\p{L}{1,10}نے وال[اےی]",
      "(?:[ہه]ر (?:روز|دن|صبح|شام|رات|دوپہر|ہفتے|ہفتہ|مہینے|مہینہ|سال|گھنٹے|گھنٹہ|(?:پیر|منگل|بدھ|جمعرات|جمعہ|جمعے|ہفتہ|ہفتے|اتوار))|روزانہ|(?:دن|ہفتے|مہینے) میں (?:ایک|دو|تین|[\\d۰-۹٠-٩]{1,2}) (?:بار|دفعہ|مرتبہ))(?: \\p{L}{1,10}){0,3}? رہ(?:ا|ی|ے) (?:ہے|ہیں)",
    ]),
    between: B([
      // Something I'd do myself: "ایک روٹین بتائیں جو میں ہر روز کر سکوں".
      "جو|جسے|جنہیں|کہ میں|میں خود|سکوں|اگر|جب|روٹین|معمول|عادت|اس پر|اس کے بارے|مشکل|آسان|(?:لگتا|لگتی|ہوتا|ہوتی|ہوتے) (?:ہے|ہیں)",
    ]),
  },
  bn: {
    recur: B([
      "(?:প্রতিদিন(?:ই)?|প্রত্যেকদিন|রোজ(?:ই|\\s{1,2}রোজ)?|(?:প্রতি|প্রত্যেক)\\s{1,2}(?:দিন|সকাল|সকালে|দুপুর|দুপুরে|বিকাল|বিকালে|বিকেল|বিকেলে|সন্ধ্যা|সন্ধ্যা[য\\u09DF]\\u09BC?|রাত|রাতে|সপ্তাহ|সপ্তাহে|হপ্তা[য\\u09DF]\\u09BC?|মাস|মাসে|বছর|বছরে|ঘণ্টা|ঘণ্টা[য\\u09DF]\\u09BC?|ঘন্টা|ঘন্টা[য\\u09DF]\\u09BC?|সোমবার|মঙ্গলবার|বুধবার|বৃহস্পতিবার|শুক্রবার|শনিবার|রবিবার|রোববার|(?:সোম|মঙ্গল|বুধ|বৃহস্পতি|শুক্র|শনি|রবি|রোব)বারে|উইকেন্ডে|সপ্তাহান্তে|মাসের\\s{1,2}(?:[0-9০-৯]{1,2}|প্রথম|শেষ)|(?:[0-9০-৯]{1,3}|দুই|দু|তিন|চার|পাঁ?চ|ছ[য\\u09DF]\\u09BC?|দশ|বারো|ক[য\\u09DF]\\u09BC?েক)\\s{0,2}(?:ঘণ্টা|ঘন্টা|দিন|সপ্তাহ|মিনিট)(?:[য\\u09DF]\\u09BC?|ে|তে|\\s{1,2}পর\\s{1,2}পর)?)|(?:দিনে|সপ্তাহে|মাসে)\\s{1,2}(?:একবার|দুবার|দুইবার|তিনবার|[0-9০-৯]{1,2}\\s{0,2}বার)|ঘণ্টা[য\\u09DF]\\u09BC?\\s{1,2}ঘণ্টা[য\\u09DF]\\u09BC?)(?:\\s{1,2}(?:সকাল|দুপুর|বিকাল|বিকেল|সন্ধ্যা|রাত)(?:ে|[য\\u09DF]\\u09BC?|তে)?)?(?:\\s{1,2}[0-9০-৯]{1,2}(?:[:.][0-9০-৯]{2})?\\s{0,2}(?:টা[য\\u09DF]\\u09BC?|টার\\s{1,2}দিকে|টাতে|টা))?",
      // Each day's news, but not "প্রতিদিনের রুটিন" (the daily routine).
      "(?:প্রতিদিনের|রোজকার|রোজের|(?:প্রতি|প্রত্যেক)\\s{1,2}(?:সকালের|সপ্তাহের|মাসের))(?=\\s{1,2}(?:[\\p{L}\\p{M}]{1,10}\\s{1,2}){0,2}(?:খবর|নিউজ|আপডেট|হেডলাইন|শিরোনাম))",
      // "every morning আমাকে … পাঠাও" (an English schedule in a Bengali request).
      "(?:every|each)\\s{1,2}(?:day|morning|afternoon|evening|night|week|month|hour|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[0-9]{1,3}\\s{1,2}(?:minutes|mins|hours|hrs|days|weeks))",
    ]),
    act: B([
      "(?:পাঠাও|পাঠান|পাঠাবেন|পাঠিও|পাঠি[য\\u09DF]\\u09BC?ো|পাঠা[য\\u09DF]\\u09BC?েন|জানাও|জানান|জানাবেন|জানিও|জানি[য\\u09DF]\\u09BC?ো|জানা[য\\u09DF]\\u09BC?েন|বলো|বলুন|বলবেন|বোলো|বইলেন|দাও|দিও|দি[য\\u09DF]\\u09BC?ো|দেবেন|দিবেন|দি[য\\u09DF]\\u09BC?েন|দেখাও|দেখান|দেখাবেন|দেখিও|লেখো|লিখো|লিখুন|লিখবেন|খোঁ?জো|খুঁ?জুন|খুঁ?জবেন|শোনাও|শোনান|শোনাবেন|শুনিও|বানাও|বানাবেন|বানিও|শেখাও|শেখান|শেখাবেন|শিখিও|শিখি[য\\u09DF]\\u09BC?ো|পাঠাইও|পাঠাই[য\\u09DF]\\u09BC?ো|পাঠাই[য\\u09DF]\\u09BC?েন|জানাইও|জানাই[য\\u09DF]\\u09BC?ো|জানাই[য\\u09DF]\\u09BC?েন|দেখাইও|শোনাইও|বানাইও)",
      // "দিন" is also "day": only where its sentence or part ends, and not in "তিন দিন" or "প্রতি দিন".
      "(?<!(?:[0-9০-৯]|এক|দুই|দু|তিন|চার|পাঁ?চ|ছ[য\\u09DF]\\u09BC?|সাত|আট|ন[য\\u09DF]\\u09BC?|দশ|কত|ক[য\\u09DF]\\u09BC?েক|প্রতি|প্রত্যেক|সব|কোন|কোনো|ওই|ঐ|সেই|এই|যে|শেষ|প্রথম|ভালো|খারাপ|শুভ|পুরো|সারা)\\s{0,2})দিন(?=\\s{0,2}(?:$|[,.!।]|(?:প্লিজ|প্লীজ|তো|না)(?![\\p{L}\\p{M}])))",
      "(?:চেক|ট্র্যাক|ট্রাক|মনিটর|সার্চ|রিসার্চ|গবেষণা|আপডেট|নোটিফাই|পোস্ট|শে[য\\u09DF]\\u09BC?ার|তুলনা|কম্পে[য\\u09DF]\\u09BC?ার|সামারি|সারাংশ|সংক্ষেপ|মেসেজ|ইমেইল|ইমেল|রিমাইন্ড|লিস্ট|তালিকা|তৈরি|সাজেস্ট|রেকমেন্ড|সুপারিশ)\\s{1,2}(?:করো|করুন|করবেন|কোরো|করিও|কইরেন)|(?:নজর|খে[য\\u09DF]\\u09BC?াল|চোখ)\\s{1,2}(?:রাখো|রাখুন|রাখবেন|রেখো)",
      "(?=দ)(?<=(?<![\\p{L}\\p{M}])(?:পাঠি[য\\u09DF]\\u09BC?ে|জানি[য\\u09DF]\\u09BC?ে|বলে|লিখে|খুঁ?জে|দেখি[য\\u09DF]\\u09BC?ে|শুনি[য\\u09DF]\\u09BC?ে|বানি[য\\u09DF]\\u09BC?ে|শিখি[য\\u09DF]\\u09BC?ে|এনে|মনে\\s{1,2}করি[য\\u09DF]\\u09BC?ে|(?:বের|চেক|ট্র্যাক|আপডেট|সার্চ|রিসার্চ|তৈরি|লিস্ট|তালিকা|সামারি|সারাংশ|মেসেজ|ইমেইল|রিমাইন্ড)\\s{1,2}করে)\\s{1,2})(?:দাও|দিও|দি[য\\u09DF]\\u09BC?ো|দিন|দেবেন|দিবেন|দি[য\\u09DF]\\u09BC?েন|দে|দিস)",
      "(?=প)(?<=(?<![\\p{L}\\p{M}])(?:পাঠা|জানা|বল|দি|দেখা|লিখ|খুঁ?জ|শোনা|বানা|মনে\\s{1,2}করা|(?:পাঠি[য\\u09DF]\\u09BC?ে|জানি[য\\u09DF]\\u09BC?ে|বলে|লিখে|খুঁ?জে|বের\\s{1,2}করে|চেক\\s{1,2}করে)\\s{1,2}দি|(?:চেক|ট্র্যাক|মনিটর|আপডেট|সার্চ|রিসার্চ|রিমাইন্ড|নোটিফাই|মেসেজ|ইমেইল)\\s{1,2}কর)তে\\s{1,2})(?:পারবে|পারবেন|পারো|পারেন|পারবা|পারবি)",
      "(?=থ)(?<=(?<![\\p{L}\\p{M}])(?:পাঠা|জানা|বল|দি|দেখা|লিখ|শোনা|মনে\\s{1,2}করা|(?:চেক|ট্র্যাক|আপডেট|রিমাইন্ড)\\s{1,2}কর)তে\\s{1,2})(?:থাকো|থেকো|থাকুন|থাকবেন|থাকিস)",
      // "তুমি … পাঠাবে?" (will you send), not "সে পাঠাবে" (he will).
      "(?:পাঠাবে|জানাবে|বলবে|দেবে|দিবে|দেখাবে|লিখবে|খুঁ?জবে|শোনাবে|(?:পাঠি[য\\u09DF]\\u09BC?ে|জানি[য\\u09DF]\\u09BC?ে|বলে|মনে\\s{1,2}করি[য\\u09DF]\\u09BC?ে)\\s{1,2}(?:দেবে|দিবে)|(?:চেক|ট্র্যাক|আপডেট)\\s{1,2}করবে)(?<=(?<![\\p{L}\\p{M}])তুমি(?![\\p{L}\\p{M}])[^।?!\\n]{0,80})",
      // "এটা প্রতি সপ্তাহে করো" (do this every week).
      "(?=ক)(?<=(?<![\\p{L}\\p{M}])(?:এটা|এটি|এটাই|এই\\s{1,2}কাজটা|এই\\s{1,2}কাজটি)\\s{1,2}(?:[\\p{L}\\p{M}0-9০-৯]{1,12}\\s{1,2}){0,3})(?:করো|করুন|করবেন|কোরো|করতে\\s{1,2}(?:পারবে|পারবেন|পারো|পারেন)|করে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন))",
    ]),
    strong: B([
      // A reminder with a time or a task ("কাল … মনে করিয়ে দিও", "ওষুধ খেতে মনে করিয়ে দিও"), not "হ্যামলেটের
      // কাহিনীটা মনে করিয়ে দাও" (remind me of the plot), "মনে করিয়ে দিল" (reminded me) or "কাল কী বলেছিলাম".
      "(?=মনে\\s{1,2}করি[য\\u09DF]\\u09BC?ে\\s{1,2}দ|মনে\\s{1,2}করা|রিমাইন্ড\\s{1,2}কর)(?:(?<=(?:ার|ও[য\\u09DF]\\u09BC?ার)\\s{1,2}কথা\\s{1,2}(?:আমাকে\\s{1,2}|আমা[য\\u09DF]\\u09BC?\\s{1,2})?)|(?<=(?<![\\p{L}\\p{M}])(?:খেতে|করতে|নিতে|দিতে|যেতে|আনতে|কিনতে|প[ড\\u09DC]\\u09BC?তে|তুলতে|পাঠাতে|ঘুমাতে|উঠতে)\\s{1,2}(?:আমাকে\\s{1,2}|আমা[য\\u09DF]\\u09BC?\\s{1,2})?)|(?<=(?<![\\p{L}\\p{M}])(?:আগামীকাল|কাল|কালকে|পরশু|আজ|আজকে|সকাল|দুপুর|বিকাল|বিকেল|সন্ধ্যা|রাত|প্রতিদিন|রোজ|প্রতি|প্রত্যেক|মিনিট|ঘণ্টা|ঘন্টা|তারিখ|সোমবার|মঙ্গলবার|বুধবার|বৃহস্পতিবার|শুক্রবার|শনিবার|রবিবার|রোববার|টা)(?:ে|[য\\u09DF]\\u09BC?|তে|ের|কে|ই)?(?![\\p{L}\\p{M}])(?:(?!ছিল|ছিলো|ছিলাম|লাম|কী|কি\\s)[^।?!\\n]){0,60})|(?=(?:মনে\\s{1,2}করি|রিমাইন্ড)[^।?!\\n]{0,50}?(?<![\\p{L}\\p{M}])(?:আগামীকাল|কাল|কালকে|পরশু|আজ|আজকে|সকাল|সন্ধ্যা|রাত|প্রতিদিন|রোজ|প্রতি|মিনিট|ঘণ্টা|তারিখ|সোমবার|মঙ্গলবার|বুধবার|বৃহস্পতিবার|শুক্রবার|শনিবার|রবিবার)(?:ে|[য\\u09DF]\\u09BC?|তে|ের|কে|ই)?(?![\\p{L}\\p{M}])(?![^।?!\\n]{0,30}?(?:ছিল|ছিলো|ছিলাম|লাম))))(?:মনে\\s{1,2}করি[য\\u09DF]\\u09BC?ে\\s{1,2}(?:দাও|দিও|দি[য\\u09DF]\\u09BC?ো|দিন|দেবেন|দিবেন|দি[য\\u09DF]\\u09BC?েন|দে|দিস|দিবা)|মনে\\s{1,2}করাবে|মনে\\s{1,2}করাবেন|মনে\\s{1,2}করাতে\\s{1,2}(?:পারবে|পারবেন)|রিমাইন্ড\\s{1,2}(?:করো|করুন|করবেন|কোরো|করিও|করে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন)))",
      "(?:রিমাইন্ডার|অ্যালার্ট)\\s{1,2}(?:সেট\\s{1,2}(?:করো|করুন|করবেন|কোরো|করে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন))|পাঠাও|পাঠান|পাঠাবেন|পাঠিও|পাঠি[য\\u09DF]\\u09BC?ে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন)|দাও|দিও|দেবেন|দিবেন|দিন)",
      // "নতুন আইফোন রিলিজ হলে আমাকে জানাবেন" (a future event), not "কবে শেষ হয়েছিল বলো", "দাম বাড়লে কী করব বলো",
      // "বাবা অফিস থেকে এলে জানাবে" ("comes" only of something new) or "জানিও বলেছিলাম" (I had said).
      "(?=[রলবপঘআউঅসচনওকছএ])(?<![\\p{L}\\p{M}])(?:(?:রিলিজ|লঞ্চ|লাঞ্চ|বের|প্রকাশ|প্রকাশিত|ঘোষণা|ঘোষিত|আউট|উপলব্ধ|অ্যাভেইলেবল|অ্যাভেলেবল|সস্তা|চালু|লাইভ)\\s{1,2}(?:হলে|হলেই|হ[য\\u09DF]\\u09BC?ে\\s{1,2}গেলে|হও[য\\u09DF]\\u09BC?া\\s{1,2}মাত্র|হও[য\\u09DF]\\u09BC?ার\\s{1,2}সাথে\\s{1,2}সাথে|হবে[,\\s]{1,3}তখন)|(?:স্টকে|সেলে|বাজারে)\\s{1,2}(?:এলে|আসলে|এলেই|আসা\\s{1,2}মাত্র|আসবে[,\\s]{1,3}তখন)|(?:নিচে|নীচে|উপরে|ওপরে|কমে|বে[ড\\u09DC]\\u09BC?ে|নেমে|উঠে)\\s{1,2}(?:গেলে|গেলেই|আসলে|এলে)|নামলে|নামলেই|কমলে|কমলেই|বা[ড\\u09DC]\\u09BC?লে|বা[ড\\u09DC]\\u09BC?লেই|উঠলে|উঠলেই|পৌঁ?ছালে|পৌঁ?ছলে|ছা[ড\\u09DC]\\u09BC?ালে|পার\\s{1,2}হলে|পাও[য\\u09DF]\\u09BC?া\\s{1,2}(?:গেলে|গেলেই)|(?:এলে|এলেই|আসবে[,\\s]{1,3}তখন)(?<=(?<![\\p{L}\\p{M}])(?:নতুন|রেজাল্ট|ফলাফল|অফার|ডিল|খবর|আপডেট|সিজন|পর্ব)\\s{1,2}(?:[\\p{L}\\p{M}A-Za-z0-9০-৯]{1,15}\\s{1,2}){0,3}(?:এলে|এলেই|আসবে[,\\s]{1,3}তখন)))(?:(?!কী|কি|কত|কেন|কীভাবে|কিভাবে|কোন|কবে)[^।?!\\n]){0,25}?(?:আমাকে\\s{1,2}|আমা[য\\u09DF]\\u09BC?\\s{1,2}|আমারে\\s{1,2})?(?:সাথে\\s{1,2}সাথে\\s{1,2}|সঙ্গে\\s{1,2}সঙ্গে\\s{1,2}|তখনই\\s{1,2}|তখন\\s{1,2}|দ্রুত\\s{1,2})?(?:জানাও|জানান|জানাবেন|জানাবে|জানিও|জানি[য\\u09DF]\\u09BC?ো|জানা[য\\u09DF]\\u09BC?েন|জানাইও|জানি[য\\u09DF]\\u09BC?ে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন|দি[য\\u09DF]\\u09BC?েন)|বলো|বলুন|বলবেন|বলে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন)|নোটিফাই\\s{1,2}(?:করো|করুন|করবেন|কোরো|করে\\s{1,2}(?:দাও|দিও|দিন|দেবেন))|(?:মেসেজ|খবর|অ্যালার্ট)\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন|করো|করবেন|কোরো|পাঠাও|পাঠিও)|ইমেইল\\s{1,2}(?:করো|করবেন|কোরো))(?!\\s{0,2}(?:কী|কি|কত|কেন|কীভাবে|কিভাবে|কোন)(?![\\p{L}\\p{M}]))(?![^।?!\\n]{0,15}?(?:ছিলাম|ছিলে|ছিলেন|ছিল|লাম)(?![\\p{L}\\p{M}]))",
      // "যখন দাম ৫০ হাজারের নিচে যাবে, আমাকে জানাবেন" (when it will drop, let me know).
      "(?=[রলবপঘআউঅসচনকউ])(?<![\\p{L}\\p{M}])(?:(?:রিলিজ|লঞ্চ|লাঞ্চ|বের|প্রকাশ|প্রকাশিত|ঘোষণা|আউট|উপলব্ধ|অ্যাভেইলেবল|সস্তা|চালু|লাইভ)\\s{1,2}হবে|পাও[য\\u09DF]\\u09BC?া\\s{1,2}যাবে|(?:স্টকে|সেলে|বাজারে)\\s{1,2}আসবে|(?:নিচে|নীচে|উপরে|ওপরে)\\s{1,2}(?:যাবে|নামবে|উঠবে)|নামবে|কমবে|বা[ড\\u09DC]\\u09BC?বে|উঠবে|পৌঁ?ছাবে)(?<=(?<![\\p{L}\\p{M}])(?:যখন|যখনই|যেদিন)\\s(?:(?!কবে|ছিল|ছিলো|হ[য\\u09DF]\\u09BC?েছিল|হ[য\\u09DF]\\u09BC?েছে|কী|কি|কত|কেন)[^।?!\\n]){0,80})[,\\s]{1,3}(?:তখন(?:ই)?\\s{1,2})?(?:আমাকে\\s{1,2}|আমা[য\\u09DF]\\u09BC?\\s{1,2}|আমারে\\s{1,2})?(?:জানাও|জানান|জানাবেন|জানাবে|জানিও|জানি[য\\u09DF]\\u09BC?ো|জানা[য\\u09DF]\\u09BC?েন|জানাইও|জানি[য\\u09DF]\\u09BC?ে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন|দি[য\\u09DF]\\u09BC?েন)|বলো|বলুন|বলবেন|বলে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন)|নোটিফাই\\s{1,2}(?:করো|করুন|করবেন|কোরো|করে\\s{1,2}(?:দাও|দিও|দিন|দেবেন))|(?:মেসেজ|খবর|অ্যালার্ট)\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন|করো|করবেন|কোরো|পাঠাও|পাঠিও)|ইমেইল\\s{1,2}(?:করো|করবেন|কোরো))(?!\\s{0,2}(?:কী|কি|কত|কেন|কীভাবে|কিভাবে|কোন)(?![\\p{L}\\p{M}]))(?![^।?!\\n]{0,15}?(?:ছিলাম|ছিলে|ছিলেন|ছিল|লাম)(?![\\p{L}\\p{M}]))",
      "(?:আমাকে|আমা[য\\u09DF]\\u09BC?)\\s{1,2}(?:জানাও|জানান|জানাবেন|জানাবে|জানিও|জানি[য\\u09DF]\\u09BC?ো|জানি[য\\u09DF]\\u09BC?ে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন)|বলো|বলুন|বলবেন|বলে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন)|নোটিফাই\\s{1,2}(?:করো|করুন|করবেন|কোরো))\\s{1,2}(?:যখন|যখনই|যেদিন)\\s{1,2}(?:(?!কবে|ছিল|ছিলো|হ[য\\u09DF]\\u09BC?েছিল|হ[য\\u09DF]\\u09BC?েছে)[^।?!\\n]){0,60}?(?:(?:রিলিজ|লঞ্চ|লাঞ্চ|বের|প্রকাশ|প্রকাশিত|ঘোষণা|আউট|উপলব্ধ|অ্যাভেইলেবল|সস্তা|চালু|লাইভ)\\s{1,2}(?:হবে|হ[য\\u09DF]\\u09BC?)|আসবে|নামবে|কমবে|বা[ড\\u09DC]\\u09BC?বে|উঠবে|পৌঁ?ছাবে)",
      "(?:এটা|এটি|এটাকে|এই\\s{1,2}কাজটা|এই\\s{1,2}কাজটি)\\s{1,2}(?:অটোমেট|অটোমেশন)\\s{1,2}(?:করো|করুন|করবেন|করে\\s{1,2}(?:দাও|দিন|দিও|দেবেন)|করতে\\s{1,2}(?:পারবে|পারবেন|পারো|পারেন))",
      // "আমাকে সাপ্তাহিক সারাংশ পাঠাও" (send me a weekly summary), not "আমার মাসিক রিপোর্ট".
      "(?:আমাকে|আমা[য\\u09DF]\\u09BC?)\\s{1,2}(?:(?!(?:আমার|তোমার|আপনার|এই|ওই|সেই)\\s)[\\p{L}\\p{M}A-Za-z0-9০-৯]{1,15}\\s{1,2}){0,3}?(?:দৈনিক|সাপ্তাহিক|মাসিক|ডেইলি|উইকলি|মান্থলি)\\s{1,2}(?:আপডেট|সারাংশ|সামারি|রিপোর্ট|খবর|নিউজ|ডাইজেস্ট|ব্রিফিং|রিমাইন্ডার|টিপস|উক্তি|কোট)(?:গুলো|টা|টি)?\\s{1,2}(?:পাঠাও|পাঠান|পাঠাবেন|পাঠিও|পাঠি[য\\u09DF]\\u09BC?ে\\s{1,2}(?:দাও|দিও|দিন|দেবেন|দিবেন)|পাঠাতে\\s{1,2}(?:থাকো|থাকুন|থাকবেন)|দাও|দিও|দেবেন|দিবেন|দি[য\\u09DF]\\u09BC?েন|দিন)",
    ]),
    // How much, why, how, should, benefits or harm, is it good/normal, which is better, a habit of mine ("আমি … যাই,")
    // or anyone's ("অফিসে মিটিং হয়,", "কী হয়"), "কী উপহার দেব", "can I", "have to", "ways to cope", "make a routine",
    // and translating or a word's meaning.
    not: /(?<![\p{L}\p{M}])(?:কত|কতো)(?:টা|টুকু|গুলো|জন|বার|ক্ষণ|দিন|খানি)?(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?:কেন|কেনো|কীভাবে|কিভাবে|কেমনে)(?![\p{L}\p{M}])|(?:কী|কি)\s{1,2}ভাবে|কেমন\s{1,2}করে|উচিত|উচিৎ|উপকার|অপকার|ক্ষতিকর|(?<![\p{L}\p{M}])ক্ষতি(?![\p{L}\p{M}])|(?:কি|কী)\s{1,2}(?:ভালো|ভাল|খারাপ|ঠিক|স্বাভাবিক|নিরাপদ|জরুরি|দরকার)(?![\p{L}\p{M}])|(?:ভালো|ভাল|খারাপ|স্বাভাবিক|নিরাপদ)\s{1,2}(?:কি|কী|নাকি)(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?:আমি|আমরা)\s(?:(?!চাই|কি\s)[^।?!\n,]){0,60}?[িই](?=\s{0,2}(?:[,।?!]|$))|(?<![\p{L}\p{M}])(?:যাই|খাই|করি|দেখি|প[ড\u09DC]\u09BC?ি|উঠি|ঘুমাই|দৌ[ড\u09DC]\u09BC?াই|খেলি|শুনি|থাকি|লিখি|হাঁ?টি|কিনি|চালাই)(?=\s{0,2}(?:[,।?!]|$))|(?<![\p{L}\p{M}])(?:কী|কি|কোন|কোনটা)\s{1,2}(?:[\p{L}\p{M}]{1,12}\s{1,2}){0,2}(?:করব|করবো|খাব|খাবো|দেব|দেবো|দিব|নেব|নেবো|কিনব|কিনবো|যাব|যাবো|পরব|পরবো|লিখব|লিখবো|প[ড\u09DC]\u09BC?ব|প[ড\u09DC]\u09BC?বো|শিখব|শিখবো|দেখব|দেখবো|বানাব|বানাবো|বলব|বলবো)(?![\p{L}\p{M}])|তে\s{1,2}(?:হ[য\u09DF]\u09BC?|হবে|হতো)(?![\p{L}\p{M}])|(?:কী|কি)\s{1,2}হ[য\u09DF]\u09BC?(?![\p{L}\p{M}])|লে\s{1,2}(?:কী|কি)\s{1,2}হবে(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?<!যদি[^,।?!\n]{1,40})হ[য\u09DF]\u09BC?(?=\s{0,2}(?:[,।?!]|$)|\s{1,2}(?:তার|তাই|এর|সেজন্য|সেই|ওই)(?![\p{L}\p{M}]))|(?:কোনটা|কোনটি)\s{1,2}(?:বেশি\s{1,2})?(?:ভালো|ভাল|ঠিক)(?![\p{L}\p{M}])|(?:কী|কি)\s{1,2}(?:করা|খাও[য\u09DF]\u09BC?া|প[ড\u09DC]\u09BC?া|দেখা|শোনা|পরা|কেনা|রাখা)\s{1,2}(?:ভালো|ভাল|উচিত|দরকার)(?![\p{L}\p{M}])|র\s{1,2}(?:উপা[য\u09DF]\u09BC?|কৌশল)(?![\p{L}\p{M}])|(?:রুটিন|প্ল্যান|পরিকল্পনা|চার্ট|সম[য\u09DF]\u09BC?সূচি|সম[য\u09DF]\u09BC?সূচী|টাইমটেবিল|টাইম\s{1,2}টেবিল)\s{1,2}(?:বানি[য\u09DF]\u09BC?ে|বানাও|বানান|বানাবেন|তৈরি)|তে\s{1,2}পারি(?![\p{L}\p{M}])|অনুবাদ|ট্রান্সলেট|(?:মানে|অর্থ)\s{1,2}(?:কী|কি)(?![\p{L}\p{M}])|ইংরেজিতে\s{1,2}(?:কী|কি|কীভাবে|কিভাবে)(?![\p{L}\p{M}])/u,
    // "প্রতিদিন সকালে করার মতো রুটিন বলো" (a routine to do each morning), "… যা আমি রোজ করতে পারি", "প্রতি শুক্রবার
    // মসজিদে যাই, …" (I go to the mosque).
    between: /(?:করার|খাও[য\u09DF]\u09BC?ার|দেখার|প[ড\u09DC]\u09BC?ার|শোনার|যাও[য\u09DF]\u09BC?ার|থাকার|নেও[য\u09DF]\u09BC?ার|দেও[য\u09DF]\u09BC?ার|ঘুমানোর)\s{1,2}(?:মতো|মত|জন্য)(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(?:যা|যে|যেটা|যেটি|যেগুলো|যিনি|যারা|যাতে|যেন|এমন)(?![\p{L}\p{M}])|(?:করা|খাও[য\u09DF]\u09BC?া)\s{1,2}যা[য\u09DF]\u09BC?|(?<![\p{L}\p{M}])(?:যাই|খাই|করি|প[ড\u09DC]\u09BC?ি|উঠি|ঘুমাই|দৌ[ড\u09DC]\u09BC?াই|খেলি|শুনি|থাকি|লিখি|হাঁ?টি|কিনি|চালাই|পাই)(?![\p{L}\p{M}])(?!\s{1,2}হোক)/u,
  },
  id: {
    recur: B([
      // Not "untuk setiap hari dalam seminggu" (for each day of the week) or "hampir setiap hari" (almost every day).
      "(?<!(?<![\\p{L}])(?:untuk|buat|dalam|hampir) )(?:setiap|tiap|stiap|saban) (?:hari|harinya|pagi|siang|sore|malam|subuh|maghrib|magrib|dini hari|tengah malam|minggu|pekan|bulan|tahun|(?:awal|akhir) (?:bulan|minggu|tahun)|(?:tanggal|tgl) \\d{1,2}|jam|menit|senin|selasa|rabu|kamis|jumat|jum'at|sabtu|ahad|akhir pekan|weekend|hari kerja|\\d{1,3} (?:jam|menit|hari|minggu|bulan)|(?:dua|tiga|empat|lima|enam) (?:jam|hari|minggu))(?! dalam (?:seminggu|sebulan|setahun))",
      "(?:sehari|seminggu|sebulan|sejam) (?:sekali|dua kali|tiga kali|\\d{1,2} ?kali)|(?:\\d{1,2}|dua|tiga|empat) ?kali (?:sehari|seminggu|sebulan)",
      // "harian" alone is "laporan harian" (daily report), "koran harian": only as an adverb.
      "secara (?:rutin|berkala|harian|mingguan|bulanan|teratur)",
    ]),
    act: B([
      "kirim(?:kan|in|i|kanlah)?|ingatkan|ingetin|ingatin|ingetkan|ngingetin|beri ?tahu(?:kan)?|kasih (?:tahu|tau|kabar|info)|kasitau|kabari|kabarin|kabarkan|infoin|infokan|update(?:in)?|laporkan|laporin",
      "cek|cekin|cekkan|check|periksa|periksain|pantau|pantauin|awasi|awasin|lacak|lacakin|monitor(?:in)?",
      "rangkum|rangkumin|rangkumkan|ringkas|ringkaskan|ringkasin|cari|carikan|cariin|riset|risetin|teliti|selidiki",
      "tulis|tuliskan|tulisin|buatkan|buatin|bikinin|bikinkan|susun|susunkan|susunin|berikan|beri|(?<!(?:terima|trima) )kasih(?! sayang)|kasi|sajikan|tampilkan|tunjukkan|bagikan|bandingkan|bandingin|rekomendasikan|sarankan|saranin|lakukan|lakuin|jalankan|jalanin|ulangi|ajari|ajarin|ajarkan",
      "(?:bisa(?:kah)?|dapatkah|tolong|mohon) (?:kamu |anda |kau |lo |lu |kak |min )?(?:mengirim(?:kan|i)?|memberi ?tahu|memberitahukan|mengingatkan|memeriksa|mengecek|memantau|merangkum|meringkas|mencari(?:kan)?|membuat(?:kan)?|menulis(?:kan)?|memberi(?:kan)?|mengabari|melaporkan|menampilkan)",
      // "Saya mau dikirimi berita tiap sore" (I want to be sent …).
      "(?:(?:saya|aku|gue|gw|gua|kami) )?(?:mau|ingin|pengen|pengin|minta) di(?:kirimi|kirimin|kirimkan|ingatkan|ingetin|kabari|kabarin|beri ?tahu|kasih (?:tahu|tau)|update|infoin)",
    ]),
    strong: B([
      // "Ingatkan saya untuk bayar listrik besok", never "Ingatkan saya tentang alur cerita Hamlet".
      "(?:ingatkan|ingetin|ingatin|ingetkan|ngingetin)(?: (?:saya|aku|gue|gw|kami|kita))?(?: (?:ya|dong|lagi))? (?:untuk|buat|biar|agar|supaya|bahwa)",
      "(?:ingatkan|ingetin|ingatin|ingetkan|ngingetin)(?: (?:saya|aku|gue|gw|kami|kita))?(?: (?:ya|dong|lagi))? [^.?!\\n]{0,60}?(?:besok|nanti|lusa|setiap|tiap|jam \\d|pukul \\d|minggu depan|bulan depan|malam ini|sore ini|pagi ini|siang ini|hari (?:senin|selasa|rabu|kamis|jumat|sabtu|minggu)|(?:senin|selasa|rabu|kamis|jumat|sabtu|minggu) (?:ini|depan|nanti)|dalam \\d{1,3} (?:menit|jam|hari)|\\d{1,3} (?:menit|jam) lagi)(?![\\p{L}])",
      "(?:pasang|pasangin|pasangkan|buatkan|buatin|bikinin|bikinkan|atur|aturin|aturkan|set|setel|setin|jadwalkan|jadwalin)(?: (?:aku|saya|gue))? (?:sebuah |satu )?(?:pengingat|reminder|otomasi|automasi)",
      // "Kabari aku kalau iPhone baru rilis", never "Kasih tahu saya kapan Perang Dunia II berakhir".
      "(?:kabari|kabarin|kabarkan|beri ?tahu|kasih (?:tahu|tau)|kasitau|infoin|infokan|notif(?:in|kan)|kirim(?:in|kan)? notif(?:ikasi)?)(?: (?:saya|aku|gue|gw|kami))?(?: (?:ya|dong|segera))? (?:kalau|kalo|klo|jika|ketika|saat|begitu|pas|bila|apabila|segera setelah|setelah|kapanpun|kapan pun|setiap kali)(?:(?!tahun \\d|dulu|kemarin|pernah|waktu itu)[^.?!\\n]){0,60}?(?:turun|naik|rilis|dirilis|keluar|tersedia|ready|restock|diumumkan|terbit|diskon|promo|launching|meluncur|diluncurkan|menyentuh|tembus|di ?bawah|di ?atas|mencapai|lebih murah|berubah|ada (?:promo|diskon|stok|lowongan|update|berita baru|kabar baru|tiket))(?![\\p{L}])(?![^.?!\\n]{0,30}?(?:tahun \\d|dulu|kemarin|waktu itu))",
      "(?:kirim|kirimkan|kirimin|kirimi|berikan|beri|kasih|kasi) (?:saya|aku|gue|gw|kami)(?: (?:sebuah|satu))? (?:ringkasan|rangkuman|laporan|update|berita|info|informasi|pengingat|rekap|kutipan|tips|ramalan|kabar)(?: \\p{L}{2,15})?? (?:harian|mingguan|bulanan)(?! (?:ini|itu|tersebut|kemarin|yang|ke)(?![\\p{L}]))",
      // The event first: "Kalau harga emas turun, kabari aku ya", with nothing after the request: not "Kalau harga BBM
      // naik, kasih tahu dampaknya" or "Pas harga turun kemarin, kenapa nggak kabari aku".
      "(?<=^\\s{0,3})(?:kalau|kalo|klo|jika|bila|apabila|begitu|setelah|pas|saat|kapanpun|kapan pun)(?:(?!tahun \\d|dulu|kemarin|pernah|waktu itu|tadi)[^.?!\\n]){1,60}?(?<![\\p{L}])(?:turun|naik|rilis|dirilis|keluar|tersedia|ready|restock|diumumkan|terbit|diskon|promo|launching|meluncur|diluncurkan|menyentuh|tembus|di ?bawah|di ?atas|mencapai|lebih murah|berubah|dibuka|buka|ada (?:promo|diskon|stok|lowongan|update|berita baru|kabar baru|tiket))(?![\\p{L}])(?:(?!(?<![\\p{L}])(?:kemarin|dulu|tadi|waktu itu|kenapa|mengapa|kok|nggak|ngga|gak|ga|enggak|tidak|jangan)(?![\\p{L}]))[^.?!\\n]){0,30}?(?<![\\p{L}])(?:(?:langsung|segera|cepat|tolong|mohon) )?(?:kabari|kabarin|kabarkan|beri ?tahu|kasih (?:tahu|tau)|kasitau|infoin|infokan|notif(?:in|kan)|ingatkan|ingetin)(?: (?:saya|aku|gue|gw|kami|kita))?(?: (?:ya|yah|dong|segera|secepatnya|aja|kak|min))?(?=\\s{0,3}$)",
      "(?:kirim|kirimkan|kirimin|kirimi|berikan|beri|kasih|kasi) (?:saya|aku|gue|gw|kami)(?: (?:sebuah|satu))? (?:daily|weekly|monthly) (?:update|summary|report|recap|news|digest|briefing|reminder|quote|tips|newsletter)",
      "otomatiskan (?:ini|itu|tugas ini)|(?:jadikan|bikin) (?:ini|itu) (?:jadi )?otomatis",
    ]),
    // A question ("berapa banyak", "kenapa", "manfaat", "normal gak"), a habit ("Setiap Senin saya ke gym", "saya biasanya")
    // or a fact ("Setiap Senin ada rapat").
    not: B([
      "(?<!(?:harga|kurs|suhu|skor|nilai)[^,.]{0,30})berapa|bedanya|perbedaan|beda (?:antara|dari)|mana yang|yang mana|di ?mana|ke ?mana|seberapa (?:sering|banyak|lama)|kenapa|mengapa|knp|napa",
      "(?:bagaimana|gimana|gmn) (?:cara(?:nya)?|saya|aku|gue|kita)|caranya|\\p{L}{3,15}nya (?:gimana|bagaimana|gmn|kayak apa|seperti apa)|cara (?:membuat|mengatur|memasang|bikin|pasang|atur|set|menghentikan|berhenti|agar|supaya|biar|untuk)",
      "apa itu|apa arti|artinya apa|apa maksud|manfaat|kelebihan dan kekurangan|efek samping|dampak|bahaya",
      "apakah (?:baik|bagus|buruk|normal|sehat|aman|boleh|perlu|harus|wajar|berbahaya|efektif)|(?:baik|bagus|buruk|sehat|aman|normal|wajar|bahaya|sopan|berlebihan|lebay|salah|benar|efektif|penting|perlu|aneh)(?:kah| (?:gak|nggak|ga|tidak|ngga|enggak|atau tidak))",
      "(?:sebaiknya|harus(?:kah)?|perlu(?:kah)?|boleh(?:kah)?) (?:saya|aku|gue|kita)|(?:saya|aku|gue|gw|kami|kita) (?:harus|sebaiknya|perlu|wajib|boleh|biasanya|biasa|selalu|sering|rutin|suka|kadang)(?! lupa)",
      "(?:setiap|tiap) (?:hari|pagi|siang|sore|malam|minggu|pekan|bulan|senin|selasa|rabu|kamis|jumat|sabtu|ahad)(?: (?:jam|pukul) \\d{1,2}(?:[.:]\\d{2})?| (?:pagi|siang|sore|malam))? (?:saya|aku|gue|gw|gua|kami|kita)(?! (?:mau|ingin|pengen|pengin|minta|butuh|perlu)(?![\\p{L}]))",
      "(?:setiap|tiap) (?:hari|pagi|siang|sore|malam|minggu|pekan|bulan|senin|selasa|rabu|kamis|jumat|sabtu|ahad)(?: (?:pagi|siang|sore|malam|jam \\d{1,2}))? (?:ada|punya)",
      // What happens on the schedule, then a one-off request: "Setiap pagi macet banget, kasih aku rute alternatif".
      "(?:setiap|tiap) \\p{L}{3,12}(?: [\\p{L}\\d]{1,15}){0,3}? (?:banget|bgt|mulu|melulu|selalu|pasti|sering|jarang)(?: [\\p{L}\\d]{1,15}){0,4}(?=\\s{0,3}[,;])",
    ]),
    // Between them, what the schedule describes: "resep yang bisa dimasak setiap hari".
    between: /(?<![\p{L}])(?:yang (?:bisa|dapat|harus|perlu|boleh|saya|aku|gue|kita|kamu|biasa|sering|buka|tutup|beroperasi|berlangsung|diadakan|digelar|tayang|terbit|libur|berangkat|dijual|dimakan|diminum|dipakai|digunakan|terjadi)|(?:bisa|dapat|harus|perlu) (?:saya|aku|gue|kita))(?![\p{L}])/iu,
    // A request said by someone else ("saya cek HP setiap jam", "Mama selalu ingetin aku"), or how-to ("cara pasang pengingat").
    lead: /(?<!(?<![\p{L}])(?:(?:saya|aku|gue|gw|gua|kami|kita|dia|ia|mereka|beliau|ini|itu|yang|cara|caranya|gimana|bagaimana)(?:\s{1,3}(?:biasanya|selalu|sering|suka|harus|perlu|mau|ingin|pengen|pengin|bisa|dapat|akan|sudah|udah|telah|sedang|lagi|juga|cuma|hanya|nggak|ngga|gak|ga|tidak|jarang|masih|sempat|pernah|baru|tetap|rutin|wajib|kadang|hampir|pasti|untuk|buat)){0,2}|(?<!(?:tolong|mohon|coba|please|pls)\s{1,3})(?:selalu|sering|biasanya|suka|udah|sudah|pernah|tadi|kemarin|telah|sempat))\s{1,3})$/iu,
  },
  sw: {
    recur: B([
      // Not "ya kila siku" (of every day): "maisha ya kila siku", "ripoti ya kila wiki", "kwa kila siku ya wiki".
      "(?<!(?<![\\p{L}])(?:ya|wa|za|la|cha|vya|kwa|mwa|pa) )kila (?:siku|asubuhi|mchana|alasiri|jioni|usiku|wiki|juma|wikendi|(?:mwisho|mwanzo) wa (?:wiki|juma|mwezi)|mwezi|tarehe \\d{1,2}|morning|evening|week|weekend|month|saa|dakika|jumatatu|jumanne|jumatano|alhamisi|ijumaa|jumamosi|jumapili|baada ya (?:saa|siku|wiki|dakika)|inapofika saa|ifikapo saa)",
      "mara (?:moja|mbili|tatu|\\d{1,2}) (?:kwa|kila) (?:siku|wiki|juma|mwezi|saa)",
      // Sheng: "Every Monday nitumie ripoti ya mauzo".
      "every ?day|every (?:morning|evening|night|week|weekend|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
    ]),
    act: B([
      "u?ni(?:tumie|kumbushe|julishe|arifu|ambie|pe|patie|letee|andikie|tafutie|fupishie|tungie|andalie|tengenezee|orodheshee|angalilie|chunguzie|fuatilie|elezee|eleze|fundishe|fanyie|pendekezee|shauri)(?:ni)?|u?tu(?:tumie|kumbushe|julishe|arifu|ambie|pe)(?:ni)?",
      "(?:tum|kumbush|julish|angali|kagu|chunguz|fuatili|fupish|tafut|andik|tung|anda|tengenez|orodhesh|linganish|let)(?:a|eni)|hakiki|arifu|tafiti|fanya (?:hivi|hivyo|hili|hilo)|rudia (?:hivi|hili)|toa muhtasari",
      "(?:unaweza|waweza|utaweza|ungeweza|naomba|ninaomba|nakuomba|tafadhali) ku(?:ni|tu)?(?:tumia|kumbusha|julisha|arifu|ambia|pa|patia|letea|andikia|tafutia|fupishia|angalia|angalilia|kagua|chunguza|fuatilia|fupisha|tafuta|andika|tunga|andaa|tengeneza|orodhesha|linganisha)",
      // "Nitashukuru ukinitumia…" (I'd be grateful if you sent me…).
      "uki(?:ni|tu)(?:tumia|kumbusha|julisha|arifu|ambia|pa|patia|letea|andikia|tafutia)",
    ]),
    strong: B([
      // "Nikumbushe kulipa kodi kesho", never "Nikumbushe kuhusu hadithi ya Hamlet" or "ulinikumbusha" (reminded me).
      "(?:u?(?:ni|tu)kumbushe(?:ni)?|(?:unaweza|waweza|utaweza|ungeweza|naomba|ninaomba|nakuomba|tafadhali) kunikumbusha|ukinikumbusha) (?:ku(?!husu)\\p{L}{2,15}|kesho|leo|jioni|usiku|asubuhi|mchana|saa|kila|siku ya|tarehe|wiki ijayo|mwezi ujao|baada ya|kwamba|kuwa|jumatatu|jumanne|jumatano|alhamisi|ijumaa|jumamosi|jumapili)",
      "(?:u?(?:ni|tu)kumbushe(?:ni)?|(?:unaweza|naomba|tafadhali) kunikumbusha) [^.?!\\n]{0,60}?(?:kesho|leo (?:jioni|usiku|mchana)|saa \\d{1,2}|wiki ijayo|mwezi ujao|baada ya (?:saa|dakika|siku) \\p{L}{1,10})(?![\\p{L}])",
      "(?:u?niwekee|weka|tengeneza|u?nitengenezee|unda|u?niundie) (?:kikumbusho|ukumbusho)",
      // "Nijulishe iPhone mpya itakapotoka" (when it will come out), "Bei ikishuka chini ya 50k, nijulishe".
      "(?:u?(?:ni|tu)(?:julishe|arifu|ambie)(?:ni)?|(?:unaweza|naomba|tafadhali) kuni(?:julisha|arifu|ambia)|u?nitumie (?:ujumbe|taarifa|arifa))[^.?!\\n]{0,60}?(?:\\p{L}{1,4}takapo\\p{L}{2,15}|\\p{L}{1,3}ki(?:shuka|panda|toka|fika|zidi|vuka|patikana|tangazwa|chapishwa|ingia|badilika|tolewa|zinduliwa|punguzwa|pungua|ongezeka)\\p{L}{0,4})",
      "\\p{L}{1,3}ki(?:shuka|panda|toka|fika|zidi|vuka|patikana|tangazwa|chapishwa|ingia|badilika|tolewa|zinduliwa|punguzwa|pungua|ongezeka)\\p{L}{0,4}[^.?!\\n]{0,40}?u?(?:ni|tu)(?:julishe|arifu|ambie)",
      // "Ukiona habari mpya kuhusu …, nijulishe" (if you see), not "Ukiona nyoka, niambie nifanye nini".
      "\\p{L}{0,2}ki(?:ona|sikia|pata|anza)\\p{L}{0,4} [^.?!\\n]{0,50}?u?(?:ni|tu)(?:julishe|arifu)(?:ni)?",
      "u?(?:ni|tu)tumie (?:\\p{L}{2,15} ){0,2}?(?:muhtasari|ripoti|habari|taarifa|ukumbusho|kikumbusho|nukuu|utabiri|orodha|vidokezo|arifa)(?: \\p{L}{2,15})? (?:ya|wa|za|la|cha|vya) kila (?:siku|wiki|juma|mwezi|asubuhi|jioni|saa)",
    ]),
    // A question ("mara ngapi", "kwa nini", "faida za", "ni vizuri kunywa") or a first-person habit ("ninaenda", "mimi huangalia").
    not: B([
      "mara ngapi|lita ngapi|glasi ngapi|vikombe vingapi|kalori ngapi|masaa mangapi|(?<!(?:bei|dola|kiwango|thamani|joto)[^,.]{0,30})(?:kiasi gani|ngapi|gharama gani)|kwa nini|kwanini|mbona|jinsi ya|namna ya|ni nini|nini maana|maana ya",
      "faida za|faida ya|hasara za|hasara ya|madhara ya|athari za|athari ya",
      "je,? (?:ni|kuna|inafaa|lazima|naweza)|ni (?:vizuri|vibaya|mbaya|salama|kawaida|afya|hatari|sawa) ku\\p{L}{2,15}|inafaa ku\\p{L}{2,15}",
      "ninywe|nile|nilale|nifanye|nisome|niende|nitembee|nikimbie|niamke|ninapaswa|napaswa|inanipasa|mtu anapaswa",
      "nina(?!omba|taka|hitaji|penda|po)\\p{L}{2,15}|nili\\p{L}{2,15}|nita(?!shukuru|furahi|futie|jie)\\p{L}{2,15}|mimi hu\\p{L}{2,15}|huwa ni\\p{L}{2,15}",
      // "Kila Jumatatu kuna mkutano, …" (there is a meeting every Monday), "Kila mwezi mshahara unaisha haraka, …" (it runs out).
      "kila \\p{L}{3,12}(?: \\p{L}{3,12})? (?:kuna|tuna|nina|huwa na)",
      "kila \\p{L}{3,12}(?: [\\p{L}\\d]{1,15}){0,3}? (?:(?:a|wa|u|i|li|ya|ki|vi|zi|tu|m|mu|ku|ni)(?:na|me)(?!po|weza)\\p{L}{0,15}|ni|si|huwa|hu\\p{L}{3,15})(?: [\\p{L}\\d]{1,15}){0,4}(?=\\s{0,3}[,;])",
    ]),
    // Between them, what the schedule describes: "mapishi ya kupika kila siku", "mazoezi ninayoweza kufanya kila siku".
    between: /(?<![\p{L}])ku\p{L}{2,15}\s{1,3}$|(?<![\p{L}])(?:ninayo|unayo|tunayo|anayo|zinazo|yanayo|inayo|ninazo|unazo)\p{L}{2,15}/iu,
  },
  ht: {
    recur: B([
      // Not "chak jou nan semèn nan" (each day of the week) or "rapò chak semèn nan" / "bidjè chak mwa a pou mwen"
      // (the weekly report, the monthly budget): a determiner closes the phrase; "chak maten nan imèl mwen" is fine.
      "(?<!(?<![\\p{L}])(?:pou|nan) )chak (?:jou|maten|apr[eè]midi|midi|asw[eè]|swa|nwit|lannwit|sem[eè]n|mwa|ane|lane|in[eè]dtan|[eè]dtan|l[eè]dtan|demi [eè]dtan|wikenn|weekend|lendi|madi|m[eè]kredi|jedi|vandredi|samdi|dimanch|\\d{1,3} (?:minit|[eè]dtan|jou|sem[eè]n|mwa)|(?:de|twa|kat|senk|dis|kenz) (?:jou|sem[eè]n|[eè]dtan|mwa)|k[eè]k (?:[eè]dtan|jou))(?: (?:ak|e|epi) (?:lendi|madi|m[eè]kredi|jedi|vandredi|samdi|dimanch))?(?! (?:nan|pou) (?:sem[eè]n|mwa) (?:la|a|nan)(?![\\p{L}])| (?:la|a|an|nan|lan)(?:\\s{0,3}(?:[.?!,;:)]|$)| (?:pou|epi|ak|e|tou|ank[oò])(?![\\p{L}])))(?: (?:a|v[eè]|anvan|apre) \\d{1,2}(?:[:h.]\\d{2})?(?: ?(?:[eè]|h|am|pm))?| a midi| a minwi| (?:nan )?(?:maten|apr[eè]midi|asw[eè]|swa|lannwit)| bon[eè]){0,3}",
      "toul[eè]jou|tou l[eè] jou|tout jou|tout maten|tout asw[eè]",
      "(?:yon|de|twa|\\d{1,2}) fwa (?:pa|chak|nan) (?:jou|sem[eè]n|mwa|[eè]dtan)",
      // "Every morning voye ban m nouvèl yo".
      EN_EVERY[0],
    ]),
    act: B([
      "voye|ban (?:m|mwen|nou)|banm|ba m|bam|di (?:m|mwen|nou)|f[eè] (?:m|mwen|nou) konnen|f[eè]m konnen|av[eè]ti (?:m|mwen|nou)|avize (?:m|mwen)|notifye (?:m|mwen)|montre (?:m|mwen)|ekri (?:m|mwen)|raple (?:m|mwen|nou)|f[eè] (?:m|mwen) sonje|kenbe (?:m|mwen|nou) (?:okouran|enf[oò]me|ajou)|e?ksplike (?:m|mwen)|esplike (?:m|mwen)",
      "tcheke|verifye|gade|swiv|siveye|ch[eè]che|jwenn|rezime|ekri|prepare|konpare|analize|pibliye|poste|chwazi|rek[oò]mande|sijere|repete|kreye|f[eè] (?:yon|on|de|twa|sa|li|l|rech[eè]ch)|ref[eè] (?:sa|li|l)",
      "(?:(?:[eè]ske|es) )?(?:ou|w) (?:ka|kab|kapab|te ka|ta ka|te kapab|ta kapab) (?:voye|ban|di|f[eè]|raple|tcheke|verifye|gade|swiv|ch[eè]che|jwenn|rezime|ekri|prepare|konpare|montre|av[eè]ti|pibliye|kenbe)",
      // "M ta renmen resevwa nouvèl yo…", not "Mwen bezwen resevwa tretman chak semèn".
      "(?:mwen|m) (?:ta renmen|vle|bezwen) resevwa(?! (?:tretman|kou|leson|vizit|masaj|terapi|swen|[eè]d|konsiltasyon)(?![\\p{L}]))",
    ]),
    strong: B([
      // "Raple m peye lwaye a demen", not "Chante sa a fè m sonje anfans mwen" or "Raple m istwa Hamlet la".
      "(?:raple (?:m|mwen|nou)|f[eè] (?:m|mwen|nou) sonje|f[eè]m sonje|(?:(?:[eè]ske|es) )?(?:ou|w) (?:ka|kapab|te ka|ta ka) (?:raple (?:m|mwen)|f[eè] (?:m|mwen) sonje))(?: tanpri)? (?:pou|ke|k[eè]|demen|apredemen|jodi a|asw[eè] a|pita|nan \\d|nan yon|a \\d|a midi|lendi|madi|m[eè]kredi|jedi|vandredi|samdi|dimanch|chak|toul[eè]jou|tout jou|sem[eè]n pwoch[eè]n|mwa pwoch[eè]n|anvan|apre|peye|rele|pran|achte|voye|ale|al|f[eè]|ekri|bw[eè]|manje|tcheke|s[oò]ti|leve|d[oò]mi|etidye|travay|netwaye|lave|jwenn|reponn|renouvle|mete|retire|chanje|prepare|pote|ranje|vizite|kontakte|resevwa|depoze|anile|konfime|tounen|wouze|bay|fini|k[oò]manse|ouvri|f[eè]men)",
      "(?:mete|kreye|f[eè]|pwograme|ajoute|aktive)(?: tanpri)? (?:yon |on )?(?:rap[eè]l|alam|alarm|otomatizasyon)",
      // "Voye yon rapèl ban m pou m bwè dlo chak èdtan".
      "voye (?:m |ban m |ba m |banm )?(?:yon |on )?rap[eè]l (?:ban m|ba m|banm|pou mwen|pou m)",
      "(?:(?:[eè]ske|es) )?(?:ou|w) (?:ka|kapab|te ka) (?:mete|kreye|f[eè]|pwograme) (?:yon |on )?(?:rap[eè]l|alam|otomatizasyon)",
      // "Fè m konnen lè nouvo iPhone nan ap soti", not "fè m konnen si ou bezwen" or "Di m lè Mi Bèlen an te tonbe".
      "(?:f[eè] (?:m|mwen|nou) konnen|f[eè]m konnen|av[eè]ti (?:m|mwen|nou)|avize (?:m|mwen)|notifye (?:m|mwen)|voye (?:yon )?mesaj (?:ban m|ba m|pou mwen)|(?:(?:[eè]ske|es) )?(?:ou|w) (?:ka|kapab|te ka) (?:f[eè] (?:m|mwen) konnen|av[eè]ti (?:m|mwen))) (?:l[eè]|depi|kou|si|kil[eè]|chak fwa|nenp[oò]t l[eè])[^.?!\\n]{0,60}? (?<!te )(?:desann|monte|bese|s[oò]ti|lanse|rive|chanje|tonbe|par[eè]t|ouvri|(?<!(?<![\\p{L}])(?:ou|w|nou|n|mwen|m) (?:ap |va |pral |a )?)(?:disponib|pibliye|anonse|k[oò]manse)|an pwomosyon|an solde|an rab[eè]|an vant|anba|pi ba|pi wo|pi bon mache|bon mache)",
      "(?:f[eè] (?:m|mwen|nou) konnen|f[eè]m konnen|av[eè]ti (?:m|mwen|nou)|avize (?:m|mwen)|notifye (?:m|mwen)) (?:l[eè]|depi|kou|chak fwa|nenp[oò]t l[eè]) (?:ke |k )?(?:gen|genyen|yo (?:pibliye|poste|mete|lanse)) (?:yon |on )?(?:nouvo|nouv[eè]l)",
      "(?:di (?:m|mwen|nou)|(?:[eè]ske|es) (?:ou|w) ka di m) (?:l[eè]|depi|kou|kil[eè])[^.?!\\n]{0,60}? (?:(?:ap|pral|pra|va|ava) (?:desann|monte|bese|s[oò]ti|lanse|rive|chanje|tonbe|par[eè]t|ouvri|disponib)|disponib|an pwomosyon|an solde)",
      "(?:voye|raple (?:m|mwen)|tcheke|verifye|f[eè] sa|f[eè] l|pibliye|poste)(?: [^\\s.?!,]{1,15}){0,3}? otomatikman",
      "otomatikman (?:chak|toul[eè]jou|voye|raple|tcheke)",
      "otomatize (?:sa|li|l|travay sa a)(?: pou mwen| pou m)?(?: tanpri)?$",
      "(?:(?:[eè]ske|es) )?(?:ou|w) (?:ka|kapab) otomatize (?:sa|li|l)(?: pou mwen| pou m)?(?: tanpri)?$",
    ]),
    // How often, why, how much should one, benefits, is it good to, how do I, what happens if, a habit.
    not: B([
      "konb(?:y)?en fwa|chak konb(?:y)?en|ki frekans",
      "poukisa|pouki|pou ki sa|pou ki rezon",
      "konb(?:y)?en [^.?!]{0,40}?(?:dwe|ta dwe|bezwen|f[oò]k|f[oò])",
      "benefis|avantaj|dezavantaj|ef[eè]|risk",
      "(?:li|sa|se) (?:bon|move|n[oò]mal|danjere|pi bon|pi mal|vre)",
      "(?:kijan|k[oò]man|kouman) (?:pou|m ka|mwen ka|m kab|ou f[eè]|w f[eè]|yo f[eè]|yo di)",
      "(?:kisa|ki sa|sa) k ?(?:ap|i)? ?(?:pase|rive) si",
      // "Chak lendi m al nan jim, ban m yon pwogram": a habit, then a one-off ask.
      "(?:chak|toul[eè]jou|tout jou) (?:[\\p{L}\\d]{1,12} ){0,2}(?:m|mwen|nou|n) (?:konn |toujou |abitye )?(?:ale|al|f[eè]|manje|bw[eè]|pran|s[oò]ti|gade|itilize|depanse|touche|peye|boule|d[oò]mi|kouri|mache|etidye|travay|antrene|tcheke|verifye|leve|reveye|benyen|kwit|priye|kondi|w[eè]|santi|resevwa|jwe|naje|voye|ekri|rele|pale|vizite|netwaye|pote|poste|achte)",
      // "Patwon mwen toujou tcheke imèl li chak maten", "Chak swa pitit mwen kriye, ban m konsèy": someone else's habit.
      "(?<=^)(?:pitit|manman|papa|mari|madanm|fr[eè]|s[eè]|patwon|b[oò]s|zanmi|vwazen|mennaj|kouzen|kouzin|chen|chat|yo)(?:(?: fi| gason)? (?:mwen|m|nou|n|li|l|yo))?(?= \\p{L})",
      "(?<=^)(?:chak|toul[eè]jou|tout jou) (?:\\p{L}{1,10} )?(?:pitit|manman|papa|mari|madanm|fr[eè]|s[eè]|patwon|b[oò]s|zanmi|vwazen|mennaj|chen|chat)(?= )",
      // "Di m si chak ane fòk mwen peye taks", "Di m kiyès ki genyen chak ane": a question.
      "(?<=^)(?:di (?:m|mwen|nou)|(?:[eè]ske|es) (?:ou|w) ka di m) (?:si|kiy[eè]s|kil[eè]s)",
      // "Di m sa chak jou vle di": the words themselves.
      "(?:chak \\p{L}{2,10}|toul[eè]jou|otomatikman) vle di",
    ]),
    // "Di m konbyen kalori m boule chak jou", "yon woutin m ka fè chak jou", a past habit.
    between: B([
      "(?:m|mwen|nou) (?:konn |toujou |abitye )?(?:ale|al|f[eè]|manje|bw[eè]|pran|s[oò]ti|gade|itilize|depanse|touche|peye|boule|d[oò]mi|kouri|mache|etidye|travay|antrene|leve|reveye|ka|kapab|kab|dwe|ta dwe|voye|ekri|rele|pale|vizite)",
      // "yon timoun ki ale lekòl chak maten", "yon famasi ki louvri chak dimanch": the schedule is someone else's.
      "(?<!(?<![\\p{L}])sa )ki (?:ale|al|louvri|ouv[eè]|travay|vann|kouri|jwe|f[eè]|manje|d[oò]mi|f[eè]men|rele|vizite|achte|ekri|etidye|kriye|leve|bay|pran|gade|kite)",
      "(?:kisa|ki sa|sa) pou m (?:manje|f[eè]|li|gade|etidye|bw[eè]|mete|kwit|poste|ekri)",
      "(?:m|mwen|nou) te (?:konn|abitye)",
    ]),
    // A verb is the same word for "send!" and "I send" ("M voye…"): a request counts at the start of the sentence
    // or part, after "tanpri / èske w ka / m vle w", or right after a schedule ("Chak maten voye…").
    lead: new RegExp(
      `(?:^|[,;(]\\s{0,3}|(?:^|[,;(]\\s{0,3})toujou\\s{1,3}|(?<![\\p{L}])(?:tanpri|souple|silvoupl[eè]|svp|pls|please|epi|e|apre sa|tou|kounye a|kounya|al[oò]|bonjou|bonswa|hey|ok|oke|flash|ann|annou|s[eè]lman|jis|kidonk|donk|pa bliye|ede m|(?:(?:[eè]ske|es) )?(?:ou|w) (?:ka|kab|kapab|te ka|ta ka|te kapab|ta kapab)|(?:mwen|m) (?:vle|ta renmen|bezwen|ta vle) (?:ou|w))\\s{1,3}(?:toujou\\s{1,3})?)(?:(?:chak (?:\\p{L}{1,10}|\\d{1,3} \\p{L}{1,7}|(?:de|twa|kat|senk|dis|kenz) \\p{L}{2,7}|demi [eè]dtan)|${EN_EVERY[0]}|toul[eè]jou|tou l[eè] jou|tout jou|tout maten|tout asw[eè]|(?:yon|de|twa|\\d{1,2}) fwa (?:pa|chak|nan) \\p{L}{2,7})(?: (?:ak|e|epi) \\p{L}{3,10})?(?:\\s{1,3}(?:(?:a|v[eè]|anvan|apre) \\d{1,2}(?:[:h.]\\d{2})?(?:\\s?(?:[eè]|h|am|pm))?|a midi|a minwi|(?:nan )?(?:maten|apr[eè]midi|asw[eè]|swa|lannwit)|bon[eè])){0,3}\\s{1,3})?$`,
      "iu",
    ),
  },
  tl: {
    recur: B([
      // Not "araw-araw na ulat" (daily report) or "pang-araw-araw na buhay" (daily life).
      "(?<!pang-|pang )araw(?:[- ]?araw|2)(?!\\s{1,2}na\\s)",
      // Not "para sa bawat araw ng linggo" (for every day of the week).
      "(?<!(?<![\\p{L}])(?:sa|ng) )(?:tuwing|bawat|kada) (?:araw|umaga|tanghali|hapon|gabi|linggo|buwan|oras|minuto|lunes|martes|miyerkules|miyerkoles|huwebes|biyernes|sabado|weekend|alas[- ]?(?:\\d{1,2}|una|dos|tres|kwatro|singko|sais|siyete|otso|nwebe|diyes|onse|dose)|\\d{1,3} (?:oras|minuto|araw))(?!\\s{1,2}(?:ng|sa) (?:linggo|buwan|taon))",
      "lingg?[ou][- ]linggo|buwan[- ]buwan|gabi[- ]gabi|oras[- ]oras|umaga[- ]umaga|(?:isang|dalawang|tatlong|\\d{1,2}) beses (?:sa isang|kada|bawat|isang) (?:araw|linggo|buwan)",
      // Taglish: "Pasend naman ng balita every morning".
      "every ?day|every (?:morning|night|evening|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)",
    ]),
    act: B([
      "(?:padalhan|ipadala|i-?send|isend|i-?remind|iremind|paalalahanan|ipaalala|sabihan|sabihin|ipaalam|abisuhan|i-?notify|inotify|i-?update|iupdate|i-?check|icheck|tingnan|tignan|bantayan|subaybayan|i-?monitor|imonitor|ibuod|i-?summarize|isummarize|hanapin|hanapan|saliksikin|isulat|sulatan|gawan|gawin|bigyan|ibigay|ilista|ikumpara|i-?research|ulitin|turuan) (?:mo|niyo|nyo|ninyo|po|sa akin|sakin|sa amin|ako|kami)",
      "(?:magpadala|mag-?send|magpaalala|mag-?remind|mag-?update|mag-?check|magbantay|maghanap|magsaliksik|mag-?research|sumulat|gumawa|magbigay|maglista|magbuod|mag-?summarize) (?:ka|kayo|po)",
      "paki[- ]?(?:send|padala|check|tingnan|tignan|remind|paalala|sabi|sabihan|sabihin|bantayan|hanap|hanapin|hanapan|summarize|buod|ibuod|sulat|isulat|gawa|gawin|update|monitor|research|lista|ilista|bigay|ibigay|ipaalam|notify|abisuhan|ipadala)|pa-?(?:send|check|remind) (?:naman|po)",
      "(?:send|check|remind|update|monitor|summarize|research|search|track|i-?track) (?:mo|niyo|nyo)",
      // "Araw-araw mo akong padalhan…", the pronouns before the verb.
      "(?:mo|niyo|nyo) (?:po )?(?:akong|kaming) (?:padalhan|paalalahanan|sabihan|bigyan|i-?update|abisuhan|hanapan|gawan|turuan|i-?remind|kuwentuhan|kwentuhan|i-?text|i-?check)",
      "(?:pwede|puwede|pede|maaari|kaya|pwedeng|puwedeng)(?: (?:mo|niyo|nyo|ninyo))?(?: po)?(?: (?:ba|bang))?(?: (?:akong|kaming))? (?:padalhan|ipadala|i-?send|isend|i-?remind|paalalahanan|ipaalala|sabihan|sabihin|ipaalam|abisuhan|i-?notify|i-?check|tingnan|bantayan|subaybayan|i-?monitor|imonitor|i-?track|itrack|ibuod|i-?summarize|hanapin|hanapan|isulat|gawan|gawin|bigyan|ilista|i-?research|i-?update|turuan|kuwentuhan|kwentuhan)",
    ]),
    strong: B([
      // "Ipaalala mo sa akin na magbayad…", never "Ipaalala mo sa akin ang kuwento ng Hamlet" or "Ipinaalala nito…".
      "(?:ipaalala (?:mo |niyo |nyo )?(?:po )?(?:sa akin|sa amin|sakin|samin)|paalalahanan (?:mo |niyo |nyo )?(?:po )?(?:ako|kami)|paki[- ]?(?:paalala|remind|ipaalala)(?: (?:po|mo|naman))?(?: (?:sa akin|sakin|ako|kami))?|i-?remind (?:mo |niyo )?(?:po )?(?:ako|kami)|remind mo (?:po )?(?:ako|kami)|pa-?remind(?: (?:naman|po))?(?: (?:ako|kami))?|(?:mo|niyo|nyo)(?: po)?(?: (?:ba|bang))? (?:akong|kaming) (?:paalalahanan|i-?remind|iremind))(?: (?:po|naman|ha))? (?:na|bukas|mamaya|mamayang|sa (?:lunes|martes|miyerkules|huwebes|biyernes|sabado|linggo)|sa susunod na (?:linggo|buwan)|tuwing|araw[- ]?araw|kada|bawat|alas|ng alas|every|tomorrow|later|para (?:bukas|mamaya)|(?:pagkalipas ng|after) \\d{1,3})",
      "(?:gumawa|mag-?set|maglagay) (?:ka|kayo|po)(?: po)? ng (?:paalala|reminder)|(?:i-?set|gawan|lagyan) (?:mo |niyo )?(?:po )?(?:ako )?ng (?:paalala|reminder)|paki[- ]?(?:set|gawa|lagay) ng (?:paalala|reminder)",
      // "Sabihan mo ako kapag lumabas na ang bagong iPhone", never "Sabihin mo kung kailan lumabas ang iPhone 4".
      "(?:sabihan (?:mo |niyo |nyo )?(?:po )?(?:ako|kami)|sabihin (?:mo |niyo )?(?:po )?(?:sa akin|sakin)|ipaalam (?:mo |niyo )?(?:po )?(?:sa akin|sakin)|abisuhan (?:mo |niyo )?(?:po )?(?:ako|kami)|i-?notify (?:mo )?(?:po )?(?:ako|kami)|paki[- ]?(?:sabi|sabihan|ipaalam|abisuhan|notify|update)(?: (?:po|mo))?(?: (?:sa akin|sakin|ako))?|i-?(?:text|message|update) (?:mo )?ako)(?: (?:po|agad|kaagad|naman))? (?:kapag|pag|kung(?! (?:kailan|paano|ano|bakit))|sa oras na|once|pagka|oras na|(?:sa )?tuwing)(?:(?!noong|nung|dati)[^.?!\\n]){0,60}?(?:lumabas|lalabas|ilabas|ilalabas|bumaba|bababa|tumaas|tataas|bumagsak|babagsak|dumating|darating|ma-?release|mare-?release|i-?release|ire-?release|na-?release|available|may stock|in stock|restock|mag-?sale|nag-?sale|naka-?sale|umabot|aabot|lumampas|lalampas|ma-?announce|ia-?announce|inanunsyo|ianunsyo|may bago(?:ng)?)(?![\\p{L}])",
      "i-?automate (?:mo |niyo )?(?:po )?(?:ito|to|iyan|yan|na ito)|automate mo (?:po )?(?:ito|to|iyan|yan)",
      "padalhan (?:mo |niyo |nyo )?(?:po )?(?:ako|kami) ng(?: isang)? (?:lingguhang|buwanang|daily|weekly|monthly) (?:buod|ulat|balita|update|paalala|summary|report|news|newsletter|quote|horoscope)",
    ]),
    // A question ("gaano karami", "bakit", "paano", "mabuti ba", "dapat ba") or a first-person habit ("nag-ji-gym ako", "tinitingnan ko").
    not: B([
      "gaano (?:karami|kadalas|katagal|kahaba|kalaki)|ilang (?:beses|baso|oras|litro|calories|kalori|tasa)|bakit|paano",
      "ano (?:ang|ba ang|'ng) (?:mga )?(?:benepisyo|pakinabang|epekto|kahulugan|ibig sabihin|magandang)|anong magandang|benepisyo|pakinabang|epekto ng",
      "(?:mabuti|masama|maganda|normal|okay|ok|ligtas|delikado|healthy) (?:ba|lang ba)|dapat (?:ba|ko|kong|ako)|kailangan (?:ba|ko|kong)",
      "(?:nag|naka|naki)[-\\p{L}]{2,18} (?:ako|kami)|\\p{L}{0,2}um\\p{L}{2,12} (?:ako|kami)|(?:lagi|palagi|madalas|minsan|araw[- ]araw|gabi[- ]gabi) (?:akong|ako|kaming|kami)|\\p{L}{1,3}in\\p{L}{2,14} ko",
      // Taglish habits: "Every day I wake up tired, …".
      "every ?\\p{L}{3,9} (?:i|we)",
      // "Tuwing Lunes may meeting kami, …" (there is a meeting every Monday), "Tuwing umaga ay umuulan dito, …" (it rains).
      "(?:araw[- ]?araw|(?:tuwing|bawat|kada) \\p{L}{3,12})(?: (?:ng )?(?:umaga|tanghali|hapon|gabi))? (?:ay )?(?:may|mayroon|meron)",
      "(?:araw[- ]?araw|(?:tuwing|bawat|kada) \\p{L}{3,12})(?: (?:ng )?(?:umaga|tanghali|hapon|gabi))?(?:,|(?: ay)?) (?:(?<tlc>\\p{L})um(?<tlv>[aeiou])\\k<tlc>\\k<tlv>\\p{L}{1,12}|um(?<tlu>[aeiou])\\k<tlu>\\p{L}{1,12}|nag[-\\p{L}]{2,15}|(?<tlc2>\\p{L})in(?<tlv2>[aeiou])\\k<tlc2>\\k<tlv2>\\p{L}{1,12})",
    ]),
    // Between them, what the schedule describes: "recipe na puwedeng lutuin araw-araw", "workout na kaya kong gawin".
    between: /(?<![\p{L}])(?:(?:na|ng) (?:puwede|pwede|pede|maaari|kaya|dapat|kailangan)(?:ng)?|kong|naming|nating)(?![\p{L}])/iu,
  },
  vi: {
    recur: B([
      // Not "cho mỗi ngày trong tuần" (for each day of the week).
      "(?<!(?<![\\p{L}])(?:cho|của|cua) )(?:mỗi|moi) (?:ngày|ngay|sáng|sang|buổi sáng|buoi sang|trưa|trua|buổi trưa|chiều|chieu|buổi chiều|buoi chieu|tối|toi|buổi tối|buoi toi|đêm|dem|tuần|tuan|tháng|thang|giờ|gio|tiếng|tieng|cuối tuần|cuoi tuan|thứ (?:hai|ba|tư|năm|sáu|bảy|[2-7])|thu (?:hai|ba|tu|nam|sau|bay|[2-7])|chủ nhật|chu nhat|t[2-7]|cn|\\d{1,3} (?:giờ|gio|tiếng|tieng|phút|phut|ngày|ngay|tuần|tuan))(?! (?:trong tuần|trong tháng|trong tuan|trong thang))",
      // "hàng tuần" follows what it describes ("báo cáo hàng tuần", "cuộc sống hằng ngày"): only at the start of a part, or before a time.
      "(?<=^\\s{0,3}|[,;]\\s{0,3})(?:hằng|hàng|hang) (?:ngày|ngay|tuần|tuan|tháng|thang|giờ|gio|sáng|sang|tối|toi|đêm)",
      "(?:hằng|hàng|hang) (?:ngày|ngay|tuần|tuan|tháng|thang|giờ|gio|sáng|sang|tối|toi)(?= (?:lúc|luc|vào|vao|từ|bắt đầu|bat dau|đều đặn|deu dan|một lần|mot lan|\\d))",
      "(?:ngày|ngay|sáng|sang|chiều|chieu|tối|toi|tuần|tuan|tháng|thang|đêm|dem) (?:nào cũng|nao cung)",
      "(?:cứ|cu) (?:mỗi |moi )?(?:\\d{1,2}|hai|ba|bốn|bon|năm|nam|sáu|sau) (?:giờ|gio|tiếng|tieng|ngày|ngay|tuần|tuan|phút|phut)",
      "(?:một|mot|1) lần (?:mỗi|moi|một|mot|1) (?:ngày|ngay|tuần|tuan|tháng|thang)|(?:ngày|ngay|tuần|tuan|tháng|thang) (?:một|mot|hai|ba|[1-3]) lần",
      "vào (?:các|những) (?:ngày )?(?:thứ (?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ nhật|buổi sáng|buổi tối|sáng|tối|cuối tuần)",
      // "8 giờ sáng hàng ngày, …", "Chiều thứ 6 hàng tuần, …", "Ngày 1 hàng tháng …", only where they start the sentence or part:
      // not "Tóm tắt cuộc họp thứ Hai hàng tuần" (the weekly Monday meeting).
      "(?<=^\\s{0,3}|[,;]\\s{0,3})(?:(?:vào|vao) )?(?:(?:(?:lúc|luc) )?\\d{1,2}(?:[:h]\\d{2}| ?(?:giờ|gio)(?: \\d{1,2})?| ?h)(?: (?:sáng|sang|chiều|chieu|tối|toi|trưa|trua))? (?:mỗi|moi|hằng|hàng|hang) (?:ngày|ngay|sáng|sang|tối|toi|tuần|tuan)|(?:(?:sáng|sang|chiều|chieu|tối|toi|trưa|trua) )?(?:thứ (?:hai|ba|tư|năm|sáu|bảy|[2-7])|thu (?:hai|ba|tu|nam|sau|bay|[2-7])|chủ nhật|chu nhat|cuối tuần|cuoi tuan|t[2-7]|cn) (?:hằng|hàng|hang) (?:tuần|tuan)|(?:ngày|ngay|mùng|mung|mồng|mong) \\d{1,2} (?:hằng|hàng|hang|mỗi|moi) (?:tháng|thang)|(?:cuối|cuoi|đầu|dau|giữa|giua) (?:mỗi|moi|hằng|hàng|hang) (?:tháng|thang|tuần|tuan))",
    ]),
    act: B([
      // Not "gửi xe" (park) or "gửi tiết kiệm" (deposit).
      "(?:gửi|gởi)(?! (?:xe|tiết kiệm|tiền|con|trẻ|hành lý|đồ)(?![\\p{L}]))|gui(?! (?:xe|tiet kiem|tien|con|tre|hanh ly)(?![\\p{L}]))|nhắc(?! (?:đến|tới|lại))|nhac(?! (?:den|toi|lai))|(?:báo|thông báo) (?:cho )?(?:tôi|mình|em|tớ|tui)|(?:bao|thong bao) (?:cho )?(?:toi|minh|em|tui)",
      // "cho tôi" (give me) only where a request starts (the start of a part, "hãy", right after a schedule) and with
      // something after it: not "tin nhắn rác cho tôi" (to me) or "lịch tập mỗi ngày cho tôi nhé" (a schedule for me).
      "(?<=^\\s{0,3}|[,;]\\s{0,3}|(?:hãy|làm ơn|lam on|vui lòng|vui long|bạn|ban|xin|giúp|giup|sáng|sang|tối|chiều|chieu|ngày|ngay|tuần|tuan|tháng|thang|giờ|gio|tiếng|tieng|nhật|nhat|hai|ba|tư|năm|sáu|bảy|cũng|cung|[2-7h]) )cho (?:tôi|mình|em|tớ|tui|toi|minh)(?= (?:\\d|\\p{L}))(?! (?:hỏi|hoi|xin hỏi|nhé|nhe|nha|nhá|với|voi|đi|ạ|được|duoc|đc|dc|ăn|an|uống|uong)(?![\\p{L}]))",
      "(?:nói|noi) (?:cho )?(?:tôi|mình|em|tớ|toi|minh) (?:biết|biet|nghe)|(?:kể|ke) (?:cho )?(?:tôi|mình|em|toi|minh|con|bé|anh|chị) nghe",
      "kiểm tra|kiem tra|check|xem (?:giúp|giùm|hộ|giup|gium|ho|cho (?:tôi|mình|em|toi|minh))|theo dõi|theo doi|giám sát|giam sat|canh (?:giá|gia|giúp|giup|chừng|chung)",
      "tóm tắt|tom tat|tổng hợp|tong hop|điểm tin|diem tin|tìm(?: kiếm)?|tim (?:kiem|giup|gium|cho)|nghiên cứu(?! (?:cho thấy|chỉ ra|mới|này|của|gần đây|khoa học|đã|năm|cho biết|phát hiện))|nghien cuu(?! (?:cho thay|chi ra|moi|nay|cua|gan day))",
      "viết|viet (?:cho|giup|gium|mot|1|bai)|soạn|soan|liệt kê|liet ke|so sánh|so sanh|gợi ý|goi y|đề xuất|de xuat|(?:cập nhật|cap nhat) (?:cho )?(?:tôi|mình|em|toi|minh)|làm (?:việc này|cái này|điều này|vậy|như vậy|như thế)|lam (?:viec nay|cai nay|dieu nay|vay)|lặp lại|lap lai",
      "(?:tôi|mình|em|tớ|toi|minh) (?:muốn|muon) (?:được |duoc )?(?:nhận|nhan)",
      "(?:dạy|day|nhắn|nhan|nhắn tin|nhan tin) (?:cho )?(?:tôi|mình|em|tớ|toi|minh)",
    ]),
    strong: B([
      // "Nhắc tôi gọi cho mẹ vào ngày mai", never "Nhắc tôi về cốt truyện Hamlet" or "Bài hát này nhắc tôi nhớ tuổi thơ".
      "nhắc (?:nhở )?(?:tôi|mình|em|tớ|tui|anh(?! ấy)|chị(?! ấy)|con)(?: (?:với|nhé|nha|giùm|giúp|hộ))? (?:là|rằng|phải|nhớ (?:uống|gọi|mua|trả|đóng|nộp|làm|đi|học|tập|lấy|gửi|kiểm tra|họp|đón|thanh toán)|đi|uống|gọi|mua|trả|đóng|nộp|làm|học|tập|ăn|ngủ|dậy|thức dậy|lấy|gửi|viết|kiểm tra|xem|đọc|họp|đón|đặt|thanh toán|chuyển|tưới|chuẩn bị|về việc|việc|ngày mai|mai|tối nay|sáng mai|chiều nay|chiều mai|tối mai|hôm nay|lúc|vào|mỗi|hằng|hàng|\\d{1,2} ?(?:giờ|h|g)|sau \\d{1,3}|\\d{1,3} (?:phút|tiếng) nữa)(?![\\p{L}])",
      "nhac (?:nho )?(?:toi|minh|em|tui)(?: (?:voi|nhe|nha|gium|giup))? (?:la|rang|phai|di|uong|goi|mua|tra|dong|nop|lam|hoc|ngu|lay|gui|kiem tra|doc|hop|don|thanh toan|ngay mai|mai|toi nay|sang mai|chieu nay|hom nay|luc|vao|moi|hang|\\d{1,2} ?(?:gio|h|g))(?![\\p{L}])",
      "(?:đặt|dat|tạo|tao|cài|cai|lập|lap)(?: (?:giúp|giùm|cho|giup|gium) (?:tôi|mình|em|toi|minh))?(?: một| 1)? (?:lời nhắc|loi nhac|nhắc nhở|nhac nho|lịch nhắc|lich nhac)",
      // "Báo cho tôi khi iPhone mới ra mắt", never "Cho tôi biết khi nào Thế chiến 2 kết thúc".
      "(?:báo|bao|thông báo|thong bao|nhắn|nhan|nhắc|nhac|cho)(?: (?:cho|ngay cho))? (?:tôi|toi|mình|minh|em|tớ|tui)(?: (?:biết|biet|ngay|nhé|nha|với))? (?:khi|ngay khi|nếu|neu|hễ)(?! (?:nào|nao)(?![\\p{L}]))(?:(?!đầu tiên|dau tien|thì|đã|năm \\d|hồi)[^.?!\\n]){0,60}?(?:ra mắt|ra mat|phát hành|phat hanh|có hàng|co hang|về hàng|ve hang|giảm|giam|tăng|xuống dưới|xuong duoi|xuống|xuong|lên trên|vượt|vuot|mở bán|mo ban|công bố|cong bo|có kết quả|co ket qua|có điểm|co diem|có vé|co ve|sale|dưới|duoi)(?![\\p{L}])",
      // The event first: "Khi nào iPhone 17 ra mắt thì báo cho tôi nhé", "Nếu giá xăng tăng thì nhắn cho mình biết nha", with
      // nothing after but "biết / ngay / nhé": not "Nếu giá xăng tăng thì nói cho tôi biết tại sao".
      "(?<=^\\s{0,3}|[,;]\\s{0,3})(?:khi nào|khi nao|khi|nếu|neu|hễ|lúc nào|luc nao|bao giờ|bao gio)(?:(?!đầu tiên|dau tien|đã|hồi|năm \\d)[^.?!\\n]){1,60}?(?<![\\p{L}])(?:ra mắt|ra mat|phát hành|phat hanh|có hàng|co hang|về hàng|ve hang|giảm|giam|tăng|tang|xuống dưới|xuong duoi|xuống|xuong|lên|len|vượt|vuot|mở bán|mo ban|công bố|cong bo|có kết quả|co ket qua|có điểm|co diem|có vé|co ve|sale|dưới|duoi)(?![\\p{L}])[^.?!\\n]{0,25}? (?:thì|thi) (?:(?:nhớ|nho|hãy|bạn|ban|em) )?(?:báo|bao|nhắn|nhan|thông báo|thong bao|nói|noi|nhắc|nhac)(?: (?:cho|ngay cho|ngay))? (?:tôi|toi|mình|minh|em|tớ|tui|anh|chị)(?: (?:biết|biet|ngay|nhé|nhe|nha|nhá|với|voi|ạ|liền|lien|luôn|luon|nhen|nghe)){0,3}(?=\\s{0,3}$)",
      "(?:gửi|gui) (?:cho )?(?:tôi|mình|em|tớ|toi|minh) (?:\\p{L}{1,10} ){0,3}?(?:bản tin|ban tin|tin tức|tin tuc|tóm tắt|tom tat|cập nhật|cap nhat|lời nhắc|loi nhac) (?:hằng|hàng|hang) (?:ngày|ngay|tuần|tuan|tháng|thang)(?! (?:này|đó|kia|của|trước|vừa|nay|cua)(?![\\p{L}]))",
      "tự động (?:hóa|hoá) (?:việc này|cái này|điều này|nó)|hãy tự động (?:gửi|nhắc|kiểm tra|báo|theo dõi|tóm tắt)",
    ]),
    // A question ("bao nhiêu nước", "tại sao", "lợi ích", "có tốt không", "nên ăn gì"), a habit ("Mỗi thứ Hai tôi đi tập")
    // or a fact ("Mỗi thứ Hai có cuộc họp").
    not: B([
      "(?<!(?:giá|gia)[^,.]{0,30})(?:bao nhiêu|bao nhieu)|bao lâu|bao lau|mấy (?:lần|tiếng|giờ|ly|cốc|lít|calo)|may (?:lan|tieng|ly|coc|lit)|tại sao|tai sao|vì sao|vi sao|sao lại|làm sao|lam sao|làm thế nào|lam the nao|như thế nào|nhu the nao|cách (?:nào|để|cài|đặt|tạo|làm)|cach (?:nao|de|cai|dat|tao|lam)|là gì|la gi|nghĩa là",
      "lợi ích|loi ich|tác dụng|tac dung|tác hại|tac hai|ưu điểm|uu diem|nhược điểm|nhuoc diem|ảnh hưởng|anh huong",
      "có (?:tốt|hại|xấu|ổn|bình thường|sao|an toàn|nguy hiểm|cần thiết|đúng)(?: gì)? (?:không|ko|k|hông)|co (?:tot|hai|xau|on|binh thuong|sao|an toan|nguy hiem|can thiet|dung) (?:khong|ko|k)|có nên|co nen",
      // First person close after the schedule ("Hàng tuần công ty mình họp …"), "Tháng nào cũng hết tiền, …", "ở đâu".
      "(?:mỗi|moi|hằng|hàng|hang) (?:ngày|ngay|sáng|sang|chiều|tối|tuần|tuan|tháng|thang|thứ (?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ nhật)(?: (?:lúc|luc) \\d{1,2}(?:[:h]\\d{0,2})?)?(?: (?!(?:gửi|gui|gởi|nhắc|nhac|báo|bao|thông báo|cho|nói|noi|kể|ke|kiểm tra|kiem tra|check|xem|theo dõi|theo doi|tóm tắt|tom tat|tổng hợp|tong hop|điểm tin|tìm|tim|viết|viet|soạn|soan|liệt kê|so sánh|gợi ý|goi y|đề xuất|cập nhật|cap nhat|làm|lam|dạy|nhắn|nhan|đọc|doc|giúp|giup|hãy|có thể|co the|lặp lại)(?![\\p{L}]))\\p{L}{1,10}){0,2} (?:tôi|tui|tớ|mình|minh|toi|chúng tôi|bọn mình|tụi mình)(?! (?:muốn|muon|cần|can)(?![\\p{L}]))",
      "(?:nào|nao) (?:cũng|cung) (?!(?:gửi|gui|gởi|nhắc|nhac|báo|bao|thông báo|cho|nói|noi|kể|ke|kiểm tra|kiem tra|check|xem|theo dõi|theo doi|tóm tắt|tom tat|tổng hợp|tong hop|điểm tin|tìm|tim|viết|viet|soạn|soan|liệt kê|so sánh|gợi ý|goi y|đề xuất|cập nhật|cap nhat|làm|lam|dạy|nhắn|nhan|đọc|doc|giúp|giup|hãy|có thể|co the|lặp lại)(?![\\p{L}]))\\p{L}{1,10}(?: \\p{L}{1,10}){0,4}(?=\\s{0,3}[,;])|ở đâu|o dau|chỗ nào|cho nao|nơi nào",
      "(?:mỗi|moi|hằng|hàng|hang) (?:ngày|ngay|sáng|sang|chiều|chieu|tối|toi)(?: (?:tôi|mình|minh|em))? (?:đưa|đón|chở|gửi|dua|don|gui) (?:con|bé|be|các con|cac con|cháu|chau)(?![\\p{L}])",
      // "Mỗi thứ Hai có cuộc họp, …" (there is a meeting every Monday), "mỗi ngày nên ăn gì".
      "(?:mỗi|moi) (?:ngày|ngay|sáng|sang|chiều|tối|tuần|tuan|tháng|thang|thứ (?:hai|ba|tư|năm|sáu|bảy|[2-7])|chủ nhật)(?: (?:lúc|luc) \\d{1,2}(?:[:h]\\d{0,2})?)? (?:có|co)(?! (?:thể|the)(?![\\p{L}]))|(?:nên|nen)(?: \\p{L}{1,8}){0,2} (?:gì|gi)",
    ]),
    // Between them, someone else does it: "bài tập tôi có thể làm mỗi ngày", "món ăn có thể nấu mỗi ngày".
    between: /(?<![\p{L}])(?:(?:tôi|mình|em|ta|bạn|người ta|toi|minh) (?:có thể|co the|nên|nen|cần|can|phải|phai|hay|thường|thuong|sẽ|se|muốn|muon)|(?<=\p{L} )(?:có thể|co the))(?![\p{L}])/iu,
    // A request said by someone else ("Tôi kiểm tra điện thoại mỗi giờ", "Bài hát này nhắc tôi…") or how-to ("Cách đặt lời nhắc").
    lead: /(?<!(?<![\p{L}])(?:tôi|toi|tui|tớ|mình|minh|tao|chúng tôi|chung toi|bọn mình|tụi mình|họ|nó|người ta|nguoi ta|mẹ|bố|má|vợ|chồng|sếp|giáo|anh ấy|cô ấy|này|đó|ấy|cách|cach|làm sao|lam sao|làm thế nào|ai)(?:\s{1,3}(?:thường|thuong|hay|luôn|luon|vẫn|đều|cũng|sẽ|se|đã|da|đang|dang|phải|phai|nên|nen|muốn|muon|định|cần|có thể|co the|không|khong|chưa|từng|để|de)){0,2}\s{1,3}|(?<![\p{L}])(?:đã|từng|vừa|đang)\s{1,3})$/iu,
  },
  th: {
    recur: SUB([
      // "ทุกวันนี้" is "these days", "ทุกวันที่ผ่านมา" the days gone by, and "รถบรรทุก" a truck.
      "(?<!บรร)ทุก(?:\\s{0,1}ๆ)?\\s{0,1}(?:วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์|ทำงาน|ธรรมดา|หยุด|ที่\\s{0,1}[0-9๐-๙]{1,2})?(?!นี้|ที่ผ่าน|ก่อน)|จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์(?:อาทิตย์)?|เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|สัปดาห์|อาทิตย์|เดือน|ปี|ชั่วโมง|ชม\\.?|ครึ่งชั่วโมง|สุดสัปดาห์|ต้นเดือน|สิ้นเดือน|[0-9๐-๙]{1,3}\\s{0,1}(?:ชั่วโมง|ชม\\.?|นาที|วัน|สัปดาห์|อาทิตย์|เดือน)|(?:สอง|สาม|สี่|ห้า|หก|สิบ|สิบสอง)\\s{0,1}(?:ชั่วโมง|ชม\\.?|นาที|วัน|สัปดาห์|อาทิตย์))(?:\\s{0,2}(?:ตอน|เวลา)?\\s{0,2}(?:[0-9๐-๙]{1,2}(?:[:.][0-9๐-๙]{2})?\\s{0,1}(?:โมง(?:เช้า|เย็น|ครึ่ง)?|น\\.|นาฬิกา|ทุ่ม)|(?:หก|เจ็ด|แปด|เก้า|สิบ|สิบเอ็ด)โมง(?:เช้า|เย็น)?|(?:บ่าย|ตี)\\s{0,1}[0-9๐-๙]{1,2}(?:\\s{0,1}โมง)?|(?:หนึ่ง|สอง|สาม|สี่|ห้า)ทุ่ม|เที่ยง(?:วัน|คืน)?|เช้า|เย็น|ค่ำ))?",
      "(?:วัน|สัปดาห์|อาทิตย์|เดือน|ชั่วโมง)ละ\\s{0,1}(?:ครั้ง|[0-9๐-๙]{1,2}\\s{0,1}ครั้ง|(?:สอง|สาม)\\s{0,1}ครั้ง)",
      // "every morning ส่งข่าวหุ้นให้หน่อย" (an English schedule in a Thai request).
      "(?<![a-z])(?:every|each)\\s{1,2}(?:day|morning|afternoon|evening|night|week|month|hour|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|[0-9]{1,3}\\s{1,2}(?:minutes|mins|hours|hrs|days|weeks))(?![a-z])",
    ]),
    // Counted only after the lead below: "ส่งของ" (deliver goods), "ส่งลูก" (take the kids), "แจ้งความ" (report to the
    // police), "สรุปว่า" (so, in short), "ปัญหา" (a problem), "หาเงิน" (earn) and "ของ" (of) are not requests.
    act: SUB([
      "(?<!ขน|จัด)ส่ง(?!เสริม|ออก|ผล|เสียง|สัญญาณ|ท้าย|ตัว|งาน|การบ้าน|ของ|พัสดุ|ไปรษณีย์|เงิน|ลูก|กลิ่น)|บอก(?!รัก|ลา|เล่า|ใบ้|กล่าว|เลิก)|(?<!ชัด|แจ่ม)แจ้ง(?!ความ|เกิด|ตาย|ย้าย|เตือน(?:จาก|ของ|แอป|เด้ง|ขึ้น|เยอะ))|(?<!คำ|แจ้ง)เตือน(?!ภัย|ใจ|สติ|ความจำ)|รีไมนด์|เล่า|รายงาน",
      "สรุป(?!ว่า|แล้ว|คือ|ก็|ได้ว่า)|เช็ค|เช็ก|เชค|ตรวจสอบ|ตรวจดู|ติดตาม|ตามดู|เฝ้าดู|จับตาดู|มอนิเตอร์|อัปเดต|อัพเดท|อัพเดต|อัปเดท",
      "ค้นหา|หาข้อมูล|หา(?![ยรกงว]|หมอ|เงิน|เลี้ยง)|รีเสิร์ช|เขียน|แต่ง(?!งาน|ตัว|หน้า|บ้าน|ห้อง)|แปล(?!ว่า|ก)|แนะนำ|เตรียม(?!ตัว|ใจ|พร้อม)|ขอ(?!โทษ|บ|ง|ร้อง|อนุญาต|ให้|ความ|ตัว)|ทำ(?:แบบนี้|อย่างนี้|สิ่งนี้|อันนี้|แบบเดิม|ซ้ำ|สรุป|รายงาน|ลิสต์|รายการ)",
    ]),
    strong: SUB([
      // "เตือนฉันจ่ายค่าไฟพรุ่งนี้", not "เตือนฉันหน่อยว่าเมืองหลวงของเปรูคืออะไร" (remind me what …).
      "(?:(?:ช่วย|รบกวน|อย่าลืม|กรุณา)(?:แจ้ง)?เตือน|(?<!คำ)(?:แจ้ง)?เตือน(?:ฉัน|ผม|หนู|เรา|ดิฉัน|เค้า|ด้วย|หน่อย|ที|ให้)|ตั้ง(?:การ)?(?:แจ้ง)?เตือนให้(?:ฉัน|ผม|หนู|หน่อย|ด้วย|ที)|ส่ง(?:ข้อความ)?(?:แจ้ง)?เตือน|รีไมนด์)(?!ความจำ|ใจ|สติ|ภัย)(?![^.?!\\n]{0,40}?(?:อะไร|ยังไง|อย่างไร|ที่ไหน|ใคร|เมื่อไหร่|เมื่อไร))",
      // "แจ้งฉันเมื่อไอโฟนรุ่นใหม่เปิดตัว" (a future event), not "บอกหน่อยว่าสงครามจบเมื่อไหร่".
      "(?:แจ้ง(?:เตือน)?|บอก)(?:ฉัน|ผม|หนู|เรา|ดิฉัน)?(?:ด้วย|หน่อย|ที)?(?:นะ(?:คะ|ครับ)?)?\\s{0,1}(?:ทันที)?(?:เมื่อ(?:ไหร่|ไร)ที่|เมื่อ(?!ไหร่|ไร|กี้|วาน|ก่อน)|ตอนที่|ถ้า(?:หาก)?|หาก(?![ิี])|ทันทีที่|พอ(?!ดี|ใจ|แล้ว|สม|ประมาณ|เพียง))(?:(?!ไหม|มั้ย|ยังไง|เท่าไหร่|เท่าไร|กี่|อะไร|ทำไม|ควร|เมื่อวาน|ที่แล้ว|เคย|ล่าสุด)[^.?!\\n]){0,40}?(?:ออก(?!กำลัง|ไป|จาก|ข่าว|แบบ|เสียง|ตัว)|เปิดตัว|วางขาย|วางจำหน่าย|เปิดขาย|เริ่มขาย|มีขาย|ลดลง|ลดราคา|ต่ำกว่า|ต่ำลง|สูงกว่า|เกิน|ทะลุ|ร่วง|ตกลง|ขึ้นไปถึง|ขึ้นถึง|มีของ|ของเข้า|เข้าสต็อก|ประกาศ|ถูกลง|ปล่อย)(?![^.?!\\n]{0,30}?(?:ไหน|อะไร|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|กี่|ทำไม|ควร|คือ|ล่าสุด|ที่แล้ว|เมื่อวาน))",
      "(?:ถ้า(?:หาก)?|หาก(?![ิี])|เมื่อ(?:ไหร่|ไร)ที่|เมื่อ(?!ไหร่|ไร|กี้|วาน|ก่อน)|ทันทีที่|พอ(?!ดี|ใจ|แล้ว|สม|ประมาณ|เพียง))(?:(?!ไหม|มั้ย|ยังไง|เท่าไหร่|เท่าไร|กี่|อะไร|ทำไม|ควร|เมื่อวาน|ที่แล้ว|เคย|ล่าสุด)[^.?!\\n]){0,40}?(?:ออก(?!กำลัง|ไป|จาก|ข่าว|แบบ|เสียง|ตัว)|เปิดตัว|วางขาย|วางจำหน่าย|เปิดขาย|เริ่มขาย|มีขาย|ลดลง|ลดราคา|ต่ำกว่า|ต่ำลง|สูงกว่า|เกิน|ทะลุ|ร่วง|ตกลง|ขึ้นไปถึง|ขึ้นถึง|มีของ|ของเข้า|เข้าสต็อก|ประกาศ|ถูกลง|ปล่อย)(?:(?!ไหม|มั้ย|ยังไง|เท่าไหร่|เท่าไร|กี่|อะไร|ทำไม|ควร|เมื่อวาน|ที่แล้ว|เคย|ล่าสุด)[^.?!\\n]){0,25}?(?:แจ้ง(?:เตือน)?|บอก)(?:ฉัน|ผม|หนู|เรา|ดิฉัน|ด้วย|หน่อย|ที|ทันที)(?![^.?!\\n]{0,20}?(?:ควร|ยังไง|อะไร|ทำไม|กี่|เท่าไหร่|เท่าไร|ดีไหม|ดีมั้ย|ดีกว่า|ไหน|คือ))",
      // "iPhone รุ่นใหม่เปิดตัวเมื่อไหร่ บอกด้วยนะ" (whenever it launches, let me know), from the start of its part.
      "(?<![^\\s])(?:(?!ไหม|มั้ย|ยังไง|เท่าไหร่|เท่าไร|กี่|อะไร|ทำไม|ควร|เมื่อวาน|ที่แล้ว|เคย|ล่าสุด)[^.?!\\n]){0,40}?(?:ออก(?!กำลัง|ไป|จาก|ข่าว|แบบ|เสียง|ตัว)|เปิดตัว|วางขาย|วางจำหน่าย|เปิดขาย|เริ่มขาย|มีขาย|ลดลง|ลดราคา|ต่ำกว่า|ต่ำลง|สูงกว่า|เกิน|ทะลุ|ร่วง|ตกลง|ขึ้นไปถึง|ขึ้นถึง|มีของ|ของเข้า|เข้าสต็อก|ประกาศ|ถูกลง|ปล่อย)(?:(?!ไหม|มั้ย|ยังไง|เท่าไหร่|เท่าไร|กี่|อะไร|ทำไม|ควร|เมื่อวาน|ที่แล้ว|เคย|ล่าสุด)[^.?!\\n]){0,20}?เมื่อ(?:ไหร่|ไร)\\s{0,1}(?:ก็ได้\\s{0,1})?(?:ช่วย)?(?:แจ้ง(?:เตือน)?|บอก)(?:ฉัน|ผม|หนู|เรา|ดิฉัน)?(?:ด้วย|ทันที)",
      "(?:ช่วย)?ทำ(?:สิ่งนี้|อันนี้|งานนี้)?(?:ให้)?(?:เป็น)?(?:แบบ)?อัตโนมัติ(?:ให้(?:หน่อย|ด้วย|ที|ฉัน|ผม)|ได้ไหม|ได้มั้ย|หน่อย|ด้วย|ทุก)",
      // "ส่งสรุปข่าว AI รายสัปดาห์ให้ฉัน" (send me a weekly summary), not "สรุปรายงานประจำสัปดาห์".
      "ส่ง(?:สรุป|อัปเดต|อัพเดท|ข่าว|ไดเจสต์|เคล็ดลับ)[^.?!\\n]{0,20}?(?:รายวัน|รายสัปดาห์|รายเดือน|ประจำวัน|ประจำสัปดาห์)ให้(?:ฉัน|ผม|หนู|เรา|ดิฉัน)",
    ]),
    // How much or many, why, how, should or must, a way to fix, which is better, benefits, is it good/normal, a word's
    // meaning, translating English, "whether … every Monday" ("ว่าทุกวันจันทร์ร้านเปิดไหม"), and a habit, with or without
    // "I" ("ฉันเช็คโทรศัพท์ทุกชั่วโมง", "ทุกเช้าไปวิ่งที่สวนลุม แนะนำรองเท้าหน่อย", "แม่ชอบส่ง…"). A sentence that starts with
    // a schedule, then something other than a time or a request, then a space, is a statement ("ทุกวันมักกะโรนีขายดีมาก
    // ช่วยเขียน…"), and so is one that doesn't start with a request and has a schedule at the end of its first clause
    // ("ส่งพัสดุไปเชียงใหม่ทุกสัปดาห์ แนะนำขนส่ง…").
    not: /(?:^|\s)ทุก(?:\s{0,1}ๆ)?\s{0,1}(?:วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์|หยุด)?|เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|สัปดาห์|อาทิตย์|เดือน|ปี)\s{0,1}(?:(?:จะ|ก็|มัก(?:จะ)?|ชอบ|ต้อง)\s{0,1})?(?:ไป(?!ดู|เช็ค|เช็ก|หา|ค้น|ตรวจ)|กิน|ทาน|ดื่ม|ตื่น|นอน|วิ่ง|ออกกำลัง|เรียน|เดิน|ขับรถ|อาบน้ำ|เล่น|ส่งลูก|รับลูก|ฝนตก|รถติด|ปวด|เจ็บ|รู้สึก|เข้างาน|เลิกงาน)|^ทุก(?:\s{0,1}ๆ)?\s{0,1}(?:วัน|จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|สัปดาห์|เดือน|ปี|ต้นเดือน|สิ้นเดือน|สุดสัปดาห์)(?!\s|ๆ|[0-9๐-๙]|หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ตี|ราว|ประมาณ|สิ้น|ต้น|กลาง|สุด|แรก|แต่ละ|นะ|ค่ะ|คะ|ครับ|เลย|วัน|จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|ทำงาน|ธรรมดา|หยุด|ที่|เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|ดึก|ตอน|เวลา|ช่วง|หลัง|ก่อน|ตั้งแต่|ถึง|และ|กับ|หรือ|ละ|ช่วย|กรุณา|รบกวน|ได้โปรด|โปรด|อย่าลืม|อยากให้|ต้องการให้|คุณ|ขอ|ส่ง|บอก|แจ้ง|เตือน|รีไมนด์|เล่า|รายงาน|สรุป|เช็|เชค|ตรวจ|ติดตาม|ตามดู|เฝ้าดู|จับตาดู|มอนิเตอร์|อัป|อัพ|ค้นหา|หา|รีเสิร์ช|เขียน|แต่ง|แปล|แนะนำ|เตรียม|ทำ|ไป(?:ดู|เช็|หา|ค้น|ตรวจ))[^\s]{2,40}\s|^(?!ช่วย|กรุณา|รบกวน|ได้โปรด|โปรด|ขอ(?!ง)|ส่ง(?!ของ|พัสดุ|ไปรษณีย์|เงิน|ลูก)|บอก|แจ้ง|เตือน|สรุป|เช็|เชค|ตรวจ|ติดตาม|อัป|อัพ|ค้นหา|หา(?!เงิน|หมอ)|เขียน|แปล|แนะนำ|เตรียม|ทำ(?!งาน)|เล่า|รายงาน|คุณ|(?:ฉัน|ผม|หนู|ดิฉัน|เรา)?(?:อยาก|ต้องการ)|อย่าลืม|ข่าว|ราคา|ทุก|every|each)[^\n]{0,80}?[^\s]ทุก(?:\s{0,1}ๆ)?\s{0,1}(?:วัน|จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|สัปดาห์|เดือน|ปี|ชั่วโมง)[^\s]{0,20}\s{1,2}(?:ช่วย|กรุณา|รบกวน|ขอ|ส่ง|บอก|แจ้ง|เตือน|แนะนำ|สรุป|เช็|หา|เขียน|แปล|อัป|อัพ|ทำ)|(?<!ไม่|ถูก)ต้อง(?!การ)|มัก(?:จะ)?(?!กะ)|(?<!ที่)(?:แม่|พ่อ|ลูก|แฟน|สามี|ภรรยา|เพื่อน|หัวหน้า|ครู|เขา|เค้า|พี่|น้อง)ชอบ|ว่า\s{0,1}ทุก|แปล(?:ประโยค|คำ|ข้อความ)?\s{0,2}[A-Za-z]|มีวิธี|วิธีแก้|ห้าม[^\s]{0,12}อะไร|(?:อัน|แบบ|ยี่ห้อ|รุ่น|ที่)ไหนดี|ไหนดีกว่า|กี่|เท่าไหร่|เท่าไร|ทำไม|ยังไง|ทำไง|อย่างไร|ควร|ประโยชน์|ข้อดี|ข้อเสีย|ผลเสีย|ผลดี|อันตราย|ดีไหม|ดีมั้ย|ดีหรือเปล่า|ดีรึเปล่า|ดีหรือไม่|ปกติไหม|ปกติมั้ย|ปกติหรือเปล่า|ปกติรึเปล่า|แปลว่า|คำว่า|หมายถึง|ความหมาย|(?<!ให้|ช่วย)(?:ฉัน|ผม|หนู|ดิฉัน|เรา|กู)(?:มัก(?:จะ)?|ชอบ|ต้อง|จะ|ก็)?(?:ไป|กิน|ทาน|ดื่ม|เช็ค|เช็ก|ตื่น|นอน|ออกกำลัง|วิ่ง|ทำงาน|เรียน|อ่าน|ใช้|เล่น|จ่าย|เข้า|ฟัง|เดิน|ขับ|ซื้อ|ส่ง|โทร)/u,
    // "แนะนำท่าที่ทำได้ทุกวัน" (moves I can do every day), "ตารางสำหรับทุกวัน" (a plan for each day).
    between: /สำหรับ|ที่(?:ฉัน|ผม|หนู|เรา|คน)|ที่[\p{L}\p{M}]{0,6}ได้/u,
    // Thai verbs don't change with the person ("แม่เตือนฉัน" = Mom reminds me): a request counts at the start of
    // the sentence or after a space, after "ช่วย / กรุณา / รบกวน / อยากให้ / คุณ", or right after a schedule or time
    // ("ทุกเช้าบอก…", "พรุ่งนี้บ่ายสองช่วยเตือน…"), not after "ทุกปีพ่อ" (every year Dad …).
    lead: new RegExp(
      "(?:^|\\s|ช่วย(?:\\s{0,1}ๆ)?(?:ไป)?|กรุณา|รบกวน(?:ช่วย)?|ได้โปรด|โปรด|อยากให้(?:คุณ|เธอ|นาย|แก)?(?:ช่วย)?|ต้องการให้(?:คุณ)?(?:ช่วย)?|อย่าลืม|คุณ(?:ช่วย)?|เธอ(?:ช่วย)?|นาย(?:ช่วย)?|ทุก(?:\\s{0,1}ๆ)?\\s{0,1}(?:วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์|ทำงาน|ธรรมดา|หยุด|ที่\\s{0,1}[0-9๐-๙]{1,2})?|จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์|เสาร์อาทิตย์|เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|ดึก|สัปดาห์|อาทิตย์|เดือน|ปี|ชั่วโมง|ชม\\.?|ครึ่งชั่วโมง|สุดสัปดาห์|ต้นเดือน|สิ้นเดือน|(?:[0-9๐-๙]{1,3}|สอง|สาม|สี่|ห้า|หก|สิบ|สิบสอง)\\s{0,1}(?:ชั่วโมง|ชม\\.?|นาที|วัน|สัปดาห์|อาทิตย์|เดือน))(?:ตอน)?(?:เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|ดึก)?(?:วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์))?(?:ไป)?|(?:พรุ่งนี้|มะรืน(?:นี้)?|วันนี้|คืนนี้|เย็นนี้|เช้านี้|บ่ายนี้|(?:สัปดาห์|อาทิตย์|เดือน)หน้า|วัน(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์)(?:นี้|หน้า)?|วันที่\\s{0,1}[0-9๐-๙]{1,2})(?:ตอน)?(?:เช้า|สาย|เที่ยง|บ่าย|เย็น|ค่ำ|คืน|ดึก)?|[0-9๐-๙]{1,2}(?:[:.][0-9๐-๙]{2})?\\s{0,1}(?:โมง(?:เช้า|เย็น|ครึ่ง)?|น\\.|นาฬิกา|ทุ่ม)|โมง(?:เช้า|เย็น|ครึ่ง)?|ทุ่ม|นาฬิกา|(?:บ่าย|ตี)\\s{0,1}(?:[0-9๐-๙]{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า)|เที่ยง(?:วัน|คืน)?|ตอน(?:เช้า|สาย|บ่าย|เย็น|ค่ำ|ดึก|กลางคืน|เที่ยง)|(?:วัน|สัปดาห์|อาทิตย์|เดือน)ละ\\s{0,1}(?:ครั้ง|[0-9๐-๙]{1,2}\\s{0,1}ครั้ง)|(?<![a-z])(?:every|each)\\s{1,2}[a-z]{3,9}\\s{1,2})$",
      "iu",
    ),
  },
  ja: {
    recur: SUB([
      // Not "毎日の…", "毎週月曜日の会議", "毎年恒例", "毎年度" or the 毎日新聞 newspaper; "毎時" not as a rate ("毎時80ミリの雨").
      "毎(?:日|朝|晩|夕|夜|週末|週|月|年(?!度)|時間|時(?![0-9０-９]{1,5}(?:[.．][0-9０-９]{1,3})?\\s?(?:ミリ|mm|ｍｍ|キロ|km|ｋｍ|メートル|m|ｍ|トン|リットル|l|人|台|件|個|本|枚|cm|センチ)))(?![月火水木金土日]曜日?の(?!朝|夜|夕方|昼|午前|午後|[0-9０-９])|の|が|を|は|も(?!う)|新聞|放送|恒例)(?:[月火水木金土日]曜日?)?(?:の?(?:朝|夜|夕方|昼|午前|午後))?(?:の?[0-9０-９]{1,2}時(?:[0-9０-９]{1,2}分|半)?)?",
      // Not inside an adjective: "うまいあさり" (tasty clams), "うまいつきあい方".
      "(?<![うあせいしおまかこ])まい(?:にち|あさ|ばん|しゅう|つき)(?!の)",
      // Not inside a date: "12月10日", "5月1日".
      "(?<![0-9０-９月])(?:[0-9０-９]{1,3}|[一二三四五六七八九十数半]{1,2})(?:時間|日|週間|分|ヶ月|か月|カ月|ヵ月)(?:ごと|おき)(?!の)",
      // Not a count so far: "今週3回目の会議", "今年2度目の台風".
      "(?<![0-9０-９月今先来再前翌去昨本毎])(?:1日|一日|週|月|年)に?(?:[0-9０-９]{1,2}|[一二三四五六七八九十]{1,2})(?:回|度)(?!の|目)",
      "(?<![0-9０-９])(?:週|月)(?:1|一|イチ|いち)(?:で|くらい|ぐらい|程度|ペース)",
      "(?<!間)隔(?:週|日|月)(?!の)|(?<!不)定期的に",
      // "平日の朝7時に", "平日の夜、", not "平日の営業時間", "平日の朝ごはん" or "平日の昼 新宿 ランチ".
      "平日(?:の|は)?(?:毎朝|毎晩|朝|夜|夕方|昼|午前|午後|[0-9０-９]{1,2}時)(?=[0-9０-９]|に|は|も|、|,)",
    ]),
    // A request ends its sentence (送って, 送ってください, 送ってくれる？, 送ってもらえますか, 教えてもらってもいい？), so
    // not "チェックしてしまう" (a habit), "教えてくれた" (past) or "教えてくれるアプリ".
    act: SUB([
      "(?:送っ|送信し|届け|配信し|教え|知らせ|お知らせし|通知し|伝え|連絡し|メールし|確認し|チェックし|調べ|リサーチし|検索し|探し|まとめ|要約し|翻訳し|監視し|見張っ|ウォッチし|追跡し|比較し|分析し|集め|書い|作っ|作成し|考え|提案し|紹介し|選ん|(?<!思い)出し|出題し|生成し|投稿し|報告し|リストアップし|ピックアップし|リマインドし|占っ|やっ|実行し|繰り返し)(?:[てで](?:おいて|みて)?|[とど]いて)(?=[。！？!?\\s〜～ー♪…]|$|ね|よ(?![かくう])|な(?=[。！？!?\\s]|$)|くださ(?!っ)|下さ(?!っ)|くれ(?:る|ない|ません|ます|ん|へん)?(?:か|かな|の)?(?:[。！？!?\\s〜～ー]|$)|(?:くれ|もらえ|いただけ|頂け)(?:ると|たら|れば)|もら(?:え(?:る|ます|ません|ない)?(?:か|かな)?(?:[。！？!?\\s〜～ー]|$)|っても?(?:いい|良い|大丈夫)|いたい|う(?:こと|の)は?(?:でき|可能))|(?:いただ|頂)(?:け(?:る|ます|ません|ない)?(?:か|でしょうか)?(?:[。！？!?\\s〜～ー]|$)|きたい)|(?:ほし|欲し)い(?!と)|ちょうだい|頂戴|、\\s?(?=毎|平日|[0-9０-９]{1,3}(?:時間|日|分)(?:ごと|おき)))",
      // Not the honorific on a medicine label: "1日3回お飲みください".
      "(?<![てで]|[おご][\\p{Script=Han}]{1,3}[みきりちしいえびにぎ]?)(?:ください|下さい|ちょうだい|頂戴)|お願い(?:します|しま|ね|いたします|致します|できますか|できる)?(?=[。！？!?\\s〜～ー]|$)",
      "(?:送れ|教えろ|調べろ|まとめろ|知らせろ|チェックしろ|確認しろ|書け|作れ)(?=[。！？!?\\s]|$|よ)",
    ]),
    // Reminders asked of Flash, never "リマインドメール" or "この曲は子供の頃を思い出させてくれる"; "tell me when it comes
    // out / drops" only with a future event before たら or 次第, never "間違っていたら教えて" or "エラーが出たら教えて".
    strong: SUB([
      "(?:リマインドし|リマインダー(?:を)?(?:設定|セット|登録|作成)し|(?:[うくすつぬぶむぐる]|ない)(?:の|こと)を(?:私に|僕に|俺に)?思い出させ|忘れない(?:ように|よう)[、,]?(?:私に)?(?:教え|知らせ|リマインドし|通知し|言っ)|(?:(?:発売|リリース|発表|公開|配信開始|入荷|再入荷|販売開始|予約開始|値下げ|値上げ|値下がり|値上がり|解禁)(?:され|し|があっ|になっ)?|(?<!(?:エラー|答え|結論|警告|バグ|症状|熱|咳|例外)が?)出|下がっ|上がっ|超え|切っ|割っ|下回っ|上回っ|届い|始まっ|空い|[0-9０-９](?:円|ドル|万円?|%|％|度)?(?:以下|以上|未満)?に?なっ)(?:たら|次第)[、,]?\\s?(?:すぐ(?:に)?)?(?:私に)?(?:知らせ|教え|通知し|連絡し|お知らせし)|(?:これ|この作業|このタスク|それ)を?自動化し)[てで](?=[。！？!?\\s〜～ー]|$|ね|よ(?![かくう])|くださ(?!っ)|下さ(?!っ)|くれ(?:る|ない|ません|ます|ん|へん)?(?:か|かな)?(?:[。！？!?\\s〜～ー]|$)|もら(?:え(?!た)|いたい)|(?:いただ|頂)(?:け(?!た)|きたい)|(?:ほし|欲し)い(?!と)|ちょうだい|お(?:いて|け))",
      "リマインド(?:を)?(?:お願い|頼む|頼みます|よろしく)",
    ]),
    // Questions and habits: "毎日どれくらい水を飲めばいいか教えて", "私は毎朝…", "母は毎朝…してくれる", "Siriは毎朝…".
    not: SUB([
      "なぜ|なんで(?!も)|どうして|どのくらい|どれくらい|どれぐらい|どのぐらい|どんだけ|何回|何度|何時間|何分|何杯|何リットル|何キロ|何カロリー|何人|何歳|いくら|どうやって|どうすれば|どうしたら|どうやったら|頻度",
      "痛い|つらい|眠い|だるい|しんどい|メリット|デメリット|効果(?!的)|効能|利点|副作用|影響|[うくすつぬぶむぐる]方法|方法(?:は|って)|(?:とは|って)(?:何|なに|なん)|という(?:メッセージ|言葉|文|フレーズ|文言|キャッチコピー|タイトル)",
      "(?:ようになる|ようになれる|られる|できる|痩せる|効く)か|(?:たら|れば|なら)(?!いい|良い|よい)[^。！？!?\\n]{1,20}?か(?:どうか)?を?(?:教え|調べ)|べきか|べき？|べきですか|(?<!ば|たら|だら|もらっても|もらえても|くれても)(?:いい|良い|よい|悪い|大丈夫|普通|正常|健康的)(?:の|ん)?(?:です|でしょう)?か",
      "(?:私|僕|俺|わたし|あたし)(?:は|も|って)|(?:母|父|親|ママ|パパ|妻|夫|嫁|旦那|彼氏|彼女|彼|友達|友人|先生|上司|同僚|子供|息子|娘|アプリ|スマホ|iPhone|アイフォン|Siri|シリ|Alexa|アレクサ|Google|グーグル|LINE|カレンダー)(?:は|が|も|って)",
      // Getting someone else to do it: "夫に毎朝ゴミを出してほしいんだけど、どう頼めばいい？".
      "どう(?:頼|言え|言っ|伝え|お願いす|説得|断)|(?:夫|妻|嫁|旦那|彼氏|彼女|子供|子ども|息子|娘|母|父|親|上司|部下|同僚|友達|家族)に[^。！？!?\\n]{1,30}?(?:ほしい|欲しい|もらいたい|させたい)",
    ]),
    // A habit, a state, a reason or a clause on a noun before the request: "毎週月曜にジムに行ってるんだけど、メニューを作って",
    // "毎朝ジョギングしてるから、…", "毎月電気代が高い理由を調べて", "毎年流行る病気を教えて"; but "毎週新しく出る漫画を…"
    // and "毎晩寝る前に…" say what each one is.
    between:
      /けど|けれど|ので|のに|んだが|んですが|ですが|ますが|ていて|ており|ても|についての|に関する|(?:た|てる|ている|ます|です)[、,]|(?:[るたいすくむぶぐつうだ]|ない|てる|でる|ます|です)から|(?:[るうくすつぬぶむぐ]|ない)の(?:が|は|も)|(?:[るたいすくむぶぐつうだ]|ない)(?:理由|原因|仕組み|やり方|仕方|コツ|秘訣)|^(?![、,\s])(?![^、,。]{0,30}?(?:今日|今週|今月|今夜|今晩|明日|来週|翌日|その日|新しく|新た|最新|新作|新刊))[^、,。]{0,30}?(?:(?:(?<![早短長多遅強軽高安良広狭深浅厚薄暗若古寒暑熱重硬太細白黒赤青甘辛苦痛怖弱近遠濃淡緩しなきさかたよ])く|(?<![もそこどよろょゅ])う|(?<!す)ぐ|[るすむぶ]|といい|べき)(?!(?:前|時|度|間|頃)(?:に|は|、|,))(?=お?[\p{Script=Han}\p{Script=Katakana}])|(?:[るうくすつぬぶむぐ]|ない)こと(?:リスト|一覧))/u,
  },
  ko: {
    recur: SUB([
      // Whole words, not quoted: "발매일" (release date), "판매시간", "매달리기" (hanging), "'매일'을 번역해줘".
      "(?<![가-힣'‘])매(?:일(?!을|이|의|은|경제|신문|유업|우유)|주(?![을를의는은가이])|달(?![리려린렸릴아았고면기을를의는은이])|월(?![을를의는은이])|년(?![을를의는은이])|시간(?![을를의는은이])|시(?=\\s?\\d|\\s?정각))(?!['’])(?:\\s?[월화수목금토일]요일)?(?:\\s?(?:아침|오전|오후|저녁|밤|새벽))?(?:\\s?\\d{1,2}\\s?시(?:\\s?\\d{1,2}\\s?분|\\s?반)?)?",
      // Not "맥주마다" (each beer), "마다하다" (to refuse) or "미국 주마다" (each US state).
      "(?:(?<![가-힣])(?:날|달|해|하루|시간)|아침|저녁|밤|새벽|점심|오전|오후|주말|평일|[월화수목금토일]요일|(?:한|두|세|네|다섯|여섯|\\d{1,3})\\s?(?:시간|분|일|주|달|개월))\\s?마다(?!하|않|할|했)",
      // "주 2회", not "이번 주 2회차".
      "(?<![가-힣0-9])(?<!(?:이번|지난|다음|저번|첫)\\s?)(?:(?:하루|일주일|한\\s?달|일\\s?년|1년)(?:에)?|(?:주|월)\\s?)\\s?(?:한|두|세|네|\\d{1,2})\\s?(?:번|회)(?!\\s?[차째])",
      // "평일 아침 7시에", not "평일 영업시간" or "평일 아침 메뉴".
      "평일(?:마다|\\s?(?:아침|저녁|오전|오후)(?=\\s?(?:\\d|마다|에\\s|,)))",
      "(?<![가-힣])데일리로(?![가-힣])",
    ]),
    // A request: "보내줘", "알려 주세요", "정리해 줄래?", "보내주실 수 있나요?", never "알려주는 앱" or "알려줬어".
    act: SUB([
      "(?:보내|알려|전해|찾아|지켜봐|살펴봐|봐|써|만들어|골라|뽑아|모아|상기시켜|챙겨|짜|들려|읽어|가르쳐|해)\\s?(?:줘(?![서도야])|줘요|주세요|주셔|주실|주시겠|주시면|주시길|줄래|줄\\s?수\\s?있(?!는|던|다면|으면)|주라|주면\\s?좋겠|줬으면|주십시오|주시오|주겠니|줄\\s?거)",
      "내(?:줘(?![서도야])|주세요|줄래|주실)|(?<![가-힣])(?:줘(?![서도야])|주세요|줄래)",
      "부탁(?:해(?![서도야])|해요|합니다|드려요|드립니다|드릴게요|드릴께요|할게|할께|드림)",
    ]),
    // Reminders asked of Flash ("리마인드 해줘", "…하라고 알려줘"), never "리마인드 메일 작성해줘", "리마인드 부탁 메일" or
    // "리마인드 해주세요를 영어로"; "let me know" only after a future event ("출시되면 알려줘"), never "언제 끝났는지 알려줘" or
    // "에러 뜨면 알려줘".
    strong: SUB([
      "리마인드\\s?(?:좀\\s?)?(?:해\\s?(?:줘(?![서도야])|주세요|줄래|주실|주시겠|줄\\s?수)|해$|부탁(?!\\s?(?:메일|문자|메시지|이메일|글|드리는|하는|한다는|드린다는)))(?!\\s?(?:를|을|라는|라고|란|는\\s?말|영어로))",
      "리마인더\\s?(?:좀\\s?)?(?:설정|등록)\\s?(?:해\\s?)?(?:줘(?![서도야])|주세요|줄래|주실|주시겠)",
      "(?:하라고|하라구|으라고|가라고|오라고|내라고|사라고|(?<!바)보라고|(?<!모)자라고|마시라고|챙기라고|일어나라고|말라고|쓰라고|끄라고|켜라고|타라고|보내라고|드리라고|두라고)\\s?(?:좀\\s?)?(?:알려|말해|얘기해|리마인드\\s?해|상기시켜)\\s?(?:줘(?![서도야])|주세요|줄래|주실|주시겠|줄\\s?수)",
      "(?:잊지|까먹지|잊어버리지)\\s?않(?:게|도록)\\s?(?:좀\\s?)?(?:알려|리마인드\\s?해|챙겨|말해)\\s?(?:줘(?![서도야])|주세요|줄래|주실|주시겠)",
      "(?:출시되|발매되|(?<!(?:에러|오류|답|정답|경고|버그|결론|팝업|창)(?:가|이)?\\s?)(?:나오|뜨)|공개되|발표되|입고되|재입고되|떨어지|오르|내려가|올라가|넘으|넘어가|돌파하|하락하|상승하|열리|시작되|오픈하|업데이트되|올라오|도착하|들어오|\\d\\s?(?:만\\s?)?(?:원|달러|불|엔|위안|유로|%|퍼센트|도)(?:이|가)?\\s?(?:이하가\\s?|이상이\\s?)?되)(?:면|는\\s?대로|자마자)\\s?(?:바로\\s?|즉시\\s?|좀\\s?|꼭\\s?)?(?:나한테\\s?|저한테\\s?|저에게\\s?|나에게\\s?)?(?:알려|알림(?:\\s?(?:보내|해))?|연락해|말해)\\s?(?:줘(?![서도야])|주세요|줄래|주실|주시겠|줄\\s?수)",
    ]),
    // Questions, habits and complaints: "매일 물을 얼마나 마셔야 하는지 알려줘", "매일 운동하면 좋은 점", "나는 매시간…",
    // "엄마가 매일…", "밤마다 잠이 안 와서…", "선인장은 매일 물 줘?" (the "?" is gone once the sentence is cut).
    not: SUB([
      "얼마나|얼마(?:야|예요|에요|인지|지|를|가|정도|면)|몇\\s?(?:명|번|시간|시|잔|리터|킬로|칼로리|kg|분|살|퍼센트|%|회|kcal|ml)|왜|어째서|어떻게(?!\\s?(?:됐|되었|마감|움직였|변했|바뀌었|끝났))|[는을]\\s?방법|는\\s?법|장점|단점|좋은\\s?점|나쁜\\s?점|효과(?!적)|이점|영향|부작용|빈도|이유|원인",
      "도\\s?(?:돼|되나|되는지|되니|되요|돼요|됩니까|될까|괜찮)|괜찮(?:아|나|을까|은가|은지|나요|습니까)|정상(?:이야|인가|이에요|인지|일까)|(?:좋|나쁘|건강하)(?:을까|은지|은가|나요|니|냐)|해야\\s?(?:해|하나|할까|돼|되나|하는지|할지)|하는\\s?게\\s?(?:좋|나|맞)|(?:하면|으면|시면)\\s?(?:좋|나쁜|안\\s?좋|어떻게|어떤|무슨|뭐|얼마|몸|건강|살)",
      "(?:매일|하루|데일리|아침)\\s?(?:루틴|일과|습관)|(?:매일|하루)\\s?식단|아파|아프|아픈|피곤|졸려|졸리|힘들|힘든|힘드|잠이\\s?(?:안|잘\\s?안)|잠을\\s?(?:못|잘\\s?못)|불면|짜증|귀찮|싫어|정기\\s?(?:배송|구독|결제)|(?:물|밥|사료|간식|비료|영양제)\\s?(?:을|를)?\\s?줘(?![가-힣])|(?:라는|이라는|란)\\s?(?:문구|말|문장|글귀|표현|메시지|제목)",
      "(?:^|\\s)(?:나는|난|저는|제가|내가|우리는|우린)\\s(?:[가-힣]{1,6}\\s)?(?:매|맨날|항상|늘|보통|평소|자주|날마다)|(?<![가-힣])(?:엄마|아빠|부모님|남편|아내|남친|여친|남자친구|여자친구|애인|친구|선생님|상사|동료|팀장|부장|선배|후배|아이|애기|아기|딸|아들|동생|언니|오빠|누나|형|할머니|할아버지|강아지|고양이|사람|그녀|걔|앱|어플|폰|휴대폰|시리)(?:가|이|는|은|도)\\s",
    ]),
    // A habit before the request: "매주 월요일에 헬스장 가는데 운동 계획 짜줘", "매일 아침 조깅해요, 운동화 추천해 주세요",
    // "매일 할 수 있는 운동 알려줘", "매일 마시는 커피"; but "매주 새로 나오는 영화", "팟캐스트 하나씩" say what each one is.
    between: /(?:는|은|인|한|던|운|쁜|픈|된)데(?=\s|,|$)|니까|지만|거든|(?:것|거|기)에\s?(?:대한|관한)|(?:있어|없어|많아|바빠|아파|와|피곤해|힘들어|늦어)서\s|(?:요|니다|해)\s?[,，]|^(?![\s\S]{0,80}?(?:오늘|이번\s?주|이번\s?달|그날|새로|최신|신작|신곡|내일|다음\s?주|씩|(?:내가|제가|우리가|저희가)\s[가-힣]{1,4}는\s(?:곳|동네|지역|도시|근처)))[\s\S]{0,80}?(?:수\s?있는|기\s?좋은|하면\s?좋은|할\s?만한|해야\s?하는|는\s?법|만한\s|(?:휴무|휴일|휴관)인\s|(?:열리|하|있|되|먹|가|보|파|생기|움직이|일어나|주|마시|읽|듣|쓰|오|타|자|다니|만들|받|찍|씻|입|신|바르|챙기|키우|배우|걷|뛰|달리|여|닫|피우|보내)는\s)/u,
  },
  "zh-Hans": {
    recur: SUB([
      // Only right before what it schedules ("每天早上", "每周一8点，", "每天给我", "每天都提醒我", "每月1号提醒我"), never
      // describing a noun or a habit: "这份每周报告", "我的每月预算", "每日经济新闻", "每天的作息", "天天向上", "今天天也很热",
      // "每一天都很美好", "每天都很累", "每天早上6点起床，…", "每天给孩子讲故事，…", "每月1号发工资，…".
      "(?<![份个篇张的这那些项期次款种类样套本部位名首段句])(?:每(?:周|星期|个星期|礼拜|个礼拜)[一二三四五六日天]|每逢(?:周|星期|礼拜)[一二三四五六日天末]|每(?:隔|(?!一))(?:[0-9]{1,3}|[一两二三四五六七八九十半几]{1,3})个?(?:小时|钟头|分钟|天|日|周|星期|礼拜|月|年)|每(?:天|日|晚|早|夜|周末?|个周末|星期|个星期|礼拜|个礼拜|月|个月|年|小时|个小时|个?工作日)|(?<![今明昨后前当整半两几哪])天天|(?<!非)工作日(?:的)?(?:每天)?(?=早|上午|中午|下午|晚|[0-9]{1,2}[点:：]))(?:早上|上午|中午|下午|晚上|早晨|清晨|傍晚|凌晨|夜里)?(?:[0-9]{1,2}(?:[点:：](?:[0-9]{1,2}分?|半)?))?(?=(?:(?:都|就|也|会|要|只|再)(?:要|会)?|(?:睡前|睡觉前|起床后|下班后|下班前|上班前|上班后|放学后|(?:早|午|晚)?饭(?:后|前)|[月年]?(?:底|初|末|中旬|上旬|下旬)|[0-9一两二三四五六七八九十半几]{1,3}(?:点|次|号|日)(?:[0-9]{1,2}分?|半|钟)?)(?:都|就|也|要)?)?(?:[，,、。\\s!！?？:：;；~～]|$|请|你|您|麻烦|给(?:我|咱|大家|团队|全家)|帮|替|把|(?:跟|和|为|对)我|提醒(?!自己)|告诉(?!自己)|通知|发(?:给|一|个|我|送|条|篇)|推送|推(?:给|一|个)|传|寄|检查(?:一下|下|我|有没有|是否)|查(?:一下|下|看|询)|看看|看一下|看下|(?:总结|汇总|整理|更新)(?:一下|下|给)|写(?:一|个|首|篇|给)|编(?:一|几|个|给)|来(?:一|几|个|点)|出(?:一|几|个)|推荐(?:一|几|个|给|我)|教(?:我|一|几|个)|找(?:一|几|个|些)|搜(?:一下|索)|(?:监控|盯|关注|跟踪|追踪|比较|对比|分析)(?:一下|下)|报给|汇报|分享(?:一|几|个|给)|列(?:一|几|个|出)|收集|生成(?:一|几|个)|讲(?:一|几|个|给)|(?:自动|定时|准时|按时|固定(?:时间)?|随机)地?(?:给|帮|发|推送|提醒|告诉|通知|把|检查|查|总结|整理|汇总|推荐|来|报)|挑(?:一|几|个)|选(?:一|几|个))|[0-9一两二三四五六七八九十半几]{1,3}(?:条|个|篇|首|句|则|份|道|本|张)|周[一二三四五六日天末]|星期|礼拜)",
      // Right after a request word the schedule needs nothing after it: "帮我每周一给老板写一份周报".
      "(?<=帮我|幫我|请|請|麻烦你|麻煩你|能不能|能否|可不可以)(?:每(?:天|日|晚|周[一二三四五六日天末]?|星期[一二三四五六日天]|个星期[一二三四五六日天]?|礼拜[一二三四五六日天]|个礼拜[一二三四五六日天]?|个?周末|月|个月|年)|天天)",
      "(?<![第统唯])一(?:天|周|星期|个星期|个月|年|小时)(?:[0-9一两二三四五六七八九十]{1,2})次(?!的)",
      "(?<![规约预不])定(?:期|时)(?=给我|帮我|提醒我|告诉我|发给我|推送|通知我|把)",
    ]),
    // Request forms only ("帮我", "给我发", "发给我", "告诉我", "查一下", "写一首"), not a bare "检查" or "总结".
    act: SUB([
      "帮我|替我|帮忙|麻烦你|劳烦",
      "给我(?:发|推送|推|传|写|讲|说|总结|汇总|整理|列|找|查|搜|选|挑|推荐|准备|生成|做(?!饭)|来|报|汇报|更新|出|提个?醒|一|[0-9两二三四五六七八九十几]{1,2}(?:条|个|篇|首|则|份|句|道|本|部|只|支|件|张))",
      "(?:发|发送|推送|推|传|寄|总结|整理|汇总|列|写|讲|报|汇报|转发|转|分享|推荐)给我|(?<![开出收沙头激启触揭举颁分散引生挥阐批研打蒸爆突自奋理])发我(?!们)",
      // "告诉我" after a pause, "请/你/能" or a time ("每天早上告诉我"), never "医生告诉我每天要…" or "他总是跟我说每天…".
      "(?=[告通推教跟和对])(?<=^|[，,、\\s]|请|請|你|您|能|可以|能否|麻烦你?|麻煩你?|唔該|再|就|也|都|并|並|然后|然後|记得|記得|直接|顺便|順便|马上|馬上|立刻|即刻|及时|及時|第一时间|第一時間|时|時|前|后|後|点|點|分|半|天|晚|早|上|午|朝|晝|[周週][一二三四五六日天末]?|(?:星期|礼拜|禮拜)[一二三四五六日天]?|号|號|日|末|底|初|旬|尾|晨|次|月|年|候)(?:(?:告诉|通知|告知|推荐|教)我(?!们)|(?:跟|和|对)我(?:说|讲))",
      "提醒(?:一下|下)?(?:我(?!们)|吃|喝|交|付|还|去|买|起|记|做|写|看|睡|运动|休息|打)",
      "(?:查|看|检查|查看|搜|搜索|总结|汇总|整理|比较|对比|分析|确认|关注|盯|更新|核对|监控|跟踪|追踪|统计|收集|梳理|列)(?:一下|下(?![周个午次星礼月半面来去班雨载单手属降跌滑]))",
      "(?:写|编|出|列|推荐|找|选|挑|发|推|讲|(?<![原后看出起下上进回])来|做|整理|总结|传)(?:[一两几0-9]{1,2}|个)(?:首|篇|段|条|份|个|句|封|道|则|本|部|张|只|支|件|题)",
      "推送(?![通的服功消])|(?<![大小缩抄描速填编改书手])写(?:份|篇|首|封)",
    ]),
    // Each Chinese table also reads the other script (they share 每天, 提醒我, 查一下), so its guards name both.
    strong: SUB([
      // "提醒我" asked of Flash, never "这首歌提醒我…", "妈妈每天提醒我…", "怎么让手机提醒我…", "提醒我一下秘鲁的首都是什么",
      // "推荐一个能每天提醒我喝水的App" or the past "今天提醒我带伞了".
      "提醒(?<=(?:^|[，,、\\s]|请|請|麻烦你?|麻煩你?|记得|記得|记着|記著|你|您|帮我|幫我|帮忙|幫忙|能|可以|能否|到时候?|到時候?|然后|然後|并且?|並且?|再|时|時|前|后|後|点|點|分|半|天|晚|早|上|午|号|號|日|末|[一二三四五六]|忘了|忘记|忘記|准时|準時|按时|按時|定时|定時)提醒)(?<!(?:昨天|前天|那天|当天|當天|刚才|剛才|那时|那時|当时|當時)提醒)(?<!(?:怎么|怎麼|如何|怎样|怎樣|为什么|為什麼|为啥|為啥|让|讓|叫|使)[^，,。！？\\n]{0,14})(?<!(?:他|她|它|佢|妈|媽|爸|老师|老師|朋友|同事|老板|老闆|老婆|老公|医生|醫生|闹钟|鬧鐘|手机|手機|日历|日曆|系统|系統|微信|app|软件|軟件|軟體|应用|應用|女友|男友|姐|哥|弟|妹|奶奶|爷爷|爺爺|室友|孩子|歌|话|話|照片)[^，,。！？\\n]{0,10})(?:一下|下)?我(?!们|們|了|的|过|過)(?![^，,。！？\\n]{0,20}?(?:是什么|是什麼|是啥|是谁|是誰|叫什么|叫什麼|讲的|講的|讲了|講了|情节|情節|剧情|劇情|内容|內容|公式|什么意思|什麼意思|区别|區別|有哪些|在哪|的(?:app|应用|應用|软件|軟件|軟體|工具|小程序|程序|程式|手表|手錶|闹钟|鬧鐘|功能|设备|設備)))(?![^，,。！？\\n]{0,15}?(?<!就行|就好|可以|就成)了(?:$|[，,。！？]))",
      // "Notify me when it's released / drops below …", never "告诉我二战什么时候结束", "怎么设置降价时通知我", "算出来就告诉我"
      // or "我的体重超过70公斤了，告诉我怎么减肥".
      "(?:发布|上市|开售|发售|推出|(?<![算想写做翻译查找画编弄搞猜看听计读拿取挑选])出来|上架|降价|打折|涨价|到货|补货|有货|开放预约|开抢|开票|放票|有票|上线|公布|出结果|开奖|开播|更新|跌了|涨了)(?:了?(?:的时候|时|以后|之后|后)|了?就)[，,]?\\s?(?:请|就|立刻|马上|立即|第一时间|麻烦|记得|及时|赶紧|再)?(?:告诉|通知|提醒|告知)(?:一下)?我(?!们)(?<!(?:怎么|怎麼|如何|怎样|怎樣|为什么|為什麼|让|讓)[^。！？\\n]{0,40})(?![^，,。！？\\n]{0,10}?(?:怎么|怎麼|为什么|為什麼|如何|咋|點樣|點解))",
      "(?:跌破|涨破|突破|低于|高于|超过|跌到|涨到|降到|跌至|涨至|降至|不到|少于)[^，。！？\\n了]{0,15}?(?:(?:的时候|时|以后|之后|后|就|了就|的话)[，,]?)?\\s?(?:请|就|立刻|马上|立即|第一时间|麻烦|记得|及时|赶紧)?(?:告诉|通知|提醒|告知)(?:一下)?我(?!们)(?<!(?:怎么|怎麼|如何|怎样|怎樣|为什么|為什麼|让|讓)[^。！？\\n]{0,40})(?![^，,。！？\\n]{0,10}?(?:怎么|怎麼|为什么|為什麼|如何|咋|點樣|點解))",
      "等[^，。！？\\n]{1,20}?(?:发布|上市|开售|发售|推出|(?<![算想写做翻译查找画编弄搞猜看听计读拿取挑选])出来|上架|降价|打折|到货|补货|有货|开放预约|开抢|开票|放票|有票|上线|公布|出结果|开奖|开播|更新)(?:了|后|以后|之后|的时候)?[，,]?\\s?(?:请|再|就|立刻|马上|立即|第一时间|记得|及时|赶紧)?(?:告诉|通知|提醒|告知)(?:一下)?我(?!们)(?![^，,。！？\\n]{0,10}?(?:怎么|怎麼|为什么|為什麼|如何|咋|點樣|點解))",
      "别让我忘(?:了|记)",
    ]),
    // Questions, habits and complaints, in both scripts: "我每天应该喝多少水", "每天锻炼有什么好处", "我每小时都要看一下手机",
    // "妈妈每天提醒我…", "微信每天都提醒我更新，烦死了", "每天看一下新闻就够了吗".
    not: SUB([
      "多久一次|多[长長](?:时间|時間)一次|频率|頻率|多频繁|多頻繁|(?<![涨漲跌升降]了?|[升跌漲]咗|是|係)(?:多少|幾多)(?!钱|錢)|(?:花|用|存|赚|賺|攒|攢|要|该|該|应该|應該|需要|得)(?:多少|幾多)(?:钱|錢)|几(?:杯|升|公斤|斤|小时|个小时|個小時|小時|点|點|次|岁|歲|分钟|分鐘|毫升|克|卡|千卡)|幾(?:杯|升|公斤|斤|小時|個小時|個鐘|點|次|歲|分鐘|毫升|克|卡|千卡)|為什麼|为什么|为何|為何|为啥|為啥|點解|怎么(?!样)|怎麼(?!樣)|怎样|怎樣|如何(?![，,。]|$)|咋|點樣",
      "^(?:什么是|什麼是|啥是)|是(?:什么|什麼|啥)(?:意思)?$|什么意思|什麼意思|好处|好處|坏处|壞處|益处|益處|优点|優點|缺点|缺點|利弊|危害|副作用|(?:的|有(?:什么|什麼|啥|哪些)?)(?:效果|作用|影响|影響)|有(?:什么|什麼|啥)用|有用(?:吗|嗎)|有没有用|有沒有用|有意义(?:吗|嗎)|有意義(?:嗎|吗)|值得(?:吗|嗎)|值不值得|[够夠]了?(?:吗|嗎)|[够夠]不[够夠]|就行(?:吗|嗎)",
      "(?<![，,我下吧呢])好(?:吗|嗎|不好)|正常(?:吗|嗎|不)|有害|健康(?:吗|嗎)|伤身|傷身|对身体|對身體|应不应该|應不應該|该不该|該不該|(?<!(?:告诉|告訴|提醒|通知)我|話我知)(?:要不要|需不需要)|是否应该|是否應該|(?:^|[，,])我(?:每天|每周|每週|每月|一天)?(?:应该|應該|该|該)|(?:合适|合適|比较好|比較好|最好|才好)(?:呢|啊)?$|(?:吗|嗎)$(?<!(?:你|您|能|可以|麻烦|麻煩|帮|幫|给我|給我|请|請|行|成|提醒|告诉|告訴|通知|发给|發給|唔該)[^。！？\\n]{0,40}(?:吗|嗎))",
      "翻译成|翻譯成|译成|譯成|(?:把|將|将)[^，,。]{0,8}?(?:翻译|翻譯)|怎么说|怎麼說|用(?:英语|英文|英語)(?:怎么|怎麼|说|說|讲|講|表达|表達)|(?:关于|關於|有关|有關)[^，,。]{0,6}?(?:每|天天)",
      "(?<![帮幫给給替让讓叫醒诉訴知跟和请請为為对對同])(?:我|咱)(?:们|們|哋|地)?(?:家|公司|学校|學校|班|这边|這邊)?(?:几乎|幾乎|基本上?|一般|通常|平时|平時|总是|總是|总|總|经常|經常|常常|老是|都|也都|也)?(?:每|天天|一(?:天|周|週|星期|个星期|個星期|个月|個月|年)[0-9一两兩二三四五六七八九十]{1,2}次)|(?<![帮幫给給替让讓叫醒诉訴知跟和请請为為对對同])我(?:都|也都|一般|通常|基本上?|平时|平時|经常|經常|总是|總是|常常|老是)",
      "(?:他|她|它|佢|妈妈|媽媽|妈|媽|阿媽|爸爸|爸|阿爸|老豆|老竇|老板|老闆|老細|老师|老師|医生|醫生|同事|朋友|孩子|儿子|兒子|女儿|女兒|老公|老婆|男朋友|女朋友|男友|女友|手机|手機|电脑|電腦|系统|系統|闹钟|鬧鐘|微信|日历|日曆|公众号|公眾號|app|软件|軟體|軟件|应用|應用)(?:们|們|哋|地)?(?:几乎|幾乎|基本上?|一般|通常|总是|總是|总|總|经常|經常|都|也|会|會|自动|自動)?(?:每|天天)|烦死|好烦|很烦|太烦|烦人|煩死|好煩|很煩|太煩|煩人|讨厌|討厭|受不了|骚扰|騷擾|太多了|太多喇|太多啦|太频繁|太頻繁",
      // Code or a product that does it, not Flash: "帮我写个脚本，每天自动备份", "推荐一个能每天提醒我喝水的App".
      "脚本|腳本|代码|代碼|(?<![a-z])(?:cron|crontab|python)(?![a-z])|定时任务|定時任務|计划任务|計劃任務|函数|函數|爬虫|爬蟲|(?:每|天天)[^，,。！？\\n给給帮幫]{1,20}?的(?:那个|那個|这个|這個|那款|这款|這款)?(?:app|应用|應用|软件|軟件|軟體|工具|小程序|程序|程式|手表|手錶|闹钟|鬧鐘|设备|設備)|叫(?:什么|什麼|啥)",
    ]),
  },
  "zh-Hant": {
    recur: SUB([
      // Only right before what it schedules ("每天早上", "每週一8點，", "逢星期一", "每天給我", "每月一號提我"), never describing
      // a noun or a habit: "這份每週報告", "我的每月預算", "每日新聞", "每天的作息", "天天向上", "今天天都好熱",
      // "每一天都好開心", "每天早上6點起身，…", "每個月一號出糧，…".
      "(?<![份個个篇張的這那些項期次款種類樣套本部位名首段句])(?:每(?:週|周|星期|個星期|禮拜|個禮拜)[一二三四五六日天]|每?逢(?:週|周|星期|禮拜)[一二三四五六日天末]|每(?:隔|(?!一))(?:[0-9]{1,3}|[一兩二三四五六七八九十半幾]{1,3})個?(?:小時|鐘頭|分鐘|天|日|週|周|星期|禮拜|月|年)|每(?:天|日|晚|早|夜|朝(?:頭?早)?|週末?|周末?|個[週周]末|星期|個星期|禮拜|個禮拜|月|個月|年|小時|個小時|個?工作日)|(?<![今明昨後后前當整半兩幾哪聽])天天|(?<!非)工作日(?:的)?(?:每天)?(?=早|上午|中午|下午|晚|[0-9]{1,2}[點:：]))(?:早上|上午|中午|下午|晚上|早晨|清晨|傍晚|凌晨|夜裡|夜裏|朝早|朝頭早|夜晚|晏晝|下晝)?(?:[0-9]{1,2}(?:[點:：](?:[0-9]{1,2}分?|半)?))?(?=(?:(?:都|就|也|會|要|只|再)(?:要|會)?|(?:睡前|睡覺前|起床後|下班後|下班前|上班前|上班後|放學後|(?:早|午|晚)?飯(?:後|前)|放工前|放工後|收工後|返工前|返工後|瞓覺前|瞓前|食飯前|食飯後|食完飯|[月年]?(?:底|初|末|尾|中旬|上旬|下旬)|[0-9一兩二三四五六七八九十半幾]{1,3}(?:點|次|號|日)(?:[0-9]{1,2}分?|半|鐘)?)(?:都|就|也|要)?)?(?:[，,、。\\s!！?？:：;；~～]|$|請|你|您|麻煩|唔該|給(?:我|咱|大家|團隊|全家)|幫|替|把|將|(?:跟|和|為|對|同)我|提(?:醒(?!自己)|我|下我)|告訴(?!自己)|通知|話(?:俾|畀)?我|send|發(?:給|俾|畀|一|個|我|送|條|篇)|推送|推(?:給|一|個)|傳|寄|檢查(?:一下|下|我|有沒有|是否)|查(?:一下|下|看|詢)|睇(?:下|一下|吓)|看看|看一下|看下|(?:總結|彙總|匯總|整理|更新)(?:一下|下|給)|寫(?:一|個|首|篇|給)|編(?:一|幾|個|給)|來(?:一|幾|個|點)|出(?:一|幾|個)|推薦(?:一|幾|個|給|我)|教(?:我|一|幾|個)|找(?:一|幾|個|些)|搵(?:一|幾|個|下)|搜(?:一下|尋|索)|(?:監控|盯|關注|跟蹤|追蹤|比較|對比|分析)(?:一下|下)|報給|匯報|彙報|分享(?:一|幾|個|給)|列(?:一|幾|個|出)|收集|生成(?:一|幾|個)|講(?:一|幾|個|給)|(?:自動|定時|準時|按時|固定(?:時間)?|隨機)地?(?:給|幫|發|推送|提|告訴|通知|話|把|檢查|查|總結|整理|彙總|匯總|推薦|來|報|send)|挑(?:一|幾|個)|選(?:一|幾|個))|[0-9一兩二三四五六七八九十半幾]{1,3}(?:條|個|篇|首|句|則|份|道|本|張)|[週周][一二三四五六日天末]|星期|禮拜)",
      // Right after a request word the schedule needs nothing after it: "幫我每個禮拜一寫份週報".
      "(?<=幫我|帮我|請|请|麻煩你|麻烦你|唔該|能不能|能否|可不可以|可唔可以)(?:每(?:天|日|晚|朝|[週周][一二三四五六日天末]?|星期[一二三四五六日天]|個星期[一二三四五六日天]?|禮拜[一二三四五六日天]|個禮拜[一二三四五六日天]?|個?[週周]末|月|個月|年)|天天)",
      "(?<![第統唯])一(?:天|週|周|星期|個星期|個月|年|小時)(?:[0-9一兩二三四五六七八九十]{1,2})次(?!的|嘅)",
      "(?<![規約預不])定(?:期|時)(?=給我|幫我|提醒我|告訴我|發給我|推送|通知我|把|話我知|send)",
    ]),
    // Request forms only ("幫我", "給我發", "發給我", "告訴我", "查一下", "send俾我", "話我知"), not a bare "檢查".
    act: SUB([
      "幫我|替我|幫忙|麻煩你|勞煩|同我|(?<![前手大])提下?我(?![們的嘅出])",
      "給我(?:發|推送|推|傳|寫|講|說|總結|彙總|匯總|整理|列|找|查|搜|選|挑|推薦|準備|生成|做(?!飯)|來|報|匯報|更新|出|提個?醒|一|[0-9兩二三四五六七八九十幾]{1,2}(?:條|個|篇|首|則|份|句|道|本|部|隻|支|件|張))",
      "(?:發|發送|推送|推|傳|寄|總結|整理|彙總|匯總|列|寫|講|報|匯報|轉發|轉|分享|推薦|send)(?:給|俾|畀)我|(?:send|發|傳|寄)[^，,。！？\\n]{1,12}?(?:俾|畀)我|(?<![開出收沙頭激啟觸揭舉頒分散引生揮闡批研打蒸爆突自奮理])發我(?!們)",
      // "告訴我" / "話我知" after a pause, "請/你/能" or a time ("每日早上話我知"), never "醫生話我知每日要…".
      "(?=[告通推教跟和對話])(?<=^|[，,、\\s]|请|請|你|您|能|可以|能否|麻烦你?|麻煩你?|唔該|再|就|也|都|并|並|然后|然後|记得|記得|直接|顺便|順便|马上|馬上|立刻|即刻|及时|及時|第一时间|第一時間|时|時|前|后|後|点|點|分|半|天|晚|早|上|午|朝|晝|[周週][一二三四五六日天末]?|(?:星期|礼拜|禮拜)[一二三四五六日天]?|号|號|日|末|底|初|旬|尾|晨|次|月|年|候)(?:(?:告訴|通知|告知|推薦|教)我(?!們)|(?:跟|和|對)我(?:說|講)|話(?:俾|畀)?我知)",
      "提醒(?:一下|下)?(?:我(?!們)|吃|喝|交|付|還|去|買|起|記|做|寫|看|睡|運動|休息|打)",
      "(?:查|看|檢查|查看|搜|搜尋|搜索|總結|彙總|匯總|整理|比較|對比|分析|確認|關注|盯|更新|核對|監控|跟蹤|追蹤|統計|收集|梳理|列)(?:一下|下(?![週周個午次星禮月半面來去班雨載單手屬降跌滑]))",
      "(?:寫|編|出|列|推薦|找|選|挑|發|推|講|(?<![原後看出起下上進回])來|做|整理|總結|傳)(?:[一兩幾0-9]{1,2}|個)(?:首|篇|段|條|份|個|句|封|道|則|本|部|張|隻|支|件|題)",
      "推送(?![通的服功消])|(?<![大小縮抄描速填編改書手])寫(?:份|篇|首|封)",
    ]),
    // Each Chinese table also reads the other script (they share 每天, 提醒我, 查一下), so its guards name both.
    strong: SUB([
      // "提醒我" asked of Flash, never "這首歌提醒我…", "媽媽每天提醒我…", "怎麼讓手機提醒我…", "提醒我一下秘魯的首都是什麼",
      // "推薦一個可以每天提醒我喝水的App" or the past "今天提醒我帶傘了".
      "提醒(?<=(?:^|[，,、\\s]|请|請|麻烦你?|麻煩你?|记得|記得|记着|記著|你|您|帮我|幫我|帮忙|幫忙|能|可以|能否|到时候?|到時候?|然后|然後|并且?|並且?|再|时|時|前|后|後|点|點|分|半|天|晚|早|上|午|号|號|日|末|[一二三四五六]|忘了|忘记|忘記|准时|準時|按时|按時|定时|定時)提醒)(?<!(?:昨天|前天|那天|当天|當天|刚才|剛才|那时|那時|当时|當時)提醒)(?<!(?:怎么|怎麼|如何|怎样|怎樣|为什么|為什麼|为啥|為啥|让|讓|叫|使)[^，,。！？\\n]{0,14})(?<!(?:他|她|它|佢|妈|媽|爸|老师|老師|朋友|同事|老板|老闆|老婆|老公|医生|醫生|闹钟|鬧鐘|手机|手機|日历|日曆|系统|系統|微信|app|软件|軟件|軟體|应用|應用|女友|男友|姐|哥|弟|妹|奶奶|爷爷|爺爺|室友|孩子|歌|话|話|照片)[^，,。！？\\n]{0,10})(?:一下|下)?我(?!们|們|了|的|过|過)(?![^，,。！？\\n]{0,20}?(?:是什么|是什麼|是啥|是谁|是誰|叫什么|叫什麼|讲的|講的|讲了|講了|情节|情節|剧情|劇情|内容|內容|公式|什么意思|什麼意思|区别|區別|有哪些|在哪|的(?:app|应用|應用|软件|軟件|軟體|工具|小程序|程序|程式|手表|手錶|闹钟|鬧鐘|功能|设备|設備)))(?![^，,。！？\\n]{0,15}?(?<!就行|就好|可以|就成)了(?:$|[，,。！？]))",
      // "Notify me when it's released / drops below …", never "告訴我二戰什麼時候結束", "怎麼設定降價時通知我", "計出來就話我知"
      // or "我嘅體重超過70公斤，話我知點樣減肥".
      "(?:發布|發佈|上市|開賣|開售|發售|推出|(?<![算想寫做翻譯查找畫編弄搞猜看聽計讀拿取挑選諗])出來|上架|降價|打折|漲價|到貨|補貨|有貨|開放預約|開搶|開票|放票|有票|上線|公布|公佈|出結果|開獎|開播|更新|跌了|漲了|跌咗|漲咗|升咗)(?:了?(?:的時候|時|以後|之後|後)|了?就|咗?(?:嗰陣|嗰時|就|之後|後))[，,]?\\s?(?:請|就|立刻|馬上|立即|即刻|第一時間|麻煩|記得|及時|趕緊|再)?(?:(?:告訴|通知|提醒|告知)(?:一下)?我(?!們)|話(?:俾|畀)?我知)(?<!(?:怎么|怎麼|如何|怎样|怎樣|为什么|為什麼|让|讓)[^。！？\\n]{0,40})(?![^，,。！？\\n]{0,10}?(?:怎么|怎麼|为什么|為什麼|如何|咋|點樣|點解))",
      "(?:跌破|漲破|突破|低於|高於|超過|跌到|漲到|降到|跌至|漲至|降至|不到|少於)[^，。！？\\n了咗]{0,15}?(?:(?:的時候|時|以後|之後|後|就|了就|的話|嗰陣|嗰時)[，,]?)?\\s?(?:請|就|立刻|馬上|立即|即刻|第一時間|麻煩|記得|及時|趕緊)?(?:(?:告訴|通知|提醒|告知)(?:一下)?我(?!們)|話(?:俾|畀)?我知)(?<!(?:怎么|怎麼|如何|怎样|怎樣|为什么|為什麼|让|讓)[^。！？\\n]{0,40})(?![^，,。！？\\n]{0,10}?(?:怎么|怎麼|为什么|為什麼|如何|咋|點樣|點解))",
      "等[^，。！？\\n]{1,20}?(?:發布|發佈|上市|開賣|開售|發售|推出|(?<![算想寫做翻譯查找畫編弄搞猜看聽計讀拿取挑選諗])出來|上架|降價|打折|到貨|補貨|有貨|開放預約|開搶|開票|放票|有票|上線|公布|公佈|出結果|開獎|開播|更新)(?:了|後|以後|之後|的時候|咗)?[，,]?\\s?(?:請|再|就|立刻|馬上|立即|即刻|第一時間|記得|及時|趕緊)?(?:(?:告訴|通知|提醒|告知)(?:一下)?我(?!們)|話(?:俾|畀)?我知)(?![^，,。！？\\n]{0,10}?(?:怎么|怎麼|为什么|為什麼|如何|咋|點樣|點解))",
      // Cantonese "提我" (remind me) after a time or "記得", never "前提我覺得" or "提我嘅名".
      "別讓我忘(?:了|記)|(?:記得|记得|聽日|听日|聽朝|聽晚|今晚|今朝|點鐘|點半|[0-9一二三四五六七八九十兩]點|之前|之後|以後|到時|唔該|麻煩你?)提我(?![們的嘅出個个])",
    ]),
    // Questions, habits and complaints, in both scripts: "我每天應該喝多少水", "每天運動有什麼好處", "我每小時都要看一下手機",
    // "媽媽每天提醒我…", "微信每天都提醒我更新，煩死了", "每天看一下新聞就夠了嗎".
    not: SUB([
      "多久一次|多[长長](?:时间|時間)一次|频率|頻率|多频繁|多頻繁|(?<![涨漲跌升降]了?|[升跌漲]咗|是|係)(?:多少|幾多)(?!钱|錢)|(?:花|用|存|赚|賺|攒|攢|要|该|該|应该|應該|需要|得)(?:多少|幾多)(?:钱|錢)|几(?:杯|升|公斤|斤|小时|个小时|個小時|小時|点|點|次|岁|歲|分钟|分鐘|毫升|克|卡|千卡)|幾(?:杯|升|公斤|斤|小時|個小時|個鐘|點|次|歲|分鐘|毫升|克|卡|千卡)|為什麼|为什么|为何|為何|为啥|為啥|點解|怎么(?!样)|怎麼(?!樣)|怎样|怎樣|如何(?![，,。]|$)|咋|點樣",
      "^(?:什么是|什麼是|啥是)|是(?:什么|什麼|啥)(?:意思)?$|什么意思|什麼意思|好处|好處|坏处|壞處|益处|益處|优点|優點|缺点|缺點|利弊|危害|副作用|(?:的|有(?:什么|什麼|啥|哪些)?)(?:效果|作用|影响|影響)|有(?:什么|什麼|啥)用|有用(?:吗|嗎)|有没有用|有沒有用|有意义(?:吗|嗎)|有意義(?:嗎|吗)|值得(?:吗|嗎)|值不值得|[够夠]了?(?:吗|嗎)|[够夠]不[够夠]|就行(?:吗|嗎)",
      "(?<![，,我下吧呢])好(?:吗|嗎|不好)|正常(?:吗|嗎|不)|有害|健康(?:吗|嗎)|伤身|傷身|对身体|對身體|应不应该|應不應該|该不该|該不該|(?<!(?:告诉|告訴|提醒|通知)我|話我知)(?:要不要|需不需要)|是否应该|是否應該|(?:^|[，,])我(?:每天|每周|每週|每月|一天)?(?:应该|應該|该|該)|(?:合适|合適|比较好|比較好|最好|才好)(?:呢|啊)?$|(?:吗|嗎)$(?<!(?:你|您|能|可以|麻烦|麻煩|帮|幫|给我|給我|请|請|行|成|提醒|告诉|告訴|通知|发给|發給|唔該)[^。！？\\n]{0,40}(?:吗|嗎))",
      "翻译成|翻譯成|译成|譯成|(?:把|將|将)[^，,。]{0,8}?(?:翻译|翻譯)|怎么说|怎麼說|用(?:英语|英文|英語)(?:怎么|怎麼|说|說|讲|講|表达|表達)|(?:关于|關於|有关|有關)[^，,。]{0,6}?(?:每|天天)",
      "(?<![帮幫给給替让讓叫醒诉訴知跟和请請为為对對同])(?:我|咱)(?:们|們|哋|地)?(?:家|公司|学校|學校|班|这边|這邊)?(?:几乎|幾乎|基本上?|一般|通常|平时|平時|总是|總是|总|總|经常|經常|常常|老是|都|也都|也)?(?:每|天天|一(?:天|周|週|星期|个星期|個星期|个月|個月|年)[0-9一两兩二三四五六七八九十]{1,2}次)|(?<![帮幫给給替让讓叫醒诉訴知跟和请請为為对對同])我(?:都|也都|一般|通常|基本上?|平时|平時|经常|經常|总是|總是|常常|老是)",
      "(?:他|她|它|佢|妈妈|媽媽|妈|媽|阿媽|爸爸|爸|阿爸|老豆|老竇|老板|老闆|老細|老师|老師|医生|醫生|同事|朋友|孩子|儿子|兒子|女儿|女兒|老公|老婆|男朋友|女朋友|男友|女友|手机|手機|电脑|電腦|系统|系統|闹钟|鬧鐘|微信|日历|日曆|公众号|公眾號|app|软件|軟體|軟件|应用|應用)(?:们|們|哋|地)?(?:几乎|幾乎|基本上?|一般|通常|总是|總是|总|總|经常|經常|都|也|会|會|自动|自動)?(?:每|天天)|烦死|好烦|很烦|太烦|烦人|煩死|好煩|很煩|太煩|煩人|讨厌|討厭|受不了|骚扰|騷擾|太多了|太多喇|太多啦|太频繁|太頻繁",
      // Code or a product that does it, not Flash: "幫我寫個腳本，每天自動備份", "推薦一個可以每天提醒我喝水的App".
      "脚本|腳本|代码|代碼|(?<![a-z])(?:cron|crontab|python)(?![a-z])|定时任务|定時任務|计划任务|計劃任務|函数|函數|爬虫|爬蟲|(?:每|天天)[^，,。！？\\n给給帮幫]{1,20}?的(?:那个|那個|这个|這個|那款|这款|這款)?(?:app|应用|應用|软件|軟件|軟體|工具|小程序|程序|程式|手表|手錶|闹钟|鬧鐘|设备|設備)|叫(?:什么|什麼|啥)",
    ]),
  },
};

/** The languages listed, for the tests. */
export const SCHEDULE_LANGUAGES = Object.keys(LANGUAGES);

/*
 * Building a pattern's classes of letters (\p{L} and the like) takes about a millisecond each, and the
 * tables have some 1,600 of them. So a pattern is built only for text with one of the strings none of its
 * matches is without (needs below), which are read from its source. The text and the strings are compared
 * lowercased, with the few letters /iu counts as the same as another letter that lowercasing doesn't
 * change to it ("ſ" and "s", "ς" and "σ") changed to that letter (see test/schedule-words.test.ts), so the
 * check never misses a match.
 */
const FOLD: Record<string, string> = {
  ſ: "s", µ: "μ", "ͅ": "ι", "ι": "ι", "ΐ": "ΐ", "ΰ": "ΰ", ϐ: "β", ϵ: "ε", ϑ: "θ", ϰ: "κ", ϖ: "π",
  ϱ: "ρ", ς: "σ", ϕ: "φ", ẛ: "ṡ", ﬅ: "ﬆ", ᲀ: "в", ᲁ: "д", ᲂ: "о", ᲃ: "с", ᲄ: "т", ᲅ: "т", ᲆ: "ъ", ᲇ: "ѣ", ᲈ: "ꙋ",
};
const FOLDS = new RegExp(`[${Object.keys(FOLD).join("")}]`, "gu");
/** Text as the checks compare it. */
export const fold = (s: string) => s.toLowerCase().replace(FOLDS, (c) => FOLD[c]);

// A piece of a pattern: the strings it can match, when there are FEW or fewer (exact), and strings one of
// which each of its matches has (some); null when they aren't known.
type Piece = { exact: string[] | null; some: string[] | null };
const FEW = 24;
const ANY: Piece = { exact: null, some: null };
const EMPTY: Piece = { exact: [""], some: null };
const unique = (list: string[]) => [...new Set(list)];
// Each string of a followed by each of b, or null when that's more than FEW.
const product = (a: string[], b: string[]) =>
  a.length * b.length > FEW ? null : b.length === 1 ? a.map((x) => x + b[0]) : unique(a.flatMap((x) => b.map((y) => x + y)));
// The longer the shortest of the strings, the fewer texts have one.
const score = (list: string[]) => Math.min(...list.map((s) => s.length)) * 10_000 - list.length;
const better = (a: string[] | null, b: string[] | null) => (!a ? b : !b ? a : score(b) > score(a) ? b : a);
const best = (p: Piece) => better(p.some, p.exact && !p.exact.includes("") ? p.exact : null);
const COUNT = /\{(\d+)(?:(,)(\d*))?\}/y;
// Plain characters, up to one that's special or counted.
const PLAIN = /[^\\^$.|?*+()[\]{}]+(?=[^?*+{]|$)/uy;

/**
 * Strings one of which every match of the pattern has, as /iu compares letters, or null when none is
 * known. A class of more than a few characters is any character, a "not followed by" or "not after"
 * (?!…), (?<!…) asks for nothing, and "followed by" or "after" (?=…), (?<=…) for what it reads.
 */
export function needs(source: string): string[] | null {
  let i = 0;
  // A character written with a backslash, after the letter e that follows it.
  const escaped = (e: string): string => {
    const at = i;
    if (e === "u" && source[i] === "{") {
      i = source.indexOf("}", i) + 1;
      return String.fromCodePoint(parseInt(source.slice(at + 1, i - 1), 16));
    }
    if (e === "u" || e === "x") {
      i += e === "u" ? 4 : 2;
      return String.fromCharCode(parseInt(source.slice(at, i), 16));
    }
    if (e === "c") return String.fromCharCode(source.charCodeAt(i++) % 32);
    return { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", "0": "\0" }[e] ?? e;
  };
  // One character in a class, or null for a class of its own (\d, \p{L}).
  const member = (): string | null => {
    if (source[i] !== "\\") {
      const c = String.fromCodePoint(source.codePointAt(i)!);
      i += c.length;
      return c;
    }
    const e = source[i + 1];
    i += 2;
    if ("dDsSwW".includes(e)) return null;
    if (e === "p" || e === "P") {
      i = source.indexOf("}", i) + 1;
      return null;
    }
    return e === "b" ? "\b" : escaped(e);
  };
  const charClass = (): Piece => {
    i++;
    let many = source[i] === "^";
    if (many) i++;
    const chars: string[] = [];
    while (source[i] !== "]") {
      const from = member();
      if (source[i] === "-" && source[i + 1] !== "]") {
        i++;
        const to = member();
        if (from === null || to === null || to.codePointAt(0)! - from.codePointAt(0)! > 8) many = true;
        else for (let c = from.codePointAt(0)!; c <= to.codePointAt(0)!; c++) chars.push(String.fromCodePoint(c));
      } else if (from === null) many = true;
      else chars.push(from);
    }
    i++;
    return many || chars.length > 8 ? ANY : { exact: unique(chars), some: null };
  };
  const atom = (): Piece => {
    const c = source[i];
    if (c === "^" || c === "$") return i++, EMPTY;
    if (c === ".") return i++, ANY;
    if (c === "[") return charClass();
    if (c === "(") {
      const look = source.startsWith("(?=", i) || source.startsWith("(?<=", i) ? "=" : source.startsWith("(?!", i) || source.startsWith("(?<!", i) ? "!" : "";
      i = look ? source.indexOf(look, i) + 1 : source.startsWith("(?:", i) ? i + 3 : source.startsWith("(?<", i) ? source.indexOf(">", i) + 1 : i + 1;
      const inner = disjunction();
      i++;
      return look === "=" ? { exact: [""], some: best(inner) } : look === "!" ? EMPTY : inner;
    }
    if (c === "\\") {
      const e = source[i + 1];
      i += 2;
      if (e === "b" || e === "B") return EMPTY;
      if ("dDsSwW".includes(e)) return ANY;
      if (e === "p" || e === "P" || e === "k") {
        i = source.indexOf(e === "k" ? ">" : "}", i) + 1;
        return ANY;
      }
      if (e >= "1" && e <= "9") {
        while (source[i] >= "0" && source[i] <= "9") i++;
        return ANY;
      }
      return { exact: [escaped(e)], some: null };
    }
    const ch = String.fromCodePoint(source.codePointAt(i)!);
    i += ch.length;
    return { exact: [ch], some: null };
  };
  const term = (): Piece => {
    PLAIN.lastIndex = i;
    const plain = PLAIN.exec(source);
    if (plain) {
      i += plain[0].length;
      return { exact: [plain[0]], some: null };
    }
    const piece = atom();
    let min = 0;
    let max = 1;
    const q = source[i];
    COUNT.lastIndex = i;
    const count = q === "{" ? COUNT.exec(source) : null;
    if (count) {
      i += count[0].length;
      min = Number(count[1]);
      max = !count[2] ? min : count[3] ? Number(count[3]) : Infinity;
    } else if (q === "*" || q === "+" || q === "?") {
      i++;
      min = q === "+" ? 1 : 0;
      max = q === "?" ? 1 : Infinity;
    } else return piece;
    if (source[i] === "?") i++;
    // The strings of each count of the piece, while they're few.
    let exact: string[] | null = piece.exact && max <= 3 ? [] : null;
    let power: string[] | null = [""];
    for (let k = 0; k <= max && exact && power; k++) {
      if (k >= min) exact = unique([...exact, ...power]);
      if (k < max) power = product(power, piece.exact!);
      if (exact.length > FEW || !power) exact = null;
    }
    return { exact, some: min >= 1 ? best(piece) : null };
  };
  const alternative = (): Piece => {
    let some: string[] | null = null;
    // What the pieces since the last one with many strings can match together.
    let run = [""];
    let whole = true;
    const close = () => {
      if (!run.includes("")) some = better(some, run);
    };
    while (i < source.length && source[i] !== "|" && source[i] !== ")") {
      const piece = term();
      some = better(some, piece.some);
      const joined = piece.exact && product(run, piece.exact);
      if (joined) run = joined;
      else {
        close();
        whole = false;
        run = piece.exact ?? [""];
      }
    }
    close();
    return { exact: whole ? run : null, some };
  };
  const disjunction = (): Piece => {
    const alts = [alternative()];
    while (source[i] === "|") {
      i++;
      alts.push(alternative());
    }
    if (alts.length === 1) return alts[0];
    const exact = alts.every((a) => a.exact) && alts.reduce((n, a) => n + a.exact!.length, 0) <= FEW ? unique(alts.flatMap((a) => a.exact!)) : null;
    const some = alts.map(best);
    return { exact, some: some.every(Boolean) ? unique(some.flatMap((s) => s!)) : null };
  };
  const whole = disjunction();
  if (i !== source.length) throw new Error(`schedule-words: pattern read to ${i} of ${source.length}`);
  return best(whole);
}

/**
 * The check before a pattern is built: one of its needs, folded, in the folded text. Null for none, or
 * for a pattern written in a way needs doesn't read (the tests read every one), which is then built.
 */
export function quickCheck(source: string): RegExp | null {
  let some: string[] | null = null;
  try {
    some = needs(source);
  } catch {
    return null;
  }
  return some && new RegExp(unique(some.map(fold)).map((s) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|"));
}

/** A table's pattern, built the first time a text passes its check. */
type Pattern = { test(s: string): boolean; all(s: string): RegExpExecArray[]; remove(s: string): string };
// The text last folded: every pattern of every table checks the same sentence.
let foldedFrom = "";
let folded = "";
function pattern({ source, flags }: Source): Pattern {
  let check: RegExp | null | undefined;
  let one: RegExp | undefined;
  let every: RegExp | undefined;
  const may = (s: string) => {
    if (check === undefined) check = quickCheck(source);
    if (!check) return true;
    if (s !== foldedFrom) [foldedFrom, folded] = [s, fold(s)];
    return check.test(folded);
  };
  const global = () => (every ??= new RegExp(source, `${flags}g`));
  return {
    test: (s) => may(s) && (one ??= new RegExp(source, flags)).test(s),
    all: (s) => (may(s) ? [...s.matchAll(global())] : []),
    remove: (s) => (may(s) ? s.replace(global(), "") : s),
  };
}

type Table = { [K in keyof Words]-?: undefined extends Words[K] ? Pattern | undefined : Pattern };
const TABLES: Table[] = Object.values(LANGUAGES).map((w) => Object.fromEntries(Object.entries(w).map(([k, p]) => [k, p && pattern(p)])) as Table);
/** Every table's patterns as written, for the tests. */
export const SCHEDULE_PATTERNS: Source[] = Object.values(LANGUAGES).flatMap((w) => Object.values(w).filter(Boolean));

const letters = (s: string) => s.replace(/[^\p{L}]/gu, "").length;

/** The sentences, a schedule on its own ("Every Monday at 8: …") joined to the one after it. */
function sentences(text: string, w: Table): string[] {
  const out: string[] = [];
  let carry = "";
  for (const piece of text.split(SENTENCE)) {
    const s = (carry ? `${carry}, ${piece}` : piece).trim();
    carry = "";
    if (!s) continue;
    if (w.recur.test(s) && letters(w.recur.remove(s)) <= 4) carry = s;
    else out.push(s);
  }
  if (carry) out.push(carry);
  return out;
}

const leads = (s: string, at: number, w: Table) => !w.lead || w.lead.test(s.slice(0, at));

/** Whether the schedule at `at` starts its part of the sentence: "every Monday, send me…", not "I go to the gym every Monday, …". */
function startsPart(s: string, at: number): boolean {
  const before = s.slice(0, at);
  let cut = 0;
  for (const m of before.matchAll(PARTS)) cut = m.index + m[0].length;
  return letters(before.slice(cut)) <= 4;
}

function asks(s: string, w: Table): boolean {
  if (w.strong) for (const m of w.strong.all(s)) if (leads(s, m.index, w)) return true;
  if (w.not?.test(s)) return false;
  const recurs = w.recur.all(s);
  if (!recurs.length) return false;
  for (const a of w.act.all(s)) {
    if (!leads(s, a.index, w)) continue;
    for (const r of recurs) {
      const [first, second] = r.index < a.index ? [r, a] : [a, r];
      const gap = s.slice(first.index + first[0].length, second.index);
      if (gap.length > NEAR || w.between?.test(gap)) continue;
      // In another part of the sentence, the schedule starts its part.
      if (PART.test(gap) && !startsPart(s, r.index)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether a message asks for something done again and again, or later, in any of the languages (a
 * message in one often has the other's words, "every day" in a Tagalog one).
 */
export function asksRecurring(whole: string): boolean {
  const text = whole.slice(0, RECURRING_CHARS).replace(QUOTED, " ");
  if (!text.trim()) return false;
  return TABLES.some((w) => sentences(text, w).some((s) => asks(s, w)));
}
