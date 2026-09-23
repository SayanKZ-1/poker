/**
 * Server-authoritative no-limit Hold'em core, integer play chips only.
 * No I/O. The same engine powers the explicitly labelled, local bot preview.
 * No balances, payments, deposits, withdrawals, rake or real-money support.
 */
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const HAND_NAMES = ['Старшая карта', 'Пара', 'Две пары', 'Тройка', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
// Integer chips only. Table-wide budget leaves headroom for raise/pot arithmetic.
export const MAX_TABLE_CHIPS = 1_000_000_000_000_000;
export const REBUY_REVIEW_LEASE_MS = 120000;
const chipText = n => new Intl.NumberFormat('ru-RU').format(n);
const phases = ['preflop', 'flop', 'turn', 'river'];
const sum = xs => xs.reduce((a, b) => a + b, 0);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;

/** Unbiased, cryptographically random integer using rejection sampling. */
export function randomBelow(n) {
  ensure(integer(n, 1, 0xffffffff), 'Invalid random bound');
  ensure(globalThis.crypto?.getRandomValues, 'Криптографический ГСЧ недоступен: раздача запрещена');
  const limit = Math.floor(0x100000000 / n) * n;
  const bytes = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(bytes); } while (bytes[0] >= limit);
  return bytes[0] % n;
}
export function shuffledDeck() {
  const cards = [...SUITS].flatMap(s => [...RANKS].map(r => r + s));
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
export function compareRanks(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}
export function evaluateFive(cards) {
  ensure(cards.length === 5 && new Set(cards).size === 5 && cards.every(c => /^[2-9TJQKA][cdhs]$/.test(c)), 'Invalid five-card hand');
  const ranks = cards.map(c => RANKS.indexOf(c[0]) + 2).sort((a, b) => b - a);
  const counts = new Map();
  ranks.forEach(r => counts.set(r, (counts.get(r) || 0) + 1));
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const unique = [...new Set(ranks)];
  const straight = unique.length === 5 && unique[0] - unique[4] === 4 ? unique[0]
    : unique.join(',') === '14,5,4,3,2' ? 5 : 0;
  if (straight && flush) return [8, straight];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map(g => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...groups.map(g => g[0])];
  if (groups[0][1] === 2) return [1, ...groups.map(g => g[0])];
  return [0, ...ranks];
}
export function bestHand(cards) {
  ensure(cards.length >= 5 && cards.length <= 7 && new Set(cards).size === cards.length, 'Invalid hand');
  let result = null;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const rank = evaluateFive(five);
            if (!result || compareRanks(rank, result.rank) > 0) result = {rank, cards: five, name: HAND_NAMES[rank[0]]};
          }
  return result;
}

/**
 * Build real pots BEFORE rounding any payout. A folded contribution does not
 * create a new side pot by itself. Adjacent layers with the same eligible
 * players must be merged, otherwise odd chips can be awarded multiple times.
 * This function neither debits nor credits any stack.
 */
export function buildPots(players) {
  ensure(players.length >= 2 && new Set(players.map(p => p.id)).size === players.length, 'Некорректные участники банка');
  ensure(players.every(p => integer(p.total, 0, MAX_TABLE_CHIPS)), 'Некорректные взносы в банк');
  ensure(players.reduce((n,p)=>n+BigInt(p.total),0n) <= BigInt(MAX_TABLE_CHIPS), 'Превышена безопасная сумма фишек');
  const contenders = players.filter(p => p.inHand && !p.folded);
  ensure(contenders.length > 0, 'Нет участников, имеющих право на банк');
  const levels = [...new Set(players.map(p => p.total).filter(Boolean))].sort((a,b) => a-b);
  const pots = [], refunds = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = players.filter(p => p.total >= level);
    const slice = level - previous, amount = slice * contributors.length;
    previous = level;
    if (contributors.length === 1) {
      refunds.push({id: contributors[0].id, amount, reason: 'Непокрытая часть ставки'});
      continue;
    }
    const eligible = contenders.filter(p => p.total >= level).map(p => p.id);
    ensure(eligible.length > 0, 'Банк без правомочного участника: требуется проверка раздачи');
    const last = pots.at(-1);
    if (last && JSON.stringify(last.eligible) === JSON.stringify(eligible)) {
      last.amount += amount;
      for (const p of contributors) last.contributions[p.id] = (last.contributions[p.id] || 0) + slice;
    } else {
      pots.push({id: pots.length, label: pots.length ? `Побочный банк ${pots.length}` : 'Основной банк', amount, eligible,
        contributions: Object.fromEntries(contributors.map(p => [p.id, slice]))});
    }
  }
  ensure(sum(pots.map(p => p.amount)) + sum(refunds.map(r => r.amount)) === sum(players.map(p => p.total)), 'Банки и возвраты не сходятся');
  return {pots, refunds};
}

