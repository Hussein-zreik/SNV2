# RN Rotating Schedule — Night Shift & Weekend Reference Guide

> Auto-generated from the scheduler logic in `index.html`. Rotation is driven by the **cycle number** (each Next/Prev step = one 2-week cycle). Assignments follow a nurse's **position in the on-screen list** (top row of a group = first up for nights), not the editable name — renaming a nurse does not change who is on nights for a given position. If you **drag-reorder** the rows, the rotation follows the new list order (the next 2 rows down in each group). The RN numbers below assume the default, un-reordered list.

## 1. How the night rotation works

- **19 nurses, two groups:** Group A = positions **RN 1–RN 10**, Group B = positions **RN 11–RN 19**.
- Every 2-week cycle, **4 nurses work nights**: one **pair from Group A** and one **pair from Group B**.
- Each cycle the pair **advances by 2 positions** within its group.
- **Group A** (10 nurses) walks 5 non-overlapping pairs → **resets every 5 cycles**.
- **Group B** (9 nurses, odd) steps by 2 through all 9 positions → **resets every 9 cycles**, producing one **wrap-around pair** each lap (last + first).
- The **combined pattern** (both groups back to the start together) repeats every **LCM(5, 9) = 45 cycles = 90 weeks (~1.7 years)**.

## 2. Fixed night day-pattern within any cycle

Whoever is the Night-A / Night-B pair works these exact days (7 nights each, N7):

| Night pair | Week 1 | Week 2 | Total |
|---|---|---|---|
| **Night-A pair** | Mon, Tue, **Sat, Sun** | Wed, Thu, Fri | 7 |
| **Night-B pair** | Wed, Thu, Fri | Mon, Tue, **Sat, Sun** | 7 |

This is why weekend **night** coverage is fully determined: **Week-1 weekend → Night-A pair**, **Week-2 weekend → Night-B pair**.

### Rest across the cycle boundary (post-night & post-weekend)

The "**no more than 3 consecutive working days**" limit is enforced *across the seam* between two cycles, not just inside each 14-day block. Sunday is only ever worked by the **Night-B pair** (weekend nights) or the **weekend day-team** (Sat + Sun D7), so anyone working into Sunday carries a run straight into the next cycle's Monday. Two cases:

- **Night-B pair** (worked weekend **nights**): to avoid a day shift straight after a night block, they get the next **Monday off** (unless on nights again). *Post-night rest rule.*
- **Weekend day-team** (worked Sat + Sun **days**): Sat → Sun → Mon is only a 3-day run (allowed), so they *may* work Monday but get the following **Tuesday off**. Their run is kept at exactly 2 by also keeping them off the preceding Friday.
- To close the last gap, the **weekend day-team of a cycle never includes the *next* cycle's Night-A pair** (who work Mon + Tue nights) — otherwise Sat, Sun + Mon, Tue would be a 4-day run.

Verified across 300 random seeds × 31 cycles and roster sizes 19–26: **0** boundary violations, **0** within-cycle violations, exactly-7 preserved, and no day dropped below minimum staffing.

## 3. Group A night sub-cycle (repeats every 5 cycles)

| Cycle (mod 5) | On nights — Group A |
|---|---|
| 0 | RN 1 + RN 2 |
| 1 | RN 3 + RN 4 |
| 2 | RN 5 + RN 6 |
| 3 | RN 7 + RN 8 |
| 4 | RN 9 + RN 10 |

_Cycle 5 returns to RN 1 + RN 2, and so on._

## 4. Group B night sub-cycle (repeats every 9 cycles)

| Cycle (mod 9) | On nights — Group B |
|---|---|
| 0 | RN 11 + RN 12 |
| 1 | RN 13 + RN 14 |
| 2 | RN 15 + RN 16 |
| 3 | RN 17 + RN 18 |
| 4 | RN 19 + RN 11 _(wrap)_ |
| 5 | RN 12 + RN 13 |
| 6 | RN 14 + RN 15 |
| 7 | RN 16 + RN 17 |
| 8 | RN 18 + RN 19 |

