// The AI's training.
//
// TRAINING CORPUS: src/manual.js indexes every page of the four field manuals (1,247 PDF pages),
// generated from the PDFs by tools/mkmanual.py. Each doctrinal page is tagged with the topics it
// teaches. Every AI force is trained on every doctrinal page; covers, contents, indexes, glossaries
// and blank pages are the only pages left out.
//
// DRILLS: the behaviours in ai.js. A drill is available to the AI only if it has been trained on the
// pages that teach its topics. The pages are the only thing the AI is given besides its own senses:
// no map layout, no player positions, no scripted kills.
import { PAGE_INDEX, TOPICS, MANUALS } from './manual.js';

export const DRILLS = [
  { id: 'org', topics: ['org'], ref: 'ATP 3-21.8, ch. 1', title: 'Squad organization',
    text: 'Squad leader plus fire teams of four (team leader, automatic rifleman, grenadier, rifleman). The automatic rifleman is the base of fire; the grenadier engages what rifles cannot reach.' },
  { id: 'movement', topics: ['movement'], ref: 'ATP 3-21.8, ch. 2', title: 'Formations and bounding overwatch',
    text: 'Wedge with dispersion while contact is unlikely; when it is likely, one team overwatches while the other bounds to the next covered position.' },
  { id: 'contact', topics: ['contact', 'cover'], ref: 'ATP 3-21.8, Battle Drill: React to Contact', title: 'React to contact',
    text: 'Return fire, get to cover (not just concealment), report. The team in contact becomes the base of fire.' },
  { id: 'firemove', topics: ['firemove'], ref: 'ATP 3-21.8, ch. 2–3', title: 'Fire and movement / flanking',
    text: 'Support element suppresses while the maneuver element moves by a covered route to the flank and assaults through.' },
  { id: 'suppress', topics: ['suppress'], ref: 'FM 3-34.2 ¶1-12–1-13', title: 'Suppression',
    text: 'Sustained fire into the last known or suspected enemy position, even without a visible target.' },
  { id: 'sosra', topics: ['breach', 'obscure', 'suppress'], ref: 'FM 3-34.2 ¶1-11–1-19', title: 'Breaching — SOSRA',
    text: 'Suppress positions that see the breach, obscure with smoke, secure the flank, reduce with a charge, assault through immediately.' },
  { id: 'cqb', topics: ['cqb', 'urban'], ref: 'ATTP 3-06.11 ¶7-52, 7-95–7-100', title: 'Entering and clearing rooms',
    text: 'Stack on one side, grenade first when the enemy is suspected, move fast through the fatal funnel to the points of domination.' },
  { id: 'stairs', topics: ['stairs'], ref: 'ATTP 3-06.11 ¶7-173', title: 'Stairwells',
    text: 'Stairs are fatal funnels: cover them like a door when defending, and move up or down them without stopping when attacking.' },
  { id: 'windows', topics: ['windows', 'urban'], ref: 'ATTP 3-06.11 (firing positions in buildings)', title: 'Fire from inside the room',
    text: 'Do not stand in the window. Fight from back inside the room so the opening frames your field of fire and hides your muzzle.' },
  { id: 'urbanmove', topics: ['urban', 'movement'], ref: 'ATTP 3-06.11 ch. 7 (movement in urban terrain)', title: 'Move along walls',
    text: 'Avoid the middle of open ground and streets; move along walls and cover, crossing open areas quickly.' },
  { id: 'danger', topics: ['obscure', 'movement'], ref: 'ATP 3-21.8, ch. 2 (danger areas)', title: 'Crossing danger areas',
    text: 'Screen open ground the enemy can see with smoke before crossing it.' },
  { id: 'defend', topics: ['defense'], ref: 'ATP 3-21.8, ch. 6 (priorities of work)', title: 'Occupying a defense',
    text: 'Reconnoiter, then occupy covered positions with sectors of fire over the entry points; the automatic rifleman covers the most likely approach.' },
  { id: 'interlock', topics: ['interlock'], ref: 'ATP 3-21.8, ch. 6', title: 'Interlocking sectors',
    text: 'Cross adjacent sectors at 45–90° so every entry point is covered by more than one weapon.' },
  { id: 'obstacles', topics: ['obstacles'], ref: 'FM 5-102, ch. 1–3', title: 'Obstacles covered by fire',
    text: 'Claymores on the entry routes inside your sectors, so the mine and the gun cover each other.' },
  { id: 'ambush', topics: ['ambush', 'firecontrol'], ref: 'ATP 3-21.8, ch. 6–7 (engagement areas, fire initiation)', title: 'Hold fire for the engagement area',
    text: 'A concealed defender holds fire until the enemy is inside the engagement area or the position is compromised; the first shot is the signal for everyone.' },
  { id: 'targets', topics: ['firecontrol'], ref: 'ATP 3-21.8, ch. 2 (fire control & distribution)', title: 'Target priority',
    text: 'Engage the enemy that is firing at you first, then automatic weapons and leaders, then the nearest.' },
  { id: 'alternate', topics: ['alternate'], ref: 'ATP 3-21.8, ch. 6', title: 'Alternate positions',
    text: 'Displace to an alternate position covering the same sector when pinned.' },
  { id: 'counterattack', topics: ['counterattack'], ref: 'ATP 3-21.8, ch. 6; ATTP 3-06.11 ch. 6', title: 'Counterattack',
    text: 'When the enemy gains a foothold inside the position, a team counterattacks to throw him out, grenades first.' },
  { id: 'search', topics: ['search'], ref: 'ATP 3-21.8, ch. 2', title: 'Re-establish lost contact',
    text: 'Keep the last known position under observation and move in pairs to find the enemy again; sounds and incoming rounds give the direction.' },
  { id: 'casualty', topics: ['casualty'], ref: 'ATP 3-21.8, ch. 2 (casualty care)', title: 'Casualty care under fire',
    text: 'A wounded man gets to cover; the nearest buddy moves to cover him and returns fire.' },
  { id: 'security', topics: ['security'], ref: 'ATP 3-21.8, ch. 2 & 6', title: '360° security',
    text: 'At every halt and on the objective, men face outward in all directions, including the rear.' },
  { id: 'grenades', topics: ['grenades'], ref: 'ATTP 3-06.11 app. B; ATP 3-21.8', title: 'Grenades and grenade launchers',
    text: 'Hand grenades into rooms and behind cover at short range; 40 mm on positions the rifles cannot see.' },
  { id: 'break', topics: ['break'], ref: 'ATP 3-21.8, Battle Drill: Break Contact', title: 'Break contact',
    text: 'When the unit can no longer fight effectively: suppress, smoke, bound back.' },
  { id: 'comms', topics: ['comms'], ref: 'ATP 3-21.8, ch. 1–2', title: 'Report contacts',
    text: 'Every contact (seen, heard or shot from) is reported to the whole squad immediately.' },
  { id: 'discipline', topics: ['firecontrol'], ref: 'ATP 3-21.8, ch. 2', title: 'Fire discipline',
    text: 'Never fire with a friend in the line of fire.' },
];