export class Table {
  constructor({smallBlind = 10, bigBlind = 20, startingStack = 2000, maxPlayers = 6, turnMs = 30000, mode = 'cash', straddleAllowed = false, levelMinutes = 10, handDelayMs = 6000, buyInMode = 'fixed', minBuyIn = startingStack, maxBuyIn = startingStack, rebuyAllowed = true, levels = null, now = () => Date.now()} = {}) {
    ensure(integer(smallBlind, 1, 5000) && integer(bigBlind, smallBlind + 1, 10000), 'Некорректные блайнды');
    ensure(integer(startingStack, bigBlind * 20, MAX_TABLE_CHIPS), 'Стек должен быть от 20 больших блайндов');
    ensure(integer(maxPlayers, 2, 6) && integer(turnMs, 1000, 120000), 'Некорректные настройки');
    ensure(['cash', 'tournament'].includes(mode), 'Неизвестный формат игры');
    ensure(typeof straddleAllowed === 'boolean', 'Некорректная настройка страдла');
    ensure(mode === 'cash' || !straddleAllowed, 'В турнире страдл запрещён');
    ensure(integer(handDelayMs, 1000, 30000), 'Пауза между раздачами: от 1 до 30 секунд');
    ensure(integer(levelMinutes, 1, 120), 'Длительность уровня: от 1 до 120 минут');
    ensure(['fixed','range'].includes(buyInMode) && typeof rebuyAllowed === 'boolean', 'Некорректный buy-in');
    if (buyInMode === 'fixed') minBuyIn = maxBuyIn = startingStack;
    ensure(integer(minBuyIn, bigBlind * 20, MAX_TABLE_CHIPS) && integer(maxBuyIn, minBuyIn, MAX_TABLE_CHIPS) && integer(startingStack, minBuyIn, maxBuyIn), 'Стек вне диапазона buy-in');
    if (levels !== null) {
      ensure(Array.isArray(levels) && levels.length > 0 && levels.length <= 50, 'От 1 до 50 уровней');
      levels = levels.map(l => {
        ensure(l && integer(l.smallBlind,1,500000) && integer(l.bigBlind,l.smallBlind+1,MAX_TABLE_CHIPS) && integer(l.durationMinutes,1,120), 'Некорректный уровень');
        ensure((l.ante ?? 0) === 0 && (l.bbAnte ?? 0) === 0, 'Анте ещё не поддерживается');
        return {smallBlind:l.smallBlind,bigBlind:l.bigBlind,durationMinutes:l.durationMinutes,ante:0,bbAnte:0};
      });
      ensure(startingStack >= levels[0].bigBlind * 20, 'Стек должен быть от 20 BB первого уровня');
    }
    Object.assign(this, {buyInMode, minBuyIn, maxBuyIn, rebuyAllowed, levels, pendingBlinds:null});
    Object.assign(this, {smallBlind, bigBlind, startingStack, maxPlayers, turnMs, mode, straddleAllowed, levelMinutes, handDelayMs, now});
    this.baseSmallBlind = smallBlind; this.baseBigBlind = bigBlind;
    this.startedAt = null; this.level = 0; this.tournamentOver = false; this.championId = null;
    this.straddle = null; this.rulesVersion = 'svoi-nlhe-0.4.1';
    this.running = false; this.paused = false; this.nextHandAt = null; this.haltReason = null;
    this.lastHand = null; this.pauseStartedAt = null;
    this.rebuyRequests = []; this.rebuyReview = null;
    this.players = [];
    this.phase = 'waiting'; this.dealer = -1; this.handId = 0; this.version = 0;
    this.board = []; this.deck = []; this.pending = new Set(); this.actor = null;
    this.currentBet = 0; this.minRaise = bigBlind; this.deadline = null;
    this.payouts = []; this.pots = []; this.refunds = []; this.accounting = []; this.lastPot = 0; this.committedPot = 0; this.history = []; this.handHistory = []; this.historyTruncated = false;
    this.nextEventId = 1; this.reveal = false; this.chipsIssued = 0;
    this.lastBigBlind = null; this.lastSmallBlind = null; this.lastParticipantCount = 0;
  }
  get idle() { return this.phase === 'waiting' || this.phase === 'showdown'; }
  get pot() { return sum(this.players.map(p => p.total)); }
  player(id) { return this.players.find(p => p.id === id); }
  contenders() { return this.players.filter(p => p.inHand && !p.folded); }
  actors() { return this.contenders().filter(p => p.stack > 0); }
  record(text, extra = {}) {
    const event = {id: this.nextEventId++, handId: this.handId, phase: this.phase, text, ...extra};
    this.history.push(event);
    if (!this.idle || ['win','return','settlement'].includes(extra.kind)) {
      this.handHistory.push(event);
      if (this.handHistory.length > 1000) { this.handHistory.splice(1,1); this.historyTruncated = true; }
    }
    this.history = this.history.slice(-60);
  }
  addPlayer(id, name, {bot = false, buyIn = this.startingStack, unfunded = false} = {}) {
    if(unfunded)buyIn=0;
    ensure(unfunded || (this.mode === 'cash' ? integer(buyIn,this.minBuyIn,this.maxBuyIn) : buyIn === this.startingStack), 'Стек вне диапазона buy-in');
    ensure(unfunded || this.idle, 'Новые игроки садятся между раздачами');
    ensure(!this.player(id), 'Вы уже за столом');
    ensure(this.players.length < this.maxPlayers, 'За столом нет свободных мест');
    if(buyIn)this.ensureChipCapacity(buyIn);
    const seat = Array.from({length: this.maxPlayers}, (_, i) => i).find(i => !this.players.some(p => p.seat === i));
    this.players.push({id, name: String(name).slice(0, 32), seat, bot, connected: true, sittingOut: false, returnPending: false, missedHands: this.mode === 'cash' && this.handId > 0, sitOutReason: null,
      fundedBefore: !unfunded, stack: buyIn, pendingBuyIn: 0, cards: [], bet: 0, total: 0, folded: false, inHand: false, actedAt: null, actedRaiseSize: this.bigBlind, lastAction: '', autoStraddle: false});
    this.players.sort((a, b) => a.seat - b.seat);
    this.chipsIssued += buyIn;
    this.version++; this.record(`${name} за столом`);
    this.assertChips();
  }
  removePlayer(id) {
    ensure(this.idle, 'Покинуть место можно между раздачами');
    ensure(this.mode !== 'tournament' || this.handId === 0 || this.tournamentOver, 'Нельзя удалять участника начавшегося турнира');
    const p = this.player(id); ensure(p, 'Игрок не найден');
    this.chipsIssued -= p.stack + (p.pendingBuyIn || 0);
    this.rebuyRequests = this.rebuyRequests.filter(r => r.playerId !== id);
    this.players = this.players.filter(x => x.id !== id);
    this.version++; this.record(`${p.name} покинул стол`);
    this.assertChips();
  }
  ensureChipCapacity(amount) {
    ensure(integer(amount,1,MAX_TABLE_CHIPS), 'Укажите целое положительное число фишек в безопасном диапазоне');
    ensure(BigInt(this.chipsIssued) + BigInt(amount) <= BigInt(MAX_TABLE_CHIPS), 'Сумма фишек стола превысит предел точного расчёта');
  }
  requestRebuy(playerId, amount, requestId, fundingType = 'rebuy') {
    ensure(!this.haltReason, 'Стол остановлен из-за ошибки');
    const p=this.player(playerId); ensure(p, 'Игрок не найден');
    ensure(['buyIn','rebuy','reentry','addon'].includes(fundingType),'Неизвестный вид закупа');
    if(!p.fundedBefore){
      fundingType='buyIn';
      ensure(this.mode==='tournament'?amount===this.startingStack:integer(amount,this.minBuyIn,this.maxBuyIn),'Стартовый стек вне диапазона buy-in');
    }else ensure(fundingType!=='buyIn','Первый бай-ин уже подтверждён; выберите ребай или реэнтри');
    this.ensureChipCapacity(amount);
    ensure(!this.rebuyRequests.some(r=>r.playerId===playerId), 'Ваш запрос уже ожидает администратора');
    ensure(typeof requestId === 'string' && requestId.length >= 10, 'Некорректный идентификатор запроса');
    this.rebuyRequests.push({id:requestId,playerId,name:p.name,amount,fundingType,createdAt:this.now()});
    this.version++;
    this.record(`${p.name} запросил докупку ${chipText(amount)} фишек`, {kind:'rebuyRequested',playerId,amount,requestId});
  }
  // Internal approved issuance. HTTP clients can only request, never call this directly.
  topUp(playerId, amount = this.startingStack, fundingType = 'rebuy') {
    return this.transaction(()=>{
      const p=this.player(playerId); ensure(p, 'Игрок не найден');
      ensure(['buyIn','rebuy','reentry','addon'].includes(fundingType),'Неизвестный вид закупа');
      if(fundingType==='reentry')ensure(p.stack===0 && p.total===0 && !p.pendingBuyIn,'Реэнтри доступен после выбывания и расчёта текущей руки');
      this.ensureChipCapacity(amount);
      p.fundedBefore=true;
      const deferred=!this.idle;
      if(deferred) p.pendingBuyIn=(p.pendingBuyIn||0)+amount;
      else p.stack+=amount;
      this.chipsIssued+=amount;this.version++;
      this.record(`${p.name} докупил ${chipText(amount)} фишек${deferred ? ' — со следующей раздачи' : ''}`, {kind:'rebuyApproved',playerId,amount,fundingType,effectiveHandId:this.handId+1});
      this.reopenTournament();
      if(this.idle)this.syncNextHand();
    });
  }
  decideRebuy(requestId, approved) {
    ensure(this.rebuyReview && this.now()<this.rebuyReview.expiresAt, 'Сначала откройте окно запросов');
    const request=this.rebuyRequests.find(r=>r.id===requestId);ensure(request, 'Запрос уже обработан или отменён');
    if(approved)this.topUp(request.playerId,request.amount,request.fundingType || 'rebuy');
    else {this.version++;this.record(`Докупка ${request.name} отклонена`,{kind:'rebuyDenied',playerId:request.playerId,requestId});}
    this.rebuyRequests=this.rebuyRequests.filter(r=>r.id!==requestId);
  }
  cancelRebuy(playerId, requestId) {
    const r=this.rebuyRequests.find(r=>r.id===requestId&&r.playerId===playerId);ensure(r,'Запрос не найден');
    this.rebuyRequests=this.rebuyRequests.filter(r=>r.id!==requestId);this.version++;
    this.record(`${r.name} отменил запрос докупки`,{kind:'rebuyCancelled',playerId,requestId});
  }
  beginRebuyReview(reviewId, admissionNames=[]) {
    ensure(!this.haltReason,'Проверка докупок недоступна');
    if(this.rebuyReview)return;
    ensure(this.rebuyRequests.length+admissionNames.length>0,'Нет ожидающих запросов');
    const now=this.now();
    this.rebuyReview={id:reviewId,names:[...this.rebuyRequests.map(r=>r.name),...admissionNames],startedAt:now,expiresAt:now+REBUY_REVIEW_LEASE_MS,
      deadlineRemaining:this.deadline===null?null:Math.max(0,this.deadline-now),
      nextHandRemaining:this.nextHandAt===null?null:Math.max(0,this.nextHandAt-now)};
    this.deadline=null;this.nextHandAt=null;this.version++;
    this.record(`Закуп в игре: ${[...this.rebuyRequests.map(r=>r.name),...admissionNames].join(', ')}. Игра приостановлена`,{kind:'rebuyReviewStarted',reviewId});
  }
  renewRebuyReview(reviewId) {
    ensure(this.rebuyReview?.id===reviewId,'Окно запросов уже закрыто');
    this.rebuyReview.expiresAt=this.now()+REBUY_REVIEW_LEASE_MS;
  }
  endRebuyReview(reviewId, automatic=false) {
    // A stale close from another tab must never resume a newer review.
    if(!this.rebuyReview || this.rebuyReview.id!==reviewId)return;
    const review=this.rebuyReview;
    if(this.mode==='tournament' && this.startedAt!==null && this.pauseStartedAt===null && this.tournamentEndedAt==null)this.startedAt+=this.now()-review.startedAt;
    this.rebuyReview=null;
    this.deadline=review.deadlineRemaining===null?null:this.now()+review.deadlineRemaining;
    this.nextHandAt=review.nextHandRemaining===null?null:this.now()+review.nextHandRemaining;
    this.version++;
    this.record(automatic?'Окно закупа потеряло связь. Игра продолжена':'Окно закупа закрыто. Игра продолжена',{kind:'rebuyReviewEnded',automatic,reviewId});
    this.syncNextHand();
  }
  applyApprovedRebuys() {
    ensure(this.idle,'Фишки докупки применяются только между раздачами');
    for(const p of this.players)if(p.pendingBuyIn){
      const amount=p.pendingBuyIn;p.stack+=amount;p.pendingBuyIn=0;this.version++;
      this.record(`${p.name}: ${chipText(amount)} фишек доступны со следующей раздачи`,{kind:'rebuyAvailable',playerId:p.id,amount,effectiveHandId:this.handId+1});
    }
  }
  reopenTournament() {
    if(this.mode!=='tournament' || !this.tournamentOver || this.players.filter(p=>p.stack>0).length<2)return;
    const resumeAt=this.rebuyReview?.startedAt ?? this.now();
    if(this.tournamentEndedAt!=null && this.startedAt!==null && this.pauseStartedAt===null)this.startedAt+=Math.max(0,resumeAt-this.tournamentEndedAt);
    this.tournamentEndedAt=null;this.tournamentOver=false;this.championId=null;
    this.record('Турнир продолжен после подтверждённого закупа',{kind:'tournamentResumed'});
  }
  clockFrozenAt() {
    const times=[this.pauseStartedAt,this.rebuyReview?.startedAt,this.tournamentEndedAt].filter(n=>n!=null);
    return times.length?Math.min(...times):null;
  }
  setStraddle(id, enabled) {
    ensure(this.idle, 'Страдл выбирается до раздачи карт, между раздачами');
    ensure(this.mode === 'cash' && this.straddleAllowed, 'Страдл за этим столом запрещён');
    ensure(typeof enabled === 'boolean', 'Некорректная настройка страдла');
    const p = this.player(id); ensure(p, 'Игрок не найден');
    p.autoStraddle = enabled; this.version++;
    this.record(`${p.name}: автострадл UTG ${enabled ? 'включён' : 'выключен'}`);
  }
  /** A session is started once. Subsequent hands are server-timed, never client-timed. */
  startPlay() {
    return this.transaction(() => {
      ensure(!this.running && this.handId === 0, 'Игра уже запущена; следующая раздача автоматическая');
      this.running = true;
      this._startHand();
    });
  }
  setPaused(paused) {
    ensure(!this.rebuyReview,'Сначала закройте окно закупа');
    ensure(typeof paused === 'boolean', 'Некорректная настройка паузы');
    ensure(this.running && !this.tournamentOver && !this.haltReason, 'Пауза сейчас недоступна');
    if (this.paused === paused) return;
    this.paused = paused;
    // A requested pause never stops a live hand, its action timer or settlement.
    if (!paused && this.pauseStartedAt !== null) {
      if (this.mode === 'tournament' && this.startedAt !== null) this.startedAt += this.now() - this.pauseStartedAt;
      this.pauseStartedAt = null;
    }
    this.version++;
    this.record(paused ? 'Пауза стола после текущей раздачи' : 'Автоматическая игра продолжена', {kind: 'pause'});
    this.syncNextHand();
  }
  setConnected(id, connected) {
    const p = this.player(id); ensure(p, 'Игрок не найден');
    ensure(typeof connected === 'boolean', 'Некорректный статус соединения');
    p.connected = connected;
    // Reconnection restores the view, never consent to play or a new action clock.
    if (this.idle) this.markDisconnected();
    this.syncNextHand();
  }
  markDisconnected() {
    // Network presence is advisory. Only an expired action clock opts a player out.
    return false;
  }
  scheduleBlinds(smallBlind, bigBlind) {
    ensure(this.mode === 'cash', 'В турнире действует структура уровней');
    ensure(integer(smallBlind,1,5000) && integer(bigBlind,smallBlind+1,10000), 'Некорректные блайнды');
    this.pendingBlinds = {smallBlind,bigBlind}; this.version++;
    this.record(`Со следующей раздачи: ${smallBlind} / ${bigBlind}`, {kind:'blindsPending',smallBlind,bigBlind});
  }
  levelAt(time = this.now()) {
    time=Math.min(time,this.clockFrozenAt() ?? time);
    const levels = this.levels;
    if (!levels) return Math.min(20, Math.floor((time - this.startedAt) / (this.levelMinutes * 60000)));
    let elapsed = Math.max(0,time - this.startedAt), i = 0;
    while (i < levels.length - 1 && elapsed >= levels[i].durationMinutes * 60000) elapsed -= levels[i++].durationMinutes * 60000;
    return i;
  }
  levelEndsAt() {
    if (this.mode !== 'tournament' || this.startedAt === null) return null;
    if (this.levels && this.level === this.levels.length - 1) return null;
    const duration = this.levels ? this.levels.slice(0,this.level+1).reduce((n,l)=>n+l.durationMinutes,0) : (this.level+1)*this.levelMinutes;
    return this.startedAt + duration * 60000 + (this.clockFrozenAt() !== null ? this.now()-this.clockFrozenAt() : 0);
  }
  serialize() {
    const {now, pending, ...data} = this;
    return {...structuredClone(data), pending:[...pending]};
  }
  static restore(data, now = () => Date.now()) {
    const table = Object.create(Table.prototype);
    Object.assign(table, {rebuyRequests:[],rebuyReview:null}, structuredClone(data), {now, pending:new Set(data.pending)});
    for(const p of table.players){p.pendingBuyIn ??= 0;p.fundedBefore ??= true;}
    table.assertChips(); return table;
  }

