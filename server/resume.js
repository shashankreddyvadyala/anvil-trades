/**
 * Resume intake and matching.
 *
 *   extractText(buffer, filename, mimetype)  PDF / DOCX / plain text -> text
 *   analyzeResume(text, context)             Claude if configured, keyword matcher if not
 *
 * The AI path and the offline path return the SAME shape, so the client
 * renders one thing and only the `engine` field differs. That matters: the
 * app has to work for someone who clones the repo without an API key.
 */
import { createRequire } from "node:module";
import mammoth from "mammoth";

const require = createRequire(import.meta.url);

/* pdfjs 3.x ships its Node build as CommonJS (hence createRequire) and prints
   a harmless "Cannot polyfill DOMMatrix" warning on load, because it looks for
   the optional native `canvas` package it would need to RENDER a page. We only
   read text, so the warning is noise — loading it lazily keeps it out of server
   startup and off the console unless someone actually uploads a PDF. */
let pdfjsModule = null;
const getPdfjs = () => (pdfjsModule ||= require("pdfjs-dist/legacy/build/pdf.js"));

export const MAX_RESUME_CHARS = 12000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

/* ============================================================
   TEXT EXTRACTION
   ============================================================ */

export async function extractText(buffer, filename = "", mimetype = "") {
  const name = String(filename).toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));

  if (ext === ".pdf" || mimetype === "application/pdf") {
    const doc = await getPdfjs().getDocument({ data: new Uint8Array(buffer) }).promise;
    let text = "";
    for (let i = 1; i <= Math.min(doc.numPages, 8); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(" ") + "\n\n";
    }
    if (!text.trim()) {
      const e = new Error("That PDF has no selectable text — it looks like a scan. Paste the text instead.");
      e.status = 400;
      throw e;
    }
    return text;
  }

  if (ext === ".docx" || mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  if (ext === ".txt" || ext === ".md" || mimetype.startsWith("text/")) {
    return buffer.toString("utf8");
  }

  const e = new Error("Upload a .pdf, .docx or .txt file, or paste the text.");
  e.status = 400;
  throw e;
}

/* ============================================================
   THE PROMPT
   ============================================================ */

function buildPrompt(resumeText, ctx) {
  const quizLine = ctx.quizTopMatches && ctx.quizTopMatches.length
    ? "The student also took our interest quiz. Their top trades from it were: "
      + ctx.quizTopMatches.join(", ")
      + ". Treat that as one signal — the resume is the stronger evidence."
    : "The student has not taken our interest quiz yet.";

  return [
    "You are helping a high-school student in the United States find a route into the skilled trades.",
    "",
    "STUDENT",
    `Graduating ${ctx.student.grad_year}, based in ${ctx.student.location}, attending ${ctx.student.school}.`,
    quizLine,
    "",
    "RESUME",
    resumeText.slice(0, MAX_RESUME_CHARS),
    "",
    "CATALOGS — you may only recommend items whose id appears below.",
    "Training programs (cost is what the provider charges; wage and debt describe that program's",
    "graduates, in US dollars per year):",
    JSON.stringify(ctx.programs),
    "",
    "Open job postings:",
    JSON.stringify(ctx.jobs),
    "",
    "TASK",
    "Read the resume for evidence of hands-on ability: coursework, shop or CTE classes, certifications,",
    "tools handled, part-time or family work, safety training, math, reliability, driving, physical work.",
    "A thin resume is normal for a 17-year-old — judge potential and transferable evidence, not polish.",
    "Recommend up to 4 programs and up to 4 jobs, best first. Weigh cost, time to certify and starting",
    "wage against what the resume shows, and prefer providers near the student. Only recommend a job the",
    "resume gives some real reason to consider. Be specific: name what in the resume drove each match.",
    "Never invent a certification, employer, or skill the resume does not show.",
    "",
    "Reply with ONLY this JSON object and nothing else:",
    '{"summary":"2-3 sentences addressed to the student, plain language",',
    '"skills":["short skill phrases found in the resume"],',
    '"certifications":["certs or licences found, [] if none"],',
    '"tools":["tools, equipment or software named, [] if none"],',
    '"strengths":["2-4 things working in their favour"],',
    '"program_recommendations":[{"program_id":"pg-xx","fit":0-100,"why":"one sentence citing the resume","gaps":["what to pick up first"]}],',
    '"job_recommendations":[{"job_id":"jb-xx","fit":0-100,"why":"one sentence citing the resume","missing":["what the resume does not yet show"]}],',
    '"next_steps":["3 concrete actions, each one short sentence"]}'
  ].join("\n");
}