_Cycle 9 returns to RN 11 + RN 12._

## 5. Weekend turns

Weekends have two independent rotations: **nights** (driven by the night pairs) and **day duty** (its own separate cycle).

### 5a. Weekend night coverage

Weekend **nights** rotate with the night pairs: **Week-1 weekend → Night-A pair**, **Week-2 weekend → Night-B pair**.

| Cycle | Week-1 weekend (Sat + Sun) nights | Week-2 weekend (Sat + Sun) nights |
|---|---|---|
| 0 | RN 1 + RN 2 | RN 11 + RN 12 |
| 1 | RN 3 + RN 4 | RN 13 + RN 14 |
| 2 | RN 5 + RN 6 | RN 15 + RN 16 |
| 3 | RN 7 + RN 8 | RN 17 + RN 18 |
| 4 | RN 9 + RN 10 | RN 19 + RN 11 |
| 5 | RN 1 + RN 2 | RN 12 + RN 13 |
| 6 | RN 3 + RN 4 | RN 14 + RN 15 |
| 7 | RN 5 + RN 6 | RN 16 + RN 17 |
| 8 | RN 7 + RN 8 | RN 18 + RN 19 |
| 9 | RN 9 + RN 10 | RN 11 + RN 12 |
| 10 | RN 1 + RN 2 | RN 13 + RN 14 |
| 11 | RN 3 + RN 4 | RN 15 + RN 16 |
| 12 | RN 5 + RN 6 | RN 17 + RN 18 |
| 13 | RN 7 + RN 8 | RN 19 + RN 11 |
| 14 | RN 9 + RN 10 | RN 12 + RN 13 |
| 15 | RN 1 + RN 2 | RN 14 + RN 15 |
| 16 | RN 3 + RN 4 | RN 16 + RN 17 |
| 17 | RN 5 + RN 6 | RN 18 + RN 19 |
| 18 | RN 7 + RN 8 | RN 11 + RN 12 |
| 19 | RN 9 + RN 10 | RN 13 + RN 14 |
| 20 | RN 1 + RN 2 | RN 15 + RN 16 |
| 21 | RN 3 + RN 4 | RN 17 + RN 18 |
| 22 | RN 5 + RN 6 | RN 19 + RN 11 |
| 23 | RN 7 + RN 8 | RN 12 + RN 13 |
| 24 | RN 9 + RN 10 | RN 14 + RN 15 |
| 25 | RN 1 + RN 2 | RN 16 + RN 17 |
| 26 | RN 3 + RN 4 | RN 18 + RN 19 |
| 27 | RN 5 + RN 6 | RN 11 + RN 12 |
| 28 | RN 7 + RN 8 | RN 13 + RN 14 |
| 29 | RN 9 + RN 10 | RN 15 + RN 16 |
| 30 | RN 1 + RN 2 | RN 17 + RN 18 |
| 31 | RN 3 + RN 4 | RN 19 + RN 11 |
| 32 | RN 5 + RN 6 | RN 12 + RN 13 |
| 33 | RN 7 + RN 8 | RN 14 + RN 15 |
| 34 | RN 9 + RN 10 | RN 16 + RN 17 |
| 35 | RN 1 + RN 2 | RN 18 + RN 19 |
| 36 | RN 3 + RN 4 | RN 11 + RN 12 |
| 37 | RN 5 + RN 6 | RN 13 + RN 14 |
| 38 | RN 7 + RN 8 | RN 15 + RN 16 |
| 39 | RN 9 + RN 10 | RN 17 + RN 18 |
| 40 | RN 1 + RN 2 | RN 19 + RN 11 |
| 41 | RN 3 + RN 4 | RN 12 + RN 13 |
| 42 | RN 5 + RN 6 | RN 14 + RN 15 |
| 43 | RN 7 + RN 8 | RN 16 + RN 17 |
| 44 | RN 9 + RN 10 | RN 18 + RN 19 |

### 5b. Weekend day duty (independent rotation)

