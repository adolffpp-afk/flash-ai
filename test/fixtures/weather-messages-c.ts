// Set C of the weather routing checks: written before the final word lists and never tuned on (a held-out check).
// When a pattern changes, write a new blind set before tuning, and report its numbers separately.
// intent: weather | clock | text | image | music | translate | docs | search | code
export type M = { q: string; intent: string };
const m = (intent: string) => (q: string): M => ({ q, intent });
export const BLIND: M[] = [
  ...[
    "is it going to rain later?", "Rain today?", "how cold will it be tonight in Calgary", "what's the weather gonna be like this weekend",
    "Should I take an umbrella to work today?", "Is it too windy to fly a drone today?", "will it be dry enough to paint the fence on Saturday?",
    "Is it freezing outside?", "Any rain expected in Accra this week?", "What's the high today?", "Are there thunderstorms in the forecast for Dallas?",
    "how many degrees tomorrow", "Is it humid in Singapore right now?", "Do I need sunscreen today?", "Will it snow on Christmas in Chicago?", "weather Nairobi",
    "Il fait froid à Montréal aujourd'hui ?", "¿Hace frío en Buenos Aires hoy?", "Está chovendo no Rio agora?", "Regnet es gerade in Hamburg?",
    "Domani piove a Milano?", "Gaat het morgen regenen in Utrecht?", "Czy jutro będzie padać w Krakowie?", "Завтра будет дождь в Петербурге?",
    "Bugün Ankara'da hava nasıl?", "Чи буде дощ у Львові завтра?", "اليوم الجو حار في الرياض؟", "上海明天气温多少？", "明日は雨が降りますか？",
    "부산 오늘 비 와?", "Hôm nay ở Sài Gòn có mưa không?", "Leo kutanyesha Mombasa?", "Mainit ba sa Cebu ngayon?", "Ce vreme va fi mâine la Cluj?",
    "Kommer det snöa i Göteborg i helgen?",
  ].map(m("weather")),
  ...[
    "What's the best temperature to brew green tea?", "How hot should my iron be for silk?", "Is it cold calling if I email a stranger on LinkedIn?",
    "What's the forecast accuracy of ARIMA models?", "How do meteorologists forecast the weather?", "Why does it rain more in the tropics?", "What causes thunder?",
    "Are umbrellas allowed in carry-on luggage?", "Can you explain the rain dance tradition?", "Will it be cheaper to rent or buy in 2027?",
    "Is it too late to start investing at 40?", "Is cold-pressed juice healthier?", "Should I bring a jacket to the job interview?", "What to wear for a winter wedding?",
    "Write an email cancelling the picnic because of the rain", "Snowflake vs BigQuery for analytics", "How do I make a cloud storage backup?",
    "What's the temperature coefficient of a solar panel?", "Résume ce texte sur le changement climatique", "Quel temps de trajet entre Paris et Lyon en train ?",
    "¿Qué tiempo verbal es 'habría comido'?", "Hoe laat is het in New York?", "Wetterfeste Jacke kaufen, welche Marke?", "Погода в доме — главное, напиши тост",
    "Hava yolları bagaj kuralları nedir?", "天气预报的原理是什么？", "Mvua ni nini? Eleza kwa watoto", "Write a weather-themed birthday card for my son",
    "Is it hot in here or is it just me, which song is that?", "Storm the castle: board game strategy tips",
  ].map(m("text")),
  ...["Tulis puisi tentang hujan di sore hari"].map(m("text")),
  ...["Generate an image of a snowy mountain at sunset", "Pinta un paraguas bajo la lluvia", "Нарисуй зонтик под дождём", "雨の中の傘を描いて"].map(m("image")),
  ...["Translate 'it is raining' to German", "Traduis « il va pleuvoir demain » en anglais"].map(m("translate")),
  ...["Fais un tableau Excel des températures moyennes à Paris"].map(m("docs")),
];
