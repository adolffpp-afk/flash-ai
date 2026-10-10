import type { Engine } from "./types.ts";
import { msg } from "./i18n.ts";
import { POST_PACK_REQUEST } from "./models.ts";

// reason is marked msg("…") here and shown in the user's language with t(reason). guessed: no rule
// was sure, so the router's guess may move it (only between the engines that answer in words when
// answersOnly). about: a spoken turn after an app or deck that didn't change it, kept with the reply
// so the next follow-up can still change that build. maybe: what the rules would have made of a
// spoken turn that sounds like talk ("how do I make a website?"), which the guess may still pick.
export type RouteDecision = { engine: Engine; reason: string; guessed?: boolean; answersOnly?: boolean; about?: Engine; maybe?: Engine };

const LANGUAGES =
  "english|french|spanish|portuguese|german|italian|dutch|arabic|chinese|mandarin|japanese|korean|hindi|russian|turkish|swahili|yoruba|igbo|hausa|zulu|amharic|polish|greek|hebrew|vietnamese|thai|indonesian|creole";

type Rule = { engine: Engine; reason: string; patterns: RegExp[]; unless?: RegExp };

// Words about when, which a request for fresh information from the web holds.
const WHEN = /\b(latest|today|tonight|yesterday|this week|this month|right now|currently|current|recent|breaking)\b/i;

