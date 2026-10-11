// The three message sets for the weather routing checks, and the 63 questions of the first diagnosis.
export * as A from "./weather-messages-a.ts";
export * as B from "./weather-messages-b.ts";
export * as C from "./weather-messages-c.ts";

// The questions the weather design started from (answers/router-output.json), in its order. The five
// follow-ups ("and tomorrow?") only make sense after a weather question.
export const DIAGNOSIS: string[] = [
  "will it rain tomorrow?", "Will it rain tomorrow in London?", "how hot is it in Lagos", "do I need an umbrella",
  "Do I need an umbrella today?", "forecast for Paris this weekend", "what's the temperature",
  "what's the temperature outside right now", "is it snowing in Toronto", "What's the weather like?",
  "what's the weather in Accra", "weather tomorrow", "Is it going to be sunny on Saturday?",
  "how cold is it in Chicago", "Should I bring a jacket tonight?", "What should I wear tomorrow in Montreal?",
  "Is there a storm coming to Miami?", "Any hurricane warnings for Florida?", "what's the humidity in Dubai",
  "chance of rain in Nairobi this afternoon", "Is it windy in Chicago?", "How many degrees is it in Kinshasa?",
  "What's the UV index today?", "When will the rain stop?", "Is it a good day for the beach in Miami?",
  "Can I go running this evening or will it rain?", "5 day forecast for Toronto",
  "Is it going to snow this week in Boston?", "temperature in Celsius for Port-au-Prince",
  "is it raining in Port-au-Prince right now?", "air quality in Delhi", "What time is sunset in Paris?",
  "How's the weather looking for my flight to New York on Friday?",
  "Will the match in Manchester be rained off tomorrow?", "Is it safe to drive to Ottawa tomorrow with the snow?",
  "what will the weather be like in Rome next week", "Is it hot in Lagos? Answer in French",
  "Tell me the weather in Tokyo and translate it to Japanese",
  "Make a packing list for Paris based on this week's weather",
  "Write an email to my team about tomorrow's snowstorm closing the office",
  "What's the weather in Lagos? Put it in a table", "Plan my weekend in Montreal around the weather",
  "How warm is the sea in Nice?", "Is there a heatwave in Spain?", "Has it stopped snowing in Toronto?",
  "and tomorrow?", "what about Saturday?", "and in Abuja?", "in Fahrenheit please", "hourly?",
  "météo à Montréal demain", "Quel temps fait-il à Paris ?", "Est-ce qu'il va pleuvoir demain ?",
  "Il fait combien à Port-au-Prince ?", "¿Qué tiempo hace en Madrid?", "¿Va a llover mañana en Bogotá?",
  "pronóstico del clima para Ciudad de México", "ما هو الطقس في دبي اليوم؟", "هل ستمطر غدا في القاهرة؟",
  "आज दिल्ली में मौसम कैसा है?", "क्या कल मुंबई में बारिश होगी?", "北京明天天气怎么样？", "上海今天会下雨吗？",
];
