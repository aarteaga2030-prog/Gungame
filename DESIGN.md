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

## 3. Training: nearly every page of the manuals

`tools/mkmanual.py` reads the four PDFs (via pdftotext) and writes `src/manual.js`, which has one entry per PDF page: manual, page, paragraph range, heading and a bitmask of the 26 topics that page teaches. Topics include organization, movement, contact, fire and movement, suppression, obscuration, breaching, room clearing, stairs, windows, defense, interlocking fires, obstacles, cover, grenades, alternate positions, counterattack, ambush and engagement areas, search, break contact, casualty care, fire control, urban terrain, communications, security and planning.

| Manual | Pages | Trained |
|---|---|---|
| FM 3-34.2 Combined-Arms Breaching Operations | 149 | 131 |
| ATP 3-21.8 Infantry Rifle Platoon and Squad | 596 | 532 |
| FM 5-102 Countermobility | 218 | 181 |
| ATTP 3-06.11 Combined Arms Operations in Urban Terrain | 284 | 254 |
| **Total** | **1,247** | **1,098** |

The 149 pages left out are covers, tables of contents, indexes, glossaries, reference lists and blank pages. Figure-only pages are trained.

Every force at every difficulty is trained on all 1,098 pages. A drill is enabled only when the force has studied at least half of the pages that teach its topics, which with full training is all of them. Difficulty no longer removes knowledge. It changes size, experience (reaction, aim, spotting, hearing, how fast decisions are made) and kit.

### Drills (`ai.js`), each gated by its topics

| Drill | Topics | What the AI does |
|---|---|---|
| Squad organization | org | SL plus fire teams of TL, AR, GR, RF |
| Formations / bounding overwatch | movement | wedge; within 45 m of the objective, teams alternate bounding, and the overwatching team's last man faces the rear |
| React to contact | contact, cover | return fire, go to cover from the threat (cover, not just concealment), report |
| Fire and movement | firemove | the team in contact is the base of fire; another team flanks on a route that avoids the contact's line of sight, then assaults |
| Crossing danger areas | obscure, movement | the flank team smokes the open ground before crossing it |
| Suppression | suppress | AR bursts and rifle fire into the last known position |
| SOSRA breaching | breach, obscure, suppress | suppress windows and contacts that see the breach, smoke, secure the flank, charge, assault |
| Entering and clearing rooms | cqb, urban | frag first, sprint through doorways, points of domination; one fire team clears in file while the rest trail with security; inner doors and barricades get their own breach |
| Stairwells | stairs | defenders treat stairs as entry points to cover; attackers never stop on stairs |
| Fire from inside the room | windows, urban | defenders avoid standing in windows and prefer positions back in the room or elevated |
| Move along walls | urban, movement | attackers' routes favour tiles next to walls or cover |
| Occupying a defense | defense | recon, then covered positions with sectors over known doors, windows and stairs, never in a doorway |
| Interlocking sectors | interlock | reward a second coverer crossing at 45–90° |
| Obstacles covered by fire | obstacles | claymores inside covered doors |
| Hold fire for the engagement area | ambush, firecontrol | concealed defenders hold fire beyond 22 m until compromised or until someone initiates |
| Target priority | firecontrol | whoever is shooting at me, then automatic weapons and leaders, then the nearest |
| Alternate positions | alternate | displace when pinned |
| Counterattack | counterattack | an enemy foothold within 12 m of the position draws a team-sized counterattack |
| Re-establish lost contact | search | a pair moves on a heard-but-unseen contact |
| Casualty care under fire | casualty | the wounded (<45 HP) go to cover and the nearest buddy covers them for 8 s |
| 360° security | security | consolidate facing out; rear security on halts |
| Grenades | grenades | frags into rooms, 40 mm on unseen positions |
| Break contact | break | above 70% losses: smoke, then fall back |
| Report contacts | comms | every contact is shared squad-wide |
| Fire discipline | firecontrol | no firing with a friend in the line |

## 4. AI vs AI

`Sim` takes `blueForce`. Blue then becomes a full AI force with its own TeamAI (attack or defend, from the mission). Each side has its own belief map and contacts, and neither side sees the other's knowledge. Hosting an AI-vs-AI match online works like a normal game: the host simulates, and everyone in the room spectates from snapshots.

## 5. Forces

| Profile | Size | Reaction | Aim error (σ) | Spot rate | Hearing | Kit | Pages trained |
|---|---|---|---|---|---|---|---|
| Recruit fire team | 4 | 1.1 s | 0.10 rad | 0.7 | 25 m | 1 frag, 2×40 mm, smoke, 1 claymore | 1,098 |
| Regular section | 7 | 0.75 s | 0.07 rad | 1.0 | 35 m | 1 frag, 3×40 mm, smoke, 1 claymore | 1,098 |
| Veteran squad | 9 | 0.5 s | 0.045 rad | 1.3 | 45 m | 2 frags, 4×40 mm, smoke, 2 claymores | 1,098 |
| Marine rifle squad | 13 | 0.3 s | 0.03 rad | 1.7 | 55 m | 2 frags, 6×40 mm, 2 smoke, 3 claymores | 1,098 |

At the top setting a "full squad of Marines" means 13 riflemen who react in 0.3 s, aim to within about 1.7°, spot a moving man in a fraction of a second, use 40 mm grenades on positions they can't see, flank, and breach their own entry points.
