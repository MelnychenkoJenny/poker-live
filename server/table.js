const crypto = require('crypto');

const MAX_SEATS = 9;

// Standard poker tournament blind structure (roughly 1.5-2x per step).
// Auto blind-ups snap forward to the next rung in this table.
const BLIND_LEVELS = [
  [5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200],
  [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [600, 1200],
  [800, 1600], [1000, 2000], [1500, 3000], [2000, 4000], 
];

function nextBlindLevel(sb, bb) {
  for (const [nsb, nbb] of BLIND_LEVELS) {
    if (nbb > bb) return { sb: nsb, bb: nbb };
  }
  return { sb: bb, bb: bb * 2 }; // past the table: just double
}

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
    this.handsPerLevel = 8; // 0 = auto blind increases disabled
    this.handsAtCurrentLevel = 0;

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
    this.paused = false;
    this._pausedRemainingMs = null;
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
    this.log(`${player.name} сідає на місце ${seatIndex + 1} з ${player.chips} фішками`);
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
    this.log(`Адмін садить ${player.name} на місце ${seatIndex + 1} з ${chips} фішками`);
    this.touch();
  }

  kickPlayer(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) return;
    if (player.seat !== null) this.seats[player.seat] = null;
    this.players.delete(playerId);
    this.log(`${player.name} видалений(а) зі столу`);
    this.touch();
  }

  setSittingOut(playerId, sittingOut) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    player.sittingOut = sittingOut;
    this.log(`${player.name} ${sittingOut ? 'сидить осторонь' : 'повертається в гру'}`);
    this.touch();
  }

  adjustChips(playerId, delta) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    player.chips = Math.max(0, player.chips + delta);
    this.log(`Адмін змінив(ла) фішки ${player.name} на ${delta > 0 ? '+' : ''}${delta} (тепер ${player.chips})`);
    this.touch();
  }

  resetGame() {
    this._clearTimer();
    for (const pid of this.seats) {
      if (!pid) continue;
      const p = this.players.get(pid);
      p.chips = this.defaultBuyIn;
      p.committedThisRound = 0;
      p.totalCommittedThisHand = 0;
      p.handStatus = 'idle';
      p.sittingOut = false;
      p.seat = null;
    }
    this.seats = new Array(MAX_SEATS).fill(null);
    this.dealerButtonSeat = null;
    this.handNumber = 0;
    this.stage = 'waiting';
    this.currentBetAmount = 0;
    this.minRaise = this.bigBlind;
    this.currentTurnSeat = null;
    this.actingQueue = new Set();
    this.bettingRoundComplete = false;
    this.pots = [];
    this.actionLog = [];
    this.handsAtCurrentLevel = 0;
    this.log('Гру скинуто — всіх пересаджено, стеки фішок оновлено');
    this.touch();
  }

  setBlinds(sb, bb) {
    this.smallBlind = sb;
    this.bigBlind = bb;
    this.handsAtCurrentLevel = 0;
    this.log(`Блайнди встановлено на ${sb}/${bb}`);
    this.touch();
  }

  setTimerSeconds(seconds) {
    this.timerSeconds = seconds;
    this.log(`Таймер на хід встановлено на ${seconds} с`);
    this.touch();
  }

  setDefaultBuyIn(amount) {
    this.defaultBuyIn = amount;
    this.touch();
  }

  setHandsPerLevel(hands) {
    this.handsPerLevel = Math.max(0, hands);
    this.handsAtCurrentLevel = 0;
    this.log(this.handsPerLevel > 0
      ? `Блайнди підвищуватимуться автоматично кожні ${this.handsPerLevel} хендів`
      : 'Автоматичне підвищення блайндів вимкнено');
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

    if (this.handsPerLevel > 0 && this.handsAtCurrentLevel >= this.handsPerLevel) {
      const next = nextBlindLevel(this.smallBlind, this.bigBlind);
      this.smallBlind = next.sb;
      this.bigBlind = next.bb;
      this.handsAtCurrentLevel = 0;
      this.log(`Блайнди підвищено до ${next.sb}/${next.bb}`);
    }
    this.handsAtCurrentLevel += 1;

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

    this.log(`Хенд #${this.handNumber} розпочато. Дилер: місце ${this.dealerButtonSeat + 1}`);
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
    this.log(`${p.name} ставить блайнд ${post === amount ? amount : `${post} (ва-банк)`}`);
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
    if (this.paused) throw new Error('Game is paused');
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('Unknown player');
    if (player.seat === null || this.currentTurnSeat !== player.seat) throw new Error('Not your turn');
    if (!['preflop', 'flop', 'turn', 'river'].includes(this.stage)) throw new Error('No betting right now');

    this._clearTimer();

    const call = this.callAmount(player.seat);

    if (type === 'fold') {
      player.handStatus = 'folded';
      this.actingQueue.delete(player.seat);
      this.log(`${player.name} скидає карти (пас)`);
    } else if (type === 'check') {
      if (call > 0) throw new Error('Cannot check, must call or fold');
      this.actingQueue.delete(player.seat);
      this.log(`${player.name} робить чек`);
    } else if (type === 'call') {
      const paid = Math.min(call, player.chips);
      player.chips -= paid;
      player.committedThisRound += paid;
      player.totalCommittedThisHand += paid;
      if (player.chips === 0) player.handStatus = 'all-in';
      this.actingQueue.delete(player.seat);
      this.log(`${player.name} відповідає (колл) ${paid}${player.handStatus === 'all-in' ? ' (ва-банк)' : ''}`);
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
      this.log(`${player.name} підвищує (рейз) до ${raiseTo}${isAllIn ? ' (ва-банк)' : ''}`);
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
        this.log(`${winner.name} забирає банк ${amount} (усі інші скинули карти)`);
      }
      this.stage = 'hand-over';
      return;
    }

    // actingQueue only ever holds seats that are still 'active' (raises
    // requeue active seats only, calls/checks/folds only remove from it),
    // so an empty queue is by itself sufficient proof nobody owes a
    // response — no separate "how many can still act" check needed. (That
    // extra check used to also fire when exactly one active player was
    // left owing a call on someone's all-in, wrongly closing the round
    // before they got to act at all.)
    if (this.actingQueue.size === 0) {
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

  _setTurn(seat, eligible, durationMs) {
    const duration = durationMs != null ? durationMs : this.timerSeconds * 1000;
    this.currentTurnSeat = seat;
    this.bettingRoundComplete = false;
    this.turnDeadline = Date.now() + duration;
    this._turnTimeout = setTimeout(() => this._autoAct(seat), duration + 250);
  }

  _clearTimer() {
    if (this._turnTimeout) clearTimeout(this._turnTimeout);
    this._turnTimeout = null;
    this.turnDeadline = null;
  }

  pauseGame() {
    if (this.paused) return;
    if (this.currentTurnSeat !== null && this.turnDeadline !== null) {
      this._pausedRemainingMs = Math.max(1000, this.turnDeadline - Date.now());
    } else {
      this._pausedRemainingMs = null;
    }
    this._clearTimer();
    this.paused = true;
    this.log('Ведучий поставив гру на паузу');
    this.touch();
  }

  resumeGame() {
    if (!this.paused) return;
    this.paused = false;
    if (this.currentTurnSeat !== null && this._pausedRemainingMs !== null) {
      this._setTurn(this.currentTurnSeat, null, this._pausedRemainingMs);
    }
    this._pausedRemainingMs = null;
    this.log('Гру відновлено');
    this.touch();
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
    const stageNames = { flop: 'флоп', turn: 'терн', river: 'рівер' };
    this.log(`Дилер відкриває ${stageNames[this.stage] || this.stage}`);

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
    this.log('Шоудаун');
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
      this.log(`${p.name} забирає ${award} з банку ${potIndex + 1}`);
    }
    pot.awarded = true;
    pot.winnerSeats = winnerSeats;

    if (this.pots.every((p) => p.awarded)) {
      this.stage = 'hand-over';
    }
    this.touch();
  }

  // A single seated player holding all the chips (everyone else seated has
  // busted to 0) means the whole session is over, not just one hand.
  _findGameWinner() {
    // Only meaningful once a hand is fully settled — mid-hand, an all-in
    // player's stack shows as 0 (it's all in the pot) even though they
    // might win it right back at showdown, so checking chip counts while
    // a hand is still live would wrongly call the game over.
    if (this.stage !== 'hand-over' && this.stage !== 'waiting') return null;
    const seated = [...this.players.values()].filter((p) => p.seat !== null);
    if (seated.length < 2) return null;
    const withChips = seated.filter((p) => p.chips > 0);
    return withChips.length === 1 ? withChips[0].name : null;
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
      paused: this.paused,
      winnerName: this._findGameWinner(),
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      defaultBuyIn: this.defaultBuyIn,
      handsPerLevel: this.handsPerLevel,
      handsAtCurrentLevel: this.handsAtCurrentLevel,
      pots: this.pots,
      actionLog: this.actionLog.slice(0, 15),
      unseatedPlayers,
      you: forPlayerId || null,
    };
  }
}

module.exports = { Table, makeRoomCode, MAX_SEATS };