/** Read one JSON value out of a reply that may be fenced or prefaced. */
function parseJsonReply(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error("No JSON in the model reply.");
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Drop anything the model invented. A recommendation that doesn't resolve to
 * a real row is worse than no recommendation — it would render a broken link.
 */
export function sanitize(raw, ctx) {
  const arr = v => (Array.isArray(v) ? v : []);
  const str = v => (typeof v === "string" ? v : "");
  const clamp = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  const progIds = new Set(ctx.programs.map(p => p.program_id));
  const jobIds = new Set(ctx.jobs.map(j => j.job_id));

  return {
    summary: str(raw?.summary),
    skills: arr(raw?.skills).map(str).filter(Boolean).slice(0, 14),
    certifications: arr(raw?.certifications).map(str).filter(Boolean).slice(0, 8),
    tools: arr(raw?.tools).map(str).filter(Boolean).slice(0, 12),
    strengths: arr(raw?.strengths).map(str).filter(Boolean).slice(0, 5),
    next_steps: arr(raw?.next_steps).map(str).filter(Boolean).slice(0, 5),
    program_recommendations: arr(raw?.program_recommendations)
      .filter(m => progIds.has(str(m?.program_id)))
      .map(m => ({ program_id: m.program_id, fit: clamp(m.fit), why: str(m.why), gaps: arr(m.gaps).map(str).filter(Boolean).slice(0, 4) }))
      .slice(0, 4),
    job_recommendations: arr(raw?.job_recommendations)
      .filter(m => jobIds.has(str(m?.job_id)))
      .map(m => ({ job_id: m.job_id, fit: clamp(m.fit), why: str(m.why), missing: arr(m.missing).map(str).filter(Boolean).slice(0, 4) }))
      .slice(0, 4)
  };
}

/* ============================================================
   OFFLINE MATCHER — runs when there is no API key
   ============================================================ */

/*
 * Keywords are matched as WHOLE WORDS. Plain substring matching reads
 * "career" as "car", "database" as "ase", "investigate" as "tig" and
 * "academic" as "cad" — so an ordinary resume with nothing about cars came
 * back as a 100% Automotive match.
 *
 * A trailing * marks a deliberate stem: "weld*" matches weld, welder,
 * welding, welded. Everything else must match the whole word; list plurals
 * separately where they matter. Multi-word phrases match with any spacing.
 *
 * Deliberately left out: words that usually mean something else on a resume —
 * "water", "panel", "stick", and "AWS" (Amazon Web Services far more often
 * than the American Welding Society, which is listed by its full name).
 */
const TRADE_KEYWORDS = {
  "Electrical":               ["electric*", "wiring", "wire", "wires", "circuit*", "voltage", "conduit",
                               "multimeter*", "breaker*", "osha", "physics"],
  "Powerline":                ["lineman", "linemen", "lineworker*", "powerline*", "utility", "utilities",
                               "climbing", "tower*", "high voltage", "cdl", "bucket truck*"],
  "Industrial Millwright":    ["millwright*", "machinery", "rigging", "bearing*", "alignment",
                               "industrial maintenance", "conveyor*", "gearbox*"],
  "Plumbing & Pipefitting":   ["plumb*", "pipe", "pipes", "piping", "pipefitt*", "solder*", "drain*",
                               "fixture*", "backflow"],
  "HVAC/R":                   ["hvac", "refrigerat*", "air condition*", "furnace*", "thermostat*",
                               "ductwork", "epa 608", "heat pump*"],
  "Diesel & Heavy Equipment": ["diesel", "truck*", "engine", "engines", "hydraulic*", "fleet",
                               "heavy equipment", "cdl", "forklift*", "tractor*"],
  "CNC Machining":            ["cnc", "machining", "machinist*", "lathe*", "mill", "milling",
                               "blueprint*", "caliper*", "micrometer*", "tolerance*", "cad", "autocad",
                               "solidworks", "3d print*"],
  "Welding & Fabrication":    ["weld*", "mig", "tig", "stick welding", "fabricat*", "metal", "metals",
                               "metalwork*", "sheet metal", "torch*", "plasma cut*", "american welding society"],
  "Solar PV":                 ["solar", "photovoltaic*", "pv", "renewable*", "roofing", "roofer*", "nabcep"],
  "Automotive":               ["automotive", "auto shop", "auto body", "auto tech*", "brake*", "car", "cars",
                               "ase", "oil change*", "tire", "tires", "mechanic", "mechanics"]
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One compiled pattern per keyword. \b is a word boundary. */
function keywordPattern(k) {
  const stem = k.endsWith("*");
  const body = escapeRe(stem ? k.slice(0, -1) : k).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${body}${stem ? "[a-z]*" : "\\b"}`, "i");
}

const PATTERNS = Object.fromEntries(
  Object.entries(TRADE_KEYWORDS).map(([trade, words]) => [trade, words.map(keywordPattern)])
);

/** The words in `text` that match a trade's keywords, as they appear there. */
export function keywordHits(text, trade) {
  const found = [];
  for (const re of PATTERNS[trade] || []) {
    const m = String(text || "").match(re);
    if (m) found.push(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  return [...new Set(found)];
}

export function keywordAnalysis(text, ctx) {
  const found = new Set();

  const byTrade = new Map();
  for (const p of ctx.programs) {
    if (!byTrade.has(p.trade)) byTrade.set(p.trade, []);
    byTrade.get(p.trade).push(p);
  }

  const scored = [...byTrade.entries()].map(([trade, list]) => {
    const hits = keywordHits(text, trade);
    hits.forEach(h => found.add(h));
    return {
      trade, hits, score: hits.length,
      programs: [...list].sort((a, b) => a.cost - b.cost),
      top_wage: Math.max(...list.map(p => p.avg_starting_wage))
    };
  }).sort((a, b) => b.score - a.score || b.top_wage - a.top_wage);

  const matched = scored.filter(s => s.score > 0).slice(0, 3);
  const picked = matched.length ? matched : scored.slice(0, 3).map(s => ({ ...s, hits: [] }));
  const best = Math.max(1, picked[0]?.score || 0);

  const programs = picked
    .filter(m => m.programs.length)
    .map(m => ({
      program_id: m.programs[0].program_id,
      // With no keyword evidence at all, don't claim a strong fit.
      fit: m.score ? Math.round((m.score / best) * 100) : 30,
      why: m.hits.length
        ? `Cheapest ${m.trade} program; your resume mentions: ${m.hits.join(", ")}.`
        : `Cheapest ${m.trade} program — listed by starting wage, not by anything in your resume.`,
      gaps: []
    }));

  // Job titles go through the same whole-word matcher, and only for trades
  // the resume actually pointed at — "MIG Welder" matches weld*, and a resume
  // with no trade evidence gets no job recommendations rather than guesses.
  const jobs = [];
  for (const m of matched) {
    for (const j of ctx.jobs) {
      if (jobs.length >= 4 || jobs.some(x => x.job_id === j.job_id)) continue;
      const hit = keywordHits(j.title, m.trade)[0];
      if (hit) jobs.push({
        job_id: j.job_id,
        fit: Math.round((m.score / best) * 100),
        why: `The title matches "${hit}", and your resume points toward ${m.trade}.`,
        missing: []
      });
    }
  }

  return {
    summary: matched.length
      ? `Keyword match only — no AI ran. Your resume mentions ${[...found].slice(0, 5).join(", ")}, which points toward ${picked[0].trade}.`
      : "Keyword match only — no AI ran. Nothing in the resume matched a trade keyword, so these are simply the highest-paying programs, not a real match. Add shop classes, tools, or hands-on jobs and scan again.",
    skills: [...found].slice(0, 10),
    certifications: [],
    tools: [],
    strengths: [],
    next_steps: [
      "Take the six-question trade quiz for a second signal.",
      "Add shop classes, tools and certifications to the resume, then scan again.",
      "Ask the site owner about turning on the AI scan for a fuller reading of your resume."
    ],
    program_recommendations: programs,
    job_recommendations: jobs
  };
}

/* ============================================================
   ENTRY POINT
   ============================================================ */

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/*
 * A site-wide ceiling on AI scans per hour, so a public URL can't run up the
 * API bill however many accounts someone creates. Past it, scans still work —
 * they just use the keyword matcher until the hour rolls over.
 * Set AI_SCANS_PER_HOUR to change it.
 */
const AI_SCANS_PER_HOUR = Number(process.env.AI_SCANS_PER_HOUR || 60);
const aiBudget = { windowStart: 0, used: 0 };
function takeAiBudget() {
  const now = Date.now();
  if (now - aiBudget.windowStart > 60 * 60 * 1000) { aiBudget.windowStart = now; aiBudget.used = 0; }
  if (aiBudget.used >= AI_SCANS_PER_HOUR) return false;
  aiBudget.used++;
  return true;
}

/**
 * @returns {Promise<{engine: "ai"|"keyword", model: string|null, analysis: object}>}
 */
export async function analyzeResume(text, ctx) {
  if (!aiConfigured()) {
    return { engine: "keyword", model: null, analysis: keywordAnalysis(text, ctx) };
  }
  if (!takeAiBudget()) {
    const analysis = keywordAnalysis(text, ctx);
    analysis.summary = "The AI scan is busy right now, so this is a keyword match instead — try again in a while. " + analysis.summary;
    return { engine: "keyword", model: null, analysis };
  }

  // Imported lazily so the server starts fine without the SDK installed.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: buildPrompt(text, ctx) }]
    });

    const reply = message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");

    return { engine: "ai", model: MODEL, analysis: sanitize(parseJsonReply(reply), ctx) };
  } catch (err) {
    // A bad key, a retired model id, a rate limit, a malformed reply: the
    // student still gets recommendations. The real reason goes to the server
    // log for the site owner — students see a plain sentence, not API errors.
    console.error("Resume analysis fell back to keywords:", err.message);
    const analysis = keywordAnalysis(text, ctx);
    analysis.summary = "The AI scan didn't work this time, so this is a keyword match instead. " + analysis.summary;
    return { engine: "keyword", model: null, analysis };
  }
}
