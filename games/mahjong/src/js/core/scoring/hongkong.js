import { Cantonese } from "./cantonese.js";
import { Ruleset } from "./ruleset.js";

/**
 * Hong Kong style mahjong.
 *
 * The current engine reuses the Cantonese/Chinese-classical
 * tile definitions and scoring helpers, so this rule set adds
 * the Hong Kong naming and the same four-player faan/laak
 * scoring framework without introducing an incompatible ruleset.
 */
class HongKong extends Cantonese {}

Ruleset.register(HongKong);

export { HongKong };
