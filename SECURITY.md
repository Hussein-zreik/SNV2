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
your unit code. Anonymous sign-in is open to anyone by design, so the unit code
is effectively the shared secret.

**Practical advice:** treat the unit code like a password — never write it in
this repository (it is public), in a screenshot, or in a chat. Use something
long and unguessable (for example a ward name plus 8 random characters), not a
short word.

> **If your unit code has ever appeared in this repository's files or history,
> consider it public and change it now** (steps below). An earlier version of
> this file named one.
You can change it any time: open **Cloud**, enter the new code, press
**Connect** on each device. (Export a backup first — a new code starts a new
empty document, then your device pushes its current schedule into it.)

## Staff request link

Staff open a link (`request.html?f=…`), pick their name and the day(s) they want
off, write a reason and send it. You read what arrives in the app under
**Staff requests**. It is a reference list: nothing a nurse sends changes the roster.

### Set it up (once, in this order)

1. **Anonymous sign-in must already be on** (Step 1 at the top of this file). The
   rules you publish in step 4 require it for the roster sync.
2. **Switch on Email/Password.** Firebase console → **Build → Authentication →
   Sign-in method → Email/Password → Enable → Save**. (Leave "Email link" off.)
3. **Create your manager account.** Authentication → **Users → Add user**. Enter
   your email and a strong password that you use nowhere else. This is the only
   account that will be able to read staff requests.
4. **Close public sign-up.** Authentication → **Settings → User actions** → untick
   **Enable create (sign-up)** → Save. Otherwise a stranger could make an account
   in your project. (They still could not read your requests — see below — but
   there is no reason to allow it.)
5. **Publish the rules.** Firestore Database → **Rules** → replace everything with
   the contents of [`firestore.rules`](./firestore.rules) → **Publish**.
6. **Create the link.** In the app: **Staff requests** → sign in with the account
   from step 3 → type the ward name → **Create the staff link** → **Copy link** →
   send it to your staff (WhatsApp group, email).

### Check it worked

1. Open the link on your phone, send a test request, and watch it appear in
   **Staff requests** on your computer within a few seconds.
2. On the phone, the page must show only the form — never anyone's requests.
3. Press **Pause**, reload the phone: it must say "Requests are closed". Press
   **Resume**.

### What it protects, and what it does not

| | |
|---|---|
| A person with the link **can** | see the list of staff names, and send a request |
| A person with the link **cannot** | read, change or delete any request — not even their own |
| Only the manager account **can** | read the requests, tick them done, delete them, pause or replace the link |
| The link **does not contain** | the unit code — it cannot open the roster |

Be aware of the limits:

- **The page does not prove who is sending.** Anyone with the link can pick any
  name. Treat a request as a message to follow up, and confirm with the nurse
  before you grant it — which is why the list never changes the roster by itself.
- **The names are visible to anyone who has the link.** Send it to staff only. If
  it leaks, or you get junk requests, press **New link**: the old link stops
  working at once (requests received through it are deleted with it).
- **Reasons can be sensitive** (health, family). Ask staff to keep them short,
  delete requests once dealt with, and check your hospital's rules on where staff
  data may be stored before using this with real names.
- **Your manager password is the key.** Anyone who has it can read every request.

`npm run test:cloud` runs these rules in the Firebase emulator (110 checks: who
may do what, then both pages end to end). That proves the rules file; it cannot
prove the rules were published — only the check above on the real project does.

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
