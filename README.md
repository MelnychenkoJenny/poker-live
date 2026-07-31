# Poker Live

**Live site: [https://poker-live.onrender.com](https://poker-live.onrender.com)**

A companion site for a live poker game where cards are dealt for real, by
hand. The site handles everything else: seating, chip stacks, the pot,
betting rounds (fold/check/call/raise), blinds, the dealer button, and a
per-player decision timer.

One person (the dealer/host) runs the game from a separate admin panel:
starts the hand, reveals the flop/turn/river (whenever they actually flip
the real cards on the table), and manually picks the pot winner(s) after
showdown. Players just watch the table on their phones and tap their action
on their turn.

> ⚠️ The free Render instance goes to sleep after ~15 min of no traffic and
> takes 30–50s to wake up on the next request — open the link yourself a
> minute before the game starts so it has time to spin up.

## Running locally

```bash
npm install
npm start
```

The site comes up on `http://localhost:3000`.

- **Players** open `http://localhost:3000/` (or a shared link with the room
  code already in it — see below), enter the room code and their name.
- **The host** opens `http://localhost:3000/admin.html`, creates a room
  (blinds, starting stack, timer), and gets a room code + a link for
  players.

Playing on one Wi-Fi network without deploying anywhere? Find your laptop's
local IP (`ipconfig getifaddr en0` on a Mac) and share `http://<IP>:3000`
instead of `localhost`.

## How to play

1. The host opens `/admin.html`, creates a room — gets a code (e.g. `A7K2`)
   and an admin token (saved in the browser automatically, for
   reconnecting).
2. The host sends players a link like `https://.../?code=A7K2` (the code
   fills itself in) — players enter their name and join.
3. Players pick their own open seat at the table — they get the starting
   chip stack immediately.
4. The host clicks **"Start Hand"** — blinds are posted automatically, the
   dealer button is placed, and the first player gets the turn and a timer.
5. Players take turns tapping Fold / Check-Call / Raise on their phones.
   Once the betting round is done, the **"Reveal flop/turn/river"** button
   lights up — the host clicks it at the same moment they actually flip the
   real cards on the table.
6. After river betting, the host clicks **"Showdown"**, looks at the real
   cards, and manually picks the winner(s) of each pot (main pot + side
   pots if anyone went all-in).
7. Clicks **"Next Hand"** — the dealer button moves on, everything resets.

Blinds, the decision timer, and the starting stack can all be changed at any
time in the admin panel's "Settings" section. Blinds increase automatically
every N hands following a standard tournament progression (5/10 → 10/20 →
15/30 → 25/50 → ...) — the number of hands per level is also configurable
there (0 disables auto-increases).

The **"End Game & Restart"** button in the "Danger Zone" unseats everyone
(seats free up so people can sit somewhere new), resets chip stacks to the
starting amount, and resets the hand number — handy for starting a fresh
game in the same room with the same code, without creating a new one.

## Extras

- **Pause** — the "⏸ Pause" button on the host's panel freezes the timer for
  everyone (e.g. something needs discussing mid-turn) and blocks player
  actions. "▶ Resume" continues with whatever time was left.
- **"Forgot?"** — a link in the top-right corner of the player page opens a
  poker hand-rankings image (`public/images/instruction.jpg`).
- Between hands (while "shuffling") and when the game is fully won (every
  other player at the table is down to zero), animated gifs pop up over the
  table (`public/images/tasovka.gif`, `public/images/winner.gif`) — both
  dismissible with the × button. After a hand ends, a small chip badge
  ("+amount") also floats near the winning seat before the shuffle gif
  covers the table.
- If a player tries to fold when there's nothing to call (checking is
  free), a joking confirmation pops up to catch accidental folds.

## Technical details

- Backend: Node.js + Express + Socket.IO. Game state lives in server
  memory (no database) — that's fine for a single game session, but it
  means restarting the server wipes every room.
- Frontend: plain HTML/CSS/JS, no build step, no framework.
- Side pots for all-ins are computed automatically.

## Deploying to Render.com

1. Push the code to a GitHub repository.
2. On [render.com](https://render.com) → **New → Web Service** → connect
   the repository.
3. Build command: `npm install`. Start command: `npm start`. Instance type:
   Free.
4. Once deployed, Render gives you a URL like
   `https://poker-live.onrender.com` — that's what you share with players.
