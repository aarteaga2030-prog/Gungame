// ─────────────────────────────────────────────────────────────────────────────
// C. "YOUTUBE SHORTS" BREAKDOWN REEL — commentary generator
//
// Builds a 5-beat script (HOOK → SETUP → CRUX → CONSEQUENCE → TAKEAWAY) from what
// actually happened in the round, in the voice of a viral tactical narrator, and
// grounds each crux in the manuals:
//   FM 3-34.2 (Combined-Arms Breaching) · ATP 3-21.8 (Infantry Platoon & Squad)
//   FM 5-102 (Countermobility) · ATTP 3-06.11 (Combined Arms Ops in Urban Terrain)
// Each beat is ~2 s on screen, so the reel lands in ~10 s.
// ─────────────────────────────────────────────────────────────────────────────

const ts = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const pick = (arr, seed) => arr[Math.abs(seed | 0) % arr.length];

export function buildScript(r) {
  const seed = Math.floor(r.time * 10) + r.level.id;
  const L = [];
  const firstBreach = r.breaches[0];
  const b0 = firstBreach ? ts(firstBreach.t) : null;

  if (r.win) {
    if (r.mode === 'breach') {
      const allSosra = r.breaches.length > 0 && r.breaches.every((b) => b.s && b.o && b.sec);
      const inWindow = r.breaches.filter((b) => b.kind === 'charge' && b.assaultDelay != null && b.assaultDelay <= 1.8);
      L.push(pick([
        `${r.stats.kills} defenders. ${ts(r.time)}. ${r.casualties ? r.casualties + ' casualties.' : 'Zero casualties.'} Here's how.`,
        `This is what a ${r.perfect ? 'PERFECT' : 'clean'} breach looks like. Watch the sequence.`,
        `They had the doors covered. It didn't matter. Here's why.`,
      ], seed));
      if (allSosra) {
        L.push(`Before the charge goes on, the gun is ALREADY talking. Suppress first — enemy accuracy drops to 5%.`);
        L.push(`Smoke between the breach and the shooters. FM 3-34.2: you don't reduce until suppression AND obscuration are in place.`);
      } else if (r.stats.smokesUsed || r.stats.suppressionTime > 3) {
        L.push(`Fire superiority first: ${r.stats.suppressionTime.toFixed(0)} seconds of suppression${r.stats.smokesUsed ? ` and ${r.stats.smokesUsed} smoke` : ''} — the defenders never got a clean sight picture.`);
        L.push(r.breaches.length ? `But look at ${b0}: the sequence wasn't complete. Suppress, Obscure, Secure, Reduce, Assault — every letter, every time.` : `No charge needed — they took the door the quiet way and owned the room before anyone reacted.`);
      } else {
        L.push(`No smoke, barely any suppression — they won the gunfight on reaction time alone.`);
        L.push(`That works on a drill. Against a coordinated defense, ATP 3-21.8 says the guy in the doorway is the guy who dies.`);
      }
      if (inWindow.length) L.push(`Charge pops — overpressure stuns everyone in the room. They're through the hole ${inWindow[0].assaultDelay.toFixed(1)}s later. Inside the 1.5-second window.`);
      else if (r.breaches.some((b) => b.kind === 'charge')) L.push(`The charge stunned them — but the assault was late. Every tenth of a second outside that 1.5 s window is a free shot for the defender.`);
      else L.push(`Through the door, off the fatal funnel, straight to the point of domination (ATTP 3-06.11, 7-99).`);
      L.push(r.perfect ? `Perfect breach. That's the standard. 🔥` : `Mission complete — but not perfect. Run it back and chase the S rank.`);
    } else {
      L.push(pick([`${r.stats.kills} attackers. ${r.casualties ? r.casualties + ' casualties' : 'Zero casualties'}. This is a defense done right.`, `They came in ${r.level.waves.length} waves. None of them made it. Watch the sectors.`], seed));
      L.push(r.interlocks ? `${r.interlocks} pair${r.interlocks > 1 ? 's' : ''} of interlocking sectors — lines of fire crossing at 45 to 90 degrees. Nowhere to hide in that killzone.` : `No interlocking sectors — each gunner fought alone. It held, but it shouldn't have.`);
      L.push(r.stats.claymoreKills ? `Claymores tied into the obstacle: ${r.stats.claymoreKills} kills before they even saw us. FM 5-102 — obstacles only work when covered by fire.` : `Wire slows them, fire kills them. That's obstacle integration straight out of FM 5-102.`);
      L.push(r.objectiveContested ? `They got close to the objective, though. Too close. Push the engagement area further out.` : `They never even got within six meters of the objective.`);
      L.push(r.perfect ? `Flawless defense. ATP 3-21.8 would be proud. 🛡️` : `Position held. Now do it flawless.`);
    }
    return finalize(L);
  }

  // ───── defeats ─────
  const reason = r.reason;
  const info = r.info || {};
  L.push(r.time < 6
    ? `${Math.max(1, Math.ceil(r.time))} second${r.time > 1 ? 's' : ''}. That's how long this ${r.mode === 'breach' ? 'breach' : 'defense'} lasted. 👀`
    : pick([`Watch this ${r.mode === 'breach' ? 'breach' : 'defense'} fall apart. 👀`, `Everything was fine… until ${ts(r.time)}. Look closely.`, `This is the mistake that gets entire squads killed.`], seed));

  if (reason === 'sosra') {
    const miss = info.missing || [];
    const winDow = info.shooter && info.shooter.window;
    if (miss.includes('SUPPRESS')) {
      L.push(`${ts(r.time)}: the breacher starts setting the charge. But look at that ${winDow ? 'WINDOW' : 'overwatch position'}. Nobody suppressed it.`);
      L.push(`FM 3-34.2 is crystal clear: reduction CANNOT happen until effective suppression and obscuration are in place.`);
    } else if (miss.includes('OBSCURE')) {
      L.push(`${ts(r.time)}: the gun is suppressing — but there's no smoke. The reduction area is naked to observation.`);
      L.push(`FM 3-34.2: obscuration protects the forces conducting reduction. No smoke, no breach.`);
    } else {
      L.push(`${ts(r.time)}: suppression and smoke are up — but nobody secured the flank. The breach force is wide open.`);
      L.push(`FM 3-34.2: the point of breach must be secured before any effort to reduce the obstacle.`);
    }
    L.push(`One unanswered position and the whole breach element collapses. Mission over.`);
    L.push(`Suppress. Obscure. Secure. THEN reduce. Every. Single. Time.`);
  } else if (reason === 'bunch') {
    L.push(`${ts(r.time)}: ${info.count || 3} men stacked inside the same doorway.`);
    L.push(`That door is a fatal funnel — the defenders' sectors were already pre-aimed and crossing right on it.`);
    L.push(`More than two bodies in the choke for 1.5 seconds and the crossfire does the rest. Squad wiped.`);
    L.push(`ATTP 3-06.11: move THROUGH the opening fast, clear the funnel, get to your point of domination.`);
  } else if (reason === 'bunch_open') {
    L.push(`${ts(r.time)}: the squad bunches up in the open. Three men inside two meters.`);
    L.push(`Against an enemy with pre-registered fires, a cluster is a target reference point.`);
    L.push(`One volley. Entire squad gone.`);
    L.push(`Dispersion isn't optional. Keep your interval.`);
  } else if (reason === 'overrun') {
    L.push(`${ts(r.time)}: an attacker walks straight onto the objective.`);
    L.push(r.interlocks ? `The sectors interlocked — but there was a gap on the avenue they actually used.` : `No interlocking sectors. Each gunner covered his own little slice and the gaps between them were a highway.`);
    L.push(`ATP 3-21.8: sectors of fire must overlap and tie into obstacles so there is no dead space.`);
    L.push(`Re-plan your sectors. Cross them at 45 to 90 degrees over the wire.`);
  } else {
    // player killed
    const cause = info.cause;
    if (info.funnel) {
      L.push(`${ts(r.time)}: the lead steps into the doorway — and just stands there.`);
      L.push(`That's the fatal funnel. Every defender in the room is already aimed at it — reaction time cut in half, accuracy nearly doubled.`);
      L.push(r.stats.smokesUsed ? `Smoke couldn't save a man who paused in the opening.` : `No smoke, no suppression, no flashbang effect. Just a silhouette in a doorframe.`);
      L.push(`ATTP 3-06.11: minimize exposure by moving RAPIDLY through the opening. Never stop in the door.`);
    } else if (cause === 'mortar') {
      L.push(`${ts(r.time)}: lingering in the open — inside a pre-registered mortar zone.`);
      L.push(`The enemy zeroed that ground before you showed up. One second of observation is all they need.`);
      L.push(`Smoke would have blinded the observer. Instead: rounds on target.`);
      L.push(`If the ground is orange, you're either in smoke or you're sprinting.`);
    } else if (cause === 'claymore') {
      L.push(`${ts(r.time)}: straight through the front of a claymore.`);
      L.push(`FM 5-102: obstacles are sited to canalize you into the killzone. That one did its job.`);
      L.push(`Approach from the back side and disarm — three seconds, under smoke.`);
      L.push(`Watch the red lines. They're there for a reason.`);
    } else if (info.wire) {
      L.push(`${ts(r.time)}: crawling through the wire at 20 percent speed.`);
      L.push(`The wire isn't meant to stop you. It's meant to HOLD you in front of the guns.`);
      L.push(`FM 5-102: an obstacle covered by fire. Cut a lane under suppression and smoke — don't wade through it.`);
      L.push(`Obstacle plus fire equals killzone. Every time.`);
    } else if (cause === 'blast') {
      L.push(`${ts(r.time)}: the charge goes off — and the breacher is still standing next to it.`);
      L.push(`Set the charge, step off the wall, then use the overpressure. Not the other way around.`);
      L.push(`Stand-off distance is part of the drill.`);
      L.push(`Respect your own explosives.`);
    } else if (cause === 'fratricide') {
      L.push(`${ts(r.time)}: blue on blue.`);
      L.push(`Muzzle discipline. Know where every friendly is before you press the trigger.`);
      L.push(`Sectors of fire exist for your own squad too.`);
      L.push(`Fratricide is still a casualty.`);
    } else if (info.by && info.by.mg) {
      L.push(`${ts(r.time)}: the lead crosses the machine gun's principal direction of fire.`);
      L.push(`That gun was paired with another — interlocking fire across the only approach.`);
      L.push(`No suppression on the gun, no smoke on the approach. Grazing fire does the rest.`);
      L.push(`Kill the gun or blind it. Never walk into its sector.`);
    } else {
      L.push(`${ts(r.time)}: the lead takes contact ${r.stats.suppressionTime < 2 ? 'with zero suppression on the enemy' : 'and loses the gunfight'}.`);
      L.push(r.stats.suppressionTime < 2 ? `The defenders had full accuracy and all the time in the world. Suppression would have pinned them to 5 percent.` : `The suppression was there — but it wasn't on the shooter who mattered.`);
      L.push(`FM 3-34.2: effective suppression is mission-critical. It's what triggers everything else.`);
      L.push(`Win the fire fight first. Then move.`);
    }
  }
  return finalize(L.slice(0, 5));
}

