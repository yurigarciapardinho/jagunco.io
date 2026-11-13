import { config } from "../moomoo/config.js";

export const MAX_XP_GRANT = 1_000_000;
export const progression = player => ({
  age: player.age,
  xp: player.XP,
  maxXp: player.maxXP,
  upgradePoints: player.upgradePoints,
});
const invalid = code => Object.assign(new Error(code), { status: 400 });

export function validateExperience(player, amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_XP_GRANT)
    throw invalid("xp_invalid");
  if (player.age >= config.maxAge) throw invalid("xp_max_age");
}

export function grantExperience(player, amount) {
  validateExperience(player, amount);
  const before = progression(player);
  let remaining = amount;
  // Native earnXP advances one age and discards overflow. Split an owner's
  // grant at each threshold so the full amount is used up to the age cap.
  while (remaining > 0 && player.age < config.maxAge) {
    const step = Math.min(remaining, Math.max(0, player.maxXP - player.XP));
    const age = player.age;
    player.earnXP(step);
    remaining = Math.max(0, remaining - step);
    if (step === 0 && player.age === age) throw invalid("xp_state_invalid");
  }
  return { requested: amount, granted: amount - remaining, before, after: progression(player) };
}
