# Securing the cloud database

The app opens with **one manager account** (email + password). That same sign-in is
what the server checks before it hands over the cloud roster or the staff requests.
There is no shared password and no unit code any more.

Two things are **not** done by anything in this repository — you do them by hand in
the Firebase console, once:

- creating the manager account, and
- publishing [`firestore.rules`](./firestore.rules).

Until the rules are published the database is only as closed as whatever rules are
live now. The app checks this itself: **Cloud** shows either

- 🔒 *Rules check passed* — it asked for a roster that is not yours and was refused, or
- ⚠ *Database NOT secured* — the request was answered; publish the rules.

---

## Set it up (once, in this order)

Order matters: from the moment this version of the app is live, nobody can open it
without the account from step 2.

1. **Switch on Email/Password.** [Firebase console](https://console.firebase.google.com/)
   → project **schedule-nursing-f14e5** → **Build → Authentication → Sign-in method →
   Email/Password → Enable → Save**. (Leave "Email link" off.)
2. **Create your manager account.** Authentication → **Users → Add user**. Your email
   and a strong password that you use nowhere else.
3. **Close public sign-up.** Authentication → **Settings → User actions** → untick
   **Enable create (sign-up)** → Save. Otherwise a stranger could make an account in
   your project. (They could not read your roster or requests — see below — but until
   step 6 they could read the old shared copy if they knew the unit code.)
4. **Publish the rules.** Firestore Database → **Rules** → replace everything with the
   contents of [`firestore.rules`](./firestore.rules) → **Publish**.
5. **Sign in to the app** on the device that has your current roster. The roster that
   was shared under the unit code moves into your account by itself. Open **Cloud**
   and confirm it says **🔒 Rules check passed**.
6. **Delete the old shared copy.** Cloud → *Old shared copy (unit code)* → **Check** →
   **Delete old copy**. That copy holds staff names and sat under a code that was
   public, so do not skip this.
7. **Switch Anonymous sign-in off.** Authentication → Sign-in method → **Anonymous** →
   disable. The app no longer uses it.

On each further device: just sign in. It receives the roster from your account.

### Check it worked

1. **Cloud** says *The roster is saved to <your email>* and *🔒 Rules check passed*.
2. Change a cell on one device; it appears on another within a few seconds.
3. Press the padlock (sign out). The app locks, and a reload stays locked.

---

## What this protects, and what it does not

| | |
|---|---|
| Cloud roster | Only your account can read or change it (`rosters/{your account id}`) |
| Staff requests | Only your account can read them (see below) |
| Old unit-code copy | Nothing can be written there; a signed-in manager can read and delete it |
| Everything else in the database | Closed |

Be aware of the limits:

- **Your password is the key.** Anyone who has it has everything. To change it:
  Firebase console → Authentication → Users → ⋮ → Reset password, or **Forgot
  password?** on the sign-in screen.
- **The sign-in screen does not encrypt what is on the device.** The browser keeps a
  copy of the roster in its own storage so the app works offline; someone with
  technical skill and access to an unlocked computer could read it. Use a device
  login, and leave **Keep me signed in** unticked on a shared ward computer — then
  the sign-in ends with the browser session.
- **Offline.** With *Keep me signed in*, the app opens without internet and works from
  the device's copy; the changes are sent to your account the next time it opens
  online. A device that has never signed in cannot be opened offline.
- **Two devices editing at the same time.** Changes to different cells, days or
  settings are all kept. If both changed the *same* cell before either had synced,
  the one saved last stays, and both devices show a notice naming the cell and the
  two values; the device whose change was replaced can bring it back with Undo.
- **Size.** The whole roster is one cloud record, which can hold about 1 MB: roughly
  seven years of locked fortnights. **Cloud** shows how full it is and warns well before
  the limit; a save that would not fit is kept on the device and never half-sent.
- **One account.** Colleagues with their own accounts, or view-only access, are not
  built yet.

> **The rules file changes with the app.** Whenever `firestore.rules` is updated,
> publish it again (step 4). If the app is newer than the published rules, **Cloud**
> shows *Cloud error* and keeps your changes on the device until you do.

`npm run test:cloud` runs the rules in the Firebase emulator (who may do what, then
the real pages end to end). That proves the rules file. Only the **Cloud** window's
rules check, on the real project, proves they were published.

---

## What the pages are allowed to load and contact

- **No code comes from another website.** The Excel, PDF and Firebase libraries are
  stored with the app (`vendor/`) as exact, checksummed copies of the published files,
  so a compromised CDN cannot change what runs.
- **The pages can talk only to Google's servers** (Firebase sign-in and the database).
  A built-in policy refuses everything else, so even a script that got onto the page
  could not send the roster to another site.
- **If the policy ever blocks something, you see it**: a red banner at the top names
  what was stopped. Send that text to whoever maintains the app.

- **No inline code can run.** The app's buttons carry no script of their own, and the
  policy refuses any script written into the page except the app's own, which it checks
  by its exact checksum. Something slipped into a name or a comment cannot run.

What this does not do: styles may still be written inline, and fonts still come from
Google Fonts.

---

## Staff request link

Staff open a link (`request.html?f=…`), pick their name and the day(s) they want
off, write a reason and send it. You read what arrives in the app under
**Staff requests**. It is a reference list: nothing a nurse sends changes the roster.

### Set it up

Do the steps under **Set it up** at the top of this file first. Then, in the app:
**Staff requests** → type the ward name → **Create the staff link** → **Copy link** →
send it to your staff (WhatsApp group, email). You are already signed in — the app
uses the same account.

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
| The link **does not contain** | your account or any password — it cannot open the roster |

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

---

## Backups

Independently of any of this: use **Cloud → Export** regularly. It saves the
whole schedule (roster, requests, settings) to a file on your device, and
**Import** restores it. That is your safety net if data is ever lost or
overwritten — cloud sync is not a backup, because a bad change syncs everywhere.