function finalize(lines) {
  const out = lines.slice(0, 5);
  while (out.length < 5) out.push('Run it back.');
  return out.map((text) => ({ text, words: text.split(' ') }));
}

// Static reference scripts (deliverable C) — used in DESIGN.md and as a fallback.
export const SAMPLE_VICTORY = [
  'Five defenders. Forty-one seconds. Zero casualties. Here\'s how.',
  'Before the charge goes on, the gun is ALREADY talking. Suppress first — enemy accuracy drops to 5%.',
  'Smoke between the breach and the window. FM 3-34.2: you don\'t reduce until suppression AND obscuration are in place.',
  'Charge pops — overpressure stuns everyone in the room. They\'re through the hole 0.8 seconds later. Inside the window.',
  'Perfect breach. That\'s the standard. 🔥',
];
export const SAMPLE_DEFEAT = [
  'Watch this breach fall apart in under three seconds. 👀',
  '0:14 — the breacher starts setting the charge. But look at that WINDOW. Nobody suppressed it.',
  'FM 3-34.2 is crystal clear: reduction CANNOT happen until effective suppression and obscuration are in place.',
  'One unanswered position and the whole breach element collapses. Mission over.',
  'Suppress. Obscure. Secure. THEN reduce. Every. Single. Time.',
];
