/**
 * The trade quiz. Each answer option carries weights toward one or more
 * trades; scoring happens on the server so the client can't fake a match.
 * `answers` is an array of chosen option indexes, one per question.
 *
 * Weights key off the `trade` label on programs — there is no pathway
 * table to point at, so these strings must match `programs.trade` exactly.
 * TRADES below is the single source of truth for that spelling.
 */
export const TRADES = {
  ELEC:   "Electrical",
  LINE:   "Powerline",
  MILL:   "Industrial Millwright",
  PLUMB:  "Plumbing & Pipefitting",
  HVAC:   "HVAC/R",
  DIESEL: "Diesel & Heavy Equipment",
  CNC:    "CNC Machining",
  WELD:   "Welding & Fabrication",
  SOLAR:  "Solar PV",
  AUTO:   "Automotive"
};
const T = TRADES;

export const QUIZ = [
  {
    q: "Where would you rather spend a full shift?",
    opts: [
      { label: "On an active job site",       w: { [T.ELEC]: 3, [T.PLUMB]: 3, [T.MILL]: 2 } },
      { label: "In a shop with machines",     w: { [T.CNC]: 3, [T.WELD]: 3, [T.AUTO]: 2 } },
      { label: "Driving between service calls", w: { [T.HVAC]: 3, [T.DIESEL]: 3, [T.AUTO]: 2 } },
      { label: "Outdoors, up off the ground", w: { [T.LINE]: 3, [T.SOLAR]: 3 } }
    ]
  },
  {
    q: "Which tool would you pick up first?",
    opts: [
      { label: "Multimeter",     w: { [T.ELEC]: 3, [T.LINE]: 2, [T.SOLAR]: 2 } },
      { label: "Welding torch",  w: { [T.WELD]: 3, [T.MILL]: 2 } },
      { label: "Torque wrench",  w: { [T.AUTO]: 3, [T.DIESEL]: 3, [T.MILL]: 1 } },
      { label: "Pipe threader",  w: { [T.PLUMB]: 3, [T.HVAC]: 2 } }
    ]
  },
  {
    q: "What matters more in your first year out?",
    opts: [
      { label: "Highest starting pay",  w: { [T.LINE]: 3, [T.MILL]: 2, [T.ELEC]: 2 } },
      { label: "Lowest training cost",  w: { [T.ELEC]: 3, [T.PLUMB]: 3, [T.SOLAR]: 2 } },
      { label: "A balance of both",     w: { [T.HVAC]: 2, [T.WELD]: 2, [T.CNC]: 2 } }
    ]
  },
  {
    q: "How long are you willing to train?",
    opts: [
      { label: "Under a year",                 w: { [T.WELD]: 3, [T.SOLAR]: 3, [T.CNC]: 2, [T.DIESEL]: 2 } },
      { label: "One to two years",             w: { [T.HVAC]: 3, [T.AUTO]: 3, [T.CNC]: 2 } },
      { label: "3+ years, if I'm paid to learn", w: { [T.ELEC]: 3, [T.PLUMB]: 3, [T.MILL]: 3, [T.LINE]: 2 } }
    ]
  },
  {
    q: "How do you feel about heights?",
    opts: [
      { label: "No problem at all",            w: { [T.LINE]: 3, [T.SOLAR]: 3 } },
      { label: "Fine with a harness",          w: { [T.SOLAR]: 2, [T.ELEC]: 1, [T.MILL]: 1 } },
      { label: "I'd rather stay on the ground", w: { [T.CNC]: 2, [T.WELD]: 2, [T.AUTO]: 2, [T.DIESEL]: 2 } }
    ]
  },
  {
    q: "Which sounds more like you?",
    opts: [
      { label: "Diagnosing what's broken",     w: { [T.AUTO]: 3, [T.HVAC]: 3, [T.DIESEL]: 2, [T.ELEC]: 1 } },
      { label: "Building something from parts", w: { [T.WELD]: 3, [T.CNC]: 3, [T.MILL]: 2 } },
      { label: "Honestly, both",               w: { [T.ELEC]: 2, [T.PLUMB]: 2, [T.MILL]: 2 } }
    ]
  }
];

/** true when `answers` is one valid option index per question. */
export function validAnswers(answers) {
  return Array.isArray(answers)
    && answers.length === QUIZ.length
    && answers.every((a, i) => Number.isInteger(a) && a >= 0 && a < QUIZ[i].opts.length);
}

/**
 * Score every trade against a set of answers, then attach that trade's
 * programs. Trades are derived from the program catalog, so a trade with
 * no programs simply never appears.
 *
 * @param {number[]} answers
 * @param {Array<{program_id, trade, cost, avg_starting_wage, ...}>} programs
 * @returns rows sorted best-first, with a 0-100 `pct` for display.
 */
export function scoreTrades(answers, programs) {
  const byTrade = new Map();
  for (const p of programs) {
    if (!byTrade.has(p.trade)) byTrade.set(p.trade, []);
    byTrade.get(p.trade).push(p);
  }

  const score = Object.fromEntries([...byTrade.keys()].map(t => [t, 0]));
  answers.forEach((choice, qi) => {
    const opt = QUIZ[qi]?.opts[choice];
    if (!opt) return;
    for (const [trade, weight] of Object.entries(opt.w)) {
      if (trade in score) score[trade] += weight;
    }
  });

  const max = Math.max(1, ...Object.values(score));
  return [...byTrade.entries()]
    .map(([trade, list]) => {
      const sorted = [...list].sort((a, b) => a.cost - b.cost);
      return {
        trade,
        score: score[trade],
        pct: Math.round((score[trade] / max) * 100),
        program_count: sorted.length,
        low_cost: Math.min(...sorted.map(p => p.cost)),
        top_wage: Math.max(...sorted.map(p => p.avg_starting_wage)),
        programs: sorted
      };
    })
    .sort((a, b) => b.score - a.score || b.top_wage - a.top_wage);
}
