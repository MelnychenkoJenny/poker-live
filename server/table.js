const crypto = require('crypto');

const MAX_SEATS = 9;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class Table {
  constructor(code, { smallBlind = 5, bigBlind = 10, timerSeconds = 30, defaultBuyIn = 1000 } = {}, onUpdate) {
    this.code = code;
    this.adminToken = crypto.randomUUID();
    this.onUpdate = onUpdate || (() => {});

    this.seats = new Array(MAX_SEATS).fill(null); // seat index -> playerId
    this.players = new Map(); // id -> player

    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.timerSeconds = timerSeconds;
    this.defaultBuyIn = defaultBuyIn;
    this.levelMinutes = 0; // 0 = disabled
    this.levelDeadline = null;

    this.dealerButtonSeat = null;
    this.handNumber = 0;
    this.stage = 'waiting'; // waiting | preflop | flop | turn | river | showdown | hand-over
    this.currentBetAmount = 0;
    this.minRaise = bigBlind;
    this.currentTurnSeat = null;
    this.actingQueue = new Set();
    this.bettingRoundComplete = false;
    this.turnDeadline = null;
    this._turnTimeout = null;
    this.pots = []; // computed at showdown: [{amount, eligibleSeats, awarded, winnerSeats}]
    this.actionLog = [];

    this.lastActivityAt = Date.now();
  }

  log(text) {
    this.actionLog.unshift({ text, at: Date.now() });
    if (this.actionLog.length > 40) this.actionLog.length = 40;
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  // ---------- players & seats ----------

  addPlayer(name) {
    const id = crypto.randomUUID();
    const player = {
      id,
      name,
      seat: null,
      chips: 0,
      sittingOut: true,
      handStatus: 'idle', // active | folded | all-in | idle
      committedThisRound: 0,
      totalCommittedThisHand: 0,
      connected: true,
    };
    this.players.set(id, player);
    return player;
  }

  getPlayer(id) {
    return this.players.get(id) || null;
  }

  takeSeat(playerId, seatIndex) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    if (seatIndex < 0 || seatIndex >= MAX_SEATS) throw new Error('Invalid seat');
    if (this.seats[seatIndex]) throw new Error('Seat taken');
    if (player.seat !== null) this.seats[player.seat] = null;
    player.seat = seatIndex;
    player.chips = this.defaultBuyIn;
    player.sittingOut = false;
    this.seats[seatIndex] = playerId;
    this.log(`${player.name} sits in seat ${seatIndex + 1} with ${player.chips}`);
    this.touch();
  }

  adminSeatPlayer(playerId, seatIndex, chips) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    if (this.seats[seatIndex] && this.seats[seatIndex] !== playerId) throw new Error('Seat taken');
    if (player.seat !== null && player.seat !== seatIndex) this.seats[player.seat] = null;
    player.seat = seatIndex;
    player.chips = chips;
    player.sittingOut = false;
    this.seats[seatIndex] = playerId;
    this.log(`Admin seats ${player.name} in seat ${seatIndex + 1} with ${chips}`);
    this.touch();
  }

  kickPlayer(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return;
    if (player.seat !== null) this.seats[player.seat] = null;
    this.players.delete(playerId);
    this.log(`${player.name} removed from table`);
    this.touch();
  }

  setSittingOut(playerId, sittingOut) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    player.sittingOut = sittingOut;
    this.log(`${player.name} is ${sittingOut ? 'sitting out' : 'back in'}`);
    this.touch();
  }

  adjustChips(playerId, delta) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    player.chips = Math.max(0, player.chips + delta);
    this.log(`Admin adjusted ${player.name}'s chips by ${delta > 0 ? '+' : ''}${delta} (now ${player.chips})`);
    this.touch();
  }

  setBlinds(sb, bb) {
    this.smallBlind = sb;
    this.bigBlind = bb;
    this.log(`Blinds set to ${sb}/${bb}`);
    this.touch();
  }

  setTimerSeconds(seconds) {
    this.timerSeconds = seconds;
    this.log(`Decision timer set to ${seconds}s`);
    this.touch();
  }

  setDefaultBuyIn(amount) {
    this.defaultBuyIn = amount;
    this.touch();
  }

  setLevelMinutes(minutes) {
    this.levelMinutes = minutes;
    this.levelDeadline = minutes > 0 ? Date.now() + minutes * 60000 : null;
    this.touch();
  }

  // ---------- hand lifecycle ----------

  eligibleSeatsInOrder() {
    const list = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      const pid = this.seats[i];
      if (!pid) continue;
      const p = this.players.get(pid);
      if (p && !p.sittingOut && p.chips > 0) list.push(i);
    }
    return list;
  }

  nextEligibleSeat(fromSeat, eligible) {
    if (eligible.length === 0) return null;
    const idx = eligible.indexOf(fromSeat);
    if (idx === -1) {
      // find first eligible seat after fromSeat
      for (const s of eligible) if (s > fromSeat) return s;
      return eligible[0];
    }
    return eligible[(idx + 1) % eligible.length];
  }

  playerAtSeat(seat) {
    const pid = this.seats[seat];
    return pid ? this.players.get(pid) : null;
  }

  startHand() {
    if (!['waiting', 'hand-over'].includes(this.stage)) throw new Error('A hand is already in progress');
    const eligible = this.eligibleSeatsInOrder();
    if (eligible.length < 2) throw new Error('Need at least 2 seated players with chips');

    this._clearTimer();

    // reset all seated players
    for (const pid of this.seats) {
      if (!pid) continue;
      const p = this.players.get(pid);
      p.committedThisRound = 0;
      p.totalCommittedThisHand = 0;
      p.handStatus = eligible.includes(p.seat) ? 'active' : 'idle';
    }

    // advance dealer button
    if (this.dealerButtonSeat === null || !eligible.includes(this.dealerButtonSeat)) {
      this.dealerButtonSeat = eligible[0];
    } else {
      this.dealerButtonSeat = this.nextEligibleSeat(this.dealerButtonSeat, eligible);
    }

    this.handNumber += 1;
    this.stage = 'preflop';
    this.pots = [];

    const heads_up = eligible.length === 2;
    let sbSeat, bbSeat, firstToAct;
    if (heads_up) {
      sbSeat = this.dealerButtonSeat; // button posts SB in heads-up
      bbSeat = this.nextEligibleSeat(sbSeat, eligible);
      firstToAct = sbSeat; // button acts first preflop heads-up
    } else {
      sbSeat = this.nextEligibleSeat(this.dealerButtonSeat, eligible);
      bbSeat = this.nextEligibleSeat(sbSeat, eligible);
      firstToAct = this.nextEligibleSeat(bbSeat, eligible);
    }

    this._postBlind(sbSeat, this.smallBlind);
    this._postBlind(bbSeat, this.bigBlind);

    this.currentBetAmount = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.actingQueue = new Set(eligible.filter((s) => this.playerAtSeat(s).handStatus === 'active'));

    this.log(`Hand #${this.handNumber} started. Button: seat ${this.dealerButtonSeat + 1}`);
    this._setTurn(firstToAct, eligible);
    this.touch();
  }

  _postBlind(seat, amount) {
    const p = this.playerAtSeat(seat);
    const post = Math.min(amount, p.chips);
    p.chips -= post;
    p.committedThisRound = post;
    p.totalCommittedThisHand = post;
    if (p.chips === 0) p.handStatus = 'all-in';
    this.log(`${p.name} posts ${post === amount ? amount : `${post} (all-in)`}`);
  }

  callAmount(seat) {
    const p = this.playerAtSeat(seat);
    if (!p) return 0;
    return Math.max(0, this.currentBetAmount - p.committedThisRound);
  }

  pot() {
    let total = 0;
    for (const p of this.players.values()) total += p.totalCommittedThisHand;
    return total;
  }

  activeNonFolded() {
    const list = [];
    for (const pid of this.seats) {
      if (!pid) continue;
      const p = this.players.get(pid);
      if (p.handStatus === 'active' || p.handStatus === 'all-in') list.push(p.seat);
    }
    return list;
  }

  canStillAct(seat) {
    const p = this.playerAtSeat(seat);
    return p && p.handStatus === 'active';
  }

  handleAction(playerId, type, amount) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    if (player.seat === null || this.currentTurnSeat !== player.seat) throw new Error('Not your turn');
    if (!['preflop', 'flop', 'turn', 'river'].includes(this.stage)) throw new Error('No betting right now');

    this._clearTimer();

    const call = this.callAmount(player.seat);

    if (type === 'fold') {
      player.handStatus = 'folded';
      this.actingQueue.delete(player.seat);
      this.log(`${player.name} folds`);
    } else if (type === 'check') {
      if (call > 0) throw new Error('Cannot check, must call or fold');
      this.actingQueue.delete(player.seat);
      this.log(`${player.name} checks`);
    } else if (type === 'call') {
      const paid = Math.min(call, player.chips);
      player.chips -= paid;
      player.committedThisRound += paid;
      player.totalCommittedThisHand += paid;
      if (player.chips === 0) player.handStatus = 'all-in';
      this.actingQueue.delete(player.seat);
      this.log(`${player.name} calls ${paid}${player.handStatus === 'all-in' ? ' (all-in)' : ''}`);
    } else if (type === 'raise') {
      const raiseTo = Math.round(Number(amount));
      if (!Number.isFinite(raiseTo) || raiseTo <= this.currentBetAmount) throw new Error('Raise must exceed current bet');
      const delta = raiseTo - player.committedThisRound;
      if (delta > player.chips) throw new Error('Not enough chips');
      const isAllIn = delta === player.chips;
      const raiseSize = raiseTo - this.currentBetAmount;
      if (!isAllIn && raiseSize < this.minRaise) throw new Error(`Raise must be at least ${this.minRaise}`);

      player.chips -= delta;
      player.committedThisRound = raiseTo;
      player.totalCommittedThisHand += delta;
      if (player.chips === 0) player.handStatus = 'all-in';
      this.currentBetAmount = raiseTo;
      if (raiseSize >= this.minRaise) this.minRaise = raiseSize;

      // reopen action for everyone else still able to act
      this.actingQueue = new Set(
        this.activeNonFolded().filter((s) => s !== player.seat && this.canStillAct(s))
      );
      this.log(`${player.name} raises to ${raiseTo}${isAllIn ? ' (all-in)' : ''}`);
    } else {
      throw new Error('Unknown action');
    }

    this._advanceAfterAction();
    this.touch();
  }

  _advanceAfterAction() {
    const remaining = this.activeNonFolded();
    if (remaining.length <= 1) {
      // everyone else folded - instant win
      this.currentTurnSeat = null;
      this.bettingRoundComplete = true;
      if (remaining.length === 1) {
        const winner = this.playerAtSeat(remaining[0]);
        const amount = this.pot();
        winner.chips += amount;
        this.log(`${winner.name} wins ${amount} (all others folded)`);
      }
      this.stage = 'hand-over';
      return;
    }

    const canAct = remaining.filter((s) => this.canStillAct(s));
    if (this.actingQueue.size === 0 || canAct.length <= 1) {
      // betting round is over - wait for admin to reveal next street / showdown
      this.currentTurnSeat = null;
      this.bettingRoundComplete = true;
      return;
    }

    // move to next player who still needs to act
    const eligible = this.eligibleSeatsInOrder();
    let next = this.nextEligibleSeat(this.currentTurnSeat, eligible);
    let guard = 0;
    while (!this.actingQueue.has(next) && guard < MAX_SEATS * 2) {
      next = this.nextEligibleSeat(next, eligible);
      guard++;
    }
    this._setTurn(next, eligible);
  }

  _setTurn(seat, eligible) {
    this.currentTurnSeat = seat;
    this.bettingRoundComplete = false;
    this.turnDeadline = Date.now() + this.timerSeconds * 1000;
    this._turnTimeout = setTimeout(() => this._autoAct(seat), this.timerSeconds * 1000 + 250);
  }

  _clearTimer() {
    if (this._turnTimeout) clearTimeout(this._turnTimeout);
    this._turnTimeout = null;
    this.turnDeadline = null;
  }

  _autoAct(seat) {
    if (this.currentTurnSeat !== seat) return;
    const player = this.playerAtSeat(seat);
    if (!player) return;
    try {
      if (this.callAmount(seat) > 0) {
        this.handleAction(player.id, 'fold');
      } else {
        this.handleAction(player.id, 'check');
      }
    } catch (e) {
      // ignore, shouldn't happen
    }
    this.onUpdate();
  }

  revealNext() {
    if (!this.bettingRoundComplete && this.stage !== 'preflop') {
      // allow forcing forward only when round is actually complete
    }
    const order = ['preflop', 'flop', 'turn', 'river'];
    const idx = order.indexOf(this.stage);
    if (idx === -1 || idx === order.length - 1) throw new Error('Nothing to reveal');
    if (!this.bettingRoundComplete) throw new Error('Betting round is not finished');

    this._clearTimer();
    this.stage = order[idx + 1];

    for (const pid of this.seats) {
      if (!pid) continue;
      const p = this.players.get(pid);
      p.committedThisRound = 0;
    }
    this.currentBetAmount = 0;
    this.minRaise = this.bigBlind;
    this.log(`Dealer reveals the ${this.stage}`);

    const remaining = this.activeNonFolded();
    const canAct = remaining.filter((s) => this.canStillAct(s));
    if (canAct.length <= 1) {
      this.currentTurnSeat = null;
      this.bettingRoundComplete = true;
      this.touch();
      return;
    }

    const eligible = this.eligibleSeatsInOrder();
    const firstToAct = this.nextEligibleSeat(this.dealerButtonSeat, eligible.filter((s) => canAct.includes(s)));
    this.actingQueue = new Set(canAct);
    this._setTurn(firstToAct, eligible);
    this.touch();
  }

  startShowdown() {
    if (this.stage !== 'river') throw new Error('Not ready for showdown');
    if (!this.bettingRoundComplete) throw new Error('Betting round is not finished');
    this._clearTimer();
    this.stage = 'showdown';
    this.pots = this._computePots();
    this.currentTurnSeat = null;
    this.log('Showdown');
    this.touch();
  }

  _computePots() {
    const contributors = [];
    for (const p of this.players.values()) {
      if (p.totalCommittedThisHand > 0) contributors.push(p);
    }
    const nonFolded = contributors.filter((p) => p.handStatus !== 'folded');
    const levels = [...new Set(nonFolded.map((p) => p.totalCommittedThisHand))].sort((a, b) => a - b);

    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of contributors) {
        amount += Math.max(0, Math.min(p.totalCommittedThisHand, level) - prev);
      }
      const eligibleSeats = nonFolded.filter((p) => p.totalCommittedThisHand >= level).map((p) => p.seat);
      if (amount > 0) pots.push({ amount, eligibleSeats, awarded: false, winnerSeats: [] });
      prev = level;
    }
    return pots;
  }

  awardPot(potIndex, winnerSeats) {
    const pot = this.pots[potIndex];
    if (!pot) throw new Error('Unknown pot');
    if (pot.awarded) throw new Error('Already awarded');
    if (!winnerSeats.length || winnerSeats.some((s) => !pot.eligibleSeats.includes(s))) {
      throw new Error('Invalid winners for this pot');
    }
    const share = Math.floor(pot.amount / winnerSeats.length);
    let remainder = pot.amount - share * winnerSeats.length;

    // remainder goes to the first winner seated left of the dealer button
    const order = [...winnerSeats].sort((a, b) => {
      const da = (a - this.dealerButtonSeat + MAX_SEATS) % MAX_SEATS;
      const db = (b - this.dealerButtonSeat + MAX_SEATS) % MAX_SEATS;
      return da - db;
    });

    for (const seat of order) {
      const p = this.playerAtSeat(seat);
      let award = share;
      if (remainder > 0) {
        award += 1;
        remainder -= 1;
      }
      p.chips += award;
      this.log(`${p.name} wins ${award} from pot ${potIndex + 1}`);
    }
    pot.awarded = true;
    pot.winnerSeats = winnerSeats;

    if (this.pots.every((p) => p.awarded)) {
      this.stage = 'hand-over';
    }
    this.touch();
  }

  // ---------- serialization ----------

  toJSON(forPlayerId) {
    const seats = this.seats.map((pid, i) => {
      if (!pid) return { seat: i, empty: true };
      const p = this.players.get(pid);
      return {
        seat: i,
        playerId: p.id,
        name: p.name,
        chips: p.chips,
        committedThisRound: p.committedThisRound,
        handStatus: p.handStatus,
        sittingOut: p.sittingOut,
        connected: p.connected,
        isYou: p.id === forPlayerId,
      };
    });

    const unseatedPlayers = [...this.players.values()]
      .filter((p) => p.seat === null)
      .map((p) => ({ id: p.id, name: p.name, connected: p.connected, isYou: p.id === forPlayerId }));

    return {
      code: this.code,
      seats,
      dealerButtonSeat: this.dealerButtonSeat,
      handNumber: this.handNumber,
      stage: this.stage,
      pot: this.pot(),
      currentBetAmount: this.currentBetAmount,
      minRaise: this.minRaise,
      currentTurnSeat: this.currentTurnSeat,
      turnDeadline: this.turnDeadline,
      timerSeconds: this.timerSeconds,
      bettingRoundComplete: this.bettingRoundComplete,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      defaultBuyIn: this.defaultBuyIn,
      levelMinutes: this.levelMinutes,
      levelDeadline: this.levelDeadline,
      pots: this.pots,
      actionLog: this.actionLog.slice(0, 15),
      unseatedPlayers,
      you: forPlayerId || null,
    };
  }
}

module.exports = { Table, makeRoomCode, MAX_SEATS };