  sitOut(id) {
    ensure(!this.rebuyReview,'Игра приостановлена: закуп в игре');
    return this.transaction(() => {
      const p = this.player(id); ensure(p, 'Игрок не найден');
      p.sittingOut = true; p.returnPending = false; p.sitOutReason = 'manual';
      this.version++;
      this.record(`${p.name}: не играет; автопас в свой ход`, {kind: 'sitOut', playerId: id, reason: 'manual'});
      if (!this.idle && this.actor === id) this.foldAbsent(id, 'manual');
      this.syncNextHand();
    });
  }
  returnToPlay(id) {
    const p = this.player(id); ensure(p, 'Игрок не найден');
    ensure(p.connected, 'Сначала восстановите соединение');
    ensure(p.stack > 0 || (!this.idle && p.inHand && !p.folded), 'Для возвращения нужны фишки');
    ensure(!this.tournamentOver && !this.haltReason, 'Игра завершена или остановлена');
    if (!p.sittingOut || p.returnPending) return;
    // Even before the seat's turn, return cannot resurrect this hand or undo a fold.
    p.returnPending = true; this.version++;
    this.record(`${p.name}: запрос на возвращение`, {kind: 'returnToPlay', playerId: id});
    this.syncNextHand();
  }
  lineup() {
    if (this.mode === 'tournament') return {players: this.players.filter(p => p.stack > 0), forcedBB: null};
    const ready = p => p.stack > 0 && (!p.sittingOut || p.returnPending);
    const regular = this.players.filter(p => ready(p) && !p.missedHands);
    const waiting = this.players.filter(p => ready(p) && p.missedHands);
    let forcedBB = null;
    if (waiting.length) {
      const next = this.nextSeat(this.lastBigBlind ?? -1, ready);
      if (regular.length >= 2) {
        if (next?.missedHands) { regular.push(next); forcedBB = next.id; }
      } else if (regular.length === 1) {
        // Restart a short-handed cash table with the returning seat paying BB.
        const bb = this.nextSeat(this.lastBigBlind ?? -1, p => waiting.includes(p));
        regular.push(bb); forcedBB = bb.id;
      } else if (waiting.length >= 2) {
        const bb = next, sb = this.nextSeat(bb.seat, p => waiting.includes(p));
        regular.push(bb, sb); forcedBB = bb.id;
      }
    }
    return {players: regular, forcedBB};
  }
  syncNextHand() {
    if(this.rebuyReview)return false;
    if (this.paused && this.idle && this.pauseStartedAt === null) this.pauseStartedAt = this.now();
    const allowed = this.running && !this.paused && !this.haltReason && this.idle &&
      !this.tournamentOver && this.lineup().players.length >= 2;
    const next = allowed ? (this.nextHandAt ?? this.now() + this.handDelayMs) : null;
    if (next === this.nextHandAt) return false;
    this.nextHandAt = next; this.version++; return true;
  }
  foldAbsent(id, reason) {
    const p = this.player(id);
    ensure(p && this.actor === id && p.inHand && !p.folded && p.stack > 0, 'Автопас здесь недоступен');
    if (!p.sittingOut) {
      p.sittingOut = true; p.returnPending = false; p.sitOutReason = reason;
    }
    this._act(id, 'fold', null, reason);
  }
  halt() {
    // Fail closed: never repeatedly retry a corrupt/failed hand on the next tick.
    this.haltReason = 'Игра остановлена из-за ошибки. Нужна проверка сервера.';
    this.paused = true; this.deadline = null; this.nextHandAt = null; this.version++;
  }
  nextSeat(after, predicate) {
    for (let n = 1; n <= this.maxPlayers; n++) {
      const seat = (after + n + this.maxPlayers) % this.maxPlayers;
      const p = this.players.find(x => x.seat === seat);
      if (p && predicate(p)) return p;
    }
    return null;
  }
  pay(p, amount) {
    const paid = Math.min(amount, p.stack);
    ensure(integer(paid, 0, MAX_TABLE_CHIPS), 'Некорректная ставка');
    p.stack -= paid; p.bet += paid; p.total += paid;
    return paid;
  }
  transaction(fn) {
    // In-process rollback only; this is NOT durable persistence / a database transaction.
    const {now, ...data} = this, before = structuredClone(data);
    try { const result = fn(); this.assertChips(); return result; }
    catch (error) { Object.assign(this, before); throw error; }
  }
  /** suppliedDeck is a test seam. It is never accepted by the HTTP API. */
  startHand(suppliedDeck = null) { return this.transaction(() => this._startHand(suppliedDeck)); }
  _startHand(suppliedDeck = null) {
    ensure(!this.rebuyReview,'Игра приостановлена: закуп в игре');
    ensure(this.idle, 'Раздача уже идёт');
    this.applyApprovedRebuys();
    ensure(!this.tournamentOver, 'Турнир уже завершён');
    ensure(!this.haltReason, 'Стол остановлен из-за ошибки');
    this.markDisconnected();
    const lineup = this.lineup(), eligibleIds = new Set(lineup.players.map(p => p.id));
    const eligible = p => eligibleIds.has(p.id);
    ensure(lineup.players.length >= 2, 'Для раздачи нужны хотя бы 2 готовых игрока с фишками');
    if (suppliedDeck) ensure(suppliedDeck.length === 52 && new Set(suppliedDeck).size === 52 && suppliedDeck.every(c => /^[2-9TJQKA][cdhs]$/.test(c)), 'Invalid deck');
    // Fail closed on entropy failure, before changing any table state.
    const deck = suppliedDeck ? [...suppliedDeck] : shuffledDeck();
    if (this.mode === 'tournament') {
      if (this.startedAt === null) this.startedAt = this.now();
      this.level = this.levelAt();
      this.smallBlind = this.levels?.[this.level].smallBlind ?? this.baseSmallBlind * 2 ** this.level;
      this.bigBlind = this.levels?.[this.level].bigBlind ?? this.baseBigBlind * 2 ** this.level;
    } else if (this.pendingBlinds) {
      Object.assign(this, this.pendingBlinds); this.pendingBlinds = null;
      this.record(`Применены блайнды ${this.smallBlind} / ${this.bigBlind}`, {kind:'blindsApplied',effectiveHandId:this.handId+1,smallBlind:this.smallBlind,bigBlind:this.bigBlind});
    }
    for (const p of this.players) {
      if (eligible(p)) {
        if (p.returnPending && p.connected) { p.sittingOut = false; p.returnPending = false; p.sitOutReason = null; }
        p.missedHands = false;
      } else if (this.mode === 'cash' && p.stack > 0) p.missedHands = true;
    }
    this.nextHandAt = null;
    this.deck = deck; this.board = []; this.phase = 'preflop'; this.handId++;
    this.payouts = []; this.pots = []; this.refunds = []; this.accounting = []; this.handHistory = []; this.historyTruncated = false;
    this.lastPot = 0; this.committedPot = 0; this.reveal = false; this.straddle = null;
    this.currentBet = this.bigBlind; this.minRaise = this.bigBlind;
    for (const p of this.players) Object.assign(p, {cards: [], bet: 0, total: 0, handStartStack: p.stack,
      inHand: eligible(p), folded: false, actedAt: null, actedRaiseSize: this.bigBlind, lastAction: ''});
    const active = this.contenders();
    let sb, bb, sbSeat;
    if (this.lastBigBlind === null) {
      this.dealer = this.nextSeat(this.dealer, p => p.inHand).seat;
      sb = active.length === 2 ? this.players.find(p => p.seat === this.dealer) : this.nextSeat(this.dealer, p => p.inHand);
      bb = this.nextSeat(sb.seat, p => p.inHand); sbSeat = sb.seat;
    } else {
      // Dead-button rotation. The BB advances to the next funded occupied seat;
      // the previous BB seat is the SB, even when it is now empty (dead SB).
      bb = lineup.forcedBB ? this.player(lineup.forcedBB) : this.nextSeat(this.lastBigBlind, p => p.inHand);
      if (active.length === 2) {
        sb = active.find(p => p.id !== bb.id); sbSeat = sb.seat; this.dealer = sb.seat;
      } else {
        sbSeat = this.lastBigBlind;
        sb = active.find(p => p.seat === sbSeat);
        this.dealer = this.lastSmallBlind;
      }
    }
    this.lastBigBlind = bb.seat; this.lastSmallBlind = sbSeat; this.lastParticipantCount = active.length;
    this.record(`Раздача #${this.handId}`, {kind: 'deal', dealer: this.dealer, smallBlind: this.smallBlind,
      bigBlind: this.bigBlind, mode: this.mode, rulesVersion: this.rulesVersion,
      startingStacks: Object.fromEntries(active.map(p => [p.id, p.stack]))});
    if (sb) { this.pay(sb, this.smallBlind); sb.lastAction = 'Малый блайнд'; }
    this.pay(bb, this.bigBlind); bb.lastAction = 'Большой блайнд';
    let lastForced = bb;
    if (this.mode === 'cash' && this.straddleAllowed && active.length >= 3) {
      const utg = this.nextSeat(bb.seat, p => p.inHand);
      if (utg.autoStraddle && utg.stack >= this.bigBlind * 2) {
        const amount = this.bigBlind * 2;
        this.pay(utg, amount); utg.lastAction = 'Страдл';
        this.straddle = {id: utg.id, amount}; this.currentBet = amount; this.minRaise = amount;
        lastForced = utg;
        this.record(`${utg.name} · страдл ${amount}`, {kind: 'straddle', playerId: utg.id, paid: amount});
      }
    }
    // All forced bets and straddle preferences have been fixed BEFORE dealing.
    for (let round = 0; round < 2; round++) {
      let after = this.dealer;
      for (let i = 0; i < active.length; i++) {
        const p = this.nextSeat(after, x => x.inHand); p.cards.push(this.deck.shift()); after = p.seat;
      }
    }
    this.pending = new Set(this.actors().map(p => p.id));
    this.advance(lastForced.seat); this.version++; this.assertChips();
  }
  legal(id) {
    const p = this.player(id);
    if (!p || this.actor !== id || this.idle) return null;
    const othersWithChips = this.actors().filter(x => x.id !== id);
    // A lone player cannot bet into an uncontestable, empty side pot.
    const target = othersWithChips.length ? this.currentBet : Math.min(this.currentBet, Math.max(0, ...this.players.filter(x => x.id !== id).map(x => x.bet)));
    const toCall = Math.max(0, target - p.bet);
    const maxTo = p.bet + p.stack;
    const reopened = p.actedAt === null || this.currentBet - p.actedAt >= p.actedRaiseSize;
    const canRaise = reopened && othersWithChips.length > 0 && maxTo > this.currentBet;
    return {toCall, callAmount: Math.min(toCall, p.stack), canCheck: toCall === 0, canRaise,
      minTo: this.currentBet + this.minRaise, maxTo, allInOnly: maxTo < this.currentBet + this.minRaise};
  }
  act(id, action, amount = null) {
    ensure(!this.rebuyReview,'Игра приостановлена: закуп в игре');
    ensure(!this.haltReason, 'Стол остановлен из-за ошибки');
    ensure(!this.player(id)?.sittingOut, 'Вы не играете; возвращение возможно только в новой раздаче');
    ensure(this.deadline === null || this.now() < this.deadline, 'Время хода истекло');
    return this.transaction(() => this._act(id, action, amount));
  }
  _act(id, action, amount = null, autoReason = null) {
    const p = this.player(id), legal = this.legal(id);
    ensure(p && legal, 'Сейчас ход другого игрока');
    const before = p.stack;
    if (action === 'fold') { p.folded = true; p.lastAction = autoReason === 'timeout' ? 'Пас по таймеру' : autoReason ? 'Автопас' : 'Пас'; }
    else if (action === 'check') { ensure(legal.canCheck, 'Нужно ответить на ставку'); p.lastAction = 'Чек'; }
    else if (action === 'call') { ensure(legal.toCall > 0, 'Можно сделать чек'); this.pay(p, legal.callAmount); p.lastAction = p.stack === 0 ? 'Олл-ин' : 'Колл'; }
    else if (action === 'raise') {
      ensure(legal.canRaise, 'Повышение сейчас недоступно');
      ensure(integer(amount, this.currentBet + 1, legal.maxTo), 'Некорректный размер ставки');
      ensure(amount >= legal.minTo || amount === legal.maxTo, `Минимальное повышение до ${legal.minTo}`);
      const raiseSize = amount - this.currentBet;
      this.pay(p, amount - p.bet);
      if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
      this.currentBet = amount;
      p.lastAction = p.stack === 0 ? 'Олл-ин' : 'Рейз';
      this.pending = new Set(this.actors().filter(x => x.id !== id).map(x => x.id));
    } else throw new Error('Неизвестное действие');
    p.actedAt = this.currentBet; p.actedRaiseSize = this.minRaise;
    this.pending.delete(id);
    const paid = before - p.stack;
    this.record(`${p.name} · ${p.lastAction}${paid ? ` ${paid}` : ''}`, {kind: action, playerId: id, paid, to: p.bet, currentBet: this.currentBet, ...(autoReason ? {automatic: true, reason: autoReason} : {})});
    this.advance(p.seat); this.version++; this.assertChips();
  }
  advance(afterSeat) {
    if (this.contenders().length === 1) { this.finish(false); return; }
    const actors = this.actors();
    for (const id of this.pending) if (!actors.some(p => p.id === id)) this.pending.delete(id);
    if (actors.length === 1) {
      const p = actors[0];
      const highestOther = Math.max(0, ...this.players.filter(x => x.id !== p.id).map(x => x.bet));
      if (p.bet >= highestOther) this.pending.clear();
      else this.pending = new Set([p.id]);
    }
    if (!this.pending.size) {
      if (this.phase === 'river') { this.finish(true); return; }
      this.nextStreet(); return;
    }
    const next = this.nextSeat(afterSeat, p => this.pending.has(p.id));
    ensure(next, 'No pending actor');
    this.actor = next.id; this.deadline = this.now() + (next.sittingOut ? 350 : this.turnMs);
  }
  nextStreet() {
    this.phase = phases[phases.indexOf(this.phase) + 1];
    this.deck.shift(); // Burn card.
    const count = this.phase === 'flop' ? 3 : 1;
    for (let i = 0; i < count; i++) this.board.push(this.deck.shift());
    for (const p of this.players) Object.assign(p, {bet: 0, actedAt: null, actedRaiseSize: this.bigBlind, lastAction: p.folded ? 'Пас' : (p.inHand && p.stack === 0 ? 'Олл-ин' : '')});
    this.currentBet = 0; this.minRaise = this.bigBlind;
    this.record({flop: 'Флоп', turn: 'Тёрн', river: 'Ривер'}[this.phase], {kind: 'street'});
    this.pending = new Set(this.actors().map(p => p.id));
    if (this.actors().length <= 1) this.pending.clear();
    this.advance(this.dealer);
  }
  finish(reveal) {
    ensure(!this.idle, 'Раздача уже завершена');
    const committedPot = this.pot, contenders = this.contenders();
    ensure(reveal || contenders.length === 1, 'Нельзя назначить победителя без вскрытия');
    if (reveal) {
      const shown = [...this.board, ...contenders.flatMap(p => p.cards)];
      ensure(this.board.length === 5 && new Set(shown).size === shown.length, 'Повтор карт или неполный борд');
    }
    const results = new Map(reveal ? contenders.map(p => [p.id, bestHand([...p.cards, ...this.board])]) : []);
    const {pots, refunds} = buildPots(this.players);
    const paid = new Map(), returned = new Map(refunds.map(r => [r.id, r.amount]));
    // Plan ALL pots, winners and odd chips before mutating ANY stack.
    for (const pot of pots) {
      let winners = [this.player(pot.eligible[0])];
      if (reveal) for (const id of pot.eligible.slice(1)) {
        const p = this.player(id), cmp = compareRanks(results.get(id).rank, results.get(winners[0].id).rank);
        if (cmp > 0) winners = [p]; else if (cmp === 0) winners.push(p);
      }
      winners.sort((a,b) => ((a.seat - this.dealer - 1 + this.maxPlayers) % this.maxPlayers) - ((b.seat - this.dealer - 1 + this.maxPlayers) % this.maxPlayers));
      const each = Math.floor(pot.amount / winners.length), extra = pot.amount % winners.length;
      pot.winners = winners.map(p => p.id);
      pot.awards = winners.map((p,i) => ({id: p.id, amount: each + (i < extra ? 1 : 0)}));
      for (const award of pot.awards) paid.set(award.id, (paid.get(award.id) || 0) + award.amount);
      ensure(sum(pot.awards.map(a => a.amount)) === pot.amount, 'Неверное деление банка');
    }
    const accounting = this.players.filter(p => p.inHand || p.total).map(p => {
      const won = paid.get(p.id) || 0, returnedAmount = returned.get(p.id) || 0;
      const startStack = p.handStartStack ?? p.stack + p.total;
      const finalStack = p.stack + won + returnedAmount;
      return {id: p.id, name: p.name, startStack, contributed: p.total, won, returned: returnedAmount,
        net: won + returnedAmount - p.total, finalStack};
    });
    ensure(sum([...paid.values()]) + sum([...returned.values()]) === committedPot, 'Выплаты не сходятся с банком');
    ensure(sum(accounting.map(p => p.net)) === 0, 'Итоги раздачи не сходятся');
    ensure(accounting.every(p => p.finalStack - p.startStack === p.net), 'Расхождение начального и конечного стека');
    ensure(this.players.every(p => integer(p.stack + (paid.get(p.id) || 0) + (returned.get(p.id) || 0), 0, MAX_TABLE_CHIPS)), 'Недопустимый итоговый стек');
    this.committedPot = committedPot; this.lastPot = sum(pots.map(p => p.amount));
    this.pots = pots; this.refunds = refunds; this.accounting = accounting; this.reveal = reveal;
    this.payouts = [...paid].map(([id, amount]) => ({id, amount, name: this.player(id).name,
      net: accounting.find(p => p.id === id).net, hand: results.get(id)?.name || 'Все соперники сбросили',
      bestCards: results.get(id)?.cards || []}));
    for (const p of this.players) p.stack += (paid.get(p.id) || 0) + (returned.get(p.id) || 0);
    for (const r of refunds) this.record(`${this.player(r.id).name}: возврат ${r.amount} (не выигрыш)`, {kind: 'return', playerId: r.id, amount: r.amount});
    for (const pot of pots) this.record(`${pot.label} ${pot.amount}: ${pot.awards.map(a => `${this.player(a.id).name} получает ${a.amount}`).join('; ')}`, {kind: 'win', potId: pot.id, amount: pot.amount, awards: pot.awards});
    this.record('Расчёт завершён: выплаты + возвраты = все взносы', {kind: 'settlement', committedPot, awardedPot: this.lastPot});
    for (const p of this.players) { p.total = 0; p.bet = 0; }
    this.phase = 'showdown'; this.actor = null; this.deadline = null; this.pending.clear();
    // Keep one completed hand for inspection even after the automatic next deal.
    this.lastHand = {handId: this.handId, phase: this.phase, rulesVersion: this.rulesVersion,
      mode: this.mode, board: [...this.board], reveal: this.reveal, committedPot: this.committedPot,
      lastPot: this.lastPot, pots: structuredClone(this.pots), payouts: structuredClone(this.payouts),
      refunds: structuredClone(this.refunds), accounting: structuredClone(this.accounting),
      handHistory: structuredClone(this.handHistory), historyTruncated: this.historyTruncated,
      players: this.players.map(p => ({id: p.id, name: p.name, seat: p.seat, cards: [...p.cards],
        inHand: p.inHand, folded: p.folded, stack: p.stack}))};
    this.applyApprovedRebuys();
    if(this.mode==='tournament' && this.players.filter(p=>p.stack>0).length===1){
      this.tournamentOver=true;this.tournamentEndedAt=this.now();this.championId=this.players.find(p=>p.stack>0).id;
    }
    this.markDisconnected(); this.syncNextHand(); this.assertChips();
  }
  tick() {
    if (this.haltReason) return false;
    return this.transaction(() => {
      if(this.rebuyReview){
        if(this.now()<this.rebuyReview.expiresAt)return false;
        this.endRebuyReview(this.rebuyReview.id,true);return true;
      }
      if (!this.idle && this.deadline !== null && this.now() >= this.deadline) {
        const p = this.player(this.actor);
        this.foldAbsent(this.actor, p.sittingOut ? (p.sitOutReason || 'manual') : 'timeout');
        return true;
      }
      if (!this.idle) return false;
      let changed = this.markDisconnected();
      changed = this.syncNextHand() || changed;
      if (this.nextHandAt !== null && this.now() >= this.nextHandAt) {
        this._startHand(); return true;
      }
      return changed;
    });
  }
  assertChips() {
    ensure(integer(this.chipsIssued,0,MAX_TABLE_CHIPS), 'Unsafe table chip total');
    ensure(this.players.every(p => integer(p.stack,0,MAX_TABLE_CHIPS) && integer(p.total,0,MAX_TABLE_CHIPS) && integer(p.pendingBuyIn||0,0,MAX_TABLE_CHIPS)), 'Chip accounting error');
    const total=this.players.reduce((n,p)=>n+BigInt(p.stack)+BigInt(p.total)+BigInt(p.pendingBuyIn||0),0n);
    ensure(total===BigInt(this.chipsIssued), 'Chip conservation failed');
  }
  /** Whitelist only. Never serialize the Table instance, deck, or RNG state. */
  viewFor(id) {
    return {phase: this.phase, handId: this.handId, version: this.version, board: [...this.board],
      dealer: this.dealer, actor: this.actor, deadline: this.deadline, serverNow: this.now(),
      pot: this.pot, lastPot: this.lastPot, smallBlind: this.smallBlind, bigBlind: this.bigBlind,
      startingStack: this.startingStack, maxPlayers: this.maxPlayers, turnMs: this.turnMs,
      mode: this.mode, straddleAllowed: this.straddleAllowed, straddle: this.straddle ? {...this.straddle} : null,
      rulesVersion: this.rulesVersion, level: this.level, levelMinutes: this.levelMinutes,
      levels: this.levels, levelEndsAt:this.levelEndsAt(), pendingLevel:this.mode === 'tournament' && this.startedAt !== null ? this.levelAt(this.pauseStartedAt ?? this.now()) : null,
      pendingBlinds: this.pendingBlinds ? {...this.pendingBlinds} : null, buyInMode:this.buyInMode,minBuyIn:this.minBuyIn,maxBuyIn:this.maxBuyIn,rebuyAllowed:true,
      tournamentOver: this.tournamentOver, championId: this.championId,
      rebuyRequests:structuredClone(this.rebuyRequests),rebuyReview:this.rebuyReview?{...this.rebuyReview}:null,maxTableChips:MAX_TABLE_CHIPS,
      running: this.running, paused: this.paused, handDelayMs: this.handDelayMs, nextHandAt: this.nextHandAt,
      haltReason: this.haltReason, readyCount: this.lineup().players.length,
      lastHand: this.lastHand ? {...structuredClone(this.lastHand), players: this.lastHand.players.map(p => ({...p, cards: p.id === id || (this.lastHand.reveal && p.inHand && !p.folded) ? [...p.cards] : p.cards.map(() => '??')}))} : null,
      committedPot: this.committedPot, refunds: structuredClone(this.refunds), accounting: structuredClone(this.accounting),
      handHistory: structuredClone(this.handHistory), historyTruncated: this.historyTruncated,
      legal: this.rebuyReview || this.player(id)?.sittingOut || this.haltReason ? null : this.legal(id), payouts: structuredClone(this.payouts), pots: structuredClone(this.pots),
      history: structuredClone(this.history),
      players: this.players.map(p => ({id: p.id, name: p.name, seat: p.seat, bot: p.bot,
        fundedBefore: p.fundedBefore, stack: p.stack, pendingBuyIn:p.pendingBuyIn||0, bet: p.bet, total: p.total, folded: p.folded, inHand: p.inHand,
        autoStraddle: p.autoStraddle, connected: p.connected, sittingOut: p.sittingOut, returnPending: p.returnPending, missedHands: p.missedHands, sitOutReason: p.sitOutReason, lastAction: p.lastAction,
        cards: p.id === id || (this.reveal && p.inHand && !p.folded) ? [...p.cards] : p.cards.map(() => '??')}))};
  }
}
