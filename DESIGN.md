# KILLHOUSE // SIM — Design

## 1. Structure

* **No levels.** You pick a map (12 maps, terrain only), a mission (Breach or Defend), an enemy force and 0–3 AI teammates.
* **Solo or online co-op.** One browser runs the authoritative simulation: the solo player's, or the host's. Other players send their input (movement, aim, action counters) and render snapshots sent 12 times a second, with interpolation and prediction for their own movement.
* **Full control.** Every player is one soldier with a rifle (semi-auto), frags and smoke. Attackers also carry breaching charges and defenders carry claymores. Any wall, door or barricade can be blown, and any door can be opened or closed.
* **No scripted outcomes.** The SOSRA tracker, the instant-loss rules, the mortar zones and the crossfire wipes are all gone. Damage always falls off with distance: a round does 33–45, frags and charges do up to 80–90 at the centre, and walls block blasts.

| Outcome | Breach (you attack) | Defend (you hold) |
|---|---|---|
| Win | every defender is down | the clock runs out (5 min), or every attacker is down |
| Lose | your side is down, or the 10-minute clock runs out | your side is down, or attackers hold the objective for 8 s with none of you within 10 m |

The defending side gets a prep phase: 20 s when the AI defends, 45 s when you do. During prep, attackers must stay in their staging area.

## 2. The AI's knowledge

| The AI has | The AI does **not** have |
|---|---|
| Its training: the pages in `doctrine.js` | The map layout |
| Its own squad's positions (radio) | Where you are, or where you will come from |
| For an attack, the order "seize the objective at grid X" | Any pre-computed fire plan or kill zone |

* **Belief map.** Each soldier casts vision rays (a 140° cone out to 45 m, plus a 5 m ring around him). Every tile a ray crosses is recorded with what is really there. Paths, fighting positions, sectors and breach points are all planned on this belief map, and unknown ground is treated as passable until seen.
* **Spotting takes time.** A soldier needs line of sight inside his field of view. A detection meter then fills at a rate set by distance, your stance (crouching ×0.6), your movement (×1.4), whether you just fired (×2.5), his own suppression and his own stun. Smoke blocks it.
* **Hearing.** Gunfire and explosions inside the profile's hearing range create a contact. Its position error grows with distance (σ is about 12% of the distance).
* **Incoming fire.** A near miss or a hit tells the soldier the rough direction and distance of the shooter.
* **Contacts.** The squad shares contacts by radio, and they expire after 45 s.

## 3. Doctrine pages and how they drive behaviour

| Page | Source | Behaviour in `ai.js` |
|---|---|---|
| Squad organization | ATP 3-21.8 ch.1 | the force is built as SL + fire teams of TL, AR, GR, RF |
| Formations & movement | ATP 3-21.8 ch.2 | wedge per fire team; bounding overwatch by team inside 45 m of the objective |
| React to contact | ATP 3-21.8 battle drill | return fire, move to cover from the threat (belief LOS or low cover between), report |
| Fire and movement | ATP 3-21.8 ch.2–3 | the team closest to the contact becomes the base of fire; another team flanks along a route that avoids the contact's line of sight, then assaults |
| Suppression | FM 3-34.2 ¶1-12 | the AR fires sustained bursts into the last known position without a visible target; riflemen add fire |
| SOSRA | FM 3-34.2 ¶1-11–1-19 | at the first door, wall or wire on the route: support suppresses known windows and contacts near the breach, smoke goes between them and the breach, one man secures the flank, the breacher sets the charge, and the stack assaults straight after the blast |
| Entering and clearing | ATTP 3-06.11 ¶7-52, 7-95–7-100 | frag before entry, sprint through the doorway (fatal funnel), alternate left and right to points of domination, move through the building as a file, stack and breach inner doors and barricades |
| Occupying a defense | ATP 3-21.8 ch.6 | reconnoiter the building first, then pick positions that see the known doors and windows (never in a doorway), assign sectors, reward lines crossing an existing coverer at 45–90° (interlocking); the AR takes the most likely approach |
| Obstacles covered by fire | FM 5-102 | claymores placed 2.6 m inside covered doors, facing them |
| Alternate positions | ATP 3-21.8 ch.6 | displace to the alternate position when pinned |
| Lost contact | ATP 3-21.8 ch.2 | the nearest pair moves to clear a heard-but-unseen contact inside the position, throwing a frag first |
| Break contact | ATP 3-21.8 battle drill | above 70% losses: smoke, then fall back |
| Fire discipline | ATP 3-21.8 ch.2 | never fire with a friendly in the line of fire |

## 4. Enemy forces

| Profile | Size | Reaction | Aim error (σ) | Spot rate | Hearing | Kit | Pages trained |
|---|---|---|---|---|---|---|---|
| Recruit fire team | 4 | 1.1 s | 0.10 rad | 0.7 | 25 m | — | 5 of 13 |
| Regular section | 7 | 0.75 s | 0.07 rad | 1.0 | 35 m | 1 frag, 2×40 mm, smoke, 1 claymore | 9 of 13 |
| Veteran squad | 9 | 0.5 s | 0.045 rad | 1.3 | 45 m | 2 frags, 4×40 mm, smoke, 2 claymores | all |
| Marine rifle squad | 13 | 0.3 s | 0.03 rad | 1.7 | 55 m | 2 frags, 6×40 mm, 2 smoke, 3 claymores | all |

At the top setting a "full squad of Marines" means 13 riflemen who react in 0.3 s, aim to within about 1.7°, spot a moving man in a fraction of a second, use 40 mm grenades on positions they can't see, flank, and breach their own entry points.
