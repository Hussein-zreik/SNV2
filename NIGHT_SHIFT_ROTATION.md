# Night and weekend rotation

How the scheduler decides whose turn it is for nights and weekends. This describes the
current engine (`turnFor()` and `computeSchedule()` in `engine.js`); the example table
below was produced by running it.

## The night turn

- **Two teams per fortnight:** one from Group A and one from Group B.
- **Team size = the N7 minimum** (Settings → Staffing minimums, default **2**). With a
  minimum of 3, three nurses from each group are on the night turn.
- **Who is eligible:** the **night list** in Settings → Night cycle. By default it is every
  RN in the order shown on screen; you can reorder it and take nurses out of it.
- **How turns move:** each group's part of the night list is cut into consecutive turns
  (with a team of 2: first and second, third and fourth, …). Each fortnight takes the next
  turn; after the last turn it starts again from the top. If the last turn is short (an
  odd number of nurses), it is completed with nurses from the top of the list, so the
  team is always full strength.

### Which nights each team works

| Team | Week 1 | Week 2 | Nights |
|---|---|---|---|
| Group A team | Mon, Tue, **Sat, Sun** | Wed, Thu, Fri | 4 + 3 = 7 |
| Group B team | Wed, Thu, Fri | Mon, Tue, **Sat, Sun** | 3 + 4 = 7 |

This matches each group's weekly split (A works 4 then 3, B works 3 then 4), so a full
night turn is exactly a nurse's fortnight.

### When a night-turn nurse has another entry

The weekly split always comes first. If you give a night-turn nurse a day duty, leave or
a request, they get nights **only up to their weekly count**, so they lose a night (the
one the evening before a day duty goes first: never a day shift straight after a night).
The lost night is then:

1. left alone if another RN already has that night entered by hand;
2. otherwise **backfilled** from the same group's night list: a nurse who is not on the
   night or weekend turn, free that night, with room in that week's split, and with no
   day duty entered for the next morning;
3. otherwise left short, and the banner says so.

## The weekend day team

- Two nurses from each group work the weekend day shift (D7, Saturday and Sunday):
  Group A's team on week 1's weekend, Group B's on week 2's.
- They are taken from the whole group in display order, starting two places further
  each fortnight, and **never** from that fortnight's night team.

## Example: the default roster

19 RNs in the default order (Group A = RN 1–10, Group B = RN 11–19), N7 minimum 2, nobody
taken out of the night list:

| Fortnight | Night team A | Night team B | Weekend team A | Weekend team B |
|---|---|---|---|---|
| 0 | RN 1 + RN 2 | RN 11 + RN 12 | RN 3 + RN 4 | RN 13 + RN 14 |
| 1 | RN 3 + RN 4 | RN 13 + RN 14 | RN 5 + RN 6 | RN 15 + RN 16 |
| 2 | RN 5 + RN 6 | RN 15 + RN 16 | RN 7 + RN 8 | RN 17 + RN 18 |
| 3 | RN 7 + RN 8 | RN 17 + RN 18 | RN 9 + RN 10 | RN 19 + RN 11 |
| 4 | RN 9 + RN 10 | RN 19 + RN 11 | RN 1 + RN 2 | RN 12 + RN 13 |
| 5 | RN 1 + RN 2 | RN 11 + RN 12 | RN 3 + RN 4 | RN 14 + RN 15 |

Both groups have five night turns here (Group B's fifth is RN 19 + RN 11), so the night
pattern repeats every 5 fortnights. The weekend teams move on a different step and repeat
on their own cycle.

Turns follow a nurse's **position** in the list, not the name: renaming a nurse changes
nothing, and dragging rows into a new order changes who is next.

## Where to see it in the app

- **Whose turn this cycle** (above the roster) shows the night and weekend teams for the
  fortnight on screen and the next one.
- **Settings → Night cycle** holds the night list. When a night-turn nurse's nights are
  blocked by day-duty entries, **Free the night turn** there clears those entries for the
  fortnight on screen so the nights can be staffed again.
