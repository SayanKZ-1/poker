import {Table, randomBelow} from './poker.mjs';
/** Local bots are explicitly identified in the UI; never used in private rooms. */
export class DemoGame {
  constructor(onState, name = 'Вы', mode = 'cash') {
    this.onState = onState; this.closed = false; this.timer = null;
    this.table = new Table({mode, straddleAllowed: mode === 'cash'});
    this.table.addPlayer('you', name);
    ['Арман', 'Дана', 'Тимур', 'Алия', 'Никита'].forEach((n, i) => this.table.addPlayer(`bot${i}`, n, {bot: true}));
    this.table.startPlay(); this.emit(); this.schedule();
    this.tick = setInterval(() => {
      if (this.closed) return;
      try {
        let changed = false;
        if (this.table.idle && this.table.mode === 'cash') for (const p of this.table.players) {
          if (p.bot && p.stack === 0) { this.table.topUp(p.id); changed = true; }
        }
        changed = this.table.tick() || changed;
        if (changed) { this.emit(); this.schedule(); }
      } catch { this.table.halt(); this.emit(); }
    }, 250);
  }
  emit() {
    if (!this.closed) this.onState({type: 'state', demo: true, me: 'you', room: {id: 'demo', name: 'Свои за столом', ownerId: 'you', pending: [], invite: null, locked: true}, table: this.table.viewFor('you')});
  }
  async send(action, data = {}) {
    if (action === 'act') this.table.act('you', data.move, data.amount);
    else if (action === 'start') this.table.startPlay();
    else if (action === 'sitOut') this.table.sitOut('you');
    else if (action === 'returnToPlay') this.table.returnToPlay('you');
    else if (action === 'pause') this.table.setPaused(data.paused);
    else if (action === 'straddle') this.table.setStraddle('you', data.enabled);
    else if (action === 'topUp') this.table.topUp('you');
    else throw new Error('Эта функция доступна в комнате с друзьями, не в демо');
    this.table.syncNextHand(); this.emit(); this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.closed || this.table.haltReason || this.table.idle || this.table.actor === 'you' || this.table.player(this.table.actor)?.sittingOut) return;
    this.timer = setTimeout(() => {
      if (this.closed || this.table.haltReason || this.table.idle || this.table.actor === 'you' || this.table.player(this.table.actor)?.sittingOut) return;
      // A throttled/background tab may wake after a bot deadline. Apply the clock first.
      if (this.table.tick()) { this.emit(); this.schedule(); return; }
      const id = this.table.actor, l = this.table.legal(id), roll = randomBelow(100);
      if (l.canRaise && !l.allInOnly && roll < 8) this.table.act(id, 'raise', l.minTo);
      else if (l.canCheck) this.table.act(id, 'check');
      else if (l.toCall > this.table.bigBlind * 5 && roll < 24) this.table.act(id, 'fold');
      else this.table.act(id, 'call');
      this.emit(); this.schedule();
    }, 850 + randomBelow(700));
  }
  close() { this.closed = true; clearTimeout(this.timer); clearInterval(this.tick); }
}
