// Internal team aliases are account identifiers; passwords are never part of the app.
export const TEAM_USERNAMES = ["andres", "byron", "mauricio", "lili", "nicole"];
export function resolveLoginEmail(value) {
  const input = String(value).trim().toLowerCase();
  if (input.includes("@")) return input;
  const username = input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (TEAM_USERNAMES.includes(username)) return `${username}@control-trabajos.invalid`;
  throw new Error("Escribe tu usuario del equipo o tu correo electrónico.");
}
