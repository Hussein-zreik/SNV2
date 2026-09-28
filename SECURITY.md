# Securing the cloud database

**Status right now:** the app signs in anonymously automatically, but your
Firestore rules are still the wide-open default (`allow read, write: if true`).
Until you do the two steps below, **anyone who finds the database can read or
change every nurse's schedule.** Nurse names and rosters are personal data.

The Cloud panel in the app tells you which state you're in:

- ⚠ *Database NOT secured* — still open, do the steps below
- 🔒 *Database secured (signed in)* — done

---

## Do these two steps in order

Order matters. If you publish the rules before enabling sign-in, the app loses
cloud access until you finish step 1.

### Step 1 — Enable Anonymous sign-in

1. Open the [Firebase console](https://console.firebase.google.com/) and pick
   the **schedule-nursing-f14e5** project.
2. Left menu: **Build → Authentication**.
3. If you've never opened it, click **Get started**.
4. Open the **Sign-in method** tab.
5. Click **Anonymous**, toggle it **Enable**, and **Save**.

### Step 2 — Publish the rules

1. Left menu: **Build → Firestore Database**.
2. Open the **Rules** tab.
3. Replace everything in the editor with the contents of
   [`firestore.rules`](./firestore.rules).
4. Click **Publish**.

### Step 3 — Check it worked

1. Hard-refresh the app (**Ctrl+Shift+R**; on a phone close the tab and reopen).
2. Open **Cloud**. It should say **🔒 Database secured (signed in)**.
3. Make a small edit on one device and confirm it still appears on another.

If the Cloud button turns red, re-check that Anonymous sign-in is enabled
(step 1), then reload.

---

## What this does and does not protect

**Protects against:** anonymous scripts and casual access to the database,
and access to any collection other than `schedules`.

**Does not protect against:** someone who both signs in anonymously *and* knows
your unit code (`pacu`). Anonymous sign-in is open to anyone by design, so the
unit code is effectively the shared secret.

**Practical advice:** treat the unit code like a password — don't put it in
anything public. Prefer something unguessable (`pacu-7f3q-x9`) over `pacu`.
You can change it any time: open **Cloud**, enter the new code, press
**Connect** on each device. (Export a backup first — a new code starts a new
empty document, then your device pushes its current schedule into it.)

## If you want proper per-person accounts

The stronger setup is one login per person instead of a shared code:

1. In **Authentication → Sign-in method**, enable **Email/Password**.
2. Add each scheduler as a user under the **Users** tab.
3. Change the rule to list who may access the unit, e.g.:

   ```
   match /schedules/{unitCode} {
     allow read, write: if request.auth != null
       && request.auth.token.email in ['you@example.com','colleague@example.com'];
   }
   ```

That also gives you a real audit trail (who changed what), which the shared
password cannot. Ask and I can wire the login screen up to it.

---

## Backups

Independently of any of this: use **Cloud → Export** regularly. It saves the
whole schedule (roster, requests, settings) to a file on your device, and
**Import** restores it. That is your safety net if data is ever lost or
overwritten — cloud sync is not a backup, because a bad change syncs everywhere.