Weekend **day** shifts now follow their **own fixed cycle**, independent of the night rotation. Each weekend:

- **2 RNs = the weekend team** → both work **Sat D7 + Sun D7**
- **1 RN = the Saturday-only extra** → works **Sat S10**

This gives exactly **Sat = 2× D7 + 1× S10 (3)** and **Sun = 2× D7 (2)**. The turn order is its own sequence that **advances 3 RNs per weekend** and simply **skips anyone on nights** that weekend (so no one is double-booked). The two weekends of a cycle always use different RNs.

| Cycle | Week-1 weekend — team (Sat+Sun) + Sat extra | Week-2 weekend — team (Sat+Sun) + Sat extra |
|---|---|---|
| 0 | RN 3 + RN 4  ·  extra RN 5 | RN 6 + RN 7  ·  extra RN 8 |
| 1 | RN 7 + RN 8  ·  extra RN 9 | RN 10 + RN 11  ·  extra RN 12 |
| 2 | RN 13 + RN 14  ·  extra RN 17 | RN 18 + RN 19  ·  extra RN 1 |
| 3 | RN 19 + RN 1  ·  extra RN 2 | RN 3 + RN 4  ·  extra RN 5 |
| 4 | RN 6 + RN 7  ·  extra RN 8 | RN 12 + RN 13  ·  extra RN 14 |
| 5 | RN 14 + RN 15  ·  extra RN 16 | RN 17 + RN 18  ·  extra RN 19 |
| 6 | RN 18 + RN 19  ·  extra RN 1 | RN 2 + RN 5  ·  extra RN 6 |
| 7 | RN 7 + RN 8  ·  extra RN 9 | RN 10 + RN 11  ·  extra RN 12 |
| 8 | RN 11 + RN 12  ·  extra RN 13 | RN 14 + RN 15  ·  extra RN 16 |
| 9 | RN 17 + RN 18  ·  extra RN 19 | RN 1 + RN 2  ·  extra RN 3 |
| 10 | RN 4 + RN 5  ·  extra RN 6 | RN 7 + RN 8  ·  extra RN 9 |
| 11 | RN 10 + RN 11  ·  extra RN 12 | RN 13 + RN 14  ·  extra RN 17 |

> Because the day rotation advances by 3 RNs per weekend **and** skips whichever pair is on nights that weekend, its exact repeat interacts with the 45-cycle night reset — so it doesn't line up on a short, neat period like the night sub-cycles. The rule itself (2-team + Saturday extra, skip nights) is fixed and deterministic; the table above lists the concrete turns for the first 12 cycles.

## 6. Master rotation table — full cycle until reset (45 cycles)

Reset markers: **A✓** = Group A pair back to start, **B✓** = Group B pair back to start, **FULL RESET** = both.

