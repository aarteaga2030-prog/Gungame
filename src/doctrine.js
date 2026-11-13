// The AI's training. These "pages" are the ONLY thing the AI is given besides its own senses:
// no map layout, no player positions, no scripted kills. Each page names the manual it comes
// from and the behaviour in ai.js that implements it (the `id` is referenced in code).

export const PAGES = [
  {
    id: 'org', ref: 'ATP 3-21.8, ch. 1 (Rifle squad & fire team)',
    title: 'Squad organization',
    text: 'A rifle squad is a squad leader and fire teams of four: team leader, automatic rifleman, grenadier, rifleman. The team leader leads by example; the automatic rifleman is the base of fire; the grenadier engages what rifles cannot reach behind cover.',
  },
  {
    id: 'movement', ref: 'ATP 3-21.8, ch. 2 (Formations & movement techniques)',
    title: 'Formations and movement',
    text: 'Move in a wedge with 10 m between men while contact is unlikely (traveling). When contact is likely, one team overwatches while the other bounds 10–20 m to the next covered position (bounding overwatch). Never bunch up.',
  },
  {
    id: 'contact', ref: 'ATP 3-21.8, Battle Drill: React to Contact',
    title: 'React to contact',
    text: 'Return fire immediately, get to the nearest cover, report the contact to the squad. The team in contact becomes the base of fire and gains fire superiority; the leader decides to assault, flank or break contact.',
  },
  {
    id: 'firemove', ref: 'ATP 3-21.8, ch. 2–3 (Fire and movement, squad attack)',
    title: 'Fire and movement / flanking',
    text: 'The support element suppresses the enemy position with sustained fire while the maneuver element moves by a covered route to the flank and assaults through. Shift fire as the assault element closes.',
  },
  {
    id: 'suppress', ref: 'FM 3-34.2, ¶1-12–1-13 (Suppress)',
    title: 'Suppression',
    text: 'Effective suppression prevents enemy fire and observation. The automatic rifleman fires sustained bursts into the last known or suspected position, even without a visible target.',
  },
  {
    id: 'sosra', ref: 'FM 3-34.2, ¶1-11–1-19 (Breaching fundamentals: SOSRA)',
    title: 'Breaching — Suppress, Obscure, Secure, Reduce, Assault',
    text: 'At an obstacle: a support element suppresses positions that can see the breach, smoke is placed between them and the breach, a man secures the flank, the breacher sets the charge, and the assault force moves through immediately after the blast.',
  },
  {
    id: 'cqb', ref: 'ATTP 3-06.11, ¶7-52, 7-95–7-100 (Entering and clearing rooms)',
    title: 'Entering and clearing a room',
    text: 'Stack on one side of the entry. If the enemy is suspected inside, throw a grenade before entry. Move through the opening fast — the doorway is a fatal funnel — and go to your point of domination along the wall. Stairwells are fatal funnels too (¶7-173).',
  },
  {
    id: 'defend', ref: 'ATP 3-21.8, ch. 6 (Defense: priorities of work)',
    title: 'Occupying a defense',
    text: 'Reconnoiter the position, then occupy fighting positions with cover. Assign each man a sector of fire over the likely avenues of approach (doors, windows, openings). Cross adjacent sectors so fires interlock and no entry point is left uncovered. The automatic rifleman covers the most likely approach.',
  },
  {
    id: 'obstacles', ref: 'FM 5-102, ch. 1–3 (Obstacle integration)',
    title: 'Obstacles covered by fire',
    text: 'Obstacles must be covered by observation and fire. Emplace claymores along the likely entry routes inside your sectors so that anyone using them is engaged by the mine and by the gun covering it.',
  },
  {
    id: 'alternate', ref: 'ATP 3-21.8, ch. 6 (Alternate & supplementary positions)',
    title: 'Displace to alternate positions',
    text: 'After engaging from a position, or when it is pinned by fire, move to an alternate position that covers the same sector. Shift to cover a new direction when the enemy appears there.',
  },
  {
    id: 'search', ref: 'ATP 3-21.8, ch. 2 (Movement to contact / search)',
    title: 'Lost contact',
    text: 'When contact is lost, keep the last known position under observation and move cautiously in pairs to re-establish contact. Sounds of fire and incoming rounds give the direction of the enemy.',
  },
  {
    id: 'break', ref: 'ATP 3-21.8, Battle Drill: Break Contact',
    title: 'Break contact',
    text: 'When the unit can no longer fight effectively, suppress, use smoke, and bound back to a covered position.',
  },
  {
    id: 'discipline', ref: 'ATP 3-21.8, ch. 2 (Fire control)',
    title: 'Fire discipline',
    text: 'Never fire with a friend in the line of fire. Aimed shots at seen targets; bursts only for suppression.',
  },
];

/**
 * Difficulty = how big and how well-trained the opposing force is.
 * The hardest setting is a full Marine rifle squad: squad leader + 3 fire teams = 13.
 */
export const PROFILES = {
  RECRUIT: {
    label: 'Recruit fire team', size: 4, blurb: '4 poorly trained riflemen. Slow to spot you, slow to react, no grenades, little coordination.',
    reaction: 1.1, aimErr: 0.10, spot: 0.7, hearing: 25, frags: 0, gl: 0, smokes: 0, claymores: 0, charges: 1,
    pages: ['org', 'contact', 'defend', 'discipline', 'search'],
  },
  REGULAR: {
    label: 'Regular section', size: 7, blurb: '7 soldiers. React to contact, suppress, simple flanking. A few grenades.',
    reaction: 0.75, aimErr: 0.07, spot: 1.0, hearing: 35, frags: 1, gl: 2, smokes: 1, claymores: 1, charges: 2,
    pages: ['org', 'movement', 'contact', 'firemove', 'suppress', 'defend', 'cqb', 'discipline', 'search'],
  },
  VETERAN: {
    label: 'Veteran squad', size: 9, blurb: 'Squad leader + 2 fire teams. Bounding overwatch, flanking, full SOSRA breaching, claymores, alternate positions.',
    reaction: 0.5, aimErr: 0.045, spot: 1.3, hearing: 45, frags: 2, gl: 4, smokes: 1, claymores: 2, charges: 2,
    pages: PAGES.map((p) => p.id),
  },
  MARINES: {
    label: 'Marine rifle squad', size: 13, blurb: 'A full USMC rifle squad: squad leader + 3 fire teams with automatic riflemen and grenadiers. Everything in the manual, executed fast.',
    reaction: 0.3, aimErr: 0.03, spot: 1.7, hearing: 55, frags: 2, gl: 6, smokes: 2, claymores: 3, charges: 3,
    pages: PAGES.map((p) => p.id),
  },
};

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

export const knows = (profile, id) => profile.pages.includes(id);