// ───────── training: every force studies every doctrinal page ─────────
const TOPIC_BIT = Object.fromEntries(TOPICS.map((t, i) => [t, 1 << i]));
const DOCTRINAL = PAGE_INDEX.filter((p) => p[5] === 1);

function buildTraining(pages) {
  const perTopic = {};
  for (const t of TOPICS) {
    const total = DOCTRINAL.filter((p) => p[4] & TOPIC_BIT[t]).length;
    const got = pages.filter((p) => p[4] & TOPIC_BIT[t]).length;
    perTopic[t] = { total, got, competence: total ? got / total : 1 };
  }
  const drills = DRILLS.filter((d) => d.topics.every((t) => perTopic[t].competence >= 0.5)).map((d) => d.id);
  const perManual = MANUALS.map((m, i) => ({
    short: m.short, title: m.title,
    pages: PAGE_INDEX.filter((p) => p[0] === i).length,
    trained: pages.filter((p) => p[0] === i).length,
  }));
  return { pages: pages.length, totalPages: PAGE_INDEX.length, perTopic, drills, perManual };
}

export const TRAINING = buildTraining(DOCTRINAL);

/** Difficulty = size, experience and kit. Knowledge is the same for all: the full corpus. */
export const PROFILES = {
  RECRUIT: {
    label: 'Recruit fire team', size: 4, blurb: '4 men fresh from the schoolhouse: they know the manuals but are slow to spot you, slow to react and shoot poorly.',
    reaction: 1.1, aimErr: 0.10, spot: 0.7, hearing: 25, frags: 1, gl: 2, smokes: 1, claymores: 1, charges: 1, decide: 1.0,
  },
  REGULAR: {
    label: 'Regular section', size: 7, blurb: '7 soldiers with some time in. Competent drills, average marksmanship.',
    reaction: 0.75, aimErr: 0.07, spot: 1.0, hearing: 35, frags: 1, gl: 3, smokes: 1, claymores: 1, charges: 2, decide: 0.7,
  },
  VETERAN: {
    label: 'Veteran squad', size: 9, blurb: 'Squad leader + 2 fire teams of combat veterans. Fast drills, good shooting.',
    reaction: 0.5, aimErr: 0.045, spot: 1.3, hearing: 45, frags: 2, gl: 4, smokes: 1, claymores: 2, charges: 2, decide: 0.5,
  },
  MARINES: {
    label: 'Marine rifle squad', size: 13, blurb: 'A full USMC rifle squad: squad leader + 3 fire teams with automatic riflemen and grenadiers. Everything in the manuals, executed fast.',
    reaction: 0.3, aimErr: 0.03, spot: 1.7, hearing: 55, frags: 2, gl: 6, smokes: 2, claymores: 3, charges: 3, decide: 0.35,
  },
};
for (const p of Object.values(PROFILES)) p.training = TRAINING;

export const PROFILE_ORDER = ['RECRUIT', 'REGULAR', 'VETERAN', 'MARINES'];

/** Roles for an AI force of n men: SL then fire teams of TL, AR, GR, RF. */
export function rolesFor(n) {
  const out = [];
  if (n >= 9) out.push({ role: 'SL', team: -1 });
  let team = 0;
  while (out.length < n) {
    for (const role of ['TL', 'AR', 'GR', 'RF']) {
      if (out.length >= n) break;
      out.push({ role, team });
    }
    team++;
  }
  return out;
}

/** Has this force been trained on the pages that teach this drill? */
export const knows = (profile, id) => profile.training.drills.includes(id);
/** How much of a topic's material this force has studied (0–1). */
export const competence = (profile, topic) => profile.training.perTopic[topic]?.competence ?? 0;

/** Which drill the team brain is running, for the spectator HUD. */
export const STATE_DRILL = {
  recon: 'defend', occupy: 'defend', hold: 'defend', advance: 'movement', contact: 'firemove',
  breach: 'sosra', clear: 'cqb', consolidate: 'security', break: 'break', follow: 'movement', counter: 'counterattack',
};
export const drill = (id) => DRILLS.find((d) => d.id === id);