// Checked in order: the most specific outputs first, plain writing last.
const RULES: Rule[] = [
  {
    engine: "transcribe",
    reason: msg("You asked for a transcript."),
    patterns: [/\b(transcribe|transcription|transcript)\b/i, /\bspeech to text\b/i],
  },
  {
    engine: "translate",
    reason: msg("You asked for a translation."),
    patterns: [
      /\btranslat(e|ion)\b/i,
      new RegExp(`\\b(say|write|put|convert)\\b.{0,60}\\b(in|into|to)\\s+(${LANGUAGES})\\b`, "i"),
      new RegExp(`\\bhow do (you|i) say\\b.{0,60}\\bin\\s+(${LANGUAGES})\\b`, "i"),
    ],
  },
  {
    // Before video and app, which "with a video" or "for my website" would match too.
    engine: "image",
    reason: msg("You asked for a social post pack."),
    patterns: [POST_PACK_REQUEST],
  },
  {
    engine: "slides",
    reason: msg("You asked for a slide deck."),
    patterns: [/\b(presentation|slide ?deck|slideshow|slides|pitch deck|keynote|powerpoint)s?\b/i],
  },
  {
    engine: "app",
    reason: msg("You asked Flash to build an app."),
    patterns: [
      /\b(build|create|make|generate|design|develop|prototype|code up|spin up)\b.{0,50}\b(app|application|web ?app|website|web ?site|site|landing page|home ?page|dashboard|portfolio|game|calculator|tracker|planner|online store|shop|quiz|timer|clone|crm|saas|mvp|prototype|booking system|to-?do list)s?\b/i,
    ],
    unless: /\b(spreadsheet|excel|csv|logo|icon|poster|song|jingle|video clip)\b/i,
  },
  {
    engine: "video",
    reason: msg("You asked for a video."),
    patterns: [
      /\b(generate|create|make|produce|render|animate)\b.{0,40}\b(video|clip|animation|footage|film|reel|trailer)s?\b/i,
      /\b(video|clip|animation) of\b/i,
      /^animate\b/i,
    ],
  },
  {
    engine: "music",
    reason: msg("You asked for music."),
    patterns: [
      /\b(compose|generate|create|make|produce|write)\b.{0,40}\b(song|music|melody|beat|jingle|soundtrack|tune|instrumental|track)s?\b/i,
      /\b(song|music|beat|jingle|soundtrack) (about|for|with)\b/i,
    ],
  },
  {
    engine: "image",
    reason: msg("You asked for a picture."),
    patterns: [
      /\b(draw|paint|sketch|illustrate)\b/i,
      /\b(generate|create|make|design|give me|render)\b.{0,40}\b(image|picture|photo|illustration|logo|poster|icon|artwork|wallpaper|drawing|banner|thumbnail)s?\b/i,
      /\b(image|picture|photo|logo|poster) of\b/i,
    ],
  },
  {
    engine: "voice",
    reason: msg("You asked for spoken audio."),
    patterns: [
      /\b(read|say|speak|narrate)\b.{0,30}\b(aloud|out loud)\b/i,
      /\b(text to speech|tts|voiceover|voice over|voice-over)\b/i,
      /\b(turn|convert|make)\b.{0,40}\b(into|to|as)\b.{0,10}\b(audio|speech|voice|mp3)\b/i,
      /^(say|speak|narrate)\b/i,
      /\b(read|say|speak|narrate)\b.{0,40}\b(voice|accent)\b/i,
      /^(please\s+)?read\b.{0,30}\b(slowly|quickly|fast|calmly)\b/i,
    ],
  },
  {
    engine: "code",
    reason: msg("This is a programming task."),
    patterns: [
      /```/,
      /\b(python|javascript|typescript|java|c\+\+|c#|golang|rust|php|ruby|kotlin|swift|sql|html|css|bash|regex|react|node\.?js|django|flask)\b/i,
      /\b(code|function|script|api|endpoint|algorithm|bug|debug|stack trace|compile|refactor|unit test|program)\b/i,
    ],
  },
  {
    engine: "docs",
    reason: msg("This is document or spreadsheet work."),
    patterns: [
      /\b(spreadsheet|excel|google sheets?|csv|table|budget|invoice|pivot|formula)s?\b/i,
      /\b(resume|cv|cover letter|report|proposal|contract|memo|business plan|meeting notes|agenda|outline|template)s?\b/i,
      /\bsummari[sz]e\b.{0,30}\b(document|pdf|file|report)\b/i,
    ],
  },
  {
    engine: "search",
    reason: msg("This needs fresh information from the web."),
    patterns: [
      /https?:\/\/\S+/i,
      WHEN,
      /\b(news|price of|stock price|exchange rate|weather|score|release date|who won)\b/i,
      /\b(search|look up|google|find sources|with sources|cite|citations)\b/i,
      /\b20(2[5-9]|3\d)\b/,
    ],
  },
];

const AUDIO_TYPE = /^(audio|video)\//;
const SHEET_TYPE = /(csv|spreadsheet|excel)/i;
// Photos Flash can edit.
export const EDITABLE_TYPE = /^image\/(png|jpeg|webp)$/;
// Pictures Claude can read.
const PHOTO_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const COLOUR = String.raw`(red|orange|yellow|green|blue|purple|violet|pink|black|white|gr[ae]y|brown|gold(en)?|silver|beige|teal|navy|turquoise)`;
const COMPARE = String.raw`(bigger|smaller|larger|taller|wider|narrower|closer|thinner|thicker|slimmer|cuter|scarier|creepier|happier|sadder|angrier|funnier|prettier|sharper|softer|simpler|cleaner|bolder|calmer|brighter|darker|lighter|warmer|cooler|older|younger)`;
// Questions about a photo, which the writing model answers: "how did you make it", "did you add a
// hat", "can I use it as my profile picture". "How about at sunset" and "do it red" are asks.
const ABOUT_PHOTO = new RegExp(
  String.raw`^\s*((wait|so|but|and|also|btw|hey|sorry|ok(ay)?|hmm+|um+|uh+|lol|haha|omg|oh|ah|yo|wow|really|honestly|seriously|quick question|out of curiosity|just curious)[,.!:]*\s+)*(what|who|where|why|which|when|how(?! about\b| to (make|turn|add|remove|change|put|give)\b)|describe|explain|tell me|((can|could|would) you )?(tell|explain|describe|show) me (what|which|how|why|who|the)|read|is|isn'?t|are|aren'?t|was|wasn'?t|were|did|didn'?t|does|doesn'?t|do(?! (it|this|him|her|them)\b)(?! (an?|one) (\w+ ){0,2}(version|look)\b)(?! the \w+ (in |a bit |more |less )?(${COLOUR}|${COMPARE})\b)|(has|have|had) (you|he|she|they|it|this|that)( ever| already| just)? (been|\w+ed|got|made|done|seen|drawn|taken|used|tried)|am i|(can|could|may|should|shall) (i|we) (use|print|sell|share|download|save|post|set|keep|copy|buy|wear|put (it|this|that) (on|as|in) my)|would (this|it|that) (work|look|be(?! (possible|able)\b))|will (it|this|that|he|she|they))\b`,
  "i",
);

// Words shared by the change patterns below.
// How a short follow-up may open: "ok", "perfect, now", "same but".
const LEAD = String.raw`^\s*((ok(ay)?|great|perfect|nice|good|cool|love it|awesome|amazing|close|almost|not bad|yes|yeah|yep|wow|lovely|beautiful|no|nope|nah|hmm+)(\s*[,.!]+\s*|\s+(?=(now|but|and|then|just|only|same)\b)))*((now|and|also|but|then|just|only|plus|same( thing| image| picture| pic| one)?,? but)\s+)?((the )?same( thing| one)?\s+)?((maybe|perhaps|try|try it|let'?s try|let'?s try it)\s+)?`;
// Where the picture can be moved: "at night", "in winter", "on a beach".
const SCENE = String.raw`(at (night|dawn|dusk|sunset|sunrise|noon|midnight|golden hour|christmas|halloween)|in (the |an? )?(winter|summer|autumn|fall|spring|snow|snowstorm|rain|storm|fog|mist|dark|morning|afternoon|evening|desert|forest|woods|jungle|rainforest|mountains|ocean|sea|space|city|countryside|moonlight|sunshine|cafe|café|coffee shop|restaurant|kitchen|living room|bedroom|garden|park|field|meadow|castle|palace|temple|cave|volcano|galaxy|spaceship|studio|stadium|museum|village|farm|lake|river|waterfall|canyon|arctic|clouds)|in (paris|london|tokyo|new york|rome|venice|dubai|italy|japan|france|greece|hawaii|iceland|bali|mexico|las vegas|times square|santorini|the alps)|(on|at) (a |the )?(beach|moon|mountain|boat|street|island|rooftop|roof|stage|mars|red carpet|runway|lake|pool|ship|yacht|bridge|balcony|cliff|hill|throne)|under ?water|during (the )?(day|night|sunset|sunrise|golden hour|a storm|winter|summer)|in front of (an?|the) \w+( \w+)?)`;
// Not when something else is asked for: "a poem instead", "also a question". It reads to the end of
// the message, so it goes right after a ^, where it runs once.
const NOT_ABOUT_IT = String.raw`(?![\s\S]*\b(poem|story|caption|description|essay|song|music|sound|audio|voice ?over|narration|soundtrack|beat|jingle|video|website|site|app|joke|summary|title|text|email|post|tweet|name|slogan|tagline|question|thought|idea|note|request|suggestion|reply|answer|message|recipe|haiku|limerick|bio|backstory|list|prompt|fact|bullet points?|lyric|pun)s?\b)`;
// A part of the picture: "the sky", "his hat".
const PART = String.raw`(the (?!(file|download|price|cost|credits?|image|picture|photo|pic|resolution|quality|logo|receipt|total|bill|answer|meeting|room|temperature|mold|mould|mildew|stains?|rust|ants|bugs|pests|weeds|smell|odou?r)\b)\w+|his \w+|her \w+|their \w+|its \w+)`;

// Asking for a change, in the everyday words people use with ChatGPT: "give him sunglasses",
// "fix the lighting", "he should be wearing a suit", "at night", "can the sky be pink".
const CHANGE_PARTS = [
  // Not the same words as nouns in praise: "great edit!", "love the crop".
  String.raw`(?<!\b(the|this|that|your|nice|great|good|cool|amazing|perfect|awesome|lovely|beautiful|best|subtle|clean|superb|excellent|solid|sick|brilliant|fantastic|wonderful|incredible|neat|sweet|stunning|clever|seamless|flawless|impressive|epic|background|colou?r|bg)\s)\b(edit|retouch|photoshop|remove|erase|replace|swap|add(?!(\s+(these|those|them|it|this|that|everything|all|of|the|my|numbers|prices|amounts|totals?|items|costs|figures|bills?)){0,4}\s+up\b)|put|place(?= (it|him|her|them|me|us|an?|the|some|my|his|their)\b)(?! (an?|the|my|your) (order|bet|call|bid|hold|reservation|booking)\b)|change(?! of (plans?|heart|mind|subject|topic)\b)|transform|convert|restore|colou?ri[sz]e|recolou?r|enhance|upscale|sharpen|blur|brighten|darken|lighten|relight|crop(?= (it|this|that|out|to|into|in|the|him|her|them|me|us|my|his|their)\b|[\s.!]*$)|zoom (in|out)|dye)\b(?!\s+(is|was|looks?|looked|turned|came|worked|job)\b)|\bdelete (?=(the|his|her|their|its|that|those|this|these|all|everything|him|them|me|us|my)\b)(?!(this|that|the|these|those|my) (account|app|email|e-?mail|message|file|folder|post|comment|chat|history|data|profile|contact|number|cache|cookies|page|tab|window)s?\b)`,
  String.raw`\bfix (the|its|his|her|their) (lighting|light|colou?rs?|exposure|contrast|white balance|red ?eyes?|shadows?|glare|blur|skin|teeth|hair|background|hands?|fingers?|faces?|eyes?|feet|foot|arms?|legs?|smile|mouth|nose|ears?|anatomy|proportions|perspective)\b(?! on\b)`,
  String.raw`\bfix (this|the|my) (photo|picture|image|pic|selfie)\b`,
  String.raw`\b(turn|make) (it|this|that|us|them|him|her|the)\b`,
  String.raw`\b(turn|make) (me|my|his|their)\b(?! (day|week|night|life|laugh|feel|essay|reply|answer|message|email|text|notes?|homework|assignment|cv|resume|bio|caption|post|story|poem|speech|code|paragraph|tweet|argument|letter|writing|sentences?|words|summary)\b)`,
  // A picture made from it: "a poster from this", but not "flashcards from this".
  String.raw`\b(make|create|turn|design)\b[\s\S]{0,30}\b(poster|flyer|banner|sticker|logo|card|cover|thumbnail|wallpaper|meme|painting|drawing|sketch|cartoon|portrait|avatar|icon|emoji|picture|image|photo|pic|illustration|artwork|collage|headshot|design|print|mockup)s?\b[\s\S]{0,20}\b(from|out of|using|based on) (it|this|that|the (picture|image|photo|pic))\b`,
  // Several photos made into one: "combine these", "me and my dog together on a beach".
  String.raw`\b(combine|merge|blend|in (one|the same) (photo|picture|image|scene|shot))\b|^(?![\s\S]*\b(caption|write|post|poem|story|message|wish)\b)[\s\S]*?\b(me|us|him|her|them|i) and (me|my|his|her|their|the|our|this|that) \w+( \w+)? together (at|on|in|under|by|near|next to|in front of)\b`,
  String.raw`(?<!\b((should|shall|can|could|may) (i|we)|(want|wanted|going|plan|planning|like) to) )\bgive (him|her|them|the (?!(total|answer|sum|amount|result|price|link|prompt|caption)\b)\w+)\b(?!\s+([\w']+ ){0,2}(name|nickname|title|backstory|story|reply|response|answer|feedback|advice|tip|idea|caption|description|slogan|score|rating|grade|hug|call|chance|break|minute|refund|discount|compliment|no)s?\b(?! tag))`,
  String.raw`\bgive (it|this|that) (a|an|some|more) (\w+ ){0,2}(look|feel|vibe|style|effect|glow|tint|border|frame|background|makeover|filter|touch|twist|shadow|texture|finish|colou?rs?|tone|mood|atmosphere|sky)\b`,
  String.raw`\blet (me|him|her|them|us) (be|have|wear|look|hold|stand|sit)\b(?! (it|your|a (copy|look|link|recipe|list)|the (file|link|prompt|original|recipe))\b)`,
  String.raw`\b(he|she|they|i|we|you|him|her|them|me|us)(( should| could| must| needs? to)( be)? (wear|wearing)| (be )?wearing)\b(?! (this|it|that|these|those)\b)|^${NOT_ABOUT_IT}\s*(now |and |also |but )?(wearing|dressed (up )?(as|in)) (a|an|some|the|his|her|their)\b|\b(him|her|them|me|us|it|be|get|got) dressed (up )?(as|in)\b|\b(he|she|they) should (be(?! (fine|ok|okay|good|alright|safe|able|there|here|home|back)\b)|have|look|wear|hold)\b|\bit should (be|look) (${COLOUR}|${COMPARE}|more|less|${SCENE}|a|an|black)\b`,
  // Short follow-ups: "more red", "a bit less busy", "ok now bigger", "without the text".
  String.raw`${LEAD}(a bit |a little |slightly |much |even |way )?((more|less) (?!(than|or|is|later|soon|tomorrow|often|please|pls|plz|info\w*|details?|about|options?|ideas?|hashtags?|emojis?|like (that|this|these|those|it|them)|of (that|this|these|those|it|them)|the)\b)[a-z]|${COMPARE}\b(?! (than|is|picture|one|version)\b)|without (?!(a doubt|you|spoilers|tax|vat|the tip|tip)\b))(?![\s\S]*\?\s*$)`,
  String.raw`${LEAD}(${SCENE} ?){1,2}(please|pls|instead|too|now|version|scene)?[\s.!]*$`,
  String.raw`${LEAD}(as (an? )?|in )?(night ?time|day ?time|sunset|sunrise|winter|summer|autumn|rainy|snowy|foggy|stormy|cloudy|sunny|realistic|photo-?realistic|hyper-?realistic|3d|b ?& ?w|monochrome|gr[ae]yscale|neon|minimalist|futuristic|retro|square|landscape|portrait|vertical|horizontal|widescreen|(9|16|4|3|2|1|21) ?: ?(9|16|4|3|2|1)|golden hour|${COLOUR})( version| style| look| scene| format| orientation| vibes?| mode| theme| background| lighting)?( please| pls| instead| too)?[\s.!]*$`,
  String.raw`^${NOT_ABOUT_IT}${LEAD}with ((a|an|some|more|his|her|their|no|two|three|four|\d+) \w+( \w+)?|snow|rain|fog|sunglasses|glasses|flowers|stars|fireworks|wings|lights)( too| on (it|him|her|top)| please)?[\s.!]*$`,
  String.raw`^\s*(and|plus|also)\s+${NOT_ABOUT_IT}(an?|some|more|two|three|\d+)\s+(?!more\b|ones?\b|others?\b)\w+( \w+)?( too| please)?[\s.!]*$`,
  String.raw`^${NOT_ABOUT_IT}${LEAD}(use |try |make it )?((an?|the|some|\d+|two|three) )?(?!(something|anything|one|other one|(the )?(first|second|other|last) one)\b)(\w+ ){0,2}instead( of (an? |the )?\w+)?[\s.!]*$`,
  String.raw`^\s*${NOT_ABOUT_IT}instead of (an? |the )?\w+,? (use |try )?(an? |the |some )?\w+[\s.!]*$`,
  // Edit verbs that need something to act on, so "move on" or "hide the chat" stay words.
  String.raw`\b(rotate|flip|mirror|invert|resize|stretch|(de)?saturate|straighten|tilt) (it|this|him|her|them|the (image|picture|photo|pic|colou?rs?))\b|\b(rotate|tilt)\b[\s\S]{0,20}\d+ ?(°|degrees?)|\bflip\b[\s\S]{0,20}\b(horizontally|vertically)\b`,
  String.raw`\b(move|shift|nudge) (?!the (meeting|appointment|call|deadline|date|event|class|session|flight|booking|reservation|payment|shift|task|item)s?\b)(it|them|him|her|the \w+|his \w+|her \w+|their \w+) (\w+ )?(left|right|up|down|higher|lower|closer|further|forward|to the (left|right|top|bottom|side|center|centre|middle|front|back|corner))\b(?![\s\S]{0,30}\b(hours?|days?|weeks?|months?|minutes?|mins?|years?|[ap]m|o'?clock|noon|tomorrow|today|tonight|(mon|tues|wednes|thurs|fri|satur|sun)day|list|queue|ranking|schedule|calendar)\b)|\bcent(er|re) (it|him|her|them|the \w+)( in the (frame|picture|image|photo|middle))?[\s.!]*$`,
  String.raw`\bhide (the|his|her|their|its) (?!(chat|conversation|project|message|history|taskbar|toolbar|sidebar|menu|bar|app|icon|notification|keyboard|cursor|tab|window|file|folder|ad|status|story|stories|post|comment|like|follower|friend|password|number|caller)s?\b)\w+|\binsert (an?|the|some|my) (?!(table|comma|row|column|line|link|page|paragraph|section|word|sentence|break|space|chart|footnote)s?\b)\w+`,
  String.raw`\b(outpaint\w*|denoise|clean (it|this) up|clean up (the|its) (background|image|picture|photo|edges?|lines?)|(expand|extend) (the|its) (background|canvas|frame|scene|sky|edges?|sides?|borders?))\b`,
  String.raw`^(?!\s*(how|should|what|why|which|best way|is there)\b)(?![\s\S]*\b(next time|screen|monitor|phone|laptop|tv|camera|settings?|fan)\b)[\s\S]*\b(increase|reduce|boost|lower|raise|adjust|tweak|turn (up|down))\b[\s\S]{0,15}\b(brightness|contrast|saturation|exposure|noise|grain|sharpness|vibrance|highlights|shadows|warmth|glow)\b`,
  String.raw`\b(dress|clothe) (him|her|them|me|us|the \w+)\b|\b(open|close|shut) (his|her|their|its|the \w+) (eyes|mouth)\b`,
  String.raw`\b(have|show) (him|her|them|it|the \w+) ((?!(some|any|every|no)thing\b|working\b)\w+ing|hold|wear|sit|stand|smile|look|wave|jump|run|ride|eat|drink|play)\b|\bshow (it|him|her|them) (at|in|during|under) (night|nighttime|daytime|sunset|sunrise|dusk|dawn|winter|summer|autumn|fall|spring|the (rain|snow|fog|dark|sun|moonlight|morning|evening|night))\b`,
  String.raw`\b(get rid of|take (off|out|away)) (the|his|her|their|its|that|those|this|these|all)\b(?<!\b(this|these|that|those))(?! (\w+ )?(lid|battery|batteries|screws?|sim( card)?)\b)|\b(get rid of|take (off|out|away)) (this|these|that|those)\b(?! (\w+ )?(mold|mould|mildew|stains?|rust|ants?|bugs?|pests?|weeds?|flies|fleas?|ticks?|lice|mice|rats?|roaches|cockroaches|termites?|wasps?|moss|limescale|acne|pimples?|rash|warts?|smell|odou?r|lid|battery|batteries|screws?|one)\b)|^(?![\s\S]*\b(which|what) colou?rs?\b)[\s\S]*?\b(colou?r|paint|tint|smooth( out)?|whiten) (it|them|him|her|the|his|their|its|that|those|these|all)\b`,
  String.raw`\b(draw|paint|sketch|stick|slap)\b[\s\S]{0,40}\bon (him|them|it|her(?! (?!please\b)[a-z]))\b|\b(draw|paint|sketch|stick|slap) (a |an |some )?\w+ on (his|her|their|its) (face|head|lips?|nose|cheeks?|chin|forehead|shirt|chest|neck)\b`,
  String.raw`\b(make|put|draw|paint|add) (an?|another|some|more|\d+) \w+( \w+)? (in|on|behind|next to|beside|above|below|under|at) (the|his|her|their|its) (background|foreground|sky|corner|left|right|top|bottom|middle|center|centre|table|wall|floor|ground|hand|head)\b`,
  // Wishes and complaints: "can the sky be pink", "I'd like the dog bigger", "how about at sunset", "too dark".
  String.raw`^\s*(can|could)( you)?( please)? (${PART}|he|she|they) (be (?=(a bit |a little |much |even )?(${COLOUR}|${COMPARE}|more|less|${SCENE}|in (black and white|colou?r)|wearing|holding|smiling|sitting|standing|an? (?!(sign|symptom|problem|issue|scam|fake|risk|mistake|real|actual)\b)\w+(?![\s\S]*\?\s*$))\b)|look|wear|hold(?! (up to|about|around|over|more than|much|the weight|weight|an? (tv|television|person|adult|child|kid|car|truck))\b| \d)|smile|laugh|grin|wink)\b(?!\s+(\w+ed|used|sold|seen|made|done|bought|shown|been|my|your|our|friends?|real|sick|ok|okay|safe|fine)\b)`,
  String.raw`^\s*(can|could)( you)? (it|this|that|${PART}|he|she|they) be (removed|changed|replaced|blurred|moved|recolou?red|gone|${COMPARE}(?! than\b)|more|less|${COLOUR}|in (black and white|colou?r|${COLOUR}))\b(?![\s\S]*\b(because|due to|than|serious|dangerous|expensive|cheaper|normal|infected|likely|common|painful|severe|sign|symptom)\b)`,
  String.raw`^(?![\s\S]*(\?\s*$|\b(how|who|where|what|which|buy|cost|price|quote|call|hire)\b))[\s\S]*?\b(i|we)('d| would)? (want|need|like|prefer|wanna) (him|her|them|${PART}) to (have (an? |some |the )?\w+ (on|in)\b|wear|hold|smile|stand|sit|look|be (a bit |a little |much |more |less )?(${COLOUR}|${COMPARE}|\w+ing))\b`,
  String.raw`\b(i|we)('d| would)? (want|need|like|prefer|wanna) (it|this|that) to (be|look) (a bit |a little |much |even )?(${COMPARE}|more|less|${COLOUR}|black and white)\b`,
  String.raw`^(?![\s\S]*(\?\s*$|\b(how|who|where|what|which|buy|cost|price|quote|call|hire)\b))[\s\S]*?\b(i|we)('d| would)? (want|need|like|prefer) ${PART}( \w+)? (removed|gone|changed|replaced|${COLOUR}|${COMPARE})\b`,
  String.raw`${LEAD}how about (making|adding|putting|giving|changing|turning|removing|at (sunset|sunrise|night|dawn|dusk)|in (the |a )?(snow|rain|winter|summer|autumn|fall|spring|space|paris|forest|city|desert|ocean)|on (a |the )?(beach|mountain|boat|moon)|(an? |some )?(${COLOUR}|${COMPARE}))\b`,
  String.raw`^(?![\s\S]*(\b(file|size|upload|download|attachment|omg|can'?t|cannot|diet|vet|worried)\b|\?\s*$|\b(how|what|why|which) |\b(u|you|ya) think\b|\bor (ok|okay|fine|not|no|nah|good)\b|\bbut (i (still )?(love|like|don't mind|can live with)|i'll keep|i will keep|whatever|it's (fine|ok|okay))\b|\balmost too\b))[\s\S]*\btoo (dark|bright|light|dim|small|big|large|busy|cluttered|plain|dull|saturated|colou?rful|${COLOUR}|cartoon\w*|realistic|blurry|grainy|noisy|zoomed in|close|far|scary|creepy|childish|fake|wide|narrow|tall|bland|washed out|harsh|cold|serious|old|young|stiff|plastic|shiny|ai|generic|empty|crowded)\b(?! (to|for (me|us))\b)|^(?![\s\S]*(\?\s*$|\b(how|what|why|which) ))[\s\S]*\btoo (much (${COLOUR}|going on|stuff|clutter|detail|contrast|saturation|shadow|glare|noise|grain|blur|smoke|fog|makeup)|many (people|things|objects|details|trees|clouds|birds|animals|fingers|colou?rs|elements))\b`,
  // Wrong words in the picture: "it should say Happy Birthday", "write Bakery on the sign".
  String.raw`\b(it|that|(the )?(text|sign|title|words?|writing|lettering|label|banner)) should (say|read|spell)\b|\bwrite\b(?! (something|anything|a (\w+ )?(message|note|poem|wish|verse|quote|letter)|some (\w+ )?(words|message|wishes))\b)[\s\S]{0,40}\bon (the|his|her|their|its) (shirt|t-?shirt|sign|cake|banner|wall|card|mug|cup|hat|cap|board|poster|label|bottle|forehead|sky|top|bottom)\b`,
  // "Do it red", "now do it in winter", "do a pixar version", and common typos.
  String.raw`${LEAD}(pls |please |can you |could you )?do (it|this|him|her|them|the \w+) (in |a bit |more |less )?(${COLOUR}|${COMPARE}|night|winter|black and white)\b|${LEAD}(pls |please )?do (an? |one )(\w+ ){0,2}(version|look)\b`,
  String.raw`\b(chnage|chage|cahnge|remov|remvoe|rmove|backround|backgroud|backgound|backgorund|bakground)\b`,
  String.raw`^(?![\s\S]*\b(poem|story|caption|essay|song|music|beat|video|website|site|app|slides?|email|letter|reply|answer|message|tone|wording|intro|ending|summary|code|function|weather|water|plan|number|margin|headline|heading|column|row|table|chart|graph|spacing|paragraph|sentence|word|font|box|shipping|mail\w*|postage|complain\w*|refund|return|order\w*|sent|deliver\w*|seller|store|shop|amazon|package|parcel)s?\b)[\s\S]*?(^\s*|\b(it|this|that|${PART}) )(still )?(should|needs? to|has to) (be|look) (a (bit|little|lot) |much |even |way |slightly )?(${COLOUR}\b|${COMPARE}\b(?! than)|(more|less) (${COLOUR}|vibrant|colou?rful|saturated|realistic|natural|detailed|visible)\b|in ${COLOUR}\b|black and white\b|on the (left|right|top|bottom|side)\b)`,
  String.raw`\b(${PART}|he|she|they) (should|must|needs? to|has to) (smile|wear|hold|have (an?|some) \w+ (on|in)\b)`,
  String.raw`(^\s*|\b(it|this|that|${PART}) )needs (a bit |a little |a lot |much )?(more|less) (${COLOUR}|contrast|light|lighting|colou?r|saturation|detail|shadows?|brightness|depth|glow|warmth|drama|texture|sharpness)\b|\bgive (it|this|that) (a bit |a little )?(more|less) (contrast|light|lighting|saturation|detail|depth|warmth|brightness|drama|colou?r|glow|shadows?|sharpness)\b`,
  String.raw`^(?![\s\S]*\b(website|site|app|price|total|answer|email|essay|reply|message|complain\w*|refund|return|order\w*|sent|deliver\w*|seller|store|shop|amazon|package|parcel)s?\b)[\s\S]*?(^\s*(want|need)|\b(i|we) (want|need|wanna)|\b(i|we)('d| would) (like|love|prefer|want|need)) (it|this|that|him|her|them|${PART}) (a (bit|little|lot) |much |even |way |slightly )?(${COMPARE}\b(?! than)|(more|less) (${COLOUR}|vibrant|colou?rful|saturated|realistic|natural|detailed)\b|${COLOUR}\b|in ${COLOUR}\b|black and white\b|(?!(in|on|at) (the |a |an )?(morning|afternoon|evening|office|party|wedding|concert|festival|train)\b)${SCENE}|in (\d+ ?: ?\d+|square|portrait|landscape|vertical|horizontal)\b|(square|vertical|horizontal)\b)`,
  String.raw`\b(i|we)('d| would)? (want|need|like|love|prefer|rather have) (an? |some )?((${COLOUR}|plain|simple|blurr?y|blurred|beach|city|forest|sunset|night|space|studio|gradient|darker|lighter|brighter) ){1,2}(background|backdrop|sky)\b`,
  String.raw`\b(i|we)('d| would)? (want|like|love|need) (an? |some )?\w+( \w+)? on (him|her|them)\b(?! (?!please\b)[a-z])`,
  String.raw`\b(i wish|it would be (nice|cool|better|great) if|it'?d be (nice|cool|better|great) if) (it|this|that|${PART}|he|she|they) (was|were|looked) (a (bit|little|lot) |much |even )?(${COLOUR}\b|${COMPARE}\b(?! than)|(more|less) (${COLOUR}|vibrant|colou?rful|realistic)\b|in ${COLOUR}\b|${SCENE})`,
  String.raw`${LEAD}(please |pls )?(zoom(ed)?[ -]?(in|out)( (a bit|a little|more))?|pan (\w+ )?(left|right|up|down|to the (left|right))|(from|at) (above|below|behind|the (side|front|back|top|left|right)|an? (\w+ )?angle|eye level)|(an? )?(full|whole)[ -]body( shot| view| photo| picture| portrait)?|(an? )?(extreme )?close[ -]?up( shot| view)?( (of|on) (the|his|her|their|its) \w+)?|(an? )?(top[ -]?down|overhead|aerial|bird'?s[ -]eye|low[ -]angle|high[ -]angle|wide[ -]angle)( view| shot)?|(an? )?(side|front|back|rear|profile|three[ -]quarter) (view|shot|angle)|(step|pull) back( a (bit|little))?|(further|farther) (away|back)|show (the |his |her |their )?(whole|full|entire) (body|person|man|woman|dog|cat|car|house|building|scene|character|figure|outfit)|show (it|him|her|them) from (above|below|behind|the (side|front|back))|show more of (the|his|her|their) (background|scene|sky|room|body|landscape|city|street|beach|surroundings))( please| pls| instead| too)?[\s.!]*$`,
  String.raw`${LEAD}(make it |do an? |an? )?(christmas|xmas|halloween|easter|valentine'?s( day)?|thanksgiving|holiday|festive|spooky|summer|winter|autumn|fall|spring)( version| theme| themed| edition| vibes?| style| look)( please| pls| instead| too)?[\s.!]*$`,
  String.raw`^${NOT_ABOUT_IT}${LEAD}with (the )?\w+( \w+)? (in the background|behind (him|her|them|it))( please| pls| too)?[\s.!]*$|${LEAD}(the |an? )?\w+( \w+)? in the background( please| pls| too)?[\s.!]*$`,
  String.raw`${LEAD}(as|like) (an? )?(baby|kid|child|toddler|teen(ager)?|old (man|woman|lady)|grandpa|grandma|superhero|astronaut|pirate|knight|princess|prince|king|queen|zombie|vampire|robot|cyborg|wizard|witch|elf|viking|samurai|ninja|cowboy|sticker|cartoon character|lego (figure|minifigure)|action figure|funko pop|statue|plushie|toy)( version)?( please| pls| instead| too)?[\s.!]*$`,
  String.raw`${LEAD}(no|without any) (more )?(hats?|people|person|humans?|crowd|cars?|clouds?|text|words|writing|letters|lettering|watermark|logo|signature|background|bg|beard|mustache|moustache|glasses|sunglasses|shadows?|reflections?|trees?|birds?|animals?|dogs?|cats?|buildings?|smoke|fog|rain|snow|stars|filter|border|frame|blur|grain|noise|wrinkles|tattoos?|makeup|jewelry|earrings|wings|horns|flowers|clutter|vignette|lens flare|extra \w+)( (in|on) (it|the (background|picture|image|sky)))?( please| pls| at all)?[\s.!]*$`,
  String.raw`${LEAD}(the )?(${COLOUR}|pastel|neon|muted|blonde?|curly|straight|wavy|longer|shorter|clear|starry)( and \w+)? (hair|eyes|dress|shirt|t-?shirt|jacket|coat|hat|cap|car|sky|background|bg|backdrop|lighting|light|tones?|colou?rs|palette|walls?|fur|lips|shoes|suit|tie|scarf|balloons?|roses|flowers)( please| pls| instead| too| now)?[\s.!]*$`,
  String.raw`${LEAD}with (${COLOUR}|curly|blonde?|long|short|longer|shorter) (hair|eyes|fur|wings|flowers|roses|balloons|lights)( please| pls| too)?[\s.!]*$`,
  String.raw`\btake (the|his|her|their|its|that|those|this|these) (?!(day|days|week|weekend|night|morning|afternoon|evening|rest|time|test|exam|money|cash|trash|garbage|bins?|call|lead|kids|car|tax|tip|discount|fees?|vat|charges?|drinks|costs?|total)\b)\w+( \w+)? (off|out|away)\b(?! for\b)|\b(lose|ditch) (the|his|her|their|that|those) (?!(weight|game|bet|match|plot|attitude|argument|deal|plan|job|habit|subject|topic|account|password|price|tone|ending|intro|title|text|email|essay|code)\b)\w+|\bshave (off )?(his|her|their|the) \w+|\b(throw in|surround (it|him|her|them) with) |\b(cartoon|anime|ghibli|pixar)(ify|ize|ise)\b`,
  String.raw`^(?![\s\S]*\b(yourself|myself|on (my|your) own|by hand)\b)[\s\S]*?\b(would you mind|do you mind|try|can you try|could you try|let'?s try|maybe try) (making (it|this|that|him|her|them|the \w+)|turning (it|this|that|him|her|them)|adding (an?|some|more) \w+|putting (an?|some|the|him|her|them|it)\b|giving (it|him|her|them)|changing (the|its|his|her|their)|removing (the|his|her|its|their|that|those)|replacing (the|his|her|its)|swapping (the|his|her|its)|zooming (in|out)|cropping (it|the))\b`,
  String.raw`\byou (forgot|left out|didn'?t (add|include|put|remove|change)) (to (add|put|remove|change|include) )?(the|his|her|their|its|an?) (?!(link|attachment|caption|question|answer|file|download|price|total|tip|tax|name|text|title|message|reply|email|deadline|meeting|password|date|time|point|rules?|context|instructions?|details?|prompt)\b)\w+|^\s*((no|nope)[,.!]* )?(but )?(i|we) (said|asked for|wanted|meant)( an?| the| it)? ((${COLOUR}|black and white|${SCENE})( (?!one\b)\w+)?|${COMPARE})( not \w+)?[\s.!]*$`,
  String.raw`\bzo?om-?(in|out)\b|\bzom (in|out)\b|\bmak (it|this|him|her|them|the)\b|\b(chang|chane|cange|chnge|chnag|chagne|chanhe|chnage) (the|it|his|her|their|its|to)\b|\b(remoce|remvoe|remive|reomve|remoev|rmeove|removethe)\b`,
  String.raw`^\s*(pls |please )?make (more |less )?(${COLOUR}|dark|bright|light|big|small|realistic|photo-?realistic|colou?rful|vibrant|detailed|${COMPARE}|black and white)( please| pls)?[\s.!]*$|\bmake (the )?(background|bg|backdrop|sky) (${COLOUR}|${COMPARE}|transparent|blurr?y|blurred)\b`,
  String.raw`${LEAD}(the )?(background|bg|backdrop) (to |=|: ?)?(${COLOUR}|transparent|blurr?y|blurred|remove[d]?|gone|beach|city|forest|space|sunset|night|studio|plain|gradient)( please| pls)?[\s.!]*$`,
  String.raw`${LEAD}(smiling|laughing|grinning|winking|frowning|eyes (open|closed)|mouth (open|closed)|looking at the camera|facing (the camera|left|right|forward))( please| pls| instead| too)?[\s.!]*$`,
  String.raw`^(?![\s\S]*\b(clock|watch)\b)[\s\S]*?\b(hands?|fingers?|face|eyes|arms?|legs?|feet|teeth|anatomy)\b[\s\S]{0,40}\b(weird|wrong|off|messed up|deformed|creepy|strange|extra)\b[\s\S]{0,20}\b(fix|correct)\b|\bfix (the|his|her|their|its) (extra|missing|weird|wrong|deformed|messed[ -]up|sixth|third) \w+|\b(extra|sixth|six|6|third|three|3) (fingers?|arms?|legs?|eyes|hands?|tails?)\b[\s\S]{0,30}\bfix\b`,
];
// Each part is a pattern of its own: joined into one, they'd be too long for the regex engine to
// optimize, and a long message would take most of a second to check.
function anyOf(parts: string[]): { test: (text: string) => boolean } {
  const patterns = parts.map((part) => new RegExp(part, "i"));
  return { test: (text) => patterns.some((pattern) => pattern.test(text)) };
}

// Style words: with a photo attached on purpose they ask for a change ("anime", "background"); after
// a picture Flash made, on their own they're a compliment ("love the background").
const STYLE_WORDS = String.raw`(?<!\b(love|loving|like|nice|great|cool|so|such|beautiful|gorgeous|amazing|my|our)( the| a| an| that| this)? )\b(background|cartoon\w*|anime|pixar|ghibli|sketch|painting|watercolou?r|oil paint\w*|pencil drawing|comic book|pixel art|black (and|&) white|sepia|vintage look|cinematic|style|filter|headshot|passport photo|profile (picture|photo)|brighter|darker|(older|younger)(?! (or|and|than|brother|sister|siblings?|sons?|daughters?|kids?|children|child|cousins?)\b))\b`;
// A style on its own still asks for it: "pixar style", "in watercolour", "in the style of van gogh".
const STYLE_ONLY =
  /^\s*(now |and |but |ok,? )?((in |as |into |like )?(an? )?(cartoon|anime|pixar|disney|dreamworks|simpsons|ghibli|studio ghibli|sketch|pencil sketch|charcoal( drawing)?|line art|watercolou?r|oil painting|pencil drawing|comic( book)?|manga|pixel art|black (and|&) white|sepia|cinematic|vintage|retro|polaroid|film noir|noir|claymation|lego|minecraft|low poly|origami|stained glass|ukiyo-?e|cyberpunk|steampunk|vaporwave|synthwave|pop art|art deco|graffiti|chibi|(19)?\d0'?s|real photo)( style| version| look| lighting| vibes?| aesthetic)?|(like|as|into) (an? )?painting|in the style of (an? )?[\w' .-]{2,40})(,? please)?\s*[.!]*\s*$/i;
// Asking to change an attached photo, rather than asking about it.
const EDIT_REQUEST = anyOf([...CHANGE_PARTS, STYLE_WORDS, STYLE_ONLY.source]);
// Asking to change the picture above: the same, without a style word on its own.
const CHANGE_ASK = anyOf(CHANGE_PARTS);
// Fixing the garbled words in a picture Flash made. Only after one: with an essay attached, "fix
// the text" means the essay.
const FIX_PICTURE_TEXT =
  /^\s*(pls |please |can you |could you )?(fix|correct) (the|its) (text|spelling|typos?|words?|letters?|lettering|writing|sign|title)( please)?[\s.!]*$|^\s*(the )?(spelling|text|words?|sign|title|lettering|writing) (is|are|looks?) (wrong|off|misspelled|gibberish|garbled|messed up)\b[\s\S]{0,60}$|^\s*(please )?spell (it|the \w+) (correctly|right)[\s.!]*$|^(?![\s\S]*\b(error|fail\w*|loading|invalid|insufficient|unavailable|not found|went wrong|credits?|download\w*|upload\w*|\d{3})\b)\s*(it|the (sign|text|title|banner|cake|shirt|label)) (says|reads|spells) [\s\S]{1,60}\b(fix|correct|should (say|be|read))\b|\b(you )?(spelled|spelt|misspelled|misspelt|wrote) (my name|it|the (name|word|text|title)) wrong\b|^\s*(the )?name (is|was) (wrong|misspelled|misspelt)([\s.!]*$|,? (it|its|it's|it should)\b)/i;
// Asking for advice or an opinion, which is words: "suggest a hairstyle", "what do you think".
const ADVICE = /\b(suggest\w*|recommend\w*|ideas|advice|tips|rate (it|this|me|my)|thoughts|opinion|what do you think|suit me|be honest|good enough|acceptable|check (if|whether)|guess (my|his|her|their) age)\b/i;
// Unless the message opens by asking for the change: "change the background to whatever you suggest".
const ASKS_EDIT = /^\s*(please |can you |could you |now |ok,? )?(edit|retouch|remove|erase|delete|replace|swap|add|put|place|change|make|turn|fix|crop|dye)\b/i;
// Something else made from the picture, which a writing or music engine makes: "turn it into a song".
const OTHER_OUTPUT =
  /\b(into|to|as|it|this|that) (an? |the |some )?([\w']+ )?(song|music|tune|jingle|rap|lyrics|poem|haiku|story|stories|riddle|joke|tweet|caption|essay|email|letter|speech|podcast|audiobook|game|recipe|shopping list|quiz|flashcards?|summary|words|sentence)s?\b(?=\s*([.!?,]|$|(about|for|with|of|that|which|in|please)\b))/i;
// Doing something with the picture rather than changing it: deleting it, a file format, hashtags.
const NOT_A_CHANGE = new RegExp(
  [
    String.raw`^\s*(delete|remove|get rid of) (it|this|that)( (picture|image|photo|pic|one))?\s*[.!]*\s*$`,
    String.raw`\b(make|set|use|put|turn) (it|this|that) (as |into )?(my|our) (\w+ )?(wallpaper|lock ?screen|home ?screen|pfp|profile (pic|picture|photo)|avatar|portfolio|collection|album|story|feed|desktop|fridge|wall)\b|\b(change|replace|update) (my|our) (old )?(\w+ )?(wallpaper|lock ?screen|home ?screen|pfp|profile (pic|picture|photo)|avatar)\b[\s\S]{0,20}\b(to|with) (it|this|that)\b|\b(add|put|place|pin|hang|save) (it|this|that)( up)? (on|to|in|into) (my|our) (\w+ )?(portfolio|collection|album|gallery|story|feed|profile|page|blog|channel|wall|fridge|desktop|drive|folder|camera roll|photos)\b|\b(add|write) (an? |some )?(short |brief |product )?(description|bio)\b`,
    String.raw`^(?![\s\S]*\b(transparent|background|cut-?out)\b)[\s\S]*\b(convert|save|export|turn|make)\b[\s\S]{0,20}\b(a |an |as |to |into )?(pdf|png|jpe?g|svg|webp)\b`,
    String.raw`\b(hashtags?|alt text|caption for|favou?rites?|gallery|download)\b`,
    // Sharing, saving or deleting it: "put it on whatsapp", "add it to my album", "delete the last one".
    String.raw`\b(put|post|share|upload|add|place|save|send|pin|copy|move) (it|this|that|them|these|those|the (logo|picture|image|photo|pic))( (one|picture|image|photo|pic|logo))? (on|to|in|into|onto) (my |our |the |a )?(website|web ?site|site|landing page|home ?page|app|instagram|insta|ig|tiktok|facebook|fb|linkedin|etsy|ebay|whatsapp|twitter|pinterest|snapchat|story|stories|feed|album|folder|drive|google drive|dropbox|desktop|phone|camera roll|photos|portfolio|collection|project|board|profile|status|email|group( chat)?|creations|library|downloads|presentation|deck|slides?( \d+)?|zip|notes|doc|document)\b`,
    String.raw`^\s*(please |pls )?(delete|erase) (both|all( of them)?|everything|the (last|first|previous|other|old|older|second|third) (one|ones|picture|image|photo|pic|version)s?|(this|the|my) (chat|conversation|history|thread)s?)\b|\b(delete|remove|clear|erase)\b[\s\S]{0,25}\bfrom (my |the )?(history|gallery|creations|chat|library|account|favou?rites|downloads|profile|phone)\b|^\s*(please |pls )?clear (the |this |my )?(chat|conversation|history)\b`,
    // Undoing a change, which an edit of the newest picture can't do: "change it back", "make it like before".
    String.raw`^\s*(please |pls |can you |could you |just )?(undo|revert)\b|\b(change|put|turn|set|switch|make) (it|this|that|them|everything) back\b(?!\s+(in|into|on|further|farther|more|a (bit|little)|to (?!(how|the way|what|normal|before|the (original|first|previous|old|last|other))\b)))|\b(make|change|turn) (it|this|that) (back )?(look )?(like|how|the way|as) (before|(it|this|that|they) (was|were|looked)|the (original|first|previous|old|last|other))\b`,
    // Saying not to change it: "it's perfect, don't change anything", "I didn't ask you to add a hat".
    String.raw`^\s*((it's |its |that's )?(perfect|great|good|fine|nice|ok(ay)?|no|nah|nope|wait|lol|haha|love it|thanks?|thank you|beautiful|amazing|stop)[,.!]*\s+)*(please |pls |but |and |so )?(don't|dont|do not|no need to|never|i didn't|i didnt|i did not|i never|you didn't|you didnt|you did not|i don't want you to)\b(?!\s+forget\b)(?![\s\S]*\b(but|instead|just|only|rather)\b)`,
    String.raw`^\s*no (more )?(changes?|edits?)( needed| please| thanks| for now)?[\s.!,]*$`,
    // Flash's own voice in Talk, the user's account, credits and settings, and chit-chat.
    String.raw`\b(your|the|flash'?s) voice\b|\b(make|turn) (it|this|that) louder\b`,
    String.raw`\b(change|update|reset|delete|remove|cancel|verify|confirm|upgrade|downgrade|switch) (my|the) (account|password|e-?mail( address)?|username|user ?name|subscription|plan|billing|payment( method| details| info)?|settings|display name|phone number)\b|\b(remove|delete|update|change) my card\b|\bmy (credit|debit|bank) card\b|\b(add|buy|get|need|more|\d+) credits\b|\bchange my profile (picture|pic|photo) to\b|\badd a (new )?(credit |debit )?card\b|\bturn (the )?(notifications?|sound|volume|dark mode|light mode|auto-?play|captions|subtitles) (on|off)\b|^\s*(can you |could you |please |pls )?(change|switch)( back| the language)? (to|into) (${LANGUAGES})( (please|pls|thanks))?[\s.!]*$|\b(british|american) english\b|\bchange the language\b`,
    String.raw`\bchange (of|my) (plans?|topic|subject|mind)\b|\bchange the (subject|topic)\b|\b(put|make|give|show) me (know )?the (price|cost|total|answer|link|prompt|name|details?|info\w*)\b|^\s*(price|cost|credits?|how much|how many credits)\b`,
    // Music or sound, which a picture can't hold: "add some background music". Not "add music notes".
    String.raw`\b(add|put|play)\b[\s\S]{0,20}\b(music|song|sound|sounds|soundtrack|audio|narration|voice ?over|voice|beat|jingle|sound effects?|sfx)\b(?! (notes?|bars?|waves?|symbols?|icons?)\b)`,
    // Learning to do it themselves: "how to remove the background in canva", "best app to crop photos".
    String.raw`\b(in|on|with|using) (photoshop|lightroom|canva|gimp|snapseed|picsart|procreate|capcut|figma|illustrator|vsco|facetune)\b|\b(myself|by myself|on my own|teach me|tutorial|steps to|learn( how)? to)\b|(^\s*|\b(best|good|free|which|what|an?) )(app|tool|website|site|program|software)s? (to|for|that)\b`,
  ].join("|"),
  "i",
);

// Asking for a new picture after one Flash made ("another one", "draw me a dragon"), rather than a
// change to that one. A request that points back at the picture ("a poster from it") is a change.
const NEW_PICTURE = new RegExp(
  [
    // "A different one", but not "add another one" or "give her a new dress, a pink one".
    String.raw`^(?![\s\S]*\b(add|put|insert|place|include|swap|switch|give (him|her|them|it|the \w+)|(replace|change) the \w+)\b)[\s\S]*\b(new|another|different|second|separate|fresh) (\w+ ){0,2}(picture|image|photo|pic|drawing|painting|logo|poster|one|version|design)s?\b`,
    String.raw`\b(try again|regenerate|redo|re-?roll|start over|from scratch|variations?)\b`,
    String.raw`^\s*((ok|great|nice|cool|perfect|yes|love it)[,!.]* )?((some|a few|\d+) )?more like (this|that|it|these|those)\b`,
    String.raw`\bsame style,? (but|with) (a|an|some)\b|\b(a|an) \w+( \w+)? in the same style\b`,
    String.raw`\b(make|create|generate|draw|design|paint|give|do) (me |us )?another( one)?( please)?\s*[!.?]*\s*$`,
    String.raw`^\s*(\d+|a few|some) more\b|\bmore (options|versions|of (these|those|them))\b`,
    String.raw`^[\s\S]*\b(make|create|generate|draw|design|paint|give|sketch|illustrate|render) (me |us )?(a|an|some|\d+)\b(?![\s\S]*?\b(make|create|generate|draw|design|paint|give|sketch|illustrate|render) (me |us )?(a|an|some|\d+)\b)(?![\s\S]*\b((from|of|with|using|based on) (it|this|that|the (picture|image|photo|pic|one))\b|on (him|them|it|her(?! (?!please\b)[a-z]))\b|(in|on|to|into) (the|his|her|their|its) (background|foreground|corner|sky)\b))(?!\w* \w+ on (his|her|their|its) (face|head|lips?|nose|cheeks?|chin|forehead|shirt|chest|neck)\b)`,
  ].join("|"),
  "i",
);

// Engines a request goes to on its own words, whatever picture came before: "make it into a song".
const NOT_ABOUT_THE_PICTURE: Engine[] = ["app", "slides", "music", "voice", "search", "transcribe", "translate", "code"];

// A screenshot, sketch or design photo to rebuild as a working app or website, rather than a
// picture to change. Checked before the photo-editing rules, which "turn this into…" also matches.
const BUILD_FROM_PHOTO = new RegExp(
  [
    String.raw`\b(build|make|create|code|turn|convert|recreate|replicate|clone|copy|rebuild|redesign|design|develop|prototype)\b[\s\S]{0,60}\b(web ?app|application|app|web ?site|website|site|web ?page|landing page|home ?page|page|dashboard|html|working code|code|online (store|shop)|prototype)s?\b`,
    String.raw`\b(screenshot|screen shot|sketch|drawing|mock-?up|wireframe|design|figma)\b[\s\S]{0,40}\b(into|to|as)\b[\s\S]{0,30}\b(app|site|website|page|html|code)s?\b`,
  ].join("|"),
  "i",
);
// The same, for a slide deck made from what's in the picture.
const DECK_FROM_PHOTO =
  /\b(build|make|create|turn|convert|recreate|design|write|put|into)\b[\s\S]{0,40}\b(presentation|slide ?deck|slideshow|slides|pitch deck|powerpoint)s?\b/i;

// Asking for the words in a photo (a receipt, a menu, a handwritten note) as text or a spreadsheet,
// rather than to change the picture: "copy the text", "turn this into a spreadsheet", "transcribe it".
const READ_TEXT = new RegExp(
  [
    String.raw`\b(ocr|transcribe|transcription)\b`,
    String.raw`\b(read|copy|extract|type (out|up)|write (out|down)|pull( out)?|grab|scan|digiti[sz]e|list)\b[\s\S]{0,40}\b(text|words|writing|handwriting|numbers|prices|items|amounts|totals?|receipts?|notes?|menus?|pages?|documents?|letters?|tables?)\b`,
    String.raw`\b(into|to|as)\s+(an?\s+)?(spreadsheet|excel( sheet)?|google sheets?|csv|table|plain text|text|word( document)?|document|list)\b`,
    String.raw`\b(spreadsheet|excel|csv|google sheets?)\b`,
  ].join("|"),
  "i",
);

// Asking for an attached photo to move: it becomes a video. "A gif" and "a short film" move too,
// but "a movie poster" and "a film photo look" are pictures.
const MOTION = String.raw`(an? )?((short|quick|little|tiny|looping|animated|\d+[\s-]*(s|sec|second)) )?(video|clip|animation|gif|movie|short film|film)(?![\s-]+(poster|cover|still|sticker|thumbnail|noir|photo\w*|camera|grain|look|style|scene|quality|set|strip|reel|roll|frame|game|stars?|characters?|villains?|heroe?s?|heroines?|icons?|legends?|monsters?|actors?|actress(es)?|art))`;
const ANIMATE_REQUEST = new RegExp(
  String.raw`\b(animate\w*|bring (it|this|her|him|them|the \w+) to life|come alive|make (it|this|them|her|him|the \w+) (move|moving|walk|dance|talk|blink|smile and wave)|(make|turn) (it|this|them|her|him) (into )?${MOTION}|into ${MOTION}|(video|gif|clip|animation) (of|from) (it|this|him|her|them)|moving (photo|picture|image)|live photo|cinemagraph|(make|let) (it|this|him|her|them|the \w+) come to life|(add|give it|put it in|set it in) (some |a bit of |more )?(motion(?! blur)|movement|animation)|(put|set) (it|this|him|her|them) in motion|make (it|this) (loop|a loop)|(make|turn) (it|this) (into )?an? (short |instagram |tiktok )?reel)\b`,
  "i",
);

// Phones type curly apostrophes ("don’t"), which the rules above spell straight.
const straight = (message: string) => message.trim().replace(/[‘’]/g, "'");

/**
 * Whether a message, sent with nothing attached right after Flash made a picture, asks to change
 * that picture ("make it darker", "add a hat", "now put him on a beach") or to bring it to life.
 * When it does, the picture goes with the message, so it's edited the way an attached photo is.
 */
export function pictureFollowUp(message: string): boolean {
  const text = straight(message);
  if (!text || ABOUT_PHOTO.test(text) || NEW_PICTURE.test(text) || NOT_A_CHANGE.test(text)) return false;
  if (NOT_ABOUT_THE_PICTURE.includes(routeOne(text).engine)) return false;
  if (FIX_PICTURE_TEXT.test(text)) return true;
  // A style word on its own ("love the background") is a compliment, not a change.
  if (!CHANGE_ASK.test(text) && !ANIMATE_REQUEST.test(text) && !STYLE_ONLY.test(text)) return false;
  const withPicture = routeOne(text, "image/png").engine;
  return withPicture === "image" || withPicture === "video";
}

/** Whether a follow-up sent with the picture above asks to fix the words in it ("fix the spelling"). */
export const fixesPictureText = (message: string) => FIX_PICTURE_TEXT.test(straight(message));

// Engines whose answers are general enough that a follow-up may really be an edit to the last build.
const GENERAL: Engine[] = ["text", "code", "docs"];
// The engines that answer in words.
export const ANSWER_ENGINES: Engine[] = ["text", "translate", "code", "docs", "search"];

/*
 * A spoken follow-up to an app or deck asks for a change ("make the button blue", "can we add a
 * login page", "the header should be bigger", "the menu has a bug"), is talk ("thank you", "how does
 * it work?", "let's take a break"), or is unclear, when the router's guess decides. Typed follow-ups
 * always change the build, as before: the user is looking at it and typing to it.
 */
// How a spoken request may open before saying what it wants: "yeah, um, Flash, can you …", "thanks,
// now …", "looks great, but …", "wait, …". Longer phrases first, so "great job" is read as one.
const SPOKEN_OPENER = new RegExp(
  String.raw`^(?:(?:thank you(?: so much| very much)?|thanks?(?: a lot| so much)?|cheers|(?:great|good|nice|amazing|awesome) (?:job|work)|well done|good (?:morning|afternoon|evening|night)|no (?:problem|worries)|(?:i )?love it|(?:(?:it|this|that) )?looks? (?:good|great|nice|amazing|awesome|perfect|better)|(?:that's|that is|it's|it is|this is) (?:great|good|perfect|cool|nice|awesome|amazing|fine|better|beautiful|lovely)|(?:wait|hold on|hang on)(?: a (?:sec|second|minute|moment))?(?! (?:for|until|till|while)\b)|never ?mind|sorry|oops|i see(?=\s*(?:[,.!]|$)|\s+(?:now|so|and|but|then|ok(?:ay)?)\b)|yeah|yes|yep|no|nope|nah|ok(?:ay)?|alright|all right|u+m+|u+h+|h+m+|e+r+m*|oh|wow|actually|hey|flash|so|and|but|now|also|then|please|cool|great|nice|perfect|awesome|amazing|excellent|lovely|beautiful|good|well|right|just)\b[\s,.!]*)+`,
  "i",
);
// The ways of asking: "can we …", "let's …", "I'd like you to …", "I think …", "is it possible to …".
const SPOKEN_ASK =
  /^(?:(?:can|could|would|will) (?:you|we)(?: please| maybe| just| also| possibly)?|let'?s|let us|(?:i|we)(?: really)?(?: want| need|'d like| would like|'d love| would love)(?: you)? to|i think|i feel like|i guess|how about|what about|maybe|perhaps|please|just|go ahead and|(?:is|would) it be possible to|is it possible to|is there a way to|do you think (?:you|we) (?:could|can)|(?:are|were) you able to|why don'?t (?:you|we)|why not)\s+/i;
// The parts of an app or deck people name when they say what they want changed.
const PART_NAMES = String.raw`(?:button|header|footer|menu|nav(?:bar|igation)?|logo|title|heading|font|text|colou?r|background|page|section|form|layout|picture|image|photo|icon|link|sidebar|banner|slide|chart|graph|table|list|card|theme|dark mode|light mode|login|log ?in|sign ?up|contact|price|pricing|tab|field|input|search bar|map|gallery|animation|style|design|spacing|margin|padding|border|corner|width|height|home ?page|landing page|checkout|cart|dashboard|score|timer|counter|level|player|bullet|paragraph|caption|subtitle)s?`;
const BUILD_PART = String.raw`(?:${PART_NAMES}|(?:app|site|website|deck|screen)s?)`;
const NAMES_PART = new RegExp(String.raw`\b${PART_NAMES}\b`, "i");
// Verbs that ask for a change, except in the talk they're also used for ("make sense", "change of
// plans", "add it up", "move on", "make me laugh").
const STRONG_VERB = String.raw`(?:make(?! (?:sense|sure|(?:me|us) \w+)\b)|change(?! (?:of|my mind|the (?:subject|topic))\b)|add(?! (?:it |that |this |them )?up\b)|remove|delete|update|rename|replace|hide|swap|resize|cent(?:er|re)|align|edit|redo|rewrite|insert|include|fix(?! (?:me|us)\b)|move(?! (?:on|along)\b)|increase|decrease|enlarge|shrink|darken|lighten|undo|revert|restore|get rid of|bring back)`;
// Verbs that also mean other things ("put it simply", "give us a minute", "set a timer", "use it offline").
const WEAK_VERB = String.raw`(?:put|turn|use|set|show|give|switch|try|bring|let)(?!\s+(?:me|us)\b)(?!\s+(?:it|this|that) (?:simply|another way|to me)\b)(?!\s+(?:it|us|me|them) a (?:second|sec|minute|moment|break|rest|try|go|shot|thought)\b)(?!\s+(?:a|an|the|my) (?:timer|alarm|reminder)\b)`;
// A strong verb with the thing it changes, or nothing after it: "make it darker", "fix the menu",
// "undo". "Fix my …" is about the build only when a part of it is named ("fix my sleep" isn't).
const CHANGE_VERB = new RegExp(
  String.raw`^${STRONG_VERB}(?:$|\s+(?:it|this|that|these|those|the|its|their|them|everything|all|each|every)\b|\s+(?:my|our) (?:\w+ ){0,2}${BUILD_PART}\b)`,
  "i",
);
// Any of them, which ask for a change when a part of the build is named: "add a footer", "put the logo on the left".
const CHANGE_ACTION = new RegExp(String.raw`^(?:${STRONG_VERB}|${WEAK_VERB})\b`, "i");
// Looking around rather than changing: "show the chart again", "bring up the menu", "try the login".
// They change it when they say how: "show the price in euros", "turn the header green".
const LOOKS_AROUND = new RegExp(
  String.raw`^(?:show|try|bring|switch|turn|open)\b(?![\s\S]*\b(?:to|into|in|as|with|without|on|off|onto|from|instead|left|right|cent(?:er|re)|top|bottom|front|back|above|below|under|over|beside|next to|more|less|first|${COLOUR}|${COMPARE})\b)`,
  "i",
);
// Talk about Flash's voice, the user's account, or moving through the deck: "change the voice",
// "make it louder", "delete my account", "show the next slide", "turn the page".
const NOT_THE_BUILD = new RegExp(
  [
    String.raw`\b(?:your|flash'?s) (?:voice|accent)\b`,
    String.raw`^(?:change|switch|use|set|make|turn|try) (?:the|an?|another|a different) (?:\w+ )?(?:voice|accent)\b`,
    String.raw`^(?:make|turn) (?:it|this|that|yourself) (?:a (?:bit|little) )?(?:louder|quieter|softer|up|down)\b`,
    String.raw`^(?:change|update|reset|delete|cancel|remove|close|edit) (?:my|our) (?:password|account|e-?mail(?: address)?|subscription|plan|card|payment(?: method)?|billing|credits?|user ?name)\b`,
    String.raw`^(?:show|go|move|skip|jump|flip|switch|turn|take (?:me|us)|bring (?:up|me|us))(?: (?:me|us))?(?: (?:back|forward|ahead|on|over))?(?: to)? (?:the )?(?:next|previous|last|first|second|third|fourth|fifth|sixth|other|following) (?:slide|page|screen|tab|section|one)s?\b`,
    String.raw`^turn (?:over )?(?:the|a) page\b`,
  ].join("|"),
  "i",
);
// How fast it goes, which may be the build ("the game") or Flash's speech: the guess decides.
const SPEED = /^(?:make|turn) (?:it|this|that|everything) (?:a (?:bit|little) )?(?:slower|faster|quicker)\b/i;
// "Yes", "sure, go ahead": maybe agreeing to Flash's offer to change the build, which the guess reads.
const AGREES =
  /^(?:(?:yes|yeah|yep|yup|sure|definitely|absolutely|of course)(?:[\s,.!]+(?:please|do it|go ahead|let'?s do it|sounds good|go for it|thanks?|thank you))*|go ahead|do it|please do|let'?s do it|go for it)$/i;
// Said as a wish or a complaint: "the button should be blue", "I need a contact form", "it's broken".
const STATEMENT_CHANGE = new RegExp(
  [
    String.raw`^(?:the|my|our|this|that|its|their|all the) (?:\w+ ){0,2}${BUILD_PART} (?:\w+ ){0,2}(?:should|shouldn't|needs?|must|has to|have to|is too|are too|looks? too|isn't|aren't|doesn't|don't|won't|can't|is broken|are broken|has an? (?:bug|error|typo|problem|glitch))\b`,
    String.raw`^(?:it|this|that|everything|the whole thing) (?:should|needs to|must|has to) (?:be|look|have|say|show)\b`,
    String.raw`^(?:i|we)(?: really)?(?: want| need|'d like| would like|'d love| would love|'d prefer| would prefer)(?! to (?:know|see|understand|learn|ask|think|talk|go|take|try|stop|hear)\b)\b.*\b${BUILD_PART}\b`,
    // "dark mode please", "a bigger logo please"
    String.raw`^(?:an? |some |the )?(?:\w+ ){0,2}${BUILD_PART}(?: too)? please$`,
    String.raw`\b(?:it|this|that|${BUILD_PART})(?: still)?(?: doesn't| does not| don't| do not| isn't| is not| won't| can't| cannot) (?:work|load|show|open|click|respond|scroll|fit|save)\b`,
    String.raw`\b(?:it|this|that|${BUILD_PART})(?:'s| is| are| looks| seems)? (?:broken|not working)\b`,
    String.raw`\b(?:(?:it|this|that|${BUILD_PART}) (?:has|have|has got|got)|there(?:'s| is| are)) (?:a |an |some )?(?:bug|error|typo|glitch|problem)s?\b`,
    String.raw`\bnothing (?:happens|works|shows up|loads)\b|\b(?:it|this|that|${BUILD_PART}) (?:crashes|freezes|is stuck|gets stuck|is frozen)\b`,
    // "I'd like to see a bigger logo": the ask is stripped, leaving "see a bigger logo".
    String.raw`^(?:see|have|get) (?:an? |the |some )?(?:${COMPARE}|${COLOUR}|new|different|better) (?:\w+ )?${BUILD_PART}\b`,
  ].join("|"),
  "i",
);
// Talk: questions, and the requests that are about the conversation rather than the build.
const SPOKEN_TALK = new RegExp(
  [
    String.raw`^$`,
    String.raw`^(?:got it|i see|interesting|not yet|not now|that's (?:it|all)|bye|good ?bye|good ?night|see you)\b`,
    String.raw`^(?:what|why|who|whom|whose|when|where|which|how|is|are|was|were|does|did|has|have|isn't|aren't|doesn't|didn't|should|shall|am i|may i|can i|could i|do(?! (?:it|this|that|the|a|an|same|something|more|another)\b))\b`,
    String.raw`^(?:tell (?:me|us)|explain|describe|show (?:me|us|how|what)|let me|talk|say|read|repeat|stop|wait|hold on|hang on|never mind|forget it|take a (?:break|rest|look)|call it a day|go to (?:bed|sleep)|see|set (?:a|an) (?:timer|alarm|reminder)|remind me|change (?:the (?:subject|topic)|of plans|my mind)|move on|do something (?:else|different)|know|understand|learn|hear|think|i'm|i am|you're|you are|we're)\b`,
    String.raw`^(?:give (?:us|me|it) a (?:second|sec|minute|moment|break|rest|try|go|shot)|put it (?:simply|another way)|make (?:me|us) \w+)\b`,
    String.raw`^(?:i )?(?:love|like|really like|adore) (?:the|it|this|that|how|your)\b`,
  ].join("|"),
  "i",
);

// A change asked anywhere in a question or a remark: "how do I change the font?".
const ASKS_INSIDE = new RegExp(String.raw`\b${STRONG_VERB}\b[\s\S]*\b${PART_NAMES}\b`, "i");

/** What a spoken follow-up to an app or deck is: an ask for a "change", "talk", or "unclear". */
export function spokenFollowUp(message: string): "change" | "talk" | "unclear" {
  const whole = straight(message).replace(/[?!.]+$/, "").trim();
  if (AGREES.test(whole)) return "unclear";
  let said = whole;
  // Openers, and the ways of asking, as many as were said: "okay so can we just …".
  for (let before = ""; before !== said; ) {
    before = said;
    said = said.replace(SPOKEN_OPENER, "").replace(SPOKEN_ASK, "").trim();
  }
  if (NOT_THE_BUILD.test(said)) return "talk";
  if (SPEED.test(said)) return "unclear";
  if (CHANGE_VERB.test(said) || (CHANGE_ACTION.test(said) && NAMES_PART.test(said) && !LOOKS_AROUND.test(said)) || STATEMENT_CHANGE.test(said)) {
    return "change";
  }
  // A question or remark that still asks for a change is for the guess to read.
  if (SPOKEN_TALK.test(said)) return ASKS_INSIDE.test(said) ? "unclear" : "talk";
  return "unclear";
}

/*
 * Spoken turns that sound like talk but hold words the rules take for something to make: "how do I
 * make a website?", "I watched a video of a cat", "what's that song about?". A question, or the
 * speaker telling about themselves, rather than an ask ("I'd like a song", "can you draw a cat").
 */
const TALK_SHAPED = new RegExp(
  String.raw`^(?:(?:what|what's|whats|why|who|whom|whose|when|where|which|how|did|does|is|are|was|were|has|isn't|aren't|doesn't|didn't|am i|(?:do|have|had) (?:you|i|we|they)|(?:can|could|may|should|shall) i)\b|(?:i|we)(?:'m|'ve| am| was| were| have| had| like| love| liked| loved| enjoy| saw| watched| heard| listened| went| think| thought| feel| felt| used to| remember| know| wish)\b|(?:my|our) \w+)`,
  "i",
);
// What the rules make that a spoken turn may only have mentioned.
const MAKES: Engine[] = ["app", "slides", "image", "video", "music"];
// Something that changes from day to day, which "today" or "right now" asks the web about.
const FRESH =
  /\b(news|headlines?|weather|forecast|temperature|rain(ing)?|snow(ing)?|prices?|cost|stocks?|market|rates?|scores?|game|match|playing|showing|open|opening|closed|hours|schedule|traffic|release[ds]?|results?|election|events?|happening|trending|on tv|bitcoin|crypto)\b/i;
// A spoken turn the search rule only matched for a word about when ("how are you today?", "I'm tired right now").
const casualWhen = (text: string) => {
  const rest = text.replace(/\b(today|tonight|yesterday|this week|this month|right now|currently)\b/gi, "");
  const search = RULES.find((r) => r.engine === "search")!;
  return !FRESH.test(text) && !search.patterns.some((p) => p.test(rest));
};

// Words to say in quotes or after a colon (not a time's, as in 9:30).
const QUOTED = /["“][^"”]+["”]/;
const COLON_WORDS = /(?<!\d):(?!\d)\s*\S/;
// An audio file asked for by name: "as an mp3", "a voice-over", "turn this into audio".
const DELIVERABLE = /\b(voice-?\s?over|mp3|tts|text to speech|(into|to|as) (an? )?(audio|speech|recording|sound file))\b/i;
// How to say the words: "in a British accent", "in a deep voice" (not "I love your voice").
const STYLE = /(?<!\b(?:your|flash'?s) )\b(accent|voice)\b/i;
// Words that point back at something said before, which the voice engine can't read: "say that
// again in a louder voice", "read the rest of the speech aloud".
const POINTER =
  /^(?:(?:it|that|this|these|those|again|back|me|us|what you (?:just )?said)\b|(?:the|my|your|our)\s+(?:rest|last|previous|whole|full|speech|file|poem|story|answer|reply|text|message|document|page|list|email|letter|script|paragraph|notes?)\b)|\bagain\b/i;
// Only how Flash should talk: "can you speak in a lower voice", "talk slower please", "speak with a
// British accent", "use a deeper voice".
const SPEAKS_HOW =
  /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:(?:speak|talk)(?:\s+(?:a (?:bit|little)\s+)?(?:more\s+)?(?:slowly|quickly|slower|faster|louder|quieter|softer|loudly|softly|quietly|clearly|calmly|normally|up|again|(?:in|with) (?:an? |your |the )?(?:\w+ ){0,2}(?:voice|tone|accent|way)|like (?:an? )?\w+(?: \w+)?))+|(?:use|try|do|switch to|change to|put on) (?:an? |your |the )?(?:\w+ ){0,2}(?:voice|accent))(?:\s+please)?[.!?]*$/i;
// The words of a request to say or read something, with "this" kept: "read this in a British accent" points back.
const toSay = (message: string) => straight(message).replace(/^((can|could|would|will) you\s+)?(please\s+)?(say|speak|narrate|read)\s+/i, "");
/**
 * Whether a request the voice rules matched asks for an audio file: it holds the words to say (in
 * quotes or after a colon), or names an audio file or a voice to say new words in. In a voice
 * conversation "say that again in a louder voice" or "read the rest aloud" is talk, which Flash
 * answers in the conversation, so it never makes a voice-over of those words.
 */
export const wantsAudioFile = (message: string) =>
  QUOTED.test(message) ||
  COLON_WORDS.test(message) ||
  (!POINTER.test(textToSpeak(message)) &&
    !POINTER.test(toSay(message)) &&
    !SPEAKS_HOW.test(straight(message)) &&
    (DELIVERABLE.test(message) || STYLE.test(message)));

/**
 * Picks the engine for a request with deterministic keyword rules. When the previous
 * reply was an app or deck, a general follow-up ("make the header blue") edits it. Said in a voice
 * conversation (spoken), "thank you" or "how does it work?" is talk, so only a change edits it (see
 * spokenFollowUp), and only an ask for an audio file makes one: "read me the news out loud" is
 * routed as if it were asked, here to search. Spoken talk that only mentions something to make or a
 * day ("how do I make a website?", "how are you today?") is answered in words unless the guess,
 * which may still pick what the rules did, reads it as an ask.
 */
export function route(message: string, attachmentType?: string, previous?: Engine, { spoken = false } = {}): RouteDecision {
  let decision = routeOne(message, attachmentType);
  if (spoken && decision.engine === "voice" && !wantsAudioFile(message)) {
    const asked = routeOne(message, attachmentType, { skipVoice: true });
    decision = ANSWER_ENGINES.includes(asked.engine) && !asked.guessed ? asked : { engine: "text", reason: msg("Flash answers in the conversation.") };
  }
  if (spoken && !attachmentType && MAKES.includes(decision.engine) && TALK_SHAPED.test(straight(message).replace(SPOKEN_OPENER, ""))) {
    decision = { engine: "text", reason: msg("Flash answers in the conversation."), guessed: true, answersOnly: true, maybe: decision.engine };
  } else if (spoken && !attachmentType && decision.engine === "search" && casualWhen(straight(message))) {
    decision = { engine: "text", reason: msg("Flash answers in the conversation."), guessed: true, answersOnly: true };
  }
  if ((previous === "app" || previous === "slides") && GENERAL.includes(decision.engine) && !attachmentType) {
    const build = { engine: previous, reason: previous === "app" ? msg("Updating your app.") : msg("Updating your slides.") };
    if (!spoken) return build;
    const asks = spokenFollowUp(message);
    if (asks === "change") return build;
    // Talk is answered in words; an unclear turn goes to the router's guess, told about the build,
    // which may answer in words or change the build but never start something else with a price.
    return asks === "talk" ? { ...decision, guessed: undefined, about: previous } : { ...decision, guessed: true, answersOnly: true, about: previous };
  }
  return decision;
}

/**
 * Whether the router checks a spoken request again: questions often hold words the keyword rules
 * take for work ("the function of the liver" isn't code, "how are you today" needs no web search).
 */
export const checksSpoken = (engine: Engine) => engine === "code" || engine === "docs" || engine === "search";

/**
 * Whether the router's guess replaces the engine picked so far. A guess moves a request away from
 * text (the rules' default) but never to transcribing, and never makes a spoken "say it slower"
 * into a voice-over. A spoken request checked again (recheck) only moves between the engines that
 * answer in words, so a guess never turns it into a build or something with a price to agree to,
 * except the build it's about, or what the rules would have made of it (maybe).
 */
export function takesGuess(
  guess: Engine,
  engine: Engine,
  message: string,
  { spoken = false, recheck = false, about, maybe }: { spoken?: boolean; recheck?: boolean; about?: Engine; maybe?: Engine } = {},
): boolean {
  if (guess === engine) return false;
  // A spoken turn about a build may also change that build.
  if (recheck) return ANSWER_ENGINES.includes(guess) || guess === about || guess === maybe;
  return guess !== "text" && guess !== "transcribe" && !(spoken && guess === "voice" && !wantsAudioFile(message));
}

function routeOne(message: string, attachmentType?: string, { skipVoice = false } = {}): RouteDecision {
  const text = straight(message);
  if (attachmentType && AUDIO_TYPE.test(attachmentType)) {
    return { engine: "transcribe", reason: msg("An audio or video file is attached, so Flash transcribes it.") };
  }
  // Reading a photo's text goes to Docs & Sheets, which gives tables as spreadsheets. Checked first, since
  // "turn this into a spreadsheet" would otherwise read as a photo edit.
  if (attachmentType && PHOTO_TYPE.test(attachmentType) && READ_TEXT.test(text)) {
    return { engine: "docs", reason: msg("Flash reads the text in your photo.") };
  }
  // A picture of a screen, a sketch or a design, to rebuild as something that works.
  if (attachmentType && PHOTO_TYPE.test(attachmentType) && !ABOUT_PHOTO.test(text)) {
    if (DECK_FROM_PHOTO.test(text)) return { engine: "slides", reason: msg("Flash builds a deck from your picture.") };
    if (BUILD_FROM_PHOTO.test(text)) return { engine: "app", reason: msg("Flash builds this from your picture.") };
  }
  if (attachmentType && EDITABLE_TYPE.test(attachmentType) && ANIMATE_REQUEST.test(text) && !ABOUT_PHOTO.test(text)) {
    return { engine: "video", reason: msg("A photo is attached and you asked to bring it to life.") };
  }
  if (
    attachmentType &&
    EDITABLE_TYPE.test(attachmentType) &&
    EDIT_REQUEST.test(text) &&
    !ABOUT_PHOTO.test(text) &&
    !OTHER_OUTPUT.test(text) &&
    !NOT_A_CHANGE.test(text) &&
    (ASKS_EDIT.test(text) || !ADVICE.test(text))
  ) {
    return { engine: "image", reason: msg("A photo is attached and you asked to change it.") };
  }
  for (const rule of RULES) {
    // An attached file is read by a text engine, so media-making rules don't apply to it.
    if (attachmentType && ["video", "music", "image", "voice", "search", "app", "slides"].includes(rule.engine)) continue;
    if (skipVoice && rule.engine === "voice") continue;
    if (rule.unless?.test(text)) continue;
    if (rule.patterns.some((p) => p.test(text))) return { engine: rule.engine, reason: rule.reason };
  }
  if (attachmentType) {
    return SHEET_TYPE.test(attachmentType)
      ? { engine: "docs", reason: msg("A spreadsheet is attached.") }
      : { engine: "text", reason: msg("A file is attached, so the writing model reads it.") };
  }
  // No rule matched: the caller may ask a small model to decide.
  return { engine: "text", reason: msg("Writing and reasoning task."), guessed: true };
}

/** Strips the instruction part of a voice request, keeping the words to speak. */
export function textToSpeak(message: string): string {
  const quoted = message.match(/["“]([\s\S]+?)["”]/);
  if (quoted) return quoted[1].trim();
  // After a colon, but not a time's: "Say good night at 9:30" says all of it.
  const colon = message.search(/(?<!\d):(?!\d)/);
  if (colon >= 0 && message.slice(colon + 1).trim()) return message.slice(colon + 1).trim();
  return message.replace(/^((can|could|would|will) you\s+)?(please\s+)?(say|speak|narrate|read( this)?( aloud| out loud)?)\s*/i, "").trim() || message;
}
