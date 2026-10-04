/*
 * Instructions for one project ("answer as my bakery's marketer, in French"), added to what Flash
 * remembers about the user for every answer in that project.
 */

export const MAX_INSTRUCTIONS = 4000;

/** Instructions as saved: trimmed and cut to MAX_INSTRUCTIONS. */
export const cleanInstructions = (text: string) => text.trim().slice(0, MAX_INSTRUCTIONS);

/** The user's saved memory with a project's instructions after it. */
export function withInstructions(preferences: string, instructions: string): string {
  const own = cleanInstructions(instructions);
  if (!own) return preferences;
  const project = `Instructions for this project (follow them in every answer here unless the user says otherwise):\n${own}`;
  return preferences.trim() ? `${preferences.trim()}\n\n${project}` : project;
}