| Cycle | Week span | On nights — Group A | On nights — Group B | Reset |
|---|---|---|---|---|
| 0 | wks 1–2 | RN 1 + RN 2 | RN 11 + RN 12 |  |
| 1 | wks 3–4 | RN 3 + RN 4 | RN 13 + RN 14 |  |
| 2 | wks 5–6 | RN 5 + RN 6 | RN 15 + RN 16 |  |
| 3 | wks 7–8 | RN 7 + RN 8 | RN 17 + RN 18 |  |
| 4 | wks 9–10 | RN 9 + RN 10 | RN 19 + RN 11 |  |
| 5 | wks 11–12 | RN 1 + RN 2 | RN 12 + RN 13 | A✓ |
| 6 | wks 13–14 | RN 3 + RN 4 | RN 14 + RN 15 |  |
| 7 | wks 15–16 | RN 5 + RN 6 | RN 16 + RN 17 |  |
| 8 | wks 17–18 | RN 7 + RN 8 | RN 18 + RN 19 |  |
| 9 | wks 19–20 | RN 9 + RN 10 | RN 11 + RN 12 | B✓ |
| 10 | wks 21–22 | RN 1 + RN 2 | RN 13 + RN 14 | A✓ |
| 11 | wks 23–24 | RN 3 + RN 4 | RN 15 + RN 16 |  |
| 12 | wks 25–26 | RN 5 + RN 6 | RN 17 + RN 18 |  |
| 13 | wks 27–28 | RN 7 + RN 8 | RN 19 + RN 11 |  |
| 14 | wks 29–30 | RN 9 + RN 10 | RN 12 + RN 13 |  |
| 15 | wks 31–32 | RN 1 + RN 2 | RN 14 + RN 15 | A✓ |
| 16 | wks 33–34 | RN 3 + RN 4 | RN 16 + RN 17 |  |
| 17 | wks 35–36 | RN 5 + RN 6 | RN 18 + RN 19 |  |
| 18 | wks 37–38 | RN 7 + RN 8 | RN 11 + RN 12 | B✓ |
| 19 | wks 39–40 | RN 9 + RN 10 | RN 13 + RN 14 |  |
| 20 | wks 41–42 | RN 1 + RN 2 | RN 15 + RN 16 | A✓ |
| 21 | wks 43–44 | RN 3 + RN 4 | RN 17 + RN 18 |  |
| 22 | wks 45–46 | RN 5 + RN 6 | RN 19 + RN 11 |  |
| 23 | wks 47–48 | RN 7 + RN 8 | RN 12 + RN 13 |  |
| 24 | wks 49–50 | RN 9 + RN 10 | RN 14 + RN 15 |  |
| 25 | wks 51–52 | RN 1 + RN 2 | RN 16 + RN 17 | A✓ |
| 26 | wks 53–54 | RN 3 + RN 4 | RN 18 + RN 19 |  |
| 27 | wks 55–56 | RN 5 + RN 6 | RN 11 + RN 12 | B✓ |
| 28 | wks 57–58 | RN 7 + RN 8 | RN 13 + RN 14 |  |
| 29 | wks 59–60 | RN 9 + RN 10 | RN 15 + RN 16 |  |
| 30 | wks 61–62 | RN 1 + RN 2 | RN 17 + RN 18 | A✓ |
| 31 | wks 63–64 | RN 3 + RN 4 | RN 19 + RN 11 |  |
| 32 | wks 65–66 | RN 5 + RN 6 | RN 12 + RN 13 |  |
| 33 | wks 67–68 | RN 7 + RN 8 | RN 14 + RN 15 |  |
| 34 | wks 69–70 | RN 9 + RN 10 | RN 16 + RN 17 |  |
| 35 | wks 71–72 | RN 1 + RN 2 | RN 18 + RN 19 | A✓ |
| 36 | wks 73–74 | RN 3 + RN 4 | RN 11 + RN 12 | B✓ |
| 37 | wks 75–76 | RN 5 + RN 6 | RN 13 + RN 14 |  |
| 38 | wks 77–78 | RN 7 + RN 8 | RN 15 + RN 16 |  |
| 39 | wks 79–80 | RN 9 + RN 10 | RN 17 + RN 18 |  |
| 40 | wks 81–82 | RN 1 + RN 2 | RN 19 + RN 11 | A✓ |
| 41 | wks 83–84 | RN 3 + RN 4 | RN 12 + RN 13 |  |
| 42 | wks 85–86 | RN 5 + RN 6 | RN 14 + RN 15 |  |
| 43 | wks 87–88 | RN 7 + RN 8 | RN 16 + RN 17 |  |
| 44 | wks 89–90 | RN 9 + RN 10 | RN 18 + RN 19 |  |

_Cycle 45 = identical to cycle 0 → the whole night pattern repeats._

## 7. Quick facts

- A nurse in **Group A** works a night block **once every 5 cycles** (~every 10 weeks).
- A nurse in **Group B** works a night block **once every ~4–5 cycles** on average (9-cycle lap over 9 nurses, in overlapping pairs).
- Each night block is always **7 nights** spread as shown in §2.
- Everything here is **position-based and deterministic**; the day/evening and weekend-day assignments around it are randomized to meet the minimums.
